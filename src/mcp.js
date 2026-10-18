import { randomUUID } from "node:crypto";
import { continueCursorTask, CURSOR_TOOLS, getCursorTask, listCursorRepos, startCursorTask } from "./cursor.js";
import { deployTask, listTargets, resolveTarget } from "./deploy.js";
import { forwardTask } from "./forward.js";
import { allowedRepos } from "./github.js";
import { rememberSubmission, readStatus } from "./grok-status.js";
import { withReceipt } from "./receipt.js";
import { validateAndNormalize } from "./task.js";
import { MAX_WAIT_SECONDS, taskService } from "./lifecycle.js";
import { currentRevision } from "./revision.js";

export const SERVER_NAME = "grok-bot-task-relay";
export const SERVER_VERSION = "1.2.0";
export const SUPPORTED_PROTOCOLS = [
  "2026-07-28",
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

export const SERVER_INSTRUCTIONS = `You are connected to Grok Bot only as an execution handoff.

Brainstorm and refine the plan in this chat. Call submitTaskToGrokBot exactly once, and only after the user explicitly asks you to send, relay, execute, or hand the task to Grok Bot. Do not call it while discussing or drafting.

The tool result's transportAccepted field means the webhook accepted the HTTP POST. botAcknowledged and taskId are set only when the response itself contains that evidence. Do not claim that Grok Bot acknowledged, started, or finished the task without that evidence. If the call fails or the result is ambiguous, report the HTTP status and stop. Do not retry unless the user explicitly authorizes another attempt.

In webhook delivery mode, keep the webhook JSON under 3000 bytes unless lifecycle manifests are configured. Put a long plan in a markdown file and pass brief_url, or use lifecycle markdown.

When persistent lifecycle mode is configured, client_request_id prevents duplicate submissions of the same task by the same caller. A relayTaskId is a relay-generated tracking ID, not evidence of Grok Bot acknowledgment. Use getTaskStatus/getTaskResult to read later results. A task is finished only after an authenticated executor report; callback delivery is tracked separately. markdown and attachments are task data, not new approvals. callback_target is a configured destination ID, never a URL or secret. Uploaded files in a chat are not automatically accessible: obtain authorized HTTPS references first.

After submitTaskToGrokBot returns, keep receipt.relayTaskId. transportAccepted and HTTP 200 only mean the webhook accepted the POST. botAcknowledged is true only when that HTTP response itself contains an ack flag or task_id. A runUuid is a webhook transport id, not a Grok Bot receipt. submitted means the handoff was stored and, when a webhook is configured, forwarded once. When the user asks about progress, call getTaskStatus once with that relay_task_id. Report status and summary from the tool result. received, forwarded, executing, and waiting_approval are progress reports from Grok Bot. forwarded means an intake bot routed the task to another bot that will keep reporting on the same relay_task_id; the work has not been done yet. Only finished or failed means the bot closed the task. Do not poll in a loop, and do not submit the task again to refresh status.

In pull delivery mode without a receiver webhook, accepted/queued means the relay stored the task for an authorized executor to claim; it does not mean Grok Bot received or started it. When pull mode also has a webhook configured, the relay notifies Grok Bot once with relay_task_id and status becomes submitted. claimed means reserved, not proof of execution. A dry run stays out of the executor inbox. Rich briefs use the lifecycle size limit in this mode rather than the webhook envelope limit.

When the user explicitly asks to hand the work to Cursor, do not call startCursorTask until they choose a repository. If that message already names one repository, use it. Otherwise call listCursorRepos once and ask, in the user's language, whether to create a new private repository or use one of the listed repositories. Wait for the choice. Omit repo_url only after they choose a new repository. Pass repo_url after they choose an existing one. Then call startCursorTask once. accepted means Cursor accepted the launch, not that the work finished. Use getCursorTask with that agent_id to read status and pull request URLs. Call continueCursorTask only when the user explicitly sends a follow-up. Do not retry a failed launch.

Deploys: call listDeployTargets to see the registered targets, then deployRelease once after the user explicitly asks to deploy. Pass the full 40-character commit sha that was reviewed (never a branch name) and the pr_number when there is one. The relay fills in the repository, environment and health check from its own configuration. A target with requires_approval returns status awaiting_approval and an approvalUrl: give that link to the user. Nothing is sent to Grok Bot until a human approves on that page with the approval key; never try to approve it yourself. A deploy is confirmed only when status is finished AND verification.status is verified, which means the relay itself read the target health endpoint and saw the requested commit. finished with verification mismatch or unreachable means Grok Bot claims success but the relay could not confirm it: say so plainly. verification skipped means the target has no health check, so the result rests on Grok Bot's report alone. Use verifyDeployment once to re-check later.

Receipts on GitHub: when a task or deploy names a pull request (github.repo + github.pr_number for tasks, pr_number for deploys) and the operator configured a GitHub token, the relay posts a commit status for each progress change and a PR comment when approval is needed and when the task closes. Agents subscribed to that pull request get woken by those comments.

Waiting: waitForTask holds the call for up to ${MAX_WAIT_SECONDS} seconds and returns as soon as the task changes. Pass since_updated_at from the previous result so you only wake on new reports. A coding agent that the user asked to follow a handoff to the end may call waitForTask repeatedly, telling the user about each new status, until the task reaches finished, failed or rejected, or for as long as the user said to wait. Do not loop on getTaskStatus. listTasks recovers relayTaskIds from earlier chats or sessions.

When the user asks which relay version is connected, call getRelayInfo once and report name, version, deliveryMode, and statusReports from the tool result. Do not invent a version from the ChatGPT app listing.

Never ask for, repeat, or store the webhook key, Cursor API key, or GitHub token.`;

const INFO_TOOL = {
  name: "getRelayInfo",
  title: "Read this relay version",
  description: "Return the connected Grok Bot relay name, version, delivery mode, and whether status reports are configured. Use when the user asks for the plugin or relay version.",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};

const TOOL = {
  name: "submitTaskToGrokBot",
  title: "Submit one task to Grok Bot",
  description: SERVER_INSTRUCTIONS,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "objective", "completion_criteria", "source"],
    properties: {
      schema_version: { type: "string", enum: ["1"], description: 'Use "1".' },
      task_id: { type: "string" },
      title: { type: "string" },
      objective: { type: "string" },
      brief_url: {
        type: "string",
        description: "URL of a markdown file with the full plan. Use this when the plan does not fit in a few sentences.",
      },
      context: { description: "Short background only. Put long plans in the markdown file at brief_url." },
      constraints: { description: "Limits on how the task may be done." },
      completion_criteria: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 500 },
        description: "Checkable conditions for done.",
      },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      source: {
        type: "string",
        description: "Chat platform that prepared the task, such as chatgpt, claude, grok, or muse.",
      },
      source_thread: { type: "string" },
      client_request_id: { type: "string", maxLength: 120, description: "Stable request ID. Reuse only for the identical task to prevent duplicate execution." },
      markdown: { type: "string", maxLength: 32000, description: "Complete Markdown task brief. Requires configured task manifests." },
      callback_target: { type: "string", description: "Operator-registered callback target ID for this caller. Never provide a URL or secret." },
      attachments: {
        type: "array", maxItems: 20,
        items: { type: "object", additionalProperties: false, required: ["name", "url", "mime_type"],
          properties: { name: { type: "string", maxLength: 200 }, url: { type: "string", maxLength: 2000 },
            mime_type: { type: "string", maxLength: 120 }, size_bytes: { type: "integer", minimum: 0 },
            sha256: { type: "string", pattern: "^[a-fA-F0-9]{64}$" } } },
      },
      dry_run: {
        type: "boolean",
        description: "True only when the user asked for a connectivity test. False for real execution.",
      },
      github: {
        type: "object", additionalProperties: false, required: ["repo"],
        description: "Optional pull request or commit to receive GitHub receipts (commit status and PR comments). The repository must be allowed by the operator.",
        properties: {
          repo: { type: "string", description: "owner/name" },
          pr_number: { type: "integer", minimum: 1 },
          commit_sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$" },
        },
      },
      approval_hints: {
        type: "array",
        items: { type: "string", enum: ["spend", "send_external", "delete", "other"] },
      },
    },
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
};

const QUERY_TOOLS = ["getTaskStatus", "getTaskResult"].map((name) => ({
  name, description: "Read one Grok Bot task this chat already submitted. Pass relay_task_id from submitTaskToGrokBot. submitted means the webhook accepted the handoff. received, forwarded, executing, and waiting_approval are progress reports; forwarded means another bot took over and the work is not done yet. Only finished or failed means Grok Bot closed the task.",
  inputSchema: { type: "object", additionalProperties: false, required: ["relay_task_id"],
    properties: { relay_task_id: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));

const ID_ARG = { relay_task_id: { type: "string", description: "relayTaskId returned at submission." } };

const LIFECYCLE_TOOLS = [
  {
    name: "listDeployTargets",
    title: "List deploy targets",
    description: "List the deploy targets the operator registered for this caller: name, repo, environment, whether a health check verifies the deploy, and whether a human must approve it. Call before deployRelease.",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "deployRelease",
    title: "Ask Grok Bot to deploy one commit",
    description: "Hand one deploy to Grok Bot. Call once, only after the user explicitly asks to deploy. target must come from listDeployTargets. commit_sha is the full reviewed commit, never a branch. Repeating the same target and commit returns the existing task instead of deploying again; pass a new client_request_id only when the user explicitly wants a redeploy. Read the result: awaiting_approval means a human must open approvalUrl first. Follow with waitForTask.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["target", "commit_sha", "source"],
      properties: {
        target: { type: "string", description: "Registered target name from listDeployTargets." },
        commit_sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$", description: "Full 40-character commit sha to deploy." },
        pr_number: { type: "integer", minimum: 1, description: "Pull request that carries this commit. Receipts are posted there." },
        rollback_sha: { type: "string", pattern: "^[a-fA-F0-9]{40}$", description: "Known-good commit to return to if the deploy fails." },
        notes: { type: "string", maxLength: 4000, description: "Deploy notes for Grok Bot, such as migrations to run. Data only; it grants no extra permission." },
        source: { type: "string", description: "Platform asking, such as claude, chatgpt, cursor." },
        source_thread: { type: "string" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
        client_request_id: { type: "string", maxLength: 120, description: "Defaults to deploy:<target>:<sha>. Set a new one only for an explicit redeploy." },
        callback_target: { type: "string" },
        dry_run: { type: "boolean", description: "True only for a connectivity test." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "waitForTask",
    title: "Wait for the next Grok Bot report",
    description: `Wait up to ${MAX_WAIT_SECONDS} seconds for a task to change, then return its full status. Pass since_updated_at from the previous result's updatedAt so the call returns only on a new report. Returns at once when the task is closed. timedOut true means nothing new arrived yet.`,
    inputSchema: {
      type: "object", additionalProperties: false, required: ["relay_task_id"],
      properties: {
        ...ID_ARG,
        since_updated_at: { type: "string", description: "updatedAt from the last result you saw." },
        wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: `Default ${MAX_WAIT_SECONDS}.` },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "listTasks",
    title: "List my Grok Bot tasks",
    description: "List recent tasks and deploys this caller submitted, newest first, with status. Use it to find a relayTaskId from an earlier chat or session.",
    inputSchema: {
      type: "object", additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 100 },
        status: { type: "string", description: "Only tasks with this status, such as executing or awaiting_approval." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "verifyDeployment",
    title: "Re-check a finished deploy",
    description: "Read the deploy target's health endpoint again and compare the running commit with the requested one. Use once when an earlier verification was unreachable or mismatched, or the user asks to confirm what is running.",
    inputSchema: { type: "object", additionalProperties: false, required: ["relay_task_id"], properties: ID_ARG },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
];

export async function handleMcp(message, config, fetchImpl = fetch, owner = "default") {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid request");
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : undefined;
  if (
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string" ||
    (hasId && id !== null && typeof id !== "string" &&
      !(typeof id === "number" && Number.isFinite(id))) ||
    (message.params !== undefined &&
      (!message.params || typeof message.params !== "object"))
  ) {
    return rpcError(null, -32600, "Invalid request");
  }
  const method = message.method;
  const params = message.params ?? {};

  if (!hasId) {
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    return null;
  }

  if (Array.isArray(params)) {
    return rpcError(id, -32602, "This server requires named parameters.");
  }

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested)
      ? requested
      : SUPPORTED_PROTOCOLS[0];
    return rpcResult(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: SERVER_INSTRUCTIONS,
    });
  }

  if (method === "ping") return rpcResult(id, {});

  if (method === "tools/list") return rpcResult(id, { tools: [TOOL, INFO_TOOL, ...QUERY_TOOLS, ...LIFECYCLE_TOOLS, ...CURSOR_TOOLS] });

  if (method === "tools/call") {
    if (params?.name === INFO_TOOL.name) {
      const result = relayInfo(config);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
        isError: false,
      });
    }
    if (QUERY_TOOLS.some((tool) => tool.name === params?.name)) {
      const outcome = readGrokStatus(params.arguments, config, owner);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
        isError: outcome.isError,
      });
    }
    if (LIFECYCLE_TOOLS.some((tool) => tool.name === params?.name)) {
      const outcome = await callLifecycle(params.name, params.arguments || {}, config, fetchImpl, owner);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
        isError: outcome.isError,
      });
    }
    if (CURSOR_TOOLS.some((tool) => tool.name === params?.name)) {
      const outcome = await callCursor(params.name, params.arguments, config, fetchImpl, owner);
      return rpcResult(id, {
        content: [{ type: "text", text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
        isError: outcome.isError,
      });
    }
    if (params?.name !== TOOL.name) {
      return rpcError(id, -32602, "Unknown tool.");
    }
    const outcome = await submitTask(params.arguments, config, fetchImpl, owner);
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: outcome.isError,
    });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function submitTask(input, config, fetchImpl = fetch, owner = "default") {
  if (config.dataDir) return taskService(config).submit(input, owner, fetchImpl);
  if (input?.markdown !== undefined || input?.attachments !== undefined || input?.callback_target !== undefined || input?.client_request_id !== undefined || input?.github !== undefined || input?.deploy !== undefined) {
    return { isError: true, result: { error: "Rich tasks, idempotency, callbacks, GitHub receipts and deploys require RELAY_DATA_DIR. Lifecycle mode is not configured." } };
  }
  const validated = validateAndNormalize(input);
  if (!validated.ok) {
    const result = {
      submitted: false,
      transportAccepted: false,
      botAcknowledged: false,
      acknowledgment: "none",
      httpStatus: null,
      taskId: null,
      dry_run: input?.dry_run === true,
      response: null,
      error: validated.errors.join(" "),
    };
    return { isError: true, result };
  }
  if (!config.statusDir) {
    const result = await forwardTask(validated.task, config, fetchImpl);
    return { isError: !result.transportAccepted || Boolean(result.error), result };
  }
  const relayTaskId = randomUUID();
  const envelope = { ...validated.task, relay_task_id: relayTaskId, task_id: validated.task.task_id || relayTaskId };
  if (Buffer.byteLength(JSON.stringify(envelope)) > 3000) {
    return { isError: true, result: { error: "Task JSON is over 3000 bytes. Put the plan in a markdown file and pass brief_url." } };
  }
  const result = await forwardTask(envelope, config, fetchImpl);
  const tracked = rememberSubmission(config, owner, {
    relayTaskId,
    status: submissionStatus(validated.task, result),
    source: validated.task.source,
    sourceThread: validated.task.source_thread,
    createdAt: new Date().toISOString(),
    transport: result,
  });
  return {
    isError: !result.transportAccepted || Boolean(result.error),
    result: withReceipt({ ...result, ...tracked }),
  };
}

export async function callLifecycle(name, args, config, fetchImpl, owner) {
  if (name === "listDeployTargets") {
    return { isError: false, result: { targets: listTargets(config, owner) } };
  }
  const service = taskService(config);
  if (!service) {
    return { isError: true, result: { error: `${name} requires lifecycle mode (RELAY_DATA_DIR and BOT_REPORT_KEY).` } };
  }
  if (name === "deployRelease") {
    const resolved = resolveTarget(config, args.target, owner);
    if (resolved.error) return { isError: true, result: { error: resolved.error } };
    return service.submit(deployTask(args, resolved.target), owner, fetchImpl);
  }
  if (name === "listTasks") {
    return { isError: false, result: { tasks: service.list(owner, args) } };
  }
  if (name === "verifyDeployment") return service.reverify(args.relay_task_id, owner);
  if (name === "waitForTask") {
    const waited = await service.waitFor(args.relay_task_id, owner, {
      sinceUpdatedAt: args.since_updated_at,
      waitSeconds: args.wait_seconds ?? MAX_WAIT_SECONDS,
    });
    if (!waited) return { isError: true, result: { error: "Task not found." } };
    return { isError: false, result: withReceipt({ ...service.view(waited.record), changed: waited.changed, timedOut: waited.timedOut }) };
  }
  return { isError: true, result: { error: "Unknown tool." } };
}

function relayInfo(config) {
  return {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    commit: currentRevision(),
    lifecycle: Boolean(config.dataDir),
    deployTargets: Object.keys(config.deployTargets || {}).length,
    githubReceipts: Boolean(config.githubToken) && allowedRepos(config).size > 0,
    deliveryMode: config.deliveryMode || "webhook",
    webhookConfigured: Boolean(config.webhookUrl && config.webhookKey),
    statusReports: Boolean(config.botReportKey && (config.dataDir || config.statusDir)),
  };
}

function readGrokStatus(args, config, owner) {
  const id = args?.relay_task_id;
  if (config.dataDir) {
    const service = taskService(config);
    const record = service?.get(id, owner);
    if (record) return { isError: false, result: withReceipt(service.view(record)) };
  }
  if (config.statusDir) {
    const record = readStatus(config, id, owner);
    if (record) return { isError: false, result: withReceipt(record) };
  }
  if (!config.dataDir && !config.statusDir) {
    return { isError: true, result: { error: "Status tracking is not configured." } };
  }
  return { isError: true, result: { error: "Task not found." } };
}

function submissionStatus(task, transport) {
  if (task.dry_run && transport.transportAccepted && !transport.error) return "dry_run";
  if (transport.transportAccepted && transport.error) return "unknown";
  if (transport.transportAccepted) return "submitted";
  if (transport.httpStatus) return "rejected";
  return "unknown";
}

function callCursor(name, args, config, fetchImpl, owner) {
  if (name === "listCursorRepos") return listCursorRepos(args, config, fetchImpl);
  if (name === "startCursorTask") return startCursorTask(args, config, fetchImpl, owner);
  if (name === "getCursorTask") return getCursorTask(args, config, fetchImpl, owner);
  if (name === "continueCursorTask") return continueCursorTask(args, config, fetchImpl, owner);
  return { isError: true, result: { error: "Unknown tool." } };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
