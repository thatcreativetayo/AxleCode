use crate::provider::EventStream;
use crate::types::{AssistantMessageEvent, ContentPart, UsageStats};
use futures::StreamExt;
use reqwest::Response;
use serde_json::Value;
use tokio_stream::wrappers::UnboundedReceiverStream;

#[derive(Default)]
struct SseDecoder {
    buffer: String,
}

fn token_count(value: &Value, field: &str) -> u32 {
    value[field].as_u64().unwrap_or(0).min(u32::MAX as u64) as u32
}

fn openai_usage(value: &Value) -> Option<UsageStats> {
    let usage = value.get("usage")?;
    if usage.is_null() {
        return None;
    }
    Some(UsageStats {
        prompt_tokens: token_count(usage, "prompt_tokens"),
        completion_tokens: token_count(usage, "completion_tokens"),
        total_tokens: token_count(usage, "total_tokens"),
    })
}

fn anthropic_usage(value: &Value, previous: Option<&UsageStats>) -> Option<UsageStats> {
    let usage = match value["type"].as_str() {
        Some("message_start") => value["message"].get("usage")?,
        Some("message_delta") => value.get("usage")?,
        _ => return previous.cloned(),
    };
    let prompt_tokens = token_count(usage, "input_tokens")
        .max(previous.map(|stats| stats.prompt_tokens).unwrap_or(0));
    let completion_tokens = token_count(usage, "output_tokens")
        .max(previous.map(|stats| stats.completion_tokens).unwrap_or(0));
    Some(UsageStats {
        prompt_tokens,
        completion_tokens,
        total_tokens: prompt_tokens.saturating_add(completion_tokens),
    })
}

fn gemini_usage(value: &Value) -> Option<UsageStats> {
    let usage = value.get("usageMetadata")?;
    Some(UsageStats {
        prompt_tokens: token_count(usage, "promptTokenCount"),
        completion_tokens: token_count(usage, "candidatesTokenCount"),
        total_tokens: token_count(usage, "totalTokenCount"),
    })
}

impl SseDecoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buffer.push_str(&String::from_utf8_lossy(bytes));
        let mut payloads = Vec::new();

        while let Some(line_end) = self.buffer.find('\n') {
            let line = self.buffer[..line_end].trim().to_string();
            self.buffer.drain(..=line_end);
            if let Some(data) = line.strip_prefix("data: ") {
                payloads.push(data.to_string());
            }
        }

        payloads
    }
}

/// Reasoning text a thinking-capable OpenAI-compatible endpoint streams
/// alongside `content`. DeepSeek-style endpoints use `reasoning_content`;
/// OpenRouter-style relays use `reasoning`. Capturing it here is what lets
/// later requests pass the assistant turn's thinking back to such endpoints.
fn openai_reasoning_delta(delta: &Value) -> Option<&str> {
    delta
        .get("reasoning_content")
        .and_then(Value::as_str)
        .or_else(|| delta.get("reasoning").and_then(Value::as_str))
}

pub(crate) fn openai(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut tool_calls: Vec<(String, String)> = Vec::new();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                if data == "[DONE]" {
                    let _ = tx.send(AssistantMessageEvent::Done { usage });
                    return;
                }
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "OpenAI returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                let delta = &value["choices"][0]["delta"];
                if let Some(parsed_usage) = openai_usage(&value) {
                    usage = Some(parsed_usage);
                }
                if let Some(text) = delta["content"].as_str() {
                    let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                }
                if let Some(reasoning) = openai_reasoning_delta(delta) {
                    let _ = tx.send(AssistantMessageEvent::ThinkingDelta(reasoning.to_string()));
                }
                if let Some(calls) = delta["tool_calls"].as_array() {
                    for call in calls {
                        let index = call["index"].as_u64().unwrap_or(0) as usize;
                        while tool_calls.len() <= index {
                            tool_calls.push((String::new(), String::new()));
                        }
                        if let Some(id) = call["id"].as_str() {
                            tool_calls[index].0 = id.to_string();
                        }
                        if let Some(name) = call["function"]["name"].as_str() {
                            tool_calls[index].1 = name.to_string();
                        }
                        let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                            id: tool_calls[index].0.clone(),
                            name: tool_calls[index].1.clone(),
                            arguments_delta: call["function"]["arguments"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        });
                    }
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "OpenAI closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

pub(crate) fn anthropic(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut tool_blocks: Vec<(String, String)> = Vec::new();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "Anthropic returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                usage = anthropic_usage(&value, usage.as_ref());
                match value["type"].as_str().unwrap_or("") {
                    "content_block_start" if value["content_block"]["type"] == "tool_use" => {
                        let index = value["index"].as_u64().unwrap_or(0) as usize;
                        while tool_blocks.len() <= index {
                            tool_blocks.push((String::new(), String::new()));
                        }
                        tool_blocks[index] = (
                            value["content_block"]["id"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                            value["content_block"]["name"]
                                .as_str()
                                .unwrap_or("")
                                .to_string(),
                        );
                        let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                            id: tool_blocks[index].0.clone(),
                            name: tool_blocks[index].1.clone(),
                            arguments_delta: String::new(),
                        });
                    }
                    "content_block_delta" => {
                        if let Some(text) = value["delta"]["text"].as_str() {
                            let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                        }
                        if let Some(thinking) = value["delta"]["thinking"].as_str() {
                            let _ =
                                tx.send(AssistantMessageEvent::ThinkingDelta(thinking.to_string()));
                        }
                        if let Some(arguments) = value["delta"]["partial_json"].as_str() {
                            let index = value["index"].as_u64().unwrap_or(0) as usize;
                            if let Some((id, name)) = tool_blocks.get(index) {
                                let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                                    id: id.clone(),
                                    name: name.clone(),
                                    arguments_delta: arguments.to_string(),
                                });
                            }
                        }
                    }
                    "message_stop" => {
                        let _ = tx.send(AssistantMessageEvent::Done { usage });
                        return;
                    }
                    "error" => {
                        let message = value["error"]["message"]
                            .as_str()
                            .unwrap_or("Anthropic streaming error")
                            .to_string();
                        let _ = tx.send(AssistantMessageEvent::Error(message));
                        return;
                    }
                    _ => {}
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "Anthropic closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

pub(crate) fn gemini(response: Response) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut usage = None;
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "Gemini returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                if let Some(parsed_usage) = gemini_usage(&value) {
                    usage = Some(parsed_usage);
                }
                if let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() {
                    for part in parts {
                        if let Some(text) = part["text"].as_str() {
                            let _ = tx.send(AssistantMessageEvent::TextDelta(text.to_string()));
                        }
                        if let Some(call) = part["functionCall"].as_object() {
                            let name = call
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let arguments = call
                                .get("args")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}));
                            let _ = tx.send(AssistantMessageEvent::ToolCallDelta {
                                id: name.clone(),
                                name,
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
                if value["candidates"][0]["finishReason"].is_string() {
                    let _ = tx.send(AssistantMessageEvent::Done { usage });
                    return;
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "Gemini closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

#[derive(Default)]
struct ResponsesStreamState {
    calls: std::collections::HashMap<u64, (String, String)>,
    arguments_seen: std::collections::HashSet<u64>,
}

enum ResponsesTerminal {
    Done(Option<UsageStats>),
    Failed(String),
}

fn responses_usage(value: &Value) -> Option<UsageStats> {
    let usage = value.get("usage")?;
    if usage.is_null() {
        return None;
    }
    let prompt_tokens = token_count(usage, "input_tokens");
    let completion_tokens = token_count(usage, "output_tokens");
    let total_tokens = usage
        .get("total_tokens")
        .and_then(Value::as_u64)
        .map(|total| total.min(u32::MAX as u64) as u32)
        .unwrap_or_else(|| prompt_tokens.saturating_add(completion_tokens));
    Some(UsageStats {
        prompt_tokens,
        completion_tokens,
        total_tokens,
    })
}

fn responses_error_detail(event: &Value) -> String {
    event["error"]["message"]
        .as_str()
        .or_else(|| event["response"]["error"]["message"].as_str())
        .or_else(|| event["message"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| event.to_string().chars().take(2_000).collect())
}

fn responses_call(item: &Value) -> (String, String) {
    let id = item["call_id"]
        .as_str()
        .or_else(|| item["id"].as_str())
        .unwrap_or_default()
        .to_string();
    let name = item["name"].as_str().unwrap_or_default().to_string();
    (id, name)
}

/// Translate one Responses API streaming event into provider events.
///
/// Kept as a pure function so the event shapes can be tested without an HTTP
/// server. `state` carries the function-call index across argument deltas.
fn responses_event(
    event: &Value,
    provider_name: &str,
    state: &mut ResponsesStreamState,
) -> (Vec<AssistantMessageEvent>, Option<ResponsesTerminal>) {
    let mut events = Vec::new();

    match event["type"].as_str().unwrap_or_default() {
        "response.output_text.delta" | "response.refusal.delta" => {
            if let Some(delta) = event["delta"].as_str() {
                events.push(AssistantMessageEvent::TextDelta(delta.to_string()));
            }
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            if let Some(delta) = event["delta"].as_str() {
                events.push(AssistantMessageEvent::ThinkingDelta(delta.to_string()));
            }
        }
        "response.output_item.added" if event["item"]["type"] == "function_call" => {
            let index = event["output_index"].as_u64().unwrap_or(0);
            let (id, name) = responses_call(&event["item"]);
            state.calls.insert(index, (id.clone(), name.clone()));
            events.push(AssistantMessageEvent::ToolCallDelta {
                id,
                name,
                arguments_delta: String::new(),
            });
        }
        "response.function_call_arguments.delta" => {
            let index = event["output_index"].as_u64().unwrap_or(0);
            let item_id = event["item_id"].as_str().unwrap_or_default().to_string();
            state
                .calls
                .entry(index)
                .or_insert_with(|| (item_id, String::new()));
            if let Some((id, name)) = state.calls.get(&index) {
                state.arguments_seen.insert(index);
                events.push(AssistantMessageEvent::ToolCallDelta {
                    id: id.clone(),
                    name: name.clone(),
                    arguments_delta: event["delta"].as_str().unwrap_or_default().to_string(),
                });
            }
        }
        "response.output_item.done" if event["item"]["type"] == "function_call" => {
            let index = event["output_index"].as_u64().unwrap_or(0);
            let (id, name) = responses_call(&event["item"]);
            let stored = state.calls.get(&index).cloned();
            match stored {
                Some((stored_id, stored_name)) => {
                    let mut effective_name = stored_name;
                    if !name.is_empty() && name != effective_name {
                        effective_name = name.clone();
                        state.calls.insert(index, (stored_id.clone(), name));
                        events.push(AssistantMessageEvent::ToolCallDelta {
                            id: stored_id.clone(),
                            name: effective_name.clone(),
                            arguments_delta: String::new(),
                        });
                    }
                    if !state.arguments_seen.contains(&index) {
                        if let Some(arguments) = event["item"]["arguments"]
                            .as_str()
                            .filter(|arguments| !arguments.is_empty())
                        {
                            state.arguments_seen.insert(index);
                            events.push(AssistantMessageEvent::ToolCallDelta {
                                id: stored_id,
                                name: effective_name,
                                arguments_delta: arguments.to_string(),
                            });
                        }
                    }
                }
                None => {
                    state.calls.insert(index, (id.clone(), name.clone()));
                    let arguments = event["item"]["arguments"].as_str().unwrap_or_default();
                    if !arguments.is_empty() {
                        state.arguments_seen.insert(index);
                    }
                    events.push(AssistantMessageEvent::ToolCallDelta {
                        id,
                        name,
                        arguments_delta: arguments.to_string(),
                    });
                }
            }
        }
        "response.output_item.done" if event["item"]["type"] == "reasoning" => {
            if let Some(encrypted_content) = event["item"]["encrypted_content"].as_str() {
                let reasoning_item = serde_json::json!({
                    "type": "reasoning",
                    "id": event["item"]["id"],
                    "encrypted_content": encrypted_content,
                    "summary": event["item"]["summary"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default(),
                });
                events.push(AssistantMessageEvent::ProviderState(
                    ContentPart::ProviderState {
                        provider: provider_name.to_string(),
                        data: reasoning_item,
                    },
                ));
            }
        }
        "response.completed" | "response.incomplete" => {
            return (
                events,
                Some(ResponsesTerminal::Done(responses_usage(&event["response"]))),
            );
        }
        "response.failed" | "error" => {
            return (
                events,
                Some(ResponsesTerminal::Failed(responses_error_detail(event))),
            );
        }
        _ => {}
    }

    (events, None)
}

pub(crate) fn responses(response: Response, provider_name: &'static str) -> EventStream {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let mut byte_stream = response.bytes_stream();

    tokio::spawn(async move {
        let mut decoder = SseDecoder::default();
        let mut state = ResponsesStreamState::default();
        while let Some(chunk) = byte_stream.next().await {
            let bytes = match chunk {
                Ok(bytes) => bytes,
                Err(error) => {
                    let _ = tx.send(AssistantMessageEvent::Error(error.to_string()));
                    return;
                }
            };

            for data in decoder.push(&bytes) {
                let Ok(value) = serde_json::from_str::<Value>(&data) else {
                    let _ = tx.send(AssistantMessageEvent::Error(
                        "The provider returned an invalid streaming event.".to_string(),
                    ));
                    return;
                };
                let (events, terminal) = responses_event(&value, provider_name, &mut state);
                for event in events {
                    let _ = tx.send(event);
                }
                match terminal {
                    Some(ResponsesTerminal::Done(usage)) => {
                        let _ = tx.send(AssistantMessageEvent::Done { usage });
                        return;
                    }
                    Some(ResponsesTerminal::Failed(detail)) => {
                        let _ = tx.send(AssistantMessageEvent::Error(detail));
                        return;
                    }
                    None => {}
                }
            }
        }
        let _ = tx.send(AssistantMessageEvent::Error(
            "The provider closed the response stream before completion.".to_string(),
        ));
    });

    Box::pin(UnboundedReceiverStream::new(rx))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_handles_sse_lines_split_across_chunks() {
        let mut decoder = SseDecoder::default();
        assert!(decoder.push(b"data: {\"part\":").is_empty());
        assert_eq!(
            decoder.push(b"1}\n\ndata: [DONE]\n"),
            vec!["{\"part\":1}", "[DONE]"]
        );
    }

    #[test]
    fn parses_usage_for_each_provider_shape() {
        assert_eq!(
            openai_usage(&serde_json::json!({
                "usage": { "prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13 }
            }))
            .unwrap()
            .total_tokens,
            13
        );

        let anthropic = anthropic_usage(
            &serde_json::json!({
                "type": "message_start",
                "message": { "usage": { "input_tokens": 20, "output_tokens": 1 } }
            }),
            None,
        )
        .unwrap();
        let anthropic = anthropic_usage(
            &serde_json::json!({
                "type": "message_delta",
                "usage": { "output_tokens": 5 }
            }),
            Some(&anthropic),
        )
        .unwrap();
        assert_eq!(anthropic.total_tokens, 25);

        assert_eq!(
            gemini_usage(&serde_json::json!({
                "usageMetadata": {
                    "promptTokenCount": 30,
                    "candidatesTokenCount": 7,
                    "totalTokenCount": 37
                }
            }))
            .unwrap()
            .total_tokens,
            37
        );
    }

    #[test]
    fn openai_reasoning_deltas_cover_deepseek_and_openrouter_field_names() {
        assert_eq!(
            openai_reasoning_delta(&serde_json::json!({ "reasoning_content": "think" })),
            Some("think")
        );
        assert_eq!(
            openai_reasoning_delta(&serde_json::json!({ "reasoning": "plan" })),
            Some("plan")
        );
        assert_eq!(
            openai_reasoning_delta(&serde_json::json!({ "content": "text" })),
            None
        );
        // `reasoning` as a structured object (some relays) is not text and
        // must be ignored rather than coerced.
        assert_eq!(
            openai_reasoning_delta(&serde_json::json!({ "reasoning": { "text": "x" } })),
            None
        );
    }

    fn collect_responses_events(
        payloads: &[Value],
        provider_name: &str,
    ) -> (Vec<AssistantMessageEvent>, Option<ResponsesTerminal>) {
        let mut state = ResponsesStreamState::default();
        let mut events = Vec::new();
        for payload in payloads {
            let (next, terminal) = responses_event(payload, provider_name, &mut state);
            events.extend(next);
            if terminal.is_some() {
                return (events, terminal);
            }
        }
        (events, None)
    }

    #[test]
    fn responses_events_cover_text_reasoning_tools_and_usage() {
        let (events, terminal) = collect_responses_events(
            &[
                serde_json::json!({
                    "type": "response.output_text.delta",
                    "delta": "Hello"
                }),
                serde_json::json!({
                    "type": "response.reasoning_summary_text.delta",
                    "delta": "think"
                }),
                serde_json::json!({
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "read"
                    }
                }),
                serde_json::json!({
                    "type": "response.function_call_arguments.delta",
                    "output_index": 0,
                    "delta": "{\"path\":\"a\"}"
                }),
                serde_json::json!({
                    "type": "response.output_item.done",
                    "item": {
                        "type": "reasoning",
                        "id": "reasoning-1",
                        "encrypted_content": "opaque-state",
                        "summary": []
                    }
                }),
                serde_json::json!({
                    "type": "response.completed",
                    "response": {
                        "usage": { "input_tokens": 10, "output_tokens": 5 }
                    }
                }),
            ],
            "agent_router",
        );

        assert!(matches!(
            &events[0],
            AssistantMessageEvent::TextDelta(text) if text == "Hello"
        ));
        assert!(matches!(
            &events[1],
            AssistantMessageEvent::ThinkingDelta(text) if text == "think"
        ));
        assert!(matches!(
            &events[2],
            AssistantMessageEvent::ToolCallDelta { id, name, arguments_delta }
                if id == "call-1" && name == "read" && arguments_delta.is_empty()
        ));
        assert!(matches!(
            &events[3],
            AssistantMessageEvent::ToolCallDelta { id, arguments_delta, .. }
                if id == "call-1" && arguments_delta == "{\"path\":\"a\"}"
        ));
        assert!(matches!(
            &events[4],
            AssistantMessageEvent::ProviderState(ContentPart::ProviderState { provider, data })
                if provider == "agent_router" && data["encrypted_content"] == "opaque-state"
        ));
        assert!(matches!(
            terminal,
            Some(ResponsesTerminal::Done(Some(UsageStats {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
            })))
        ));
    }

    #[test]
    fn responses_events_emit_full_arguments_when_only_item_done_arrives() {
        let (events, terminal) = collect_responses_events(
            &[
                serde_json::json!({
                    "type": "response.output_item.added",
                    "output_index": 0,
                    "item": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "read"
                    }
                }),
                serde_json::json!({
                    "type": "response.output_item.done",
                    "output_index": 0,
                    "item": {
                        "type": "function_call",
                        "call_id": "call-1",
                        "name": "read",
                        "arguments": "{\"path\":\"b\"}"
                    }
                }),
                serde_json::json!({
                    "type": "response.completed",
                    "response": {}
                }),
            ],
            "agent_router",
        );

        assert!(matches!(
            &events[1],
            AssistantMessageEvent::ToolCallDelta { arguments_delta, .. }
                if arguments_delta == "{\"path\":\"b\"}"
        ));
        assert!(matches!(terminal, Some(ResponsesTerminal::Done(None))));
    }

    #[test]
    fn responses_events_surface_failures() {
        let (events, terminal) = collect_responses_events(
            &[serde_json::json!({
                "type": "response.failed",
                "response": { "error": { "message": "model overloaded" } }
            })],
            "agent_router",
        );

        assert!(events.is_empty());
        assert!(matches!(
            terminal,
            Some(ResponsesTerminal::Failed(message)) if message == "model overloaded"
        ));
    }
}
