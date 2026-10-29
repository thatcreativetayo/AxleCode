# Cloud execution

Axle Cloud jobs are long-running agent runs that execute on independent **worker hosts** — machines operated by you (or a cloud provider you choose), not by the desktop app. Desktop, mobile, and web clients only talk to the Axle **control plane** (the account API); workers claim jobs from the control plane, run the `axle` CLI on the worker, and report state back. Nothing about a job depends on a user's machine staying online.

## Architecture

```
client (desktop / mobile / web)
  |  POST /v1/cloud/jobs                     create job (prompt, repo, provider, model)
  |  GET  /v1/cloud/jobs/{jobId}             poll state + result summary
  |  GET  /v1/cloud/jobs/{jobId}/events      event log (cursor paginated)
  |  POST /v1/cloud/jobs/{jobId}/responses   answer approval / input requests
  |  POST /v1/cloud/jobs/{jobId}/cancel      request cancellation
  v
control plane (apps/account-api)
  |  timer (30s Node / `* * * * *` cron)  dispatch due schedules as full-access jobs
  |  POST /v1/cloud-workers/{environmentId}/claim
  |  POST /v1/cloud-workers/{environmentId}/recover
  |  POST /v1/cloud-workers/{environmentId}/jobs/{jobId}/heartbeat
  |  POST /v1/cloud-workers/{environmentId}/jobs/{jobId}/update
  v
worker (apps/cloud-worker)
  |  git clone (https-only, credential-free) -> workspace
  |  spawn `axle --prompt-stdin --json-stream --runtime-mode approval-required|full-access ...`
  |  relay approvals through the approval file (interactive jobs only)
  `- upload artifacts -> jobs/{jobId}/{kind}/{name}
```

| Piece                            | Where                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| Job / lease / update contracts   | `packages/contracts/src/cloudJobs.ts`                                                      |
| Schedule contracts               | `packages/contracts/src/cloudSchedules.ts`                                                 |
| Control-plane routes             | `apps/account-api/src/cloudHandler.ts`                                                     |
| Job persistence                  | `apps/account-api/src/cloudStore.ts`, `apps/account-api/src/cloudMongo.ts` (MongoDB)       |
| Schedule persistence + dispatch  | `apps/account-api/src/cloudScheduleStore.ts`, `cloudScheduleRunner.ts`, `cloudRevision.ts` |
| Schedule timing                  | `packages/shared/src/scheduleTiming.ts`                                                    |
| Operator config (control plane)  | `apps/account-api/src/cloudConfig.ts` (`AXLE_CLOUD_CONFIG`)                                |
| Worker                           | `apps/cloud-worker` (`@axle/cloud-worker`)                                                 |
| CLI runtime mode + approval file | `crates/axle_cli/src/main.rs`, `crates/axle_agent/src/loop_runner.rs`                      |

## Job lifecycle

```
provisioning --+--> running --+--> waiting_for_approval --+
               |             +--> waiting_for_input ------+
               |             +--> finalizing --> completed
               |             +--> failed
               |             `--> cancelled
               +--> failed
               `--> cancelled
```

Invariants enforced by the control plane:

- `completed` requires the worker's reported `result.sourceRevision` to equal the job's `input.sourceRevision` — a job only completes when the agent's work actually landed on the source revision the job started from.
- `waiting_for_approval` and `waiting_for_input` never accept a same-state update; they move only when the worker reports progress or the user answers.
- A same-state update without an `event` is rejected as invalid.
- `update` requires the `commandId` from the current lease; stale commands are rejected.
- Heartbeats carry the lease; a lost lease halts the worker (`lease_lost`).

## Control-plane API

### Worker routes

All worker requests are `POST`, authenticated with `Authorization: Bearer <workerToken>` and a body containing `workerId` (timing-safe token comparison); the worker must be listed for the environment or the request is `403 forbidden`.

| Route                                                      | Purpose                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/v1/cloud-workers/{environmentId}/claim`                  | Claim the next queued job. `200` with a lease, or `204` when there is no work. |
| `/v1/cloud-workers/{environmentId}/recover`                | Reclaim this worker's leased job after a worker restart.                       |
| `/v1/cloud-workers/{environmentId}/jobs/{jobId}/heartbeat` | Extend the lease while the job runs.                                           |
| `/v1/cloud-workers/{environmentId}/jobs/{jobId}/update`    | Report a state transition / event. Requires `commandId`.                       |

### Client routes

Authenticated with the user's session; `cloud_access_denied` (403) when the user is not in `allowedUserIds`.

| Route                                             | Purpose                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `GET /v1/cloud/environments`                      | Environments and their allowed provider/model pairs for client forms. |
| `POST /v1/cloud/jobs`                             | Create a job (`201` created, `200` idempotent replay).                |
| `GET /v1/cloud/jobs`                              | List the user's jobs.                                                 |
| `GET /v1/cloud/jobs/{jobId}`                      | Current job state and result summary.                                 |
| `GET /v1/cloud/jobs/{jobId}/events?after=&limit=` | Event log (cursor paginated; default 200, max 500).                   |
| `POST /v1/cloud/jobs/{jobId}/responses`           | Answer an approval or input request.                                  |
| `POST /v1/cloud/jobs/{jobId}/cancel`              | Request cancellation.                                                 |
| `GET /v1/cloud/schedules`                         | List the caller's schedules.                                          |
| `POST /v1/cloud/schedules`                        | Create or update a schedule (upsert by `scheduleId`).                 |
| `DELETE /v1/cloud/schedules/{scheduleId}`         | Delete a schedule; returns `{ deleted }`.                             |
| `GET /v1/cloud/schedules/{scheduleId}/runs`       | Jobs dispatched by the schedule, newest first.                        |
| `POST /v1/cloud/schedules/{scheduleId}/run`       | Dispatch a manual run now.                                            |

`POST /v1/cloud/jobs` also accepts a branch, tag, or commit as `sourceRevision`. Branch and tag
refs are resolved to a pinned commit through the control plane before the job is persisted, so a
worker always checks out an immutable commit. Repositories outside `github.com` must send a full
commit id.

### Cloud schedules

A cloud schedule is self-contained: it stores the repository, branch, prompt, provider/model, and timing — not a reference to a local thread. The control plane owns it, so runs fire and settle with no IDE or desktop process open. Each run clones the pushed repository state on a worker; uncommitted local work never reaches a scheduled run.

- **Timing** — `hourly`, `daily` (`time` + IANA `timezone`), `weekly` (`weekday` + `time` + `timezone`), or `once` (`runAt`). `nextRunAt` is computed from the schedule, and inactive schedules have `nextRunAt: null`.
- **Full-access execution** — scheduled jobs are dispatched with `runtimeMode: "full-access"`, so the CLI runs without an approval file and no approval round trip. Creating the schedule is the consent; interactive jobs remain `approval-required`.
- **Revision pinning** — a 40/64-character hex `sourceRef` is used as-is. Branch and tag names are resolved to a commit through the GitHub commits API at dispatch time. Branch and tag names are resolved to a commit through the GitHub commits API at dispatch time (`AXLE_GITHUB_TOKEN` raises rate limits and is required for private-repository metadata, though clones stay credential-free). Repositories on other hosts must pin a commit id.
- **Dispatch** — the control plane checks for due schedules at startup and every 30 seconds; the Cloudflare worker additionally runs the `* * * * *` cron. A slot is claimed with a compare-and-swap on `nextRunAt` before dispatch, so multiple timers never double-run a slot. Slots missed while the control plane is offline are skipped, not backfilled.
- **Runs** — dispatched jobs carry `scheduleId` and appear under `/runs`. Scheduled command ids derive from `scheduleId` + slot, making dispatch retries idempotent; manual runs use a unique command id.
- **Limits** — creating schedules requires `cloudJobsEnabled` (`cloud_not_entitled`) and membership in `allowedUserIds`; active schedules are capped by the plan's `scheduledTasksMax` (`schedule_limit_reached`).

### Errors

| Error                                                   | Status |
| ------------------------------------------------------- | ------ |
| `cloud_not_configured`                                  | 503    |
| `unauthorized`                                          | 401    |
| `forbidden`, `cloud_access_denied`                      | 403    |
| `cloud_not_entitled`                                    | 403    |
| `insufficient_credits`, `credit_account_missing`        | 402    |
| `not_found`                                             | 404    |
| `invalid_*`                                             | 400    |
| `environment_unavailable`, `model_unavailable`          | 422    |
| `capacity_exceeded`, `event_limit_exceeded`             | 429    |
| `source_revision_unavailable`, `schedule_limit_reached` | 409    |
| any other `CloudJobError` code                          | 409    |
| `internal_error`                                        | 500    |

## Worker configuration

`AXLE_CLOUD_WORKER_CONFIG` (JSON string) or `AXLE_CLOUD_WORKER_CONFIG_FILE` (path to a JSON file). Both are read once at startup; the raw value is never logged.

| Field                 | Required | Default | Notes                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `controlPlaneUrl`     | yes      | —       | `http(s)`, no credentials in the URL; trailing slashes stripped.                                                                                                                                                                                                                                                                              |
| `workerId`            | yes      | —       | `[A-Za-z0-9][A-Za-z0-9_-]*`, at most 128 chars; must match the control plane's `workers[].workerId`.                                                                                                                                                                                                                                          |
| `workerToken`         | yes      | —       | 32-256 chars; must match `workers[].token`.                                                                                                                                                                                                                                                                                                   |
| `environmentIds`      | yes      | —       | Non-empty, unique; environments the worker is bound to on the control plane.                                                                                                                                                                                                                                                                  |
| `workspaceRoot`       | yes      | —       | Where per-job clones are created.                                                                                                                                                                                                                                                                                                             |
| `artifactRoot`        | yes      | —       | Artifact store root (`jobs/{jobId}/...`).                                                                                                                                                                                                                                                                                                     |
| `agentBinary`         | no       | `axle`  | Path/name of the CLI binary to spawn.                                                                                                                                                                                                                                                                                                         |
| `agentEnv`            | no       | `{}`    | Extra environment variables for the agent process.                                                                                                                                                                                                                                                                                            |
| `providers`           | yes      | —       | Non-empty array of `{ providerInstanceId, provider, apiKeyEnv?, baseUrl? }`. `provider` is one of `openai`, `anthropic`, `gemini`, `fireworks`, `ollama-cloud`, `cerebras`, `groq`, `openrouter`, `mistral`, `deepseek`, `xai`, `ollama`. `apiKeyEnv` is required unless the provider is `ollama`; `baseUrl` overrides the provider endpoint. |
| `pollIntervalMs`      | no       | `3000`  | 250-60000.                                                                                                                                                                                                                                                                                                                                    |
| `heartbeatIntervalMs` | no       | `10000` | 1000-120000.                                                                                                                                                                                                                                                                                                                                  |
| `shutdownGraceMs`     | no       | `30000` | 1000-600000; time in-flight jobs get to wind down on SIGINT/SIGTERM.                                                                                                                                                                                                                                                                          |
| `maxConcurrentJobs`   | no       | `4`     | 1-100.                                                                                                                                                                                                                                                                                                                                        |
| `keepWorkspaces`      | no       | `true`  | Keep job workspaces after completion for inspection.                                                                                                                                                                                                                                                                                          |

Example — see also `apps/cloud-worker/.env.example`:

```json
{
  "controlPlaneUrl": "https://accounts.example.com",
  "workerId": "worker-1",
  "workerToken": "replace-with-a-32-plus-character-token",
  "environmentIds": ["linux-standard"],
  "workspaceRoot": "/var/lib/axle-cloud/work",
  "artifactRoot": "/var/lib/axle-cloud/artifacts",
  "providers": [
    {
      "providerInstanceId": "anthropic-default",
      "provider": "anthropic",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    }
  ]
}
```

Provider credentials live only in the worker host environment (e.g. `ANTHROPIC_API_KEY`) and are passed to the agent process for the provider the claimed job selected. They never transit the control plane.

## Control-plane configuration

`AXLE_CLOUD_CONFIG` on the account API (JSON string). When absent, every cloud route reports `cloud_not_configured` (503). Do not announce a runner or paid entitlement until this configuration and billing are actually enabled.

| Field                  | Notes                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `environments[]`       | `{ environmentId, repositoryHosts[], providerModels[{ providerInstanceId, model }], maxConcurrentJobs (1-100), limits }`. `repositoryHosts` are DNS names (no `.localhost`); `limits` = `{ maxDurationSeconds <= 86400, maxEvents 10-10000, cpuMillis <= 32000, memoryMb <= 65536, diskMb <= 1048576 }`, with `maxDurationSeconds >= leaseSeconds`. |
| `workers[]`            | `{ workerId, token (32-256), environmentIds[] }`. Worker ids and tokens must be unique and a worker's environments must exist.                                                                                                                                                                                                                      |
| `allowedUserIds[]`     | Non-empty; only these users can create jobs or answer requests.                                                                                                                                                                                                                                                                                     |
| `maxActiveJobsPerUser` | 1-100.                                                                                                                                                                                                                                                                                                                                              |
| `leaseSeconds`         | 15-300.                                                                                                                                                                                                                                                                                                                                             |

## Billing and credits

`AXLE_BILLING_CONFIG` on the account API (JSON string). When absent, cloud jobs are unmetered: no reservation is taken and no charge is applied, while `maxActiveJobsPerUser` still applies.

```json
{
  "plans": [
    {
      "planId": "free",
      "cloudJobsEnabled": false,
      "monthlyCredits": 0,
      "maxConcurrentJobs": 1,
      "gatewayCredits": 0
    },
    {
      "planId": "pro",
      "cloudJobsEnabled": true,
      "monthlyCredits": 120,
      "maxConcurrentJobs": 4,
      "gatewayCredits": 2000,
      "features": {
        "scheduledTasksMax": 50,
        "pullRequestReviews": true,
        "teamSharing": false
      }
    },
    {
      "planId": "pro-plus",
      "cloudJobsEnabled": true,
      "monthlyCredits": 300,
      "maxConcurrentJobs": 6,
      "gatewayCredits": 4000
    },
    {
      "planId": "ultra",
      "cloudJobsEnabled": true,
      "monthlyCredits": 1000,
      "maxConcurrentJobs": 8,
      "gatewayCredits": 10000
    }
  ],
  "defaultPlanId": "free",
  "userPlans": { "user-1": "pro" },
  "creditsPerMinute": 3,
  "adminToken": "replace-with-a-32-plus-character-operator-token"
}
```

- `plans[]`: unique plan ids. `cloudJobsEnabled` gates job creation (`cloud_not_entitled`); `monthlyCredits` is granted once per calendar month on first use; `maxConcurrentJobs` caps concurrent work per user (combined with `maxActiveJobsPerUser`, whichever is lower wins).
- `gatewayCredits` (optional per plan): the monthly hosted-provider allowance applied to the gateway's plan balance when the subscription webhook confirms payment. The gateway sets (not adds) this bucket per subscription month; Free keeps the gateway's 100/day grant instead.
- `features` (optional per plan): advisory gates for client surfaces, resolved server-side and exposed through `GET /v1/cloud/billing` as `account.entitlements`. Plans that omit `features` fall back to the closed baseline `{ scheduledTasksMax: 2, pullRequestReviews: false, teamSharing: false }`. `entitlements` is `null` on unmetered deployments, which clients treat as everything unlocked — only a positively resolved plan may gate a feature.
- `defaultPlanId`: plan for users without an explicit assignment.
- `userPlans`: optional per-user overrides; values must reference a configured plan.
- `creditsPerMinute`: reservation and settlement rate. Set 0 to keep plans and accounting while charging nothing.
- `adminToken`: optional operator credential (32-256 chars) for credit grants.

Plan precedence is `userPlans` → active paid subscription recorded from the payment webhook → `defaultPlanId`. Only a plan id present in `plans[]` can grant entitlements, so a stale subscription cannot widen access.

Ledger policy — accounting runs in the same database transaction as the job state change:

1. **Reserve** — job creation reserves `ceil(maxDurationSeconds / 60) * creditsPerMinute`; creation fails with `insufficient_credits` (402) when the balance cannot cover it, and `credit_account_missing` (402) for an account without a balance record. The client never supplies its plan, balance, or limits; the server resolves them from configuration.
2. **Meter** — the metered window starts at the first worker claim.
3. **Settle** — on a terminal state the charge is `ceil(runtimeMinutes) * creditsPerMinute`, capped by the reservation, and the remainder is released. Jobs cancelled before any worker claimed them are released in full. Settlement is idempotent.
4. **Grants** — `POST /v1/cloud/credits/grant` with the `x-axle-admin` header requires the configured `adminToken` (403 otherwise) and a body `{ userId, entryId, amount, note? }`; `entryId` makes retries idempotent.

Routes: `GET /v1/cloud/billing` returns the caller's `{ account: { planId, balance, updatedAt, entitlements }, entries[] }` with the 50 most recent ledger entries.

### Self-serve checkout (Bachs)

Paid plans and credit packs are sold through [Bachs](https://app.bachs.io/developer) hosted checkout. Products are configured by id: `AXLE_PRO_BACHS_PRODUCT_ID`, `AXLE_PRO_PLUS_BACHS_PRODUCT_ID` (legacy fallback `AXLE_TEAM_BACHS_PRODUCT_ID`), `AXLE_ULTRA_BACHS_PRODUCT_ID`, and `AXLE_CREDITS_BACHS_PRODUCT_ID`. Checkout is disabled (`billing_not_configured`, 503) until `AXLE_BACHS_API_KEY` and the ids needed for the requested flow are set; credit packs also require the gateway to be configured. The API base URL is derived from the key prefix (`sk_sandbox_...` → `https://sandbox-api.bachs.io`, `sk_live_...` → `https://api.bachs.io`) and can be overridden with `AXLE_BACHS_API_URL`. Optional: `AXLE_BACHS_SUCCESS_URL`, `AXLE_BACHS_CANCEL_URL`, `AXLE_BACHS_PAYMENT_METHOD_TYPES` (comma-separated), and `AXLE_BACHS_WEBHOOK_SECRET` (`whsec_...`) for webhook verification.

- `POST /v1/billing/checkout` (session-authenticated): body `{ plan: "pro" | "pro-plus" | "ultra", email?, seats? }` (seats 1-100, default 1) for subscriptions, or `{ plan: "credits", usd, email? }` for a one-time top-up. `usd` must be a whole number of cents between $5 and $500 and is priced ad hoc on the "Axle Credits" product (`price_type: fixed`). Creates a Bachs checkout session bound to the authenticated user via metadata and returns `{ checkoutId, checkoutUrl }`. Subscription plans must also exist in `AXLE_BILLING_CONFIG.plans[]` so a sold plan always resolves entitlements; provider failures map to `billing_provider_error` (502).
- `POST /v1/billing/webhook` (public, the only unauthenticated route): verified against the raw body with HMAC-SHA256 over `{timestamp}.{raw_body}` (`X-Bachs-Signature-V2` `t=...,v1=...`, or the legacy `X-Bachs-Timestamp` + `X-Bachs-Signature` pair), 300-second replay tolerance, multi-`v1` accepted for secret rotation. Invalid deliveries return `invalid_signature` (401). `collection.succeeded` is fulfilled before acknowledgement: a `credits` purpose purchase credits the gateway's **paid** bucket with `usd × 200` credits (the payment event id is the idempotency reference); a subscription payment applies the plan's `gatewayCredits` to the gateway's **plan** bucket and activates the subscription. Duplicate event ids and unrelated event types are acknowledged idempotently. Register the deployed URL plus `/v1/billing/webhook` in the Bachs dashboard and set `AXLE_BACHS_WEBHOOK_SECRET` to that endpoint's signing secret. Delivery failures must be 5xx so Bachs redelivers instead of losing a paid top-up.
- `GET /v1/billing/plan?user_id=...` (internal): authenticated with `Authorization: Bearer <AXLE_INTERNAL_TOKEN>` (timing-safe compare, 401 `invalid_internal_token` otherwise) and returns `{ planId, paid, entitlements }`. This is what the hosted-provider gateway calls to gate paid models; `paid` is true only for `pro`, `pro-plus`, and `ultra`.

Gateway credit application goes through the gateway's `POST /v1/internal/credits` route with `{ user_id, amount, bucket: "paid" | "plan", reference }` (`AXLE_GATEWAY_INTERNAL_URL` is the gateway origin, no `/v1` suffix; the same shared token is set as the gateway's `INTERNAL_API_TOKEN`).

Subscriptions live in the `axle_billing_subscriptions` collection with the applied-event log in `axle_billing_events` (`src/cloudMongo.ts`).

## Agent process contract

The worker spawns the CLI with:

```
axle --prompt-stdin --json-stream --runtime-mode approval-required|full-access \
     [--approval-file <staging>/approval.ndjson --approval-timeout-seconds <n>] \
     --provider <kind> --model <model> --cwd <workspace> \
     --interaction-mode build|plan [--base-url <url>]
```

- Interactive jobs run `approval-required` and carry the approval file; scheduled jobs (job `runtimeMode: "full-access"`) omit approval flags entirely, so the agent completes writes without waiting on a control-plane response.
- The prompt is written to stdin; stdout is parsed as NDJSON (non-JSON and array lines are skipped; oversized lines are dropped).
- Approval requests stream back as events; the worker appends decisions to the approval file:

  ```json
  { "type": "approval_response", "requestId": "<cli request id>", "decision": "allow" }
  ```

  The CLI polls the file every 150 ms. Anything unrecognised is **denied** — approvals default to deny.

- Cancellation: the worker sends `SIGTERM` and waits `shutdownGraceMs`; the job settles as `cancelled`.
- A non-zero agent exit fails the job as `runtime_failed`; a provisioning failure fails it as `provisioning_failed`, and an agent that exits while an approval is pending is held open until the request settles.

## Security model

- **Repositories**: clone URLs must be https and their host must be listed in the environment's `repositoryHosts`; clones run credential-free (`GIT_CONFIG_NOSYSTEM=1`, no credential helpers), so a worker cannot leak user tokens and a job cannot fetch anything the environment does not allow.
- **Workspaces**: one clone per job under `workspaceRoot`; nothing is shared between jobs.
- **Approvals**: default-deny; the worker only writes an allow when the user, through the control plane, allows that exact request id. Jobs with `runtimeMode: "full-access"` run without an approval file at all — scheduled runs rely on this, and creating the schedule is treated as consent.
- **Pushed code only**: scheduled runs clone the repository at the resolved commit, so only pushed work is visible; local uncommitted changes never reach a scheduled run.
- **Artifacts**: storage keys are confined to `jobs/{jobId}/{kind}/{name}` and validated against traversal; writes over the store's byte limit (default 100 MB) are rejected.
- **Credentials**: the worker token is compared with a timing-safe hash and never logged; invalid config errors never echo the raw configuration.
- **Observability**: logs never include prompts, worker capabilities, or DB error details.

## Limitations

- The control plane stores only artifact **manifests** (kind, `storageKey`, `sha256`, `sizeBytes`); artifact bytes stay on worker storage and are fetched out of band.
- One job is leased to one worker at a time; `recover` exists for worker restarts, not for parallel execution of the same job.
- Per-environment `maxConcurrentJobs`, lease duration, and per-job limits are enforced; a job that exceeds `maxDurationSeconds` is failed.
- Workers are operator-run: the product makes no claim of a default public runner.
