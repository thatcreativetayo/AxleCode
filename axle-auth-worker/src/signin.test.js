import assert from "node:assert/strict";
import test from "node:test";

import { consumeAuthCodeByState } from "./accounts.js";
import { desktopHandoffPage, isDesktopRedirect } from "./signin.js";

/**
 * Minimal D1 stand-in for the two statements the claim path issues. It keeps
 * the production semantics (newest unconsumed row per state, single-use claim)
 * so the assertions below cover the real decision logic.
 */
function makeAuthCodeDb(rows) {
  const codes = rows.map((row) => ({ ...row }));
  return {
    prepare(sql) {
      const isRead = sql.includes("FROM axle_auth_codes");
      const isClaim = sql.includes("UPDATE axle_auth_codes");
      if (!isRead && !isClaim) throw new Error(`unexpected query: ${sql}`);
      const selectsByState = sql.includes("WHERE state = ?");
      return {
        bind(...params) {
          return {
            async first() {
              if (!selectsByState) throw new Error(`unexpected read: ${sql}`);
              const [state] = params;
              const candidates = codes.filter(
                (row) => row.state === state && row.consumed_at === null,
              );
              if (candidates.length === 0) return null;
              return candidates.reduce((newest, row) =>
                Date.parse(row.created_at) > Date.parse(newest.created_at) ? row : newest,
              );
            },
            async run() {
              const [consumedAt, code] = params;
              const row = codes.find(
                (entry) => entry.code === code && entry.consumed_at === null,
              );
              if (!row) return { meta: { changes: 0 } };
              row.consumed_at = consumedAt;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function authCodeRow(overrides = {}) {
  return {
    code: "code_primary",
    user_id: "usr_1",
    session_id: "ses_1",
    state: "state_1234567890123456",
    created_at: new Date(Date.now() - 1_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    ...overrides,
  };
}

test("desktop hand-off page asks the user to open Axle and keeps the deep link", async () => {
  const target = "axle://app/clerk-callback?code=abc123&state=state_1234567890123456";
  const page = await (await desktopHandoffPage(target, "nonce123")).text();
  assert.match(page, /Open Axle/u);
  assert.match(page, /You can close this tab afterwards/u);
  assert.ok(page.includes(`href="${target.replaceAll("&", "&amp;")}"`));
  assert.match(page, /window\.location\.href = target/u);
  assert.doesNotMatch(page, /<script(?![^>]*nonce="nonce123")/u);
});

test("desktop hand-off page escapes the deep link inside the inline script", async () => {
  const page = await (
    await desktopHandoffPage("axle://app/clerk-callback?code=</script>x", "nonce123")
  ).text();
  assert.doesNotMatch(page, /<\/script>x/u);
  assert.match(page, /\\u003c\/script>x/u);
});

test("desktop redirect allowlist only accepts Axle callbacks", () => {
  assert.equal(isDesktopRedirect("axle://app/clerk-callback"), true);
  assert.equal(isDesktopRedirect("axle-dev://app/clerk-callback"), true);
  assert.equal(isDesktopRedirect("http://localhost:5733/clerk-callback"), true);
  assert.equal(isDesktopRedirect("https://evil.example/clerk-callback"), false);
  assert.equal(isDesktopRedirect("axle://app/other"), false);
});

test("a pending desktop sign-in hands its code over exactly once", async () => {
  const db = makeAuthCodeDb([authCodeRow()]);
  const claimed = await consumeAuthCodeByState(db, "state_1234567890123456");
  assert.equal(claimed?.code, "code_primary");
  assert.equal(await consumeAuthCodeByState(db, "state_1234567890123456"), null);
});

test("an expired or unknown desktop sign-in stays pending", async () => {
  const db = makeAuthCodeDb([
    authCodeRow({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
    authCodeRow({ code: "code_other", state: "state_other_1234567890" }),
  ]);
  assert.equal(await consumeAuthCodeByState(db, "state_1234567890123456"), null);
  assert.equal(await consumeAuthCodeByState(db, "state_missing_12345678"), null);
});

test("a restarted desktop sign-in claims the newest code for its state", async () => {
  const db = makeAuthCodeDb([
    authCodeRow({ code: "code_old", created_at: new Date(Date.now() - 5_000).toISOString() }),
    authCodeRow({ code: "code_new", created_at: new Date(Date.now() - 10).toISOString() }),
  ]);
  const claimed = await consumeAuthCodeByState(db, "state_1234567890123456");
  assert.equal(claimed?.code, "code_new");
});
