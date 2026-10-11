# Grok Bot 任务中转

聊天留在 ChatGPT、Claude、Grok、Muse。方案聊清楚之后，你明确说一句「交给 Grok Bot 执行」，那个平台再调用这里的 `submitTaskToGrokBot`。中转服务把任务 POST 到你已经建好的 Grok Bot webhook。Webhook 密钥只放在本机 `.env`，不要贴进任何聊天。

长说明可以使用 `brief_url`，或启用下文的持久任务模式后直接提交 `markdown`。文件和图片使用 HTTPS 附件引用；本 PR 不提供文件上传或代取外部附件。发给 Grok Bot 的 webhook JSON 仍保持在 3000 字节以内，较大的任务通过受认证保护的完整任务清单传递。

Grok Bot 收到的是一次执行请求。闲聊和头脑风暴不要走这条链路。

## 多平台任务、附件和完成回报

新增的持久任务模式同时服务 MCP 和 HTTP API，支持文件/图片引用、Markdown 正文、任务查询、同一调用方的提交去重以及完成通知。默认不启用，原来的单次转发配置继续工作。

完整配置、接口示例、Grok Bot 完成回报契约和企业微信接入边界见 [任务生命周期与回调](docs/task-lifecycle.md)。平台兼容以实际连接测试为准，不表示已接通 ChatGPT、Claude、Grok、DeepSeek 或企业微信。

启用后，在现有配置基础上设置 `RELAY_DATA_DIR`、稳定公网 HTTPS 的 `RELAY_PUBLIC_BASE_URL`，以及与调用方钥匙不同的 `BOT_REPORT_KEY`。Grok Bot 必须能够用该执行端钥匙读取任务清单和提交完成报告。

MCP 提供 `submitTaskToGrokBot`、`getTaskStatus`、`getTaskResult`；API 提供提交、查询、执行端回报和通知重发接口。需要通知时，管理员在私有环境文件中登记回调目标，任务只填写目标名称。未登记回调时，可使用查询工具读取结果。

`finished` 只由经过认证的 Grok Bot 完成报告触发。webhook 返回 200、分配了中转任务编号、收到 Bot 的接收确认，都不等于执行完成。通知失败不改变任务执行结果，也不会自动再次执行任务。

## 配置

不希望预设接收 Bot/webhook 时，可以选择 [执行端主动领取模式](docs/executor-pull.md)。各平台仍调用同一 MCP/API，任务先进入持久收件箱，再由已授权执行端领取。不需要填写 receiver bot ID 或 webhook；需要一次配置执行端访问与实际运行 worker，本项目不会自动唤醒或创建 Grok Bot。默认 webhook 模式保持兼容。

pull 模式必须运行 `npm run start:http`，MCP 调用方连接 `/mcp`；stdio 入口会拒绝启动，避免接受执行端无法领取的任务。

1. 在 Grok Bot 的 Routines 面板复制 Task Receiver webhook 的 URL 和发送密钥。
2. 复制 `.env.example` 为 `.env`。URL 如果已经填好，只补 `GROK_BOT_WEBHOOK_KEY`。
3. 面板如果显示的不是 `Authorization: Bearer`，再改 `GROK_BOT_WEBHOOK_AUTH_HEADER` 和 `GROK_BOT_WEBHOOK_AUTH_SCHEME`。Scheme 留空表示 header 里只放密钥本身。
4. 运行检查时只会看到 set / missing，不会打印密钥：

```powershell
node src/check-config.js
```

这台机器如果还没有单独安装 Node，可以用 Cursor 自带的：

```powershell
& "$env:LOCALAPPDATA\Programs\cursor\resources\app\resources\helpers\node.exe" src/check-config.js
```

## 本地自测

自测只打本机的假 webhook，不会请求 Grok Bot。

```powershell
node src/selftest.js
```

## 接到 Cursor

Cursor 的 MCP 配置使用 stdio。进程会自己读取项目里的 `.env`。

```json
{
  "mcpServers": {
    "grok-bot-task-relay": {
      "command": "C:\\Users\\yifug\\AppData\\Local\\Programs\\cursor\\resources\\app\\resources\\helpers\\node.exe",
      "args": ["C:\\Users\\yifug\\grok-bot-mcp\\src\\stdio.js"]
    }
  }
}
```

装好系统 Node 之后，把 `command` 改成 `node` 即可。

## 放到 relay

这个服务要跑在一直开着的 relay（`82.157.187.207`）上。电脑关机后，本机的 Cloudflare 临时隧道会停，网页版就连不上。

relay 上用 systemd 和一份只有 root 能读的环境文件，不把密钥写进代码：

- 程序目录：`/opt/grok-bot-task-relay`
- 环境文件：`/etc/grok-bot-task-relay.env`（`GROK_BOT_WEBHOOK_URL`、`GROK_BOT_WEBHOOK_KEY`、`RELAY_API_KEY`）
- 服务单元：`deploy/grok-bot-task-relay.service`
- 对外地址：在现有 Caddy 上反代到 `127.0.0.1:8787`，见 `deploy/Caddyfile.snippet`
- 运行环境：Node.js 22 或更新版本

这台电脑目前没有该 relay 的 SSH 密钥，所以还没有登录，也没有把密钥拷上去。

## 接到 ChatGPT、Claude、Grok、Muse

网页版连的是公网 HTTPS，不是你电脑上的 `127.0.0.1`。先在本机启动中转，再用 Cloudflare Tunnel 给出地址。这个地址会在隧道重启后变化。

```powershell
node src/http.js
cloudflared tunnel --url http://127.0.0.1:8787
```

把终端里出现的 `https://….trycloudflare.com` 加上 `/mcp`，作为各平台的 MCP 地址。调用方的钥匙是 `.env` 里的 `RELAY_API_KEY`，不是 Grok Bot 的 webhook 密钥。把它填进平台自己的认证框，不要贴进聊天。

| 平台 | 在哪里加 | 认证 |
| --- | --- | --- |
| Cursor | 已写入本机 `mcp.json`，用本地进程，不经过隧道 | 进程自己读 `.env` |
| Claude | Settings → Connectors → Add custom connector | Request header 选 `authorization`，值写 `Bearer <RELAY_API_KEY>`，`Bearer` 和密钥之间有一个空格 |
| ChatGPT | Plugins → Add custom MCP server | 地址填公网 `https://<域名>/mcp`，认证选 OAuth。同意页里输入 `RELAY_API_KEY`，不要贴进聊天 |
| Grok | grok.com/connectors → New Connector → Custom | 地址同上。有 authorization 字段时填这把 Bearer 钥匙 |
| Muse 聊天 App | 没有自定义 MCP 入口 | 用 Muse Code |
| Muse Code | `~/.config/muse/settings.json` 的 `mcp_servers` | `url` 填 MCP 地址，并带上同一个 authorization header |

Claude 的网页版如果看不到 Request headers，说明当前账号还不能保存固定钥匙，需要改用 OAuth。那时候不要把服务改成免认证。

ChatGPT 的自定义 MCP 会先找 OAuth。环境里要有 `RELAY_PUBLIC_BASE_URL`（例如 `https://relay.onetopway.com`，不要带路径或结尾斜杠）。Caddy 必须反代整个站点，不能只转发 `/mcp`，否则 `/.well-known` 会 404。同意页核对的是现有的 `RELAY_API_KEY`。Bearer 钥匙仍然可以直接调用，OAuth 通过后发给聊天应用的是另一把访问令牌。

## ChatGPT 看 Grok Bot 的执行状态

交给 Grok Bot 之后，ChatGPT 拿到 `relayTaskId`。你在同一个对话里问进度时，它调用 `getTaskStatus`。`submitted` 只表示 webhook 收下了任务。Grok Bot 再用执行端钥匙把状态写成 `received`、`executing`、`waiting_approval`、`finished` 或 `failed`，摘要在 `summary` 里。只有 `finished` 或 `failed` 表示这单已经结束。

默认把这些状态写在 `data/grok-status`。执行端钥匙是 `BOT_REPORT_KEY`，只放在 relay 的环境文件里，不要贴进聊天。执行 Bot 的说明要包含向 `/executor/tasks/<relay_task_id>/progress` 回报这一步。

## 贴给聊天平台的规则

把下面这段放进该平台的自定义说明或项目说明：

```text
先在这里把任务聊清楚。只有当我明确说交给 Grok Bot 执行、发送或 relay 时，才调用 submitTaskToGrokBot 一次。

提交时带上 schema_version "1"、title、objective、completion_criteria、source。source 用当前平台名，例如 chatgpt、claude、grok、muse。说明较长时写成 Markdown，用 brief_url 指向它，不要把长文或源码塞进 JSON。dry_run 只有我要求连通测试时才设为 true。

不要向我要 webhook 密钥。调用结果里，transportAccepted 只表示 webhook 收下了这次 POST。relayTaskId 用来查进度，不表示 Grok Bot 已经做完。我问进度时调用 getTaskStatus 一次，按返回的 status 和 summary 说明。只有 finished 或 failed 才能说这单结束。失败或结果含糊时不要自动重试。
```

连通测试用准备好的 dry run，一次即可：标题 `relay-ping`，`dry_run` 为 true。看到 HTTP 状态之后停住。200 只说明 webhook 收了请求，不等于 Grok Bot 已经在对话里确认。
