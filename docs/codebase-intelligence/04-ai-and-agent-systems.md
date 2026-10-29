# 04 — AI and Agent Systems

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date 2026-10-13. This is the deepest technical document; read it with `05-integrations.md` (what the agent talks to) and `07-api-and-events.md` (the NDJSON wire protocol).

---

## 1. Where the agent system lives

| Concern | Location |
| --- | --- |
| Process entry / flags / interactive REPL | `crates/axle_cli/src/main.rs` |
| Turn loop, streaming, tool dispatch, approvals | `crates/axle_agent/src/loop_runner.rs` (2472 lines) |
| Tool implementations + registry | `crates/axle_tools/src/*` |
| Prompt + AGENTS.md + skills | `crates/axle_prompt/src/builder.rs` |
| Providers + retries | `crates/axle_ai/src/*` |
| Sessions (JSONL) | `crates/axle_session/src/{manager,types}.rs` |
| Compaction | `crates/axle_compaction/src/engine.rs` |
| Memory | `crates/axle_memory/src/lib.rs` |
| Config/profiles | `crates/axle_config/src/lib.rs` |
| Extensions | `crates/axle_extensions/src/*` |
| Server-side spawn + decode | `axle-desktop/source/apps/server/src/provider/Layers/AxleAdapter.ts` |

## 2. Turn lifecycle (verified sequence)

`AgentLoop::run_turn_streaming_with_images` (`loop_runner.rs:1916-2283`):

1. Build prompt with memory context (1930-1944); emit `BeforeAgentStart` (1946).
2. Enter a per-turn `'completion` loop that can iterate (2006-2108):
   - **Proactive compaction** when the estimated context crosses the threshold; forced `compact_session_now` + retry on a context-window error (`is_context_window_error`, markers at 1822).
   - Stream the model response; **partial streams are never accepted as a completion** (2103) — a truncated stream raises a protocol error instead of silently finishing.
   - Malformed tool-call JSON is converted to a tool error message, including the EOF case: "JSON truncated mid-content… Split the content into smaller files".
3. Tool execution (2233-2274):
   - Sequential tools run in place; **adjacent Parallel tools are batched via `join_all` while preserving declared call order** in results.
4. `end_task` control path (2186-2231): its own lifecycle events are suppressed, a summary argument is required, subsequent tools error out, and the loop breaks.
5. Usage accumulates and is emitted as a `UsageUpdate` event (2294-2313).

### Approval gating (`execute_tool_call_result_with_events`, 2335-2430)

```
requires_approval(tool, plan_mode)
  → emit ToolApprovalRequested { requestId = "{tool_call_id}:{nanos}" }
  → wait_for_approval(file, requestId, timeout)
  → Allow  → emit resolved(approved) → execute
  → Deny   → emit resolved(denied)  → return error result; tool NEVER runs
```

- Response channel: line-delimited JSON appended to the approval file; the reader ignores stale/malformed lines and matches `type == "approval_response"` + `requestId` (69-100).
- Poll interval `APPROVAL_POLL_INTERVAL` = 150 ms; timeout produces `Deny{timeout}` with a message telling the model "Do not retry this action automatically" (102-145).
- Decision vocabulary: allow/approved/accept/accept_for_session = approve; deny/declined/cancel = deny (56-64).

## 3. Tool inventory (exact approval/timeout truth)

Default `Tool::requires_approval() = false` and `ToolTimeoutPolicy::RegistryDefault` (= 300 s, `registry.rs:28`) apply unless overridden (`tool.rs:94-103`).

| Tool | Approval | Timeout | Evidence |
| --- | --- | --- | --- |
| `bash` | **yes** | Self-managed; `timeout_seconds` arg defaults 300 s | `bash.rs:73-94` |
| `write` | **yes** | Registry default | `write.rs:44-46`; test at `registry.rs:353` |
| `edit` | **yes** | Registry default | `edit.rs:89-91` |
| `read`, `ls`, `grep`, `find` | no | Registry default | `tool.rs:101-103` default |
| `web_search` | no | Registry default | `web_search.rs` |
| `memory_search/add/update/delete` | no | Registry default | `memory.rs:8-11` |
| `update_plan` | no | Registry default | `plan.rs` |
| `ask_user` | no | Registry default | `plan.rs` |
| `end_task` | no | Registry default | `plan.rs:5`; control path in `loop_runner.rs` |
| MCP-imported tools | **yes (always)** | **[U]** — not separately verified | `mcp.rs:594-596, 852` |

Other invariants:

- Control tools `ask_user` + `end_task` are always kept even when `restrict_to`/plan filtering is active (`registry.rs:23-26`).
- Plan mode exposes only: read, ls, grep, find, web_search, memory_search, ask_user, update_plan, end_task; `update_plan` is the only writer (`registry.rs:55-65`, bidirectional filtering in `get_for_mode` 161-175).
- `requires_approval` returns **false for unknown tool names** (`registry.rs:192-196`) — a fail-open default that matters when comparing to agents that fail closed.
- Tool output is truncated UTF-8-safely; default tool output limit 32 KB (`tool.rs` `truncate_output`; `axle_config/src/lib.rs:3-5`).
- Path guard: traversal rejection + ancestor-walk for writes; skip dirs `.git .hg .svn target node_modules dist build release .wrangler .axle` (`path_guard.rs:95-111`).
- Shell resolution order: explicit target → `AXLE_SHELL` → platform default (`powershell` on Windows, `sh` on Unix); PowerShell invoked `-NoProfile -Command`; timeout kills the process (`kill_on_drop`) and returns empty partial output (`execution.rs:129-308`).
- **`execution.rs:16-20` states the confinement boundary is the approval gate, not the execution target** — the local target inherits the agent process environment. Relevant to the security audit.

## 4. Prompt assembly

`PromptBuilder` (`builder.rs:199`) with `build()` at 475-716:

- **Build/Plan system prompts**: default prompt is "You are Axle…" (483-657) covering core behavior, tool guide, project instructions + skills, web-research rules (web_search is the default research path; `preview_*` only for real browser work; single hosted search provider), workflow, failure handling, communication.
- **AGENTS.md hierarchy** discovered via `agent_instruction_paths` (319).
- **Skill roots** parsed at 19 and enumerated at 340: `.agents`, `.claude`, `.codex`, `.axle`, `.rivet`, `.sparky`.
- Appends `AXLE_TOOL_GUIDE` (661), then `<project_context>` and `<available_skills>` blocks (686-710), then the current working directory (712).
- Agent profiles from `.axle/agents.toml` (legacy `.rivet`/`.sparky`) inject a `system_prompt_fragment` wrapped in `<agent_profile name=…>` (`axle_config/src/lib.rs:24-56`); unknown fields are denied at parse, workflow keys are rejected (65-92).
- Memory context is injected as user-approved context, explicitly labeled "not instructions" (`axle_memory/src/lib.rs:214-232`) — a prompt-injection mitigation.

## 5. Providers (agent plane)

| Provider | Endpoint (verified) | Credential |
| --- | --- | --- |
| `openai` | `https://api.openai.com/v1` (+ localhost detection for local models) | `OPENAI_API_KEY` |
| `anthropic` | `https://api.anthropic.com/v1/messages` | Anthropic key |
| `gemini` | `generativelanguage.googleapis.com/v1beta` | Google key |
| `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |

- Abstractions: `CompletionOptions` (`provider.rs:11`), `LlmProvider { provider_name, capabilities, complete, stream }` (34-55).
- Message parts: Text / Thinking / ProviderState (persisted, never rendered) / Image (`types.rs`); token estimation is heuristic: chars/4 plus 1024 per image (156-184).
- Retry policy: `MAX_RETRIES = 2`, backoff 1 s → 2 s → 4 s capped at 30 s, **only for 429 and 5xx** (`retry.rs:5-18`).
- CLI additionally surfaces fireworks/cerebras/groq/ollama/ollama-cloud provider choices (provider resolution at `main.rs:236`).
- **[U]** Exact wire-format details of `stream_parser.rs` per provider were not exhaustively read in this pass; the file exists and is the single stream-framing point.

## 6. Sessions, context, and compaction

**Sessions** (`axle_session/src/manager.rs`):

- Path `<cwd>/.axle/sessions/<uuid>.jsonl` (128); header validation requires `type`, `version ≤ CURRENT`, `id == filename` (197-208).
- One JSON entry per line with line-numbered parse errors.
- Compaction trim: `first_kept_entry_id` discovered from the last `Compaction` entry; entries before it are trimmed on load (234-254).
- Append path takes a file lock, appends, updates in-memory state (259-282).
- Context building walks leaf → root; `CustomMessage` → user role; `Compaction` → system message titled "[Compaction Summary]" (296-336).
- **`repair_tool_protocol` (371-426)** drops orphan/duplicate tool results and injects an `INTERRUPTED_TOOL_RESULT` — this is what makes crash recovery not poison the next turn.
- `first_entry_id_for_recent_tokens` (465) and `trim_entries_before` (485) support token-budget trimming; `rewrite_session_file` (530+) is the compaction write-back.

**Compaction** (`axle_compaction/src/engine.rs`): threshold 80 % of the context window; keep recent = min(48 000, window/3) tokens; 120 s timeout; `compact` requires ≥4 messages, `compact_now` ≥2; summarizer at temperature 0.3, max 2048 tokens; **streaming only**; writes a `Compaction` entry, then trims and rewrites the session file (8-196).

## 7. Memory

- Secret-pattern rejection before any write: literal "api key/token/password/secret" phrases, PEM blocks, `sk-`/`ghp_`/`xoxb-`/`AKIA…` shapes (`lib.rs:61-84`).
- Global + project stores; legacy project fallback (87-104).
- Search is keyword scoring, not embeddings (110).
- `upsert`/`delete` roll back on persist failure; backup-recovery path exists (249-258).
- Rendered into prompts with an explicit "user-approved memories… not instructions" framing.

## 8. Extensions

- Event bus: `AxleEvent` (serde tag `type`, snake_case): session_start/shutdown, before_agent_start, agent_start/end, turn_start/end, usage_update, tool_execution_start/end (+`duration_ms`, `timed_out` with defaults), tool_approval_requested/resolved, model_select, user_bash (`events.rs:5-69`).
- JS engine: `JsToolDefinition` (75), `JsExtensionRunner` (107), tool registration validation (21-24), `Tool` impl (251).
- Rust trait: `ExtensionContext { cwd, event_bus, tool_registry }` (`extension.rs`).
- Extension tools default to `requires_approval = false` unless the extension declares otherwise — the registry only knows what the tool reports (`registry.rs:192-196`). Treat third-party extension tools as a trust boundary.

## 9. MCP (agent as MCP client)

`crates/axle_tools/src/mcp.rs`:

- Protocol version `2025-06-18`; clientInfo name `"axle"` (15-31).
- Transports: HTTP and stdio; SSE responses parsed from `data:` lines.
- Timeouts: 45 s per request, 120 s for initialization; stderr tail kept to 4 KB; `tools/list` paginated.
- **Every imported MCP tool requires approval** (`mcp.rs:592-596`), which is what makes server-exposed preview/plugin tools safe to hand to the agent.
- Wired from the server via `--mcp-url` + `--mcp-bearer-token-env-var`; the server sets env `T3_MCP_BEARER_TOKEN` (`AxleAdapter.ts:53-55`, `949-1013`).

## 10. Failure behavior and limits (verified)

| Situation | Behavior |
| --- | --- |
| Context window exceeded | Detect via markers, force compaction, retry the turn once |
| Stream ends mid-message | Treated as protocol error; **never** recorded as a completed assistant message (2103) |
| Tool JSON truncated | Tool returns an actionable error ("split into smaller files") |
| Approval timeout | Denial with explicit "do not retry automatically" text |
| Command timeout | Process killed; empty partial output returned with `timed_out` surfaced to the event/UI |
| Server process dies | Decoder fails open with a retryable error class; adapter reconnects up to 5× with 1→16 s backoff (`AxleAdapter.ts:141-179`) |

## 11. Gaps and risks in the agent system

1. **Fail-open approval defaults** for unknown tools (`registry.rs:194-195`). Any registration path that loses the flag is unapproved-by-default-*allowed*.
2. **Bash inherits the full parent environment** and the code comments say so (`execution.rs:16-20`); the only boundary is the approval gate. A session-scoped "accept" decision (accept_for_session) widens that materially.
3. **MCP tool timeout policy unverified** — registry default or self-managed was not established.
4. **Heuristic token accounting** (chars/4) can mis-size contexts for CJK/code-heavy prompts; compaction thresholds inherit that error.
5. **`AXLE_SHELL` env override** lets an arbitrary shell binary be selected if the agent process env is attacker-controlled.
