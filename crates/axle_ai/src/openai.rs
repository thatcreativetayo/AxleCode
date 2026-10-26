use crate::formatting::{openai_messages, openai_tools};
use crate::provider::{CompletionOptions, EventStream, LlmProvider};
use crate::responses;
use crate::retry::send_with_retry;
use crate::stream_parser;
use crate::types::{AssistantMessageEvent, ContentPart, Message, Role, ToolCall};

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::Client;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;

/// The message an OpenAI-compatible endpoint reported. Structured errors
/// (`{"error": {"message": ...}}`, which is what the Axle gateway sends when
/// credit runs out) read as sentences instead of raw JSON.
pub(crate) fn extract_upstream_error_message(body: &str) -> String {
    let trimmed = body.trim();
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        let message = value
            .get("error")
            .and_then(|error| {
                error.as_str().map(str::to_owned).or_else(|| {
                    error
                        .get("message")
                        .and_then(|message| message.as_str())
                        .map(str::to_owned)
                })
            })
            .or_else(|| {
                value
                    .get("message")
                    .and_then(|message| message.as_str())
                    .map(str::to_owned)
            });
        if let Some(message) = message {
            if !message.trim().is_empty() {
                return message;
            }
        }
    }
    trimmed.to_owned()
}

fn provider_api_error(label: &str, status: reqwest::StatusCode, body: &str) -> anyhow::Error {
    let hint = if matches!(status.as_u16(), 401 | 403) {
        " Check that the API key is valid and authorized for this model."
    } else {
        ""
    };
    anyhow::anyhow!(
        "{} API error (HTTP {}): {}{}",
        label,
        status,
        extract_upstream_error_message(body),
        hint
    )
}

pub struct OpenAiProvider {
    api_key: String,
    api_key_env: Option<String>,
    base_url: String,
    provider_name: &'static str,
    provider_label: &'static str,
    extra_headers: Vec<(String, String)>,
    responses_models: Mutex<HashSet<String>>,
    client: Client,
}

impl OpenAiProvider {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self::new_with_api_key_env(api_key, base_url, "OPENAI_API_KEY")
    }

    pub fn new_with_api_key_env(
        api_key: impl Into<String>,
        base_url: Option<String>,
        api_key_env: impl Into<String>,
    ) -> Self {
        Self::new_named(api_key, base_url, api_key_env, "openai", "OpenAI")
    }

    pub fn new_named(
        api_key: impl Into<String>,
        base_url: Option<String>,
        api_key_env: impl Into<String>,
        provider_name: &'static str,
        provider_label: &'static str,
    ) -> Self {
        Self::new_named_with_headers(
            api_key,
            base_url,
            api_key_env,
            provider_name,
            provider_label,
            Vec::new(),
        )
    }

    /// [`Self::new_named`] plus caller-supplied headers on every request.
    /// OpenAI-compatible vendors that ask for attribution headers (for
    /// example OpenRouter's `X-Title`) use this constructor.
    pub fn new_named_with_headers(
        api_key: impl Into<String>,
        base_url: Option<String>,
        api_key_env: impl Into<String>,
        provider_name: &'static str,
        provider_label: &'static str,
        extra_headers: Vec<(String, String)>,
    ) -> Self {
        let base_url = base_url.unwrap_or_else(|| "https://api.openai.com/v1".to_string());
        let is_local = base_url.contains("localhost")
            || base_url.contains("127.0.0.1")
            || base_url.contains("[::1]");
        Self {
            api_key: api_key.into().trim().to_string(),
            api_key_env: (!is_local).then(|| api_key_env.into()),
            base_url,
            provider_name,
            provider_label,
            extra_headers,
            responses_models: Mutex::new(HashSet::new()),
            client: Client::new(),
        }
    }

    fn validate_api_key(&self) -> anyhow::Result<()> {
        if self.api_key.trim().is_empty() {
            if let Some(api_key_env) = &self.api_key_env {
                anyhow::bail!(
                    "ERROR: {} environment variable is not set. Set it before running axle.",
                    api_key_env
                );
            }
        }
        Ok(())
    }

    /// `prompt_cache_key` is an OpenAI-specific request field. Keep it off
    /// custom/OpenAI-compatible endpoints because some of them reject unknown
    /// fields even though they otherwise implement Chat Completions.
    fn supports_prompt_cache_key(&self) -> bool {
        self.provider_name == "openai"
            && self.base_url.trim_end_matches('/') == "https://api.openai.com/v1"
    }

    /// Derive stable cache affinity from the oldest persisted conversation
    /// message. The agent recreates the leading system message for every model
    /// round, so its timestamp cannot be used. Session messages, however, keep
    /// their timestamp across tool rounds, later user turns, and process
    /// restarts. If compaction removes that message the key changes together
    /// with the model-visible prefix, which is the desired cache boundary.
    fn prompt_cache_key(messages: &[Message]) -> Option<String> {
        messages
            .iter()
            .find(|message| !matches!(&message.role, Role::System))
            .and_then(|message| message.timestamp)
            .map(|timestamp| format!("axle-{timestamp}"))
    }

    fn apply_prompt_cache_key(&self, body: &mut Value, messages: &[Message]) {
        if !self.supports_prompt_cache_key() {
            return;
        }
        if let Some(cache_key) = Self::prompt_cache_key(messages) {
            body["prompt_cache_key"] = json!(cache_key);
        }
    }

    /// Attach provider-specific headers to every outbound request.
    fn with_extra_headers(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        self.extra_headers
            .iter()
            .fold(request, |request, (name, value)| {
                request.header(name.as_str(), value.as_str())
            })
    }

    fn model_requires_responses(&self, model: &str) -> bool {
        self.responses_models
            .lock()
            .map(|models| models.contains(model))
            .unwrap_or(false)
    }

    fn remember_responses_model(&self, model: &str) {
        if let Ok(mut models) = self.responses_models.lock() {
            models.insert(model.to_string());
        }
    }

    async fn send_responses_request(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<reqwest::Response> {
        let body = responses::request_body(messages, options, self.provider_name);
        let url = format!("{}/responses", self.base_url);
        let resp = send_with_retry(self.provider_name, || async {
            let mut req = self.client.post(&url).json(&body);
            req = self.with_extra_headers(req);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }
            req.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await?;
            return Err(provider_api_error(self.provider_label, status, &err_text));
        }
        self.remember_responses_model(&options.model);
        Ok(resp)
    }

    async fn responses_stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        let resp = self.send_responses_request(messages, options).await?;
        Ok(stream_parser::responses(resp, self.provider_name))
    }

    async fn responses_complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        let mut stream = self.responses_stream(messages, options).await?;
        let mut text = String::new();
        let mut thinking = String::new();
        let mut provider_state = Vec::new();
        let mut calls: Vec<(String, String, String)> = Vec::new();

        while let Some(event) = stream.next().await {
            match event {
                AssistantMessageEvent::TextDelta(delta) => text.push_str(&delta),
                AssistantMessageEvent::ThinkingDelta(delta) => thinking.push_str(&delta),
                AssistantMessageEvent::ToolCallDelta {
                    id,
                    name,
                    arguments_delta,
                } => {
                    if let Some(call) = calls.iter_mut().find(|(call_id, _, _)| *call_id == id) {
                        if !name.is_empty() {
                            call.1 = name;
                        }
                        call.2.push_str(&arguments_delta);
                    } else {
                        calls.push((id, name, arguments_delta));
                    }
                }
                AssistantMessageEvent::ProviderState(part) => provider_state.push(part),
                AssistantMessageEvent::Done { .. } => {}
                AssistantMessageEvent::Error(message) => anyhow::bail!(message),
            }
        }

        let tool_calls = calls
            .into_iter()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| ToolCall {
                id,
                name,
                arguments: if arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&arguments).unwrap_or_else(|_| json!({}))
                },
            })
            .collect::<Vec<_>>();
        let mut message = Message::assistant(text, (!tool_calls.is_empty()).then_some(tool_calls));
        if !thinking.is_empty() {
            message.content.push(ContentPart::Thinking {
                thinking,
                signature: None,
            });
        }
        message.content.extend(provider_state);
        message.provider = Some(self.provider_name.to_string());
        message.model = Some(options.model.clone());
        Ok(message)
    }

    #[cfg(test)]
    pub(crate) fn base_url_for_tests(&self) -> &str {
        &self.base_url
    }
}

fn responses_api_required(status: reqwest::StatusCode, body: &str) -> bool {
    if status != reqwest::StatusCode::BAD_REQUEST {
        return false;
    }
    let body = body.to_ascii_lowercase();
    body.contains("/v1/responses")
        || body.contains("responses api")
        || (body.contains("chat/completions")
            && (body.contains("not support") || body.contains("不支持")))
}

fn apply_sampling_options(body: &mut Value, options: &CompletionOptions) {
    if options.reasoning_effort.is_none() {
        if let Some(temp) = options.temperature {
            body["temperature"] = json!(temp);
        }
    }
    if let Some(max) = options.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(effort) = options.reasoning_effort.as_deref() {
        body["reasoning_effort"] = json!(effort);
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    fn provider_name(&self) -> &str {
        self.provider_name
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message> {
        self.validate_api_key()?;
        if self.model_requires_responses(&options.model) {
            return self.responses_complete(messages, options).await;
        }
        let formatted = openai_messages(messages);
        let mut body = json!({
            "model": options.model,
            "messages": formatted,
        });

        apply_sampling_options(&mut body, options);

        if !options.tools.is_empty() {
            body["tools"] = json!(openai_tools(&options.tools));
        }
        self.apply_prompt_cache_key(&mut body, messages);

        let resp = send_with_retry(self.provider_name, || async {
            let mut req = self
                .client
                .post(format!("{}/chat/completions", self.base_url))
                .json(&body);
            req = self.with_extra_headers(req);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }
            req.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await?;
            if responses_api_required(status, &err_text) {
                return self.responses_complete(messages, options).await;
            }
            return Err(provider_api_error(self.provider_label, status, &err_text));
        }

        let val: Value = resp.json().await?;
        let choice = &val["choices"][0]["message"];
        let content_str = choice["content"].as_str().unwrap_or("").to_string();

        let tool_calls = choice["tool_calls"].as_array().map(|arr| {
            arr.iter()
                .map(|tc| {
                    let id = tc["id"].as_str().unwrap_or("").to_string();
                    let name = tc["function"]["name"].as_str().unwrap_or("").to_string();
                    let args_str = tc["function"]["arguments"].as_str().unwrap_or("{}");
                    let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                    ToolCall {
                        id,
                        name,
                        arguments: args,
                    }
                })
                .collect()
        });

        let mut msg = Message::assistant(content_str, tool_calls);
        msg.provider = Some(self.provider_name.to_string());
        msg.model = Some(options.model.clone());
        Ok(msg)
    }

    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream> {
        self.validate_api_key()?;
        if self.model_requires_responses(&options.model) {
            return self.responses_stream(messages, options).await;
        }
        let formatted = openai_messages(messages);
        let mut body = json!({
            "model": options.model,
            "messages": formatted,
            "stream": true,
            "stream_options": { "include_usage": true }
        });

        apply_sampling_options(&mut body, options);

        if !options.tools.is_empty() {
            body["tools"] = json!(openai_tools(&options.tools));
        }
        self.apply_prompt_cache_key(&mut body, messages);

        let resp = send_with_retry(self.provider_name, || async {
            let mut req = self
                .client
                .post(format!("{}/chat/completions", self.base_url))
                .json(&body);
            req = self.with_extra_headers(req);
            if !self.api_key.is_empty() {
                req = req.bearer_auth(&self.api_key);
            }
            req.send().await
        })
        .await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let err_text = resp.text().await?;
            if responses_api_required(status, &err_text) {
                return self.responses_stream(messages, options).await;
            }
            return Err(provider_api_error(self.provider_label, status, &err_text));
        }

        Ok(stream_parser::openai(resp))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_test_messages() -> Vec<Message> {
        let mut first_user = Message::user("first turn");
        first_user.timestamp = Some(1_725_000_000_123);
        vec![Message::system("system"), first_user]
    }

    #[test]
    fn cache_key_stays_stable_as_the_conversation_grows() {
        let mut messages = cache_test_messages();
        let expected = OpenAiProvider::prompt_cache_key(&messages);
        messages.push(Message::assistant("tool work", None));
        messages.push(Message::user("follow up"));

        assert_eq!(expected.as_deref(), Some("axle-1725000000123"));
        assert_eq!(OpenAiProvider::prompt_cache_key(&messages), expected);
    }

    #[test]
    fn official_openai_requests_get_cache_affinity() {
        let provider = OpenAiProvider::new("test-key", None);
        let mut body = json!({ "model": "gpt-5.6-sol" });
        provider.apply_prompt_cache_key(&mut body, &cache_test_messages());

        assert_eq!(body["prompt_cache_key"], "axle-1725000000123");
    }

    #[test]
    fn custom_compatible_endpoints_do_not_receive_openai_only_cache_fields() {
        let provider = OpenAiProvider::new("test-key", Some("http://localhost:1234/v1".into()));
        let mut body = json!({ "model": "local-model" });
        provider.apply_prompt_cache_key(&mut body, &cache_test_messages());

        assert!(body.get("prompt_cache_key").is_none());
    }

    #[test]
    fn reasoning_requests_omit_temperature_that_reasoning_models_reject() {
        let mut body = json!({ "model": "gpt-5.6-sol" });
        let options = CompletionOptions {
            temperature: Some(0.7),
            reasoning_effort: Some("high".to_string()),
            ..CompletionOptions::default()
        };

        apply_sampling_options(&mut body, &options);

        assert!(body.get("temperature").is_none());
        assert_eq!(body["reasoning_effort"], "high");
    }

    #[test]
    fn standard_requests_keep_temperature() {
        let mut body = json!({ "model": "gpt-4o-mini" });
        let options = CompletionOptions {
            temperature: Some(0.25),
            reasoning_effort: None,
            ..CompletionOptions::default()
        };

        apply_sampling_options(&mut body, &options);

        assert_eq!(body["temperature"], 0.25);
    }

    #[test]
    fn structured_errors_surface_the_gateway_message() {
        assert_eq!(
            extract_upstream_error_message(
                r#"{"error":{"message":"Not enough Axle credits: this request reserves 12 and your balance is 3.","type":"insufficient_credits","code":"axle_insufficient_credits"}}"#,
            ),
            "Not enough Axle credits: this request reserves 12 and your balance is 3."
        );
        assert_eq!(
            extract_upstream_error_message(r#"{"error":"Revoked."}"#),
            "Revoked."
        );
        assert_eq!(
            extract_upstream_error_message(r#"{"message":"Bad model."}"#),
            "Bad model."
        );
    }

    #[test]
    fn unstructured_errors_fall_back_to_the_raw_body() {
        assert_eq!(
            extract_upstream_error_message("upstream exploded"),
            "upstream exploded"
        );
        assert_eq!(extract_upstream_error_message("  spaced  "), "spaced");
        assert_eq!(
            extract_upstream_error_message(r#"{"error":{"message":"  "}}"#),
            r#"{"error":{"message":"  "}}"#
        );
    }

    #[test]
    fn provider_errors_keep_the_status_and_key_hint() {
        let error = provider_api_error("Axle", reqwest::StatusCode::PAYMENT_REQUIRED, "{}");
        let message = error.to_string();
        assert!(message.contains("Axle API error (HTTP 402"));
        assert!(!message.contains("API key is valid"));

        let unauthorized = provider_api_error(
            "OpenAI",
            reqwest::StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"bad key"}}"#,
        );
        let message = unauthorized.to_string();
        assert!(message.contains("OpenAI API error (HTTP 401 Unauthorized): bad key"));
        assert!(message.contains("API key is valid"));
    }

    #[test]
    fn detects_when_a_gateway_requires_the_responses_api() {
        let chinese = r#"{"error":{"message":"模型 gpt-5.6-sol 不支持 /v1/chat/completions 接口，请改用 /v1/responses（OpenAI Responses API）。"}}"#;
        assert!(responses_api_required(
            reqwest::StatusCode::BAD_REQUEST,
            chinese
        ));
        assert!(responses_api_required(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"This model does not support /v1/chat/completions; use /v1/responses."}}"#,
        ));
        assert!(!responses_api_required(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"bad model"}}"#,
        ));
        assert!(!responses_api_required(
            reqwest::StatusCode::UNAUTHORIZED,
            "use /v1/responses",
        ));
    }

    #[test]
    fn remembered_models_skip_the_chat_completions_probe() {
        let provider = OpenAiProvider::new("test-key", Some("https://agentrouter.org/v1".into()));

        assert!(!provider.model_requires_responses("gpt-5.6-sol"));
        provider.remember_responses_model("gpt-5.6-sol");
        assert!(provider.model_requires_responses("gpt-5.6-sol"));
        assert!(!provider.model_requires_responses("claude-opus-5-5"));
    }
}
