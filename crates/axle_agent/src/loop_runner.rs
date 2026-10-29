use axle_ai::{
    AssistantMessageEvent, CompletionOptions, ContentPart, LlmProvider, Message, ToolCall,
    UsageStats,
};
use axle_compaction::CompactionEngine;
use axle_config::{max_output_tokens_for_model, DEFAULT_CONTEXT_WINDOW_TOKENS};
use axle_extensions::{AxleEvent, EventBus};
use axle_prompt::PromptBuilder;
use axle_session::SessionManager;
use axle_tools::{ToolExecutionMode, ToolExecutionResult, ToolRegistry, END_TASK_TOOL_NAME};
use futures::{future::join_all, StreamExt};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::{sleep, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InteractionMode {
    Build,
    Plan,
}

pub struct AgentLoopOptions {
    pub cwd: String,
    pub workspace_context: bool,
    pub model_name: String,
    pub temperature: Option<f32>,
    pub reasoning_effort: Option<String>,
    pub append_system_prompt: Option<String>,
    pub context_window_tokens: Option<usize>,
    pub memory_context: Option<String>,
    pub interaction_mode: InteractionMode,
    /// When set, tools that declare `requires_approval` wait for an explicit
    /// allow/deny decision before they execute.
    pub approval: Option<ApprovalConfig>,
}

/// Bidirectional approval channel between the runtime and its controlling
/// application. Requests are emitted as events (the CLI serializes them to
/// NDJSON); responses are newline-delimited JSON objects appended to `file`.
#[derive(Debug, Clone)]
pub struct ApprovalConfig {
    pub file: PathBuf,
    pub timeout: Duration,
    /// Only the built-in write/edit tools bypass the gate. Commands and MCP
    /// calls still need a decision, and plan-mode tool restrictions still apply.
    pub auto_accept_edits: bool,
}

const APPROVAL_POLL_INTERVAL: Duration = Duration::from_millis(150);

#[derive(Debug, PartialEq, Eq)]
enum ApprovalVerdict {
    Allow,
    Deny { reason: String },
}

fn parse_approval_decision(value: &str) -> Option<bool> {
    match value {
        "allow" | "approved" | "accept" | "accept_for_session" | "acceptForSession" => Some(true),
        "deny" | "denied" | "declined" | "decline" | "cancel" | "cancelled" | "canceled" => {
            Some(false)
        }
        _ => None,
    }
}

/// Find a response for `request_id` in the approval file contents. Lines that
/// do not match (other requests, other event types, malformed JSON) are
/// ignored so stale responses from earlier turns can never approve a new call.
fn read_approval_response(contents: &str, request_id: &str) -> Option<ApprovalVerdict> {
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("approval_response") {
            continue;
        }
        if value.get("requestId").and_then(|value| value.as_str()) != Some(request_id) {
            continue;
        }
        let Some(decision) = value.get("decision").and_then(|value| value.as_str()) else {
            continue;
        };
        match parse_approval_decision(decision) {
            Some(true) => return Some(ApprovalVerdict::Allow),
            Some(false) => {
                return Some(ApprovalVerdict::Deny {
                    reason: "denied".to_string(),
                })
            }
            // Unknown decision values keep the request pending rather than
            // guessing what the user meant.
            None => continue,
        }
    }
    None
}

async fn wait_for_approval(file: &Path, request_id: &str, timeout: Duration) -> ApprovalVerdict {
    let deadline = Instant::now() + timeout;
    loop {
        match tokio::fs::read_to_string(file).await {
            Ok(contents) => {
                if let Some(verdict) = read_approval_response(&contents, request_id) {
                    return verdict;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(
                    path = %file.display(),
                    %error,
                    "failed to read the tool approval file"
                );
            }
        }
        let now = Instant::now();
        if now >= deadline {
            return ApprovalVerdict::Deny {
                reason: "timeout".to_string(),
            };
        }
        sleep(APPROVAL_POLL_INTERVAL.min(deadline - now)).await;
    }
}

fn approval_request_id(tool_call_id: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    format!("{tool_call_id}:{nanos}")
}

fn approval_denied_message(tool_name: &str, reason: &str, timeout: Duration) -> String {
    if reason == "timeout" {
        format!(
            "Tool '{tool_name}' was not executed because the approval request timed out after {} seconds. \
Do not retry this action automatically; continue without it or explain why it is required.",
            timeout.as_secs()
        )
    } else {
        format!(
            "Tool '{tool_name}' was denied by the user and was not executed. \
Do not retry this action; continue without it or explain why it is required."
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use axle_ai::EventStream;
    use axle_tools::{Tool, ToolExecutionResult};
    use futures::stream;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct StreamingProvider;

    struct EndTaskProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct MalformedToolArgumentsProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ParallelToolsProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ContextRecoveryProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct ContinuityProvider {
        calls: std::sync::atomic::AtomicUsize,
        saw_persisted_history: std::sync::atomic::AtomicBool,
    }

    struct IncompleteStreamProvider;

    struct PendingStreamProvider {
        stream_started: Arc<std::sync::atomic::AtomicBool>,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    /// A stream that never completes; `instrument` fires when the consumer
    /// drops the stream (the same drop that happens when a canceled future is
    /// discarded). The produced item above the park point proves cancellation
    /// dropped a real in-flight stream, not a not-yet-started one.
    struct InstrumentedPendingStream {
        produced: bool,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for InstrumentedPendingStream {
        fn drop(&mut self) {
            self.dropped
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    impl futures::Stream for InstrumentedPendingStream {
        type Item = AssistantMessageEvent;

        fn poll_next(
            mut self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<Option<Self::Item>> {
            if !self.produced {
                self.produced = true;
                return std::task::Poll::Ready(Some(AssistantMessageEvent::TextDelta(
                    "partial".to_string(),
                )));
            }
            std::task::Poll::Pending
        }
    }

    struct BlockingTool {
        started: Arc<tokio::sync::Notify>,
    }

    #[async_trait]
    impl Tool for BlockingTool {
        fn name(&self) -> &str {
            "blocking-test-tool"
        }

        fn label(&self) -> &str {
            "Blocking test tool"
        }

        fn description(&self) -> &str {
            "Waits until its future is dropped to simulate an interrupted tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            self.started.notify_one();
            std::future::pending::<()>().await;
            Ok(ToolExecutionResult::success("unreachable"))
        }
    }

    struct BlockingToolProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct BrowserToolProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    struct BrowserStatusTool {
        executed: Arc<std::sync::atomic::AtomicBool>,
    }

    struct BarrierTool {
        name: &'static str,
        barrier: Arc<tokio::sync::Barrier>,
    }

    #[async_trait]
    impl Tool for BarrierTool {
        fn name(&self) -> &str {
            self.name
        }

        fn label(&self) -> &str {
            self.name
        }

        fn description(&self) -> &str {
            "Wait for another parallel tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        fn execution_mode(&self) -> ToolExecutionMode {
            ToolExecutionMode::Parallel
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            self.barrier.wait().await;
            Ok(ToolExecutionResult::success(self.name))
        }
    }

    #[async_trait]
    impl Tool for BrowserStatusTool {
        fn name(&self) -> &str {
            "preview_status"
        }

        fn label(&self) -> &str {
            "Get preview status"
        }

        fn description(&self) -> &str {
            "Report the collaborative browser status"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            self.executed
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(ToolExecutionResult::success("Browser is available."))
        }
    }

    #[async_trait]
    impl LlmProvider for StreamingProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Hel".to_string()),
                AssistantMessageEvent::TextDelta("lo".to_string()),
                AssistantMessageEvent::Done {
                    usage: Some(UsageStats {
                        prompt_tokens: 10,
                        completion_tokens: 2,
                        total_tokens: 12,
                    }),
                },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for BrowserToolProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                assert!(
                    options
                        .tools
                        .iter()
                        .any(|tool| tool.name == "preview_status"),
                    "browser tools must be available for ordinary implementation requests"
                );
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "browser-status".to_string(),
                        name: "preview_status".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let result = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .find(|result| result.tool_call_id == "browser-status")
                .expect("browser tool result should be returned to the model");
            assert!(!result.is_error);
            assert_eq!(result.output, "Browser is available.");
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Browser verified.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for IncompleteStreamProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("partial output".to_string()),
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for PendingStreamProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            self.stream_started
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Box::pin(InstrumentedPendingStream {
                produced: false,
                dropped: self.dropped.clone(),
            }))
        }
    }

    #[async_trait]
    impl LlmProvider for BlockingToolProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "blocking-call".to_string(),
                        name: "blocking-test-tool".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let repaired = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .find(|result| result.tool_call_id == "blocking-call")
                .expect("resuming after an interrupted tool must repair the tool protocol");
            assert!(repaired.is_error, "the repaired result must be an error");
            assert!(
                repaired.output.contains("interrupted"),
                "the repaired result must explain the interruption: {}",
                repaired.output
            );
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Recovered after interruption.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for EndTaskProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            assert!(options
                .tools
                .iter()
                .any(|tool| tool.name == END_TASK_TOOL_NAME));
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(call, 0, "end_task should stop the agent loop immediately");
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta(
                    "Implemented and verified the requested fix.".to_string(),
                ),
                AssistantMessageEvent::ToolCallDelta {
                    id: "end-task-call".to_string(),
                    name: END_TASK_TOOL_NAME.to_string(),
                    arguments_delta: r#"{"summary":"Implemented and verified the requested fix."}"#
                        .to_string(),
                },
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for MalformedToolArgumentsProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "bad-call".to_string(),
                        name: "read".to_string(),
                        arguments_delta: r#"{"path":"README.md""#.to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let parse_error = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .find(|result| result.tool_call_id == "bad-call")
                .expect("malformed arguments should be returned to the model");
            assert!(parse_error.is_error);
            // The truncated JSON triggers the EOF-specific helpful message
            assert!(
                parse_error.output.contains("truncated")
                    || parse_error
                        .output
                        .contains("Failed to parse arguments JSON")
            );

            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Recovered from malformed arguments.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for ParallelToolsProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "call-first".to_string(),
                        name: "parallel-first".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::ToolCallDelta {
                        id: "call-second".to_string(),
                        name: "parallel-second".to_string(),
                        arguments_delta: "{}".to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            let result_ids: Vec<_> = messages
                .iter()
                .filter_map(|message| message.tool_result.as_ref())
                .map(|result| result.tool_call_id.as_str())
                .collect();
            assert_eq!(result_ids, vec!["call-first", "call-second"]);
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Both tools completed.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    #[async_trait]
    impl LlmProvider for ContextRecoveryProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            match self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) {
                0 => Ok(Box::pin(stream::iter(vec![AssistantMessageEvent::Error(
                    "context_length_exceeded".to_string(),
                )]))),
                1 => Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("Conversation compacted.".to_string()),
                    AssistantMessageEvent::Done { usage: None },
                ]))),
                _ => Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("Recovered in the same session.".to_string()),
                    AssistantMessageEvent::Done { usage: None },
                ]))),
            }
        }
    }

    #[async_trait]
    impl LlmProvider for ContinuityProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let transcript = messages
                .iter()
                .map(Message::text)
                .collect::<Vec<_>>()
                .join("\n");
            if call == 0 {
                assert!(transcript.contains("amber-orchid"));
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::TextDelta("I will remember amber-orchid.".to_string()),
                    AssistantMessageEvent::ProviderState(ContentPart::ProviderState {
                        provider: "openai".to_string(),
                        data: serde_json::json!({
                            "type": "reasoning",
                            "id": "reasoning-1",
                            "encrypted_content": "opaque-state",
                            "summary": [],
                        }),
                    }),
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }

            assert_eq!(call, 1, "the recall turn should use one provider request");
            assert!(transcript.contains("The continuity phrase is amber-orchid."));
            assert!(transcript.contains("I will remember amber-orchid."));
            assert!(transcript.contains("What was the continuity phrase?"));
            assert!(messages.iter().any(|message| {
                message.content.iter().any(|part| {
                    matches!(
                        part,
                        ContentPart::ProviderState { provider, data }
                            if provider == "openai"
                                && data["encrypted_content"] == "opaque-state"
                    )
                })
            }));
            self.saw_persisted_history
                .store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("amber-orchid".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    struct GuardedTool {
        name: &'static str,
        executed: Arc<std::sync::atomic::AtomicUsize>,
    }

    #[async_trait]
    impl Tool for GuardedTool {
        fn name(&self) -> &str {
            self.name
        }

        fn label(&self) -> &str {
            "Guarded write"
        }

        fn description(&self) -> &str {
            "A consequential test tool that requires approval"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        fn requires_approval(&self) -> bool {
            true
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            self.executed
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ToolExecutionResult::success("guarded tool executed"))
        }
    }

    struct GuardedToolProvider {
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl LlmProvider for GuardedToolProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            let call = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if call == 0 {
                return Ok(Box::pin(stream::iter(vec![
                    AssistantMessageEvent::ToolCallDelta {
                        id: "guarded-call".to_string(),
                        name: "guarded-write".to_string(),
                        arguments_delta: r#"{"value":1}"#.to_string(),
                    },
                    AssistantMessageEvent::Done { usage: None },
                ])));
            }
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Continuing without the tool.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    fn temporary_workspace() -> PathBuf {
        static NEXT_WORKSPACE_ID: std::sync::atomic::AtomicU64 =
            std::sync::atomic::AtomicU64::new(0);
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "axle-streaming-test-{}-{suffix}-{}",
            std::process::id(),
            NEXT_WORKSPACE_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ))
    }

    async fn remove_temporary_workspace(workspace: PathBuf) {
        let mut last_error = None;
        for _ in 0..10 {
            match tokio::fs::remove_dir_all(&workspace).await {
                Ok(()) => return,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
                Err(error) => last_error = Some(error),
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        panic!(
            "failed to remove temporary workspace {}: {}",
            workspace.display(),
            last_error.expect("cleanup attempts should record an error")
        );
    }

    #[tokio::test]
    async fn forwards_deltas_while_reconstructing_the_final_message() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let usage_events = Arc::new(std::sync::Mutex::new(Vec::new()));
        let agent = AgentLoop::new(
            Arc::new(StreamingProvider),
            ToolRegistry::new(),
            {
                let usage_events_for_bus = usage_events.clone();
                let mut event_bus = EventBus::new();
                event_bus.subscribe(move |event| {
                    if let AxleEvent::UsageUpdate {
                        prompt_tokens,
                        completion_tokens,
                        total_tokens,
                        cumulative_total_tokens,
                    } = event
                    {
                        usage_events_for_bus.lock().unwrap().push((
                            *prompt_tokens,
                            *completion_tokens,
                            *total_tokens,
                            *cumulative_total_tokens,
                        ));
                    }
                });
                event_bus
            },
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );
        let mut deltas = Vec::new();

        let response = agent
            .run_turn_streaming("Say hello", &mut session, |event| {
                if let AssistantMessageEvent::TextDelta(delta) = event {
                    deltas.push(delta.clone());
                }
            })
            .await
            .unwrap();

        assert_eq!(deltas, vec!["Hel", "lo"]);
        assert_eq!(response, "Hello");
        assert_eq!(*usage_events.lock().unwrap(), vec![(10, 2, 12, 12)]);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn refuses_to_treat_an_incomplete_provider_stream_as_a_completed_turn() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let agent = AgentLoop::new(
            Arc::new(IncompleteStreamProvider),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let error = agent
            .run_turn_streaming("Continue the task", &mut session, |_| {})
            .await
            .expect_err("an incomplete stream must fail the turn");

        assert!(error
            .to_string()
            .contains("ended before a completion event"));
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn refuses_to_treat_an_incomplete_max_turn_response_as_completed() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let agent = AgentLoop::new(
            Arc::new(IncompleteStreamProvider),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );
        let mut session = SessionManager::create_new(&workspace.to_string_lossy(), None)
            .await
            .unwrap();

        let error = agent
            .run_turn_streaming("Finish the task", &mut session, |_| {})
            .await
            .expect_err("the final response also requires a completion event");

        assert!(error
            .to_string()
            .contains("ended before a completion event"));
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn cancelling_a_pending_stream_drops_it_and_leaves_a_resumable_transcript() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let session_id = session.session_id().to_string();
        let stream_started = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let agent = AgentLoop::new(
            Arc::new(PendingStreamProvider {
                stream_started: stream_started.clone(),
                dropped: dropped.clone(),
            }),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let mut turn = Box::pin(agent.run_turn_streaming(
            "Start a response that never finishes",
            &mut session,
            |_| {},
        ));
        let wait_deadline = Instant::now() + Duration::from_secs(10);
        while !stream_started.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                Instant::now() < wait_deadline,
                "the provider stream never started"
            );
            tokio::select! {
                result = &mut turn => {
                    panic!("the turn should not finish while the stream is pending: {result:?}");
                }
                _ = sleep(Duration::from_millis(5)) => {}
            }
        }

        // Dropping the in-flight turn is exactly what cancelling the CLI
        // future on Ctrl+C does to it.
        drop(turn);

        assert!(
            dropped.load(std::sync::atomic::Ordering::SeqCst),
            "cancelling the turn must drop the in-flight provider stream"
        );

        let context = session.build_context_messages();
        assert!(context.iter().any(|message| message
            .text()
            .contains("Start a response that never finishes")));
        assert!(
            !context
                .iter()
                .any(|message| message.text().contains("partial")),
            "partial stream output must never be persisted as an assistant message"
        );
        assert!(
            context
                .iter()
                .all(|message| matches!(message.role, axle_ai::Role::User)),
            "a turn killed mid-stream must leave only the user message"
        );

        drop(session);
        let resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        assert_eq!(resumed.session_id(), session_id);
        assert!(resumed
            .build_context_messages()
            .iter()
            .any(|message| message
                .text()
                .contains("Start a response that never finishes")));

        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn cancelling_mid_tool_leaves_an_orphaned_call_that_resumes_cleanly() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let session_id = session.session_id().to_string();
        let provider = Arc::new(BlockingToolProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let started = Arc::new(tokio::sync::Notify::new());
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(BlockingTool {
            started: started.clone(),
        }));
        let agent = AgentLoop::new(
            provider.clone(),
            registry,
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let mut turn =
            Box::pin(agent.run_turn_streaming("Run the blocking tool", &mut session, |_| {}));
        tokio::select! {
            result = &mut turn => {
                panic!("the turn should not finish while the tool is blocked: {result:?}");
            }
            _ = started.notified() => {}
        }

        // Dropping the in-flight turn is exactly what cancelling the CLI
        // future on Ctrl+C does to it.
        drop(turn);

        let context = session.build_context_messages();
        let persisted_call = context
            .iter()
            .filter_map(|message| message.tool_calls.as_ref())
            .flatten()
            .find(|call| call.id == "blocking-call")
            .expect("the assistant tool call must be durable before the tool returns");
        assert_eq!(persisted_call.name, "blocking-test-tool");

        let transcript = tokio::fs::read_to_string(session.session_file())
            .await
            .unwrap();
        assert!(
            !transcript.contains(r#""tool_call_id":"blocking-call""#),
            "a tool cancelled mid-execution must not have a recorded result"
        );

        drop(session);
        let mut resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        let repaired = resumed
            .build_context_messages()
            .into_iter()
            .filter_map(|message| message.tool_result)
            .find(|result| result.tool_call_id == "blocking-call")
            .expect("rebuilding context must repair the orphaned tool call");
        assert!(repaired.is_error);
        assert!(repaired.output.contains("interrupted"));

        let resumed_agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );
        let response = resumed_agent
            .run_turn_streaming("Continue after the interruption", &mut resumed, |_| {})
            .await
            .unwrap();
        assert_eq!(response, "Recovered after interruption.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);

        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn compacts_and_retries_context_overflow_without_starting_a_new_session() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        for index in 0..3 {
            session
                .append_message(Message::user(format!("prior-{index}:{}", "x".repeat(100))))
                .await
                .unwrap();
        }

        let provider = Arc::new(ContextRecoveryProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                context_window_tokens: Some(1_000),
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn_streaming("continue the same conversation", &mut session, |_| {})
            .await
            .unwrap();

        assert_eq!(response, "Recovered in the same session.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
        let context = session.build_context_messages();
        assert!(context
            .iter()
            .any(|message| message.text().contains("[Compaction Summary]")));
        assert_eq!(
            context
                .iter()
                .filter(|message| message.text().contains("continue the same conversation"))
                .count(),
            1
        );

        let session_id = session.session_id().to_string();
        drop(agent);
        drop(provider);
        drop(session);
        let resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        let resumed_context = resumed.build_context_messages();
        assert!(resumed_context
            .iter()
            .any(|message| message.text().contains("[Compaction Summary]")));
        assert_eq!(
            resumed_context
                .iter()
                .filter(|message| message.text().contains("continue the same conversation"))
                .count(),
            1
        );
        drop(resumed);

        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn reloads_the_same_session_transcript_for_two_turn_recall() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let provider = Arc::new(ContinuityProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
            saw_persisted_history: std::sync::atomic::AtomicBool::new(false),
        });
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let session_id = session.session_id().to_string();
        let first_agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let first_response = first_agent
            .run_turn_streaming(
                "The continuity phrase is amber-orchid.",
                &mut session,
                |_| {},
            )
            .await
            .unwrap();
        assert_eq!(first_response, "I will remember amber-orchid.");

        drop(first_agent);
        drop(session);
        let mut resumed = SessionManager::load(&cwd, &session_id).await.unwrap();
        assert_eq!(resumed.session_id(), session_id);
        let second_agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd: cwd.clone(),
                ..AgentLoopOptions::default()
            },
        );

        let second_response = second_agent
            .run_turn_streaming("What was the continuity phrase?", &mut resumed, |_| {})
            .await
            .unwrap();

        assert_eq!(second_response, "amber-orchid");
        assert!(provider
            .saw_persisted_history
            .load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(second_agent);
        drop(resumed);
        drop(provider);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn hidden_end_task_closes_the_turn_without_emitting_a_tool_call() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let observed_events = Arc::new(std::sync::Mutex::new(Vec::<AxleEvent>::new()));
        let observed_events_for_bus = observed_events.clone();
        let mut event_bus = EventBus::new();
        event_bus.subscribe(move |event| {
            observed_events_for_bus.lock().unwrap().push(event.clone());
        });
        let provider = Arc::new(EndTaskProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            event_bus,
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Implement the requested fix", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Implemented and verified the requested fix.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        let events = observed_events.lock().unwrap();
        assert!(!events.iter().any(|event| matches!(
            event,
            AxleEvent::ToolExecutionStart { tool_name, .. }
                | AxleEvent::ToolExecutionEnd { tool_name, .. }
                if tool_name == END_TASK_TOOL_NAME
        )));
        assert!(events
            .iter()
            .any(|event| matches!(event, AxleEvent::AgentEnd)));
        let messages = session.build_context_messages();
        assert!(messages.iter().any(|message| {
            message
                .tool_calls
                .as_deref()
                .is_some_and(|calls| calls.iter().any(|call| call.name == END_TASK_TOOL_NAME))
        }));
        assert!(messages.iter().any(|message| {
            message
                .tool_result
                .as_ref()
                .is_some_and(|result| result.tool_call_id == "end-task-call")
        }));

        drop(agent);
        drop(provider);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn returns_malformed_tool_arguments_to_the_model_as_an_error_result() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let provider = Arc::new(MalformedToolArgumentsProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Trigger a malformed tool call", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Recovered from malformed arguments.");
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(agent);
        drop(provider);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn executes_parallel_tools_concurrently_and_records_results_in_call_order() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(BarrierTool {
            name: "parallel-first",
            barrier: barrier.clone(),
        }));
        registry.register(Arc::new(BarrierTool {
            name: "parallel-second",
            barrier,
        }));
        let agent = AgentLoop::new(
            Arc::new(ParallelToolsProvider {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }),
            registry,
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            agent.run_turn("Run both tools", &mut session),
        )
        .await
        .expect("parallel tools should meet at the barrier")
        .unwrap();

        assert_eq!(response, "Both tools completed.");
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn browser_tools_are_available_for_ordinary_implementation_requests() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let executed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(BrowserStatusTool {
            executed: executed.clone(),
        }));
        let provider = Arc::new(BrowserToolProvider {
            calls: std::sync::atomic::AtomicUsize::new(0),
        });
        let agent = AgentLoop::new(
            provider.clone(),
            registry,
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Implement the requested layout fix.", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Browser verified.");
        assert!(executed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(provider.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        drop(agent);
        drop(provider);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    fn guarded_registry(executed: &Arc<std::sync::atomic::AtomicUsize>) -> ToolRegistry {
        let mut registry = ToolRegistry::default();
        registry.register(Arc::new(GuardedTool {
            name: "guarded-write",
            executed: executed.clone(),
        }));
        registry
    }

    fn guarded_tool_result(session: &SessionManager) -> axle_ai::ToolResult {
        session
            .build_context_messages()
            .into_iter()
            .filter_map(|message| message.tool_result)
            .find(|result| result.tool_call_id == "guarded-call")
            .expect("the guarded tool call should have a recorded result")
    }

    #[tokio::test]
    async fn runtime_modes_enforce_edit_command_and_mcp_boundaries() {
        for (mode, auto_accept_edits, approval_enabled) in [
            ("approval-required", false, true),
            ("auto-accept-edits", true, true),
            ("full-access", false, false),
        ] {
            let workspace = temporary_workspace();
            tokio::fs::create_dir_all(&workspace).await.unwrap();
            let executed = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let mut registry = ToolRegistry::new();
            // Consequential probes never execute a real shell or contact MCP.
            for name in ["bash", "mcp__github__write"] {
                registry.register(Arc::new(GuardedTool {
                    name,
                    executed: executed.clone(),
                }));
            }
            let approval_file = workspace.join("approval.jsonl");
            let requested = Arc::new(std::sync::Mutex::new(Vec::new()));
            let mut event_bus = EventBus::new();
            {
                let requested = requested.clone();
                let approval_file = approval_file.clone();
                event_bus.subscribe(move |event| {
                    if let AxleEvent::ToolApprovalRequested {
                        request_id,
                        tool_name,
                        ..
                    } = event
                    {
                        requested.lock().unwrap().push(tool_name.clone());
                        std::fs::write(&approval_file, serde_json::json!({
                            "type": "approval_response", "requestId": request_id, "decision": "deny"
                        }).to_string()).unwrap();
                    }
                });
            }
            let agent = AgentLoop::new(
                Arc::new(GuardedToolProvider {
                    calls: std::sync::atomic::AtomicUsize::new(0),
                }),
                registry,
                event_bus,
                AgentLoopOptions {
                    cwd: workspace.to_string_lossy().to_string(),
                    approval: approval_enabled.then_some(ApprovalConfig {
                        file: approval_file,
                        timeout: Duration::from_secs(1),
                        auto_accept_edits,
                    }),
                    ..AgentLoopOptions::default()
                },
            );
            tokio::fs::write(workspace.join("edit.txt"), "before")
                .await
                .unwrap();
            for (name, arguments) in [
                (
                    "write",
                    serde_json::json!({ "path": "written.txt", "content": "created" }),
                ),
                (
                    "edit",
                    serde_json::json!({ "path": "edit.txt", "old_text": "before", "new_text": "after" }),
                ),
                ("bash", serde_json::json!({})),
                ("mcp__github__write", serde_json::json!({})),
            ] {
                let result = agent
                    .execute_tool_call_result(&ToolCall {
                        id: format!("{mode}-{name}"),
                        name: name.to_string(),
                        arguments,
                    })
                    .await;
                let allowed =
                    !approval_enabled || (auto_accept_edits && matches!(name, "write" | "edit"));
                assert_eq!(
                    !result.is_error, allowed,
                    "{mode}: {name}: {}",
                    result.output
                );
            }
            assert_eq!(
                workspace.join("written.txt").exists(),
                !approval_enabled || auto_accept_edits
            );
            assert_eq!(
                std::fs::read_to_string(workspace.join("edit.txt")).unwrap(),
                if !approval_enabled || auto_accept_edits {
                    "after"
                } else {
                    "before"
                }
            );
            assert_eq!(
                executed.load(std::sync::atomic::Ordering::SeqCst),
                if approval_enabled { 0 } else { 2 }
            );
            let requests = requested.lock().unwrap().clone();
            assert_eq!(
                requests,
                match mode {
                    "approval-required" => vec!["write", "edit", "bash", "mcp__github__write"],
                    "auto-accept-edits" => vec!["bash", "mcp__github__write"],
                    _ => vec![],
                }
            );
            // Auto approval cannot bypass the native file-path boundary.
            let escape = agent.execute_tool_call_result(&ToolCall {
                id: "escape".to_string(), name: "write".to_string(),
                arguments: serde_json::json!({ "path": "../escaped.txt", "content": "blocked" }),
            }).await;
            assert!(escape.is_error);
            // Plan mode restricts the registry even in full access.
            let plan_agent = AgentLoop::new(
                agent.provider.clone(),
                agent.tool_registry.clone(),
                EventBus::new(),
                AgentLoopOptions {
                    cwd: workspace.to_string_lossy().to_string(),
                    interaction_mode: InteractionMode::Plan,
                    approval: agent.options.approval.clone(),
                    ..AgentLoopOptions::default()
                },
            );
            let plan_write = plan_agent
                .execute_tool_call_result(&ToolCall {
                    id: "plan-write".to_string(),
                    name: "write".to_string(),
                    arguments: serde_json::json!({ "path": "plan.txt", "content": "blocked" }),
                })
                .await;
            assert!(plan_write.is_error);
            assert!(!workspace.join("plan.txt").exists());
            // MCP discovery registers names verbatim. A replacement named
            // "write" must never inherit the native tool's auto approval.
            let mut shadowed_registry = agent.tool_registry.clone();
            shadowed_registry.register(Arc::new(GuardedTool {
                name: "write",
                executed: executed.clone(),
            }));
            let shadowed_agent = AgentLoop::new(
                agent.provider.clone(),
                shadowed_registry,
                EventBus::new(),
                AgentLoopOptions {
                    cwd: workspace.to_string_lossy().to_string(),
                    approval: agent.options.approval.clone().map(|mut approval| {
                        approval.timeout = Duration::from_millis(1);
                        approval
                    }),
                    ..AgentLoopOptions::default()
                },
            );
            let shadowed_write = shadowed_agent
                .execute_tool_call_result(&ToolCall {
                    id: "shadowed-write".to_string(),
                    name: "write".to_string(),
                    arguments: serde_json::json!({}),
                })
                .await;
            assert_eq!(shadowed_write.is_error, approval_enabled);
            drop(shadowed_agent);
            drop(plan_agent);
            drop(agent);
            remove_temporary_workspace(workspace).await;
        }
    }

    #[tokio::test]
    async fn approval_gate_denies_consequential_tool_when_the_user_declines() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let approval_file = workspace.join("approval.jsonl");
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let executed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let mut event_bus = EventBus::new();
        {
            let approval_path = approval_file.clone();
            event_bus.subscribe(move |event| {
                if let AxleEvent::ToolApprovalRequested { request_id, .. } = event {
                    std::fs::write(
                        &approval_path,
                        format!(
                            "{{\"type\":\"approval_response\",\"requestId\":\"{request_id}\",\"decision\":\"deny\"}}\n"
                        ),
                    )
                    .expect("the test should be able to answer the approval request");
                }
            });
        }

        let agent = AgentLoop::new(
            Arc::new(GuardedToolProvider {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }),
            guarded_registry(&executed),
            event_bus,
            AgentLoopOptions {
                cwd,
                approval: Some(ApprovalConfig {
                    file: approval_file,
                    timeout: Duration::from_secs(5),
                    auto_accept_edits: false,
                }),
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Please run the guarded tool.", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Continuing without the tool.");
        assert_eq!(executed.load(std::sync::atomic::Ordering::SeqCst), 0);
        let result = guarded_tool_result(&session);
        assert!(result.is_error);
        assert!(result.output.contains("denied"));
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn approval_gate_executes_consequential_tool_when_the_user_approves() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let approval_file = workspace.join("approval.jsonl");
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let executed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let mut event_bus = EventBus::new();
        {
            let approval_path = approval_file.clone();
            event_bus.subscribe(move |event| {
                if let AxleEvent::ToolApprovalRequested { request_id, .. } = event {
                    std::fs::write(
                        &approval_path,
                        format!(
                            "{{\"type\":\"approval_response\",\"requestId\":\"{request_id}\",\"decision\":\"accept\"}}\n"
                        ),
                    )
                    .expect("the test should be able to answer the approval request");
                }
            });
        }

        let agent = AgentLoop::new(
            Arc::new(GuardedToolProvider {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }),
            guarded_registry(&executed),
            event_bus,
            AgentLoopOptions {
                cwd,
                approval: Some(ApprovalConfig {
                    file: approval_file,
                    timeout: Duration::from_secs(5),
                    auto_accept_edits: false,
                }),
                ..AgentLoopOptions::default()
            },
        );

        let response = agent
            .run_turn("Please run the guarded tool.", &mut session)
            .await
            .unwrap();

        assert_eq!(response, "Continuing without the tool.");
        assert_eq!(executed.load(std::sync::atomic::Ordering::SeqCst), 1);
        let result = guarded_tool_result(&session);
        assert!(!result.is_error);
        assert!(result.output.contains("guarded tool executed"));
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn approval_gate_denies_when_no_decision_arrives_before_the_timeout() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let approval_file = workspace.join("approval.jsonl");
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let executed = Arc::new(std::sync::atomic::AtomicUsize::new(0));

        let agent = AgentLoop::new(
            Arc::new(GuardedToolProvider {
                calls: std::sync::atomic::AtomicUsize::new(0),
            }),
            guarded_registry(&executed),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                approval: Some(ApprovalConfig {
                    file: approval_file,
                    timeout: Duration::from_millis(60),
                    auto_accept_edits: false,
                }),
                ..AgentLoopOptions::default()
            },
        );

        let response = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            agent.run_turn("Please run the guarded tool.", &mut session),
        )
        .await
        .expect("the approval timeout should release the turn")
        .unwrap();

        assert_eq!(response, "Continuing without the tool.");
        assert_eq!(executed.load(std::sync::atomic::Ordering::SeqCst), 0);
        let result = guarded_tool_result(&session);
        assert!(result.is_error);
        assert!(result.output.contains("timed out"));
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[test]
    fn approval_response_parser_matches_only_the_requested_id() {
        let contents = concat!(
            "{\"type\":\"approval_response\",\"requestId\":\"other-call:1\",\"decision\":\"deny\"}\n",
            "not json\n",
            "{\"type\":\"approval_response\",\"requestId\":\"guarded-call:2\",\"decision\":\"maybe\"}\n"
        );
        assert_eq!(read_approval_response(contents, "guarded-call:2"), None);
        assert_eq!(
            read_approval_response(
                &format!("{contents}{{\"type\":\"approval_response\",\"requestId\":\"guarded-call:2\",\"decision\":\"allow\"}}\n"),
                "guarded-call:2"
            ),
            Some(ApprovalVerdict::Allow)
        );
        assert_eq!(
            read_approval_response(contents, "other-call:1"),
            Some(ApprovalVerdict::Deny {
                reason: "denied".to_string()
            })
        );
    }

    struct CapabilityRecordingProvider {
        seen: Arc<std::sync::Mutex<Vec<CompletionOptions>>>,
    }

    #[async_trait]
    impl LlmProvider for CapabilityRecordingProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        fn capabilities(&self, _model: &str) -> axle_ai::ModelCapabilities {
            axle_ai::ModelCapabilities {
                supports_temperature: false,
                supports_reasoning_effort: false,
                supports_tools: true,
                supports_images: true,
            }
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            self.seen
                .lock()
                .expect("the captured options should be readable")
                .push(options.clone());
            Ok(Box::pin(stream::iter(vec![
                AssistantMessageEvent::TextDelta("Done.".to_string()),
                AssistantMessageEvent::Done { usage: None },
            ])))
        }
    }

    struct TextOnlyProvider;

    #[async_trait]
    impl LlmProvider for TextOnlyProvider {
        fn provider_name(&self) -> &str {
            "test"
        }

        fn capabilities(&self, _model: &str) -> axle_ai::ModelCapabilities {
            axle_ai::ModelCapabilities {
                supports_temperature: true,
                supports_reasoning_effort: true,
                supports_tools: true,
                supports_images: false,
            }
        }

        async fn complete(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<Message> {
            anyhow::bail!("the streaming agent loop must not call complete")
        }

        async fn stream(
            &self,
            _messages: &[Message],
            _options: &CompletionOptions,
        ) -> anyhow::Result<EventStream> {
            anyhow::bail!("no request should reach a text-only provider")
        }
    }

    #[tokio::test]
    async fn drops_sampling_parameters_the_model_does_not_support() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));

        let agent = AgentLoop::new(
            Arc::new(CapabilityRecordingProvider { seen: seen.clone() }),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                temperature: Some(0.7),
                reasoning_effort: Some("high".to_string()),
                ..AgentLoopOptions::default()
            },
        );

        let response = agent.run_turn("Say hello.", &mut session).await.unwrap();
        assert_eq!(response, "Done.");

        let captured = seen
            .lock()
            .expect("the captured options should be readable");
        assert_eq!(captured.len(), 1);
        assert_eq!(captured[0].temperature, None);
        assert_eq!(captured[0].reasoning_effort, None);
        drop(captured);
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[tokio::test]
    async fn rejects_image_attachments_when_the_model_has_no_image_input() {
        let workspace = temporary_workspace();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let cwd = workspace.to_string_lossy().to_string();
        let mut session = SessionManager::create_new(&cwd, None).await.unwrap();

        let agent = AgentLoop::new(
            Arc::new(TextOnlyProvider),
            ToolRegistry::new(),
            EventBus::new(),
            AgentLoopOptions {
                cwd,
                ..AgentLoopOptions::default()
            },
        );

        let error = agent
            .run_turn_with_images(
                "Describe this image.",
                vec![ContentPart::Image {
                    data: "aGVsbG8=".to_string(),
                    mime_type: "image/png".to_string(),
                }],
                &mut session,
            )
            .await
            .expect_err("a text-only model must reject image attachments");

        assert!(error.to_string().contains("does not accept image input"));
        drop(agent);
        drop(session);
        remove_temporary_workspace(workspace).await;
    }

    #[test]
    fn detects_thinking_replay_errors() {
        assert!(is_thinking_replay_error(
            "The `content[].thinking` in the thinking mode must be passed back to the API."
        ));
        assert!(is_thinking_replay_error(
            "thinking must be passed back to the API"
        ));
        assert!(is_thinking_replay_error(
            "reasoning_content must be passed back"
        ));
        assert!(!is_thinking_replay_error(
            "Invalid schema for function 'ls'"
        ));
        assert!(!is_thinking_replay_error("invalid api key"));
    }

    #[test]
    fn detects_transient_provider_errors_with_capped_backoff() {
        assert!(is_transient_provider_error("HTTP 503 Service Unavailable"));
        assert!(is_transient_provider_error("429 Too Many Requests"));
        assert!(is_transient_provider_error("stream ended unexpectedly"));
        assert!(is_transient_provider_error("connection reset by peer"));
        assert!(is_transient_provider_error("request timed out"));
        assert!(!is_transient_provider_error(
            "Invalid schema for function 'ls'"
        ));
        assert!(!is_transient_provider_error("invalid api key"));

        assert_eq!(stream_retry_delay(1), Duration::from_millis(750));
        assert_eq!(stream_retry_delay(2), Duration::from_millis(1_500));
        assert_eq!(stream_retry_delay(3), Duration::from_millis(3_000));
    }
}

impl Default for AgentLoopOptions {
    fn default() -> Self {
        Self {
            cwd: ".".to_string(),
            workspace_context: true,
            model_name: "gpt-4o".to_string(),
            temperature: Some(0.7),
            reasoning_effort: None,
            append_system_prompt: None,
            context_window_tokens: Some(DEFAULT_CONTEXT_WINDOW_TOKENS),
            memory_context: None,
            interaction_mode: InteractionMode::Build,
            approval: None,
        }
    }
}

pub struct AgentLoop {
    provider: Arc<dyn LlmProvider>,
    tool_registry: ToolRegistry,
    event_bus: EventBus,
    pending_background_tools: tokio::sync::Mutex<HashMap<String, PendingBackgroundTool>>,
    compaction: CompactionEngine,
    options: AgentLoopOptions,
}

struct PendingBackgroundTool {
    tool_call_id: String,
    tool_name: String,
}

fn is_end_task_tool(tool_call: &ToolCall) -> bool {
    tool_call.name == END_TASK_TOOL_NAME
}

fn is_context_window_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("context_length_exceeded")
        || message.contains("context window")
        || message.contains("contextwindowexceeded")
        || message.contains("maximum context")
}

const MAX_STREAM_RETRIES: u32 = 3;

fn is_thinking_replay_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    message.contains("content[].thinking")
        || (message.contains("thinking") && message.contains("must be passed back"))
        || (message.contains("reasoning_content") && message.contains("passed back"))
}

fn stream_retry_delay(retry_index: u32) -> Duration {
    Duration::from_millis(750 * 2u64.saturating_pow(retry_index.saturating_sub(1)))
}

fn is_transient_provider_error(message: &str) -> bool {
    let message = message.to_ascii_lowercase();
    [
        "429",
        "rate limit",
        "rate_limit",
        "too many requests",
        "http 500",
        "http 502",
        "http 503",
        "http 504",
        "internal server error",
        "bad gateway",
        "service unavailable",
        "gateway timeout",
        "overloaded",
        "temporarily unavailable",
        "timed out",
        "timeout",
        "connection reset",
        "connection closed",
        "connection refused",
        "connection error",
        "econnreset",
        "etimedout",
        "stream ended unexpectedly",
    ]
    .iter()
    .any(|needle| message.contains(needle))
}

fn end_task_summary(tool_call: &ToolCall) -> Option<String> {
    tool_call
        .arguments
        .get("summary")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|summary| !summary.is_empty())
        .map(ToOwned::to_owned)
}

impl AgentLoop {
    pub fn new(
        provider: Arc<dyn LlmProvider>,
        tool_registry: ToolRegistry,
        event_bus: EventBus,
        options: AgentLoopOptions,
    ) -> Self {
        Self {
            provider,
            tool_registry,
            event_bus,
            pending_background_tools: tokio::sync::Mutex::new(HashMap::new()),
            compaction: CompactionEngine::default(),
            options,
        }
    }

    /// Update the per-turn policy used by a long-lived agent process. The
    /// persistent JSON stream calls this before each turn because the desktop
    /// can switch between build and plan mode without restarting the CLI.
    pub fn set_turn_context(
        &mut self,
        interaction_mode: InteractionMode,
        memory_context: Option<String>,
    ) {
        self.options.interaction_mode = interaction_mode;
        self.options.memory_context = memory_context;
    }

    pub async fn run_turn(
        &self,
        user_prompt: &str,
        session: &mut SessionManager,
    ) -> anyhow::Result<String> {
        self.run_turn_streaming_with_images(user_prompt, Vec::new(), session, |_| {})
            .await
    }

    pub async fn run_turn_with_images(
        &self,
        user_prompt: &str,
        images: Vec<ContentPart>,
        session: &mut SessionManager,
    ) -> anyhow::Result<String> {
        self.run_turn_streaming_with_images(user_prompt, images, session, |_| {})
            .await
    }

    pub async fn compact_session(&self, session: &mut SessionManager) -> anyhow::Result<bool> {
        let Some(context_window_tokens) = self.options.context_window_tokens else {
            return Ok(false);
        };
        self.compaction
            .compact(
                session,
                self.provider.clone(),
                &self.options.model_name,
                context_window_tokens,
            )
            .await
    }

    async fn compact_session_now(&self, session: &mut SessionManager) -> anyhow::Result<bool> {
        let Some(context_window_tokens) = self.options.context_window_tokens else {
            return Ok(false);
        };
        self.compaction
            .compact_now(
                session,
                self.provider.clone(),
                &self.options.model_name,
                context_window_tokens,
            )
            .await
    }

    pub async fn run_turn_streaming<F>(
        &self,
        user_prompt: &str,
        session: &mut SessionManager,
        on_event: F,
    ) -> anyhow::Result<String>
    where
        F: FnMut(&AssistantMessageEvent),
    {
        self.run_turn_streaming_with_images(user_prompt, Vec::new(), session, on_event)
            .await
    }

    pub async fn run_turn_streaming_with_images<F>(
        &self,
        user_prompt: &str,
        images: Vec<ContentPart>,
        session: &mut SessionManager,
        mut on_event: F,
    ) -> anyhow::Result<String>
    where
        F: FnMut(&AssistantMessageEvent),
    {
        let plan_mode = self.options.interaction_mode == InteractionMode::Plan;
        let tools_schemas = self.tool_registry.get_schemas_for_mode(plan_mode);
        let capabilities = self.provider.capabilities(&self.options.model_name);

        let prompt_builder = PromptBuilder::new(&self.options.cwd)
            .with_workspace_context(self.options.workspace_context)
            .with_append_prompt(self.options.append_system_prompt.clone())
            .with_plan_mode(plan_mode);
        let mut system_prompt = prompt_builder.build().await;
        if let Some(memory_context) = self
            .options
            .memory_context
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            system_prompt.push_str("\n\n");
            system_prompt.push_str(memory_context);
        }

        self.event_bus.emit(&AxleEvent::BeforeAgentStart {
            prompt: user_prompt.to_string(),
            system_prompt: system_prompt.clone(),
        });

        // Preserve images as provider-native content instead of reducing the
        // turn to text before it reaches the LLM request builder.
        if !user_prompt.trim().is_empty() || !images.is_empty() {
            if !images.is_empty() && !capabilities.supports_images {
                anyhow::bail!(
                    "model '{}' does not accept image input; remove the attachments and retry",
                    self.options.model_name
                );
            }
            let mut content = Vec::with_capacity(1 + images.len());
            if !user_prompt.trim().is_empty() {
                content.push(ContentPart::Text {
                    text: user_prompt.to_string(),
                });
            }
            content.extend(images);
            session
                .append_message(Message::user_with_content(content))
                .await?;
        }

        self.event_bus.emit(&AxleEvent::AgentStart);

        let mut turn_count = 0;
        let mut final_response = String::new();
        let mut cumulative_usage = UsageStats {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };

        loop {
            turn_count += 1;

            self.event_bus.emit(&AxleEvent::TurnStart {
                turn_index: turn_count,
            });

            let completion_options = CompletionOptions {
                model: self.options.model_name.clone(),
                temperature: if capabilities.supports_temperature {
                    self.options.temperature
                } else {
                    None
                },
                max_tokens: Some(max_output_tokens_for_model(&self.options.model_name)),
                reasoning_effort: if capabilities.supports_reasoning_effort {
                    self.options.reasoning_effort.clone()
                } else {
                    None
                },
                tools: tools_schemas.clone(),
                ..Default::default()
            };

            let mut context_recovery_attempted = false;
            let mut thinking_replay_recovery_attempted = false;
            let mut stream_retry_attempts: u32 = 0;
            let (text_output, tool_call_parts, provider_state, thinking_output, attempt_usage) = 'completion: loop {
                if let Some(context_window) = self.options.context_window_tokens {
                    self.compaction
                        .compact(
                            session,
                            self.provider.clone(),
                            &self.options.model_name,
                            context_window,
                        )
                        .await?;
                }

                let mut context_messages = vec![Message::system(&system_prompt)];
                context_messages.extend(session.build_context_messages());
                let mut event_stream = match self
                    .provider
                    .stream(&context_messages, &completion_options)
                    .await
                {
                    Ok(stream) => stream,
                    Err(error) => {
                        let error_text = error.to_string();
                        if !context_recovery_attempted && is_context_window_error(&error_text) {
                            context_recovery_attempted = true;
                            if self.compact_session_now(session).await? {
                                continue 'completion;
                            }
                        }
                        if !thinking_replay_recovery_attempted
                            && is_thinking_replay_error(&error_text)
                            && session.repair_missing_thinking_for_replay() > 0
                        {
                            thinking_replay_recovery_attempted = true;
                            session.rewrite_session_file().await?;
                            tracing::warn!(
                                "LLM rejected replayed history without thinking parts; repaired session and retrying"
                            );
                            continue 'completion;
                        }
                        if stream_retry_attempts < MAX_STREAM_RETRIES
                            && is_transient_provider_error(&error_text)
                        {
                            stream_retry_attempts += 1;
                            let delay = stream_retry_delay(stream_retry_attempts);
                            tracing::warn!(
                                "Transient provider error on stream start (attempt {}/{}): {}; retrying in {:?}",
                                stream_retry_attempts,
                                MAX_STREAM_RETRIES,
                                error_text,
                                delay
                            );
                            sleep(delay).await;
                            continue 'completion;
                        }
                        tracing::error!("LLM stream failed: {}", error);
                        return Err(error);
                    }
                };

                let mut text_output = String::new();
                let mut thinking_output = String::new();
                let mut tool_call_parts: Vec<(String, String, String)> = Vec::new();
                let mut provider_state = Vec::new();
                let mut attempt_usage = UsageStats {
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    total_tokens: 0,
                };
                let mut saw_partial_output = false;
                let mut saw_completion = false;
                while let Some(event) = event_stream.next().await {
                    on_event(&event);
                    match event {
                        AssistantMessageEvent::TextDelta(delta) => {
                            saw_partial_output = true;
                            text_output.push_str(&delta);
                        }
                        AssistantMessageEvent::ToolCallDelta {
                            id,
                            name,
                            arguments_delta,
                        } => {
                            saw_partial_output = true;
                            if let Some((_, stored_name, stored_arguments)) = tool_call_parts
                                .iter_mut()
                                .find(|(stored_id, _, _)| *stored_id == id)
                            {
                                if !name.is_empty() {
                                    *stored_name = name;
                                }
                                stored_arguments.push_str(&arguments_delta);
                            } else {
                                tool_call_parts.push((id, name, arguments_delta));
                            }
                        }
                        AssistantMessageEvent::Error(message) => {
                            if !saw_partial_output
                                && !context_recovery_attempted
                                && is_context_window_error(&message)
                            {
                                context_recovery_attempted = true;
                                if self.compact_session_now(session).await? {
                                    continue 'completion;
                                }
                            }
                            if !saw_partial_output
                                && stream_retry_attempts < MAX_STREAM_RETRIES
                                && is_transient_provider_error(&message)
                            {
                                stream_retry_attempts += 1;
                                let delay = stream_retry_delay(stream_retry_attempts);
                                tracing::warn!(
                                    "Transient provider error mid-stream (attempt {}/{}): {}; retrying in {:?}",
                                    stream_retry_attempts,
                                    MAX_STREAM_RETRIES,
                                    message,
                                    delay
                                );
                                sleep(delay).await;
                                continue 'completion;
                            }
                            anyhow::bail!(message)
                        }
                        AssistantMessageEvent::Done { usage: Some(usage) } => {
                            Self::accumulate_usage(&mut attempt_usage, &usage);
                            saw_completion = true;
                            break;
                        }
                        AssistantMessageEvent::ProviderState(state) => {
                            provider_state.push(state);
                        }
                        AssistantMessageEvent::ThinkingDelta(delta) => {
                            thinking_output.push_str(&delta);
                        }
                        AssistantMessageEvent::Done { usage: None } => {
                            saw_completion = true;
                            break;
                        }
                    }
                }
                if !saw_completion {
                    anyhow::bail!(
                        "LLM stream ended before a completion event; refusing to treat partial output as a completed turn"
                    );
                }
                break (
                    text_output,
                    tool_call_parts,
                    provider_state,
                    thinking_output,
                    attempt_usage,
                );
            };
            self.record_usage(&mut cumulative_usage, &attempt_usage);

            let mut malformed_arguments = HashMap::new();
            let tool_calls: Vec<ToolCall> = tool_call_parts
                .into_iter()
                .map(|(id, name, arguments)| {
                    let parsed_arguments = match serde_json::from_str(&arguments) {
                        Ok(arguments) => arguments,
                        Err(err) => {
                            let message = if err.is_eof() {
                                "The tool call JSON was truncated mid-content. The file content is too large for a single write. Split the content into smaller files or write the file in multiple smaller steps. Do NOT retry the exact same large write.".to_string()
                            } else {
                                format!("Failed to parse arguments JSON: {err}")
                            };
                            tracing::error!(
                                tool_call_id = %id,
                                tool_name = %name,
                                error = %err,
                                arguments_len = arguments.len(),
                                "LLM returned malformed tool arguments"
                            );
                            malformed_arguments.insert(id.clone(), message);
                            serde_json::json!({})
                        }
                    };

                    ToolCall {
                        id,
                        name,
                        arguments: parsed_arguments,
                    }
                })
                .collect();
            let mut assistant_msg = Message::assistant(
                text_output.clone(),
                if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
            );
            assistant_msg.provider = Some(self.provider.provider_name().to_string());
            assistant_msg.model = Some(self.options.model_name.clone());
            assistant_msg.content.extend(provider_state);
            if !thinking_output.is_empty() {
                assistant_msg.content.push(ContentPart::Thinking {
                    thinking: thinking_output,
                    signature: None,
                });
            }

            let tool_calls = assistant_msg.tool_calls.clone().unwrap_or_default();
            let end_task_call_index = tool_calls.iter().position(|call| {
                is_end_task_tool(call) && !malformed_arguments.contains_key(&call.id)
            });
            let terminal_summary =
                end_task_call_index.and_then(|index| end_task_summary(&tool_calls[index]));
            if let Some(summary) = terminal_summary.as_ref() {
                if text_output.trim().is_empty() {
                    assistant_msg.content = vec![ContentPart::Text {
                        text: summary.clone(),
                    }];
                } else if !text_output.contains(summary) {
                    assistant_msg.content.push(ContentPart::Text {
                        text: format!("\n\n{summary}"),
                    });
                }
            }

            if !text_output.trim().is_empty() {
                final_response.push_str(&text_output);
            }

            session.append_message(assistant_msg.clone()).await?;

            if tool_calls.is_empty() {
                self.event_bus.emit(&AxleEvent::TurnEnd {
                    turn_index: turn_count,
                });
                break;
            }

            // `end_task` is a control-only tool. It is exposed to the model so
            // the model can explicitly close a completed task, but its own
            // lifecycle is never emitted to the UI. A valid summary is
            // required before it can terminate the agent loop.
            if let Some(end_task_call_index) = end_task_call_index {
                for (index, tool_call) in tool_calls.iter().enumerate() {
                    if index > end_task_call_index {
                        self.append_tool_result(
                            tool_call,
                            ToolExecutionResult::error("Task ended before this tool was executed."),
                            session,
                        )
                        .await?;
                        continue;
                    }

                    if let Some(error) = malformed_arguments.remove(&tool_call.id) {
                        self.record_tool_call_error(tool_call, error, session)
                            .await?;
                        continue;
                    }

                    let result = if index == end_task_call_index {
                        self.execute_tool_call_result_silent(tool_call).await
                    } else {
                        self.execute_tool_call_result(tool_call).await
                    };
                    self.append_tool_result(tool_call, result, session).await?;
                }

                let summary = terminal_summary
                    .as_deref()
                    .expect("validated end_task call should include a summary");
                if text_output.trim().is_empty() {
                    final_response.push_str(summary);
                    on_event(&AssistantMessageEvent::TextDelta(summary.to_string()));
                } else if !text_output.contains(summary) {
                    let suffix = format!("\n\n{summary}");
                    final_response.push_str(&suffix);
                    on_event(&AssistantMessageEvent::TextDelta(suffix));
                }
                self.event_bus.emit(&AxleEvent::TurnEnd {
                    turn_index: turn_count,
                });
                break;
            }

            // Execute sequential tools in place and adjacent parallel tools as a batch.
            let mut tool_index = 0;
            while tool_index < tool_calls.len() {
                let tool_call = &tool_calls[tool_index];
                if is_end_task_tool(tool_call) {
                    let result = self.execute_tool_call_result_silent(tool_call).await;
                    self.append_tool_result(tool_call, result, session).await?;
                    tool_index += 1;
                    continue;
                }
                if let Some(error) = malformed_arguments.remove(&tool_call.id) {
                    self.record_tool_call_error(tool_call, error, session)
                        .await?;
                    tool_index += 1;
                    continue;
                }

                if self.execution_mode(tool_call) == ToolExecutionMode::Sequential {
                    self.execute_tool_call(tool_call, session).await?;
                    tool_index += 1;
                    continue;
                }

                let mut batch_end = tool_index + 1;
                while batch_end < tool_calls.len()
                    && !malformed_arguments.contains_key(&tool_calls[batch_end].id)
                    && self.execution_mode(&tool_calls[batch_end]) == ToolExecutionMode::Parallel
                {
                    batch_end += 1;
                }

                let results = join_all(
                    tool_calls[tool_index..batch_end]
                        .iter()
                        .map(|call| self.execute_tool_call_result(call)),
                )
                .await;
                for (call, result) in tool_calls[tool_index..batch_end].iter().zip(results) {
                    self.append_tool_result(call, result, session).await?;
                }
                tool_index = batch_end;
            }

            self.event_bus.emit(&AxleEvent::TurnEnd {
                turn_index: turn_count,
            });
        }

        self.event_bus.emit(&AxleEvent::AgentEnd);
        Ok(final_response)
    }

    async fn execute_tool_call(
        &self,
        tool_call: &ToolCall,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        let result = self.execute_tool_call_result(tool_call).await;
        self.append_tool_result(tool_call, result, session).await
    }

    fn record_usage(&self, cumulative: &mut UsageStats, usage: &UsageStats) {
        Self::accumulate_usage(cumulative, usage);
        if usage.prompt_tokens == 0 && usage.completion_tokens == 0 && usage.total_tokens == 0 {
            return;
        }
        self.event_bus.emit(&AxleEvent::UsageUpdate {
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            cumulative_total_tokens: cumulative.total_tokens as u64,
        });
    }

    fn accumulate_usage(cumulative: &mut UsageStats, usage: &UsageStats) {
        cumulative.prompt_tokens = cumulative.prompt_tokens.saturating_add(usage.prompt_tokens);
        cumulative.completion_tokens = cumulative
            .completion_tokens
            .saturating_add(usage.completion_tokens);
        cumulative.total_tokens = cumulative.total_tokens.saturating_add(usage.total_tokens);
    }

    fn execution_mode(&self, tool_call: &ToolCall) -> ToolExecutionMode {
        self.tool_registry
            .get_for_mode(
                &tool_call.name,
                self.options.interaction_mode == InteractionMode::Plan,
            )
            .map(|tool| tool.execution_mode())
            .unwrap_or(ToolExecutionMode::Sequential)
    }

    async fn execute_tool_call_result(&self, tool_call: &ToolCall) -> ToolExecutionResult {
        self.execute_tool_call_result_with_events(tool_call, true)
            .await
    }

    async fn execute_tool_call_result_silent(&self, tool_call: &ToolCall) -> ToolExecutionResult {
        self.execute_tool_call_result_with_events(tool_call, false)
            .await
    }

    async fn execute_tool_call_result_with_events(
        &self,
        tool_call: &ToolCall,
        emit_events: bool,
    ) -> ToolExecutionResult {
        if emit_events {
            self.event_bus.emit(&AxleEvent::ToolExecutionStart {
                tool_call_id: tool_call.id.clone(),
                tool_name: tool_call.name.clone(),
                arguments: tool_call.arguments.clone(),
            });
        }

        let plan_mode = self.options.interaction_mode == InteractionMode::Plan;
        if let Some(approval) = self.options.approval.as_ref() {
            if self
                .tool_registry
                .requires_approval(&tool_call.name, plan_mode)
                && !(approval.auto_accept_edits
                    && self
                        .tool_registry
                        .is_builtin_workspace_edit(&tool_call.name))
            {
                let request_id = approval_request_id(&tool_call.id);
                if emit_events {
                    self.event_bus.emit(&AxleEvent::ToolApprovalRequested {
                        request_id: request_id.clone(),
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                        arguments: tool_call.arguments.clone(),
                        timeout_seconds: approval.timeout.as_secs(),
                    });
                }
                let verdict =
                    wait_for_approval(&approval.file, &request_id, approval.timeout).await;
                match verdict {
                    ApprovalVerdict::Allow => {
                        if emit_events {
                            self.event_bus.emit(&AxleEvent::ToolApprovalResolved {
                                request_id,
                                tool_call_id: tool_call.id.clone(),
                                tool_name: tool_call.name.clone(),
                                decision: "allow".to_string(),
                                reason: "user".to_string(),
                            });
                        }
                    }
                    ApprovalVerdict::Deny { reason } => {
                        if emit_events {
                            self.event_bus.emit(&AxleEvent::ToolApprovalResolved {
                                request_id,
                                tool_call_id: tool_call.id.clone(),
                                tool_name: tool_call.name.clone(),
                                decision: "deny".to_string(),
                                reason: reason.clone(),
                            });
                        }
                        let result = ToolExecutionResult::error(approval_denied_message(
                            &tool_call.name,
                            &reason,
                            approval.timeout,
                        ));
                        if emit_events {
                            self.event_bus.emit(&AxleEvent::ToolExecutionEnd {
                                tool_call_id: tool_call.id.clone(),
                                tool_name: tool_call.name.clone(),
                                output: result.output.clone(),
                                is_error: result.is_error,
                                duration_ms: result.duration_ms,
                                timed_out: result.timed_out,
                            });
                        }
                        return result;
                    }
                }
            }
        }
        let result = self
            .tool_registry
            .execute_for_mode(
                &tool_call.name,
                tool_call.arguments.clone(),
                &self.options.cwd,
                plan_mode,
            )
            .await;

        if emit_events {
            if let Some(job_id) = result.background_job_id.as_ref() {
                self.pending_background_tools.lock().await.insert(
                    job_id.clone(),
                    PendingBackgroundTool {
                        tool_call_id: tool_call.id.clone(),
                        tool_name: tool_call.name.clone(),
                    },
                );
                self.event_bus.emit(&AxleEvent::ToolExecutionBackground {
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.name.clone(),
                    job_id: job_id.clone(),
                });
            } else {
                self.event_bus.emit(&AxleEvent::ToolExecutionEnd {
                    tool_call_id: tool_call.id.clone(),
                    tool_name: tool_call.name.clone(),
                    output: result.output.clone(),
                    is_error: result.is_error,
                    duration_ms: result.duration_ms,
                    timed_out: result.timed_out,
                });
            }

            if let Some(job_id) = result.completed_background_job_id.as_ref() {
                if let Some(pending) = self.pending_background_tools.lock().await.remove(job_id) {
                    self.event_bus.emit(&AxleEvent::ToolExecutionEnd {
                        tool_call_id: pending.tool_call_id,
                        tool_name: pending.tool_name,
                        output: result.output.clone(),
                        is_error: result.is_error,
                        duration_ms: result.duration_ms,
                        timed_out: result.timed_out,
                    });
                }
            }
        }

        result
    }

    async fn append_tool_result(
        &self,
        tool_call: &ToolCall,
        result: axle_tools::ToolExecutionResult,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        session
            .append_message(Message::tool_result(
                tool_call.id.clone(),
                result.output,
                result.is_error,
            ))
            .await?;
        Ok(())
    }

    async fn record_tool_call_error(
        &self,
        tool_call: &ToolCall,
        error: String,
        session: &mut SessionManager,
    ) -> anyhow::Result<()> {
        self.event_bus.emit(&AxleEvent::ToolExecutionStart {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: tool_call.arguments.clone(),
        });
        self.event_bus.emit(&AxleEvent::ToolExecutionEnd {
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            output: error.clone(),
            is_error: true,
            duration_ms: 0,
            timed_out: false,
        });
        session
            .append_message(Message::tool_result(tool_call.id.clone(), error, true))
            .await?;
        Ok(())
    }
}
