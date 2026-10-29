# 03 — Feature Catalog

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date 2026-10-13. Status vocabulary: IMPLEMENTED / PARTIAL / SCAFFOLDED / BROKEN / PLANNED (see `11-implementation-status-and-technical-debt.md` for the full matrix and test evidence).

Each feature lists: purpose → files → execution trace → status.

---

## F1 — Chat with the agent (a "thread")

**Purpose:** the core product loop; user asks in plain English, the agent reads/edits/runs and streams results.
**Files:** `apps/web/src/components/ChatView.tsx`, `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`, `apps/web/src/routes/_chat.draft.$draftId.tsx`; server orchestration (`apps/server/src/orchestration/*`), adapter `apps/server/src/provider/Layers/AxleAdapter.ts`; runtime `crates/axle_agent/src/loop_runner.rs`.
**Trace:** composer submit → client-runtime RPC → `thread.turn.start` command → orchestration event + receipt → provider adapter spawns `axle --json-stream` (one process per turn) → NDJSON deltas/thinking/tool events → runtime ingestion → projections → WS push → ChatView renders streaming markdown.
**State handling:** streaming deltas, thinking deltas (validated, dropped if invalid), tool cards with duration/timedOut, usage updates, final `result`; fail-open decoder on process death (`AxleAdapter.ts:246-508`).
**Status:** IMPLEMENTED. Failure evidence is environmental (server test suite), not in this path: see `10`.

## F2 — Plan mode and proposed plans

**Purpose:** let the agent investigate and propose without editing; user then implements the plan.
**Files:** Rust `PLAN_TOOL_NAMES` (`crates/axle_tools/src/registry.rs:55-65`), `--interaction-mode plan|build` (`AxleAdapter.ts:949-1013`), migration `013_ProjectionThreadProposedPlans`, `014_...Implementation`, `015_ProjectionTurnsSourceProposedPlan`; web plan UI in ChatView/build toolbar.
**Trace:** user switches mode → adapter flag `--interaction-mode plan` → Rust restricts tool registry (`get_for_mode`, `registry.rs:161-175`) so `update_plan` is the only writer → plan events persist as proposed-plan projection → "implement" transitions create a turn whose source is the proposed plan (migration `015`).
**Status:** IMPLEMENTED (projection + adapter + runtime restriction all present). UI polish is part of the uncommitted redesign WIP.

## F3 — Tool approval workflow

**Purpose:** human-in-the-loop before dangerous actions (shell, writes, MCP tools).
**Files:** `crates/axle_agent/src/loop_runner.rs:42-145,2335-2430`; `crates/axle_tools/src/bash.rs:77`, `mcp.rs:592-596`; `AxleAdapter.ts:647-676,861-869`; migration `009`+`025` pending-approval projection.
**Trace in doc `02` section 3.** Decision vocabulary: allow/approved/accept/accept_for_session = approve; deny/declined/cancel = deny (`loop_runner.rs:56-64`). Timeout → Deny with "Do not retry this action automatically" (`loop_runner.rs:138-145`).
**Status:** IMPLEMENTED.

## F4 — Tools (read/write/edit/bash/search/memory/plan/end_task/MCP)

**Purpose:** the agent's action surface.
**Files:** `crates/axle_tools/src/*`; server MCP toolkits `apps/server/src/mcp/toolkits/{preview,plugins,pullRequestReview}`.
**Inventory:** bash, read, write, edit, find, grep, ls, web_search, memory_search, memory_add, memory_update, memory_delete, update_plan, ask_user, end_task + MCP-imported tools (preview_status/open/navigate/resize/snapshot/click/type/press/scroll/evaluate/wait_for/recording_start/recording_stop, axle_request_plugin_authorization, axle_plugin_call, getPullRequestComments, review_pull_request).
**Status:** IMPLEMENTED. Details and edge cases in `04-ai-and-agent-systems.md`.

## F5 — Sessions, resume, and `/compact`

**Purpose:** durable conversation state per working directory.
**Files:** `crates/axle_session/src/manager.rs`, `types.rs`; `crates/axle_cli/src/main.rs` (`/compact` at ~1110, Ctrl+C save 1133-1157).
**Storage:** `<cwd>/.axle/sessions/<uuid>.jsonl`, header-validated (type/version/id==filename), entry per line, compaction trims on load (`manager.rs:128,197-254`).
**Status:** IMPLEMENTED (Rust side). Server-side session binding is separate: `AxleAdapter.ts:785/828`.

## F6 — Automatic context compaction

**Purpose:** stay under model context windows without losing the thread.
**Files:** `crates/axle_compaction/src/engine.rs`; proactive call in the turn loop (`loop_runner.rs:2006-2108`).
**Behavior:** threshold 80% of window, keep recent min(48k, window/3) tokens, summarizer at temp 0.3/max 2048 tokens, streaming-only, writes a Compaction entry then trims + rewrites the session file (`engine.rs:8-33,98-196`).
**Status:** IMPLEMENTED; context-overflow recovery retries the turn once after forced compaction (`loop_runner.rs`).

## F7 — Memory

**Purpose:** user-approved long-lived facts the agent can recall.
**Files:** `crates/axle_memory/src/lib.rs`; tools `memory_search/add/update/delete`; server `apps/server/src/memoryStore.ts`; UI `apps/web/src/routes/settings.memory.tsx`; contract `packages/contracts/src/memory.ts`.
**Behavior:** secret-pattern rejection on write; global + project stores with legacy fallback; keyword scoring search; injected into prompt inside `<axle_memory>` labeled "user-approved memories… not instructions" (`lib.rs:214-232`); backup recovery.
**Status:** IMPLEMENTED.

## F8 — Model selection and provider credentials

**Purpose:** choose provider/model/effort and store API keys.
**Files:** web `settings.models`, `settings.personalize`; server `codexModelOptions.ts`, provider layers; runtime resolution `crates/axle_cli/src/main.rs:236-267`; catalog/capabilities `crates/axle_config/src/lib.rs:213-264`.
**Status:** IMPLEMENTED. Provider list and auth specifics in `05-integrations.md`.

## F9 — Checkpoints and diffs

**Purpose:** show every change the agent made; allow review.
**Files:** migration `003_CheckpointDiffBlobs`; reactor `apps/server/src/orchestration/reactors/Checkpoint*`; web `DiffPanel.tsx`, `DiffPanelShell.tsx`, `@pierre/diffs`.
**Trace:** turn completes → checkpoint reactor computes diff blob → stored in `checkpoint_diff_blobs` → DiffPanel queries by thread/turn.
**Status:** IMPLEMENTED (server persistence + UI present).

## F10 — Git, branches, worktrees, pull requests

**Purpose:** branch/commit context and PR workflows around the agent.
**Files:** `packages/contracts/src/{git,vcs,sourceControl,review}.ts`; server git services + `VcsStatusBroadcaster`; desktop `githubCli/githubOAuth/githubResilience/githubPullRequestDiff` IPC handlers; web `BranchToolbar*.tsx`, `routes/pull-requests.tsx`; MCP `review_pull_request` tool.
**Known issue:** GitManager fork-PR tests fail (2) — see `11`.
**Status:** IMPLEMENTED, with failing tests.

## F11 — Integrated terminal

**Purpose:** real PTY terminal inside the app.
**Files:** `apps/server/src/terminal/Manager.ts` (service at 117; env blocklist `{PORT, ELECTRON_RENDERER_PORT, ELECTRON_RUN_AS_NODE}` at 84; 5k-line history; 128-session retention); web/desktop use xterm.
**Status:** IMPLEMENTED.

## F12 — Preview browser automation

**Purpose:** let the agent drive a browser (open local app, click, type, screenshot, record).
**Files:** server `mcp/toolkits/preview/*` + `PreviewAutomationBroker.ts`; desktop preview integration `apps/desktop/src/preview/*`; web `browser/BrowserDeviceToolbar.tsx`; instructions constant `AXLE_BROWSER_INSTRUCTIONS` (`AxleAdapter.ts:56`).
**Status:** IMPLEMENTED. Tools are classified safe/readonly/browser (`tools.ts:39-178`).

## F13 — Plugins (agent-callable third-party apps)

**Purpose:** authorize and call external apps (Gmail, Slack, Jira, …) from the agent.
**Files:** web `routes/plugins.tsx`, `settings.plugins.tsx`; server `mcp/toolkits/plugins/{tools,handlers}.ts`; auth worker `/v1/plugins/*` routes and per-provider scope tables; desktop `pluginSync`/`pluginCredentials` IPC.
**Trace:** agent calls `axle_request_plugin_authorization` → server → auth worker authorize URL → browser consent → callback → credentials stored → `axle_plugin_call` executes the provider request.
**Status:** IMPLEMENTED (auth-worker tests green: 21/21).

## F14 — Scheduled tasks

**Purpose:** run a prompt on a schedule (e.g. nightly triage) against a chat/thread.
**Files:** server `apps/server/src/schedules/Service.ts`; contract `packages/contracts/src/schedules.ts`; web `routes/schedules.tsx`.
**Behavior:** single-row SQLite state table for atomic claim+advance; executor validates chat not deleted/archived and not busy (session running/starting, turn running, pending approvals/user input); dispatches `thread.turn.start` with deterministic id `schedule:{run.id}`; run statuses include needs-attention.
**Status:** IMPLEMENTED but **[F]** its tests are the largest failing cluster (`server.test.ts` does not provide `ScheduledTasksLive`).

## F15 — Archive and restore threads

**Purpose:** remove threads from the main list without deleting data.
**Evidence:** migration `017`/`018` (`projection_threads.archived_at` + index), `030` archive indexes; web `settings.archived.tsx`.
**Status:** IMPLEMENTED.

## F16 — Onboarding

**Purpose:** first-run setup (folder, models, first prompt).
**Files:** `apps/web/src/routes/onboarding.tsx`; desktop bootstrap; `AXLE_DIRECTORIES` layout creation in `apps/server/src/launcher.ts:47-58`.
**Status:** IMPLEMENTED.

## F17 — Remote access (SSH, Tailscale, relay, mobile pairing)

**Purpose:** reach a user's machine/environment from another device.
**Files:** `packages/ssh`, `packages/tailscale`; desktop `src/ssh/*`, `src/wsl/*`, `ipc` handlers `sshEnvironment`, `serverExposure`; relay `infra/relay` (DPoP auth, environment links/credentials, managed endpoints, mobile registrations); contracts `relay.ts`, `relayClient.ts`, `remoteAccess.ts`.
**Status:** IMPLEMENTED for relay core (migrations through 2026-07). Locally unverifiable (Cloudflare/Postgres/APNs). Relay tests exist in-repo (`infra/relay/src/**/*.test.ts`) but were not run in this investigation.

## F18 — Mobile companion features

**Purpose:** monitor and steer agent work from a phone.
**Files:** `apps/mobile/src/features/*` (agent-awareness, threads, terminal, diffs, review), native widgets; relay `agentActivity/*` (AgentActivityPublisher, ApnsClient, ApnsDeliveries, LiveActivities, Devices).
**Status:** IMPLEMENTED (needs a device to verify push end-to-end). **[U]** for APNs credentials in this environment.

## F19 — Extensions

**Purpose:** third-party tool extensions, including JS-authored ones.
**Files:** `crates/axle_extensions/src/{events.rs,js_engine.rs,extension.rs}` (JsToolDefinition at 75, JsExtensionRunner at 107, registerTool validation 21-24).
**Status:** IMPLEMENTED as a Rust/JS runtime; **[U]** whether any shipped extension consumes it (no first-party extension catalog found in the read scope).

## F20 — Instructions, skills, and agent profiles

**Purpose:** steer the agent per project/user.
**Files:** `crates/axle_prompt/src/builder.rs` (AGENTS.md hierarchy 319; skill roots `.agents/.claude/.codex/.axle/.rivet/.sparky` 340; prompt build 475-716); `crates/axle_config` profiles (`.axle/agents.toml`, legacy `.rivet`/`.sparky`, `system_prompt_fragment` → `<agent_profile>`); web `settings.instructions.tsx`.
**Status:** IMPLEMENTED.

## F21 — Command palette and keybindings

**Purpose:** keyboard-first control.
**Files:** web `components/CommandPalette.tsx`, `CommandPaletteResults.tsx`; contract `packages/contracts/src/keybindings.ts`; server `src/keybindings.ts`; web `settings.keybindings.tsx`.
**Known issue:** 1 failing keybindings test.
**Status:** IMPLEMENTED with a failing test.

## F22 — Diagnostics and observability

**Purpose:** expose logs/traces for support and debugging.
**Files:** web `settings.diagnostics.tsx`; server `http.ts` OTLP traces proxy (`OTLP_TRACES_PROXY_PATH`, `http.ts:242-297`) guarded by `AuthOrchestrationOperateScope`; `serverLogger.ts`; analytics via Convex `axle-analytics`.
**Status:** IMPLEMENTED.

## F23 — Updates and distribution

**Purpose:** auto-update desktop; distribute installers + npm CLI.
**Files:** `apps/desktop/src/updates/*`, `update-portal/`, `axle-download-worker`; updater contracts are frozen by `axle-desktop/source/AGENTS.md` (`AXLE_UPDATE_URL`, `AXLE_UPDATE_SITE_URL`, `/get/updates/*`, `latest.yml`, productName).
**Status:** IMPLEMENTED; do not touch contracts.

## F24 — Accounts, pairing, and CLI auth

**Purpose:** authenticate the app and connect CLI/desktop sessions.
**Files:** auth worker (`/health`, `/v1/session`, `/v1/mcp`, `/v1/clerk/restore`, plugin routes, `/v1/github/exchange|refresh|revoke`); context `packages/contracts/src/auth.ts`; deskop `accountSession` IPC; server migrations `020/021/022/031/032` (auth access management, session client metadata, last connected, authorization scopes, DPoP-style pairing proof key thumbprint); web `src/account/*`.
**Status:** IMPLEMENTED (worker tests 21/21 green).

---

## Unreachable / dead / placeholder watchlist

- `apps/server/src/server.test.ts` exercises services that exist but is not wired to provide them → tests fail, not the features. See `11`.
- Root `.circleci/` config appears legacy; the active root workflows are `axle-installers-ci`, `axle-windows-artifact`, `build-macos` (verify per file when working on CI).
- The uncommitted `ui-redesign-*.md` files document an in-flight design change; treat as WIP, not shipped behavior.
