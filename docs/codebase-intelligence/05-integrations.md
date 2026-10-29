# 05 — Integrations

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date 2026-10-13. No credential values appear here; environment variable names only.

---

## 1. Integration matrix

| # | Integration | Direction | Owner | Status |
| --- | --- | --- | --- | --- |
| 1 | Model providers (OpenAI, Anthropic, Gemini, OpenRouter) | outbound | Rust `axle_ai` | IMPLEMENTED |
| 2 | Hosted web search (Exa, `https://axle.llc/search`) | outbound | Rust `axle_tools/web_search.rs` | IMPLEMENTED, no fallback provider |
| 3 | MCP — agent as client | outbound | Rust `axle_tools/mcp.rs` | IMPLEMENTED (HTTP + stdio) |
| 4 | MCP — server as tool provider to the agent | inbound | `apps/server/src/mcp/` | IMPLEMENTED |
| 5 | GitHub (CLI/OAuth token, PRs, diffs, review tool) | outbound | desktop IPC + server + auth worker | IMPLEMENTED |
| 6 | Plugin OAuth providers (Gmail, Microsoft Graph, Slack, Jira, …) | outbound | `axle-auth-worker` + server plugin toolkit | IMPLEMENTED (21/21 worker tests green) |
| 7 | Preview browser automation (Playwright) | local | server `mcp/toolkits/preview`, desktop preview | IMPLEMENTED |
| 8 | Integrated terminal (PTY) | local | server `terminal/Manager.ts` | IMPLEMENTED |
| 9 | Relay — mobile device ↔ environment | cloud | `infra/relay` | IMPLEMENTED; not runnable locally |
| 10 | APNs push + Live Activities | outbound from relay | relay `agentActivity/*` | IMPLEMENTED; needs Apple credentials |
| 11 | Analytics + release feed (Convex) | outbound | `axle-analytics`, web | IMPLEMENTED |
| 12 | Update distribution (download worker + update portal + electron-updater) | outbound | `axle-download-worker`, `apps/desktop/src/updates` | IMPLEMENTED; contracts frozen |
| 13 | SSH / WSL / Tailscale remote environments | outbound | `packages/ssh`, `packages/tailscale`, desktop `src/ssh`, `src/wsl` | IMPLEMENTED |

## 2. Model providers

**Files:** `crates/axle_ai/src/{provider.rs,types.rs,retry.rs,openai.rs,anthropic.rs,gemini.rs,openrouter.rs,stream_parser.rs}`.

- Common trait `LlmProvider` (`provider.rs:34-55`) with `complete` and `stream`; `ContentPart` includes ProviderState, which is persisted in sessions but never rendered (`types.rs`).
- Retries: only 429/5xx, max 2 retries, 1 s→2 s→4 s capped 30 s (`retry.rs:5-18`). **[I]** No retry for stream truncation or 4xx auth errors; those surface to the loop.
- Selection plumbing: web `settings.models` → server model options (`codexModelOptions.ts`) → argv `--provider/--model/--effort/--context-window` → runtime resolution (`main.rs:236-267`).

## 3. Web search

**File:** `crates/axle_tools/src/web_search.rs`.
- Single hosted provider at `https://axle.llc/search`; worker URL overridable via `AXLE_SEARCH_WORKER_URL`; max 10 results per call; **no fallback provider** — if the endpoint is down, search fails.
- The system prompt treats `web_search` as the default research path and restricts `preview_*` tools to real browser work (`axle_prompt/src/builder.rs:483-657`).

## 4. MCP in both directions

**Agent as MCP client:** protocol `2025-06-18`, HTTP + stdio transports, SSE `data:` parsing, 45 s request / 120 s init timeouts, 4 KB stderr tail, paginated tools/list; **all MCP tools require approval** (`crates/axle_tools/src/mcp.rs:15-31,592-596`).

**Server as MCP provider:** `apps/server/src/mcp/McpHttpServer.ts` registers three toolkits (registrations at 214/219/291):

| Toolkit | Tools |
| --- | --- |
| Preview | `preview_status`, `preview_open`, `preview_navigate`, `preview_resize`, `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`, `preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop` |
| Plugins | `axle_request_plugin_authorization`, `axle_plugin_call`, `getPullRequestComments` |
| Pull request review | `review_pull_request` |

Session scoping lives in `McpSessionRegistry.ts` / `McpProviderSession.ts`; invocation context (thread, cwd, environment) in `McpInvocationContext.ts`; browser state brokered by `PreviewAutomationBroker.ts`. The CLI receives `--mcp-url` + `--mcp-bearer-token-env-var`, and the server sets `T3_MCP_BEARER_TOKEN` for the child process (`AxleAdapter.ts:53-55`). **[I]** Token value is per-launch; rotation/caching policy was not established.

## 5. GitHub

- **Surface:** desktop IPC handlers `githubCli`, `githubOAuth`, `githubResilience`, `githubPullRequestDiff` under `apps/desktop/src/ipc/`; web `routes/pull-requests.tsx`; contracts `git.ts`, `vcs.ts`, `review.ts`, `sourceControl.ts`.
- **Token flow:** auth worker exposes `/v1/github/exchange`, `/v1/github/refresh`, `/v1/github/revoke` and `/github/oauth/callback` (`axle-auth-worker/src/*`). Root workflow `github-auth-security.yml` exists, implying CI checks on that path.
- **Agent-facing:** `review_pull_request` (server toolkit) and `getPullRequestComments` (plugin toolkit) let the agent review PRs without direct GitHub credentials in the agent process.
- **Known failing tests:** GitManager fork-PR tests (2) — see `11`.

## 6. Plugin providers (Gmail, Microsoft Graph, Slack, Jira, …)

**Owner:** `axle-auth-worker` (`/v1/plugins/authorize|cancel|disconnect|import|callback`) with per-provider scope tables in `src/` (space- vs comma-joined scope parameters differ per provider; inspect the tables before adding a provider). Server side: `mcp/toolkits/plugins/{tools.ts,handlers.ts}`; UI: `routes/plugins.tsx`, `settings.plugins.tsx`; desktop credential/sync IPC: `pluginCredentials`, `pluginSync`.

**Representative trace (verified shape):** agent calls `axle_request_plugin_authorization` → server invokes auth worker `/v1/plugins/authorize` → user completes consent in browser → provider callback lands on `/v1/plugins/callback` → auth worker stores/returns credential reference → subsequent `axle_plugin_call` executes the provider request server-side and returns the result to the agent. Every plugin tool call crosses the MCP approval gate.

## 7. Preview browser automation

Server toolkit (`mcp/toolkits/preview/tools.ts`) classifies tools as plain/safe/readonly browser tools (39-218); broker `PreviewAutomationBroker.ts`; desktop integration under `apps/desktop/src/preview/*`; web UI `browser/BrowserDeviceToolbar.tsx`. Playwright is a server dependency (`apps/server/package.json`). The adapter injects `AXLE_BROWSER_INSTRUCTIONS` into turns that have browser tooling (`AxleAdapter.ts:56`). Status: IMPLEMENTED; **[U]** whether a headless browser is guaranteed present on every platform (desktop bundles it; bare CLI does not).

## 8. Terminal

`apps/server/src/terminal/Manager.ts`: PTY sessions via `node-pty` (a build-script-allowed dependency in `pnpm-workspace.yaml`), env blocklist `{PORT, ELECTRON_RENDERER_PORT, ELECTRON_RUN_AS_NODE}` (84), 5 000-line history, 128-session retention, service at 117. **[I]** Env blocklist deliberately prevents the PTY from hijacking the server's own ports/Electron linkage.

## 9. Relay, mobile, and push

**Package:** `t3code-relay` (`axle-desktop/source/infra/relay`). Entry `src/worker.ts` wires: Effect HttpApi from `@axle/contracts/relay`, DPoP client auth layers (`relayDpopClientAuthLayer`), environment auth, token API, mobile API, metadata/health APIs, CORS (`relayCors`), tracing (`makeRelayTraceLayer`), Cloudflare Queues for APNs (`RelayApnsDeliveryQueue`, `RelayApnsDeliveryDeadLetterQueue`), D1/Postgres rows via drizzle (`src/db.ts`, `migrations/postgres/` 2026-05-27 → 2026-07-06).

Domain modules: `auth/{DpopProofs,RelayTokens}`, `environments/{EnvironmentCredentials,EnvironmentLinks,EnvironmentConnector,EnvironmentLinker,EnvironmentPublishSignatures,ManagedEndpointAllocations,ManagedEndpointProvider}`, `agentActivity/{AgentActivityPublisher,AgentActivityRows,ApnsClient,ApnsDeliveries,apnsJwt,ApnsProviderTokens,LiveActivities,Devices,MobileRegistrations,DeliveryAttempts}`.

**Trace:** mobile registers a device → relay records registration + push token → environment publishes signed activity → `AgentActivityPublisher` persists row + enqueues APNs job → `ApnsClient` (JWT via `apnsJwt`) delivers → `ApnsDeliveries`/`DeliveryAttempts` record outcome; dead-letter queue catches failures. Status: IMPLEMENTED; **[U]** end-to-end APNs delivery could not be verified locally (Apple credentials, Cloudflare account).

## 10. Analytics and releases

`axle-analytics` (Convex: `analytics`, `releases`, `awsReleases`, `schema`, `http`). Web sends events from `apps/web/src/observability`; release metadata feeds the download/update flows. **[U]** Privacy posture of collected events requires reading the Convex functions; not done in this pass.

## 11. Updates and distribution

`apps/desktop/src/updates/*` + `update-portal/` + `axle-download-worker`. **Frozen contracts** (do not change — `axle-desktop/source/AGENTS.md`): `AXLE_UPDATE_URL`, `AXLE_UPDATE_SITE_URL`, `/get/updates/*`, `latest.yml`, product name in packaging. The nested `release.yml` workflow builds on tag push (`v*.*.*` excluding nightlies), every-3-hours nightly schedule (skips when HEAD == last nightly tag), and manual dispatch with `stable|nightly` + version inputs (`axle-desktop/source/.github/workflows/release.yml`).

## 12. Not found / not present

- No payment/billing provider (Stripe/etc.) anywhere in manifests — **[I]** monetization is not implemented in this repo.
- No vector database or embedding store; memory search is keyword-based and sessions are files.
- No message queue besides Cloudflare Queues used by the relay for APNs.
- `infra/relay` was the only `infra/*` directory observed at the root of the TS workspace in this pass; other `infra/*` globs exist per `pnpm-workspace.yaml` but were not enumerated.
