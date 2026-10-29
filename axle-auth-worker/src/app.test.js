import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanDimension,
  emptyAnalytics,
  handleWrappedRequest,
  normalizeFigmaToken,
} from "./app.js";

function makeKv() {
  const values = new Map();
  return {
    async get(key, mode) {
      const value = values.get(key) ?? null;
      if (mode === "json" && typeof value === "string") return JSON.parse(value);
      return value;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      values.delete(key);
    },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

test("analytics records contain counters but no conversation fields", () => {
  const record = emptyAnalytics("user_123", "2026-09-03T00:00:00.000Z");
  assert.deepEqual(record, {
    userId: "user_123",
    signedUpAt: "2026-09-03T00:00:00.000Z",
    lastSeenAt: "2026-09-03T00:00:00.000Z",
    prompts: 0,
    modelCalls: 0,
    models: {},
    providers: {},
  });
  assert.equal("prompt" in record, false);
  assert.equal("content" in record, false);
});

test("analytics dimensions are bounded and stripped of unsafe characters", () => {
  assert.equal(cleanDimension("  gpt-5.6/luna  "), "gpt-5.6/luna");
  assert.equal(cleanDimension("provider<script>"), "providerscript");
  assert.equal(cleanDimension(""), null);
  assert.equal(cleanDimension(null), null);
  assert.ok(cleanDimension("x".repeat(200)).length <= 120);
});

test("Figma refresh responses keep the existing refresh token", () => {
  const token = normalizeFigmaToken(
    { access_token: "figma-access-token", token_type: "bearer", expires_in: 3600 },
    "figma-refresh-token",
    { userId: "123" },
  );
  assert.equal(token.accessToken, "figma-access-token");
  assert.equal(token.refreshToken, "figma-refresh-token");
  assert.equal(token.metadata.userId, "123");
  assert.ok(token.expiresAt > Date.now());
});

test("admin analytics endpoint requires its dedicated bearer secret", async () => {
  const env = { PLUGIN_STORE: makeKv(), ANALYTICS_ADMIN_TOKEN: "admin-secret" };
  const denied = await handleWrappedRequest(
    new Request("https://auth.example/v1/admin/analytics"),
    env,
  );
  assert.equal(denied.status, 401);

  const allowed = await handleWrappedRequest(
    new Request("https://auth.example/v1/admin/analytics", {
      headers: { Authorization: "Bearer admin-secret" },
    }),
    env,
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(await allowed.json(), {
    totals: { users: 0, prompts: 0, modelCalls: 0 },
    users: [],
  });
});

test("Figma token exchange authenticates with Basic credentials", async () => {
  const store = makeKv();
  await store.put(
    "oauth:test-figma-state",
    JSON.stringify({
      userId: "user_test",
      pluginId: "figma",
      redirectUri: "https://auth.example/v1/plugins/figma/callback",
      verifier: "verifier_test",
    }),
  );
  const env = {
    PLUGIN_STORE: store,
    FIGMA_CLIENT_ID: "figma-client-id",
    FIGMA_CLIENT_SECRET: "figma-client-secret",
  };
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json(
      { error: "invalid_grant", error_description: "Authorization code expired." },
      { status: 400 },
    );
  };
  try {
    const response = await handleWrappedRequest(
      new Request(
        "https://auth.example/v1/plugins/figma/callback?code=code-12345678&state=test-figma-state",
      ),
      env,
    );
    assert.equal(response.status, 502);
    assert.equal(captured.url, "https://api.figma.com/v1/oauth/token");
    assert.equal(
      captured.init.headers.Authorization,
      `Basic ${btoa("figma-client-id:figma-client-secret")}`,
    );
    const body = new URLSearchParams(captured.init.body);
    assert.equal(body.get("code"), "code-12345678");
    assert.equal(body.get("code_verifier"), "verifier_test");
    assert.equal(body.get("redirect_uri"), "https://auth.example/v1/plugins/figma/callback");
    assert.equal(body.get("client_id"), null);
    assert.equal(body.get("client_secret"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack callback joins public channels after connecting", async () => {
  const store = makeKv();
  await store.put(
    "oauth:test-slack-state",
    JSON.stringify({
      userId: "user_test",
      pluginId: "slack",
      redirectUri: "https://auth.example/v1/plugins/slack/callback",
      verifier: null,
    }),
  );
  const env = {
    PLUGIN_STORE: store,
    SLACK_CLIENT_ID: "slack-client-id",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    PLUGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
  };
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value === "https://slack.com/api/oauth.v2.access") {
      return Response.json({
        ok: true,
        access_token: "xoxb-test-token",
        token_type: "bot",
        team: { id: "T1", name: "Test" },
      });
    }
    if (value.startsWith("https://slack.com/api/conversations.list")) {
      return Response.json({
        ok: true,
        channels: [
          { id: "C1", is_member: false },
          { id: "C2", is_member: true },
        ],
        response_metadata: { next_cursor: "" },
      });
    }
    if (value === "https://slack.com/api/conversations.join") {
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected fetch: ${value}`);
  };
  try {
    const response = await handleWrappedRequest(
      new Request(
        "https://auth.example/v1/plugins/slack/callback?code=code-12345678&state=test-slack-state",
      ),
      env,
    );
    assert.equal(response.status, 200);
    const joins = calls.filter(
      (call) => call.url === "https://slack.com/api/conversations.join",
    );
    assert.equal(joins.length, 1);
    assert.deepEqual(JSON.parse(joins[0].init.body), { channel: "C1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OAuth callback keeps the provider token-exchange error visible", async () => {
  const store = makeKv();
  await store.put(
    "oauth:test-gmail-state",
    JSON.stringify({
      userId: "user_test",
      pluginId: "gmail",
      redirectUri: "https://auth.example/v1/plugins/gmail/callback",
      verifier: "verifier_test",
    }),
  );
  const env = {
    PLUGIN_STORE: store,
    GMAIL_CLIENT_ID: "client-id",
    GMAIL_CLIENT_SECRET: "client-secret",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      { error: "invalid_client", error_description: "The client secret is invalid." },
      { status: 401 },
    );
  try {
    const response = await handleWrappedRequest(
      new Request(
        "https://auth.example/v1/plugins/gmail/callback?code=code-12345678&state=test-gmail-state",
      ),
      env,
    );
    assert.equal(response.status, 502);
    assert.match(await response.text(), /The client secret is invalid/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
