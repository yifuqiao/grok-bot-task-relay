import fs from "node:fs";
import path from "node:path";

const ID = /^[a-f0-9-]{36}$/;
const PROGRESS = new Set(["received", "executing", "waiting_approval"]);
const TERMINAL = new Set(["finished", "failed"]);
const CLOSED = new Set(["finished", "failed", "rejected", "dry_run"]);

export function rememberSubmission(config, owner, fields) {
  fs.mkdirSync(config.statusDir, { recursive: true, mode: 0o700 });
  const record = {
    relayTaskId: fields.relayTaskId,
    owner,
    status: fields.status,
    deliveryMode: "webhook",
    source: fields.source,
    sourceThread: fields.sourceThread ?? null,
    createdAt: fields.createdAt,
    updatedAt: fields.createdAt,
    summary: null,
    updates: [],
    transport: {
      transportAccepted: fields.transport.transportAccepted === true,
      botAcknowledged: fields.transport.botAcknowledged === true,
      httpStatus: fields.transport.httpStatus ?? null,
      taskId: fields.transport.taskId ?? null,
      error: fields.transport.error ?? null,
    },
  };
  writeRecord(config, record);
  return view(record);
}

export function readStatus(config, id, owner) {
  const record = loadRecord(config, id);
  if (!record || record.owner !== owner) return null;
  return view(record);
}

export function progressStatus(config, id, input) {
  if (!ID.test(id)) return { status: 404, body: { error: "Task not found." } };
  const record = loadRecord(config, id);
  if (!record) return { status: 404, body: { error: "Task not found." } };
  const checked = checkProgress(record, input);
  if (checked.error) return checked.error;
  if (checked.duplicate) return { status: 200, body: { ...view(record), deduplicated: true } };
  const now = new Date().toISOString();
  record.updates.push({ event_id: checked.eventId, status: checked.status, summary: checked.summary, at: now });
  if (record.updates.length > 20) record.updates.splice(0, record.updates.length - 20);
  record.status = checked.status;
  record.summary = checked.summary;
  record.updatedAt = now;
  writeRecord(config, record);
  return { status: 200, body: view(record) };
}

export function checkProgress(record, input) {
  if (record.status === "dry_run" || record.dryRun) {
    return { error: { status: 409, body: { error: "Dry-run tasks cannot be executed or completed." } } };
  }
  if (CLOSED.has(record.status)) {
    return { error: { status: 409, body: { error: "Task is already closed." } } };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { error: { status: 400, body: { error: "Progress must be an object." } } };
  }
  const eventId = typeof input.event_id === "string" ? input.event_id.trim() : "";
  const summary = typeof input.summary === "string" ? input.summary.trim() : "";
  const status = input.status;
  if (!eventId || eventId.length > 120) {
    return { error: { status: 400, body: { error: "event_id is required (max 120 characters)." } } };
  }
  if (!PROGRESS.has(status) && !TERMINAL.has(status)) {
    return { error: { status: 400, body: { error: "status must be received, executing, waiting_approval, finished, or failed." } } };
  }
  const maxSummary = TERMINAL.has(status) ? 8000 : 2000;
  if (!summary || summary.length > maxSummary) {
    return { error: { status: 400, body: { error: `summary is required (max ${maxSummary} characters).` } } };
  }
  const existing = (record.updates || []).find((item) => item.event_id === eventId);
  if (existing) {
    if (existing.status !== status || existing.summary !== summary) {
      return { error: { status: 409, body: { error: "event_id was already used with different contents." } } };
    }
    return { duplicate: true };
  }
  if (record.completion && TERMINAL.has(status)) {
    return { error: { status: 409, body: { error: "A different terminal report already exists." } } };
  }
  return { eventId, status, summary };
}

function view(record) {
  return {
    relayTaskId: record.relayTaskId,
    status: record.status,
    deliveryMode: record.deliveryMode || "webhook",
    source: record.source ?? null,
    sourceThread: record.sourceThread ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    summary: record.summary ?? null,
    updates: (record.updates || []).map((item) => ({
      event_id: item.event_id,
      status: item.status,
      summary: item.summary,
      at: item.at,
    })),
    transport: record.transport ?? null,
    completion: record.completion ?? null,
  };
}

function loadRecord(config, id) {
  if (!config.statusDir || !ID.test(id)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(config.statusDir, `${id}.json`), "utf8"));
    if (record.relayTaskId !== id || typeof record.owner !== "string") return null;
    return record;
  } catch {
    return null;
  }
}

function writeRecord(config, record) {
  const file = path.join(config.statusDir, `${record.relayTaskId}.json`);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
