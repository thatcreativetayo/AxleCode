use crate::types::{AssistantMessageEvent, Message, ThinkingLevel, ToolParamSchema};
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

pub use axle_config::ModelCapabilities;

pub type EventStream = Pin<Box<dyn Stream<Item = AssistantMessageEvent> + Send>>;

#[derive(Debug, Clone)]
pub struct CompletionOptions {
    pub model: String,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    pub reasoning_effort: Option<String>,
    pub thinking_level: ThinkingLevel,
    pub tools: Vec<ToolParamSchema>,
}

impl Default for CompletionOptions {
    fn default() -> Self {
        Self {
            model: "default".to_string(),
            temperature: Some(0.7),
            max_tokens: Some(axle_config::DEFAULT_MAX_OUTPUT_TOKENS),
            reasoning_effort: None,
            thinking_level: ThinkingLevel::Off,
            tools: Vec::new(),
        }
    }
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn provider_name(&self) -> &str;

    /// Capabilities for `model` as served by this provider. Defaults to the
    /// shared model catalogue; adapters override when their wire protocol
    /// diverges (for example the OpenAI Responses API has no sampling
    /// parameters at all).
    fn capabilities(&self, model: &str) -> ModelCapabilities {
        axle_config::model_capabilities(model)
    }

    async fn complete(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<Message>;
    async fn stream(
        &self,
        messages: &[Message],
        options: &CompletionOptions,
    ) -> anyhow::Result<EventStream>;
}
