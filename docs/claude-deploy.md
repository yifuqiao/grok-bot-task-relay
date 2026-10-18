# Claude ⇄ Grok Bot：部署、任务和回执

这一页说明 Claude（claude.ai 和 Claude Code 云端会话）怎样通过这个中转把部署和任务交给 Grok Bot，以及 Grok Bot 的回执怎样回到 Claude。其他平台（ChatGPT、Cursor、Grok）用的是同一套工具。

## 整体流程

```text
Claude 写代码、开 PR
   │  deployRelease(target, commit_sha, pr_number)
   ▼
中转 ──(需要审批的目标)──► awaiting_approval ──► 你在 /approvals/<id> 输入审批钥匙
   │                                                │
   │◄───────────────────────────────────────────────┘ 批准
   ▼
Grok Bot webhook（kind: "deploy"，带 repo / environment / commit_sha / health_url）
   │  received → executing → finished(deployed_sha)
   ▼
中转独立读取 health_url，核对正在运行的 commit
   │
   ├─► GitHub：每次状态变化更新 commit status，审批 / 结束时在 PR 发评论（会唤醒订阅了 PR 的 Claude）
   ├─► waitForTask：Claude 长轮询，最多 50 秒一次，有新回报马上返回
   └─► getTaskStatus / listTasks：随时查
```

## 1. 连接 Claude

在 claude.ai 的 Settings → Connectors → Add custom connector：

- URL：`https://relay.onetopway.com/mcp`
- 认证：OAuth。claude.ai 会自动注册客户端（`/register`），然后打开同意页，在同意页输入 `RELAY_API_KEY`。不要把钥匙贴进聊天。

连好后，claude.ai 聊天和 Claude Code 云端会话里都会出现 `submitTaskToGrokBot`、`deployRelease` 等工具。

想让 Claude 的任务和 ChatGPT 的任务互相隔离，就在 `RELAY_CLIENT_KEYS` 里给 Claude 单独一把钥匙（例如 `{"claude":"..."}`），连接器改用 Request header `authorization: Bearer <那把钥匙>`。OAuth 连进来的所有客户端都算 `default` 调用方。

## 2. relay 上的配置

写在 `/etc/grok-bot-task-relay.env`（权限 0600），然后重启服务。

```dotenv
RELAY_DATA_DIR=data
BOT_REPORT_KEY=<executor-only-secret>
RELAY_PUBLIC_BASE_URL=https://relay.onetopway.com

RELAY_DEPLOY_TARGETS={"relay-prod":{"owners":["default","claude"],"repo":"yifuqiao/grok-bot-task-relay","environment":"production","health_url":"https://relay.onetopway.com/health","health_sha_field":"commit","requires_approval":true}}
RELAY_APPROVAL_KEY=<human-only-secret>

RELAY_GITHUB_TOKEN=<fine-grained token>
RELAY_GITHUB_REPOS=yifuqiao/grok-bot-task-relay
```

| 设置 | 作用 |
| --- | --- |
| `RELAY_DEPLOY_TARGETS` | 部署目标白名单。模型只能挑名字，仓库、环境、health 地址都来自这里。`owners` 限定哪些调用方能用；`requires_approval` 让部署先停在中转等人批准。 |
| `RELAY_APPROVAL_KEY` | 只给人用的审批钥匙，至少 24 个字符。有目标需要审批时必须配置，不能和调用方或执行端钥匙相同。聊天平台和 AI 都拿不到它，所以 AI 不能自己批准生产部署。 |
| `RELAY_GITHUB_TOKEN` | 用来发 commit status 和 PR 评论。建议用 fine-grained token，只授权相关仓库的 Commit statuses: write 和 Pull requests: write。 |
| `RELAY_GITHUB_REPOS` | 普通任务（非部署）可以回执到的仓库。部署目标的仓库自动允许。 |

`node src/check-config.js` 只显示 set / missing，不打印钥匙。

### 被部署的服务要报告自己的 commit

独立核验要求目标的 `health_url` 返回 JSON，在 `health_sha_field`（点路径，默认 `commit`）里给出正在运行的 commit sha。中转自己的 `/health` 已经带 `commit`，来源依次是 `RELAY_GIT_SHA`、项目根目录的 `REVISION` 文件、`.git`。不带 `.git` 拷贝部署时，部署脚本写一行 `git rev-parse HEAD > REVISION`。

没有配置 `health_url` 的目标，verification 为 `skipped`，结果只能依赖 Grok Bot 的自报。

## 3. 工具

| 工具 | 用途 |
| --- | --- |
| `listDeployTargets` | 列出当前调用方能用的部署目标 |
| `deployRelease` | 部署一个 commit。必须是完整 40 位 sha，不接受分支名。默认去重键是 `deploy:<target>:<sha>`，同一个 commit 不会被重复部署；明确要重新部署时传新的 `client_request_id` |
| `submitTaskToGrokBot` | 普通执行任务。可以带 `github: {repo, pr_number}`，让回执发到 PR 上 |
| `waitForTask` | 最多等 50 秒，任务一变就返回。传上次结果的 `updatedAt` 作为 `since_updated_at` |
| `getTaskStatus` / `getTaskResult` | 读一次当前状态 |
| `listTasks` | 列出自己最近的任务。云端会话是临时的，换了会话也能用它找回 `relayTaskId` |
| `verifyDeployment` | 重新读一次 health，核对正在运行的 commit |
| `getRelayInfo` | 中转版本、commit、是否启用部署和 GitHub 回执 |

HTTP 也有对应接口，都用调用方的 Bearer 钥匙：`POST /deploy`、`GET /deploy-targets`、`GET /tasks`、`GET /tasks/<id>?wait=50&since=<updatedAt>`、`POST /tasks/<id>/verify`。

## 4. 状态怎么读

| 状态 | 含义 |
| --- | --- |
| `awaiting_approval` | 停在中转，还没发给 Grok Bot。结果里的 `approvalUrl` 交给人去批准 |
| `submitted` / `queued` | 已交给 Grok Bot（或进入收件箱），还没有回报 |
| `received` / `executing` / `waiting_approval` | Grok Bot 的进度回报。`waiting_approval` 是 Bot 自己停下来等人确认 |
| `forwarded` | 收件或分拣 Bot 把任务转给了另一个 Bot，还没有执行。接手的 Bot 继续用同一个 relay_task_id 回报 |
| `finished` | Bot 报告完成。部署任务还要看 `verification.status` |
| `failed` | Bot 报告失败 |
| `rejected` | webhook 拒绝，或者审批人拒绝了（`approval.decision` 为 `declined`） |

部署任务的 `verification.status`：

- `verified`：中转读到 health，正在运行的就是请求的 commit。只有这种情况才算部署确认成功。
- `mismatch`：health 显示的是别的 commit，或者 Bot 报的 `deployed_sha` 和请求的不一致。
- `unreachable`：health 读不到。可以稍后用 `verifyDeployment` 再查。
- `skipped`：这个目标没有配置 health 检查。

GitHub commit status 的含义一样：verified 对应 success，mismatch 对应 failure，unreachable 对应 error。

## 5. 原文核对（暗号）

任务经过收件分拣、转交这些中间环节时，执行的 Bot 拿到的可能是别人的转述，不是原文。relay 用暗号来确认这一点：

- relay 配置了 `RELAY_PUBLIC_BASE_URL` 时，每个任务都会生成一个随机暗号，形如 `ECHO-7F3K-92QD`。暗号只写在 relay 任务清单的最末尾，webhook 消息里没有，转述的摘要里也不会有。
- webhook 消息里总是带着 `task_manifest_url`、`payload_sha256`（原文指纹）和 `manifest_echo_required: true`。
- 执行的 Bot 用执行端钥匙读取清单，在第一次回报 `received` 或 `executing` 时把暗号放进 `echo_token` 字段。
- relay 自动比对，结果写在任务的 `integrity.status` 里：`verified` 表示回报的 Bot 读完了完整原文；`mismatch` 表示暗号不对，它手上的不是原文；`unconfirmed` 表示还没有 Bot 回报暗号。
- 暗号不对时，relay 不会拒收这次回报，只会如实记录，由调用方判断要不要相信结果。PR 回执评论里也会显示这一项。

LLM 算不了 sha256，所以 `payload_sha256` 留给程序核对，Bot 只需要回显暗号。

## 6. GitHub 回执

任务或部署带上 PR 后：

- 每次状态变化，中转在 commit 上更新一个 status。上下文是 `grok-bot/deploy/<target>` 或 `grok-bot/task/<编号前 8 位>`，在 PR 的检查列表里可以看到。
- 需要人工批准时、任务结束时、核验结果改变时，在 PR 上发一条评论，开头有 `<!-- grok-bot-relay:<id>:<事件> -->` 标记，同一事件只发一次。
- Bot 的摘要会去掉已知密钥，`@` 提及会被中和，避免误 @ 别人。
- 发 GitHub 失败不影响任务结果，错误写在任务的 `github.error` 里。调用 `POST /tasks/<id>/notify` 可以重发。

Claude Code 云端会话订阅了 PR 之后，PR 评论会把会话唤醒，所以 Claude 不需要一直轮询，也能看到“已部署并核验”。

## 7. 安全边界

- 模型只能选登记过的目标名，不能指定主机、命令或 health 地址。
- 部署只接受完整 commit sha，避免“部署 main”时实际部署了别的提交。
- 生产目标设 `requires_approval`，中转在拿到人工批准前不会联系 Grok Bot。审批钥匙至少 24 个字符；同一来源 IP 对同一任务输错会被限速（约 10 次 / 15 分钟），输错还会多等 1 秒。正确钥匙始终可立即批准并清掉该 IP 的计数，别人故意输错不能把生产审批锁死。
- `finished` 只能由带执行端钥匙的回报产生。部署成功还要通过中转自己的 health 核对。
- GitHub 回执只发到白名单仓库。

## 8. 验证

`npm test` 包含 `src/deploy-test.js`：目标白名单和调用方限制、部署信封、去重、PR 回执、commit 不一致、Bot 报错 sha、人工审批（调用方钥匙不能代替审批钥匙）、长轮询、任务列表隔离、GitHub 失败不影响结果。测试使用本地假服务，不连接真实的 Grok Bot 或 GitHub。
