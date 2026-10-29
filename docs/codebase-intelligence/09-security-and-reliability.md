# 09 — Security and Reliability Audit

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date 2026-10-13. This is a **source-level** audit: no exploits were run, no production systems contacted, no credentials captured.

Severity scale: **High** = exploitable with realistic preconditions / large blast radius; **Medium** = requires specific preconditions or is defense-in-depth; **Low** = hardening/process. Each finding separates **confirmed** (read in source) from **hypothesis** (needs runtime verification).

---

## Findings

### SEC-1 — Fail-open tool-approval defaults — Medium — confirmed
`ToolRegistry::requires_approval` returns `false` for any tool name it does not know (`crates/axle_tools/src/registry.rs:192-196`), and the `Tool` trait default is `false` (`tool.rs:101-103`). Only `bash`, `write`, `edit` (Rust) and all MCP tools opt in (`bash.rs:77`, `write.rs:44`, `edit.rs:89`, `mcp.rs:594`). Extension-provided tools (JS engine `js_engine.rs` registration at 21-24) inherit the default unless they declare otherwise, and plans can restrict tools (`restrict_to`) in ways that additionally change which approvals apply (test at `registry.rs:353-367`).
**Impact:** a tool added by a future contributor or a third-party extension executes without the approval gate; nothing fails loudly.
**Remediation:** invert the default for non-core tools (require approval unless explicitly marked read-only) and add a registry test asserting the full built-in table's flags.

### SEC-2 — Bash inherits the full agent environment; approval is the only boundary — Medium — confirmed
`crates/axle_tools/src/execution.rs:16-20` documents, in the source, that the local execution target inherits the agent process environment and that **the approval gate, not the sandbox, is the confinement boundary**. The agent environment includes provider keys and, when the server spawns it, `T3_MCP_BEARER_TOKEN` (set by `AxleAdapter.ts:53-55`). `AXLE_SHELL` can redirect the shell binary (`execution.rs:229-242`).
**Impact:** an approve-once (or "accept for session" — `loop_runner.rs:56-64`) decision lets a prompt-injected model read every secret the runtime holds and use the MCP bearer token. `env`-dumping commands are indistinguishable from legitimate build steps.
**Remediation:** scrub/filter child-process env for shell tools (e.g. drop provider keys and MCP token, inject only what the tool needs); consider `accept_for_session` scoped to a tool pattern instead of the whole tool.

### SEC-3 — Wildcard CORS for the browser API — Medium — hypothesis
`apps/server/src/httpCors.ts` returns `access-control-allow-origin: *` with allowed headers including `authorization` and `dpop` for the browser API. If any route relies on ambient browser credentials rather than an explicit header set by trusted JS, a wildcard origin is unsafe; if all browser API auth is header-based (no cookies), impact is limited because a hostile origin cannot mint the token.
**Verify:** enumerate which routes consume `browserApiCorsHeaders` and confirm none accept cookie/ambient credentials; then either pin allowed origins or document why wildcard is safe.
**Remediation:** prefer an explicit origin allowlist for non-localhost deployments.

### SEC-4 — Local server exposure modes — Medium — partially confirmed
`apps/server/src/startupAccess.ts` treats an empty host as loopback and distinguishes loopback/wildcard hosts for headless serving; the terminal manager blocks `PORT`, `ELECTRON_RENDERER_PORT`, `ELECTRON_RUN_AS_NODE` from PTY children (`terminal/Manager.ts:84`). Headless "serve" mode can bind beyond loopback.
**Impact:** once bound to a LAN interface, all auth depends on EnvironmentAuth + scopes; there is no evidence of rate limiting or lockout on credential attempts. **[U]** brute-force protections not found.
**Remediation:** document the exposure model, ensure non-loopback binds require an explicit token, and add rate limiting if unauthenticated endpoints exist.

### SEC-5 — Approval-file channel is path-trusting — Low/Medium — confirmed
The adapter writes approval responses to a file path it controls and the Rust runtime polls it (`AxleAdapter.ts:861-869`, `loop_runner.rs:102-145`). Any local process able to write that file can approve an action, and any process able to read it can observe `requestId`s.
**Impact:** local same-user escalation; on multi-user machines with shared temp dirs this is more serious. **[I]** File location/permissions were not read — verify the path is inside the app home with user-only permissions.
**Remediation:** create the file with restrictive permissions and validate ownership before trusting responses.

### SEC-6 — Provider/plugin credential storage formats — Medium — unknown
`userdata/secrets/` is created by the launcher (`launcher.ts:53`) and desktop uses `electron-store`; plugin credentials must live somewhere. **[U]** The exact storage, encryption, and permissions were not verified in this pass.
**Verify:** trace where the auth worker/client stores plugin credentials; confirm OS-level protection (DPAPI/Keychain/libsecret) rather than plaintext JSON.
**Remediation:** if plaintext, move to OS keychain and document migration.

### SEC-7 — Search endpoint is env-overridable — Low — confirmed
`crates/axle_tools/src/web_search.rs` posts queries to the bundled worker (`https://axle.llc/search`) but honors `AXLE_SEARCH_WORKER_URL`. If the agent process environment is attacker-influenced, code search queries can be redirected.
**Remediation:** treat as a dev-only override; strip it in packaged builds or document it.

### SEC-8 — Prompt-injection surface is broad but partially mitigated — Medium — confirmed design, unquantified
Agent instructions come from many places the model reads back: AGENTS.md hierarchies, skill files, memory (`<axle_memory>` framed as "user-approved memories… not instructions", `axle_memory/src/lib.rs:214-232`), tool outputs, and web-search content. The memory store rejects secret-shaped content (`lib.rs:61-84`) and memory is explicitly not framed as instructions; approval gating is the last line of defence for consequential tools.
**Remediation:** keep approvals on for network/exec tools (they are today), and prefer surfacing "this content came from the web" provenance in tool outputs.

### SEC-9 — Unbounded agent execution budget — Medium — hypothesis
Timeouts exist per tool (300 s default; bash self-managed), per approval, compaction (120 s), MCP requests (45/120 s), adapter idle (10 min), and reconnect (5×1-16 s). **[U]** No repository-level cap was found on *number of turns/steps per user request* or total tokens per turn; the loop continues until the model stops or `end_task` runs.
**Verify:** confirm whether any per-turn step cap exists in `loop_runner.rs` (none was observed in the read window).
**Remediation:** add a configurable max-steps/token budget per turn and surface it in events.

### SEC-10 — MCP/plugin tool calls cross an approval gate but the server side trusts the bearer token — Medium — confirmed (resolved 2026-10-18)
`McpHttpServer` (toolkit registrations at 214/219/291) authenticates with the bearer token the adapter exports; the session registry scopes calls to an invocation context (`McpInvocationContext.ts`). **Verified 2026-10-18 [V]:** `McpSessionRegistry.ts` issues a fresh 32-byte random credential per provider launch and stores only its SHA-256 hash; the credential is bound to one environment/thread/provider-session (plus cwd, auth session, plugin session token, and a `preview` capability set), expires after 30 min idle or 8 h total, and is revoked on provider-session/thread teardown and on logout. The registry is process-local, so a server restart drops all credentials; there is no in-place rotation (each launch gets a new credential without revoking in-flight ones). Unknown/expired tokens are rejected with `401 invalid_mcp_credential`.
**Residual:** the raw token still sits in the spawned agent's environment, so SEC-2 remains the real exposure path; the token's own blast radius is limited to one thread/session until expiry.

### SEC-11 — No rate limiting / abuse controls on local HTTP API — Low — hypothesis
Raw routes (OTLP proxy) are scope-guarded (`http.ts:196-246`) but no rate limit middleware was observed.
**Remediation:** acceptable for loopback; required if headless exposure ships.

## Reliability

### REL-1 — Dead quality gate (process) — High — confirmed
The only workflow running typecheck + `vp check` + desktop build + preload contract grep is `axle-desktop/source/.github/workflows/ci.yml`. GitHub only reads `.github/workflows/` at the repository root, where that file does not exist. Net effect: **regressions in the TS workspace can merge without any automated gate**, which is consistent with the observed 239 typecheck errors and 124 failing server tests. See `10` for the full CI inventory. Remediation: move/duplicate the gate to the root workflows or make the repo root the TS workspace.

### REL-2 — apps/server test breakage — High — confirmed
~124 failing tests, 111 of them from `ScheduledTasks` not being provided in `apps/server/src/server.test.ts` even though `schedules/Service.ts:22` defines the service; plus GitManager fork-PR (2), ProviderRuntimeIngestion (9), VcsStatusBroadcaster Windows symlink EPERM (1), keybindings (1). Until this is fixed, the server suite cannot catch regressions.

### REL-3 — Compaction rewrites the whole session file — Medium — confirmed
`rewrite_session_file` (`axle_session/src/manager.rs:530+`) replaces the JSONL file after compaction. A crash or full disk mid-rewrite can lose the session; the repair path (`repair_tool_protocol`, 371-426) mitigates protocol corruption but not file truncation. **Remediation:** write-temp-then-rename, or append a compaction record and trim lazily.

### REL-4 — Fail-open NDJSON decoding — Medium — confirmed
Malformed/unknown frames are dropped rather than fatal (`AxleAdapter.ts:246-508`, explicitly "fail-open on death"). Silent loss of `thinking_delta` is benign; silent loss of a `tool.completed` frame would desynchronize UI state from reality. **Remediation:** count dropped frames and emit a visible warning after a threshold.

### REL-5 — Provider-process lifecycle coupling — Medium — confirmed
One child process per turn with 10-minute idle timeout; long-running commands exceed the tool timeout (300 s) but the adapter's idle timeout is what kills a hung stream. Interrupted turns are tracked in `cancelledTurnKeys`; **[U]** orphan-process reaping after server crash is not guaranteed (POSIX child re-parenting; Windows job objects not observed).

### REL-6 — Windows symlink test failure — Low — confirmed
`VcsStatusBroadcaster` test fails on Windows symlink EPERM — environmental, but it means the suite is red on the maintainer's own platform.

### REL-7 — Single-row schedules state = throughput bottleneck — Low — confirmed by design
`ScheduledTasks` serializes all claim/advance through one SQLite row (`Service.ts:43,162-172`). Correct for atomicity; fine at current scale; becomes a hot spot with many schedules.

## Positive controls observed

- Path traversal guard with skip-dirs before file tools (`path_guard.rs:95-111`).
- Memory secret-pattern rejection (`axle_memory/src/lib.rs:61-84`).
- `rehype-sanitize` on rendered markdown (`ChatView` pipeline).
- Scoped auth constants for every surface (`packages/contracts/src/auth.ts:76-83`) and scope checks on raw routes (`http.ts:200,208,216,246`).
- Env blocklist for terminal children (`terminal/Manager.ts:84`).
- Approval required for all MCP tools, bash, write, edit — verified individually.
- Token estimation and context guards prevent runaway prompts.
