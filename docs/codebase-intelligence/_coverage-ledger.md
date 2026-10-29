# Coverage Ledger — Axle Codebase Intelligence Mission

Working ledger for the intelligence dossier. Final state as of mission close.
Last updated: 2026-10-13 (late evening, Africa/Lagos).

## Mission constraints (as executed)
- Investigation + documentation only. **No code changes, no commits, no branches.**
- Deliverables: 17 files in `docs/codebase-intelligence/` (15 numbered docs + master context + index).
- Evidence rules: file paths + symbols + line numbers where practical; separate verified **[V]** / inferred **[I]** / unknown **[U]** / failing **[F]**; no secret values; variable names only.
- `axle-desktop/source/AGENTS.md` respected: frozen identifiers (`T3CODE_*`, `@t3tools/*`, `t3`, `~/.t3`, `/api/t3-connect/*`, `/.well-known/t3/*`) and updater contracts untouched and documented as frozen; no `.repos/` access.
- Uncommitted UI-redesign WIP (154 M + 8 untracked, mostly `apps/web`, plus `ui-redesign-*.md`) documented as WIP only; no WIP file edited.

## Repo state at mission start (verified)
- Branch `main`. Remote `https://github.com/thatcreativetayo/AxleCode.git`.
- Working tree contains the UI-redesign WIP described above. Not produced by this investigation.
- Measurements taken this mission: cargo check/test green (~147 tests incl. `journey_e2e`); `apps/web` + `apps/desktop` typecheck pass; `apps/server` typecheck ~239 errors (222 = `ScheduledTasks` missing in `server.test.ts` layer; service at `schedules/Service.ts:22`); `apps/server` tests 124 failing; root lint 4 hard errors (`t3code(namespace-node-imports)`); auth-worker 21/21; landing build OK.

## Phase plan & final status
| Phase | Scope | Status |
| --- | --- | --- |
| 0 | Recon: instructions, docs, manifests, naming history | DONE |
| 1 | Repository discovery / inventory | DONE (doc 01) |
| 2 | Architecture reconstruction | DONE (doc 02) |
| 3 | Feature-by-feature reverse engineering | DONE (doc 03, F1–F24) |
| 4 | AI & agent systems deep dive | DONE (doc 04) |
| 5 | Integrations & connectivity | DONE (doc 05) |
| 6 | Data model & lifecycle | DONE (doc 06) |
| 7 | API / events / contracts | DONE (doc 07) |
| 8 | Frontend / UX / design system | DONE (doc 08) |
| 9 | Security & reliability audit | DONE (doc 09, SEC-1..11 + REL-1..7) |
| 10 | Testing / build / deployment | DONE (doc 10) |
| 11 | Implementation status & tech debt | DONE (doc 11) |
| 12 | Source-level knowledge map | DONE (doc 12) |
| D | Write 17 dossier documents | DONE |
| V | Validation pass + final report | DONE |

## Deliverables checklist (all non-empty, sizes verified at write time)
- [x] 00-executive-overview.md (8754 B)
- [x] 01-repository-map.md (8914 B)
- [x] 02-system-architecture.md (12437 B)
- [x] 03-feature-catalog.md (13554 B)
- [x] 04-ai-and-agent-systems.md (12844 B)
- [x] 05-integrations.md (10300 B)
- [x] 06-data-model-and-lifecycle.md (12571 B)
- [x] 07-api-and-events.md (10232 B)
- [x] 08-frontend-and-design-system.md (7113 B)
- [x] 09-security-and-reliability.md (11311 B)
- [x] 10-testing-build-deployment.md (13480 B)
- [x] 11-implementation-status-and-technical-debt.md (10684 B)
- [x] 12-developer-task-map.md (9892 B)
- [x] 13-glossary-and-domain-model.md (8962 B)
- [x] 14-open-questions-and-unknowns.md (9419 B)
- [x] 15-master-codebase-context.md (7936 B)
- [x] CODEBASE_INTELLIGENCE_INDEX.md (5768 B)

## Areas inspected (running log, condensed)
- Instructions/docs: `axle-desktop/source/AGENTS.md`, `axle-landing/AGENTS.md`, `CLAUDE.md` (pointer), root + source `README.md`, `AXLE_IMPLEMENTATION.md`, `docs/axle-architecture.md`, `docs/axle-configuration.md`.
- Manifests: root `Cargo.toml` (10 crates, v1.1.22), `pnpm-workspace.yaml` (catalog pins, alchemy stub, 14 patches), `package.json` scripts (`package.json:7-43`), per-app package.json files, `infra/relay` package + drizzle, `axle-download-worker`, mobile.
- Rust: agent loop `loop_runner.rs`, tools (`registry.rs`, `bash.rs`, `write.rs`, `edit.rs`, `mcp.rs`, `path_guard.rs`, `execution.rs`), sessions (`manager.rs`, `engine.rs`), prompt (`builder.rs`), config (`axle_config`), memory (`axle_memory`).
- TS server: `ws.ts` (method table + handlers), `http.ts` (routes, OTLP proxy), `httpCors.ts`, `startupAccess.ts`, `AxleAdapter.ts`, `schedules/Service.ts`, `terminal/Manager.ts`, `McpHttpServer.ts`, `serverLogger.ts`, migrations `001–032` (+ migration tests).
- Contracts: `orchestration.ts` (WS methods, policies, ModelSelection, commands, events, duplicated shell block), `auth.ts` (scopes), `schedules.ts`; 47 module names listed.
- Web: routes (10 top-level + settings children), `AppRoot.tsx:17-30`, `index.css:204-283` tokens, state/hooks/connection/lib directory inventories.
- Desktop: launcher home layout (`launcher.ts:41-58`), preload bundle markers.
- Infra/CI: root `.github/workflows` (6) + nested source workflows (10, incl. `ci.yml`, `release.yml`), `scripts/` (build artifact, dev-runner, update manifests, release smoke, mock update server, mobile checks), `.circleci` presence, `infra/relay` deploy script.
- Tests/typecheck runs recorded in docs 10–11 (same tree, same machine, earlier in mission).

## Unresolved questions (final register)
All open items now live in `14-open-questions-and-unknowns.md` (Q1–Q22; Q7 resolved 2026-10-18), including: canonical release repo; UI-redesign release intent; version drift cause; alchemy stub fidelity; `stream_parser.rs` per-provider formats; web WS reconnect policy; analytics privacy; rate limiting; orphan process reaping; SQLite journaling/busy timeout; per-turn caps; scope↔method coverage; a11y; mobile E2E; relay deployment state; other infra surfaces + `.circleci`; download worker runtime; account-api role; Windows test-failure reality; instruction/skill discovery precedence.

## Method notes / lessons
- `rg` on Windows PowerShell: exclude `-g "!node_modules" -g "!target" -g "!.git" -g "!.next"`; list `.rs` files explicitly (PowerShell globs don't expand in rg paths).
- Large files written via single-quoted here-strings with `Set-Content -Encoding utf8`; verify byte size after each write.
- No secrets were read or recorded at any point; secrets-store paths referenced by name only.
