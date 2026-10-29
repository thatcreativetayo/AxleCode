# 01 — Repository Map

Part of the Axle codebase-intelligence dossier (index: `CODEBASE_INTELLIGENCE_INDEX.md`). Evidence date 2026-10-13.

The repository is a **two-build-world monorepo**: a Rust workspace at the root and a TypeScript/Electron monorepo under `axle-desktop/source/`, flanked by four standalone deployable services. Nothing links the two build systems; they meet at the compiled `axle` binary and the NDJSON protocol.

---

## 1. Root layout

| Path | Responsibility |
| --- | --- |
| `Cargo.toml` | Rust workspace: 10 crates, version `1.1.22`, resolver 2 |
| `crates/` | Agent runtime crates (see table below) |
| `axle-desktop/source/` | TS/Electron workspace root (has its own `pnpm-workspace.yaml`, `.github/workflows/`, `AGENTS.md`) |
| `axle-auth-worker/` | Cloudflare Worker: sessions, plugin OAuth, GitHub token exchange, MCP credentials |
| `axle-download-worker/` | Cloudflare Worker: release/asset download service (single `src/index.js`, ~399 LOC, version ~1.1.15) |
| `axle-analytics/` | Convex deployment: analytics, releases, awsReleases, schema, http endpoint |
| `axle-landing/` | Marketing/landing site (independent build; prior verification: build OK) |
| `docs/` | Hand-written architecture/config docs (`axle-architecture.md`, `axle-configuration.md`) + `docs/codebase-intelligence/` (this dossier) |
| `scripts/` | Root utility scripts |
| `.github/workflows/` | Root workflows: `axle-installers-ci.yml`, `axle-windows-artifact.yml`, `build-macos.yml`, `github-auth-security.yml`, `plugin-auth-pr.yml`, `replay-pr20-main.yml` |
| `.circleci/` | Legacy CI config (present; not the active gate) |
| `target/` | Rust build artifacts (do not inspect) |
| `.axle/` | Runtime state from local agent runs (do not read for content; treat as user data) |

## 2. Rust workspace — `crates/`

| Crate | Role | Key files |
| --- | --- | --- |
| `axle_cli` | Binary entry point `axle`; flag parsing, provider/model resolution, interactive loop, `/compact`, image attachments | `src/main.rs` (single file; flags at 29-209, `run_text_only` at 311, context-window parser 267, Ctrl+C save 1133-1157) |
| `axle_agent` | Agent loop, streaming turns, tool-call execution, approvals, usage accounting | `src/loop_runner.rs` (2472 lines: options 24-64, approvals 42-145, streaming turn 1916-2283, approval gating 2335-2430) |
| `axle_tools` | Tool implementations, registry, path guard, shell execution, MCP client, plan/end-task control tools | `registry.rs`, `tool.rs`, `bash.rs`, `edit.rs`, `read.rs`, `write.rs`, `find.rs`, `grep.rs`, `ls.rs`, `memory.rs`, `plan.rs`, `mcp.rs`, `web_search.rs`, `execution.rs`, `path_guard.rs` |
| `axle_ai` | Provider abstraction and wire clients | `provider.rs`, `types.rs`, `retry.rs`, `openai.rs`, `anthropic.rs`, `gemini.rs`, `openrouter.rs`, `stream_parser.rs` |
| `axle_session` | JSONL session persistence, context building, tool-protocol repair | `manager.rs` (header 197-208, compaction trim 234-254, append 259-282, repair 371-426), `types.rs` |
| `axle_compaction` | Context compaction engine | `engine.rs` (KEEP_RECENT_TOKENS/threshold 8-33, summarize 141-176, rewrite 184-196) |
| `axle_prompt` | System prompt + AGENTS.md + skills assembly | `builder.rs` (skill roots 340, `build()` 475-716) |
| `axle_config` | Config/profile loading (`.axle/agents.toml`, legacy `.rivet`/`.sparky`) | `lib.rs` (defaults 3-5, profile schema 24-92, validation 142-178, model caps 213-264) |
| `axle_memory` | Long-term memory store with secret-pattern rejection | `lib.rs` (secret patterns 61-84, search 110, context render 214-232) |
| `axle_extensions` | Extension system (Rust + JS extensions, event bus) | `events.rs` (AxleEvent enum 5-69), `js_engine.rs`, `extension.rs` |

## 3. TypeScript workspace — `axle-desktop/source/`

Workspace globs (`pnpm-workspace.yaml`): `apps/*`, `infra/*`, `oxlint-plugin-t3code`, `packages/*`, `scripts`.

### Apps

| Path | Package | Role |
| --- | --- | --- |
| `apps/server` | `t3` (bin `axle`) | The orchestration server **and** the npm-distributed launcher (`src/launcher.ts`) that installs/locates the Rust runtime and Electron app. Entry `src/bin.ts` (Effect CLI `t3` with `start`/`serve`/`project`), HTTP routes/WS in `src/http.ts`/`src/ws.ts`, provider adapters in `src/provider/`, MCP in `src/mcp/`, persistence in `src/persistence/`, orchestration in `src/orchestration/` |
| `apps/web` | `@axle/web` | React SPA (TanStack Router file routes in `src/routes/`), 12 top-level routes, Tailwind v4, Zustand, Effect Atom |
| `apps/desktop` | `@axle/desktop` | Electron main process (`src/main.ts`, `src/preload.ts`), IPC handlers, SSH/WSL/preview/updates integrations, electron-builder config |
| `apps/mobile` | mobile app | Expo/EAS React Native client: threads, terminal, diffs, review, agent-awareness; native widgets |
| `apps/account-api` | — | Small account API package (~1k LOC) |
| `apps/marketing` | — | Marketing app inside the workspace |

### Packages

| Path | Role |
| --- | --- |
| `packages/contracts` | 47 modules; the shared contract layer (Effect Schema): orchestration, provider, providerRuntime, relay, schedules, terminal, git, vcs, preview, settings, keybindings, rpc, ipc, environment, assets, auth, model, memory, review, sourceControl, remoteAccess, desktopBootstrap. `index.ts` re-exports all |
| `packages/client-runtime` | 130 files: client-side runtime (connection, RPC client, session state) used by web/desktop/mobile |
| `packages/shared` | 86 files: cross-cutting utilities (schemaJson, hostProcess, Net, …) |
| `packages/ssh` | SSH transport support for remote environments |
| `packages/tailscale` | Tailscale integration for remote reach |

### Infra + misc

| Path | Role |
| --- | --- |
| `infra/relay` (`t3code-relay`) | Cloudflare Worker relay between mobile devices and user environments: Effect HttpApi (`RelayApi` from `@axle/contracts/relay`), DPoP auth, Postgres via Drizzle (4 migrations, 2026-05→07), APNs delivery queue + dead-letter queue, live activities, managed endpoint allocations. Entry `src/worker.ts` |
| `infra/*` (other) | Other alchemy deployments (inspect per-directory) |
| `stubs/alchemy-stub` | Local stub that pnpm `overrides` redirect `alchemy` to (network-fetched `alchemy` package is replaced) |
| `experiments/` | Scratch area (not part of deployed surface) |
| `update-portal/` | Update portal assets for the desktop updater flow |
| `oxlint-plugin-t3code` | Custom lint plugin enforcing repo-specific rules (e.g. `namespace-node-imports`) |
| `patches/` | pnpm patched dependencies (14 patches incl. effect, expo, react-native) |

## 4. Executable entry points (startup map)

| Component | Entry | How it starts |
| --- | --- | --- |
| Agent runtime | `crates/axle_cli/src/main.rs` → binary `axle` | Spawned per turn by the server with `--json-stream`; also runnable interactively |
| Orchestration server | `axle-desktop/source/apps/server/src/bin.ts` (`Command.make("t3")`, subcommands `start`/`serve`/`project`) | `vp dev` (node --watch) or `node dist/bin.mjs` |
| npm launcher | `apps/server/src/launcher.ts` (build output `dist/launcher.mjs`, bin name `axle`) | Installed via npm; resolves `AXLE_HOME` (legacy `RIVET_HOME`, `T3CODE_HOME`), lays out `userdata/`, `caches/`, `worktrees/`, `memory/`, `launcher/`, then starts server/desktop |
| Desktop app | `apps/desktop/src/main.ts` (Electron main; `dist-electron/main.cjs`) | Electron via `scripts/start-electron.mjs`; packaged by electron-builder |
| Web app | `apps/web/src/AppRoot.tsx` + file routes | Served by the server; Vite build |
| Mobile app | Expo entry under `apps/mobile` | EAS workflows `mobile-eas-preview.yml` / `mobile-eas-production.yml` |
| Auth worker | `axle-auth-worker/src/entry.js` (index/app/final modules) | Cloudflare deploy |
| Relay | `infra/relay/src/worker.ts` | Cloudflare via `alchemy.run.ts` + `scripts/deploy.ts` |
| Download worker | `axle-download-worker/src/index.js` | Cloudflare deploy |
| Analytics | `axle-analytics/convex/*` | Convex deploy |

## 5. Generated / do-not-inspect

`target/` (Rust), `node_modules/`, `dist/`, `dist-electron/`, `build/`, `release/`, `*.generated.*`, `.wrangler/`, `apps/*/dist`, `.next` if present. `crates/axle_tools` skip-dir list also treats `target node_modules dist build release .wrangler .axle` as non-source when scanning (`path_guard.rs:95-111`).

## 6. Where the "product" lives vs. support

- Product core: `crates/*` + `apps/server` + `apps/web` + `apps/desktop`.
- Distribution/update: `axle-download-worker`, `update-portal/`, `apps/desktop/src/updates/*`, updater contracts (do not modify: `AXLE_UPDATE_URL`, `AXLE_UPDATE_SITE_URL`, `/get/updates/*`, `latest.yml`, product name — `axle-desktop/source/AGENTS.md`).
- Cloud glue: `axle-auth-worker`, `infra/relay`, `axle-analytics`.
- Go-to-market: `axle-landing`, `apps/marketing`.
