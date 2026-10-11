import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { progressStatus } from "./grok-status.js";
import { createRequestListener } from "./http.js";
import { TaskService } from "./lifecycle.js";
import { handleMcp } from "./mcp.js";

const failures = [];
const task = {
  schema_version: "1",
  title: "Plant notes",
  objective: "Record watering dates",
  completion_criteria: ["The notebook exists"],
  source: "chatgpt",
  dry_run: false,
};

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok ${name}`))
    .catch((error) => {
      failures.push(name);
      console.error(`fail ${name}: ${error instanceof Error ? error.stack : error}`);
    });
}

await check("ChatGPT can read Grok Bot progress for a webhook handoff", async () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-status-"));
  const config = {
    webhookUrl: "https://example.test/hook",
    webhookKey: "webhook-key",
    relayApiKey: "relay-key",
    botReportKey: "report-key",
    statusDir,
    host: "127.0.0.1",
    port: 8787,
    allowedOrigins: [],
    timeoutMs: 3000,
    authHeader: "authorization",
    authScheme: "Bearer",
  };
  const server = http.createServer(createRequestListener(config, async () => jsonResponse(200, { ok: true })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const submitted = await fetch(`${base}/submit-task`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer relay-key" },
      body: JSON.stringify(task),
    });
    const body = await submitted.json();
    assert.equal(submitted.status, 200);
    assert.equal(body.status, "submitted");
    assert.equal(body.transportAccepted, true);
    assert.match(body.relayTaskId, /^[a-f0-9-]{36}$/);

    const progress = await fetch(`${base}/executor/tasks/${body.relayTaskId}/progress`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer report-key" },
      body: JSON.stringify({ event_id: "step-1", status: "executing", summary: "Reading the brief." }),
    });
    const progressBody = await progress.json();
    assert.equal(progress.status, 200);
    assert.equal(progressBody.status, "executing");

    const listed = await handleMcp(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "getTaskStatus", arguments: { relay_task_id: body.relayTaskId } } },
      config,
    );
    assert.equal(listed.result.structuredContent.status, "executing");
    assert.equal(listed.result.structuredContent.summary, "Reading the brief.");

    const httpStatus = await fetch(`${base}/tasks/${body.relayTaskId}`, {
      headers: { authorization: "Bearer relay-key" },
    });
    const httpBody = await httpStatus.json();
    assert.equal(httpStatus.status, 200);
    assert.equal(httpBody.status, "executing");
    assert.equal(httpBody.receipt.relayTaskId, body.relayTaskId);

    const other = await handleMcp(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "getTaskStatus", arguments: { relay_task_id: body.relayTaskId } } },
      config,
      fetch,
      "someone-else",
    );
    assert.equal(other.result.structuredContent.error, "Task not found.");

    const closed = progressStatus(config, body.relayTaskId, { event_id: "step-2", status: "finished", summary: "Notebook saved." });
    assert.equal(closed.body.status, "finished");
    const again = progressStatus(config, body.relayTaskId, { event_id: "step-3", status: "executing", summary: "Still going." });
    assert.equal(again.status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

await check("a dry run cannot be marked finished", async () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-status-"));
  const config = {
    webhookUrl: "https://example.test/hook",
    webhookKey: "webhook-key",
    statusDir,
    timeoutMs: 3000,
    authHeader: "authorization",
    authScheme: "Bearer",
  };
  const submitted = await handleMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "submitTaskToGrokBot", arguments: { ...task, dry_run: true } } },
    config,
    async () => jsonResponse(200, { ok: true }),
  );
  const id = submitted.result.structuredContent.relayTaskId;
  assert.equal(submitted.result.structuredContent.status, "dry_run");
  const progress = progressStatus(config, id, { event_id: "nope", status: "finished", summary: "Done." });
  assert.equal(progress.status, 409);
  fs.rmSync(statusDir, { recursive: true, force: true });
});

await check("lifecycle progress is visible on the task view", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-life-"));
  const service = new TaskService({
    dataDir,
    deliveryMode: "webhook",
    botReportKey: "report-key",
    relayApiKey: "relay-key",
    webhookUrl: "https://example.test/hook",
    webhookKey: "webhook-key",
    timeoutMs: 1000,
  });
  try {
    const submitted = await service.submit(task, "alice", async () => jsonResponse(200, { ok: true }));
    const id = submitted.result.relayTaskId;
    const progress = await service.progress(id, { event_id: "work-1", status: "waiting_approval", summary: "Need approval to send." });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.status, "waiting_approval");
    assert.equal(service.get(id, "alice").updates[0].summary, "Need approval to send.");
    const duplicate = await service.progress(id, { event_id: "work-1", status: "waiting_approval", summary: "Need approval to send." });
    assert.equal(duplicate.body.deduplicated, true);
  } finally {
    service.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall grok status checks passed");

function jsonResponse(status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    status,
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: payload };
          },
          async cancel() {},
          releaseLock() {},
        };
      },
    },
  };
}
