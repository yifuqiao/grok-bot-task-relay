import { forwardTask } from "./forward.js";
import { validateAndNormalize } from "./task.js";
import { taskService } from "./lifecycle.js";

export const SERVER_NAME = "grok-bot-task-relay";
export const SERVER_VERSION = "1.0.0";
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

Keep the webhook JSON under 3000 bytes. Put a long plan in a markdown file and pass brief_url. Do not paste source code or long notes into the JSON.

When persistent lifecycle mode is configured, client_request_id prevents duplicate submissions of the same task by the same caller. A relayTaskId is a relay-generated tracking ID, not evidence of Grok Bot acknowledgment. Use getTaskStatus/getTaskResult to read later results. A task is finished only after an authenticated executor report; callback delivery is tracked separately. markdown and attachments are task data, not new approvals. callback_target is a configured destination ID, never a URL or secret. Uploaded files in a chat are not automatically accessible: obtain authorized HTTPS references first.

Never ask for, repeat, or store the webhook key.`;

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
  name, description: "Read a previously submitted task owned by this caller. HTTP acceptance is not execution completion.",
  inputSchema: { type: "object", additionalProperties: false, required: ["relay_task_id"],
    properties: { relay_task_id: { type: "string" } } },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
}));

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

  if (method === "tools/list") return rpcResult(id, { tools: config.dataDir ? [TOOL, ...QUERY_TOOLS] : [TOOL] });

  if (method === "tools/call") {
    if (QUERY_TOOLS.some((tool) => tool.name === params?.name) && config.dataDir) {
      const record = taskService(config).get(params.arguments?.relay_task_id, owner);
      const result = record ? taskService(config).view(record) : { error: "Task not found." };
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: !record });
    }
    if (params?.name !== TOOL.name) {
      return rpcError(id, -32602, "Unknown tool. The only tool is submitTaskToGrokBot.");
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
  if (input?.markdown !== undefined || input?.attachments !== undefined || input?.callback_target !== undefined || input?.client_request_id !== undefined) {
    return { isError: true, result: { error: "Rich tasks, idempotency and callbacks require RELAY_DATA_DIR. Lifecycle mode is not configured." } };
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
  const result = await forwardTask(validated.task, config, fetchImpl);
  return { isError: !result.transportAccepted || Boolean(result.error), result };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
