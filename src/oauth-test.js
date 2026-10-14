import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./env.js";
import { createRequestListener, startServer } from "./http.js";
import { assertOAuthPublicBase, createOAuth, publicBaseFrom, relayKeyAccepted } from "./oauth.js";

const failures = [];
const redirectUri = "http://127.0.0.1/callback";
const challenge = createHash("sha256").update("relay-oauth-verifier-0123456789").digest("base64url");

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok ${name}`))
    .catch((error) => {
      failures.push(name);
      console.error(`fail ${name}: ${error instanceof Error ? error.stack : error}`);
    });
}

await check("empty relay key is never accepted", () => {
  assert.equal(relayKeyAccepted("", ""), false);
  assert.equal(relayKeyAccepted("", "   "), false);
  assert.equal(relayKeyAccepted("   ", "   "), false);
  assert.equal(relayKeyAccepted("secret", ""), false);
  assert.equal(relayKeyAccepted("", "secret"), false);
  assert.equal(relayKeyAccepted(undefined, "secret"), false);
  assert.equal(relayKeyAccepted("secret", "secret"), true);
});

await check("authorize submit rejects an empty relay key even when a transaction exists", () => {
  const emptyServer = seededOAuth("");
  const blank = emptyServer.oauth.authorizeSubmit({ txn: "txn-1", relay_key: "" });
  assert.equal(blank.status, 401);
  assert.equal(blank.location, undefined);
  assert.equal(Object.keys(readStore(emptyServer.storePath).codes).length, 0);

  const anyKey = emptyServer.oauth.authorizeSubmit({ txn: "txn-1", relay_key: "not-the-key" });
  assert.equal(anyKey.status, 401);
  assert.equal(anyKey.location, undefined);
  assert.equal(Object.keys(readStore(emptyServer.storePath).codes).length, 0);

  const emptySubmitted = seededOAuth("relay-key").oauth.authorizeSubmit({ txn: "txn-1", relay_key: "" });
  assert.equal(emptySubmitted.status, 401);
  assert.equal(emptySubmitted.location, undefined);

  const whitespace = seededOAuth("relay-key").oauth.authorizeSubmit({ txn: "txn-1", relay_key: "   " });
  assert.equal(whitespace.status, 401);
  assert.equal(whitespace.location, undefined);

  const allowed = seededOAuth("relay-key").oauth.authorizeSubmit({ txn: "txn-1", relay_key: "relay-key" });
  assert.equal(allowed.status, 302);
  assert.ok(new URL(allowed.location).searchParams.get("code"));
});

await check("consent page refuses OAuth when the relay key is not configured", () => {
  const { oauth } = seededOAuth("");
  const page = oauth.authorizePage(authorizeQuery("existing-client"), "http://127.0.0.1:8787");
  assert.equal(page.status, 401);
  assert.equal(page.html.includes('name="txn"'), false);
  assert.match(page.html, /not available/);
});

await check("unregistered client_id is rejected and not stored", () => {
  const storePath = tempStore();
  const oauth = createOAuth({ relayApiKey: "relay-key", oauthStorePath: storePath });
  const page = oauth.authorizePage(authorizeQuery("chatgpt"), "http://127.0.0.1:8787");
  assert.equal(page.status, 400);
  assert.match(page.html, /not registered/);
  assert.equal(page.html.includes('name="txn"'), false);
  assert.equal(fs.existsSync(storePath), false);
});

await check("a previously stored client can still authorize", () => {
  const { oauth, storePath } = seededOAuth("relay-key");
  const page = oauth.authorizePage(authorizeQuery("existing-client"), "http://127.0.0.1:8787");
  assert.equal(page.status, 200);
  const txn = page.html.match(/name="txn" value="([^"]+)"/)?.[1];
  const allowed = oauth.authorizeSubmit({ txn, relay_key: "relay-key" });
  assert.equal(allowed.status, 302);
  const stored = readStore(storePath);
  assert.deepEqual(Object.keys(stored.clients), ["existing-client"]);
  assert.deepEqual(stored.clients["existing-client"].redirectUris, [redirectUri]);
});

await check("registered client cannot use a redirect URI outside its registration", () => {
  const { oauth } = seededOAuth("relay-key");
  const page = oauth.authorizePage(
    authorizeQuery("existing-client", "https://evil.example/callback"),
    "http://127.0.0.1:8787",
  );
  assert.equal(page.status, 400);
  assert.match(page.html, /not registered for this client/);
});

await check("Grok and Muse register explicitly before authorize", async () => {
  const storePath = tempStore();
  const server = http.createServer(createRequestListener(listenerConfig("relay-key", storePath)));
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const grok = await register(base, {
      client_name: "Grok",
      redirect_uris: ["https://grok.com/connectors-oauth-exchange-code/"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(grok.status, 201);
    assert.ok(grok.body.client_id);
    assert.deepEqual(grok.body.redirect_uris, ["https://grok.com/connectors-oauth-exchange-code/"]);
    const grokPage = await fetch(authorizeUrl(base, grok.body.client_id, grok.body.redirect_uris[0]));
    assert.equal(grokPage.status, 200);
    await grokPage.arrayBuffer();

    const muse = await register(base, {
      client_name: "Muse Code",
      redirect_uris: ["http://127.0.0.1:53682/oauth/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    assert.equal(muse.status, 201);
    const musePage = await fetch(authorizeUrl(base, muse.body.client_id, muse.body.redirect_uris[0]));
    assert.equal(musePage.status, 200);
    await musePage.arrayBuffer();

    const skipped = await fetch(authorizeUrl(base, "muse", "http://127.0.0.1:53682/oauth/callback"));
    const skippedHtml = await skipped.text();
    assert.equal(skipped.status, 400);
    assert.match(skippedHtml, /not registered/);
  } finally {
    server.close();
  }
});

await check("metadata ignores X-Forwarded-Host when no public base is configured", async () => {
  const server = http.createServer(createRequestListener(listenerConfig("relay-key", tempStore(), "")));
  await listen(server);
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, {
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.issuer, `http://127.0.0.1:${port}`);
    assert.equal(JSON.stringify(body).includes("evil.example"), false);
  } finally {
    server.close();
  }
});

await check("configured public base wins over forwarded headers", () => {
  const req = {
    headers: {
      host: "evil.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    },
  };
  assert.equal(publicBaseFrom(req, { publicBaseUrl: "https://relay.example" }), "https://relay.example");
  assert.equal(
    publicBaseFrom(
      { headers: { host: "127.0.0.1:8787", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https" } },
      { publicBaseUrl: "" },
    ),
    "http://127.0.0.1:8787",
  );
  assert.equal(
    publicBaseFrom(req, { publicBaseUrl: "", port: 8787 }),
    "http://127.0.0.1:8787",
  );
});

await check("production startup requires RELAY_PUBLIC_BASE_URL", async () => {
  assert.throws(
    () => assertOAuthPublicBase({ publicBaseUrl: "", nodeEnv: "production" }),
    /RELAY_PUBLIC_BASE_URL is required in production/,
  );
  assert.throws(
    () => assertOAuthPublicBase({ nodeEnv: "Production" }),
    /X-Forwarded-Host/,
  );
  assertOAuthPublicBase({ publicBaseUrl: "https://relay.example", nodeEnv: "production" });

  const warnings = [];
  const original = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  try {
    assertOAuthPublicBase({ publicBaseUrl: "", nodeEnv: "development" });
  } finally {
    console.error = original;
  }
  assert.match(warnings.join("\n"), /ignores X-Forwarded-Host/);

  await assert.rejects(
    async () => startServer({
      relayApiKey: "relay-key",
      host: "127.0.0.1",
      port: 0,
      nodeEnv: "production",
      publicBaseUrl: "",
      oauthStorePath: "",
      clientKeys: {},
    }),
    /RELAY_PUBLIC_BASE_URL is required in production/,
  );
});

await check("non-production still starts without a public base and warns", async () => {
  const warnings = [];
  const original = console.error;
  console.error = (...args) => warnings.push(args.join(" "));
  let server;
  try {
    server = await startServer({
      relayApiKey: "",
      clientKeys: { alice: "alice-key" },
      host: "127.0.0.1",
      port: 0,
      nodeEnv: "",
      publicBaseUrl: "",
      oauthStorePath: tempStore(),
      deliveryMode: "webhook",
    });
    const port = server.address().port;
    const registered = await register(`http://127.0.0.1:${port}`, {
      client_name: "local",
      redirect_uris: [redirectUri],
    });
    assert.equal(registered.status, 201);
    const page = await fetch(authorizeUrl(`http://127.0.0.1:${port}`, registered.body.client_id, redirectUri));
    const html = await page.text();
    assert.equal(page.status, 401);
    assert.match(html, /not available/);
    const listed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer alice-key",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const listedBody = await listed.json();
    assert.equal(listed.status, 200);
    assert.equal(listedBody.result.tools[0].name, "submitTaskToGrokBot");
  } finally {
    console.error = original;
    server?.close();
  }
  assert.match(warnings.join("\n"), /X-Forwarded-Host/);
});

await check("loadConfig records NODE_ENV for the production check", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.equal(loadConfig().nodeEnv, "production");
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall oauth checks passed");

function authorizeQuery(clientId, redirect = redirectUri) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "chat-state",
  };
}

function seededOAuth(relayApiKey) {
  const storePath = tempStore();
  fs.writeFileSync(storePath, JSON.stringify({
    clients: { "existing-client": { redirectUris: [redirectUri], name: "ChatGPT" } },
    codes: {},
    tokens: {},
    refresh: {},
    txns: {
      "txn-1": {
        clientId: "existing-client",
        redirectUri,
        challenge,
        oauthState: "chat-state",
        expiresAt: Date.now() + 60_000,
      },
    },
  }));
  return { storePath, oauth: createOAuth({ relayApiKey, oauthStorePath: storePath }) };
}

function readStore(storePath) {
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function tempStore() {
  return path.join(os.tmpdir(), `grok-oauth-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
}

function listenerConfig(relayApiKey, storePath, publicBaseUrl = "https://relay.example") {
  return {
    webhookUrl: "",
    webhookKey: "",
    relayApiKey,
    authHeader: "authorization",
    authScheme: "Bearer",
    timeoutMs: 3000,
    host: "127.0.0.1",
    port: 8787,
    allowedOrigins: [],
    publicBaseUrl,
    oauthStorePath: storePath,
    deliveryMode: "webhook",
    clientKeys: {},
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function authorizeUrl(base, clientId, redirect) {
  const start = new URL(`${base}/authorize`);
  const query = authorizeQuery(clientId, redirect);
  for (const [key, value] of Object.entries(query)) start.searchParams.set(key, value);
  return start;
}

async function register(base, body) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
