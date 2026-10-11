import { forwardTask } from "./forward.js";
import { validateAndNormalize } from "./task.js";

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
      schema_version: { type: "string", description: 'Use "1".' },
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
        items: { type: "string" },
        description: "Checkable conditions for done.",
      },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      source: {
        type: "string",
        description: "Chat platform that prepared the task, such as chatgpt, claude, grok, or muse.",
      },
      source_thread: { type: "string" },
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

export async function handleMcp(message, config, fetchImpl = fetch) {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return rpcError(null, -32600, "Invalid request");
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");
  const id = hasId ? message.id : undefined;
  const method = message.method;
  const params = message.params ?? {};

  if (!hasId) {
    if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
    return null;
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

  if (method === "tools/list") return rpcResult(id, { tools: [TOOL] });

  if (method === "tools/call") {
    if (params?.name !== TOOL.name) {
      return rpcError(id, -32602, "Unknown tool. The only tool is submitTaskToGrokBot.");
    }
    const outcome = await submitTask(params.arguments, config, fetchImpl);
    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
      isError: outcome.isError,
    });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function submitTask(input, config, fetchImpl = fetch) {
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
  return { isError: !result.transportAccepted, result };
}

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
