import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { continueCursorTask, getCursorTask, listCursorRepos, startCursorTask } from "./cursor.js";
import { handleMcp } from "./mcp.js";

const cursorKey = "cursor-key-test-value";
const githubToken = "github-token-test-value";
const failures = [];
const task = {
  title: "Plant notes",
  objective: "Keep a private notebook of plant watering dates",
  completion_criteria: ["A pull request contains the notebook"],
  source: "chatgpt",
  client_request_id: "chat-1",
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

await check("dry run does not create a repository or a Cursor agent", async () => {
  const fetchImpl = mustNotFetch();
  const outcome = await startCursorTask(
    { ...task, dry_run: true },
    config(fetchImpl.path),
    fetchImpl.impl,
  );
  assert.equal(outcome.isError, false);
  assert.equal(outcome.result.dry_run, true);
  assert.equal(outcome.result.accepted, false);
  assert.equal(outcome.result.repoName, "plant-notes");
  assert.equal(fetchImpl.calls.length, 0);
});

await check("a new task creates one private repository and launches Cursor once", async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(201, { html_url: "https://github.com/example/plant-notes" }),
    jsonResponse(200, {
      agent: { id: "bc-00000000-0000-0000-0000-000000000001", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001", status: "ACTIVE" },
      run: { id: "run-00000000-0000-0000-0000-000000000001", status: "CREATING" },
    }),
  ]);
  const outcome = await startCursorTask(task, config(fetchImpl.path), fetchImpl.impl);
  assert.equal(outcome.result.accepted, true);
  assert.equal(outcome.result.createdRepository, true);
  assert.equal(outcome.result.repoUrl, "https://github.com/example/plant-notes");
  assert.equal(outcome.result.agentId, "bc-00000000-0000-0000-0000-000000000001");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, "https://api.github.com/user/repos");
  assert.equal(fetchImpl.calls[0].body.private, true);
  assert.equal(fetchImpl.calls[0].body.name, "plant-notes");
  assert.equal(fetchImpl.calls[1].url, "https://api.cursor.com/v1/agents");
  assert.equal(fetchImpl.calls[1].body.autoCreatePR, true);
  assert.equal(JSON.stringify(outcome.result).includes(cursorKey), false);
  assert.equal(JSON.stringify(outcome.result).includes(githubToken), false);

  const again = await startCursorTask(task, config(fetchImpl.path), mustNotFetch().impl);
  assert.equal(again.result.deduplicated, true);
  assert.equal(again.result.agentId, outcome.result.agentId);
});

await check("a taken repository name is tried once more", async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(422, { message: "Validation Failed", errors: [{ message: "name already exists on this account" }] }),
    jsonResponse(201, { html_url: "https://github.com/example/plant-notes-harbor" }),
    jsonResponse(200, {
      agent: { id: "bc-00000000-0000-0000-0000-000000000002", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000002", status: "ACTIVE" },
      run: { id: "run-00000000-0000-0000-0000-000000000002", status: "CREATING" },
    }),
  ]);
  const outcome = await startCursorTask(
    { ...task, client_request_id: "chat-2" },
    config(fetchImpl.path),
    fetchImpl.impl,
  );
  assert.equal(outcome.result.accepted, true);
  assert.equal(fetchImpl.calls.length, 3);
  assert.notEqual(fetchImpl.calls[1].body.name, "plant-notes");
});

await check("ChatGPT can read the pull request and send one follow-up", async () => {
  const handoff = path.join(os.tmpdir(), `cursor-handoff-${Date.now()}-read.json`);
  const started = scriptedFetch([
    jsonResponse(201, { html_url: "https://github.com/example/plant-notes" }),
    jsonResponse(200, {
      agent: { id: "bc-00000000-0000-0000-0000-000000000003", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000003", status: "ACTIVE" },
      run: { id: "run-00000000-0000-0000-0000-000000000003", status: "CREATING" },
    }),
  ], handoff);
  await startCursorTask({ ...task, client_request_id: "chat-3" }, config(handoff), started.impl);

  const status = scriptedFetch([
    jsonResponse(200, { id: "bc-00000000-0000-0000-0000-000000000003", url: "https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000003", status: "IDLE", latestRunId: "run-00000000-0000-0000-0000-000000000004" }),
    jsonResponse(200, {
      id: "run-00000000-0000-0000-0000-000000000004",
      status: "FINISHED",
      result: "Opened the notebook.",
      git: { branches: [{ repoUrl: "github.com/example/plant-notes", branch: "cursor/notes", prUrl: "https://github.com/example/plant-notes/pull/2" }] },
    }),
  ], handoff);
  const read = await getCursorTask({ agent_id: "bc-00000000-0000-0000-0000-000000000003" }, config(handoff), status.impl);
  assert.equal(read.result.finished, true);
  assert.equal(read.result.pullRequests[0].prUrl, "https://github.com/example/plant-notes/pull/2");

  const otherOwner = await getCursorTask({ agent_id: "bc-00000000-0000-0000-0000-000000000003" }, config(handoff), mustNotFetch().impl, "someone-else");
  assert.equal(otherOwner.isError, true);

  const follow = scriptedFetch([
    jsonResponse(200, { run: { id: "run-00000000-0000-0000-0000-000000000005", status: "CREATING" } }),
  ], handoff);
  const sent = await continueCursorTask(
    { agent_id: "bc-00000000-0000-0000-0000-000000000003", message: "Also add a watering reminder" },
    config(handoff),
    follow.impl,
  );
  assert.equal(sent.result.accepted, true);
  assert.equal(follow.calls.length, 1);
  assert.equal(follow.calls[0].body.prompt.text, "Also add a watering reminder");
});

await check("a rejected Cursor launch is not retried and does not echo secrets", async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(201, { html_url: "https://github.com/example/plant-notes" }),
    jsonResponse(401, { message: `bad ${cursorKey}` }),
  ]);
  const outcome = await startCursorTask({ ...task, client_request_id: "chat-4" }, config(fetchImpl.path), fetchImpl.impl);
  assert.equal(outcome.isError, true);
  assert.equal(outcome.result.repoUrl, "https://github.com/example/plant-notes");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(JSON.stringify(outcome.result).includes(cursorKey), false);
});

await check("repository choices are listed before a Cursor handoff", async () => {
  const fetchImpl = scriptedFetch([
    jsonResponse(200, [
      { full_name: "example/plant-notes", html_url: "https://github.com/example/plant-notes", private: true, description: `notes ${githubToken}` },
      { full_name: "example/other", html_url: "https://github.com/example/other", private: false, description: "unrelated" },
    ]),
  ]);
  const listed = await listCursorRepos({ query: "plant" }, config(fetchImpl.path), fetchImpl.impl);
  assert.equal(listed.isError, false);
  assert.equal(listed.result.repositories.length, 1);
  assert.equal(listed.result.repositories[0].url, "https://github.com/example/plant-notes");
  assert.equal(JSON.stringify(listed.result).includes(githubToken), false);
  assert.equal(fetchImpl.calls.length, 1);

  const missing = await listCursorRepos({}, { cursorGithubToken: "" }, mustNotFetch().impl);
  assert.equal(missing.result.repositories.length, 0);
  assert.match(missing.result.error, /new private repository/);
});

await check("MCP lists the Cursor handoff beside the Grok Bot tool", async () => {
  const listed = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { dataDir: "" });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(names[0], "submitTaskToGrokBot");
  assert.ok(names.includes("listCursorRepos"));
  assert.ok(names.includes("startCursorTask"));
  assert.ok(names.includes("getCursorTask"));
  assert.ok(names.includes("continueCursorTask"));
});

if (failures.length) {
  console.error(`\n${failures.length} failed`);
  process.exit(1);
}
console.log("\nall cursor checks passed");

function config(handoffPath) {
  return {
    cursorApiKey: cursorKey,
    cursorGithubToken: githubToken,
    cursorHandoffPath: handoffPath,
    timeoutMs: 3000,
  };
}

function mustNotFetch() {
  return {
    path: path.join(os.tmpdir(), `cursor-handoff-${Date.now()}-none.json`),
    calls: [],
    impl: async () => {
      throw new Error("network was called");
    },
  };
}

function scriptedFetch(responses, handoffPath = path.join(os.tmpdir(), `cursor-handoff-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)) {
  const calls = [];
  return {
    path: handoffPath,
    calls,
    impl: async (url, options) => {
      calls.push({ url, body: options.body ? JSON.parse(options.body) : null });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next;
    },
  };
}

function jsonResponse(status, body) {
  return { status, async text() { return JSON.stringify(body); } };
}

process.on("exit", () => {
  for (const entry of fs.readdirSync(os.tmpdir())) {
    if (entry.startsWith("cursor-handoff-")) fs.rmSync(path.join(os.tmpdir(), entry), { force: true });
  }
});
