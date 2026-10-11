import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { TaskService, taskService } from "./lifecycle.js";
import { handleMcp } from "./mcp.js";
import { createRequestListener } from "./http.js";

const dirs = [];
const servers = [];
const config = () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  dirs.push(dataDir);
  return { dataDir, webhookUrl: "https://webhook.example/task", webhookKey: "fake-webhook-key",
    relayApiKey: "fake-caller-key", clientKeys: { alice: "fake-alice-key", bob: "fake-bob-key" },
    botReportKey: "fake-executor-key", publicBaseUrl: "https://relay.example",
    callbackTargets: {}, timeoutMs: 1000, host: "127.0.0.1", port: 0, allowedOrigins: [] };
};
const task = { title: "Attachment task", objective: "Read the attached specification", source: "wecom",
  completion_criteria: ["Return the completed result"], source_thread: "conversation-1" };
const ok = async () => new Response('{"ok":true}', { status: 200 });
async function listen(listener) {
  const server = http.createServer(listener);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

try {
  const settings = config();
  let service = new TaskService(settings);
  let posts = 0;
  let sent;
  const rich = { ...task, client_request_id: "request-1", markdown: "# Full brief\n" + "细节".repeat(3000),
    attachments: [{ name: "example.png", url: "https://files.example/example.png", mime_type: "image/png", size_bytes: 100 }] };
  const first = await service.submit(rich, "alice", async (_url, options) => {
    posts++;
    sent = JSON.parse(options.body);
    assert.ok(Buffer.byteLength(options.body) <= 3000);
    return ok();
  });
  assert.equal(first.isError, false);
  assert.equal(first.result.status, "submitted");
  assert.equal(first.result.botAcknowledged, false);
  assert.ok(sent.task_manifest_url);
  assert.equal(sent.markdown, undefined);
  assert.equal(service.get(first.result.relayTaskId, "alice").task.markdown, rich.markdown);
  const duplicate = await service.submit(rich, "alice", async () => { posts++; return ok(); });
  assert.equal(duplicate.result.deduplicated, true);
  assert.equal(posts, 1);
  assert.equal((await service.submit({ ...rich, objective: "Changed" }, "alice", ok)).isError, true);
  assert.equal(service.get(first.result.relayTaskId, "bob"), null);
  assert.throws(() => new TaskService(settings), /already has a writer/);
  service.close();
  service = new TaskService(settings);
  assert.equal((await service.submit(rich, "alice", () => { throw new Error("Must not resend"); })).result.deduplicated, true);
  console.log("ok rich manifest preservation, caller isolation and durable idempotency");

  const invalid = await service.submit({ ...task, attachments: [{ name: "x", url: "file:///secret", mime_type: "text/plain" }] }, "alice", ok);
  assert.equal(invalid.isError, true);
  assert.equal((await service.submit({ ...task, callback_target: "arbitrary" }, "alice", ok)).isError, true);
  const missingManifest = new TaskService({ ...config(), publicBaseUrl: "" });
  assert.equal((await missingManifest.submit(rich, "alice", () => { throw new Error("Must not send"); })).isError, true);
  console.log("ok invalid attachments, unknown callbacks and missing manifest configuration rejected");

  const pendingConfig = config();
  const pending = new TaskService(pendingConfig);
  let pendingCalls = 0;
  const uncertain = await pending.submit({ ...task, client_request_id: "uncertain" }, "alice", async () => {
    pendingCalls++;
    throw new Error("lost network");
  });
  assert.equal(uncertain.result.status, "unknown");
  assert.equal((await pending.submit({ ...task, client_request_id: "uncertain" }, "alice", ok)).result.deduplicated, true);
  assert.equal(pendingCalls, 1);
  let release;
  let concurrentPosts = 0;
  const delayed = pending.submit({ ...task, client_request_id: "in-flight" }, "alice", () => {
    concurrentPosts++;
    return new Promise((resolve) => { release = resolve; });
  });
  const inFlight = await pending.submit({ ...task, client_request_id: "in-flight" }, "alice", () => { throw new Error("Duplicate POST"); });
  assert.equal(inFlight.result.deduplicated, true);
  assert.equal(inFlight.result.status, "submitting");
  release(await ok());
  await delayed;
  assert.equal(concurrentPosts, 1);
  console.log("ok ambiguous submissions do not retry");

  let callbackCalls = 0;
  let callbackStatus = 503;
  const events = [];
  const callbackUrl = await listen((req, res) => {
    callbackCalls++;
    assert.equal(req.headers.authorization, "Bearer fake-callback-key");
    const chunks = [];
    req.on("data", (data) => chunks.push(data));
    req.on("end", () => {
      events.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(callbackStatus);
      res.end("fake-callback-key");
    });
  });
  const appConfig = config();
  // Loopback HTTP is injected only in tests. Environment callback configuration requires HTTPS.
  appConfig.callbackTargets.wecom = { url: callbackUrl, owner: "alice", apiKey: "fake-callback-key" };
  const appService = taskService(appConfig);
  const submitted = await appService.submit({ ...task, callback_target: "wecom" }, "alice", ok);
  const id = submitted.result.relayTaskId;
  const endpoint = await listen(createRequestListener(appConfig, ok));
  const badOrigin = await fetch(`${endpoint}/tasks/${id}`, { headers: {
    authorization: `Bearer ${appConfig.clientKeys.alice}`, origin: "https://untrusted.example",
  } });
  assert.equal(badOrigin.status, 403);
  const headers = { authorization: `Bearer ${appConfig.botReportKey}`, "content-type": "application/json" };
  const completion = { event_id: "completion-1", status: "finished", summary: "Read and implemented the specification",
    artifacts: [{ name: "result.md", url: "https://files.example/result.md", mime_type: "text/markdown" }] };
  const badAuth = await fetch(`${endpoint}/executor/tasks/${id}/report`, { method: "POST",
    headers: { ...headers, authorization: `Bearer ${appConfig.clientKeys.alice}` }, body: JSON.stringify(completion) });
  assert.equal(badAuth.status, 401);
  const reported = await fetch(`${endpoint}/executor/tasks/${id}/report`, { method: "POST", headers, body: JSON.stringify(completion) });
  assert.equal(reported.status, 200);
  const result = await reported.json();
  assert.equal(result.status, "finished");
  assert.equal(result.callback.status, "failed");
  assert.equal(result.callback.httpStatus, 503);
  assert.equal(callbackCalls, 1);
  assert.equal(JSON.stringify(result).includes("fake-callback-key"), false);
  const again = await fetch(`${endpoint}/executor/tasks/${id}/report`, { method: "POST", headers, body: JSON.stringify(completion) });
  assert.equal((await again.json()).deduplicated, true);
  assert.equal(callbackCalls, 1);
  const conflict = await fetch(`${endpoint}/executor/tasks/${id}/report`, { method: "POST", headers,
    body: JSON.stringify({ ...completion, status: "failed" }) });
  assert.equal(conflict.status, 409);
  callbackStatus = 200;
  const retried = await fetch(`${endpoint}/tasks/${id}/notify`, { method: "POST",
    headers: { authorization: `Bearer ${appConfig.clientKeys.alice}` } });
  assert.equal((await retried.json()).callback.status, "delivered");
  assert.equal(callbackCalls, 2);
  assert.equal(events[0].event_id, events[1].event_id);
  assert.equal(events[1].source_thread, task.source_thread);
  const denied = await fetch(`${endpoint}/tasks/${id}`, { headers: { authorization: `Bearer ${appConfig.clientKeys.bob}` } });
  assert.equal(denied.status, 404);
  assert.equal((await fetch(`${endpoint}/executor/tasks/${id}/manifest`, { headers })).status, 200);
  console.log("ok authenticated completion, isolated API reads, callback failures and explicit delivery retry");

  const query = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "getTaskResult", arguments: { relay_task_id: id } } }, appConfig, ok, "alice");
  assert.equal(query.result.structuredContent.status, "finished");
  const deniedQuery = await handleMcp({ jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "getTaskResult", arguments: { relay_task_id: id } } }, appConfig, ok, "bob");
  assert.equal(deniedQuery.result.isError, true);
  const mcpQuery = await fetch(`${endpoint}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${appConfig.clientKeys.alice}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "getTaskStatus", arguments: { relay_task_id: id } } }),
  });
  assert.equal((await mcpQuery.json()).result.structuredContent.status, "finished");
  const dry = await appService.submit({ ...task, dry_run: true }, "alice", ok);
  assert.equal((await appService.report(dry.result.relayTaskId, completion)).status, 409);
  appService.close();
  const completedStore = new TaskService(appConfig);
  assert.equal(completedStore.get(id, "alice").completion.summary, completion.summary);
  assert.equal(completedStore.get(id, "alice").callback.status, "delivered");
  completedStore.close();
  console.log("ok MCP result queries and dry-run completion protection");
  console.log("all lifecycle checks passed");
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const directory of dirs) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith("relay-test-"));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
