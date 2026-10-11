import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { forwardTask } from "./forward.js";
import { validateAndNormalize, normalizeAttachments } from "./task.js";

const services = new WeakMap();
const ID = /^[a-f0-9-]{36}$/;
const TERMINAL = new Set(["finished", "failed", "dry_run", "rejected"]);

export function taskService(config) {
  if (!config.dataDir) return null;
  if (!services.has(config)) services.set(config, new TaskService(config));
  return services.get(config);
}

export class TaskService {
  constructor(config) {
    if (typeof config.botReportKey !== "string" || !config.botReportKey.trim()) {
      throw new Error("Lifecycle mode requires BOT_REPORT_KEY for completion reports.");
    }
    this.config = config;
    this.records = new Map();
    this.dedupe = new Map();
    this.delivering = new Set();
    if (config.publicBaseUrl) {
      const base = new URL(config.publicBaseUrl);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
        throw new Error("RELAY_PUBLIC_BASE_URL must be an HTTPS origin without credentials, query or path.");
      }
    }
    if (config.botReportKey && [config.relayApiKey, ...Object.values(config.clientKeys || {})].includes(config.botReportKey)) {
      throw new Error("BOT_REPORT_KEY must be separate from caller credentials.");
    }
    fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    this.lockPath = path.join(config.dataDir, ".writer.lock");
    this.acquireLock();
    try {
      for (const name of fs.readdirSync(config.dataDir)) {
        if (!name.endsWith(".json") || !ID.test(name.slice(0, -5))) continue;
        let record;
        try {
          record = JSON.parse(fs.readFileSync(path.join(config.dataDir, name), "utf8"));
          if (record.relayTaskId !== name.slice(0, -5) || !record.task || typeof record.owner !== "string") throw new Error();
        } catch {
          throw new Error("Task store contains an invalid record. Contents are not printed; restore from backup.");
        }
        if (record.status === "submitting") record.status = "unknown";
        this.records.set(record.relayTaskId, record);
        if (record.task.client_request_id) {
          this.dedupe.set(`${record.owner}\0${record.task.client_request_id}`, record.relayTaskId);
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }

  acquireLock() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, "wx", 0o600);
        try { fs.writeFileSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
        this.closed = false;
        return;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const pid = Number(fs.readFileSync(this.lockPath, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Task store lock is invalid. Check the writer before removing it.");
        try { process.kill(pid, 0); } catch (probeError) {
          if (probeError.code === "ESRCH") {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        }
        throw new Error("Task store already has a writer. Run one HTTP relay or use a separate directory for each stdio process.");
      }
    }
    throw new Error("Could not acquire the task store writer lock.");
  }

  close() {
    if (!this.closed) {
      fs.unlinkSync(this.lockPath);
      this.closed = true;
    }
  }

  save(record) {
    if (this.closed) throw new Error("Task store is closed.");
    const file = path.join(this.config.dataDir, `${record.relayTaskId}.json`);
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temporary, file);
    this.records.set(record.relayTaskId, record);
  }

  get(id, owner) {
    const record = this.records.get(id);
    return record && record.owner === owner ? record : null;
  }

  view(record) {
    return {
      relayTaskId: record.relayTaskId,
      status: record.status,
      source: record.task.source,
      sourceThread: record.task.source_thread ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      transport: record.transport ?? null,
      completion: record.completion ?? null,
      callback: record.callback ?? null,
    };
  }

  async submit(input, owner, fetchImpl = fetch) {
    const checked = validateAndNormalize(input, { maxBytes: 48 * 1024 });
    if (!checked.ok) return { isError: true, result: { error: checked.errors.join(" ") } };
    const task = checked.task;
    const target = task.callback_target && this.config.callbackTargets?.[task.callback_target];
    if (task.callback_target && (!target || target.owner !== owner)) {
      return { isError: true, result: { error: "Callback target is not registered for this caller." } };
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(task)).digest("hex");
    const dedupeKey = task.client_request_id && `${owner}\0${task.client_request_id}`;
    const previous = dedupeKey && this.records.get(this.dedupe.get(dedupeKey));
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { isError: true, result: { error: "client_request_id was already used with different task contents." } };
      }
      return { isError: Boolean(previous.transport?.error) || previous.status === "unknown",
        result: { ...(previous.transport ?? {}), ...this.view(previous), deduplicated: true } };
    }
    const relayTaskId = randomUUID();
    const now = new Date().toISOString();
    const record = { relayTaskId, owner, task, fingerprint, status: "submitting", createdAt: now, updatedAt: now };
    const envelope = { ...task, task_id: task.task_id ?? relayTaskId, relay_task_id: relayTaskId };
    delete envelope.callback_target;
    delete envelope.client_request_id;
    if (task.markdown || Buffer.byteLength(JSON.stringify(envelope)) > 3000) {
      if (!this.config.publicBaseUrl || !this.config.botReportKey) {
        return { isError: true, result: { error: "Rich task manifests require RELAY_PUBLIC_BASE_URL and BOT_REPORT_KEY. Use HTTPS attachment references or brief_url until configured." } };
      }
      const url = new URL(`/executor/tasks/${relayTaskId}/manifest`, this.config.publicBaseUrl);
      // The manifest preserves the full original task. The execution envelope stays small.
      for (const key of ["markdown", "attachments", "context", "constraints"]) delete envelope[key];
      envelope.task_manifest_url = url.href;
    }
    if (Buffer.byteLength(JSON.stringify(envelope)) > 3000) {
      return { isError: true, result: { error: "Webhook envelope exceeds 3000 bytes. Shorten the title, objective and completion criteria." } };
    }
    this.save(record); // Persist before any network side effect; ambiguous attempts must not be resent.
    if (dedupeKey) this.dedupe.set(dedupeKey, relayTaskId);
    const transport = await forwardTask(envelope, this.config, fetchImpl);
    const current = this.records.get(relayTaskId);
    current.transport = transport;
    if (!TERMINAL.has(current.status)) {
      current.status = transport.error && transport.transportAccepted ? "unknown" : transport.transportAccepted
        ? (task.dry_run ? "dry_run" : "submitted")
        : (transport.httpStatus ? "rejected" : "unknown");
    }
    current.updatedAt = new Date().toISOString();
    this.save(current);
    return { isError: !transport.transportAccepted || Boolean(transport.error),
      result: { ...transport, ...this.view(current) } };
  }

  async report(id, input) {
    const record = this.records.get(id);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (record.task.dry_run) return { status: 409, body: { error: "Dry-run tasks cannot be executed or completed." } };
    const errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { status: 400, body: { error: "Report must be an object." } };
    }
    if (typeof input.event_id !== "string" || !input.event_id.trim() || input.event_id.length > 120) errors.push("event_id is required (max 120 characters).");
    if (!["finished", "failed"].includes(input.status)) errors.push("status must be finished or failed.");
    if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 8000) errors.push("summary is required (max 8000 characters).");
    const artifacts = input.artifacts === undefined ? [] : normalizeAttachments(input.artifacts, errors);
    if (errors.length) return { status: 400, body: { error: errors.join(" ") } };
    const completion = { event_id: input.event_id, status: input.status, summary: input.summary, artifacts };
    if (record.completion) {
      if (JSON.stringify(record.completion) !== JSON.stringify(completion)) {
        return { status: 409, body: { error: "A different terminal report already exists." } };
      }
      return { status: 200, body: { ...this.view(record), deduplicated: true } };
    }
    if (record.status === "rejected") return { status: 409, body: { error: "Task was rejected by the webhook." } };
    record.completion = completion;
    record.status = completion.status;
    record.updatedAt = new Date().toISOString();
    if (record.task.callback_target) record.callback = { status: "pending", attempts: 0, httpStatus: null };
    this.save(record);
    await this.notify(id, record.owner);
    return { status: 200, body: this.view(record) };
  }

  async notify(id, owner, fetchImpl = fetch) {
    const record = this.get(id, owner);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (!record.callback || record.callback.status === "delivered") return { status: 200, body: this.view(record) };
    if (this.delivering.has(id)) return { status: 409, body: { error: "Callback delivery is already in progress." } };
    const target = this.config.callbackTargets?.[record.task.callback_target];
    if (!target || target.owner !== owner) return { status: 503, body: { error: "Callback target is unavailable." } };
    this.delivering.add(id);
    try {
      record.callback = { ...record.callback, status: "pending", attempts: record.callback.attempts + 1 };
      this.save(record);
      const event = { event_id: `${id}:${record.completion.event_id}`, relay_task_id: id,
        status: record.status, source: record.task.source, source_thread: record.task.source_thread ?? null,
        summary: record.completion.summary, artifacts: record.completion.artifacts };
      let response;
      try {
        response = await fetchImpl(target.url, { method: "POST", redirect: "manual",
          headers: { "content-type": "application/json", ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}) },
          body: JSON.stringify(event), signal: AbortSignal.timeout(this.config.timeoutMs || 30000) });
        record.callback = { ...record.callback, status: response.ok ? "delivered" : "failed", httpStatus: response.status };
        // Do not expose or parse receiver response bodies, which may echo secrets.
        await response.body?.cancel().catch(() => {});
      } catch {
        record.callback = { ...record.callback, status: "failed", httpStatus: response?.status ?? null };
      }
      this.save(record);
      return { status: 200, body: this.view(record) };
    } finally {
      this.delivering.delete(id);
    }
  }
}
