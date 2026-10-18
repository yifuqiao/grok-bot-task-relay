import { redact } from "./forward.js";

const API = "https://api.github.com";
const MAX_SUMMARY = 3000;

// Repositories the relay may post receipts to: RELAY_GITHUB_REPOS plus every deploy target repo.
export function allowedRepos(config) {
  const repos = new Set((config.githubRepos || []).map((repo) => repo.toLowerCase()));
  for (const target of Object.values(config.deployTargets || {})) repos.add(target.repo.toLowerCase());
  return repos;
}

export function repoAllowed(config, repo) {
  return allowedRepos(config).has(String(repo).toLowerCase());
}

// Commit status for the current record state. null means post nothing.
export function desiredStatus(record) {
  const deploy = Boolean(record.task.deploy);
  const summary = record.updates?.at(-1)?.summary;
  switch (record.status) {
    case "awaiting_approval":
      return { state: "pending", description: "Waiting for a human to approve this deploy in the relay." };
    case "submitted":
    case "queued":
    case "claimed":
      return { state: "pending", description: "Handed to Grok Bot. No progress report yet." };
    case "received":
    case "executing":
      return { state: "pending", description: `Grok Bot ${record.status}: ${summary || ""}` };
    case "waiting_approval":
      return { state: "pending", description: `Grok Bot waits for approval: ${summary || ""}` };
    case "finished": {
      if (!deploy) return { state: "success", description: record.completion?.summary || "Grok Bot finished." };
      const check = record.verification?.status;
      if (check === "verified") return { state: "success", description: `Deployed and verified at ${short(record.verification.observedSha)}.` };
      if (check === "mismatch") return { state: "failure", description: `Bot reported done, but health shows ${short(record.verification.observedSha) || "another revision"}.` };
      if (check === "unreachable") return { state: "error", description: "Bot reported done, but the health check could not be read." };
      return { state: "success", description: "Bot reported done. No health check is configured for this target." };
    }
    case "failed":
      return { state: "failure", description: record.completion?.summary || "Grok Bot reported failure." };
    case "rejected":
      return { state: "error", description: record.declined ? "Deploy declined by the approver." : "The webhook rejected the task." };
    case "unknown":
      return { state: "error", description: "Handoff result is unknown. Check before sending again." };
    default:
      return null;
  }
}

// PR comments are what wake an agent subscribed to the PR, so post one per milestone only.
export function commentKey(record) {
  if (record.status === "awaiting_approval") return "awaiting_approval";
  if (record.status === "waiting_approval") return `waiting_approval:${record.updates?.at(-1)?.event_id}`;
  if (["finished", "failed"].includes(record.status)) return `${record.status}:${record.verification?.status || ""}`;
  if (record.status === "rejected") return "rejected";
  return null;
}

export class GithubReceipts {
  constructor(config, fetchImpl) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  enabled() {
    return Boolean(this.config.githubToken);
  }

  // Mutates record.github and record.githubTarget; the caller persists the record.
  async sync(record, links = {}) {
    const target = record.githubTarget;
    if (!target || record.task.dry_run) return;
    if (!this.enabled()) {
      record.github = { enabled: false, reason: "RELAY_GITHUB_TOKEN is not configured." };
      return;
    }
    const state = record.github?.enabled === false ? { posted: [] } : (record.github || { posted: [] });
    state.enabled = true;
    state.posted = state.posted || [];
    try {
      if (!target.commit_sha && target.pr_number) {
        const pr = await this.request("GET", `/repos/${target.repo}/pulls/${target.pr_number}`);
        const sha = pr?.head?.sha;
        if (typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) target.commit_sha = sha;
      }
      const status = desiredStatus(record);
      const statusKey = status && `${status.state}:${status.description}`;
      if (status && target.commit_sha && state.lastStatus !== statusKey) {
        await this.request("POST", `/repos/${target.repo}/statuses/${target.commit_sha}`, {
          state: status.state,
          context: target.context,
          description: clip(this.clean(status.description), 140),
          ...(links.approval || links.task ? { target_url: links.approval && record.status === "awaiting_approval" ? links.approval : links.task } : {}),
        });
        state.lastStatus = statusKey;
      }
      const key = commentKey(record);
      if (key && target.pr_number && !state.posted.includes(key)) {
        await this.request("POST", `/repos/${target.repo}/issues/${target.pr_number}/comments`, {
          body: this.comment(record, key, links),
        });
        state.posted.push(key);
      }
      state.error = null;
    } catch (error) {
      state.error = clip(this.clean(error instanceof Error ? error.message : String(error)), 300);
    }
    state.at = new Date().toISOString();
    record.github = state;
  }

  comment(record, key, links) {
    const task = record.task;
    const lines = [
      `<!-- grok-bot-relay:${record.relayTaskId}:${key} -->`,
      `**Grok Bot 回执** · \`${record.status}\``,
      "",
      `- relay_task_id: \`${record.relayTaskId}\``,
      `- 任务：${this.clean(task.title)}`,
    ];
    if (task.deploy) {
      const env = record.deployTarget?.environment ? `（${this.clean(record.deployTarget.environment)}）` : "";
      lines.push(`- 部署目标：\`${task.deploy.target}\`${env}，请求的 commit \`${short(task.deploy.commit_sha)}\``);
      if (record.completion?.deployed_sha) lines.push(`- Bot 报告实际部署：\`${short(record.completion.deployed_sha)}\``);
      if (record.verification) lines.push(`- 中转独立核验：**${record.verification.status}**${record.verification.observedSha ? `，health 显示 \`${short(record.verification.observedSha)}\`` : ""}${record.verification.httpStatus ? `（HTTP ${record.verification.httpStatus}）` : ""}`);
    }
    if (record.status === "awaiting_approval" && links.approval) {
      lines.push("", `需要人工批准后才会发给 Grok Bot：${links.approval}`, "批准页要求输入审批钥匙，聊天里的 AI 无法代为批准。");
    }
    const summary = record.completion?.summary || record.updates?.at(-1)?.summary;
    if (summary) {
      lines.push("", "Grok Bot 摘要：", ...clip(this.clean(summary), MAX_SUMMARY).split("\n").map((line) => `> ${line}`));
    }
    const artifacts = record.completion?.artifacts || [];
    if (artifacts.length) {
      lines.push("", "产物：", ...artifacts.slice(0, 10).map((item) => `- [${this.clean(item.name).replace(/[[\]]/g, "")}](<${item.url.replace(/[<>\s]/g, "")}>)`));
    }
    lines.push("", "_这条评论由 grok-bot-task-relay 根据 Grok Bot 的认证回报生成。_");
    return lines.join("\n");
  }

  // Bot summaries are untrusted text: strip known secrets and avoid pinging people.
  clean(text) {
    const secrets = [this.config.githubToken, this.config.webhookKey, this.config.relayApiKey,
      this.config.botReportKey, this.config.approvalKey, ...Object.values(this.config.clientKeys || {})];
    return redact(String(text ?? ""), secrets).replace(/@(?=[A-Za-z0-9-])/g, "@​");
  }

  async request(method, pathname, body) {
    let response;
    try {
      response = await this.fetchImpl(`${API}${pathname}`, {
        method,
        redirect: "manual",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.config.githubToken}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "grok-bot-task-relay",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.config.githubTimeoutMs || 10000),
      });
    } catch (error) {
      throw new Error(`GitHub ${method} failed before a response: ${error instanceof Error ? error.message : error}`);
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) throw new Error(`GitHub ${method} ${pathname.split("/").slice(0, 5).join("/")} returned HTTP ${response.status}.`);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
}

function short(sha) {
  return typeof sha === "string" ? sha.slice(0, 12) : "";
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
