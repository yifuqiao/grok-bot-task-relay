export function withReceipt(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const relayTaskId = typeof result.relayTaskId === "string" ? result.relayTaskId : null;
  if (!relayTaskId) return result;
  return {
    ...result,
    receipt: {
      relayTaskId,
      status: result.status ?? null,
      transportAccepted: result.transportAccepted ?? result.transport?.transportAccepted ?? null,
      botAcknowledged: result.botAcknowledged ?? result.transport?.botAcknowledged ?? false,
      runUuid: result.runUuid ?? result.transport?.runUuid ?? null,
      statusTool: "getTaskStatus",
      note: "Keep relayTaskId. Call getTaskStatus once when the user asks about progress. HTTP acceptance is not a Grok Bot receipt; received, forwarded, executing, waiting_approval, finished, and failed come from authenticated progress reports. forwarded is not done.",
    },
  };
}
