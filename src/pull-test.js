import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { taskService, TaskService } from "./lifecycle.js";
import { createRequestListener } from "./http.js";
import { handleMcp } from "./mcp.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pull-test-"));
const config = { deliveryMode: "pull", dataDir: directory, botReportKey: "fake-executor-key",
  relayApiKey: "fake-caller-key", clientKeys: { other: "fake-other-key" }, callbackTargets: {},
  host: "127.0.0.1", allowedOrigins: [] };
const stdioAttempt = spawnSync(process.execPath, [fileURLToPath(new URL("./stdio.js", import.meta.url))], {
  env: { ...process.env, RELAY_DELIVERY_MODE: "pull", RELAY_DATA_DIR: directory,
    BOT_REPORT_KEY: "fake-executor-key", RELAY_API_KEY: "fake-caller-key",
    RELAY_CLIENT_KEYS: "{}", RELAY_CALLBACK_TARGETS: "{}" },
  input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
    name: "submitTaskToGrokBot", arguments: { title: "Unreachable task", objective: "Must not queue",
      source: "test", completion_criteria: ["Not accepted"] },
  } }) + "\n", encoding: "utf8", timeout: 5000,
});
assert.equal(stdioAttempt.error, undefined);
assert.equal(stdioAttempt.status, 1);
assert.equal(stdioAttempt.stdout, "");
assert.match(stdioAttempt.stderr, /Pull mode requires the HTTP service/);
assert.deepEqual(fs.readdirSync(directory), []);
console.log("ok stdio rejects pull mode without accepting tasks or acquiring the writer lock");
const service = taskService(config);
const server = http.createServer(createRequestListener(config, () => { throw new Error("Must not call webhook"); }));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const task = { title: "Queued task", objective: "Read a rich brief", source: "wecom",
  completion_criteria: ["Deliver result"], client_request_id: "request-1", markdown: "detail".repeat(2000) };
const caller = { authorization: "Bearer fake-caller-key", "content-type": "application/json" };
const executor = { authorization: "Bearer fake-executor-key", "content-type": "application/json" };
const post = (route, value, headers = executor) => fetch(base + route, { method: "POST", headers, body: JSON.stringify(value) });
try {
  const submitted = await post("/submit-task", task, caller);
  assert.equal(submitted.status, 202);
  const queued = await submitted.json();
  assert.equal(queued.status, "queued");
  assert.equal(queued.transport, null);
  assert.equal(queued.botAcknowledged, undefined);
  const id = queued.relayTaskId;
  const prefix = `/executor/tasks/${id}`;
  const duplicate = await post("/submit-task", task, caller);
  assert.equal(duplicate.status, 202);
  assert.equal((await duplicate.json()).relayTaskId, id);
  assert.equal((await fetch(base + "/executor/tasks", { headers: caller })).status, 401);
  assert.equal((await fetch(base + prefix + "/claim", { headers: caller })).status, 401);
  const inbox = await (await fetch(base + "/executor/tasks", { headers: executor })).json();
  assert.equal(inbox.tasks.length, 1);
  assert.equal(inbox.tasks[0].relay_task_id, id);
  const completion = { event_id: "done-1", status: "finished", summary: "Actually completed" };
  assert.equal((await post(prefix + "/report", completion)).status, 409);
  assert.equal((await post(prefix + "/claim", {})).status, 400);
  const claims = await Promise.all([post(prefix + "/claim", { claim_id: "worker-a-1" }),
    post(prefix + "/claim", { claim_id: "worker-b-1" })]);
  assert.deepEqual(claims.map((x) => x.status).sort(), [200, 409]);
  const winner = claims[0].status === 200 ? "worker-a-1" : "worker-b-1";
  assert.equal((await post(prefix + "/report", completion)).status, 409);
  completion.claim_id = winner;
  assert.equal((await (await post(prefix + "/claim", { claim_id: winner })).json()).deduplicated, true);
  assert.equal((await (await post("/submit-task", task, caller)).json()).status, "claimed");
  assert.equal((await post("/submit-task", task, caller)).status, 200);
  assert.equal((await (await fetch(base + "/executor/tasks", { headers: executor })).json()).tasks.length, 0);
  assert.equal((await (await fetch(base + prefix + "/manifest", { headers: executor })).json()).markdown, task.markdown);
  assert.equal((await fetch(base + `/tasks/${id}`, { headers: { authorization: "Bearer fake-other-key" } })).status, 404);
  const remoteMcp = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "submitTaskToGrokBot", arguments: { ...task, client_request_id: "http-mcp-request" },
  } }, caller);
  assert.equal(remoteMcp.status, 200);
  const mcpResult = (await remoteMcp.json()).result;
  assert.equal(mcpResult.isError, false);
  assert.equal(mcpResult.structuredContent.status, "queued");
  assert.equal((await post(`/executor/tasks/${mcpResult.structuredContent.relayTaskId}/claim`,
    { claim_id: "http-mcp-worker" })).status, 200);
  service.close();
  const restarted = new TaskService(config);
  assert.equal(restarted.get(id, "default").status, "claimed");
  assert.equal(restarted.claim(id, { claim_id: winner }).body.deduplicated, true);
  assert.equal(restarted.claim(id, { claim_id: "new-worker" }).status, 409);
  assert.equal((await restarted.report(id, completion)).status, 200);
  assert.equal((await restarted.report(id, completion)).body.deduplicated, true);
  assert.equal(restarted.get(id, "default").status, "finished");
  restarted.close();
  console.log("ok persistent pull inbox, exclusive claims, rich briefs, authentication and completion");
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  if (!service.closed) service.close();
  assert.equal(path.dirname(directory), os.tmpdir());
  fs.rmSync(directory, { recursive: true, force: true });
}

const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pull-test-"));
const dryConfig = { ...config, dataDir: dryDir };
try {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "submitTaskToGrokBot", arguments: { ...task, dry_run: true } } }, dryConfig,
    () => { throw new Error("Must not call webhook"); });
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.status, "dry_run");
  const dryService = taskService(dryConfig);
  assert.equal(dryService.inbox().length, 0);
  const id = response.result.structuredContent.relayTaskId;
  assert.equal(dryService.claim(id, { claim_id: "worker" }).status, 409);
  assert.equal((await dryService.report(id, { event_id: "done", status: "finished", summary: "x" })).status, 409);
  console.log("ok MCP pull dry run never enters the executor inbox");
} finally {
  taskService(dryConfig).close();
  assert.equal(path.dirname(dryDir), os.tmpdir());
  fs.rmSync(dryDir, { recursive: true, force: true });
}

const notifyDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pull-notify-"));
const notifyConfig = {
  deliveryMode: "pull",
  dataDir: notifyDir,
  botReportKey: "fake-executor-key",
  relayApiKey: "fake-caller-key",
  clientKeys: {},
  callbackTargets: {},
  webhookUrl: "https://example.test/hook",
  webhookKey: "fake-webhook-key",
  authHeader: "authorization",
  authScheme: "Bearer",
  timeoutMs: 3000,
  host: "127.0.0.1",
  allowedOrigins: [],
};
let notified = 0;
const notifyServer = http.createServer(createRequestListener(notifyConfig, async (_url, init) => {
  notified += 1;
  const body = JSON.parse(init.body);
  assert.match(body.relay_task_id, /^[a-f0-9-]{36}$/);
  return new Response(JSON.stringify({ ok: true, runUuid: "run-from-webhook" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}));
await new Promise((resolve) => notifyServer.listen(0, "127.0.0.1", resolve));
const notifyBase = `http://127.0.0.1:${notifyServer.address().port}`;
try {
  const submitted = await fetch(`${notifyBase}/submit-task`, {
    method: "POST",
    headers: { authorization: "Bearer fake-caller-key", "content-type": "application/json" },
    body: JSON.stringify({
      title: "Notify pull task",
      objective: "Reach Grok Bot even in pull mode",
      source: "chatgpt",
      completion_criteria: ["Bot can report progress"],
    }),
  });
  const body = await submitted.json();
  assert.equal(submitted.status, 200);
  assert.equal(notified, 1);
  assert.equal(body.status, "submitted");
  assert.equal(body.transportAccepted, true);
  assert.equal(body.botAcknowledged, false);
  assert.equal(body.runUuid, "run-from-webhook");
  assert.equal(body.receipt.relayTaskId, body.relayTaskId);
  assert.equal(body.receipt.statusTool, "getTaskStatus");
  const notifyService = taskService(notifyConfig);
  assert.equal(notifyService.inbox().length, 0);
  const progress = await fetch(`${notifyBase}/executor/tasks/${body.relayTaskId}/progress`, {
    method: "POST",
    headers: { authorization: "Bearer fake-executor-key", "content-type": "application/json" },
    body: JSON.stringify({ event_id: "recv-1", status: "received", summary: "Got the task." }),
  });
  assert.equal(progress.status, 200);
  assert.equal((await progress.json()).status, "received");
  console.log("ok pull mode with webhook notifies Grok Bot and accepts progress without claim");
} finally {
  notifyServer.closeAllConnections();
  await new Promise((resolve) => notifyServer.close(resolve));
  taskService(notifyConfig).close();
  assert.equal(path.dirname(notifyDir), os.tmpdir());
  fs.rmSync(notifyDir, { recursive: true, force: true });
}
