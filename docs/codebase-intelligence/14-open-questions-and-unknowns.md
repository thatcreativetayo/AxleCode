# 14 — Open Questions & Unknowns

> These are the things this audit could **not** settle from source alone — each with what is known, why it matters, and the cheapest experiment that would resolve it. Ordered by blast radius.
> An honest dossier lists its blind spots; treat this as the mission's debt.

## Q1 — What is the canonical repository/release home? ⭐ highest impact
**Known [V]:** README points to `thatcreativetayo/AxleCode`; `apps/server/package.json` repository field points to `pingdotgg/t3code`; root CI workflows (`build-macos.yml`, `axle-*`) live at the Axle repo root but reference `axle-desktop/source` paths, while the *real* gate workflow (`ci.yml`, `release.yml`, `deploy-relay.yml`) is nested under `axle-desktop/source/.github/workflows/` — as if that directory is (or was) its own repo. `scripts/sync-reference-repos.ts` suggests upstream reference repos also exist.
**Why it matters:** every release/update/CI fix depends on which repo is authoritative. The frozen updater contracts (`latest.yml`, `/get/updates/*`) must point somewhere specific.
**Resolve by:** checking `git -C axle-desktop/source remote -v` (if it is a nested/nested-ignored git dir), plus the GitHub org settings for the three candidate names.

## Q2 — Is the uncommitted UI redesign intended for the next release?
**Known [V]:** 154 modified + 8 untracked files (mostly `apps/web`) + `ui-redesign-*.md` design notes dated 2026-10-13. Not authored by this mission. Typecheck of packages passed at `HEAD` earlier; the WIP's own state was not validated.
**Why it matters:** any build/screenshot/QA measurement on this working tree may be measuring the WIP, not `HEAD`; release cut from this machine would ship it accidentally.
**Resolve by:** asking the author; or `git stash` and re-measure to compare.

## Q3 — Why do versions drift (1.1.22 vs 1.1.23 vs ~1.1.15 vs 0.0.29)?
**Known [V]:** Rust+TS core at 1.1.22; README references v1.1.23; `axle-download-worker` ~1.1.15; analytics 0.0.29.
**Why it matters:** updater decision logic (version compare) can loop or skip releases if feeds disagree with app versions.
**Resolve by:** finding the release procedure doc (if any) and `scripts/update-release-package-versions.ts` usage; verifying feed JSON from the update portal.

## Q4 — Does the `alchemy` stub faithfully stand in for the real SDK?
**Known [V]:** `pnpm-workspace.yaml` overrides `alchemy` → `file:stubs/alchemy-stub`. Deploy paths import it. Stub's surface was not compared to the real package.
**Why it matters:** relay/infra deploys via Alchemy may be silently broken or untested in-repo.
**Resolve by:** diff stub exports vs the pinned real version's types; run relay deploy in a dev account.

## Q5 — `stream_parser.rs`: which per-provider wire formats are supported?
**Known [V]:** the file exists and parses provider streams into NDJSON events; provider set is multi-model (doc 05). Exact per-provider framing (OpenAI-style SSE vs Anthropic-style events vs others) was not traced line-by-line.
**Why it matters:** adding a model provider without parser support fails at runtime, not compile time.
**Resolve by:** read `stream_parser.rs` fully + its tests; build the provider matrix table.

## Q6 — Codex OAuth token storage — RESOLVED by removal (2026-10-25)
The ChatGPT-plan OAuth provider, its login routes, and its token-storage path were removed from the product, so this question is no longer applicable.

## Q7 — MCP tokens: rotation, scoping, revocation? — RESOLVED 2026-10-18
**Resolved [V]** (evidence: SEC-10 in doc 09): `McpSessionRegistry.ts` issues a fresh 32-byte credential per provider launch, stores only its SHA-256 hash, scopes it to one environment/thread/provider-session (plus cwd, auth session, plugin token, `preview` capability), expires it after 30 min idle or 8 h max, and revokes it on teardown/logout. Registry is in-memory (restart drops all) and there is no in-place rotation by design. Residual exposure is token presence in the child env (SEC-2), not scoping.

## Q8 — Web WS reconnect/backoff policy?
**Known [V]:** client connection layer exists (`apps/web/src/connection/`); reconnect behavior under server drop not exercised.
**Why it matters:** user-facing reliability; duplicated turns if reconnection replays commands.
**Resolve by:** kill the server mid-turn and observe; read the reconnect code path.

## Q9 — Analytics: what is collected, where does it go, can it be disabled?
**Known [V]:** Convex-backed analytics package exists (0.0.29). Data model/privacy posture not read ([U]).
**Why it matters:** privacy claims, compliance, enterprise objections.
**Resolve by:** read the analytics package's event list and the consent/disable path.

## Q10 — Rate limiting anywhere?
**Known [V]:** none found on server HTTP/WS or relay endpoints during this pass; CORS/DPoP/scopes are the only gates observed.
**Why it matters:** DoS and credential-stuffing surface, especially on relay (internet-facing).
**Resolve by:** grep for limiter/throttle utilities across `apps/server`, `infra/relay`, workers.

## Q11 — Orphan process reaping after a server crash?
**Known [V]:** tool subprocesses are spawned by the agent; server manages lifecycle. Behavior when the server dies without cleanup (children survive?) is [U].
**Why it matters:** zombie dev-servers/dev-servers-port conflicts after crashes — a classic Axle-class product bug.
**Resolve by:** spawn a long-running bash tool, `taskkill` the server, check the tree.

## Q12 — SQLite concurrency settings (journaling, busy timeout)?
**Known [V]:** SQLite is the agent-plane store; single-writer architecture by design [I]. PRAGMA settings (WAL? busy_timeout?) not confirmed.
**Why it matters:** "database is locked" under parallel threads/schedules.
**Resolve by:** open the persistence bootstrap and read pragmas; stress with two concurrent sessions.

## Q13 — Is there a per-turn step/token cap?
**Known [V]:** loop termination conditions exist (`loop_runner.rs:2335-2430`) and compaction manages context. Whether a hard max-steps/max-tokens per turn exists (and its values) is [U].
**Why it matters:** runaway turns burning provider quota.
**Resolve by:** read termination logic; check config keys in `axle-config`.

## Q14 — Scope ↔ WS-method mapping completeness?
**Known [V]:** scopes enumerated `auth.ts:76-83`; WS method list at `orchestration.ts:29-37`; doc 07 maps the observed pairing. A full exhaustive matrix (every method enforced?) was not proven.
**Why it matters:** any unguarded method is an authz hole.
**Resolve by:** enumerate method handlers in `ws.ts` and assert each checks a scope; add a test.

## Q15 — Accessibility posture of the web app?
**Known [V]:** keyboard handling and focus patterns exist (doc 08); no a11y audit, no automated checks found.
**Why it matters:** product quality, eventually procurement.
**Resolve by:** axe/Lighthouse pass on the main routes after WIP settles.

## Q16 — Mobile end-to-end? APNs? 
**Known [V]:** EAS workflows exist (nested); APNs-related relay columns (`bundle_id`, `aps_environment`) exist. No build/run verification ([U]). Apple credentials existence unknown.
**Resolve by:** run EAS preview build; send a test push via relay in dev.

## Q17 — Relay deployed and current?
**Known [V]:** relay source + migrations + deploy script + workflow exist. Actual deployment state, worker version, and whether `deploy-relay.yml` has ever run (nested workflow!) is [U].
**Resolve by:** compare deployed worker version via Cloudflare API/CLI vs repo.

## Q18 — What are the other `infra/*` surfaces and `.circleci/`?
**Known [V]:** `infra/relay` is the only infra child found; `.circleci/` exists at repo root but is legacy (no wiring observed). Whether other infra (Neon, Convex, gateway) is managed elsewhere is [U].
**Resolve by:** inspect `.circleci/config.yml` for dead jobs; search for other IaC references.

## Q19 — Download worker: deployed? tested anywhere real?
**Known [V]:** ~399 LOC worker; tests run only from the dormant installer CI job (`ci/windows-installer-artifact-073adc3` branch trigger).
**Resolve by:** `npm --prefix axle-download-worker test` locally; compare deployed worker against repo.

## Q20 — Any product surfaces in `apps/account-api`? 
**Known [V]:** account-api exists (lint errors live there). Its product role (accounts for what — analytics? plugins? auth broker?) was only partially traced.
**Resolve by:** read account-api routes + its contracts.

## Q21 — Windows-specific test failures: are they real or environment artifacts?
**Known [V]:** VcsStatusBroadcaster test fails with symlink `EPERM` on Windows; GitManager fork-PR tests fail (2). Whether the latter are environment or true defects is [U].
**Resolve by:** run those suites in the (would-be) Linux CI container.

## Q22 — Instruction/skill discovery roots and precedence?
**Known [V]:** instructions + skills loading verified at feature level (doc 03 F20). Exact search roots, precedence, and caching were not exhaustively enumerated.
**Resolve by:** read the loader; write a precedence matrix.

## Methodology note
Every item above is traceable to a specific hole in this audit, not speculation. Where a later reader resolves one, strike it here and record the evidence in the relevant numbered doc — this file is the register of what the dossier does **not** know.
