import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { taskService, TaskService } from "./lifecycle.js";
import { createRequestListener } from "./http.js";
import { handleMcp } from "./mcp.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pull-test-"));
const config = { deliveryMode: "pull", dataDir: directory, botReportKey: "fake-executor-key",
  relayApiKey: "fake-caller-key", clientKeys: { other: "fake-other-key" }, callbackTargets: {},
  host: "127.0.0.1", allowedOrigins: [] };
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
