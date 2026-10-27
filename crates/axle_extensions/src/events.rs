use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AxleEvent {
    SessionStart {
        reason: String,
    },
    SessionShutdown {
        reason: String,
    },
    BeforeAgentStart {
        prompt: String,
        system_prompt: String,
    },
    AgentStart,
    AgentEnd,
    TurnStart {
        turn_index: usize,
    },
    TurnEnd {
        turn_index: usize,
    },
    UsageUpdate {
        prompt_tokens: u32,
        completion_tokens: u32,
        total_tokens: u32,
        cumulative_total_tokens: u64,
    },
    ToolExecutionStart {
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
    },
    ToolExecutionBackground {
        tool_call_id: String,
        tool_name: String,
        job_id: String,
    },
    ToolExecutionEnd {
        tool_call_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
        /// Wall-clock execution time in milliseconds. Zero when the tool
        /// never ran (for example an approval denial).
        #[serde(default)]
        duration_ms: u64,
        /// True when the tool stopped because it hit a timeout limit.
        #[serde(default)]
        timed_out: bool,
    },
    ToolApprovalRequested {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
        arguments: serde_json::Value,
        timeout_seconds: u64,
    },
    ToolApprovalResolved {
        request_id: String,
        tool_call_id: String,
        tool_name: String,
        decision: String,
        reason: String,
    },
    ModelSelect {
        model: String,
        provider: String,
    },
    UserBash {
        command: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_execution_end_defaults_duration_and_timeout_for_older_frames() {
        let legacy = r#"{"type":"tool_execution_end","tool_call_id":"c1","tool_name":"bash","output":"done","is_error":false}"#;
        let event: AxleEvent = serde_json::from_str(legacy).expect("legacy frame parses");
        match event {
            AxleEvent::ToolExecutionEnd {
                duration_ms,
                timed_out,
                ..
            } => {
                assert_eq!(duration_ms, 0);
                assert!(!timed_out);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn tool_execution_end_round_trips_duration_and_timeout() {
        let event = AxleEvent::ToolExecutionEnd {
            tool_call_id: "c1".to_string(),
            tool_name: "bash".to_string(),
            output: "done".to_string(),
            is_error: false,
            duration_ms: 1234,
            timed_out: true,
        };
        let json = serde_json::to_string(&event).unwrap();
        let parsed: AxleEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            AxleEvent::ToolExecutionEnd {
                duration_ms,
                timed_out,
                ..
            } => {
                assert_eq!(duration_ms, 1234);
                assert!(timed_out);
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
