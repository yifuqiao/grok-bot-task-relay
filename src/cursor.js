import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const CURSOR_API = "https://api.cursor.com";
const GITHUB_API = "https://api.github.com/user/repos";
const NAME_SUFFIXES = ["harbor", "maple", "slate", "cedar", "brook"];
const memory = new Map();

export const CURSOR_TOOLS = [
  {
    name: "listCursorRepos",
    title: "List repositories Cursor can use",
    description:
      "List existing GitHub repositories before handing work to Cursor. Call once when the user asks to send work to Cursor but has not yet chosen a repository. Show the returned repositories as choices, and also offer to create a new private repository. Do not call startCursorTask from this result.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 80, description: "Optional name filter." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "startCursorTask",
    title: "Hand one task to Cursor",
    description:
      "Hand one approved task to a Cursor cloud agent. Call once, only after the user has chosen a new private repository or one existing repository. Omit repo_url when they chose a new repository. Pass repo_url when they chose an existing one. accepted means Cursor accepted the launch, not that the work finished. Do not retry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["title", "objective", "completion_criteria", "source"],
      properties: {
        title: { type: "string", minLength: 1, maxLength: 200 },
        objective: { type: "string", minLength: 1, maxLength: 4000 },
        completion_criteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 500 },
        },
        source: { type: "string", minLength: 1, maxLength: 40 },
        repo_url: { type: "string", maxLength: 500 },
        brief_url: { type: "string", maxLength: 500 },
        constraints: { type: "string", maxLength: 2000 },
        starting_ref: { type: "string", maxLength: 200 },
        client_request_id: { type: "string", maxLength: 120 },
        dry_run: { type: "boolean" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "getCursorTask",
    title: "Read a Cursor task",
    description:
      "Read one Cursor agent this chat already started. Report the run status, agent URL, and pull request URLs. Only a run status of FINISHED means that run completed.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id"],
      properties: { agent_id: { type: "string" } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "continueCursorTask",
    title: "Send a Cursor follow-up",
    description:
      "Send one follow-up to an existing Cursor agent. Call only after the user explicitly asks to send that follow-up. Do not retry.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["agent_id", "message"],
      properties: {
        agent_id: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: 8000 },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

export async function listCursorRepos(input, config, fetchImpl = fetch) {
  const query = typeof input?.query === "string" ? input.query.trim().toLowerCase() : "";
  if (query.length > 80) return { isError: true, result: { repositories: [], error: "query must be at most 80 characters." } };
  if (!config.cursorGithubToken) {
    return {
      isError: false,
      result: {
        repositories: [],
        error: "No GitHub repositories are available to list. Ask whether to create a new private repository or which existing https repository URL to use. Do not ask for a token.",
      },
    };
  }
  const loaded = await requestJson(
    fetchImpl,
    `${GITHUB_API}?per_page=20&sort=updated&affiliation=owner,collaborator`,
    {
      method: "GET",
      token: config.cursorGithubToken,
      timeoutMs: config.timeoutMs,
      secrets: secretValues(config),
    },
  );
  if (!loaded.ok) return { isError: true, result: { repositories: [], error: loaded.error } };
  const rows = Array.isArray(loaded.body) ? loaded.body : [];
  const repositories = rows
    .map((repo) => ({
      name: typeof repo?.full_name === "string" ? repo.full_name : repo?.name,
      url: typeof repo?.html_url === "string" ? repo.html_url : "",
      private: repo?.private === true,
      description: typeof repo?.description === "string" ? repo.description.slice(0, 200) : null,
    }))
    .filter((repo) => repo.name && repo.url.startsWith("https://"))
    .filter((repo) => !query || `${repo.name} ${repo.description || ""}`.toLowerCase().includes(query))
    .slice(0, 20);
  return { isError: false, result: { repositories, error: null } };
}

export async function startCursorTask(input, config, fetchImpl = fetch, owner = "default") {
  const validated = validateStart(input);
  if (!validated.ok) return failure(validated.error, { dry_run: input?.dry_run === true });
  const task = validated.task;
  const secrets = secretValues(config);
  if (!config.cursorApiKey || (!task.repoUrl && !config.cursorGithubToken)) {
    return failure(
      "Cursor handoff is not configured. Add CURSOR_API_KEY and, for new repositories, CURSOR_GITHUB_TOKEN to the relay environment. Do not paste either value into chat.",
      { dry_run: task.dryRun },
    );
  }
  if (task.dryRun) {
    return {
      isError: false,
      result: {
        accepted: false,
        dry_run: true,
        createdRepository: false,
        repoUrl: task.repoUrl,
        repoName: task.repoUrl ? null : repoName(task.title),
        agentId: null,
        agentUrl: null,
        error: null,
      },
    };
  }

  const existing = task.clientRequestId ? readStore(config).get(storeKey(owner, task.clientRequestId)) : null;
  if (existing?.agentId) return { isError: false, result: { ...existing.result, deduplicated: true } };

  let repoUrl = existing?.repoUrl || task.repoUrl;
  let createdRepository = Boolean(existing?.createdRepository);
  if (!repoUrl) {
    const created = await createRepository(task, config, fetchImpl, secrets);
    if (!created.ok) return failure(created.error, { createdRepository: false });
    repoUrl = created.repoUrl;
    createdRepository = true;
    remember(config, owner, {
      clientRequestId: task.clientRequestId,
      repoUrl,
      createdRepository,
      agentId: null,
      result: null,
    });
  }

  const launched = await requestJson(fetchImpl, `${CURSOR_API}/v1/agents`, {
    method: "POST",
    basic: config.cursorApiKey,
    body: {
      name: task.title.slice(0, 100),
      prompt: { text: task.prompt },
      repos: [{ url: repoUrl, startingRef: task.startingRef }],
      autoCreatePR: true,
      skipReviewerRequest: true,
      workOnCurrentBranch: false,
    },
    timeoutMs: config.timeoutMs,
    secrets,
  });
  if (!launched.ok) {
    return failure(launched.error, { createdRepository, repoUrl, agentId: null });
  }
  const agent = launched.body?.agent || {};
  const run = launched.body?.run || {};
  if (!agent.id || !agent.url) {
    return failure("Cursor accepted the request but did not return an agent id. Do not launch another agent.", {
      createdRepository,
      repoUrl,
    });
  }
  const result = {
    accepted: true,
    dry_run: false,
    createdRepository,
    repoUrl,
    agentId: agent.id,
    agentUrl: agent.url,
    agentStatus: agent.status || null,
    runId: run.id || agent.latestRunId || null,
    runStatus: run.status || null,
    error: null,
  };
  remember(config, owner, {
    clientRequestId: task.clientRequestId,
    repoUrl,
    createdRepository,
    agentId: agent.id,
    result,
  });
  return { isError: false, result };
}

export async function getCursorTask(input, config, fetchImpl = fetch, owner = "default") {
  const agentId = typeof input?.agent_id === "string" ? input.agent_id.trim() : "";
  if (!/^bc-[A-Za-z0-9-]{8,}$/.test(agentId)) return failure("agent_id must be a Cursor agent id.");
  if (!config.cursorApiKey) {
    return failure("Cursor handoff is not configured. Add CURSOR_API_KEY to the relay environment. Do not paste it into chat.");
  }
  if (!readStore(config).has(agentKey(owner, agentId))) {
    return failure("This chat has no Cursor agent with that id.");
  }
  const secrets = secretValues(config);
  const agent = await requestJson(fetchImpl, `${CURSOR_API}/v1/agents/${agentId}`, {
    method: "GET",
    basic: config.cursorApiKey,
    timeoutMs: config.timeoutMs,
    secrets,
  });
  if (!agent.ok) return failure(agent.error, { agentId });
  const runId = agent.body?.latestRunId;
  let run = null;
  if (typeof runId === "string" && /^run-[A-Za-z0-9-]{8,}$/.test(runId)) {
    const loaded = await requestJson(fetchImpl, `${CURSOR_API}/v1/agents/${agentId}/runs/${runId}`, {
      method: "GET",
      basic: config.cursorApiKey,
      timeoutMs: config.timeoutMs,
      secrets,
    });
    if (!loaded.ok) return failure(loaded.error, { agentId, runId });
    run = loaded.body;
  }
  const branches = Array.isArray(run?.git?.branches) ? run.git.branches : [];
  return {
    isError: false,
    result: {
      agentId,
      agentUrl: agent.body?.url || null,
      agentStatus: agent.body?.status || null,
      runId: runId || null,
      runStatus: run?.status || null,
      finished: run?.status === "FINISHED",
      result: typeof run?.result === "string" ? run.result.slice(0, 4000) : null,
      pullRequests: branches.map((branch) => ({
        repoUrl: branch.repoUrl || null,
        branch: branch.branch || null,
        prUrl: branch.prUrl || null,
      })),
      error: null,
    },
  };
}

export async function continueCursorTask(input, config, fetchImpl = fetch, owner = "default") {
  const agentId = typeof input?.agent_id === "string" ? input.agent_id.trim() : "";
  const message = typeof input?.message === "string" ? input.message.trim() : "";
  if (!/^bc-[A-Za-z0-9-]{8,}$/.test(agentId)) return failure("agent_id must be a Cursor agent id.");
  if (!message || message.length > 8000) return failure("message must be 1 to 8000 characters.");
  if (!config.cursorApiKey) {
    return failure("Cursor handoff is not configured. Add CURSOR_API_KEY to the relay environment. Do not paste it into chat.");
  }
  if (!readStore(config).has(agentKey(owner, agentId))) {
    return failure("This chat has no Cursor agent with that id.");
  }
  const sent = await requestJson(fetchImpl, `${CURSOR_API}/v1/agents/${agentId}/runs`, {
    method: "POST",
    basic: config.cursorApiKey,
    body: { prompt: { text: message } },
    timeoutMs: config.timeoutMs,
    secrets: secretValues(config),
  });
  if (!sent.ok) return failure(sent.error, { agentId });
  const run = sent.body?.run || sent.body || {};
  if (!run.id) return failure("Cursor accepted the follow-up but did not return a run id. Do not send it again.", { agentId });
  return {
    isError: false,
    result: {
      accepted: true,
      agentId,
      runId: run.id,
      runStatus: run.status || null,
      error: null,
    },
  };
}

function validateStart(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Task must be an object." };
  const title = stringField(input.title, 200);
  const objective = stringField(input.objective, 4000);
  const source = stringField(input.source, 40);
  const criteria = Array.isArray(input.completion_criteria) ? input.completion_criteria : [];
  if (!title || !objective || !source) return { ok: false, error: "title, objective, and source are required." };
  if (!criteria.length || criteria.length > 20 || criteria.some((item) => !stringField(item, 500))) {
    return { ok: false, error: "completion_criteria needs 1 to 20 checkable items." };
  }
  let repoUrl = null;
  if (input.repo_url !== undefined && input.repo_url !== "") {
    repoUrl = stringField(input.repo_url, 500);
    if (!repoUrl || !allowedRepo(repoUrl)) return { ok: false, error: "repo_url must be an https GitHub, GitLab, Bitbucket, or Azure DevOps URL." };
  }
  let briefUrl = null;
  if (input.brief_url !== undefined && input.brief_url !== "") {
    briefUrl = stringField(input.brief_url, 500);
    if (!briefUrl || !allowedHttps(briefUrl)) return { ok: false, error: "brief_url must be an https URL." };
  }
  const constraints = input.constraints === undefined ? "" : stringField(input.constraints, 2000);
  if (input.constraints !== undefined && !constraints && input.constraints !== "") {
    return { ok: false, error: "constraints must be text up to 2000 characters." };
  }
  const startingRef = input.starting_ref === undefined || input.starting_ref === "" ? "main" : stringField(input.starting_ref, 200);
  if (!startingRef || /\s/.test(startingRef)) return { ok: false, error: "starting_ref must be a branch name or commit without spaces." };
  const clientRequestId = input.client_request_id === undefined || input.client_request_id === ""
    ? ""
    : stringField(input.client_request_id, 120);
  if (input.client_request_id !== undefined && input.client_request_id !== "" && !clientRequestId) {
    return { ok: false, error: "client_request_id must be text up to 120 characters." };
  }
  const prompt = [
    `Title: ${title}`,
    `Source: ${source}`,
    `Objective: ${objective}`,
    "Completion criteria:",
    ...criteria.map((item) => `- ${item.trim()}`),
    constraints ? `Constraints: ${constraints}` : "",
    briefUrl ? `Full plan: ${briefUrl}` : "",
    "Implement this on a new branch and open a pull request. Do not push to the default branch. Do not ask for API keys or tokens.",
  ].filter(Boolean).join("\n");
  if (Buffer.byteLength(prompt) > 12000) return { ok: false, error: "The handoff is too long. Put the plan in a markdown file and pass brief_url." };
  return {
    ok: true,
    task: {
      title,
      prompt,
      repoUrl,
      startingRef,
      clientRequestId,
      dryRun: input.dry_run === true,
    },
  };
}

async function createRepository(task, config, fetchImpl, secrets) {
  const base = repoName(task.title);
  const names = [base, `${base}-${NAME_SUFFIXES[randomBytes(1)[0] % NAME_SUFFIXES.length]}`];
  let lastError = "GitHub did not create a repository.";
  for (let index = 0; index < names.length; index += 1) {
    const created = await requestJson(fetchImpl, GITHUB_API, {
      method: "POST",
      token: config.cursorGithubToken,
      body: {
        name: names[index],
        private: true,
        auto_init: true,
        description: task.prompt.slice(0, 200),
      },
      timeoutMs: config.timeoutMs,
      secrets,
    });
    if (created.ok && typeof created.body?.html_url === "string") return { ok: true, repoUrl: created.body.html_url };
    lastError = created.error || lastError;
    const taken = created.status === 422 && /already exists/i.test(created.error || "");
    if (!taken || index === names.length - 1) return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError };
}

function repoName(title) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return slug || "cursor-task";
}

function allowedRepo(value) {
  if (!allowedHttps(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ["github.com", "www.github.com", "gitlab.com", "bitbucket.org", "dev.azure.com"].includes(host);
  } catch {
    return false;
  }
}

function allowedHttps(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function stringField(value, max) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return "";
  return trimmed;
}

async function requestJson(fetchImpl, url, options) {
  const headers = { accept: "application/json" };
  if (options.body) headers["content-type"] = "application/json";
  if (options.basic) headers.authorization = `Basic ${Buffer.from(`${options.basic}:`).toString("base64")}`;
  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
    headers["user-agent"] = "grok-bot-task-relay";
    headers["x-github-api-version"] = "2022-11-28";
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: options.method,
      redirect: "manual",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs || 30000),
    });
  } catch (error) {
    return { ok: false, status: null, error: `Request failed before a response: ${redact(errorMessage(error), options.secrets)}. Do not retry automatically.` };
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, status: response.status, error: "Redirect was not followed, and the request was not retried." };
  }
  let text = "";
  try {
    text = await readLimited(response);
  } catch (error) {
    return { ok: false, status: response.status, error: `HTTP ${response.status} body could not be read: ${redact(errorMessage(error), options.secrets)}. Do not retry automatically.` };
  }
  const body = parseJson(text, options.secrets);
  const ok = response.status >= 200 && response.status < 300;
  if (!ok) {
    const parts = [];
    if (typeof body?.message === "string") parts.push(body.message);
    if (Array.isArray(body?.errors)) {
      for (const item of body.errors) if (typeof item?.message === "string") parts.push(item.message);
    }
    const detail = parts.join(" ") || `HTTP ${response.status}`;
    return { ok: false, status: response.status, body, error: redact(detail, options.secrets).slice(0, 300) };
  }
  return { ok: true, status: response.status, body };
}

function readLimited(response) {
  return response.text().then((text) => (text.length > 65536 ? text.slice(0, 65536) : text));
}

function parseJson(text, secrets) {
  if (!text) return null;
  try {
    return JSON.parse(redact(text, secrets));
  } catch {
    return null;
  }
}

function remember(config, owner, record) {
  const map = readStore(config);
  if (record.clientRequestId) map.set(storeKey(owner, record.clientRequestId), record);
  if (record.agentId) map.set(agentKey(owner, record.agentId), record);
  writeStore(config, map);
}

function readStore(config) {
  const file = storePath(config);
  if (!file) return memory;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

function writeStore(config, map) {
  const file = storePath(config);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function storePath(config) {
  if (config.cursorHandoffPath === "") return "";
  if (config.cursorHandoffPath) return config.cursorHandoffPath;
  if (config.dataDir) return path.join(config.dataDir, "cursor-handoffs.json");
  return "";
}

function storeKey(owner, clientRequestId) {
  return `${owner}:request:${clientRequestId}`;
}

function agentKey(owner, agentId) {
  return `${owner}:agent:${agentId}`;
}

function secretValues(config) {
  return [config.cursorApiKey, config.cursorGithubToken, config.relayApiKey].filter(Boolean);
}

function redact(value, secrets) {
  let text = String(value ?? "");
  for (const secret of secrets || []) {
    if (secret) text = text.split(secret).join("[redacted]");
  }
  return text;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "request failed";
}

function failure(error, extra = {}) {
  return {
    isError: true,
    result: {
      accepted: false,
      dry_run: false,
      createdRepository: false,
      repoUrl: null,
      agentId: null,
      agentUrl: null,
      error,
      ...extra,
    },
  };
}
