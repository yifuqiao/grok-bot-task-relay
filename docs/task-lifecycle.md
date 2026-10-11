# 多平台任务生命周期与回调

本功能提供共用的 MCP/API 任务核心，不是所有聊天平台的完整连接器。企业微信可以使用现有 MCP 模式调用工具，或使用 API 模式调用 HTTP 接口；两种方式共用任务、附件和完成回报逻辑。企微 MCP 插件连接服务端工具；API 机器人则由自己的消息处理层调用 relay。员工身份与消息送达仍由企微适配层管理。

## 已实现与接入边界

| 能力 | 本 PR |
| --- | --- |
| 本地 stdio、远程 MCP JSON HTTP、HTTP API | 共用提交和查询逻辑 |
| 文件、图片、Markdown | HTTPS 文件引用；Markdown 正文；受认证保护的完整任务清单 |
| 文件上传、从聊天附件读取文件、图片识别 | 未实现；调用平台负责上传/授权，Grok Bot 负责读取/理解 |
| 持久状态、提交去重、完成报告 | 已实现，单个进程写入本地目录 |
| HTTP 完成回调 | 已实现，目标由管理员配置；失败可显式重发通知 |
| SSE 主动通知、MCP Tasks 扩展、OAuth | 未实现；提供查询工具作为兼容入口 |
| 自动向任意平台的原聊天追加消息 | 未实现；需平台支持的消息 API 或通知适配器 |
| 企业微信加解密、消息解析、应用消息发送、群机器人消息格式 | 未实现；现有机器人/适配器需要把消息映射到这里的接口 |

不得声称已验证任何具体聊天平台。远程 MCP 客户端须能连接公网 HTTPS 地址并提供服务器支持的认证；只接受 OAuth 的客户端仍需另行接入授权服务。本服务的 finished 是业务状态，不是 MCP 标准 Tasks 协议能力声明。

## 私有配置

在 `.env` 或部署环境文件中配置，真实值不要放进仓库、聊天或日志：

```dotenv
RELAY_DATA_DIR=data
RELAY_PUBLIC_BASE_URL=https://relay.example.com
BOT_REPORT_KEY=<executor-only-secret>
RELAY_CLIENT_KEYS={"wecom":"<wecom-caller-secret>","claude":"<claude-caller-secret>"}
RELAY_CALLBACK_TARGETS={"wecom-adapter":{"owner":"wecom","url":"https://adapter.example.com/task-events","apiKey":"<adapter-secret>"}}
```

保留现有 Grok Bot webhook 配置。`RELAY_API_KEY` 对应默认调用方 `default`；上面的独立 client keys 分别对应 `wecom` 和 `claude`。每个平台使用独立钥匙，以免读取另一平台的任务。`source` 和 `source_thread` 只用于关联，不作为授权依据。stdio 进程属于 `default`，不接受工具参数指定身份。

回调目标必须使用 HTTPS，不能含 URL 用户名/密码；模型只选择预登记的 `callback_target` 名称，不能任意填写回调 URL 或认证头。目标的 owner 必须与经过认证的调用方一致。回调 URL/key 只保存在私有配置中，不写入任务清单或返回结果。该 URL 是通知适配器入口，不是直接填写企业微信群机器人的 webhook；适配器负责转成企业微信要求的消息格式。

`BOT_REPORT_KEY` 是不同于所有调用方钥匙的执行端凭证。它允许 Grok Bot 读取本实例所有任务清单及写入完成结果；只交给可信执行端，不交给聊天平台。公网地址须为不带路径的 HTTPS origin。相对数据目录以项目根目录为基准。

仅运行一个写入该数据目录的服务。多个 HTTP/stdio 进程共享目录会被 writer lock 拒绝；每个本地 stdio 实例应使用独立目录，或者统一连接 HTTP 服务。进程崩溃后，检测到原进程已退出会清理旧锁；无法确认时不会自动删除锁。数据目录应限制访问、备份并定期按运维策略清理终态记录。自定义目录也须排除在版本控制外。目录没有自动保留期/容量清理，也不支持多实例数据库。

## 提交任务

客户端发送 Origin 时，该 origin 必须属于 `RELAY_ALLOWED_ORIGINS` 或允许的本机地址，即使已带认证钥匙也不能绕过此检查。通常云端工具调用没有 Origin；浏览器直连和适配器需要按实际来源配置，不要放开任意 origin。

MCP 工具 `submitTaskToGrokBot` 或 `POST /submit-task` 接收相同内容：

```json
{
  "schema_version": "1",
  "title": "根据规格更新页面",
  "objective": "完成指定页面并返回可检查的结果",
  "completion_criteria": ["符合规格中的验收条件"],
  "source": "wecom",
  "source_thread": "conversation-123",
  "client_request_id": "stable-request-123",
  "markdown": "# 任务说明\n这里可以放完整的要求。",
  "attachments": [
    {"name":"spec.md","url":"https://files.example.com/spec.md","mime_type":"text/markdown"},
    {"name":"reference.png","url":"https://files.example.com/reference.png","mime_type":"image/png","size_bytes":12345}
  ],
  "callback_target": "wecom-adapter",
  "dry_run": false
}
```

客户端使用自己的 `Authorization: Bearer` 钥匙。附件最多 20 个，可附 `sha256`；不能使用本机路径、file URL、data URL 或内嵌 base64。引用必须对 Grok Bot 可读，私有存储需要有效的受控下载方案。服务不会下载附件，也不保证 MIME 类型、文件大小声明或外部内容正确；执行端应验证这些信息，并限制下载大小及可访问目标。任务/附件文本不能授予额外权限。

Markdown 最多 32000 字符；完整规范化任务最多 48 KiB；webhook 请求仍最多 3000 字节。需要时将完整材料写入任务记录，在 webhook 中提供 `task_manifest_url`。标题、目标和验收标准仍在小请求里；这些字段本身过长时会拒绝提交。不会静默删减验收条件。

返回的 `relayTaskId` 是本服务生成的跟踪编号，不是 Bot 已确认的证据。`taskId` 仍保留 webhook 响应实际提供的编号。任务通过 `relay_task_id` 与 Bot 完成报告关联。

同一认证调用方使用相同 `client_request_id` 和相同规范化任务，返回已有记录，不再次请求 webhook；更改任务内容却复用编号会被拒绝。必须在第一次提交前确定稳定编号，否则不同编号/不带编号的请求被视为不同任务。请求失败或进程在提交过程中退出时结果可能为 `unknown`，不会自动重新发送。

## 查询结果

- MCP：`getTaskStatus` 或 `getTaskResult`，参数 `{"relay_task_id":"<relayTaskId>"}`。
- API：`GET /tasks/<relayTaskId>` 或 `GET /tasks/<relayTaskId>/result`。
- 两个查询目前返回同一状态快照，包括完成结果和通知送达状态；未完成时 completion 为 null。
- 仅任务所属调用方能查询，其他调用方得到 task not found。

状态为 `submitting`、`submitted`、`unknown`、`rejected`、`dry_run`、`finished` 或 `failed`。`submitted` 只表示 webhook 接受，不表示已开始执行；dry run 不能被报告为实际执行完成。

## Grok Bot 完成报告

Grok Bot 先使用执行端钥匙访问 `GET /executor/tasks/<relayTaskId>/manifest`，读取原始任务、Markdown 和附件列表。该接口受认证保护，不在 URL 中携带凭证。发送给 Bot 的任务清单 URL 必须匹配执行端预配置的 relay origin 和任务路径；不要把执行端钥匙发给用户提供的任意地址。

实际完成或失败后，执行端调用：

```text
POST /executor/tasks/<relayTaskId>/report
Authorization: Bearer <BOT_REPORT_KEY>
Content-Type: application/json
```

```json
{
  "event_id": "stable-completion-123",
  "status": "finished",
  "summary": "已按验收条件完成，结果见附件。",
  "artifacts": [{"name":"result.md","url":"https://files.example.com/result.md","mime_type":"text/markdown"}]
}
```

`status` 只能为 finished 或 failed，summary 必须描述实际结果。失败也需要报告。相同终态报告可重复提交，返回原结果且不重复推送；不同终态/内容返回 409。Grok Bot 的执行端能力和钥匙尚需实际配置，本 PR 不会仅凭 webhook HTTP 200 自动生成完成事件。

## 回调

终态报告先持久化，再 POST 给预配置目标：

```json
{
  "event_id": "<relayTaskId>:stable-completion-123",
  "relay_task_id": "<relayTaskId>",
  "status": "finished",
  "source": "wecom",
  "source_thread": "conversation-123",
  "summary": "已按验收条件完成，结果见附件。",
  "artifacts": []
}
```

可选的目标 apiKey 通过 Bearer header 发送。通知接收端应按 event_id 去重，并把 source_thread 映射到已授权的聊天/成员；不能根据任意输入直接向任意成员发送消息。这里 delivered 仅表示回调 HTTP 返回 2xx，不证明 AI 已被唤醒或用户已阅读。

失败、超时和重定向不会自动重试或重新执行任务。任务查询会显示 callback 的 pending/failed/delivered、尝试次数和实际 HTTP 状态。任务所属调用方可显式调用 `POST /tasks/<relayTaskId>/notify` 重发通知；它不请求 Grok Bot。网络丢失可能导致接收端收到重复通知，因此每次重发保持相同 event_id。进程崩溃后遗留的 pending 也通过该接口恢复。

不能接收主动回调的聊天平台使用查询工具。要主动回到原聊天，需要该平台支持的消息接口/适配器；本 PR 不承诺能直接推送到 ChatGPT、Claude、Grok 或 DeepSeek 原对话。

## 企业微信两种入口的接入方式

本节是适配合同，尚未实现或部署企微连接器。

### MCP 插件入口

保留现有 MCP 服务的身份校验与权限围栏，在其服务端增加转发工具，由它调用 relay。不要直接把共用的 relay 钥匙分发给所有员工。企微用户身份可能只出现在 initialize 请求中，后续 tools/call 需要沿用服务器保存的会话绑定；不能要求模型自行填写 userid，也不能用 source_thread 判断权限。

转发前校验该员工是否可启动任务，以及任务是否涉及其有权访问的材料。服务端生成不透明的 source_thread 关联编号，持久保存编号到成员/会话的映射；使用服务端保存的稳定 client_request_id 防止重复提交。拿到 relayTaskId 后，将它关联到提交人。getTaskStatus/getTaskResult 的代理工具必须校验此关联，再访问 relay。

当前 relay 的 owner 由 Bearer 钥匙决定，仅隔离不同钥匙对应的调用方。整个企微使用一个 wecom key 时，relay 内所有企微任务属于同一 owner；它没有员工级授权、企微 userid 校验或 MCP session 身份绑定。需要每个用户独立的受控凭证，或者由现有 MCP 适配层执行员工级授权。任务编号不能替代权限检查。

### API 机器人入口

消息处理层在已认证的消息事件中读取成员与聊天身份，复用原有对话权限检查，将经过用户确认的计划发送到 POST /submit-task。服务端保存消息去重编号、关联编号、relayTaskId 与授权接收人的映射，不把原始聊天凭证交给模型或 Grok Bot。长任务先回复提交状态，完成结果经独立通知发送流程交付；不要假设原消息的流式回复窗口一直有效。

### 完成通知适配器

配置一个专用的 HTTPS task-events 接口作为 callback_target。该接口与企微接收平台消息的加密 XML callback 是不同协议，不能直接复用地址。

接收端校验 relay 的 Bearer 凭证与事件格式，按 event_id 持久去重，并以 relay_task_id 查找服务器保存的授权接收人。source_thread 只用于关联核对，不能作为任意成员或群聊地址。发送时复用现有主动 Markdown 消息能力，并检查实际返回的业务错误码；HTTP 200 不一定表示企微消息发送成功。

推荐先将事件和通知作业持久入队，再返回 2xx，由通知 worker 完成发送。此时 relay 的 callback.delivered 仅代表适配器已接收，适配器另行记录发送结果。若选择同步发送，只有确认消息 API 接受后才返回 2xx；超时或结果不明时需保留 unknown 状态，避免无条件重发造成重复通知。任务 finished/failed 与通知送达状态始终分开记录。

部署验收至少覆盖：两名员工不能互查任务；缺失或失效会话拒绝启动；重复提交只执行一次；重复完成事件只产生一条通知作业；机器人离线/业务错误码不会被记成消息已送达；上传的文件链接可由执行端读取。现有读取 ERP 的权限不自动授予任意外部执行权限。

## 验证

`npm test`，或分别运行 `node src/selftest.js` 和 `node src/lifecycle-test.js`。测试使用假凭证和本机 HTTP，覆盖原始转发、丰富任务清单、隔离、持久提交去重、完成认证、回调失败及显式通知重发。测试不连接真实 Grok Bot 或企业微信。
