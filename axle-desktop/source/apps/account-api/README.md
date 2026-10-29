# Axle account API

This service owns the application-specific account/profile/device/usage data in MongoDB (MongoDB
Atlas in production). The API verifies Clerk JWTs, with a legacy Neon Auth configuration fallback,
and never receives the database connection string from a browser.

Required environment variables:

- `MONGODB_URI` — server-only MongoDB connection string (`mongodb+srv://…`); a replica set is
  required for the transactional cloud-job ledger.
- `CLERK_ISSUER`; `CLERK_JWKS_URL` and `CLERK_AUDIENCE` are optional.

Existing deployments can instead supply all three legacy variables: `NEON_AUTH_JWKS_URL`,
`NEON_AUTH_ISSUER`, and `NEON_AUTH_AUDIENCE`.

Optional: `HOST`, `PORT`, and `AXLE_ACCOUNT_CORS_ORIGIN`.

Run locally with `pnpm --filter @axle/account-api dev`. The service automatically loads the gitignored
`apps/account-api/.env.local` file; use a development database connection for local verification.
Startup ensures every collection index idempotently (`src/mongo.ts`); collections are schema-on-use,
so a fresh database needs no separate schema step.

Device identifiers and session identifiers retain their original account owner. A conflicting or
revoked device registration returns HTTP 409 without returning the existing record. Repeated
registration by its active owner updates that record and preserves omitted metadata. An atomic
session upsert rejects a revoked or differently owned session with HTTP 401 before any protected
account route runs; ordinary traffic cannot clear a revocation marker. No schema migration is needed
for these checks.

The service does not yet expose device/session revocation endpoints or synchronize identity-provider
revocations. Database session revocation applies when the verified token includes `sid`, `sessionId`,
or `session_id`; legacy verified tokens without a session claim still rely on JWT validation and
expiry. Device registration is inventory, not an authorization entitlement, and devices are not yet
bound to account sessions.

Usage events remain authenticated, client-reported telemetry. Their aggregation is atomic and
deduplicates `(userId, eventId)`, but token counts and costs are not authoritative billing values.
Cloud-job credits are a separate, server-owned ledger (`src/cloudMongo.ts`). Bachs checkout and
subscription webhooks are handled under `/v1/billing/*`; credits purchased there and the monthly
plan allowance are applied to the hosted provider gateway's own balance through its internal credit
route (`src/gateway.ts`), which stays authoritative for model spend.

Focused verification from the monorepo directory:

```sh
vp test run apps/account-api/src/handler.test.ts apps/account-api/src/config.test.ts
```

The ownership tests exercise the real upsert predicates against an in-process
`mongodb-memory-server` instance. They cover cross-account conflicts, repeated registration, revoked
requests across all protected routes, and active sessions without requiring credentials or a server.
The cloud-job suite (`src/cloudMongo.integration.test.ts`) runs a single-node replica set so
transactions, lease fencing, and the credit ledger are exercised for real. Live Atlas behavior and
real Clerk/Neon JWT verification require a configured test deployment and are not covered by these
suites.

## Cloudflare Worker deployment

`src/worker.ts` reuses the same request handlers as the Node server and deploys as the
`axle-account` Worker (`wrangler.jsonc`). The MongoDB driver runs on Workers via `nodejs_compat`,
so there are no bundled migration files; configuration comes from Worker bindings instead of files.

From the repository root:

```sh
pnpm --filter @axle/account-api exec wrangler deploy --dry-run --outdir dist   # bundle check
pnpm --filter @axle/account-api exec wrangler deploy
```

Set the runtime secrets once per environment (values from the production GitHub environment):

```sh
wrangler secret put MONGODB_URI
wrangler secret put CLERK_ISSUER
wrangler secret put CLERK_JWKS_URL
wrangler secret put CLERK_AUDIENCE
wrangler secret put AXLE_CLOUD_CONFIG            # JSON from docs/cloud-execution.md
wrangler secret put AXLE_GITHUB_TOKEN            # optional: resolves branch/tag job sources on GitHub
wrangler secret put AXLE_BILLING_CONFIG
wrangler secret put AXLE_BACHS_API_KEY
wrangler secret put AXLE_PRO_BACHS_PRODUCT_ID
wrangler secret put AXLE_PRO_PLUS_BACHS_PRODUCT_ID
wrangler secret put AXLE_ULTRA_BACHS_PRODUCT_ID
wrangler secret put AXLE_CREDITS_BACHS_PRODUCT_ID
wrangler secret put AXLE_BACHS_WEBHOOK_SECRET
wrangler secret put AXLE_GATEWAY_INTERNAL_URL    # gateway origin, no /v1 suffix
wrangler secret put AXLE_INTERNAL_TOKEN          # same value as the gateway's INTERNAL_API_TOKEN
```

`AXLE_TEAM_BACHS_PRODUCT_ID` remains supported as the legacy name for the Pro+ product when
`AXLE_PRO_PLUS_BACHS_PRODUCT_ID` is unset.

The worker reaches the gateway (credit grants) and the auth worker (JWKS) through the
`AXLE_GATEWAY_SERVICE` and `AXLE_AUTH_SERVICE` service bindings in `wrangler.jsonc`. They are
required in production: same-zone worker-to-worker `fetch()` fails with Cloudflare error 1042.
Set up the same binding on the gateway as `ACCOUNT_API_SERVICE` so its plan checks work too.

Non-secret vars (`AXLE_ACCOUNT_CORS_ORIGIN`, optional Bachs redirect/corridor settings) live in
`wrangler.jsonc`. The deployed URL is `https://axle-account.<workers.dev subdomain>`; set the
repository `AXLE_ACCOUNT_API_URL` Actions variable (consumed by release builds as
`VITE_ACCOUNT_API_URL`) to it. The Bachs webhook endpoint is
`https://axle-account.<workers.dev subdomain>/v1/billing/webhook`.

Index creation runs lazily on the first request in each Worker isolate; `createIndex` is idempotent,
so cold starts are safe to repeat.
