import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash, randomInt, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { deployEnvelope, resolveTarget, verifyDeployment } from "./deploy.js";
import { forwardTask } from "./forward.js";
import { GithubReceipts, repoAllowed } from "./github.js";
import { checkProgress } from "./grok-status.js";
import { withReceipt } from "./receipt.js";
import { validateAndNormalize, normalizeAttachments } from "./task.js";

const services = new WeakMap();
const ID = /^[a-f0-9-]{36}$/;
const TERMINAL = new Set(["finished", "failed", "dry_run", "rejected"]);
const SHA_PREFIX = /^[a-f0-9]{7,40}$/;
export const MAX_WAIT_SECONDS = 50;
// No 0/O/1/I/L so a bot copying the token by hand does not confuse characters.
const ECHO_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// The echo token appears only at the end of the manifest, never in the webhook envelope.
// A bot that reports it back has read the relay's original task to the last line.
export function newEchoToken() {
  const pick = () => Array.from({ length: 4 }, () => ECHO_ALPHABET[randomInt(ECHO_ALPHABET.length)]).join("");
  return `ECHO-${pick()}-${pick()}`;
}

export function taskService(config) {
  if (!config.dataDir) return null;
  if (!services.has(config)) services.set(config, new TaskService(config));
  return services.get(config);
}

export class TaskService {
  constructor(config) {
    if (!["webhook", "pull"].includes(config.deliveryMode || "webhook")) throw new Error("Invalid delivery mode.");
    if (typeof config.botReportKey !== "string" || !config.botReportKey.trim()) {
      throw new Error("Lifecycle mode requires BOT_REPORT_KEY for completion reports.");
    }
    this.config = config;
    this.records = new Map();
    this.dedupe = new Map();
    this.delivering = new Set();
    this.fetchImpl = config.fetchImpl || ((...args) => fetch(...args));
    this.github = new GithubReceipts(config, (...args) => this.fetchImpl(...args));
    this.events = new EventEmitter();
    this.events.setMaxListeners(0);
    const callerKeys = [config.relayApiKey, ...Object.values(config.clientKeys || {})].filter(Boolean);
    if (config.approvalKey && [config.botReportKey, ...callerKeys].includes(config.approvalKey)) {
      throw new Error("RELAY_APPROVAL_KEY must be separate from caller and executor credentials.");
    }
    if (config.approvalKey && config.approvalKey.length < 24) {
      throw new Error("RELAY_APPROVAL_KEY must be at least 24 characters.");
    }
    if (Object.values(config.deployTargets || {}).some((target) => target.requires_approval) && !this.approvalKey()) {
      throw new Error("Deploy targets that require approval need RELAY_APPROVAL_KEY.");
    }
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
    this.events.emit(record.relayTaskId, record);
  }

  // What the executor reads: the original task plus the operator-resolved deploy details.
  manifest(record) {
    const out = { relay_task_id: record.relayTaskId, ...record.task };
    if (record.deployTarget) {
      const envelope = deployEnvelope(record.task, record.deployTarget);
      out.kind = envelope.kind;
      out.deploy = { ...envelope.deploy, ...(record.task.deploy.notes ? { notes: record.task.deploy.notes } : {}) };
    }
    if (record.githubTarget) {
      out.github = { repo: record.githubTarget.repo, ...(record.githubTarget.pr_number ? { pr_number: record.githubTarget.pr_number } : {}) };
    }
    if (record.echoToken) {
      // Keep this last: echoing it proves the reader got to the end of the original task.
      out.integrity = {
        payload_sha256: record.fingerprint,
        echo_token: record.echoToken,
        instruction: "Include echo_token unchanged in your first received or executing report. Routing bots: forward relay_task_id and task_manifest_url, not a summary.",
      };
    }
    return out;
  }

  approvalKey() {
    return this.config.approvalKey || "";
  }

  links(id) {
    if (!this.config.publicBaseUrl) return {};
    return {
      task: new URL(`/tasks/${id}`, this.config.publicBaseUrl).href,
      approval: new URL(`/approvals/${id}`, this.config.publicBaseUrl).href,
    };
  }

  // GitHub receipts are best effort and never change the task result.
  async syncGithub(record) {
    if (!record.githubTarget) return;
    await this.github.sync(record, this.links(record.relayTaskId));
    this.save(record);
  }

  list(owner, { limit = 20, status } = {}) {
    return [...this.records.values()]
      .filter((record) => record.owner === owner && (!status || record.status === status))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 100))
      .map((record) => ({
        relayTaskId: record.relayTaskId,
        title: record.task.title,
        kind: record.task.deploy ? "deploy" : "task",
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        ...(record.task.deploy ? { target: record.task.deploy.target, commit_sha: record.task.deploy.commit_sha } : {}),
        ...(record.verification ? { verification: record.verification.status } : {}),
      }));
  }

  // Long poll: resolve once the record changes after sinceUpdatedAt, it closes, or time runs out.
  waitFor(id, owner, { sinceUpdatedAt, waitSeconds = 0 } = {}) {
    const record = this.get(id, owner);
    if (!record) return Promise.resolve(null);
    const seconds = Math.min(Math.max(Number(waitSeconds) || 0, 0), MAX_WAIT_SECONDS);
    const changed = (current) => (sinceUpdatedAt ? current.updatedAt !== sinceUpdatedAt : false);
    if (seconds === 0 || TERMINAL.has(record.status) || changed(record)) {
      return Promise.resolve({ record, changed: changed(record), timedOut: false });
    }
    return new Promise((resolve) => {
      const before = record.updatedAt;
      const listener = (current) => {
        // Receipt bookkeeping saves keep updatedAt; only real task changes wake the waiter.
        if (current.status === "submitting" || current.updatedAt === before) return;
        clearTimeout(timer);
        this.events.off(id, listener);
        resolve({ record: current, changed: true, timedOut: false });
      };
      const timer = setTimeout(() => {
        this.events.off(id, listener);
        resolve({ record: this.records.get(id), changed: false, timedOut: true });
      }, seconds * 1000);
      timer.unref?.();
      this.events.on(id, listener);
    });
  }

  get(id, owner) {
    const record = this.records.get(id);
    return record && record.owner === owner ? record : null;
  }

  view(record) {
    return {
      relayTaskId: record.relayTaskId,
      status: record.status,
      deliveryMode: record.deliveryMode || "webhook",
      claimedAt: record.claimedAt ?? null,
      source: record.task.source,
      sourceThread: record.task.source_thread ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      transport: record.transport ?? null,
      completion: record.completion ?? null,
      callback: record.callback ?? null,
      kind: record.task.deploy ? "deploy" : "task",
      ...(record.task.deploy ? { deploy: { ...record.task.deploy,
        repo: record.deployTarget?.repo ?? null, environment: record.deployTarget?.environment ?? null,
        requiresApproval: record.deployTarget?.requires_approval === true } } : {}),
      verification: record.verification ?? null,
      integrity: record.echoToken ? { status: record.integrity?.status ?? "unconfirmed",
        event_id: record.integrity?.event_id ?? null, reported_with: record.integrity?.reported_with ?? null,
        at: record.integrity?.at ?? null, payload_sha256: record.fingerprint } : null,
      approval: record.approval ?? null,
      ...(record.status === "awaiting_approval" && this.links(record.relayTaskId).approval
        ? { approvalUrl: this.links(record.relayTaskId).approval } : {}),
      github: record.githubTarget ? { repo: record.githubTarget.repo, pr_number: record.githubTarget.pr_number ?? null,
        commit_sha: record.githubTarget.commit_sha ?? null, context: record.githubTarget.context,
        enabled: record.github?.enabled ?? this.github.enabled(), lastStatus: record.github?.lastStatus ?? null,
        comments: record.github?.posted ?? [], error: record.github?.error ?? null } : null,
      summary: record.completion?.summary ?? record.updates?.at(-1)?.summary ?? null,
      updates: (record.updates || []).map((item) => ({
        event_id: item.event_id,
        status: item.status,
        summary: item.summary,
        at: item.at,
      })),
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
    let deployTarget = null;
    if (task.deploy) {
      const resolved = resolveTarget(this.config, task.deploy.target, owner);
      if (resolved.error) return { isError: true, result: { error: resolved.error } };
      deployTarget = resolved.target;
    }
    if (task.github && !repoAllowed(this.config, task.github.repo)) {
      return { isError: true, result: { error: "github.repo is not allowed for receipts. Add it to RELAY_GITHUB_REPOS or a deploy target." } };
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(task)).digest("hex");
    const dedupeKey = task.client_request_id && `${owner}\0${task.client_request_id}`;
    const previous = dedupeKey && this.records.get(this.dedupe.get(dedupeKey));
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return { isError: true, result: { error: "client_request_id was already used with different task contents." } };
      }
      return { isError: Boolean(previous.transport?.error) || previous.status === "unknown",
        result: withReceipt({ ...(previous.transport ?? {}), ...this.view(previous),
          ...(previous.deliveryMode === "pull" ? { accepted: true } : {}),
          deduplicated: true }) };
    }
    const relayTaskId = randomUUID();
    const now = new Date().toISOString();
    const record = { relayTaskId, owner, task, fingerprint, status: "submitting", updates: [], createdAt: now, updatedAt: now };
    if (this.config.publicBaseUrl && !task.dry_run) record.echoToken = newEchoToken();
    record.deliveryMode = this.config.deliveryMode || "webhook";
    if (deployTarget) record.deployTarget = deployTarget;
    const githubTarget = githubTargetFor(task, deployTarget, relayTaskId);
    if (githubTarget) record.githubTarget = githubTarget;
    if (deployTarget?.requires_approval && !task.dry_run) {
      // Held in the relay until a human enters the approval key. Nothing reaches Grok Bot yet.
      record.status = "awaiting_approval";
      this.save(record);
      if (dedupeKey) this.dedupe.set(dedupeKey, relayTaskId);
      await this.syncGithub(record);
      return { isError: false, result: withReceipt({ accepted: true, ...this.view(record) }) };
    }
    return this.dispatch(record, dedupeKey, fetchImpl);
  }

  async dispatch(record, dedupeKey, fetchImpl) {
    const { task, relayTaskId } = record;
    if (record.deliveryMode === "pull") {
      if (task.dry_run) {
        record.status = "dry_run";
        record.updatedAt = new Date().toISOString();
        this.save(record);
        if (dedupeKey) this.dedupe.set(dedupeKey, relayTaskId);
        return { isError: false, result: withReceipt({ accepted: true, ...this.view(record) }) };
      }
      // Pull inbox alone leaves tasks queued. When a receiver webhook is configured,
      // notify Grok Bot once with relay_task_id so ChatGPT can read later progress.
      if (this.config.webhookUrl && this.config.webhookKey) {
        return this.deliverWebhook(record, task, relayTaskId, dedupeKey, fetchImpl);
      }
      record.status = "queued";
      record.updatedAt = new Date().toISOString();
      this.save(record);
      if (dedupeKey) this.dedupe.set(dedupeKey, relayTaskId);
      await this.syncGithub(record);
      return { isError: false, result: withReceipt({ accepted: true, ...this.view(record) }) };
    }
    return this.deliverWebhook(record, task, relayTaskId, dedupeKey, fetchImpl);
  }

  // Human decision on a deploy held at awaiting_approval. The caller has verified the approval key.
  async decide(id, decision, fetchImpl = this.fetchImpl) {
    const record = this.records.get(id);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (record.status !== "awaiting_approval") {
      return { status: 409, body: { error: `Task is ${record.status}, not awaiting approval.` } };
    }
    record.approval = { decision, at: new Date().toISOString() };
    if (decision === "declined") {
      record.status = "rejected";
      record.declined = true;
      record.updatedAt = record.approval.at;
      this.save(record);
      await this.syncGithub(record);
      return { status: 200, body: this.view(record) };
    }
    record.status = "submitting";
    this.save(record);
    const outcome = await this.dispatch(record, null, fetchImpl);
    const current = this.records.get(id);
    if (current.status === "submitting" && !current.transport) {
      // Refused before any network call (for example a manifest setting is missing): keep it approvable.
      current.status = "awaiting_approval";
      delete current.approval;
      this.save(current);
    }
    return { status: outcome.isError ? 502 : 200, body: outcome.result };
  }

  // Records whether the reporting bot echoed the manifest token. A mismatch is kept, not rejected,
  // so the caller sees that the executor worked from something other than the original.
  checkEcho(record, input, eventId, status) {
    if (input.echo_token === undefined) return {};
    if (typeof input.echo_token !== "string" || input.echo_token.length > 64) {
      return { error: { status: 400, body: { error: "echo_token must be the string from the manifest (max 64 characters)." } } };
    }
    if (!record.echoToken) return {};
    const given = Buffer.from(input.echo_token.trim().toUpperCase());
    const expected = Buffer.from(record.echoToken);
    const matches = given.length === expected.length && timingSafeEqual(given, expected);
    if (record.integrity?.status === "verified" && matches) return {};
    return { integrity: { status: matches ? "verified" : "mismatch", event_id: eventId, reported_with: status, at: new Date().toISOString() } };
  }

  async reverify(id, owner) {
    const record = this.get(id, owner);
    if (!record) return { isError: true, result: { error: "Task not found." } };
    if (!record.task.deploy || record.status !== "finished") {
      return { isError: true, result: { error: "Only finished deploy tasks can be verified." } };
    }
    record.verification = await this.verify(record, { attempts: 1 });
    record.updatedAt = new Date().toISOString();
    this.save(record);
    await this.syncGithub(record);
    return { isError: false, result: withReceipt(this.view(record)) };
  }

  async verify(record, options = {}) {
    const expected = record.task.deploy.commit_sha;
    const reported = record.completion?.deployed_sha;
    const check = await verifyDeployment(record.deployTarget, expected, this.fetchImpl, {
      attempts: options.attempts ?? this.config.verifyAttempts ?? 3,
      delayMs: this.config.verifyDelayMs ?? 2000,
      timeoutMs: this.config.verifyTimeoutMs || 5000,
    });
    const botMatches = reported ? expected.startsWith(reported) : null;
    if (botMatches === false && check.status !== "mismatch") {
      return { ...check, status: "mismatch", botReportedSha: reported, reason: "Bot reported a different deployed_sha." };
    }
    return { ...check, botReportedSha: reported ?? null };
  }

  async deliverWebhook(record, task, relayTaskId, dedupeKey, fetchImpl) {
    const envelope = { ...task, task_id: task.task_id ?? relayTaskId, relay_task_id: relayTaskId,
      ...(record.deployTarget ? deployEnvelope(task, record.deployTarget) : {}) };
    if (record.githubTarget) {
      envelope.github = { repo: record.githubTarget.repo,
        ...(record.githubTarget.pr_number ? { pr_number: record.githubTarget.pr_number } : {}) };
    }
    delete envelope.callback_target;
    delete envelope.client_request_id;
    if (record.echoToken) {
      // Always point at the original so routing bots can pass it on instead of retelling it.
      envelope.task_manifest_url = new URL(`/executor/tasks/${relayTaskId}/manifest`, this.config.publicBaseUrl).href;
      envelope.payload_sha256 = record.fingerprint;
      envelope.manifest_echo_required = true;
    }
    if (task.markdown || Buffer.byteLength(JSON.stringify(envelope)) > 3000) {
      if (!this.config.publicBaseUrl || !this.config.botReportKey) {
        return { isError: true, result: { error: "Rich task manifests require RELAY_PUBLIC_BASE_URL and BOT_REPORT_KEY. Use HTTPS attachment references or brief_url until configured." } };
      }
      const url = new URL(`/executor/tasks/${relayTaskId}/manifest`, this.config.publicBaseUrl);
      // The manifest preserves the full original task. The execution envelope stays small.
      for (const key of ["markdown", "attachments", "context", "constraints"]) delete envelope[key];
      if (envelope.deploy?.notes) delete envelope.deploy.notes;
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
    await this.syncGithub(current);
    return {
      isError: !transport.transportAccepted || Boolean(transport.error),
      result: withReceipt({ ...transport, ...this.view(current) }),
    };
  }

  webhookNotified(record) {
    return Boolean(record?.transport?.transportAccepted);
  }

  inbox() {
    return [...this.records.values()].filter((record) => record.status === "queued")
      .slice(0, 100).map((record) => ({ relay_task_id: record.relayTaskId,
        title: record.task.title, createdAt: record.createdAt }));
  }

  claim(id, input) {
    const record = this.records.get(id);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (!input || typeof input.claim_id !== "string" || !input.claim_id.trim() || input.claim_id.length > 120) {
      return { status: 400, body: { error: "claim_id is required (max 120 characters)." } };
    }
    if (record.deliveryMode !== "pull" || record.task.dry_run) {
      return { status: 409, body: { error: "Task is not claimable." } };
    }
    if (record.claimId) {
      if (record.claimId !== input.claim_id) return { status: 409, body: { error: "Task already claimed." } };
      return { status: 200, body: { ...this.view(record), deduplicated: true } };
    }
    if (record.status !== "queued") return { status: 409, body: { error: "Task is not queued." } };
    record.claimId = input.claim_id;
    record.claimedAt = record.updatedAt = new Date().toISOString();
    record.status = "claimed";
    this.save(record);
    return { status: 200, body: this.view(record) };
  }

  async progress(id, input) {
    const record = this.records.get(id);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (input?.status === "finished" || input?.status === "failed") return this.report(id, input);
    if (record.task.dry_run) return { status: 409, body: { error: "Dry-run tasks cannot be executed or completed." } };
    if (record.deliveryMode === "pull" && !record.claimId && !this.webhookNotified(record)) {
      return { status: 409, body: { error: "Claim the queued task before reporting progress." } };
    }
    if (record.status === "submitting") return { status: 409, body: { error: "Task is still being submitted." } };
    if (record.status === "awaiting_approval") return { status: 409, body: { error: "Task waits for human approval in the relay." } };
    if (["finished", "failed", "rejected"].includes(record.status)) {
      return { status: 409, body: { error: "Task is already closed." } };
    }
    const checked = checkProgress(record, input);
    if (checked.error) return checked.error;
    if (checked.duplicate) return { status: 200, body: withReceipt({ ...this.view(record), deduplicated: true }) };
    const echo = this.checkEcho(record, input, checked.eventId, checked.status);
    if (echo.error) return echo.error;
    if (echo.integrity) record.integrity = echo.integrity;
    const now = new Date().toISOString();
    record.updates = record.updates || [];
    record.updates.push({ event_id: checked.eventId, status: checked.status, summary: checked.summary, at: now });
    if (record.updates.length > 20) record.updates.splice(0, record.updates.length - 20);
    record.status = checked.status;
    record.updatedAt = now;
    this.save(record);
    await this.syncGithub(record);
    return { status: 200, body: withReceipt(this.view(record)) };
  }

  async report(id, input) {
    const record = this.records.get(id);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (record.task.dry_run) return { status: 409, body: { error: "Dry-run tasks cannot be executed or completed." } };
    if (record.status === "awaiting_approval") return { status: 409, body: { error: "Task waits for human approval in the relay." } };
    if (record.deliveryMode === "pull" && !record.claimId && !this.webhookNotified(record)) {
      return { status: 409, body: { error: "Claim the queued task before reporting completion." } };
    }
    const errors = [];
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { status: 400, body: { error: "Report must be an object." } };
    }
    if (record.deliveryMode === "pull" && record.claimId && input.claim_id !== record.claimId) {
      return { status: 409, body: { error: "Completion report must match the task claim_id." } };
    }
    if (typeof input.event_id !== "string" || !input.event_id.trim() || input.event_id.length > 120) errors.push("event_id is required (max 120 characters).");
    if (!["finished", "failed"].includes(input.status)) errors.push("status must be finished or failed.");
    if (typeof input.summary !== "string" || !input.summary.trim() || input.summary.length > 8000) errors.push("summary is required (max 8000 characters).");
    const artifacts = input.artifacts === undefined ? [] : normalizeAttachments(input.artifacts, errors);
    let deployedSha;
    if (input.deployed_sha !== undefined) {
      if (typeof input.deployed_sha !== "string" || !SHA_PREFIX.test(input.deployed_sha.toLowerCase())) errors.push("deployed_sha must be a hex commit sha (7-40 characters).");
      else deployedSha = input.deployed_sha.toLowerCase();
    }
    if (record.task.deploy && input.status === "finished" && !deployedSha) errors.push("Finished deploy reports must include deployed_sha.");
    if (errors.length) return { status: 400, body: { error: errors.join(" ") } };
    const echo = this.checkEcho(record, input, input.event_id, input.status);
    if (echo.error) return echo.error;
    const completion = { event_id: input.event_id, status: input.status, summary: input.summary, artifacts,
      ...(deployedSha ? { deployed_sha: deployedSha } : {}) };
    if (record.completion) {
      if (JSON.stringify(record.completion) !== JSON.stringify(completion)) {
        return { status: 409, body: { error: "A different terminal report already exists." } };
      }
      if (echo.integrity) {
        record.integrity = echo.integrity;
        this.save(record);
      }
      if (record.task.deploy && record.status === "finished" && !record.verification) {
        // The relay stopped between saving the report and verifying it; the Bot's retry resumes it.
        record.verification = await this.verify(record);
        record.updatedAt = new Date().toISOString();
        this.save(record);
        await this.syncGithub(record);
      }
      return { status: 200, body: withReceipt({ ...this.view(record), deduplicated: true }) };
    }
    if (record.status === "rejected") return { status: 409, body: { error: "Task was rejected by the webhook." } };
    if (echo.integrity) record.integrity = echo.integrity;
    record.completion = completion;
    record.status = completion.status;
    record.updatedAt = new Date().toISOString();
    if (record.task.callback_target) record.callback = { status: "pending", attempts: 0, httpStatus: null };
    this.save(record);
    if (record.task.deploy && completion.status === "finished") {
      record.verification = await this.verify(record);
      record.updatedAt = new Date().toISOString();
      this.save(record);
    }
    await this.notify(id, record.owner);
    await this.syncGithub(this.records.get(id));
    return { status: 200, body: withReceipt(this.view(this.records.get(id))) };
  }

  async notify(id, owner, fetchImpl = this.fetchImpl) {
    const record = this.get(id, owner);
    if (!record) return { status: 404, body: { error: "Task not found." } };
    if (record.githubTarget && record.github?.error) await this.syncGithub(record);
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
        summary: record.completion.summary, artifacts: record.completion.artifacts,
        ...(record.completion.deployed_sha ? { deployed_sha: record.completion.deployed_sha } : {}),
        ...(record.verification ? { verification: record.verification.status } : {}) };
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

function githubTargetFor(task, deployTarget, relayTaskId) {
  if (deployTarget) {
    return { repo: deployTarget.repo, commit_sha: task.deploy.commit_sha,
      ...(task.deploy.pr_number ? { pr_number: task.deploy.pr_number } : {}),
      context: `grok-bot/deploy/${deployTarget.name}` };
  }
  if (task.github) {
    return { repo: task.github.repo,
      ...(task.github.commit_sha ? { commit_sha: task.github.commit_sha } : {}),
      ...(task.github.pr_number ? { pr_number: task.github.pr_number } : {}),
      context: `grok-bot/task/${relayTaskId.slice(0, 8)}` };
  }
  return null;
}
