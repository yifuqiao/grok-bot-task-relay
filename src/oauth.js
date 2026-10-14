import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ACCESS_TTL_SEC = 60 * 60 * 12;
const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const TXN_TTL_MS = 10 * 60 * 1000;

export function createOAuth(config) {
  const filePath = config.oauthStorePath;
  const state = filePath ? loadStore(filePath) : { clients: {}, codes: {}, tokens: {}, refresh: {}, txns: {} };

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  return {
    metadata(base) {
      const resource = `${base}/mcp`;
      return {
        protectedResource: {
          resource,
          authorization_servers: [base],
          scopes_supported: ["mcp"],
          bearer_methods_supported: ["header"],
        },
        authorizationServer: {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp"],
        },
      };
    },

    authenticateHeader(base) {
      return `Bearer realm="grok-bot-task-relay", resource_metadata="${base}/.well-known/oauth-protected-resource"`;
    },

    hasAccessToken(token) {
      prune(state);
      const row = state.tokens[token];
      return Boolean(row && row.expiresAt > Date.now());
    },

    register(body) {
      const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
      if (!redirectUris.length || redirectUris.some((uri) => !allowedRedirect(uri))) {
        return { status: 400, body: { error: "invalid_client_metadata" } };
      }
      const clientId = randomBytes(16).toString("base64url");
      state.clients[clientId] = {
        redirectUris,
        name: String(body.client_name || "MCP client").slice(0, 120),
      };
      persist();
      return {
        status: 201,
        body: {
          client_id: clientId,
          client_name: state.clients[clientId].name,
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      };
    },

    authorizePage(query, base) {
      const checked = checkAuthorizeQuery(query, state);
      if (checked.error) return { status: 400, html: page("Cannot start sign-in", escapeHtml(checked.error)) };
      if (!presentSecret(config.relayApiKey)) {
        return { status: 401, html: page("Sign-in unavailable", "OAuth sign-in is not available on this relay.") };
      }
      const txn = randomBytes(18).toString("base64url");
      state.txns[txn] = { ...checked, expiresAt: Date.now() + TXN_TTL_MS };
      persist();
      const html = page(
        "Connect Grok Bot",
        `<p>Enter the relay key to let this app submit tasks. The key stays on this server and is not sent to the chat app.</p>
         <form method="post" action="${escapeHtml(base)}/authorize">
           <input type="hidden" name="txn" value="${escapeHtml(txn)}">
           <label>Relay key <input type="password" name="relay_key" autocomplete="current-password" required></label>
           <button type="submit">Allow</button>
         </form>`,
      );
      return { status: 200, html };
    },

    authorizeSubmit(form) {
      prune(state);
      const txn = state.txns[form.txn];
      if (!txn || txn.expiresAt <= Date.now()) {
        return { status: 400, html: page("Sign-in expired", "Start the connection again from the chat app.") };
      }
      const client = state.clients[txn.clientId];
      if (!client || !Array.isArray(client.redirectUris) || !client.redirectUris.includes(txn.redirectUri)) {
        delete state.txns[form.txn];
        persist();
        return { status: 400, html: page("Cannot start sign-in", "client_id is not registered.") };
      }
      if (!relayKeyAccepted(form.relay_key, config.relayApiKey)) {
        return {
          status: 401,
          html: page(
            "Key did not match",
            `<p>The relay key was not accepted.</p>
             <form method="post" action="/authorize">
               <input type="hidden" name="txn" value="${escapeHtml(form.txn)}">
               <label>Relay key <input type="password" name="relay_key" autocomplete="current-password" required></label>
               <button type="submit">Allow</button>
             </form>`,
          ),
        };
      }
      delete state.txns[form.txn];
      const code = randomBytes(24).toString("base64url");
      state.codes[code] = {
        clientId: txn.clientId,
        redirectUri: txn.redirectUri,
        challenge: txn.challenge,
        expiresAt: Date.now() + CODE_TTL_MS,
      };
      persist();
      const location = new URL(txn.redirectUri);
      location.searchParams.set("code", code);
      if (txn.oauthState) location.searchParams.set("state", txn.oauthState);
      return { status: 302, location: location.toString() };
    },

    token(form) {
      prune(state);
      if (form.grant_type === "authorization_code") return exchangeCode(state, form, persist);
      if (form.grant_type === "refresh_token") return exchangeRefresh(state, form, persist);
      return { status: 400, body: { error: "unsupported_grant_type" } };
    },
  };
}

export function publicBaseFrom(req, config) {
  const configured = typeof config.publicBaseUrl === "string" ? config.publicBaseUrl.trim() : "";
  if (configured) return configured;
  const host = String(req.headers?.host || "").split(",")[0].trim();
  if (isLoopbackHost(host)) return `http://${host}`;
  return `http://127.0.0.1:${config.port || 8787}`;
}

export function assertOAuthPublicBase(config) {
  if (typeof config.publicBaseUrl === "string" && config.publicBaseUrl.trim()) return;
  const production = String(config.nodeEnv || "").trim().toLowerCase() === "production";
  const message = production
    ? "RELAY_PUBLIC_BASE_URL is required in production. Refusing to start because OAuth will not trust X-Forwarded-Host."
    : "RELAY_PUBLIC_BASE_URL is not set. OAuth metadata ignores X-Forwarded-Host and X-Forwarded-Proto. Set RELAY_PUBLIC_BASE_URL before using a public hostname.";
  if (production) throw new Error(message);
  console.error(`warning: ${message}`);
}

function exchangeCode(state, form, persist) {
  const row = state.codes[form.code];
  if (!row || row.expiresAt <= Date.now()) return { status: 400, body: { error: "invalid_grant" } };
  if (row.clientId !== form.client_id || row.redirectUri !== form.redirect_uri) {
    return { status: 400, body: { error: "invalid_grant" } };
  }
  const challenge = createHash("sha256").update(form.code_verifier || "").digest("base64url");
  if (!safeEqual(challenge, row.challenge)) return { status: 400, body: { error: "invalid_grant" } };
  delete state.codes[form.code];
  const issued = issueTokens(state, row.clientId);
  persist();
  return { status: 200, body: issued };
}

function exchangeRefresh(state, form, persist) {
  const row = state.refresh[form.refresh_token];
  if (!row || row.expiresAt <= Date.now() || row.clientId !== form.client_id) {
    return { status: 400, body: { error: "invalid_grant" } };
  }
  delete state.refresh[form.refresh_token];
  delete state.tokens[row.accessToken];
  const issued = issueTokens(state, row.clientId);
  persist();
  return { status: 200, body: issued };
}

function issueTokens(state, clientId) {
  const accessToken = randomBytes(32).toString("base64url");
  const refreshToken = randomBytes(32).toString("base64url");
  state.tokens[accessToken] = { clientId, expiresAt: Date.now() + ACCESS_TTL_SEC * 1000 };
  state.refresh[refreshToken] = {
    clientId,
    accessToken,
    expiresAt: Date.now() + REFRESH_TTL_MS,
  };
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SEC,
    refresh_token: refreshToken,
    scope: "mcp",
  };
}

function checkAuthorizeQuery(query, state) {
  if (query.response_type !== "code") return { error: "response_type must be code." };
  if (query.code_challenge_method !== "S256" || !query.code_challenge) {
    return { error: "PKCE S256 is required." };
  }
  if (!query.client_id) return { error: "client_id is required." };
  const client = state.clients[query.client_id];
  if (!client || !Array.isArray(client.redirectUris)) return { error: "client_id is not registered." };
  if (!allowedRedirect(query.redirect_uri || "")) return { error: "redirect_uri is not allowed." };
  if (!client.redirectUris.includes(query.redirect_uri)) {
    return { error: "redirect_uri is not registered for this client." };
  }
  return {
    clientId: query.client_id,
    redirectUri: query.redirect_uri,
    challenge: query.code_challenge,
    oauthState: query.state || "",
  };
}

function allowedRedirect(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) return true;
  } catch {
    return false;
  }
  return false;
}

function prune(state) {
  const now = Date.now();
  for (const [key, row] of Object.entries(state.codes || {})) if (row.expiresAt <= now) delete state.codes[key];
  for (const [key, row] of Object.entries(state.txns || {})) if (row.expiresAt <= now) delete state.txns[key];
  for (const [key, row] of Object.entries(state.tokens || {})) if (row.expiresAt <= now) delete state.tokens[key];
  for (const [key, row] of Object.entries(state.refresh || {})) if (row.expiresAt <= now) delete state.refresh[key];
}

function loadStore(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return {
      clients: parsed.clients || {},
      codes: parsed.codes || {},
      tokens: parsed.tokens || {},
      refresh: parsed.refresh || {},
      txns: parsed.txns || {},
    };
  } catch {
    return { clients: {}, codes: {}, tokens: {}, refresh: {}, txns: {} };
  }
}

export function relayKeyAccepted(submitted, expected) {
  if (!presentSecret(expected) || !presentSecret(submitted)) return false;
  return safeEqual(submitted, expected);
}

function presentSecret(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isLoopbackHost(host) {
  if (!host) return false;
  try {
    const name = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return name === "127.0.0.1" || name === "localhost" || name === "::1";
  } catch {
    return false;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}
