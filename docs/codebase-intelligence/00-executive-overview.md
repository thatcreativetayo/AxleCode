# 00 — Executive Overview

Part of the Axle codebase-intelligence dossier. Start here, then read `01-repository-map.md`, `02-system-architecture.md`, `15-master-codebase-context.md`. Master index: `CODEBASE_INTELLIGENCE_INDEX.md`.

Investigation window: 2026-10-13 (Africa/Lagos). Branch `main`, remote `thatcreativetayo/AxleCode`, working tree carries an uncommitted UI-redesign WIP (see `11-implementation-status-and-technical-debt.md`). Status legend used across the dossier: **[V]** = verified by reading source/config/tests; **[I]** = inference from evidence; **[U]** = unknown/unverified; **[F]** = verified failing.

---

## 1. What Axle is, according to the code

An AI coding agent that runs locally on the user's machine and is driven from a desktop app, a browser UI, or a mobile companion app.

- Product statement: `README.md` — "An AI engineer that lives on your computer… desktop app (Windows, macOS, Linux)… runs locally on your computer, and the only network traffic is the model calls you make with your own key." **[V]**
- The runtime that actually calls models, runs tools, and persists sessions is a Rust binary, `axle`, built from `crates/axle_cli/src/main.rs`. It speaks an NDJSON event protocol on stdout when started with `--json-stream`. **[V]**
- The orchestration layer is a TypeScript server (`axle-desktop/source/apps/server`, package name `t3`, bin `axle` → `dist/launcher.mjs`) that owns conversations ("threads"), turns, checkpoints, provider processes, MCP tool exposure, schedules, terminals, and an SQLite projection database. **[V]**
- Three clients exist: Electron desktop shell (`axle-desktop/source/apps/desktop`), React web UI (`apps/web`), Expo mobile app (`apps/mobile`). **[V]**
- Three cloud/edge services exist: an auth + plugin-OAuth Cloudflare Worker (`axle-auth-worker`), the device↔environment relay (`axle-desktop/source/infra/relay`, package `t3code-relay`, Effect + Alchemy + Postgres/Drizzle + APNs), and a release/download worker (`axle-download-worker`). Analytics/releases live in `axle-analytics` (Convex). Marketing site: `axle-landing`. **[V]**

Legacy naming is deliberate and must be preserved: internal identifiers `t3`, `@t3tools/*`, `T3CODE_*`, `~/.t3`, `pingdotgg/t3code` repository URL in `apps/server/package.json:6`, `.t3` directories, and `RIVET_HOME` compatibility remain per `axle-desktop/source/AGENTS.md` and rebrand-compatibility code such as `apps/server/src/launcher.ts:41-58` (`AXLE_HOME`, `RIVET_HOME`, `T3CODE_HOME`, homes `.Axle`/`.Rivet`/`.sparky-desktop`/`.t3`). **[V]**

## 2. Technology stack (all verified from manifests)

| Layer | Technology |
| --- | --- |
| Agent runtime | Rust 2021, tokio, reqwest; 10 crates in `crates/`, workspace version `1.1.22` (`Cargo.toml`) |
| Server | TypeScript, Effect 4.0.0-beta.78 (services/layers/routers), SQLite (`@effect/sql-sqlite-bun`), node-pty, playwright-core, electron-updater |
| Web | React 19.2.6, TanStack Router, Tailwind CSS v4, Zustand, Lexical editor, xterm, framer-motion, @pierre/diffs |
| Desktop | Electron 41.5.0, electron-builder, electron-store, SSH + Tailscale workspace packages |
| Mobile | Expo/React Native (EAS build profiles), native widgets |
| Cloud | Cloudflare Workers (auth worker, relay, download worker), Alchemy IaC, Drizzle + Postgres (relay), Effect HttpApi, APNs push, Convex (analytics) |
| Toolchain | pnpm 11 via `vite-plus` (`vp`) with `catalog:` pinning; tsgo typecheck; oxlint + custom `oxlint-plugin-t3code` |

## 3. The single most important architecture fact

Axle is two cooperating runtimes joined by one protocol:

1. **Rust agent plane** — prompt building, model streaming, tool execution, approvals, sessions, compaction, memory. Owns model provider credentials and calls.
2. **TypeScript orchestration plane** — owns threads/turns, event persistence, projections, checkpoints, git/VCS, terminals, schedules, MCP toolkits, and the UI transport.

They meet at the NDJSON boundary implemented in `apps/server/src/provider/Layers/AxleAdapter.ts` (`makeAxleStreamDecoder` at 246-508, `runAxle` at 1015-1176, `makeAxleProcessArgs` at 949-1013). The server spawns one `axle --json-stream` process per turn, writes the prompt to stdin, parses typed events, and exposes them to clients. Approvals travel back through a file-watch protocol (`loop_runner.rs:42-145`, `AxleAdapter.ts:861-869`). **[V]**

## 4. Verified capability highlights

- Streaming turns with proactive context compaction, overflow recovery and retry (`crates/axle_agent/src/loop_runner.rs:1916-2283`; `crates/axle_compaction/src/engine.rs`). **[V]**
- 14 built-in Rust tools + 4 memory tools + MCP-imported tools; plan-mode tool restriction; per-tool approval flags; 300 s default timeout (`crates/axle_tools/src/registry.rs:23-225`, `bash.rs:73-79`). **[V]**
- Session persistence as append-only JSONL with header validation, crash repair, compaction trimming (`crates/axle_session/src/manager.rs`). **[V]**
- Provider coverage: OpenAI, Anthropic, Gemini, OpenRouter, plus CLI-level extra providers (fireworks, cerebras, groq, ollama, ollama-cloud) — see `04-ai-and-agent-systems.md`. **[V]**
- MCP server in the TS server exposing preview browser automation (`preview_*`), plugin auth/call, and PR review toolkits to the agent (`apps/server/src/mcp/`). **[V]**
- Scheduled background tasks with atomic claim/advance in a single-row SQLite state table (`apps/server/src/schedules/Service.ts:42-43,162-172`). **[V]**
- 32 SQLite migrations covering event-sourced orchestration + projections + auth scopes (`apps/server/src/persistence/Migrations/001..032`). **[V]**

## 5. Verified problems a new engineer must know on day one

1. **[F] CI never runs the real gate.** The only workflow that typechecks/tests the TS workspace is `axle-desktop/source/.github/workflows/ci.yml`; GitHub only executes workflows from the repository-root `.github/workflows/`, so this nested file is dead. Root workflows (`axle-installers-ci`, `axle-windows-artifact`, `build-macos`, …) exist, but the `vp check`/`typecheck`/`build:desktop` gate is not among them. Details in `10-testing-build-deployment.md`.
2. **[F] `apps/server` typecheck has ~239 errors; its test suite has ~124 failing tests.** 222 typecheck errors and 111 failing tests trace to `ScheduledTasks` not being provided in `apps/server/src/server.test.ts` even though the service exists (`schedules/Service.ts:22`); other clusters are GitManager (2, fork-PR), ProviderRuntimeIngestion (9), VcsStatusBroadcaster Windows symlink EPERM (1), keybindings (1). This is the highest-leverage fix in the repo.
3. **[F] Root lint has 4 hard errors** (`t3code(namespace-node-imports)`) in `account-api` and `schedules/Service.ts`.
4. **[I] Repo-wide version drift:** Rust/TS packages at 1.1.22, download worker ~1.1.15, analytics 0.0.29; `README.md` references v1.1.23 assets. Canonical release repo is ambiguous (`thatcreativetayo/AxleCode` in README vs `pingdotgg/t3code` in `apps/server/package.json` vs root workflow targets). See `14-open-questions-and-unknowns.md`.
5. **[I] A large uncommitted UI redesign** (154 modified + 8 untracked files, mostly `apps/web`, plus `ui-redesign-*.md` docs) sits in the working tree. It is not committed anywhere; treat as WIP and do not assume it ships.

## 6. Maturity summary by subsystem

| Subsystem | Maturity | Evidence |
| --- | --- | --- |
| Rust agent core | High — complete loop, tools, sessions, compaction, providers; tests green (`cargo test`, ~147 tests incl. e2e journey) | `crates/`, `loop_runner.rs` |
| Server orchestration/persistence | High design, medium health — rich event-sourcing + projections; failing tests/typecheck | `apps/server/src/orchestration`, `persistence` |
| Desktop shell | Medium-high — updater, IPC, SSH, WSL, preview all present; `desktop` typecheck passes | `apps/desktop/src` |
| Web UI | Medium-high — full route tree; WIP redesign; `apps/web` typecheck passes | `apps/web/src/routes` |
| Mobile | Medium — Expo app with 90 test files; delivery via EAS workflows | `apps/mobile` |
| Cloud services | Medium — auth worker tests 21/21 green; relay is newer (2026-05→07 migrations) and unverified locally | `axle-auth-worker`, `infra/relay` |
| CI/release | Low — release workflow exists (tag + nightly cron + manual dispatch); quality gate effectively absent | `.github/workflows/*` |

## 7. How to use this dossier

Read in this order: `01` (map) → `02` (architecture) → `15` (master context) → then per-task documents. Every claim carries a file path; where a claim is inference it is labeled. `14-open-questions-and-unknowns.md` lists what could not be established statically so you do not mistake silence for certainty.
