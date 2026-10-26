use crate::provider::CompletionOptions;
use crate::types::{ContentPart, Message, Role};
use serde_json::{json, Value};

/// The Responses API's `input` shape for one message's user content.
///
/// A text-only turn stays a plain string (the form most gateways accept); any
/// image or multi-part turn becomes the structured `input_text`/`input_image`
/// array.
fn user_content(message: &Message) -> Value {
    let mut parts = Vec::new();
    for part in &message.content {
        match part {
            ContentPart::Text { text } => {
                parts.push(json!({ "type": "input_text", "text": text }));
            }
            ContentPart::Image { data, mime_type } => {
                parts.push(json!({
                    "type": "input_image",
                    "image_url": format!("data:{mime_type};base64,{data}"),
                }));
            }
            ContentPart::Thinking { thinking, .. } => {
                parts.push(json!({ "type": "input_text", "text": thinking }));
            }
            ContentPart::ProviderState { .. } => {}
        }
    }
    if parts.len() == 1 && parts[0]["type"] == "input_text" {
        parts.pop().unwrap()["text"].clone()
    } else {
        Value::Array(parts)
    }
}

/// Build the stateless OpenAI Responses API request for a conversation.
///
/// Reasoning items recorded from an earlier Responses stream are replayed as
/// opaque `ProviderState` parts. They are filtered by `provider_name` so a
/// conversation that switches providers never sends another vendor's opaque
/// reasoning state.
pub(crate) fn request_body(
    messages: &[Message],
    options: &CompletionOptions,
    provider_name: &str,
) -> Value {
    let mut instructions = Vec::new();
    let mut input = Vec::new();

    for message in messages {
        match &message.role {
            Role::System => {
                let text = message.text();
                if !text.trim().is_empty() {
                    instructions.push(text);
                }
            }
            Role::User | Role::Custom(_) => {
                input.push(json!({ "role": "user", "content": user_content(message) }));
            }
            Role::Assistant => {
                for part in &message.content {
                    if let ContentPart::ProviderState { provider, data } = part {
                        if provider == provider_name {
                            input.push(data.clone());
                        }
                    }
                }
                if !message.text().is_empty() {
                    input.push(json!({ "role": "assistant", "content": message.text() }));
                }
                for call in message.tool_calls.clone().unwrap_or_default() {
                    input.push(json!({
                        "type": "function_call",
                        "call_id": call.id,
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    }));
                }
            }
            Role::Tool => {
                if let Some(result) = &message.tool_result {
                    input.push(json!({
                        "type": "function_call_output",
                        "call_id": result.tool_call_id,
                        "output": result.output,
                    }));
                }
            }
        }
    }

    let mut body = json!({
        "model": options.model,
        "input": input,
        "store": false,
        "stream": true,
        // Required to replay reasoning items when `store` is false.
        "include": ["reasoning.encrypted_content"],
    });

    if !instructions.is_empty() {
        body["instructions"] = json!(instructions.join("\n\n"));
    }

    if !options.tools.is_empty() {
        body["tools"] = json!(options
            .tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.parameters,
                "strict": false,
            }))
            .collect::<Vec<_>>());
        body["tool_choice"] = json!("auto");
    }

    if let Some(effort) = options
        .reasoning_effort
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && *value != "none")
    {
        body["reasoning"] = json!({ "effort": effort, "summary": "auto" });
    }

    if let Some(max) = options.max_tokens {
        body["max_output_tokens"] = json!(max);
    }

    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ToolCall;
    use crate::types::ToolParamSchema;

    fn options() -> CompletionOptions {
        CompletionOptions {
            model: "gpt-5.6-sol".into(),
            reasoning_effort: Some("high".into()),
            tools: vec![ToolParamSchema {
                name: "read".into(),
                description: "Read a file".into(),
                parameters: json!({ "type": "object" }),
            }],
            max_tokens: Some(4_096),
            ..Default::default()
        }
    }

    #[test]
    fn maps_system_instructions_and_tool_turns() {
        let messages = vec![
            Message::system("You are Axle."),
            Message::user("Read the file"),
            Message::assistant(
                "",
                Some(vec![ToolCall {
                    id: "call-1".into(),
                    name: "read".into(),
                    arguments: json!({ "path": "README.md" }),
                }]),
            ),
            Message::tool_result("call-1", "contents", false),
        ];

        let body = request_body(&messages, &options(), "agent_router");

        assert_eq!(body["model"], "gpt-5.6-sol");
        assert_eq!(body["instructions"], "You are Axle.");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][1]["type"], "function_call");
        assert_eq!(body["input"][1]["call_id"], "call-1");
        assert_eq!(body["input"][2]["type"], "function_call_output");
        assert_eq!(body["tools"][0]["name"], "read");
        assert_eq!(body["tools"][0]["strict"], false);
        assert_eq!(body["reasoning"]["effort"], "high");
        assert_eq!(body["max_output_tokens"], 4_096);
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn replays_only_this_providers_opaque_reasoning() {
        let messages = vec![
            Message::user("The phrase is amber-orchid."),
            Message {
                role: Role::Assistant,
                content: vec![
                    ContentPart::Text {
                        text: "I will remember it.".into(),
                    },
                    ContentPart::ProviderState {
                        provider: "agent_router".into(),
                        data: json!({
                            "type": "reasoning",
                            "id": "reasoning-1",
                            "encrypted_content": "opaque-state",
                            "summary": [],
                        }),
                    },
                    ContentPart::ProviderState {
                        provider: "someone_else".into(),
                        data: json!({ "type": "reasoning", "id": "foreign" }),
                    },
                ],
                tool_calls: None,
                tool_result: None,
                timestamp: None,
                provider: Some("agent_router".into()),
                model: Some("gpt-5.6-sol".into()),
            },
            Message::user("What was the phrase?"),
        ];

        let body = request_body(&messages, &CompletionOptions::default(), "agent_router");

        assert_eq!(body["input"][1]["type"], "reasoning");
        assert_eq!(body["input"][1]["encrypted_content"], "opaque-state");
        assert_eq!(body["input"][2]["role"], "assistant");
        assert_eq!(body["input"][3]["role"], "user");
        assert_eq!(body["input"].as_array().unwrap().len(), 4);
    }

    #[test]
    fn includes_user_images_as_responses_input_parts() {
        let messages = vec![Message::user_with_content(vec![
            ContentPart::Text {
                text: "Describe this".into(),
            },
            ContentPart::Image {
                data: "aGVsbG8=".into(),
                mime_type: "image/png".into(),
            },
        ])];

        let body = request_body(&messages, &CompletionOptions::default(), "agent_router");

        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][0]["content"][1]["type"], "input_image");
        assert_eq!(
            body["input"][0]["content"][1]["image_url"],
            "data:image/png;base64,aGVsbG8="
        );
    }

    #[test]
    fn omits_tools_and_reasoning_when_not_requested() {
        let body = request_body(
            &[Message::user("hello")],
            &CompletionOptions::default(),
            "agent_router",
        );

        assert!(body.get("tools").is_none());
        assert!(body.get("reasoning").is_none());
        assert!(body.get("instructions").is_none());
    }
}
