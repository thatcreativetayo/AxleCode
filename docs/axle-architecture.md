# Axle architecture

Axle is a local-first AI engineering platform: a desktop application drives a
Rust agent runtime called `axle`, which owns the agent loop, model providers,
tools, approvals and durable sessions. Everything runs on the user's machine;
the only network traffic is the provider API calls the user's own keys
authenticate.

This document describes the shipped architecture, not an aspiration. Every path
below exists in the repository.

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| Web UI | `axle-desktop/source/apps/web` | Chat timeline, diffs, approval prompts, model/tool settings |
| Desktop host (Electron) | `axle-desktop/source/apps/desktop` | Window and process lifecycle, provider metadata, environment forwarding (incl. WSL) |
| Local server | `axle-desktop/source/apps/server` | Thread orchestration, approval routing, checkpoints, SQLite projections, MCP server and toolkits |
| Runtime boundary | `axle-desktop/source/apps/server/src/provider/Layers/AxleAdapter.ts` | Spawns the `axle` binary, decodes its NDJSON stream, owns the per-thread approval file |
| Agent runtime | `crates/` | Providers, tool execution, agent loop, sessions, memory, compaction, prompt assembly |

The desktop does not reimplement agent behavior in TypeScript. It starts one
`axle` process per turn with `--json-stream` and renders the frames it emits;
`AxleAdapter.ts` is the only place that knows the wire format.

## Runtime crates

| Crate | Owns |
| --- | --- |
| `axle_ai` | `LlmProvider` contract, provider adapters (OpenAI, Anthropic, Gemini, OpenRouter), SSE parsing, provider capability metadata |
| `axle_tools` | `Tool` contract, `ToolRegistry` (timeouts, plan mode, execution modes), built-in tools, `ExecutionTarget`, MCP client (HTTP + stdio) |
| `axle_agent` | The multi-step agent loop, parallel tool batches, approval gating, cancellation, compaction trigger, `end_task` |
| `axle_session` | Durable session JSONL (`<cwd>/.axle/sessions/<id>.jsonl`), resume, transcript repair |
| `axle_memory` | Axle Memory store (project + global) |
| `axle_compaction` | Context compaction summaries |
| `axle_prompt` | Built-in system prompt and workspace context |
| `axle_extensions` | Runtime event types (`AxleEvent`), JS/TS extension loading |
| `axle_config` | Model capabilities, tool output limits, `.axle/agents.toml` agent profiles |
| `axle_cli` | The `axle` binary: flag parsing, provider factory, NDJSON/human output, approval file polling |

## The boundary contract (NDJSON)

With `--json-stream`, every line on stdout is one JSON frame:

| Frame | Meaning |
| --- | --- |
| `{"type":"session","sessionId":...}` | Published before the first provider call, so a crashed process still has a resumable id |
| `{"type":"delta","delta":...}` | Assistant text token stream |
| `{"type":"thinking_delta","delta":...}` | Reasoning token stream (models that expose it) |
| `{"type":"tool.started","toolCallId","toolName","arguments"}` | A tool call is about to execute |
| `{"type":"tool.completed","toolCallId","toolName","output","isError","durationMs","timedOut"}` | Real result of the call, with measured duration; `durationMs` excludes approval wait time |
| `{"type":"usage","promptTokens","completionTokens","totalTokens","cumulativeTotalTokens"}` | Token accounting when the provider reports it |
| `{"type":"approval.requested","requestId","toolCallId","toolName","arguments","timeoutSeconds"}` | A gated tool is waiting for a human decision |
| `{"type":"approval.resolved","requestId","decision","reason"}` | The decision that unblocked (or denied) the call |
| `{"type":"result","response","sessionId"}` | Final response for this turn |
| `{"type":"shutdown","message","sessionId"}` | Only on interrupt (Ctrl+C); the turn was cancelled and the session saved |

Human mode prints the same information as readable text. `--json` prints a
single result object instead.

## Agent loop

`crates/axle_agent/src/loop_runner.rs` runs one turn as:

1. Build context from the session transcript (repairing interrupted tool calls,
   see below) and call the provider.
2. Stream assistant text and tool calls. Text is emitted live.
3. Execute tool calls. Independent calls run as a parallel batch; calls that
   must serialize (or that return control to the user) run alone. Each call is
   wrapped in its timeout policy and emits `tool.started` / `tool.completed`.
4. Append the assistant message and every tool result to the session, then
   repeat until the model answers without tool calls, calls `end_task`, or is
   cancelled.

Plan mode (`--interaction-mode plan`) swaps the registry for a read-only tool
set (`read`, `ls`, `grep`, `find`, `web_search`, `memory_search`, `ask_user`,
`update_plan`, `end_task`), so mutating tools are not merely gated - they are
absent.

## Approval gate

Gated tools (`bash`, `write`, `edit`, every MCP tool) pause before executing.
The channel is a per-thread JSONL file - no new network surface, no new auth.

1. The runtime emits `approval.requested` with a unique request id
   (`<toolCallId>:<unixNanos>`) and polls the approval file every 150 ms.
2. A responder (the desktop adapter, or any embedder) appends one line:
   `{"type":"approval_response","requestId":"<id>","decision":"allow"}`
   (also accepted: `approved`, `accept`, `accept_for_session`; denials:
   `deny`, `denied`, `decline`, `cancel`).
3. Unknown or mismatched request ids stay pending; a timeout denies with
   guidance text the model can act on. The tool result for a denial is an
   error message, never a silent skip.

The desktop prepares `<cwd>/.axle/approvals/<sha256(threadId)>.jsonl`
(gitignored), publishes runtime events from the frames, and `respondToRequest`
appends the decision. Approval wait time is excluded from `durationMs`; the
wait is visible as the gap between the `approval.requested` and
`approval.resolved` frames.

## Sessions and resumability

A session is an append-only JSONL audit log with a header plus typed entries
(`message`, `compaction`, `custom_message`). Every append flushes before the
write returns, so a killed process leaves a prefix-accurate file.

Cancellation is drop-based: the CLI races the turn future against Ctrl+C in a
`tokio::select!`, so the provider stream and inline tool execution are dropped
with the future and nothing keeps writing. On resume, `build_context_messages`
runs `repair_tool_protocol`: an assistant tool call without a persisted result
gets a synthetic interrupted-result message, which keeps the provider's
message protocol valid and tells the model what happened.

## Execution target boundary

`crates/axle_tools/src/execution.rs` defines the `ExecutionTarget` contract
(command, cwd, timeout, env in; exit code, stdout, stderr, timeout out).
`LocalExecutionTarget` is the only implementation and spawns a real shell on
this machine (`--shell` / `AXLE_SHELL` override, platform default otherwise).
No remote or cloud execution target is pretended; a future remote executor
implements the same trait without touching `bash` or the agent loop.

## MCP and integrations

`crates/axle_tools/src/mcp.rs` implements both MCP transports behind one
connection layer: streamable HTTP and local stdio servers (with Windows shim
resolution for `npx`). Tools discovered from a server are registered into the
same `ToolRegistry` and go through the same approval gate. The CLI wires them
with `--mcp-url` (bearer or custom header from an env var), `--mcp-stdio-program`
/ `--mcp-stdio-arg`, and `--github-mcp` (GitHub's hosted remote MCP server with
a real PAT).

On the server side (`apps/server/src/mcp/`), three toolkits are exposed behind
a bearer credential issued by `McpSessionRegistry`: a 32-byte random token
whose SHA-256 hash is all the server stores. Each credential is scoped to one
thread and provider session (plus cwd, auth session, and plugin session token
when present) and expires after 30 minutes idle or 8 hours total; provider
session and thread teardown revoke the matching credentials, logout revokes
the auth session's credentials and clears its plugin token, and a server
restart drops every credential because the registry is process-local. There is
no in-place rotation: each provider launch gets a fresh credential without
revoking in-flight credentials held by an active turn. The agent receives the
raw token via `--mcp-url` + `--mcp-bearer-token-env-var`
(`T3_MCP_BEARER_TOKEN`); unknown or expired tokens are rejected with
`401 invalid_mcp_credential`.

## Extension points

Adding a provider touches a fixed set of registration points: the Rust
provider factory (`crates/axle_cli/src/main.rs`) plus `crates/axle_ai`, the
TS model catalog (`AxleModelCatalog.ts`), the adapter drivers
(`AxleDriver.ts`), desktop env forwarding
(`DesktopBackendConfiguration.ts`), and the web model picker
(`providerIconUtils.ts`, `ModelPickerContent.tsx`, `axleModelCatalog.ts`,
`ModelsSettingsPanel.tsx`).

Adding a tool is one `Tool` implementation registered in
`ToolRegistry::with_output_limits` (or `register_builtin`); MCP tools come in
through the connection layer instead. Agent profiles
(`.axle/agents.toml`) change instructions, provider/model preference and the
allowed tool set without code changes - see
[axle-configuration.md](./axle-configuration.md).

## Tests worth knowing

| Area | Where |
| --- | --- |
| Provider wire formats and sampling rules | `crates/axle_ai/src/*` unit tests |
| Tool registry, timeouts, execution target, MCP | `crates/axle_tools` unit + integration tests |
| Agent loop, approvals, cancellation, resumability | `crates/axle_agent/src/loop_runner.rs` tests |
| Full offline user journey (tool use, session, resume, approval allow/deny) | `crates/axle_cli/tests/journey_e2e.rs` |
| Desktop adapter: frame decoding, approval file, duration passthrough | `axle-desktop/source/apps/server/src/provider/Layers/AxleAdapter.test.ts` |

The journey test starts a local mock OpenAI-compatible SSE server and runs the
real compiled `axle` binary against it: no API keys, no network. It asserts
the NDJSON frames, the on-disk session transcript, the resumed turn, and that
an approved write really lands on disk while a denied write never touches it.

Run it with:

```powershell
cargo test -p axle_cli --test journey_e2e
```
