// Human approval page for deploys held at awaiting_approval. Every value is escaped.
export function approvalPage({ record, view, message } = {}) {
  const rows = [];
  if (view) {
    const deploy = view.deploy || {};
    rows.push(
      ["任务", view.relayTaskId],
      ["标题", record.task.title],
      ["状态", view.status],
      ["仓库", deploy.repo],
      ["环境", deploy.environment],
      ["目标", deploy.target],
      ["Commit", deploy.commit_sha],
      ["回滚到", deploy.rollback_sha],
      ["PR", deploy.repo && deploy.pr_number ? `https://github.com/${deploy.repo}/pull/${deploy.pr_number}` : null],
      ["来源", view.source],
      ["说明", deploy.notes],
    );
  }
  const table = rows.filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([label, value]) => `<tr><th>${escape(label)}</th><td>${escape(value)}</td></tr>`).join("");
  const form = view?.status === "awaiting_approval" ? `
  <form method="post">
    <label>审批钥匙 <input type="password" name="approval_key" autocomplete="off" required></label>
    <div class="actions">
      <button type="submit" name="decision" value="approve">批准并交给 Grok Bot</button>
      <button type="submit" name="decision" value="decline" class="secondary">拒绝</button>
    </div>
  </form>` : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>部署审批</title>
<style>
:root { color-scheme: light dark; --bg: #fafafa; --fg: #1d1d1f; --muted: #6e6e73; --line: #d2d2d7; --accent: #0a66c2; }
@media (prefers-color-scheme: dark) { :root { --bg: #161617; --fg: #f5f5f7; --muted: #a1a1a6; --line: #3a3a3c; --accent: #4da3ff; } }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 16px; }
h1 { font-size: 22px; margin: 0 0 4px; }
p.note { color: var(--muted); margin: 0 0 20px; }
table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
th, td { text-align: left; padding: 8px 0; border-bottom: 1px solid var(--line); vertical-align: top; word-break: break-all; }
th { width: 88px; color: var(--muted); font-weight: 500; }
label { display: block; margin-bottom: 16px; }
input { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
button { padding: 10px 16px; font: inherit; border-radius: 8px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
button.secondary { background: transparent; color: var(--fg); border-color: var(--line); }
.message { padding: 12px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 20px; }
</style></head>
<body><main>
<h1>部署审批</h1>
<p class="note">批准后中转才会把这次部署交给 Grok Bot。聊天里的 AI 拿不到审批钥匙，不能代你批准。</p>
${message ? `<div class="message">${escape(message)}</div>` : ""}
${table ? `<table>${table}</table>` : ""}
${form}
</main></body></html>`;
}

function escape(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}
