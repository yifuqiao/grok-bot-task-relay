import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./env.js";
import { createRequestListener } from "./http.js";
import { TaskService, taskService } from "./lifecycle.js";
import { handleMcp } from "./mcp.js";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const PR_HEAD = "c".repeat(40);
const failures = [];
const servers = [];
const dirs = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok ${name}`))
    .catch((error) => {
      failures.push(name);
      console.error(`fail ${name}: ${error instanceof Error ? error.stack : error}`);
    });
}

// One fake for the Grok Bot webhook, the GitHub API and the target health endpoint.
function fakeNet({ healthSha = SHA } = {}) {
  const calls = { webhook: [], github: [], health: 0 };
  const net = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://webhook.example/")) {
      calls.webhook.push(JSON.parse(options.body));
      return json(200, { ok: true });
    }
    if (href.startsWith("https://api.github.com/")) {
      assert.equal(options.headers.authorization, "Bearer fake-github-token");
      calls.github.push({ method: options.method, path: href.slice("https://api.github.com".length), body: options.body ? JSON.parse(options.body) : null });
      if (options.method === "GET") return json(200, { head: { sha: PR_HEAD } });
      return json(201, { id: 1 });
    }
    if (href === "https://app.example/health") {
      calls.health++;
      return json(200, { status: "up", build: { commit: net.healthSha } });
    }
    throw new Error(`unexpected request ${href}`);
  };
  net.healthSha = healthSha;
  net.calls = calls;
  return net;
}

function config(net, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-deploy-"));
  dirs.push(dataDir);
  return {
    dataDir, webhookUrl: "https://webhook.example/task", webhookKey: "fake-webhook-key",
    relayApiKey: "fake-caller-key", clientKeys: { claude: "fake-claude-key" }, botReportKey: "fake-executor-key",
    approvalKey: "fake-approval-key-0123456789", publicBaseUrl: "https://relay.example", callbackTargets: {},
    githubToken: "fake-github-token", githubRepos: ["yifuqiao/notes"],
    deployTargets: {
      "app-staging": { owners: ["default", "claude"], repo: "yifuqiao/app", environment: "staging",
        health_url: "https://app.example/health", health_sha_field: "build.commit" },
      "app-prod": { owners: ["claude"], repo: "yifuqiao/app", environment: "production",
        health_url: "https://app.example/health", health_sha_field: "build.commit", requires_approval: true },
      "docs": { repo: "yifuqiao/docs" },
    },
    fetchImpl: net, verifyAttempts: 1, verifyDelayMs: 0, approvalFailureDelayMs: 0,
    timeoutMs: 1000, host: "127.0.0.1", port: 0, allowedOrigins: [], ...extra,
  };
}

async function listen(settings) {
  const server = http.createServer(createRequestListener(settings, settings.fetchImpl));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function call(settings, name, args, owner = "claude") {
  const response = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    settings, settings.fetchImpl, owner);
  return response.result;
}

const executor = { "content-type": "application/json", authorization: "Bearer fake-executor-key" };
const post = (url, body, headers = executor) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

try {
  await check("deploy target configuration is validated", () => {
    const saved = process.env.RELAY_DEPLOY_TARGETS;
    try {
      process.env.RELAY_DEPLOY_TARGETS = JSON.stringify({ prod: { repo: "a/b", health_url: "http://insecure.example/health" } });
      assert.throws(() => loadConfig(), /RELAY_DEPLOY_TARGETS has invalid configuration/);
      process.env.RELAY_DEPLOY_TARGETS = JSON.stringify({ "Bad Name": { repo: "a/b" } });
      assert.throws(() => loadConfig(), /RELAY_DEPLOY_TARGETS/);
      process.env.RELAY_DEPLOY_TARGETS = JSON.stringify({ prod: { repo: "a/b", requires_approval: true } });
      assert.equal(loadConfig().deployTargets.prod.repo, "a/b");
    } finally {
      if (saved === undefined) delete process.env.RELAY_DEPLOY_TARGETS;
      else process.env.RELAY_DEPLOY_TARGETS = saved;
    }
    const net = fakeNet();
    assert.throws(() => new TaskService(config(net, { approvalKey: "fake-caller-key" })), /RELAY_APPROVAL_KEY must be separate/);
    assert.throws(() => new TaskService(config(net, { approvalKey: "" })), /need RELAY_APPROVAL_KEY/);
    assert.throws(() => new TaskService(config(net, { approvalKey: "short-approval-key" })), /at least 24 characters/);
  });

  await check("MCP lists deploy, wait and list tools", async () => {
    const listed = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { dataDir: "" });
    const names = listed.result.tools.map((tool) => tool.name);
    for (const name of ["deployRelease", "listDeployTargets", "waitForTask", "listTasks", "verifyDeployment"]) assert.ok(names.includes(name), name);
    assert.equal(names[0], "submitTaskToGrokBot");
  });

  await check("deploy targets are filtered by caller and unknown targets are refused", async () => {
    const net = fakeNet();
    const settings = config(net);
    const mine = await call(settings, "listDeployTargets", {}, "default");
    assert.deepEqual(mine.structuredContent.targets.map((t) => t.name).sort(), ["app-staging", "docs"]);
    assert.equal(mine.structuredContent.targets[0].health_url, undefined);
    const refused = await call(settings, "deployRelease", { target: "app-prod", commit_sha: SHA, source: "chatgpt" }, "default");
    assert.equal(refused.isError, true);
    assert.match(refused.structuredContent.error, /not registered for this caller/);
    const unknown = await call(settings, "deployRelease", { target: "nope", commit_sha: SHA, source: "claude" });
    assert.match(unknown.structuredContent.error, /listDeployTargets/);
    const branch = await call(settings, "deployRelease", { target: "app-staging", commit_sha: "main", source: "claude" });
    assert.equal(branch.isError, true);
    assert.equal(net.calls.webhook.length, 0);
    taskServiceClose(settings);
  });

  await check("a deploy goes to Grok Bot, is verified by the relay and receipted on the PR", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const submitted = await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA.toUpperCase(), pr_number: 7, source: "claude",
      rollback_sha: OTHER, notes: "Run migrations first." });
    assert.equal(submitted.isError, false);
    const task = submitted.structuredContent;
    assert.equal(task.status, "submitted");
    assert.equal(task.kind, "deploy");
    assert.equal(task.deploy.commit_sha, SHA);
    const sent = net.calls.webhook[0];
    assert.equal(sent.kind, "deploy");
    assert.deepEqual(sent.deploy, { target: "app-staging", repo: "yifuqiao/app", environment: "staging", commit_sha: SHA,
      pr_number: 7, rollback_sha: OTHER, health_url: "https://app.example/health", health_sha_field: "build.commit", report_deployed_sha: true });
    assert.equal(sent.relay_task_id, task.relayTaskId);
    const pending = net.calls.github.find((c) => c.path === `/repos/yifuqiao/app/statuses/${SHA}`);
    assert.equal(pending.body.state, "pending");
    assert.equal(pending.body.context, "grok-bot/deploy/app-staging");

    const again = await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 7, source: "claude",
      rollback_sha: OTHER, notes: "Run migrations first." });
    assert.equal(again.structuredContent.deduplicated, true);
    assert.equal(net.calls.webhook.length, 1);

    const id = task.relayTaskId;
    let response = await post(`${base}/executor/tasks/${id}/progress`, { event_id: "p1", status: "executing", summary: "Pulling @someone image" });
    assert.equal(response.status, 200);
    response = await post(`${base}/executor/tasks/${id}/report`, { event_id: "done", status: "finished", summary: "Deployed." });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /deployed_sha/);
    response = await post(`${base}/executor/tasks/${id}/report`, { event_id: "done", status: "finished",
      summary: "Deployed. token fake-webhook-key ping @yifuqiao", deployed_sha: SHA.slice(0, 12) });
    assert.equal(response.status, 200);
    const done = await response.json();
    assert.equal(done.status, "finished");
    assert.equal(done.verification.status, "verified");
    assert.equal(done.verification.observedSha, SHA);
    assert.equal(done.completion.deployed_sha, SHA.slice(0, 12));

    const statuses = net.calls.github.filter((c) => c.path.includes("/statuses/")).map((c) => c.body.state);
    assert.deepEqual(statuses, ["pending", "pending", "success"]);
    const comments = net.calls.github.filter((c) => c.path === "/repos/yifuqiao/app/issues/7/comments");
    assert.equal(comments.length, 1);
    const body = comments[0].body.body;
    assert.match(body, new RegExp(`grok-bot-relay:${id}:finished:verified`));
    assert.match(body, /verified/);
    assert.doesNotMatch(body, /fake-webhook-key/);
    assert.doesNotMatch(body, /@yifuqiao/);

    const repeat = await post(`${base}/executor/tasks/${id}/report`, { event_id: "done", status: "finished",
      summary: "Deployed. token fake-webhook-key ping @yifuqiao", deployed_sha: SHA.slice(0, 12) });
    assert.equal((await repeat.json()).deduplicated, true);
    assert.equal(net.calls.github.filter((c) => c.path.endsWith("/comments")).length, 1);

    const viewed = await fetch(`${base}/tasks/${id}`, { headers: { authorization: "Bearer fake-claude-key" } });
    const view = await viewed.json();
    assert.equal(view.github.comments.length, 1);
    assert.equal(view.github.error, null);
    taskServiceClose(settings);
  });

  await check("a deploy whose health shows another commit is reported as a mismatch", async () => {
    const net = fakeNet({ healthSha: OTHER });
    const settings = config(net);
    const base = await listen(settings);
    const { relayTaskId: id } = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 8, source: "claude" })).structuredContent;
    const response = await post(`${base}/executor/tasks/${id}/report`, { event_id: "done", status: "finished", summary: "Deployed.", deployed_sha: SHA });
    const done = await response.json();
    assert.equal(done.status, "finished");
    assert.equal(done.verification.status, "mismatch");
    assert.equal(net.calls.github.filter((c) => c.path.includes("/statuses/")).at(-1).body.state, "failure");

    net.healthSha = SHA;
    const again = await call(settings, "verifyDeployment", { relay_task_id: id });
    assert.equal(again.structuredContent.verification.status, "verified");
    assert.equal(net.calls.github.filter((c) => c.path.includes("/statuses/")).at(-1).body.state, "success");
    assert.equal(net.calls.github.filter((c) => c.path.endsWith("/comments")).length, 2);
    taskServiceClose(settings);
  });

  await check("a bot claiming a different deployed_sha is not verified", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const { relayTaskId: id } = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, source: "claude" })).structuredContent;
    const done = await (await post(`${base}/executor/tasks/${id}/report`, { event_id: "done", status: "finished", summary: "Deployed.", deployed_sha: OTHER })).json();
    assert.equal(done.verification.status, "mismatch");
    assert.equal(done.verification.botReportedSha, OTHER);
    taskServiceClose(settings);
  });

  await check("production deploys wait for a human approval that the caller key cannot give", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const held = (await call(settings, "deployRelease", { target: "app-prod", commit_sha: SHA, pr_number: 9, source: "claude" })).structuredContent;
    assert.equal(held.status, "awaiting_approval");
    assert.equal(held.approvalUrl, `https://relay.example/approvals/${held.relayTaskId}`);
    assert.equal(net.calls.webhook.length, 0);
    const comment = net.calls.github.find((c) => c.path === "/repos/yifuqiao/app/issues/9/comments");
    assert.match(comment.body.body, /approvals\//);

    const id = held.relayTaskId;
    assert.equal((await post(`${base}/executor/tasks/${id}/progress`, { event_id: "x", status: "executing", summary: "go" })).status, 409);
    const page = await fetch(`${base}/approvals/${id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /production/);
    assert.match(html, new RegExp(SHA));
    const form = (fields) => fetch(`${base}/approvals/${id}`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    assert.equal((await form({ approval_key: "fake-claude-key", decision: "approve" })).status, 401);
    assert.equal((await form({ approval_key: "fake-caller-key", decision: "approve" })).status, 401);
    assert.equal(net.calls.webhook.length, 0);
    const approved = await form({ approval_key: "fake-approval-key-0123456789", decision: "approve" });
    assert.equal(approved.status, 200);
    assert.match(await approved.text(), /已批准/);
    assert.equal(net.calls.webhook.length, 1);
    assert.equal(net.calls.webhook[0].deploy.environment, "production");
    const view = (await call(settings, "getTaskStatus", { relay_task_id: id })).structuredContent;
    assert.equal(view.status, "submitted");
    assert.equal(view.approval.decision, "approved");
    assert.equal((await form({ approval_key: "fake-approval-key-0123456789", decision: "approve" })).status, 409);
    assert.equal(net.calls.webhook.length, 1);

    const other = (await call(settings, "deployRelease", { target: "app-prod", commit_sha: OTHER, source: "claude" })).structuredContent;
    const declined = await fetch(`${base}/approvals/${other.relayTaskId}`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ approval_key: "fake-approval-key-0123456789", decision: "decline" }).toString() });
    assert.equal(declined.status, 200);
    const closed = (await call(settings, "getTaskStatus", { relay_task_id: other.relayTaskId })).structuredContent;
    assert.equal(closed.status, "rejected");
    assert.equal(net.calls.webhook.length, 1);
    taskServiceClose(settings);
  });

  await check("wrong approval keys are rate-limited per IP but the correct key always works", async () => {
    const net = fakeNet();
    const settings = config(net, { approvalFailMax: 3, approvalFailWindowMs: 60_000 });
    const base = await listen(settings);
    const { relayTaskId: id } = (await call(settings, "deployRelease", { target: "app-prod", commit_sha: SHA, source: "claude" })).structuredContent;
    const form = (key) => fetch(`${base}/approvals/${id}`, { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ approval_key: key, decision: "approve" }).toString() });
    assert.equal((await form("wrong-1")).status, 401);
    assert.equal((await form("wrong-2")).status, 401);
    assert.equal((await form("wrong-3")).status, 401);
    assert.equal((await form("wrong-4")).status, 429);
    assert.equal((await form("wrong-5")).status, 429);
    assert.equal(net.calls.webhook.length, 0);
    // Correct key bypasses and clears the per-IP lockout even after the stranger hit the cap.
    assert.equal((await form("fake-approval-key-0123456789")).status, 200);
    assert.equal(net.calls.webhook.length, 1);
    taskServiceClose(settings);
  });

  await check("pull executors read the resolved deploy details from the manifest", async () => {
    const net = fakeNet();
    const settings = config(net, { deliveryMode: "pull", webhookUrl: "", webhookKey: "" });
    const base = await listen(settings);
    const queued = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 5, notes: "Migrate first.", source: "claude" })).structuredContent;
    assert.equal(queued.status, "queued");
    assert.equal(net.calls.webhook.length, 0);
    const manifest = await (await fetch(`${base}/executor/tasks/${queued.relayTaskId}/manifest`, { headers: executor })).json();
    assert.equal(manifest.kind, "deploy");
    assert.equal(manifest.deploy.repo, "yifuqiao/app");
    assert.equal(manifest.deploy.environment, "staging");
    assert.equal(manifest.deploy.health_url, "https://app.example/health");
    assert.equal(manifest.deploy.health_sha_field, "build.commit");
    assert.equal(manifest.deploy.commit_sha, SHA);
    assert.equal(manifest.deploy.report_deployed_sha, true);
    assert.equal(manifest.deploy.notes, "Migrate first.");
    assert.deepEqual(manifest.github, { repo: "yifuqiao/app", pr_number: 5 });
    // Claim + finish using only the pull manifest fields an executor would see.
    assert.equal((await post(`${base}/executor/tasks/${queued.relayTaskId}/claim`, { claim_id: "pull-1" })).status, 200);
    const done = await (await post(`${base}/executor/tasks/${queued.relayTaskId}/report`, {
      claim_id: "pull-1", event_id: "done", status: "finished", summary: "Deployed from pull manifest.",
      deployed_sha: manifest.deploy.commit_sha,
    })).json();
    assert.equal(done.status, "finished");
    assert.equal(done.verification.status, "verified");
    taskServiceClose(settings);
  });

  await check("a retried finished report resumes verification lost to a restart", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const service = taskService(settings);
    const { relayTaskId: id } = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 6, source: "claude" })).structuredContent;
    const report = { event_id: "done", status: "finished", summary: "Deployed.", deployed_sha: SHA };
    const record = service.records.get(id);
    // State left behind when the relay stopped after saving the report and before verifying it.
    record.completion = { event_id: report.event_id, status: report.status, summary: report.summary, artifacts: [], deployed_sha: SHA };
    record.status = "finished";
    service.save(record);
    const replay = await (await post(`${base}/executor/tasks/${id}/report`, report)).json();
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.verification.status, "verified");
    assert.equal(net.calls.github.filter((c) => c.path === "/repos/yifuqiao/app/issues/6/comments").length, 1);
    taskServiceClose(settings);
  });

  await check("waitForTask returns on the next report and times out quietly", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const task = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, source: "claude" })).structuredContent;
    const quiet = await call(settings, "waitForTask", { relay_task_id: task.relayTaskId, since_updated_at: task.updatedAt, wait_seconds: 1 });
    assert.equal(quiet.structuredContent.timedOut, true);
    assert.equal(quiet.structuredContent.changed, false);
    const started = Date.now();
    const waiting = call(settings, "waitForTask", { relay_task_id: task.relayTaskId, since_updated_at: task.updatedAt, wait_seconds: 20 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await post(`${base}/executor/tasks/${task.relayTaskId}/progress`, { event_id: "r1", status: "received", summary: "Got it" });
    const woke = (await waiting).structuredContent;
    assert.ok(Date.now() - started < 5000);
    assert.equal(woke.changed, true);
    assert.equal(woke.status, "received");
    const viaHttp = await fetch(`${base}/tasks/${task.relayTaskId}?wait=1&since=${encodeURIComponent(woke.updatedAt)}`,
      { headers: { authorization: "Bearer fake-claude-key" } });
    assert.equal((await viaHttp.json()).timedOut, true);
    const stranger = await call(settings, "waitForTask", { relay_task_id: task.relayTaskId, wait_seconds: 0 }, "default");
    assert.equal(stranger.isError, true);
    taskServiceClose(settings);
  });

  await check("listTasks shows only this caller's tasks, over MCP and HTTP", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, source: "claude" });
    await call(settings, "deployRelease", { target: "docs", commit_sha: SHA, source: "chatgpt" }, "default");
    const mine = (await call(settings, "listTasks", {})).structuredContent.tasks;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].target, "app-staging");
    const listed = await fetch(`${base}/tasks`, { headers: { authorization: "Bearer fake-caller-key" } });
    const theirs = (await listed.json()).tasks;
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].target, "docs");
    const deploy = await fetch(`${base}/deploy`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-claude-key" },
      body: JSON.stringify({ target: "app-staging", commit_sha: OTHER, source: "claude" }) });
    assert.equal(deploy.status, 200);
    assert.equal((await deploy.json()).kind, "deploy");
    taskServiceClose(settings);
  });

  await check("ordinary tasks can carry PR receipts only for allowed repositories", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const task = { title: "Write notes", objective: "Summarise the PR", completion_criteria: ["Notes posted"], source: "claude" };
    const refused = await call(settings, "submitTaskToGrokBot", { ...task, github: { repo: "someone/else", pr_number: 1 } });
    assert.equal(refused.isError, true);
    assert.match(refused.structuredContent.error, /not allowed/);
    const accepted = (await call(settings, "submitTaskToGrokBot", { ...task, github: { repo: "yifuqiao/notes", pr_number: 3 } })).structuredContent;
    assert.equal(accepted.status, "submitted");
    assert.deepEqual(net.calls.webhook.at(-1).github, { repo: "yifuqiao/notes", pr_number: 3 });
    assert.equal(net.calls.github[0].method, "GET");
    assert.equal(net.calls.github[1].path, `/repos/yifuqiao/notes/statuses/${PR_HEAD}`);
    await post(`${base}/executor/tasks/${accepted.relayTaskId}/report`, { event_id: "done", status: "failed", summary: "Could not reach the repo." });
    const failed = net.calls.github.filter((c) => c.path.includes("/statuses/")).at(-1);
    assert.equal(failed.body.state, "failure");
    assert.equal(net.calls.github.filter((c) => c.path === "/repos/yifuqiao/notes/issues/3/comments").length, 1);
    taskServiceClose(settings);
  });

  await check("GitHub failures are recorded without changing the task result", async () => {
    const net = fakeNet();
    const broken = async (url, options) => (String(url).startsWith("https://api.github.com/") ? json(403, { message: "nope" }) : net(url, options));
    const settings = config(broken);
    const result = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 2, source: "claude" })).structuredContent;
    assert.equal(result.status, "submitted");
    assert.match(result.github.error, /HTTP 403/);
    assert.doesNotMatch(JSON.stringify(result), /fake-github-token/);
    taskServiceClose(settings);
  });

  await check("an intake bot reports forwarded and the executing bot still closes the task", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const task = { title: "Sort then run", objective: "Route to the right bot", completion_criteria: ["Done"], source: "claude",
      github: { repo: "yifuqiao/notes", pr_number: 4 } };
    const { relayTaskId: id } = (await call(settings, "submitTaskToGrokBot", task)).structuredContent;
    await post(`${base}/executor/tasks/${id}/progress`, { event_id: "sort-received", status: "received", summary: "Intake got it" });
    const forwarded = await post(`${base}/executor/tasks/${id}/progress`, { event_id: "sort-forwarded", status: "forwarded", summary: "Sent to the ops bot" });
    assert.equal(forwarded.status, 200);
    assert.equal((await forwarded.json()).status, "forwarded");
    assert.match(net.calls.github.filter((c) => c.path.includes("/statuses/")).at(-1).body.description, /Forwarded/);
    await post(`${base}/executor/tasks/${id}/progress`, { event_id: "ops-executing", status: "executing", summary: "Ops bot running" });
    const done = await post(`${base}/executor/tasks/${id}/progress`, { event_id: "ops-finished", status: "finished", summary: "Ops bot finished" });
    assert.equal(done.status, 200);
    const view = await done.json();
    assert.equal(view.status, "finished");
    assert.deepEqual(view.updates.map((u) => u.status), ["received", "forwarded", "executing"]);
    taskServiceClose(settings);
  });

  await check("the echo token proves the executing bot read the original manifest", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const task = { title: "Long brief", objective: "Follow the five steps", completion_criteria: ["All five steps done"], source: "claude",
      markdown: "# Five steps\n" + "step\n".repeat(50) };
    const submitted = (await call(settings, "submitTaskToGrokBot", task)).structuredContent;
    const id = submitted.relayTaskId;
    assert.equal(submitted.integrity.status, "unconfirmed");
    const sent = net.calls.webhook.at(-1);
    assert.equal(sent.manifest_echo_required, true);
    assert.match(sent.payload_sha256, /^[a-f0-9]{64}$/);
    assert.equal(sent.task_manifest_url, `https://relay.example/executor/tasks/${id}/manifest`);
    assert.doesNotMatch(JSON.stringify(sent), /ECHO-/);
    assert.doesNotMatch(JSON.stringify(submitted), /ECHO-/);

    const manifest = await (await fetch(`${base}/executor/tasks/${id}/manifest`, { headers: executor })).json();
    assert.equal(Object.keys(manifest).at(-1), "integrity");
    assert.match(manifest.integrity.echo_token, /^ECHO-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    assert.equal(manifest.integrity.payload_sha256, sent.payload_sha256);
    assert.equal(manifest.markdown, task.markdown.trim());

    await post(`${base}/executor/tasks/${id}/progress`, { event_id: "sort", status: "forwarded", summary: "To the ops bot" });
    let view = (await call(settings, "getTaskStatus", { relay_task_id: id })).structuredContent;
    assert.equal(view.integrity.status, "unconfirmed");
    const bad = await post(`${base}/executor/tasks/${id}/progress`, { event_id: "ops-1", status: "received", summary: "Got a summary", echo_token: "ECHO-AAAA-BBBB" });
    assert.equal(bad.status, 200);
    assert.equal((await bad.json()).integrity.status, "mismatch");
    const good = await post(`${base}/executor/tasks/${id}/progress`, { event_id: "ops-2", status: "executing", summary: "Read the manifest",
      echo_token: ` ${manifest.integrity.echo_token.toLowerCase()} ` });
    view = await good.json();
    assert.equal(view.integrity.status, "verified");
    assert.equal(view.integrity.event_id, "ops-2");
    await post(`${base}/executor/tasks/${id}/progress`, { event_id: "ops-3", status: "finished", summary: "Done" });
    view = (await call(settings, "getTaskStatus", { relay_task_id: id })).structuredContent;
    assert.equal(view.status, "finished");
    assert.equal(view.integrity.status, "verified");
    assert.equal((await post(`${base}/executor/tasks/${id}/progress`, { event_id: "x", status: "executing", summary: "late", echo_token: 42 })).status, 409);
    taskServiceClose(settings);
  });

  await check("a rejected report does not change the integrity record", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const { relayTaskId: id } = (await call(settings, "deployRelease", { target: "app-staging", commit_sha: SHA, pr_number: 11, source: "claude" })).structuredContent;
    const bad = await post(`${base}/executor/tasks/${id}/report`, { event_id: "d", status: "finished", summary: "Done", echo_token: "ECHO-AAAA-BBBB" });
    assert.equal(bad.status, 400);
    const view = (await call(settings, "getTaskStatus", { relay_task_id: id })).structuredContent;
    assert.equal(view.integrity.status, "unconfirmed");
    const manifest = await (await fetch(`${base}/executor/tasks/${id}/manifest`, { headers: executor })).json();
    const done = await (await post(`${base}/executor/tasks/${id}/report`, { event_id: "d", status: "finished", summary: "Done",
      deployed_sha: SHA, echo_token: manifest.integrity.echo_token })).json();
    assert.equal(done.integrity.status, "verified");
    const comment = net.calls.github.filter((c) => c.path === "/repos/yifuqiao/app/issues/11/comments").at(-1).body.body;
    assert.match(comment, /原文核对：\*\*verified/);
    taskServiceClose(settings);
  });

  await check("health reports the running commit", async () => {
    const net = fakeNet();
    const settings = config(net);
    const base = await listen(settings);
    const health = await (await fetch(`${base}/health`)).json();
    assert.ok(health.commit === null || /^[a-f0-9]{40}$/.test(health.commit));
    assert.equal(health.version, "1.2.0");
    taskServiceClose(settings);
  });
} finally {
  for (const server of servers) server.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} deploy checks failed`);
  process.exit(1);
}
console.log("\nall deploy checks passed");

function taskServiceClose(settings) {
  for (const server of servers.splice(0)) server.close();
  taskService(settings)?.close();
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
