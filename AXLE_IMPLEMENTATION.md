# Axle — Implementation & Migration Notes

Working record of the transformation of this repository into **Axle**, kept in
sync with the code rather than aspirations. Product documentation lives in
`docs/axle-architecture.md` (layers, contracts, event frames, approvals,
sessions) and `docs/axle-configuration.md` (CLI, providers, `.axle/` workspace
files, environment variables, desktop configuration).

Last updated: 2026-10-12.

## What Axle is

Axle is an AI engineering workspace: a desktop app that pairs a Rust agent
runtime (the `axle` CLI) with a server that owns orchestration, approvals,
checkpoints and persistence, plus web and mobile frontends.

- Rust runtime (`crates/axle_*`): provider adapters (`axle_ai`), tool registry
  and built-ins plus MCP (`axle_tools`), agent loop (`axle_agent`), sessions
  (`axle_session`), memory (`axle_memory`), compaction (`axle_compaction`),
  prompt building (`axle_prompt`), events/extensions (`axle_extensions`), and
  the CLI (`axle_cli`).
- Desktop (`axle-desktop/source/apps/desktop` + `apps/server`): Electron shell,
  orchestration, approvals, SQLite persistence projections, terminal Manager,
  GitManager, MCP server and toolkits.
- Frontends: web (`apps/web`), mobile (`apps/mobile`), marketing site
  (`apps/marketing`), account API (`apps/account-api`).

## Architecture snapshot

- The desktop app spawns the Rust `axle` CLI as the agent runtime
  (`AxleAdapter.ts`: `--json-stream --provider X --model Y --cwd Z
  --prompt-stdin`) and renders NDJSON events.
- Model slugs use `provider/model` (split on the first `/`), parsed by
  `parseAxleModelSelection` in `AxleAdapter.ts`.
- Adding a provider touches these registration points: Rust CLI provider
  factory + `crates/axle_ai`, TS `AxleModelCatalog.ts`, `AxleDriver.ts`, desktop
  WSL env forwarding (`DesktopBackendConfiguration.ts`), web
  `providerIconUtils.ts`, `ModelPickerContent.tsx`, `axleModelCatalog.ts`,
  `ModelsSettingsPanel.tsx`.

## Core guarantees (implemented)

- Approval gate: gated tools (bash, write, edit, MCP) pause and poll a
  per-thread approval file (`<cwd>/.axle/approvals/<sha256(threadId)>.jsonl`);
  the CLI emits `approval.requested`/`approval.resolved`; the desktop adapter
  and server route decisions back and auto-resolve stale rows.
- Cancellation and resumability: Ctrl+C drops the running turn future; the
  session JSONL stays prefix-accurate; `repair_tool_protocol` rebuilds orphaned
  tool calls on resume without rewriting the audit log.
- Execution boundary: `bash` runs through an `ExecutionTarget`; only
  `LocalExecutionTarget` exists (spawns the configured shell; `--shell` /
  `AXLE_SHELL` override). No remote/sandbox target is pretended.
- Structured tool events carry `duration_ms` + `timed_out` end to end (Rust
  events -> CLI NDJSON -> desktop adapter -> web timeline).
- MCP transports: streamable HTTP and stdio behind one connection layer;
  GitHub remote MCP via `--github-mcp` with PAT authentication.
- Specialized agent profiles: `.axle/agents.toml` plus `--agent <NAME>`
  (instructions, provider/model preference, allowed tools).
- End-to-end journey test: `crates/axle_cli/tests/journey_e2e.rs` drives the
  real compiled `axle` binary through tool use, durable session, resume, and
  approval allow/deny against a local mock provider.

## Migration history

The product has carried three names:

1. **Sparky** — the original line (also the brand in the git history).
2. **Rivet** — the previous rebrand, now superseded.
3. **Axle** — the current and only product identity. Package names, crates,
   directories, product strings, environment variables, storage keys, docs,
   tests and fixtures all speak Axle.

Two exceptions are kept on purpose and are isolated in this document:

- **Legacy compatibility shims** read old data and state so installations that
  predate the rename keep working. They are read-only fallbacks: current Axle
  identifiers always win, legacy locations are left untouched, and every shim
  is covered by a test or a migration.
- **T3 contractual identifiers** (`T3CODE_*`, `@t3tools/*`, `~/.t3`,
  `t3code.*` mobile storage keys, `/api/t3-connect/*`, the `t3` server package
  name, `oxlint-plugin-t3code`) belong to an external integration contract —
  see `axle-desktop/source/AGENTS.md`. They are not Axle branding and must not
  be renamed.

## Legacy compatibility shims (intentional)

| Legacy identifier | Kind | Where | Covered by |
| --- | --- | --- | --- |
| `RIVET_HOME`, `SPARKY_HOME`, `RIVET_MEMORY_GLOBAL_DIR`, `SPARKY_MEMORY_GLOBAL_DIR` | environment variables | Read as fallbacks when the `AXLE_*` equivalent is unset: `crates/axle_memory/src/lib.rs`, `apps/server/src/memoryStore.ts`, `apps/server/src/launcher.ts` | Rust unit tests, `memoryStore.test.ts`, `launcher.test.ts` |
| `.rivet/`, `.sparky/` project dirs (memory, sessions, `agents.toml`, skills) | on-disk state | Read fallbacks in `crates/axle_memory` (`LEGACY_PROJECT_DIRS`), `crates/axle_session` (`LEGACY_STATE_DIRS`), `crates/axle_config` (`LEGACY_AGENT_PROFILES_RELATIVE_PATHS`), `crates/axle_prompt` (skill roots), `apps/server/src/memoryStore.ts` (legacy project files) | Rust unit tests, `memoryStore.test.ts` |
| `.Rivet/`, `.sparky-desktop/` home dirs, `Rivet`/`Sparky` app-data dirs | desktop homes | Reused only when the newest Axle home has no state: `apps/server/src/launcher.ts`, `apps/server/src/memoryStore.ts` | `launcher.test.ts` |
| `rivet`, `Sparky (Alpha)` (and dev-line variants) user-data dirs | Electron userData | Probed in order; the newest existing legacy profile wins: `apps/desktop/src/app/DesktopEnvironment.ts` | `DesktopAppIdentity.test.ts` |
| `rivet.scheduled-tasks`, `sparky.scheduled-tasks` (+ `.suggestion-cycle`) | web storage keys | `apps/web/src/scheduledTasks.ts` via the `useLocalStorage` legacy-key mechanism | `useLocalStorage.test.ts` |
| `rivet.plugin-session.v1`, `sparky.plugin-session.v1`, `rivet.plugin-installation-id.v1`, `sparky.plugin-installation-id.v1`, `rivet.plugin-session-revoke.v1`, `sparky.plugin-session-revoke.v1` | web storage keys | `apps/web/src/components/plugins/pluginApi.ts` | `pluginApiLegacyStorage.test.ts` |
| `rivet:archived-projects:v1`, `sparky:archived-projects:v1` | web storage keys | `apps/web/src/archivedProjectsState.ts` | `archivedProjectsState.test.ts` |
| `rivet_account_*`, `sparky_account_*` tables, indexes, constraints | Postgres schema | Renamed to `axle_account_*` by `apps/account-api/migrations/002_rebrand_axle.sql` | migration SQL, `apps/account-api/README.md` |

## Verification

Commands and results from this session are recorded below. Test invocations
from the app directory use:

```powershell
$env:pnpm_config_verify_deps_before_run="warn"; pnpm exec vp test run <files>
```

The env var downgrades pnpm 11's automatic deps-status install to a warning.
Without it, `pnpm exec`/`pnpm run` triggers `pnpm install`, which fails on
`infra/relay`'s private dependency URL (`https://pkg.ing/alchemy/078ff00` ->
404). The "node_modules are out of sync" warning for `infra/relay` is expected
and unrelated to test targets. Do not delete or rewrite the relay lockfile
state.

### Results (2026-10-12)

- `pnpm install --frozen-lockfile --prefer-offline
  --config.confirm-modules-purge=false --reporter=append-only` from
  `axle-desktop/source`: exit 0 (13m29.7s). One patched-dependency copy in the
  pnpm store (`@pierre/diffs`) had a corrupt, blank `dist/editor/editor.js`;
  deleting that one `.pnpm` directory and re-running the install produced two
  correctly patched copies. Keep `--config.confirm-modules-purge=false` on
  later installs: the interactive purge prompt otherwise hangs the run.
- Rust workspace: `cargo fmt --check` clean, `cargo check --workspace` clean,
  `cargo test --workspace` all green — `axle_config` 6, `axle_memory` 4,
  `axle_prompt` 7, `axle_session` 9, `axle_ai` 27, `axle_extensions` 3,
  `axle_tools` 63, `axle_agent` 17, `axle_cli` 7 (including `journey_e2e.rs`),
  `axle_compaction` 4 — 147 tests, 0 failures.
- TypeScript regression set (9 files, covering every rebrand-touched TS
  surface): 55 passed / 55. Files:

  ```text
  apps/web/src/archivedProjectsState.test.ts
  apps/web/src/scheduledTasks.test.ts
  apps/web/src/hooks/useLocalStorage.test.ts
  apps/web/src/components/plugins/pluginApiLegacyStorage.test.ts
  apps/server/src/memoryStore.test.ts
  apps/server/src/launcher.test.ts
  apps/desktop/src/app/DesktopEnvironment.test.ts
  apps/desktop/src/app/DesktopAppIdentity.test.ts
  apps/account-api/src/config.test.ts
  ```

  Three test-side fixes landed while getting this set green (the product
  behavior was already correct): `useLocalStorage.test.ts` asserted the wrong
  legacy-key precedence (rivet must win when both legacy keys exist; sparky is
  only the fallback), and `pluginApiLegacyStorage.test.ts` leaked module-scope
  session / installation-id caches across cases, so it now resets modules and
  re-imports `lib/runtime` + `./pluginApi` per test and covers the
  both-legacy-keys-present case.
- `apps/web` `pnpm run typecheck` (`tsgo --noEmit`): exits 0.

## Known pre-existing failures (do not attribute to the rebrand)

- `apps/server` `scripts/axle-sqlite-state.test.ts` — pre-existing.
- auth-worker logout-revocation test — pre-existing.
- `apps/server` `pnpm run typecheck` reports 13 pre-existing errors:
  `mcp/McpHttpServer.test.ts` JSON.parse lint; `mcp/toolkits/plugins/handlers.ts`
  missing `PreviewAutomationBroker` (x4); `mcp/toolkits/pullRequestReview/handlers.ts`
  JSON.parse lints (x3); `provider/Drivers/AxleModelCatalog.test.ts`
  `RequestInfo` undefined; `provider/Drivers/AxleModelCatalog.ts` Date.now lint
  + 2 argument-type errors; `provider/ProviderExecutionContext.ts` unsafe
  assertion lint.
- `apps/web` typecheck: the two `ChatView.tsx` errors previously seen under
  `exactOptionalPropertyTypes` no longer reproduce; `tsgo --noEmit` exits 0
  (see Verification).

## Working constraints and follow-ups

- Commit history: `main` holds the 500-commit import of the transformed tree
  targeted at the AxleCode remote; the pre-rebrand history (52 commits) stays
  reachable locally as `sparky-history` and on the old remote (kept as remote
  `sparky`).
- The working checkout lives at `Desktop\Axle`; `Desktop\Sparky` also exists as
  a junction to it and can be deleted once nothing references the old path.
- A GUI smoke pass (desktop on a machine with a display) is still pending; the
  runtime journey and the adapter boundaries are covered by automated tests.
