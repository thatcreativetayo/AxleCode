/**
 * Axle account sign-in: GitHub and Google OAuth, desktop frame, and session
 * exchange. Replaces the Clerk-hosted frame with an Axle-owned one.
 *
 * The desktop keeps talking the existing frame protocol, so only the frame URL,
 * the code-exchange URL, and the restore URL change on the client.
 */

import {
  consumeAuthCode,
  consumeAuthCodeByState,
  consumeOAuthRequest,
  createApiKey,
  createAuthCode,
  createSession,
  linkIdentityToUser,
  listApiKeys,
  listIdentities,
  listSessions,
  readSession,
  readUser,
  revokeApiKey,
  revokeOwnSession,
  revokeSession,
  saveOAuthRequest,
  touchSession,
  unlinkIdentity,
  updateProfile,
  upsertUserFromIdentity,
} from "./accounts.js";
import {
  accountsDb,
  issueAccessToken,
  issuerFor,
  jwksDocument,
  verifyAccessToken,
} from "./identity.js";
import { authenticatePluginSession } from "./index.js";
import { base64UrlToBytes, bytesToBase64Url } from "./shared.js";

const FRAME_SOURCE = "axle-clerk-frame";
const HOST_SOURCE = "axle-clerk-host";

/**
 * Sign-in providers in display order. Google is the method Axle ships with, so
 * it is listed first and rendered as the primary action on the sign-in pages.
 */
const PROVIDERS = {
  google: {
    label: "Google",
    clientIdVars: ["GOOGLE_CLIENT_ID", "GMAIL_CLIENT_ID"],
    clientSecretVars: ["GOOGLE_CLIENT_SECRET", "GMAIL_CLIENT_SECRET"],
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["openid", "email", "profile"],
    pkce: true,
  },
  github: {
    label: "GitHub",
    clientIdVars: ["GITHUB_CLIENT_ID"],
    clientSecretVars: ["GITHUB_CLIENT_SECRET"],
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["read:user", "user:email"],
    pkce: false,
  },
};

export const SIGNIN_PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * Brand marks are inlined because these pages run under a strict CSP that
 * blocks remote assets. The Axle mark inherits the surrounding text colour.
 */
const AXLE_MARK = `<svg class="mark" viewBox="0 0 181 176" width="22" height="22" fill="currentColor" aria-hidden="true" focusable="false"><path d="M107.5 4.5C114.56 8.5 117.9 15.75 121.54 22.69C122.45 24.41 123.39 26.1 124.34 27.8C127.0 32.73 129.16 37.01 129.2 42.68C127.83 46.25 124.89 48.69 121.65 50.57C119.45 51.65 117.23 52.64 114.98 53.62C114.15 53.99 113.31 54.37 112.45 54.75C109.72 55.97 106.99 57.17 104.25 58.38C101.4 59.64 98.56 60.9 95.71 62.17C93.79 63.02 91.87 63.88 89.94 64.73C83.82 67.45 77.73 70.23 71.66 73.08C70.16 73.78 68.65 74.49 67.15 75.19C65.03 76.18 62.92 77.17 60.81 78.17C47.36 84.59 47.36 84.59 40.5 83.5C38.23 82.09 36.73 80.9 35.5 78.5C34.5 74.41 34.08 71.78 35.85 67.91C36.51 66.64 37.2 65.37 37.9 64.12C38.65 62.7 39.39 61.29 40.14 59.87C40.53 59.15 40.92 58.43 41.33 57.69C42.84 54.87 44.28 52.02 45.73 49.17C47.15 46.36 48.59 43.55 50.04 40.74C50.77 39.32 51.5 37.9 52.22 36.48C66.93 7.7 66.93 7.7 78.61 2.23C88.24 -1.47 98.44 -0.04 107.5 4.5Z"/><path d="M135.94 59.19C136.51 59.34 137.09 59.48 137.68 59.64C143.73 62.51 145.89 68.87 148.63 74.56C149.61 76.57 150.59 78.57 151.57 80.57C152.07 81.57 152.56 82.57 153.06 83.61C155.12 87.75 157.27 91.85 159.44 95.94C159.84 96.69 160.23 97.45 160.65 98.22C162.44 101.62 164.24 105.01 166.04 108.4C167.66 111.45 169.27 114.51 170.88 117.56C171.38 118.5 171.88 119.44 172.39 120.41C177.64 130.4 181.98 138.98 180.5 150.5C178.52 158.63 174.13 164.98 167.48 170.04C160.73 174.46 154.9 175.72 146.89 175.96C136.77 174.58 127.26 168.47 118.25 163.88C115.6 162.52 112.95 161.18 110.3 159.84C109.7 159.53 109.11 159.23 108.5 158.91C102.71 155.98 97.43 154.19 90.88 154.06C89.77 154.02 88.66 153.98 87.52 153.94C76.73 154.77 65.52 162.39 56.0 167.25C53.35 168.6 50.69 169.95 48.03 171.3C47.43 171.6 46.84 171.91 46.22 172.23C39.31 175.72 33.2 176.17 25.5 175.5C17.38 173.57 11.0 169.1 5.96 162.48C0.89 154.75 -0.39 147.69 0.5 138.5C1.39 134.58 2.81 131.13 4.5 127.5C4.62 127.22 4.62 127.22 5.22 125.79C7.61 120.16 10.23 114.47 15.77 111.41C17.03 110.8 18.29 110.22 19.57 109.65C20.26 109.32 20.96 108.99 21.67 108.65C23.17 107.95 24.67 107.25 26.17 106.57C28.51 105.49 30.85 104.4 33.18 103.29C38.17 100.94 43.18 98.62 48.19 96.31C49.08 95.9 49.98 95.49 50.9 95.06C64.93 88.57 79.01 82.18 93.13 75.9C97.78 73.83 102.42 71.73 107.06 69.63C107.78 69.3 108.5 68.98 109.24 68.65C112.05 67.37 114.87 66.09 117.69 64.81C119.61 63.94 121.53 63.07 123.45 62.2C124.02 61.94 124.59 61.68 125.17 61.42C132.33 58.18 132.33 58.18 135.94 59.19Z"/></svg>`;

const PROVIDER_ICONS = {
  google: `<svg viewBox="0 0 48 48" width="16" height="16" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
  github: `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>`,
};

function providerIcon(providerId) {
  return PROVIDER_ICONS[providerId] ?? "";
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name]?.trim();
    if (value) return value;
  }
  return "";
}

function providerConfig(env, providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  return {
    ...provider,
    id: providerId,
    clientId: firstEnv(env, provider.clientIdVars),
    clientSecret: firstEnv(env, provider.clientSecretVars),
  };
}

function baseUrl(request, env) {
  const configured = env?.PUBLIC_BASE_URL?.trim();
  if (configured) return configured.replace(/\/$/u, "");
  return new URL(request.url).origin;
}

function json(value, status = 200, extraHeaders = {}) {
  return Response.json(value, {
    status,
    headers: {
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
  });
}

function fail(message, status = 400, code = "bad_request") {
  return json({ error: message, code }, status);
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > 64 * 1024) throw new Error("Request body is too large.");
  const text = await request.text();
  if (!text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value;
}

async function sha256Bytes(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64Url(value);
}

/**
 * Only the desktop renderer may receive a session handoff code. An open redirect
 * here would leak the code, so the shape is an explicit allowlist.
 */
function isDesktopRedirect(value) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.protocol === "axle:" || url.protocol === "axle-dev:") {
    return url.pathname === "/clerk-callback";
  }
  if (url.protocol !== "http:") return false;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
  return url.pathname === "/clerk-callback";
}

function html(body, nonce, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "origin",
      "Content-Security-Policy": [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        `style-src 'nonce-${nonce}'`,
        "frame-ancestors axle://app axle-dev://app http://localhost:* http://127.0.0.1:*",
        "base-uri 'none'",
        "form-action 'none'",
      ].join("; "),
    },
  });
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function providerButtons(providers, target) {
  if (providers.length === 0) {
    return `<p class="empty">No sign-in provider is configured yet.</p>`;
  }
  return providers
    .map(
      (provider, index) =>
        `<a class="provider${index === 0 ? " primary" : ""}" href="${escapeHtml(target(provider))}" data-provider="${escapeHtml(provider.id)}">${providerIcon(provider.id)}Continue with ${escapeHtml(provider.label)}</a>`,
    )
    .join("\n");
}

/**
 * Page chrome mirrors the desktop IDE: the same surface, border, radius and
 * type tokens from `apps/web/src/index.css`, in both dark and light themes.
 */
function shellStyles(nonce) {
  return `<style nonce="${nonce}">
:root { color-scheme: dark light;
  --background:#1a1a1a; --foreground:#ececec; --card:#222222; --accent:#2b2b2b;
  --primary:#ececec; --primary-foreground:#1a1a1a; --muted-foreground:#969696;
  --border:#2c2c2c; --input:#3d3d3d; --ring:#b5b5b5; --destructive:#ed7777;
  --radius:0.625rem;
  --font-sans:"Inter Variable","Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; }
@media (prefers-color-scheme: light) { :root { color-scheme: light;
  --background:#ffffff; --foreground:#202020; --card:#fafafa; --accent:#f0f0f0;
  --primary:#202020; --primary-foreground:#ffffff; --muted-foreground:#686868;
  --border:#e6e6e6; --input:#d4d4d4; --ring:#202020; --destructive:#c23939; } }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px;
  background:var(--background); color:var(--foreground); font-family:var(--font-sans);
  font-size:0.875rem; line-height:1.5; -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
.card { width:100%; max-width:22rem; padding:1.5rem; background:var(--card);
  border:1px solid var(--border); border-radius:calc(var(--radius) + 6px); box-shadow:0 14px 44px rgb(0 0 0 / 22%); }
.brand { display:flex; align-items:center; gap:0.5rem; margin:0 0 1.125rem; color:var(--foreground); }
.brand .mark { flex:none; }
.brand .name { font-size:0.9375rem; font-weight:600; letter-spacing:-0.01em; }
h1 { margin:0 0 0.25rem; font-size:1rem; font-weight:600; letter-spacing:-0.01em; }
p.sub { margin:0 0 1.25rem; color:var(--muted-foreground); font-size:0.8125rem; }
a.provider { display:flex; align-items:center; justify-content:center; gap:0.5rem; width:100%;
  height:2.25rem; padding:0 0.875rem; margin-bottom:0.5rem; border:1px solid transparent;
  border-radius:var(--radius); background:var(--accent); color:var(--foreground);
  font-size:0.875rem; font-weight:500; text-decoration:none; cursor:pointer;
  transition:background .12s ease,border-color .12s ease,opacity .12s ease; }
a.provider svg { flex:none; }
a.provider:hover { border-color:var(--input); }
a.provider.primary { background:var(--primary); color:var(--primary-foreground); }
a.provider.primary:hover { opacity:0.9; border-color:transparent; }
a.provider:focus-visible { outline:none; box-shadow:0 0 0 2px var(--card),0 0 0 4px var(--ring); }
p.empty { margin:0 0 0.75rem; color:var(--destructive); font-size:0.8125rem; }
p.note { margin:1rem 0 0; color:var(--muted-foreground); font-size:0.75rem; }
@media (prefers-reduced-motion: reduce) { a.provider { transition:none; } }
</style>`;
}

function framePage(providers, nonce) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to Axle</title>${shellStyles(nonce)}</head>
<body><div class="card">
<div class="brand">${AXLE_MARK}<span class="name">Axle</span></div>
<h1>Sign in to Axle</h1>
<p class="sub">Sign-in opens in your browser.</p>
${providerButtons(providers, (provider) => `#${provider.id}`)}
<p class="note">Axle never sees your password.</p>
</div>
<script nonce="${nonce}">
(function () {
  var currentToken = null;
  function post(message) {
    try { parent.postMessage(message, "*"); } catch (error) {}
  }
  post({ source: "${FRAME_SOURCE}", type: "ready" });
  window.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || data.source !== "${HOST_SOURCE}" || data.type !== "request-token") return;
    post({ source: "${FRAME_SOURCE}", type: "token", requestId: data.requestId, token: currentToken });
  });
  document.querySelectorAll("a.provider").forEach(function (link) {
    link.addEventListener("click", function (event) {
      event.preventDefault();
      post({ source: "${FRAME_SOURCE}", type: "external-auth" });
    });
  });
})();
</script></body></html>`;
}

function externalPage(providers, nonce, startHref, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sign in to Axle</title>${shellStyles(nonce)}</head>
<body><div class="card">
<div class="brand">${AXLE_MARK}<span class="name">Axle</span></div>
<h1>Sign in to Axle</h1>
<p class="sub">Choose how you want to continue.</p>
${message ? `<p class="empty">${escapeHtml(message)}</p>` : ""}
${providerButtons(providers, (provider) => startHref(provider))}
<p class="note">Axle never sees your password.</p>
</div></body></html>`;
}

/**
 * Last step of a browser sign-in: hand the one-time code back to the Axle app.
 * A bare redirect to a custom scheme is blocked by some browsers, so the page
 * asks the user to open Axle and keeps the deep link behind a clickable
 * button as well.
 */
function desktopHandoffPage(targetUrl, nonce) {
  const targetJson = JSON.stringify(targetUrl).replaceAll("<", "\\u003c");
  return html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Signing in to Axle</title>${shellStyles(nonce)}</head>
<body><div class="card">
<div class="brand">${AXLE_MARK}<span class="name">Axle</span></div>
<h1>You're signed in</h1>
<p class="sub">Axle is opening to finish signing in.</p>
<a class="provider primary" id="open-axle" href="${escapeHtml(targetUrl)}">Open Axle</a>
<p class="note">Nothing happened? Choose Open Axle. You can close this tab afterwards.</p>
</div>
<script nonce="${nonce}">
(function () {
  var target = ${targetJson};
  var attempt = setTimeout(function () { window.location.href = target; }, 350);
  var button = document.getElementById("open-axle");
  if (button) button.addEventListener("click", function () { clearTimeout(attempt); });
})();
</script></body></html>`,
    nonce,
  );
}

async function fetchGitHubIdentity(accessToken) {
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "axle-auth",
  };
  const response = await fetch("https://api.github.com/user", { headers });
  if (!response.ok) throw new Error("GitHub did not return a profile.");
  const profile = await response.json();
  let email = typeof profile.email === "string" ? profile.email : null;
  let emailVerified = Boolean(email);
  if (!email) {
    const emails = await fetch("https://api.github.com/user/emails", { headers });
    if (emails.ok) {
      const list = await emails.json();
      const primary = Array.isArray(list)
        ? list.find((entry) => entry?.primary && entry?.verified) ?? list.find((entry) => entry?.verified)
        : null;
      if (primary?.email) {
        email = primary.email;
        emailVerified = true;
      }
    }
  }
  return {
    providerUserId: String(profile.id),
    email,
    emailVerified,
    displayName: typeof profile.name === "string" ? profile.name : (profile.login ?? null),
    avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
    login: typeof profile.login === "string" ? profile.login : null,
  };
}

async function fetchGoogleIdentity(accessToken) {
  const response = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Google did not return a profile.");
  const profile = await response.json();
  if (typeof profile.sub !== "string" || profile.sub.length === 0) {
    throw new Error("Google returned a profile without a subject.");
  }
  return {
    providerUserId: profile.sub,
    email: typeof profile.email === "string" ? profile.email : null,
    // Google only exposes `email_verified` on the id_token; userinfo omits it.
    emailVerified: profile.email_verified !== false && typeof profile.email === "string",
    displayName: typeof profile.name === "string" ? profile.name : null,
    avatarUrl: typeof profile.picture === "string" ? profile.picture : null,
    login: typeof profile.email === "string" ? profile.email : null,
  };
}

async function exchangeProviderCode(config, { code, codeVerifier, redirectUri }) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  if (codeVerifier) body.set("code_verifier", codeVerifier);
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const value = await response.json().catch(() => null);
  const accessToken = value?.access_token;
  if (!response.ok || typeof accessToken !== "string" || accessToken.length === 0) {
    const detail = typeof value?.error_description === "string" ? value.error_description : value?.error;
    throw new Error(detail ? `${config.label} rejected the sign-in: ${detail}` : `${config.label} sign-in failed.`);
  }
  return accessToken;
}

function configuredProviders(env) {
  return SIGNIN_PROVIDER_IDS.map((id) => providerConfig(env, id))
    .filter((config) => config.clientId.length > 0 && config.clientSecret.length > 0)
    .map((config) => ({ id: config.id, label: config.label }));
}

/**
 * Providers offered on the sign-in pages. Google is the method Axle ships
 * with, so once it is configured the pages show it alone. If it is not
 * configured, the remaining providers are offered rather than leaving users
 * with no way to reach their account.
 */
function signInProviders(env) {
  const configured = configuredProviders(env);
  const google = configured.filter((provider) => provider.id === "google");
  return google.length > 0 ? google : configured;
}

/** Build the provider consent URL; shared by sign-in and account linking. */
async function buildAuthorizeUrl(config, { callbackUrl, state, codeVerifier }) {
  const authorize = new URL(config.authorizeUrl);
  authorize.searchParams.set("client_id", config.clientId);
  authorize.searchParams.set("redirect_uri", callbackUrl);
  authorize.searchParams.set("scope", config.scopes.join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  if (config.pkce && codeVerifier) {
    authorize.searchParams.set("code_challenge", bytesToBase64Url(await sha256Bytes(codeVerifier)));
    authorize.searchParams.set("code_challenge_method", "S256");
  }
  return authorize.toString();
}

async function handleStart(request, env, url) {
  const providerId = url.searchParams.get("provider") ?? "";
  const config = providerConfig(env, providerId);
  if (!config) return fail("Unknown sign-in provider.", 400, "unknown_provider");
  if (!config.clientId || !config.clientSecret) {
    return fail(`${config.label} sign-in is not configured on this deployment.`, 503, "provider_not_configured");
  }
  const redirectUri = url.searchParams.get("redirect_uri") ?? "";
  if (!isDesktopRedirect(redirectUri)) {
    return fail("The sign-in redirect target is not an Axle desktop callback.", 400, "invalid_redirect");
  }
  const state = (url.searchParams.get("state") ?? "").trim();
  if (state.length === 0 || state.length > 200) {
    return fail("A sign-in state value is required.", 400, "invalid_state");
  }
  const db = accountsDb(env);
  const callbackUrl = `${baseUrl(request, env)}/v1/auth/callback/${providerId}`;
  const codeVerifier = config.pkce ? randomToken(32) : null;
  await saveOAuthRequest(db, {
    state,
    provider: providerId,
    codeVerifier,
    redirectUri,
  });
  return Response.redirect(await buildAuthorizeUrl(config, { callbackUrl, state, codeVerifier }), 302);
}

function callbackErrorPage(providerLabel, message, nonce) {
  return html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Axle sign-in failed</title>${shellStyles(nonce)}</head>
<body><div class="card"><h1>Sign-in failed</h1><p class="empty">${escapeHtml(message)}</p>
<p class="note">You can close this tab and try again from Axle.</p></div></body></html>`,
    nonce,
    400,
  );
}

async function handleCallback(request, env, url, providerId) {
  const nonce = randomToken(16);
  const config = providerConfig(env, providerId);
  if (!config) return callbackErrorPage(providerId, "Unknown sign-in provider.", nonce);
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const description = url.searchParams.get("error_description") ?? providerError;
    return callbackErrorPage(config.label, `${config.label} reported: ${description}`, nonce);
  }
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  if (!code || !state) return callbackErrorPage(config.label, "The sign-in callback was incomplete.", nonce);

  const db = accountsDb(env);
  const pending = await consumeOAuthRequest(db, state);
  if (!pending || pending.provider !== providerId) {
    return callbackErrorPage(config.label, "This sign-in link expired or was already used. Try again.", nonce);
  }

  try {
    const accessToken = await exchangeProviderCode(config, {
      code,
      codeVerifier: pending.code_verifier ?? null,
      redirectUri: `${baseUrl(request, env)}/v1/auth/callback/${providerId}`,
    });
    const profile = providerId === "github"
      ? await fetchGitHubIdentity(accessToken)
      : await fetchGoogleIdentity(accessToken);

    let userId;
    let sessionId;
    if (pending.return_to) {
      // Started from Settings -> Account. Attach the provider to the account
      // that owns this session instead of signing anybody in.
      const owner = await readSession(db, pending.return_to);
      if (!owner) {
        return callbackErrorPage(
          config.label,
          "Your Axle session ended before this finished. Sign in and try again.",
          nonce,
        );
      }
      const linked = await linkIdentityToUser(db, owner.user_id, { provider: providerId, ...profile });
      if (!linked.ok) {
        return callbackErrorPage(
          config.label,
          `That ${config.label} account is already connected to a different Axle account.`,
          nonce,
        );
      }
      userId = owner.user_id;
      sessionId = owner.session_id;
    } else {
      const created = await upsertUserFromIdentity(db, { provider: providerId, ...profile });
      userId = created.userId;
      sessionId = (await createSession(db, { userId, method: `oauth:${providerId}` })).sessionId;
    }

    const handoff = await createAuthCode(db, { userId, sessionId, state: pending.state });
    const destination = new URL(pending.redirect_uri);
    destination.searchParams.set("code", handoff);
    destination.searchParams.set("state", state);
    return desktopHandoffPage(destination.toString(), nonce);
  } catch (error) {
    return callbackErrorPage(
      config.label,
      error instanceof Error ? error.message : "Sign-in could not be completed.",
      nonce,
    );
  }
}

async function handleExchange(request, env) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid request body.", 400);
  }
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) return fail("A sign-in code is required.", 400, "invalid_code");
  const db = accountsDb(env);
  const claimed = await consumeAuthCode(db, code);
  if (!claimed) return fail("This sign-in code expired or was already used.", 401, "invalid_code");
  const payload = await issueSignInPayload(env, claimed);
  if (!payload) return fail("The Axle session is no longer valid.", 401, "unauthorized");
  return json(payload);
}

/** Turns a claimed one-time code into the session payload every client expects. */
async function issueSignInPayload(env, claimed) {
  const db = accountsDb(env);
  const session = await readSession(db, claimed.session_id);
  if (!session || session.user_id !== claimed.user_id) return null;
  const user = await readUser(db, claimed.user_id);
  const token = await issueAccessToken(env, {
    userId: claimed.user_id,
    sessionId: claimed.session_id,
    email: user?.email ?? null,
  });
  return {
    token,
    sessionId: claimed.session_id,
    state: claimed.state ?? "",
    user: { id: claimed.user_id, email: user?.email ?? null },
  };
}

/**
 * Desktop fallback for the return trip: the app polls with the state it
 * started the browser sign-in with and collects the session as soon as the
 * provider callback has minted a code. Returns `pending` until then, so the
 * browser can stay open and the user never has to click a deep link.
 */
async function handleDesktopClaim(request, env) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid request body.", 400);
  }
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (!/^[A-Za-z0-9._~-]{16,160}$/u.test(state)) {
    return fail("A sign-in state value is required.", 400, "invalid_state");
  }
  const claimed = await consumeAuthCodeByState(accountsDb(env), state);
  if (!claimed) return json({ status: "pending" });
  const payload = await issueSignInPayload(env, claimed);
  if (!payload) return fail("The Axle session is no longer valid.", 401, "unauthorized");
  return json({ status: "signed-in", ...payload });
}

async function handleRestore(request, env) {
  const pluginSession = await authenticatePluginSession(request, env);
  if (!pluginSession || !pluginSession.sessionId) {
    return fail("The saved Axle session is missing or expired.", 401, "unauthorized");
  }
  const db = accountsDb(env);
  const session = await readSession(db, pluginSession.sessionId);
  if (!session || session.user_id !== pluginSession.userId) {
    return fail("The saved Axle session is no longer valid.", 401, "unauthorized");
  }
  await touchSession(db, session.session_id);
  const user = await readUser(db, session.user_id);
  const token = await issueAccessToken(env, {
    userId: session.user_id,
    sessionId: session.session_id,
    email: user?.email ?? null,
  });
  return json({
    token,
    sessionId: session.session_id,
    user: { id: session.user_id, email: user?.email ?? null },
  });
}

async function requireSession(request, env) {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const identity = await verifyAccessToken(env, authorization.slice(7).trim()).catch(() => null);
  if (!identity) return null;
  const db = accountsDb(env);
  if (identity.sessionId) {
    const session = await readSession(db, identity.sessionId);
    if (!session || session.user_id !== identity.userId) return null;
    await touchSession(db, identity.sessionId);
  }
  return identity;
}

async function handleMe(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  const db = accountsDb(env);
  const user = await readUser(db, identity.userId);
  if (!user) return fail("The Axle account no longer exists.", 401, "unauthorized");
  return json({
    user: {
      id: user.user_id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    },
    identities: (await listIdentities(db, identity.userId)).map((row) => ({
      provider: row.provider,
      login: row.login,
      email: row.email,
      linkedAt: row.created_at,
    })),
    sessions: (await listSessions(db, identity.userId)).map((row) => ({
      sessionId: row.session_id,
      method: row.method,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      current: row.session_id === identity.sessionId,
    })),
    signInProviders: configuredProviders(env),
  });
}

async function handleSignOut(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return json({ ok: true });
  if (identity.sessionId) await revokeSession(accountsDb(env), identity.sessionId);
  return json({ ok: true });
}

async function handleUpdateProfile(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid request body.", 400);
  }
  if (body.displayName !== null && typeof body.displayName !== "string") {
    return fail("displayName must be a string or null.", 400, "invalid_profile");
  }
  const db = accountsDb(env);
  await updateProfile(db, identity.userId, { displayName: body.displayName ?? null });
  const user = await readUser(db, identity.userId);
  return json({
    user: {
      id: user.user_id,
      email: user.email,
      displayName: user.display_name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    },
  });
}

async function handleRevokeSession(request, env, sessionId) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  const revoked = await revokeOwnSession(accountsDb(env), identity.userId, sessionId);
  if (!revoked) return fail("That session is not active on this account.", 404, "not_found");
  return json({ ok: true, revoked: sessionId, current: sessionId === identity.sessionId });
}

/**
 * Begin connecting an extra provider to the signed-in account. Returns the
 * provider consent URL for the desktop to open in the system browser; the
 * callback links the identity rather than signing anybody in.
 */
async function handleStartLink(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  if (!identity.sessionId) return fail("This session cannot link providers.", 400, "no_session");
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid request body.", 400);
  }
  const config = providerConfig(env, typeof body.provider === "string" ? body.provider : "");
  if (!config) return fail("Unknown sign-in provider.", 400, "unknown_provider");
  if (!config.clientId || !config.clientSecret) {
    return fail(`${config.label} is not configured on this deployment.`, 503, "provider_not_configured");
  }
  const redirectUri = typeof body.redirectUri === "string" ? body.redirectUri : "";
  if (!isDesktopRedirect(redirectUri)) {
    return fail("The link redirect target is not an Axle desktop callback.", 400, "invalid_redirect");
  }
  const state = typeof body.state === "string" ? body.state.trim() : "";
  if (state.length === 0 || state.length > 200) {
    return fail("A link state value is required.", 400, "invalid_state");
  }
  const db = accountsDb(env);
  const callbackUrl = `${baseUrl(request, env)}/v1/auth/callback/${config.id}`;
  const codeVerifier = config.pkce ? randomToken(32) : null;
  await saveOAuthRequest(db, {
    state,
    provider: config.id,
    codeVerifier,
    redirectUri,
    returnTo: identity.sessionId,
  });
  return json({ authorizeUrl: await buildAuthorizeUrl(config, { callbackUrl, state, codeVerifier }) });
}

async function handleUnlinkIdentity(request, env, provider) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  const result = await unlinkIdentity(accountsDb(env), identity.userId, provider);
  if (!result.ok) {
    if (result.reason === "last_identity") {
      return fail(
        "Connect another sign-in method before removing this one.",
        409,
        "last_identity",
      );
    }
    return fail("That provider is not connected to this account.", 404, "not_found");
  }
  return json({ ok: true, provider });
}

function publicApiKey(row) {
  return {
    id: row.key_id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

/** The keys that authenticate `--provider axle` against the hosted gateway. */
async function handleListApiKeys(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  const rows = await listApiKeys(accountsDb(env), identity.userId);
  return json({ keys: rows.map(publicApiKey) });
}

/**
 * Mint a key. The plaintext is returned exactly once — only the hash is
 * stored, so a later read cannot recover it and the UI must copy it now.
 */
async function handleCreateApiKey(request, env) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Invalid request body.", 400);
  }
  const created = await createApiKey(accountsDb(env), {
    userId: identity.userId,
    name: typeof body.name === "string" ? body.name : null,
  });
  return json(
    {
      key: {
        id: created.keyId,
        name: typeof body.name === "string" && body.name.trim().length > 0
          ? body.name.trim().slice(0, 60)
          : null,
        prefix: created.prefix,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
      // Shown once. The worker cannot reproduce it later.
      secret: created.key,
    },
    201,
  );
}

async function handleRevokeApiKey(request, env, keyId) {
  const identity = await requireSession(request, env);
  if (!identity) return fail("A valid Axle session is required.", 401, "unauthorized");
  const revoked = await revokeApiKey(accountsDb(env), identity.userId, keyId);
  if (!revoked) return fail("That API key does not exist.", 404, "not_found");
  return json({ ok: true, id: keyId });
}

/**
 * Returns a Response for a handled auth route, or null so the caller can fall
 * through to the existing plugin/MCP router.
 */
export async function handleAuthRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!pathname.startsWith("/v1/auth") && pathname !== "/.well-known/jwks.json") return null;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  try {
    if (request.method === "GET" && pathname === "/.well-known/jwks.json") {
      return json(await jwksDocument(env), 200, { "Cache-Control": "public, max-age=300" });
    }

    if (request.method === "GET" && pathname === "/v1/auth/providers") {
      return json({ providers: configuredProviders(env), issuer: issuerFor(env) });
    }

    if (request.method === "GET" && pathname === "/v1/auth/desktop") {
      const providers = signInProviders(env);
      const nonce = randomToken(16);
      const mode = url.searchParams.get("mode") ?? "";
      if (mode !== "external") return html(framePage(providers, nonce), nonce);
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const valid = isDesktopRedirect(redirectUri) && state.length > 0;
      return html(
        externalPage(
          providers,
          nonce,
          (provider) =>
            `${baseUrl(request, env)}/v1/auth/start?provider=${encodeURIComponent(provider.id)}&state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirectUri)}`,
          valid ? null : "This sign-in link is missing its desktop callback and cannot be used.",
        ),
        nonce,
        valid ? 200 : 400,
      );
    }

    if (request.method === "GET" && pathname === "/v1/auth/start") {
      return await handleStart(request, env, url);
    }

    const callback = pathname.match(/^\/v1\/auth\/callback\/([a-z]+)$/u);
    if (request.method === "GET" && callback) {
      return await handleCallback(request, env, url, callback[1]);
    }

    if (request.method === "POST" && pathname === "/v1/auth/exchange") {
      return await handleExchange(request, env);
    }

    if (request.method === "POST" && pathname === "/v1/auth/desktop/claim") {
      return await handleDesktopClaim(request, env);
    }

    if (request.method === "POST" && pathname === "/v1/auth/restore") {
      return await handleRestore(request, env);
    }

    if (request.method === "POST" && pathname === "/v1/auth/link/start") {
      return await handleStartLink(request, env);
    }

    if (request.method === "PATCH" && pathname === "/v1/auth/profile") {
      return await handleUpdateProfile(request, env);
    }

    if (request.method === "GET" && pathname === "/v1/auth/api-keys") {
      return await handleListApiKeys(request, env);
    }

    if (request.method === "POST" && pathname === "/v1/auth/api-keys") {
      return await handleCreateApiKey(request, env);
    }

    if (request.method === "DELETE") {
      const sessionRoute = pathname.match(/^\/v1\/auth\/sessions\/([A-Za-z0-9_-]{8,120})$/u);
      if (sessionRoute) return await handleRevokeSession(request, env, sessionRoute[1]);
      const identityRoute = pathname.match(/^\/v1\/auth\/identities\/([a-z]{2,32})$/u);
      if (identityRoute) return await handleUnlinkIdentity(request, env, identityRoute[1]);
      const apiKeyRoute = pathname.match(/^\/v1\/auth\/api-keys\/([A-Za-z0-9_-]{8,120})$/u);
      if (apiKeyRoute) return await handleRevokeApiKey(request, env, apiKeyRoute[1]);
    }

    if (request.method === "GET" && pathname === "/v1/auth/me") {
      return await handleMe(request, env);
    }

    if ((request.method === "POST" || request.method === "DELETE") && pathname === "/v1/auth/signout") {
      return await handleSignOut(request, env);
    }

    return fail("Not found.", 404, "not_found");
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Sign-in request failed.", 500, "internal_error");
  }
}

export {
  base64UrlToBytes,
  desktopHandoffPage,
  isDesktopRedirect,
  issueSignInPayload,
  PROVIDERS as SIGNIN_PROVIDERS,
};
