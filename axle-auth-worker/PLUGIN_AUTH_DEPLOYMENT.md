# Axle plugin auth worker

This Worker owns persistent per-installation plugin authorization for Axle Desktop. Composio is not used. GitHub keeps Axle's existing native desktop OAuth flow; Gmail, Slack, Jira, Notion, Sentry, and Figma use their provider OAuth flows directly through this Worker. Axle account sign-in is not required to create a plugin session or connect a provider; each provider still requires its own authorization.

The desktop renderer receives an opaque, encrypted Axle plugin-session token. When no Axle account session exists, the Worker issues an anonymous session scoped to a stable, random installation ID; session creation and validation are stateless and do not use Cloudflare KV. Provider access/refresh tokens remain encrypted at rest in Cloudflare KV and are never returned to the renderer.

The Worker also hosts `/v1/auth/desktop`, the Axle-owned sign-in surface used by Axle Desktop. Older builds that still request the retired `/v1/clerk/desktop` are redirected there.

## Public client IDs

OAuth client IDs are public values. Put them in `wrangler.toml` under `[vars]`; Wrangler injects them into the Worker deployment:

- `GITHUB_CLIENT_ID`
- `GOOGLE_CLIENT_ID` (desktop sign-in; separate from `GMAIL_CLIENT_ID`, which stays bound to the Gmail plugin)
- `GMAIL_CLIENT_ID`
- `OUTLOOK_CLIENT_ID`
- `SLACK_CLIENT_ID`
- `JIRA_CLIENT_ID`
- `NOTION_CLIENT_ID`
- `SENTRY_CLIENT_ID`
- `FIGMA_CLIENT_ID`
- `CLERK_PUBLISHABLE_KEY`
- `PUBLIC_BASE_URL`, the deployed Worker origin. Today this is
  `https://axle-auth.axle-download-worker.workers.dev`. A custom domain such as
  `https://auth.axle.llc` can replace it once the domain is attached and its DNS
  resolves, but `PUBLIC_BASE_URL` and `AUTH_ISSUER` must stay in sync with the
  origin actually serving the Worker.

Do not put provider client secrets in `wrangler.toml`, Vite variables, the desktop installer, or source control.

Create a KV namespace and configure the `PLUGIN_STORE` binding in `wrangler.toml`.

## Worker secrets

Install provider client secrets directly into the Cloudflare Worker:

```sh
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GMAIL_CLIENT_SECRET
wrangler secret put OUTLOOK_CLIENT_SECRET
wrangler secret put SLACK_CLIENT_SECRET
wrangler secret put JIRA_CLIENT_SECRET
wrangler secret put NOTION_CLIENT_SECRET
wrangler secret put SENTRY_CLIENT_SECRET
wrangler secret put FIGMA_CLIENT_SECRET
wrangler secret put CLERK_SECRET_KEY
wrangler secret put PLUGIN_TOKEN_ENCRYPTION_KEY
wrangler secret put ANALYTICS_ADMIN_TOKEN
wrangler secret put INTERNAL_API_TOKEN
```

`INTERNAL_API_TOKEN` must match the gateway's `INTERNAL_API_TOKEN` (the account API's `AXLE_INTERNAL_TOKEN`); the Worker uses it to read the caller's plan through the `ACCOUNT_API_SERVICE` binding.

`PLUGIN_TOKEN_ENCRYPTION_KEY` must be a base64url-encoded 32-byte random value. It protects provider credentials persisted in `PLUGIN_STORE` and encrypts the stateless desktop session tokens.
`CLERK_SECRET_KEY` is used only by the Worker to mint a fresh short-lived Clerk session JWT from the saved Clerk session when the desktop app relaunches. The encrypted plugin-session token is retained in the desktop app's local profile for 30 days; logout clears that local token. The Clerk secret key is never returned to the desktop renderer.

## OAuth callbacks

Configure each provider application to allow the callback on the deployed Worker origin:

```text
Google sign-in: https://axle-auth.axle-download-worker.workers.dev/v1/auth/callback/google
Gmail:   https://axle-auth.axle-download-worker.workers.dev/v1/plugins/gmail/callback
Slack:   https://axle-auth.axle-download-worker.workers.dev/v1/plugins/slack/callback
Jira:    https://axle-auth.axle-download-worker.workers.dev/v1/plugins/jira/callback
Notion:  https://axle-auth.axle-download-worker.workers.dev/v1/plugins/notion/callback
Sentry:  https://axle-auth.axle-download-worker.workers.dev/v1/plugins/sentry/callback
Figma:   https://axle-auth.axle-download-worker.workers.dev/v1/plugins/figma/callback
```

Do not register callbacks for `auth.axle.llc` (or any other custom domain) until
that origin is attached to the Worker and its DNS resolves.

### Provider app requirements

Rotating a `*_CLIENT_ID` also requires updating the matching provider app. The
Worker can only request scopes the provider app has enabled, and the provider
rejects the authorization before the callback if its app configuration is stale.

- **Slack**: add the Slack callback URL under **OAuth & Permissions → Redirect
  URLs**, add the bot scopes the Worker requests, and install the app to the
  workspace. `redirect_uri did not match any configured URIs` means the callback
  is missing from that list.
- **Jira**: use an Atlassian OAuth 2.0 (3LO) app with the Jira API scopes
  (`read:jira-work`, `write:jira-work`, `read:jira-user`, `offline_access`).
  The authorizing account must have access to a Jira site with admin
  permissions, and a private app must be distributed/installed to that site.
  `Access denied ... requires access to a Jira site` means Atlassian could not
  find a Jira site the account can use with this app.
- **Figma**: use a Figma **OAuth app** (not a plugin app), enable
  `current_user:read`, `file_content:read`, `file_comments:read`, and
  `file_comments:write` under **OAuth scopes**, then publish the app. Scope
  changes only take effect after republishing. `Invalid scopes for app` means a
  requested scope is not enabled on the published app.
- **Notion**: add the callback URL to the public integration's redirect URIs.
- **Sentry**: add the callback URL to the OAuth application; public clients use
  PKCE and have no client secret.
- **Gmail**: add the callback URL to the Google web OAuth client, enable the
  Gmail API, and add the `gmail.modify` and `gmail.send` scopes to the consent
  screen.

Google is the desktop sign-in provider, and Google requires an exact redirect
URI match. The URI must be `${PUBLIC_BASE_URL}/v1/auth/callback/google` for the
deployment, so registering it under an `OAuth client` of type **Web
application** is mandatory — adding the origin under *Authorized JavaScript
origins* is not enough. Until it is registered, `/v1/auth/start?provider=google`
reaches Google and comes back with `redirect_uri_mismatch`. `/v1/auth/providers`
only reports `google` once both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
are set.

GitHub intentionally stays on Axle's existing desktop OAuth flow. Its OAuth App should allow the loopback callback:

```text
http://127.0.0.1/github/oauth/callback
```

The desktop chooses a random loopback port at runtime and imports the resulting GitHub credential into the Worker without exposing it to renderer JavaScript.

## Plan gating

GitHub stays available on the Free plan; every other plugin is gated server-side
by `pluginPlanAllows` (src/index.js). The Worker asks the account API
(`ACCOUNT_API_URL` through the `ACCOUNT_API_SERVICE` binding, authenticated by
`INTERNAL_API_TOKEN`) whether the session's user has a paid plan. Guest sessions
(no Axle account) count as Free. Billing outages and deployments without
`ACCOUNT_API_URL`/`INTERNAL_API_TOKEN` fail open so a paying user is never locked
out. `POST /v1/plugins/:id/authorize` returns
`402 {"code":"plan_required"}` for gated plugins, including the figma route in
`app.js`.

## Clerk application

Create one Clerk application for Axle and enable the sign-in methods you want. Copy its Publishable Key into `CLERK_PUBLISHABLE_KEY`.

In **Clerk Dashboard → Sessions → Customize session token**, add:

```json
{
  "aud": "axle-relay"
}
```

For the separate account API, configure the same Clerk application:

```sh
CLERK_ISSUER=https://<your-clerk-frontend-api-domain>
CLERK_JWKS_URL=https://<your-clerk-frontend-api-domain>/.well-known/jwks.json
CLERK_AUDIENCE=axle-relay
```

The relay currently keeps its historical `NEON_AUTH_*` variable names. Point those variables at Clerk:

```sh
NEON_AUTH_JWKS_URL=https://<your-clerk-frontend-api-domain>/.well-known/jwks.json
NEON_AUTH_ISSUER=https://<your-clerk-frontend-api-domain>
NEON_AUTH_AUDIENCE=axle-relay
```

## Desktop configuration

Source builds need only the Worker origin:

```sh
VITE_AXLE_PLUGIN_WORKER_URL=https://axle-auth.axle-download-worker.workers.dev
AXLE_PLUGIN_WORKER_URL=https://axle-auth.axle-download-worker.workers.dev
```

The provider client IDs do not need to be exposed to the Electron renderer because the Worker constructs the provider authorization URLs. They are public, but keeping them in Worker vars gives one authoritative deployment configuration and avoids duplicating OAuth config in the installer.

Release builds should keep:

- `AXLE_PLUGIN_WORKER_URL` → deployed Worker origin
- `AXLE_GITHUB_CLIENT_ID` → Axle GitHub OAuth app client ID
- `AXLE_GITHUB_AUTH_BROKER_URL` → GitHub auth broker URL when it differs from the plugin Worker

## Analytics

The Worker keeps privacy-safe per-Clerk-user counters in KV for signup/last-seen time, prompts, model calls/requests, agent calls, plugin authorization requests, successful plugin uses, and aggregate model/provider/plugin/action dimensions.

It does not store prompt text, responses, attachments, file paths, tool payloads, provider tokens, or conversation content.

## Deploy

From `axle-auth-worker`:

```sh
npm test
npx wrangler deploy --name axle-auth
```

After deployment, verify `/health`, Clerk sign-in, every provider OAuth callback, disconnect/reconnect behavior, GitHub credential import/refresh, agent authorization-card cancellation, and one read plus one permitted write action for each plugin.

### Credentialless smoke test

These checks need no secrets and catch origin drift, broken routes, and auth-wall regressions. Verified against the deployed `https://axle-auth.axle-download-worker.workers.dev` on 2026-10-18:

```sh
BASE=https://axle-auth.axle-download-worker.workers.dev

# 0. Secret inventory: names only, never values. Expect at minimum
#    GITHUB_CLIENT_SECRET, GOOGLE_CLIENT_SECRET, PLUGIN_TOKEN_ENCRYPTION_KEY,
#    CLERK_SECRET_KEY, and a <PROVIDER>_CLIENT_SECRET for every plugin you
#    expect to work. Missing names explain false entries in /health.
npx wrangler secret list

# 1. Health: 200 with the config flags; providerClientSecretsConfigured must be
#    true for every provider you expect to work (github's client secret is not
#    reported here - check GITHUB_CLIENT_SECRET manually).
curl -sS "$BASE/health"

# 2. Session wall: all session-gated routes must reject unauthenticated calls
#    with 401 {"error":"Plugin session is invalid or expired.","code":"unauthorized"}.
curl -sS -X POST "$BASE/v1/mcp" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
curl -sS "$BASE/v1/plugins"
curl -sS -X POST "$BASE/v1/plugins/github/authorize"

# 3. Installation wall: 400 {"code":"invalid_installation"} without one.
curl -sS -X POST "$BASE/v1/session"
```

Full OAuth E2E (connect a plugin and run one MCP tool call through the native
agent) additionally requires, in order: provider client secrets set via
`npx wrangler secret put`, a Clerk sign-in, and a completed OAuth authorization
in the app. Until `providerClientSecretsConfigured` is true for a provider, its
authorize flow cannot complete even though the route itself responds.
