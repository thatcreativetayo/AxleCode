# 07 — API, Events, and Communication Contracts

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date: 2026-10-13. Contracts live in `axle-desktop/source/packages/contracts/src/` (47 modules, re-exported by `index.ts`); runtime enforcement is Effect Schema on both ends.

There are **five distinct communication systems**:

1. Client ↔ server WebSocket RPC (`/ws`) for orchestration.
2. Server ↔ agent NDJSON over stdio (the Axle protocol).
3. Agent → server HTTP MCP (bearer-authenticated tool calls).
4. HTTP routes on the server (auth-scoped: OTLP proxy, assets, static).
5. Cloud APIs: auth worker HTTP, relay HttpApi, download worker, Convex.

---

## 1. WebSocket RPC (clients ↔ orchestrator)

**Route:** `GET /ws` (`apps/server/src/ws.ts:2175-2226`). Upgrade authenticated by `EnvironmentAuth.authenticateWebSocketUpgrade` (2183); RPC server built with JSON serialization (2196).

**Methods** (`packages/contracts/src/orchestration.ts:29-37`):

| Method | Purpose |
| --- | --- |
| `orchestration.dispatchCommand` | Submit any command from the table below |
| `orchestration.getTurnDiff` | Diff for one turn |
| `orchestration.getFullThreadDiff` | Diff for a whole thread |
| `orchestration.replayEvents` | Replay the event stream |
| `orchestration.getArchivedShellSnapshot` | Sidebar/shell data for archived threads |
| `orchestration.subscribeShell` | Live shell stream |
| `orchestration.subscribeThread` | Live per-thread stream |

Additionally `ws.ts` imports scope constants for `terminal:operate`, `review:write`, `relay:write`, `access:read`, i.e. the RPC surface carries multiple scoped capability groups beyond orchestration (`ws.ts:12-23`). **[I]** exact method↔scope mapping should be read from `WsRpcGroup` before changing auth.

## 2. Orchestration commands (client → server)

From `packages/contracts/src/orchestration.ts` (`type:` literals at 513-752). Names are wire contracts; do not rename.

| Category | Commands |
| --- | --- |
| Projects | `project.create`, `project.meta.update`, `project.delete` |
| Threads | `thread.create`, `thread.delete`, `thread.archive`, `thread.unarchive`, `thread.meta.update`, `thread.runtime-mode.set`, `thread.interaction-mode.set` |
| Turns | `thread.turn.start` (two schema variants — initial + follow-up/attachment shape), `thread.turn.interrupt` |
| Interaction | `thread.approval.respond`, `thread.user-input.respond` |
| Checkpoints | `thread.checkpoint.revert` |
| Session | `thread.session.stop`, `thread.session.set` |

Determinism: commands carry ids; receipts recorded in `command_receipts` (migration `002`). Scheduled runs use `schedule:{run.id}` as the deterministic id (`schedules/Service.ts`).

## 3. Orchestration events (server → clients)

Client-visible events (`orchestration.ts:834-855`, re-declared for the shell stream at 1055-1160):

`project.created`, `project.meta-updated`, `project.deleted`, `thread.created`, `thread.deleted`, `thread.archived`, `thread.unarchived`, `thread.meta-updated`, `thread.runtime-mode-set`, `thread.interaction-mode-set`, `thread.message-sent`, `thread.turn-start-requested`, `thread.turn-interrupt-requested`, `thread.approval-response-requested`, `thread.user-input-response-requested`, `thread.checkpoint-revert-requested`, `thread.reverted`, `thread.session-stop-requested`, `thread.session-set`, `thread.proposed-plan-upserted`, `thread.turn-diff-completed`, `thread.activity-appended`.

Runtime-originated events (dispatched by the provider-runtime ingestion path, not by users; `orchestration.ts:760-809`):

`thread.message.assistant.delta`, `thread.message.assistant.complete`, `thread.proposed-plan.upsert`, `thread.turn.diff.complete`, `thread.activity.append`, `thread.revert.complete`.

Note the deliberate two spellings: user-facing events are hyphenated (`thread.message-sent`), runtime events are dotted (`thread.message.assistant.delta`). Replay/subscription consumers must handle both. **[V]**

## 4. Server HTTP routes

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/ws` | Upgrade auth (`authenticateWebSocketUpgrade`) | Orchestration RPC socket |
| POST | `/api/observability/v1/traces` | `orchestration:operate` | OTLP trace proxy (`OTLP_TRACES_PROXY_PATH`, `http.ts:43,242-297`) |
| GET | asset route | — | Attachment/asset serving (`http.ts:297`) |
| GET | static/dev route | — | Web app assets / dev server fallback (`http.ts:332`) |
| GET | CLI token callback | — | `cloud/CliTokenManager.ts:372` (path constant in that file) **[U]** exact path not read |

CORS is configured at `http.ts:61` (see `httpCors.ts` for the policy). **[I]** The raw routes above are the ones registered outside the Effect HttpApi groups; the grouped APIs (`EnvironmentHttpApi` etc. at `http.ts:222+`) add environment metadata endpoints.

## 5. NDJSON protocol (server ↔ `axle` process)

**Spawn contract** (`AxleAdapter.ts:949-1013`): `axle --json-stream --provider <id> --model <id> --cwd <dir> --prompt-stdin [--base-url] [--text-only] [--session <id>] [--no-workspace-context] [--effort <level>] [--context-window <n>] [--interaction-mode plan|build] [--image-path <p> --image-mime-type <m>] [--append-system-prompt <text>] [--mcp-url <url> --mcp-bearer-token-env-var <NAME>] [--approval-file <path>]`. Prompt is written to stdin; shell is disabled (`shell: false`); stderr capped at 64 KB; idle timeout 10 min; reconnect up to 5× with 1→16 s backoff (`AxleAdapter.ts:1015-1176`).

**Event stream** (decoder `AxleAdapter.ts:246-508`):

| Event `type` | Payload highlights | Client effect |
| --- | --- | --- |
| `delta` | text chunk | streaming assistant message |
| `thinking_delta` | thinking chunk | thinking UI (validated; invalid frames dropped) |
| `session` | provider session/thread ids | binds runtime session |
| `tool.started` | tool name/args | tool card |
| `tool.completed` | output/error, `durationMs`, `timedOut` | tool card result |
| `usage` | token usage | usage meters |
| `approval.requested` | `requestId`, tool, detail | approval prompt |
| `approval.resolved` | `requestId`, decision | clears approval |
| `result` | final message | turn completion |
| protocol error | — | fail-open retryable error |

**Approval response channel:** append a JSON line `{type:"approval_response", requestId, decision}` to the `--approval-file` path (`AxleAdapter.ts:861-869`); the Rust side polls every 150 ms and ignores stale/malformed lines (`loop_runner.rs:69-145`).

## 6. MCP (agent → server)

`apps/server/src/mcp/McpHttpServer.ts` serves the three toolkits documented in `05-integrations.md`; the agent connects with `--mcp-url` + bearer env var (`T3_MCP_BEARER_TOKEN`, `AxleAdapter.ts:53-55`). Every MCP tool call requires an approval in the agent loop (`crates/axle_tools/src/mcp.rs:592-596`). **[U]** exact HTTP path and token format were not read in this pass.

## 7. Auth worker HTTP API (`axle-auth-worker`)

| Route | Purpose |
| --- | --- |
| `/health` | Liveness |
| `/v1/session` | Session exchange/validation |
| `/v1/mcp` | MCP credential issue |
| `/v1/clerk/restore` | Clerk-backed restore |
| `/v1/plugins/authorize`, `/cancel`, `/disconnect`, `/import`, `/callback` | Plugin OAuth lifecycle |
| `/v1/github/exchange`, `/refresh`, `/revoke` | GitHub token lifecycle |
| `/github/oauth/callback` | GitHub OAuth redirect |

Worker tests: 21/21 green (prior verification, same working tree).

## 8. Relay API + queues (`infra/relay`)

Effect `HttpApi` (`RelayApi` from `@axle/contracts/relay`) with groups wired in `src/worker.ts:78+`: `healthApi`, `metadataApi`, `clientApi`, `dpopClientApi`, `tokenApi`, `mobileApi`, `serverApi` (+ scalar docs route, 404 route). Auth layers: `relayClientAuthLayer`, `relayDpopClientAuthLayer`, `relayEnvironmentAuthLayer`. Cloudflare Queues: `RelayApnsDeliveryQueue`, `RelayApnsDeliveryDeadLetterQueue` (`src/queues.ts`). Observability via `makeRelayTraceLayer`.

## 9. Desktop IPC

`apps/desktop/src/ipc/` defines channels/methods for: `accountSession`, `connectionCatalog`, `clientSettings`, `githubCli`, `githubOAuth`, `githubResilience`, `githubPullRequestDiff`, `pluginSync`, `pluginCredentials`, `sshEnvironment`, `serverExposure`, `preview`, `updates`, `window`, `wsl`. The nested CI gate greps the preload bundle for `desktopBridge|getLocalEnvironmentBootstrap|PICK_FOLDER_CHANNEL|wsUrl` — treat those symbols as IPC contract anchors (`axle-desktop/source/.github/workflows/ci.yml`).

## 10. Schedules contract

`packages/contracts/src/schedules.ts`: schedule frequency shapes, run statuses (including `needs-attention`), list + target selection, typed errors. Executor semantics are in `apps/server/src/schedules/Service.ts` (busy-guard list: session running/starting, turn running, pending approvals, pending user input; deleted/archived chats are rejected).

## 11. Event lifecycle, retries, cleanup

- **Dispatch acknowledgment** is the command receipt (`command_receipts`), not a socket ack; a retried identical command is absorbed there. **[I]** precise receipt comparison logic not read.
- **Subscriptions**: `subscribeThread` / `subscribeShell` stream live events; `replayEvents` reconstructs history; `getArchivedShellSnapshot` gives a cold snapshot. Consumers should assume at-least-once delivery during reconnects and be idempotent by event id (`EventId` exists in contracts).
- **Interrupts**: `thread.turn.interrupt`; the adapter tracks cancelled turns in `cancelledTurnKeys` and kills the child process.
- **Provider process failure**: retryable vs non-retryable error classification at `AxleAdapter.ts:146-179`; reconnect backoff 1→16 s, max 5 attempts.
- **Approval cleanup**: migration `025` cleans invalid pending approvals; `projection_pending_approvals` gets `resolved_at` rather than row deletion.
- **WebSocket reconnection**: client-side policy not read in this pass. **[U]**
