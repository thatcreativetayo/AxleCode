import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizationHeader,
  handleRequest,
  isLoopbackRedirect,
  isPkceVerifier,
  isPluginId,
  PLUGIN_IDS,
  PROVIDERS,
  sha256,
} from "./index.js";
import { bytesToBase64Url, encryptionKey, sealStateless } from "./shared.js";

const env = {
  GITHUB_CLIENT_ID: "Iv1.testclient",
  GITHUB_CLIENT_SECRET: "test-secret",
};

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
  };
}

async function sealConnection(value, env) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return JSON.stringify({
    version: 1,
    iv: bytesToBase64Url(iv),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  });
}

test("Slack requests channels:join so the bot can join public channels", () => {
  assert.ok(PROVIDERS.slack.scopes.includes("channels:join"));
});

test("only accepts the exact loopback callback shape", () => {
  assert.equal(isLoopbackRedirect("http://127.0.0.1:48123/github/oauth/callback"), true);
  assert.equal(isLoopbackRedirect("http://localhost:48123/github/oauth/callback"), false);
  assert.equal(isLoopbackRedirect("https://127.0.0.1:48123/github/oauth/callback"), false);
  assert.equal(isLoopbackRedirect("http://127.0.0.1:48123/other"), false);
});

test("validates PKCE verifier length and character set", () => {
  assert.equal(isPkceVerifier("a".repeat(43)), true);
  assert.equal(isPkceVerifier("a".repeat(128)), true);
  assert.equal(isPkceVerifier("a".repeat(42)), false);
  assert.equal(isPkceVerifier("a".repeat(129)), false);
  assert.equal(isPkceVerifier("a".repeat(42) + "!"), false);
});

test("uses the Bearer HTTP scheme for Slack bot and user tokens", () => {
  assert.equal(authorizationHeader({ tokenType: "bot", accessToken: "xoxb-test" }), "Bearer xoxb-test");
  assert.equal(authorizationHeader({ tokenType: "user", accessToken: "xoxp-test" }), "Bearer xoxp-test");
  assert.equal(authorizationHeader({ tokenType: "bearer", accessToken: "provider-token" }), "bearer provider-token");
});

test("plugin catalog is the supported seven services", () => {
  assert.deepEqual(PLUGIN_IDS, [
    "github",
    "jira",
    "notion",
    "gmail",
    "slack",
    "sentry",
    "figma",
  ]);
  for (const pluginId of PLUGIN_IDS) assert.equal(isPluginId(pluginId), true);
  assert.equal(isPluginId("discord"), false);
  assert.equal(isPluginId("googlecalendar"), false);
});

test("health endpoint reports configured state without leaking secret", async () => {
  const response = await handleRequest(new Request("https://auth.example/health"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    githubClientIdConfigured: true,
    clerkConfigured: false,
    pluginStoreConfigured: false,
    tokenEncryptionConfigured: false,
    providerClientSecretsConfigured: {
      gmail: false,
      slack: false,
      jira: false,
      notion: false,
      sentry: false,
      figma: false,
    },
    plugins: PLUGIN_IDS,
  });
  assert.equal(JSON.stringify(body).includes(env.GITHUB_CLIENT_SECRET), false);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
});

test("health treats a public OAuth client as configured without a secret", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/health"),
    { ...env, SENTRY_CLIENT_ID: "sentry-public-client" },
  );
  const body = await response.json();
  assert.equal(body.providerClientSecretsConfigured.sentry, true);
  assert.equal(body.providerClientSecretsConfigured.slack, false);
});

test("creates stable anonymous plugin sessions without Clerk authentication", async () => {
  const installationId = "d9428888-122b-4f71-9479-2f4f4f320f34";
  const anonymousEnv = {
    ...env,
    PLUGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
  };
  const createSession = () =>
    handleRequest(
      new Request("https://auth.example/v1/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ installationId }),
      }),
      anonymousEnv,
    );

  const firstResponse = await createSession();
  const secondResponse = await createSession();
  assert.equal(firstResponse.status, 200);
  assert.equal(secondResponse.status, 200);
  const first = await firstResponse.json();
  const second = await secondResponse.json();
  assert.equal(first.anonymous, true);
  assert.equal(first.user.id, second.user.id);
  assert.equal(first.user.email, null);
  assert.notEqual(first.sessionToken, second.sessionToken);
});

test("rejects anonymous plugin sessions without a valid installation ID", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: "not-a-uuid" }),
    }),
    env,
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /installation ID/i);
});

test("revokes the persisted plugin session on explicit logout", async () => {
  const token = "session-token-with-enough-length";
  const key = `session:${await sha256(token)}`;
  let deletedKey = null;
  const store = {
    async get(requestedKey) {
      return requestedKey === key ? { userId: "user-1", sessionId: "session-1" } : null;
    },
    async delete(requestedKey) {
      deletedKey = requestedKey;
    },
    async put() {},
  };
  const response = await handleRequest(
    new Request("https://auth.example/v1/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
    { ...env, PLUGIN_STORE: store },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: true });
  assert.equal(deletedKey, key);
});

test("rejects non-JSON token requests", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/github/exchange", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "nope",
    }),
    env,
  );
  assert.equal(response.status, 415);
});

test("refreshes expired Figma tokens with Basic auth at the refresh endpoint", async () => {
  const figmaEnv = {
    ...env,
    PLUGIN_STORE: makeKv(),
    PLUGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    FIGMA_CLIENT_ID: "figma-client-id",
    FIGMA_CLIENT_SECRET: "figma-client-secret",
  };
  const sessionResponse = await handleRequest(
    new Request("https://auth.example/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installationId: "d9428888-122b-4f71-9479-2f4f4f320f34" }),
    }),
    figmaEnv,
  );
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  await figmaEnv.PLUGIN_STORE.put(
    `connection:${session.user.id}:figma`,
    await sealConnection(
      {
        accessToken: "old-figma-token",
        refreshToken: "figma-refresh-token",
        tokenType: "bearer",
        scope: "",
        expiresAt: Date.now() - 1_000,
        metadata: { userId: "123" },
      },
      figmaEnv,
    ),
  );
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return Response.json({
      access_token: "new-figma-token",
      token_type: "bearer",
      expires_in: 3600,
    });
  };
  try {
    const response = await handleRequest(
      new Request("https://auth.example/v1/plugins", {
        headers: { Authorization: `Bearer ${session.sessionToken}` },
      }),
      figmaEnv,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const figma = body.plugins.find((plugin) => plugin.pluginId === "figma");
    assert.equal(figma.connected, true);
    assert.equal(captured.url, "https://api.figma.com/v1/oauth/refresh");
    assert.equal(
      captured.init.headers.Authorization,
      `Basic ${btoa("figma-client-id:figma-client-secret")}`,
    );
    const params = new URLSearchParams(captured.init.body);
    assert.equal(params.get("refresh_token"), "figma-refresh-token");
    assert.equal(params.get("client_id"), null);
    assert.equal(params.get("client_secret"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Slack send joins a public channel and retries after not_in_channel", async () => {
  const store = makeKv();
  const slackEnv = {
    ...env,
    PLUGIN_STORE: store,
    PLUGIN_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
  };
  const sessionToken = await sealStateless(
    {
      type: "plugin-session",
      userId: "user_test",
      email: "test@example.com",
      sessionId: "session_test",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    },
    slackEnv,
  );
  await store.put(
    "connection:user_test:slack",
    await sealConnection(
      {
        accessToken: "xoxb-test-token",
        refreshToken: null,
        tokenType: "bot",
        scope: "",
        expiresAt: null,
        metadata: { teamId: "T1", teamName: "Test" },
      },
      slackEnv,
    ),
  );
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const value = String(url);
    calls.push({ url: value, init });
    if (value === "https://slack.com/api/chat.postMessage") {
      const attempts = calls.filter((call) => call.url === value).length;
      return Response.json(
        attempts === 1 ? { ok: false, error: "not_in_channel" } : { ok: true, ts: "123.456" },
      );
    }
    if (value === "https://slack.com/api/conversations.join") return Response.json({ ok: true });
    throw new Error(`Unexpected fetch: ${value}`);
  };
  try {
    const response = await handleRequest(
      new Request("https://auth.example/v1/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "axle_plugin_call",
            arguments: {
              pluginId: "slack",
              action: "send_message",
              input: { channel: "C1", text: "Hello" },
            },
          },
        }),
      }),
      slackEnv,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.result.isError, false);
    const joins = calls.filter((call) => call.url === "https://slack.com/api/conversations.join");
    assert.equal(joins.length, 1);
    assert.deepEqual(JSON.parse(joins[0].init.body), { channel: "C1" });
    assert.equal(
      calls.filter((call) => call.url === "https://slack.com/api/chat.postMessage").length,
      2,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects invalid callback before contacting GitHub", async () => {
  const response = await handleRequest(
    new Request("https://auth.example/v1/github/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: "12345678",
        code_verifier: "a".repeat(43),
        redirect_uri: "https://attacker.example/callback",
      }),
    }),
    env,
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /loopback/i);
});
