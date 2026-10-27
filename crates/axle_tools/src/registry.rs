use crate::bash::{BashMonitorTool, BashTool};
use crate::edit::EditTool;
use crate::execution::{ExecutionTarget, LocalExecutionTarget};
use crate::find::FindTool;
use crate::grep::GrepTool;
use crate::ls::LsTool;
use crate::memory::{MemoryTool, SharedMemoryStore, MEMORY_SEARCH_TOOL_NAME};
use crate::plan::{AskUserTool, EndTaskTool, UpdatePlanTool, END_TASK_TOOL_NAME};
use crate::read::ReadTool;
use crate::tool::{Tool, ToolExecutionResult, ToolTimeoutPolicy};
use crate::web_search::WebSearchTool;
use crate::write::WriteTool;
use axle_ai::ToolParamSchema;
use axle_config::ToolOutputLimits;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub fn is_hidden_control_tool(name: &str) -> bool {
    name == END_TASK_TOOL_NAME
}

/// Tools that keep returning control to the user stay available even when an
/// agent profile restricts the tool set; without them a restricted agent
/// could not stop or ask a question.
const CONTROL_TOOL_NAMES: [&str; 2] = ["ask_user", END_TASK_TOOL_NAME];

pub const DEFAULT_TOOL_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone)]
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
    builtin_edit_tools: HashMap<String, Arc<dyn Tool>>,
    plan_tools: HashMap<String, Arc<dyn Tool>>,
    registry_timeout: Option<Duration>,
    execution_target: Arc<dyn ExecutionTarget>,
    bash_output_limit: usize,
    allowed_tools: Option<std::collections::HashSet<String>>,
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self {
            tools: HashMap::new(),
            builtin_edit_tools: HashMap::new(),
            plan_tools: HashMap::new(),
            registry_timeout: Some(DEFAULT_TOOL_TIMEOUT),
            execution_target: Arc::new(LocalExecutionTarget::from_env()),
            bash_output_limit: axle_config::DEFAULT_TOOL_OUTPUT_LIMIT_BYTES,
            allowed_tools: None,
        }
    }
}

impl ToolRegistry {
    const PLAN_ONLY_TOOL_NAMES: [&'static str; 1] = ["update_plan"];
    const PLAN_TOOL_NAMES: [&'static str; 9] = [
        "read",
        "ls",
        "grep",
        "find",
        "web_search",
        MEMORY_SEARCH_TOOL_NAME,
        "ask_user",
        "update_plan",
        END_TASK_TOOL_NAME,
    ];

    pub fn new() -> Self {
        Self::with_output_limits(ToolOutputLimits::default())
    }

    pub fn with_memory_store(limits: ToolOutputLimits, store: SharedMemoryStore) -> Self {
        let mut reg = Self::with_output_limits(limits);
        reg.register_builtin(Arc::new(MemoryTool::search(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::add(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::update(store.clone())));
        reg.register_builtin(Arc::new(MemoryTool::delete(store)));
        reg
    }

    pub fn with_project_free(_limits: ToolOutputLimits) -> Self {
        let mut reg = Self::default();
        reg.register_builtin(Arc::new(WebSearchTool));
        reg.register_builtin(Arc::new(AskUserTool));
        reg.register_builtin(Arc::new(UpdatePlanTool));
        reg.register_builtin(Arc::new(EndTaskTool));
        reg
    }

    pub fn with_output_limits(limits: ToolOutputLimits) -> Self {
        let mut reg = Self::default();
        reg.bash_output_limit = limits.bash_bytes;
        reg.register_builtin(Arc::new(ReadTool::new(limits.read_bytes)));
        reg.register_builtin(Arc::new(WriteTool));
        reg.register_builtin(Arc::new(EditTool));
        let bash = BashTool::with_target(limits.bash_bytes, reg.execution_target.clone());
        reg.register_builtin(Arc::new(BashMonitorTool::new(bash.monitor())));
        reg.register_builtin(Arc::new(bash));
        reg.register_builtin(Arc::new(LsTool));
        reg.register_builtin(Arc::new(GrepTool));
        reg.register_builtin(Arc::new(WebSearchTool));
        reg.register_builtin(Arc::new(FindTool));
        reg.register_builtin(Arc::new(AskUserTool));
        reg.register_builtin(Arc::new(UpdatePlanTool));
        reg.register_builtin(Arc::new(EndTaskTool));
        reg
    }

    /// Swap the execution target the `bash` tool runs through (section 8
    /// boundary). Registries without a `bash` tool (project-free chats) store
    /// the target but have nothing to rebuild.
    pub fn set_execution_target(&mut self, target: Arc<dyn ExecutionTarget>) {
        self.execution_target = target.clone();
        if self.tools.contains_key("bash") {
            let bash = BashTool::with_target(self.bash_output_limit, target);
            self.tools.insert(
                "bash_monitor".to_string(),
                Arc::new(BashMonitorTool::new(bash.monitor())),
            );
            self.tools.insert("bash".to_string(), Arc::new(bash));
        }
    }

    /// The execution target workspace tools currently run through.
    pub fn execution_target(&self) -> Arc<dyn ExecutionTarget> {
        self.execution_target.clone()
    }

    pub fn register(&mut self, tool: Arc<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    fn register_builtin(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.name().to_string();
        if matches!(name.as_str(), "write" | "edit") {
            self.builtin_edit_tools.insert(name.clone(), tool.clone());
        }
        self.tools.insert(name.clone(), tool.clone());
        if Self::PLAN_TOOL_NAMES.contains(&name.as_str()) {
            self.plan_tools.insert(name, tool);
        }
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    /// An MCP tool may reuse a built-in name. Only the original workspace
    /// edit implementation is eligible for automatic edit approval.
    pub fn is_builtin_workspace_edit(&self, name: &str) -> bool {
        self.builtin_edit_tools
            .get(name)
            .zip(self.tools.get(name))
            .map(|(builtin, registered)| Arc::ptr_eq(builtin, registered))
            .unwrap_or(false)
    }

    /// Restrict every later schema/execution/approval lookup to this tool set
    /// (an agent profile's `allowed_tools`). An empty list keeps every tool.
    /// User-facing control tools stay available regardless.
    pub fn restrict_to(&mut self, tool_names: &[String]) {
        self.allowed_tools = if tool_names.is_empty() {
            None
        } else {
            Some(tool_names.iter().cloned().collect())
        };
    }

    fn is_allowed(&self, name: &str) -> bool {
        match &self.allowed_tools {
            Some(allowed) => CONTROL_TOOL_NAMES.contains(&name) || allowed.contains(name),
            None => true,
        }
    }

    pub fn get_for_mode(&self, name: &str, plan_mode: bool) -> Option<Arc<dyn Tool>> {
        if !self.is_allowed(name) {
            return None;
        }
        if plan_mode && !Self::PLAN_TOOL_NAMES.contains(&name) {
            return None;
        }
        if !plan_mode && Self::PLAN_ONLY_TOOL_NAMES.contains(&name) {
            return None;
        }
        if plan_mode {
            return self.plan_tools.get(name).cloned();
        }
        self.get(name)
    }

    pub fn set_registry_timeout(&mut self, timeout: Option<Duration>) {
        self.registry_timeout = timeout;
    }

    pub fn timeout_for(&self, tool: &dyn Tool) -> Option<Duration> {
        match tool.timeout_policy() {
            ToolTimeoutPolicy::SelfManaged => None,
            ToolTimeoutPolicy::Fixed(limit) => Some(limit),
            ToolTimeoutPolicy::RegistryDefault => self.registry_timeout,
        }
    }

    /// Whether the named tool must pass a user approval gate before it runs.
    /// Unknown or plan-mode-filtered tools return false; they cannot execute
    /// through this registry anyway.
    pub fn requires_approval(&self, name: &str, plan_mode: bool) -> bool {
        self.get_for_mode(name, plan_mode)
            .map(|tool| tool.requires_approval())
            .unwrap_or(false)
    }

    pub async fn execute_for_mode(
        &self,
        name: &str,
        args: serde_json::Value,
        cwd: &str,
        plan_mode: bool,
    ) -> ToolExecutionResult {
        let Some(tool) = self.get_for_mode(name, plan_mode) else {
            return ToolExecutionResult::error(format!("Unknown tool: {name}"));
        };
        let started = Instant::now();
        let result = match self.timeout_for(tool.as_ref()) {
            Some(limit) => match tokio::time::timeout(limit, tool.execute(args, cwd)).await {
                Ok(Ok(result)) => result,
                Ok(Err(error)) => {
                    ToolExecutionResult::error(format!("Tool execution error: {error}"))
                }
                Err(_) => {
                    ToolExecutionResult::timeout(format!("Tool '{name}' timed out after {limit:?}"))
                }
            },
            None => match tool.execute(args, cwd).await {
                Ok(result) => result,
                Err(error) => ToolExecutionResult::error(format!("Tool execution error: {error}")),
            },
        };
        result.with_duration(started.elapsed())
    }

    pub fn get_schemas(&self) -> Vec<ToolParamSchema> {
        self.schemas_for_names(self.allowed_names(false), &self.tools)
    }

    pub fn get_schemas_for_mode(&self, plan_mode: bool) -> Vec<ToolParamSchema> {
        let tools = if plan_mode {
            &self.plan_tools
        } else {
            &self.tools
        };
        self.schemas_for_names(self.allowed_names(plan_mode), tools)
    }

    /// Names visible to the model for a mode, after both the mode filter and
    /// any agent tool restriction.
    fn allowed_names(&self, plan_mode: bool) -> Vec<String> {
        if plan_mode {
            return Self::PLAN_TOOL_NAMES
                .iter()
                .filter(|name| self.is_allowed(name))
                .map(|name| name.to_string())
                .collect();
        }
        let plan_names = Self::PLAN_TOOL_NAMES.map(|name| name.to_string());
        plan_names
            .iter()
            .filter(|name| !Self::PLAN_ONLY_TOOL_NAMES.contains(&name.as_str()))
            .filter(|name| self.tools.contains_key(*name))
            .filter(|name| self.is_allowed(name))
            .cloned()
            .chain(
                self.tools
                    .keys()
                    .filter(|name| !Self::PLAN_TOOL_NAMES.contains(&name.as_str()))
                    .filter(|name| self.is_allowed(name))
                    .cloned(),
            )
            .collect()
    }

    fn schemas_for_names<I>(
        &self,
        names: I,
        tools: &HashMap<String, Arc<dyn Tool>>,
    ) -> Vec<ToolParamSchema>
    where
        I: IntoIterator<Item = String>,
    {
        names
            .into_iter()
            .filter_map(|name| tools.get(&name))
            .map(|t| ToolParamSchema {
                name: t.name().to_string(),
                description: t.description().to_string(),
                parameters: t.parameters(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_free_registry_excludes_workspace_tools() {
        let registry = ToolRegistry::with_project_free(ToolOutputLimits::default());

        for name in ["read", "write", "edit", "bash", "ls", "grep", "find"] {
            assert!(
                registry.get(name).is_none(),
                "unexpected project tool: {name}"
            );
        }
        for name in ["web_search", "ask_user", "update_plan", END_TASK_TOOL_NAME] {
            assert!(
                registry.get(name).is_some(),
                "missing project-free tool: {name}"
            );
        }
    }

    #[test]
    fn plan_mode_exposes_only_read_context_and_planning_tools() {
        let registry = ToolRegistry::new();
        let names = registry
            .get_schemas_for_mode(true)
            .into_iter()
            .map(|schema| schema.name)
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "read",
                "ls",
                "grep",
                "find",
                "web_search",
                "ask_user",
                "update_plan",
                "end_task",
            ]
        );
        assert!(registry.get_for_mode("read", true).is_some());
        assert!(registry.get_for_mode("write", true).is_none());
        assert!(registry.get_for_mode("write", false).is_some());
        assert!(registry.get_for_mode("update_plan", true).is_some());
        assert!(registry.get_for_mode("update_plan", false).is_none());
        assert!(!registry
            .get_schemas_for_mode(false)
            .iter()
            .any(|schema| schema.name == "update_plan"));
    }

    #[test]
    fn build_mode_does_not_expose_plan_only_tools_to_the_model() {
        let registry = ToolRegistry::new();

        assert!(registry.get("update_plan").is_some());
        assert!(registry.get_for_mode("update_plan", false).is_none());
    }

    #[test]
    fn restrict_to_limits_tools_schemas_and_approvals() {
        let mut registry = ToolRegistry::new();
        assert!(registry.requires_approval("write", false));

        registry.restrict_to(&["read".to_string(), "grep".to_string()]);

        // Allowed tools keep working; everything else is invisible and
        // cannot execute or request approval.
        assert!(registry.get_for_mode("read", false).is_some());
        assert!(registry.get_for_mode("grep", false).is_some());
        for name in ["write", "edit", "bash", "ls", "update_plan"] {
            assert!(
                registry.get_for_mode(name, false).is_none(),
                "{name} must be blocked"
            );
        }
        assert!(!registry.requires_approval("write", false));

        let names = registry
            .get_schemas_for_mode(false)
            .into_iter()
            .map(|schema| schema.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"read".to_string()));
        assert!(names.contains(&"grep".to_string()));
        assert!(!names.contains(&"write".to_string()));
        assert!(!names.contains(&"bash".to_string()));
    }

    #[test]
    fn restrict_to_keeps_user_control_tools_available() {
        let mut registry = ToolRegistry::new();
        registry.restrict_to(&["read".to_string()]);

        for name in ["ask_user", END_TASK_TOOL_NAME] {
            assert!(
                registry.get_for_mode(name, false).is_some(),
                "control tool {name} must stay reachable"
            );
        }
        let names = registry
            .get_schemas_for_mode(false)
            .into_iter()
            .map(|schema| schema.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&"ask_user".to_string()));
        assert!(names.contains(&END_TASK_TOOL_NAME.to_string()));
    }

    #[test]
    fn restrict_to_empty_list_keeps_every_tool() {
        let mut registry = ToolRegistry::new();
        registry.restrict_to(&[]);

        assert!(registry.get_for_mode("write", false).is_some());
        assert!(registry.get_for_mode("bash", false).is_some());
        assert!(registry.get_for_mode("ls", false).is_some());
    }

    #[tokio::test]
    async fn memory_search_is_available_in_build_and_plan_modes() {
        let dir = tempfile::tempdir().unwrap();
        let store = std::sync::Arc::new(tokio::sync::Mutex::new(
            axle_memory::MemoryStore::load(dir.path().to_str().unwrap(), None)
                .await
                .unwrap(),
        ));
        let registry = ToolRegistry::with_memory_store(ToolOutputLimits::default(), store);

        assert!(registry
            .get_for_mode(MEMORY_SEARCH_TOOL_NAME, true)
            .is_some());
        assert!(registry
            .get_for_mode(MEMORY_SEARCH_TOOL_NAME, false)
            .is_some());
        assert!(registry.get_for_mode("memory_add", true).is_none());
        assert!(registry.get_for_mode("memory_add", false).is_some());
    }

    struct StubTool {
        name: &'static str,
        delay: Duration,
        policy: ToolTimeoutPolicy,
    }

    #[async_trait::async_trait]
    impl Tool for StubTool {
        fn name(&self) -> &str {
            self.name
        }

        fn label(&self) -> &str {
            self.name
        }

        fn description(&self) -> &str {
            "stub tool"
        }

        fn parameters(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        fn timeout_policy(&self) -> ToolTimeoutPolicy {
            self.policy
        }

        async fn execute(
            &self,
            _args: serde_json::Value,
            _cwd: &str,
        ) -> anyhow::Result<ToolExecutionResult> {
            tokio::time::sleep(self.delay).await;
            Ok(ToolExecutionResult::success("stub done"))
        }
    }

    #[test]
    fn fixed_tool_timeouts_override_the_registry_default() {
        let mut registry = ToolRegistry::new();
        registry.set_registry_timeout(Some(Duration::from_secs(30)));
        let tool = StubTool {
            name: "fixed",
            delay: Duration::ZERO,
            policy: ToolTimeoutPolicy::Fixed(Duration::from_secs(5)),
        };

        assert_eq!(registry.timeout_for(&tool), Some(Duration::from_secs(5)));
    }

    #[tokio::test]
    async fn registry_timeout_stops_tools_that_exceed_the_limit() {
        let mut registry = ToolRegistry::new();
        registry.set_registry_timeout(Some(Duration::from_millis(20)));
        registry.register(Arc::new(StubTool {
            name: "slow",
            delay: Duration::from_secs(30),
            policy: ToolTimeoutPolicy::RegistryDefault,
        }));

        let result = registry
            .execute_for_mode("slow", serde_json::json!({}), ".", false)
            .await;

        assert!(result.is_error);
        assert!(result.output.contains("timed out"));
        assert!(result.output.contains("slow"));
        assert!(result.timed_out);
        assert!(result.duration_ms >= 20);
    }

    #[tokio::test]
    async fn self_managed_tools_bypass_the_registry_default() {
        let mut registry = ToolRegistry::new();
        registry.set_registry_timeout(Some(Duration::from_millis(20)));
        registry.register(Arc::new(StubTool {
            name: "self-managed",
            delay: Duration::from_millis(60),
            policy: ToolTimeoutPolicy::SelfManaged,
        }));

        let result = registry
            .execute_for_mode("self-managed", serde_json::json!({}), ".", false)
            .await;

        assert!(!result.is_error);
        assert_eq!(result.output, "stub done");
        assert!(!result.timed_out);
        assert!(result.duration_ms >= 60);
    }

    #[tokio::test]
    async fn unknown_tools_get_a_normalized_error_result() {
        let registry = ToolRegistry::new();

        let result = registry
            .execute_for_mode("not-a-tool", serde_json::json!({}), ".", false)
            .await;

        assert!(result.is_error);
        assert_eq!(result.output, "Unknown tool: not-a-tool");
    }

    #[tokio::test]
    async fn set_execution_target_routes_bash_through_the_target() {
        use crate::execution::test_support::RecordingTarget;
        use crate::execution::ExecutionOutcome;

        let target = RecordingTarget::new(ExecutionOutcome {
            exit_code: Some(0),
            stdout: "routed\n".to_string(),
            stderr: String::new(),
            timed_out: false,
        });
        let mut registry = ToolRegistry::new();
        registry.set_execution_target(target.clone());

        assert_eq!(registry.execution_target().id(), "recording");
        let result = registry
            .execute_for_mode(
                "bash",
                serde_json::json!({ "command": "echo hi" }),
                ".",
                false,
            )
            .await;

        assert!(!result.is_error, "output: {}", result.output);
        assert_eq!(result.output, "routed\n");
        let requests = target.requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].command, "echo hi");
    }

    #[test]
    fn set_execution_target_without_bash_only_stores_the_target() {
        use crate::execution::test_support::RecordingTarget;
        use crate::execution::ExecutionOutcome;

        let mut registry = ToolRegistry::with_project_free(ToolOutputLimits::default());
        registry.set_execution_target(RecordingTarget::new(ExecutionOutcome {
            exit_code: Some(0),
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
        }));

        assert!(registry.get("bash").is_none());
        assert_eq!(registry.execution_target().id(), "recording");
    }
}
