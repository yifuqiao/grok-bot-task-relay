import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { detectAck, forwardTask } from "./forward.js";
import { createRequestListener } from "./http.js";
import { handleMcp } from "./mcp.js";
import { validateAndNormalize } from "./task.js";

const webhookKey = "webhook-key-test-value";
const relayKey = "relay-key-test-value";

const ping = {
  schema_version: "1",
  title: "relay-ping",
  objective: "Confirm webhook delivery to New Bot",
  context: "Connectivity test from the local relay self-test",
  completion_criteria: ["Bot acks in Grok Bot chat with task_id"],
  priority: "normal",
  source: "selftest",
  dry_run: true,
};

const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok ${name}`))
    .catch((error) => {
      failures.push(name);
      console.error(`fail ${name}: ${error instanceof Error ? error.message : error}`);
    });
}

await check("rejects an incomplete task", () => {
  const result = validateAndNormalize({ title: "x" });
  assert.equal(result.ok, false);
});

await check("rejects a plan that is too large for the webhook", () => {
  const result = validateAndNormalize({
    ...ping,
    context: "x".repeat(4000),
  });
  assert.equal(result.ok, false);
});

await check("normalizes the dry-run ping", () => {
  const result = validateAndNormalize(ping);
  assert.equal(result.ok, true);
  assert.equal(result.task.dry_run, true);
  assert.equal(result.task.schema_version, "1");
});

await check("keeps runUuid as transport metadata without treating it as an acknowledgment", () => {
  const ack = detectAck({ ok: true, runUuid: "run-abc" });
  assert.equal(ack.acknowledged, false);
  assert.equal(ack.taskId, null);
});

await check("rejects unsupported schema versions and overlong criteria without sending", async () => {
  for (const patch of [
    { schema_version: "2" },
    { completion_criteria: "x".repeat(501) },
    { completion_criteria: ["x".repeat(501)] },
  ]) {
    let calls = 0;
    const reply = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "submitTaskToGrokBot", arguments: { ...ping, ...patch } } },
      { webhookUrl: "http://unused", webhookKey },
      async () => { calls++; return new Response('{}'); },
    );
    assert.equal(reply.result.isError, true);
    assert.equal(calls, 0);
  }
});

await check("malformed MCP envelopes cannot forward a task", async () => {
  for (const patch of [
    { jsonrpc: "1.0" }, { jsonrpc: undefined }, { id: {} }, { id: true },
    { method: 7 }, { params: "invalid" }, { params: null },
  ]) {
    let calls = 0;
    const reply = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "submitTaskToGrokBot", arguments: ping }, ...patch },
      { webhookUrl: "http://unused", webhookKey },
      async () => { calls++; return new Response('{}'); },
    );
    assert.equal(reply.error.code, -32600);
    assert.equal(calls, 0);
  }
});

await check("rejected webhook responses never count as bot acknowledgment", async () => {
  const result = await forwardTask(ping, { webhookUrl: "http://unused", webhookKey },
    async () => new Response(JSON.stringify({ task_id: "rejected-id", ack: true }), { status: 500 }));
  assert.equal(result.httpStatus, 500);
  assert.equal(result.transportAccepted, false);
  assert.equal(result.botAcknowledged, false);
  assert.equal(result.taskId, null);
});

await check("a broken response body preserves the observed status and reports ambiguity", async () => {
  let calls = 0;
  const reply = await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "submitTaskToGrokBot", arguments: ping } },
    { webhookUrl: "http://unused", webhookKey },
    async () => {
      calls++;
      return new Response(new ReadableStream({
        start(controller) { controller.error(new Error(`socket closed ${webhookKey}`)); },
      }), { status: 200 });
    },
  );
  assert.equal(calls, 1);
  assert.equal(reply.result.isError, true);
  const result = reply.result.structuredContent;
  assert.equal(result.httpStatus, 200);
  assert.equal(result.submitted, true);
  assert.equal(result.transportAccepted, true);
  assert.equal(result.botAcknowledged, false);
  assert.equal(JSON.stringify(result).includes(webhookKey), false);
  assert.match(result.error, /response body/i);
});

await check("oversized webhook bodies are cancelled without retrying", async () => {
  let cancelled = false;
  let calls = 0;
  const result = await forwardTask(ping, { webhookUrl: "http://unused", webhookKey }, async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
      cancel() { cancelled = true; },
    }), { status: 200 });
  });
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.botAcknowledged, false);
  assert.match(result.error, /response body/i);
});

await check("timeout during a real response body keeps HTTP 200 without another POST", async () => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.flushHeaders();
    res.write('{"ack":');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const result = await forwardTask(ping, {
      webhookUrl: `http://127.0.0.1:${server.address().port}/hook`,
      webhookKey,
      // Leave time for CI's cold fetch startup; the body deliberately never completes.
      timeoutMs: 2000,
    });
    assert.equal(calls, 1);
    assert.equal(result.httpStatus, 200);
    assert.equal(result.transportAccepted, true);
    assert.equal(result.botAcknowledged, false);
    assert.match(result.error, /response body/i);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

await check("does not treat a generic acceptance body as a bot ack", () => {
  const ack = detectAck({ ok: true, message: "accepted" });
  assert.equal(ack.acknowledged, false);
  assert.equal(ack.taskId, null);
});

await check("records a task id only when the response contains one", () => {
  const ack = detectAck({ task_id: "task-123" });
  assert.equal(ack.acknowledged, true);
  assert.equal(ack.taskId, "task-123");
});

const fake = await startFakeWebhook();

await check("missing webhook config does not send", async () => {
  const result = await forwardTask(ping, { webhookUrl: "", webhookKey: "" }, fake.fetch);
  assert.equal(result.submitted, false);
  assert.equal(result.httpStatus, null);
  assert.equal(fake.count, 0);
});

await check("sends one dry run and keeps the webhook key out of the result", async () => {
  const before = fake.count;
  const result = await forwardTask(
    ping,
    {
      webhookUrl: fake.url,
      webhookKey,
      authHeader: "authorization",
      authScheme: "Bearer",
      timeoutMs: 3000,
    },
    fake.fetch,
  );
  assert.equal(fake.count, before + 1);
  assert.equal(result.transportAccepted, true);
  assert.equal(result.botAcknowledged, false);
  assert.equal(result.httpStatus, 200);
  assert.equal(result.dry_run, true);
  assert.equal(fake.lastBody.dry_run, true);
  assert.equal(fake.lastAuth, `Bearer ${webhookKey}`);
  assert.equal(JSON.stringify(result).includes(webhookKey), false);
});

await check("redacts a webhook key echoed by the response", async () => {
  fake.nextBody = { echo: webhookKey, ok: true };
  const result = await forwardTask(
    ping,
    {
      webhookUrl: fake.url,
      webhookKey,
      authHeader: "authorization",
      authScheme: "Bearer",
      timeoutMs: 3000,
    },
  );
  assert.equal(result.response.echo, "[redacted]");
  assert.equal(JSON.stringify(result).includes(webhookKey), false);
  fake.nextBody = { ok: true };
});

await check("does not follow a redirect or send a second request", async () => {
  fake.nextStatus = 302;
  const before = fake.count;
  const result = await forwardTask(
    ping,
    {
      webhookUrl: fake.url,
      webhookKey,
      authHeader: "authorization",
      authScheme: "Bearer",
      timeoutMs: 3000,
    },
    fake.fetch,
  );
  assert.equal(fake.count, before + 1);
  assert.equal(result.transportAccepted, false);
  assert.equal(result.httpStatus, 302);
  assert.equal(result.botAcknowledged, false);
  fake.nextStatus = 200;
});

await check("MCP lists submitTaskToGrokBot and returns transport status", async () => {
  fake.nextBody = { ok: true };
  const listed = await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { webhookUrl: fake.url, webhookKey, authScheme: "Bearer", timeoutMs: 3000 },
  );
  assert.equal(listed.result.tools[0].name, "submitTaskToGrokBot");
  assert.equal(listed.result.tools[1].name, "getRelayInfo");

  const info = await handleMcp(
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "getRelayInfo", arguments: {} } },
    { webhookUrl: fake.url, webhookKey, authScheme: "Bearer", timeoutMs: 3000, deliveryMode: "webhook", statusDir: "data/grok-status", botReportKey: "report" },
  );
  assert.equal(info.result.isError, false);
  assert.equal(info.result.structuredContent.version, "1.2.0");
  assert.equal(info.result.structuredContent.name, "grok-bot-task-relay");

  const called = await handleMcp(
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "submitTaskToGrokBot", arguments: ping },
    },
    { webhookUrl: fake.url, webhookKey, authScheme: "Bearer", timeoutMs: 3000 },
  );
  assert.equal(called.result.isError, false);
  assert.equal(called.result.structuredContent.transportAccepted, true);
  assert.equal(called.result.structuredContent.botAcknowledged, false);
  assert.equal(called.result.structuredContent.httpStatus, 200);
});

await check("MCP reports an observed task id as acknowledgment evidence", async () => {
  fake.nextBody = { task_id: "observed-1" };
  const called = await handleMcp(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "submitTaskToGrokBot", arguments: ping },
    },
    { webhookUrl: fake.url, webhookKey, authScheme: "Bearer", timeoutMs: 3000 },
  );
  assert.equal(called.result.structuredContent.botAcknowledged, true);
  assert.equal(called.result.structuredContent.taskId, "observed-1");
  assert.equal(called.result.structuredContent.acknowledgment, "task_id");
});

await check("HTTP submit requires the relay key and posts once", async () => {
  const config = {
    webhookUrl: fake.url,
    webhookKey,
    relayApiKey: relayKey,
    authHeader: "authorization",
    authScheme: "Bearer",
    timeoutMs: 3000,
    host: "127.0.0.1",
    port: 8787,
    allowedOrigins: [],
  };
  const server = http.createServer(createRequestListener(config));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = address.port;
  config.port = port;
  const endpoint = `http://127.0.0.1:${port}/submit-task`;
  const before = fake.count;
  fake.nextBody = { ok: true };

  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", host: `127.0.0.1:${port}` },
    body: JSON.stringify(ping),
  });
  assert.equal(denied.status, 401);
  assert.equal(fake.count, before);

  const accepted = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${relayKey}`,
      host: `127.0.0.1:${port}`,
    },
    body: JSON.stringify(ping),
  });
  const payload = await accepted.json();
  assert.equal(accepted.status, 200);
  assert.equal(fake.count, before + 1);
  assert.equal(payload.transportAccepted, true);
  assert.equal(payload.botAcknowledged, false);
  assert.equal(JSON.stringify(payload).includes(webhookKey), false);
  assert.equal(JSON.stringify(payload).includes(relayKey), false);
  const tunneled = await requestLocal(port, {
    method: "GET",
    path: "/health",
    headers: { host: "example.trycloudflare.com" },
  });
  assert.equal(tunneled.status, 200);

  const rebound = await requestLocal(port, {
    method: "GET",
    path: "/health",
    headers: { host: "evil.example", origin: "https://evil.example" },
  });
  assert.equal(rebound.status, 403);
  server.close();
});

await check("OAuth discovery and consent issue a bearer token", async () => {
  const storePath = path.join(os.tmpdir(), `grok-oauth-${randomBytes(4).toString("hex")}.json`);
  const server = http.createServer(
    createRequestListener({
      webhookUrl: "",
      webhookKey: "",
      relayApiKey: relayKey,
      authHeader: "authorization",
      authScheme: "Bearer",
      timeoutMs: 3000,
      host: "127.0.0.1",
      port: 8787,
      allowedOrigins: [],
      publicBaseUrl: "",
      oauthStorePath: storePath,
      deliveryMode: "webhook",
    }),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const metadata = await fetch(`${base}/.well-known/oauth-authorization-server`);
  const discovered = await metadata.json();
  assert.equal(metadata.status, 200);
  assert.equal(discovered.authorization_endpoint, `${base}/authorize`);
  assert.equal(discovered.token_endpoint, `${base}/token`);
  assert.ok(discovered.code_challenge_methods_supported.includes("S256"));

  const unauthenticated = await fetch(`${base}/mcp`);
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.headers.get("www-authenticate") || "", /resource_metadata=/);
  await unauthenticated.arrayBuffer();

  const verifier = "relay-oauth-verifier-0123456789";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirectUri = "http://127.0.0.1/callback";
  const registered = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "ChatGPT", redirect_uris: [redirectUri] }),
  });
  const client = await registered.json();
  assert.equal(registered.status, 201);
  assert.ok(client.client_id);
  const start = new URL(`${base}/authorize`);
  start.searchParams.set("response_type", "code");
  start.searchParams.set("client_id", client.client_id);
  start.searchParams.set("redirect_uri", redirectUri);
  start.searchParams.set("code_challenge", challenge);
  start.searchParams.set("code_challenge_method", "S256");
  start.searchParams.set("state", "chat-state");
  const page = await fetch(start);
  const html = await page.text();
  const txn = html.match(/name="txn" value="([^"]+)"/)?.[1];
  assert.ok(txn);

  const denied = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ txn, relay_key: "wrong-key" }),
  });
  assert.equal(denied.status, 401);
  await denied.arrayBuffer();

  const allowed = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ txn, relay_key: relayKey }),
    redirect: "manual",
  });
  assert.equal(allowed.status, 302);
  const location = new URL(allowed.headers.get("location"));
  assert.equal(location.searchParams.get("state"), "chat-state");
  const code = location.searchParams.get("code");
  assert.ok(code);

  const tokenResponse = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const token = await tokenResponse.json();
  assert.equal(tokenResponse.status, 200);
  assert.equal(token.token_type, "Bearer");
  assert.equal(JSON.stringify(token).includes(relayKey), false);

  const listed = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(listedBody.result.tools[0].name, "submitTaskToGrokBot");
  server.close();
});

await new Promise((resolve) => fake.server.close(resolve));

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall checks passed");

function requestLocal(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, ...options }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
}

function startFakeWebhook() {
  const state = {
    count: 0,
    lastBody: null,
    lastAuth: "",
    nextStatus: 200,
    nextBody: { ok: true },
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      state.count += 1;
      state.lastAuth = String(req.headers.authorization || "");
      state.lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (state.nextStatus === 302) {
        res.writeHead(302, { location: "http://127.0.0.1/not-followed" });
        res.end();
        return;
      }
      const payload = JSON.stringify(state.nextBody);
      res.writeHead(state.nextStatus, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/hook`,
        fetch,
        get count() {
          return state.count;
        },
        get lastBody() {
          return state.lastBody;
        },
        get lastAuth() {
          return state.lastAuth;
        },
        set nextStatus(value) {
          state.nextStatus = value;
        },
        set nextBody(value) {
          state.nextBody = value;
        },
      });
    });
  });
}
