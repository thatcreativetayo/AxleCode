use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolTimeoutPolicy {
    RegistryDefault,
    SelfManaged,
    Fixed(Duration),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolExecutionMode {
    Sequential,
    Parallel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolExecutionResult {
    pub output: String,
    pub is_error: bool,
    /// Wall-clock execution time in milliseconds. The tool registry stamps
    /// this immediately before handing the result back to the agent loop.
    #[serde(default)]
    pub duration_ms: u64,
    /// True when execution stopped because a timeout limit was reached.
    #[serde(default)]
    pub timed_out: bool,
    /// Set when the tool handed work to a background job and the agent should
    /// keep the tool call open until a monitor collects it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_job_id: Option<String>,
    /// Set by a monitor when it collected a previously backgrounded job. The
    /// agent uses this to close the original tool call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_background_job_id: Option<String>,
}

impl ToolExecutionResult {
    pub fn success(output: impl Into<String>) -> Self {
        Self {
            output: output.into(),
            is_error: false,
            duration_ms: 0,
            timed_out: false,
            background_job_id: None,
            completed_background_job_id: None,
        }
    }

    pub fn error(error: impl Into<String>) -> Self {
        Self {
            output: error.into(),
            is_error: true,
            duration_ms: 0,
            timed_out: false,
            background_job_id: None,
            completed_background_job_id: None,
        }
    }

    /// An error result caused by a timeout limit. Self-managed tools (such as
    /// bash) use this so callers can distinguish a timeout from a plain
    /// failure.
    pub fn timeout(error: impl Into<String>) -> Self {
        Self {
            output: error.into(),
            is_error: true,
            duration_ms: 0,
            timed_out: true,
            background_job_id: None,
            completed_background_job_id: None,
        }
    }

    pub fn background_started(mut self, job_id: impl Into<String>) -> Self {
        self.background_job_id = Some(job_id.into());
        self
    }

    pub fn background_completed(mut self, job_id: impl Into<String>) -> Self {
        self.completed_background_job_id = Some(job_id.into());
        self
    }

    /// Stamps the measured wall-clock duration. The registry calls this once
    /// the tool returns (or the timeout fires).
    pub fn with_duration(mut self, duration: Duration) -> Self {
        self.duration_ms = duration.as_millis().min(u128::from(u64::MAX)) as u64;
        self
    }
}

pub(crate) fn truncate_output(mut output: String, limit: usize) -> String {
    if output.len() <= limit {
        return output;
    }

    let mut boundary = limit.min(output.len());
    while boundary > 0 && !output.is_char_boundary(boundary) {
        boundary -= 1;
    }
    output.truncate(boundary);
    output.push_str(&format!("...\n[Output truncated at {} bytes]", limit));
    output
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    fn parameters(&self) -> serde_json::Value;
    fn execution_mode(&self) -> ToolExecutionMode {
        ToolExecutionMode::Sequential
    }
    fn timeout_policy(&self) -> ToolTimeoutPolicy {
        ToolTimeoutPolicy::RegistryDefault
    }
    /// Whether this tool can take consequential or destructive actions that
    /// require explicit user approval before it is executed. Read-only tools
    /// keep the default; side-effecting tools (commands, file writes,
    /// external services) override this.
    fn requires_approval(&self) -> bool {
        false
    }

    async fn execute(
        &self,
        args: serde_json::Value,
        cwd: &str,
    ) -> anyhow::Result<ToolExecutionResult>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_respects_configured_limit_and_utf8_boundaries() {
        let output = truncate_output("éééé".to_string(), 5);
        assert!(output.starts_with("éé"));
        assert!(output.contains("truncated at 5 bytes"));
    }

    #[test]
    fn timeout_results_are_flagged_and_duration_is_stamped() {
        let timed_out =
            ToolExecutionResult::timeout("timed out").with_duration(Duration::from_millis(1500));
        assert!(timed_out.is_error);
        assert!(timed_out.timed_out);
        assert_eq!(timed_out.duration_ms, 1500);

        let ok = ToolExecutionResult::success("ok");
        assert!(!ok.is_error);
        assert!(!ok.timed_out);
        assert_eq!(ok.duration_ms, 0);
    }
}
