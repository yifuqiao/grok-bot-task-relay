# 无固定 receiver webhook 的任务入口

设置 RELAY_DELIVERY_MODE=pull，聊天平台使用原 submitTaskToGrokBot 或 POST /submit-task，服务将任务写入持久收件箱。调用方不需要选 Bot，也不需要 receiver webhook。默认仍为 webhook 模式。

这是本 relay 的执行端接口，不是 Grok Bot 官方 API。尚未验证 Grok Bot 自动创建 Bot、唤醒 Bot、或动态选择 Bot 的接口，也没有实现此类能力。需要一个具备 HTTP 调用权限的执行端 worker，或经实际验证能够轮询的 Grok Bot skill/routine，领取任务并执行。只有配置收件箱而没有运行执行端时，任务会保持 queued。

## 一次连接配置

```dotenv
RELAY_DELIVERY_MODE=pull
RELAY_DATA_DIR=data
RELAY_API_KEY=<caller-secret>
BOT_REPORT_KEY=<executor-only-secret>
```

pull 模式不需要 GROK_BOT_WEBHOOK_URL、GROK_BOT_WEBHOOK_KEY 或 RELAY_PUBLIC_BASE_URL。执行端需要知道 relay 的可达 HTTPS 地址，并在私有配置中保存 BOT_REPORT_KEY；公网部署仍需 HTTPS、访问控制与原有 Origin/Host 检查。执行端钥匙与调用方钥匙必须不同，允许读取本实例所有任务，不要交给普通聊天调用方。单实例存储和员工级授权边界与任务生命周期文档相同。

完整任务最多 48 KiB，直接保存在记录中；不经过 3000 字节 webhook。附件仍为受控 HTTPS 引用，不是上传功能。

## 执行端协议

以下请求都使用 Authorization: Bearer 的执行端钥匙，不能使用普通调用方钥匙。

1. GET /executor/tasks 返回最多 100 个 queued 任务，字段为 relay_task_id、title、createdAt。领取后从队列移除，下次读取会出现后续任务。
2. 为本次领取生成并持久保存唯一 claim_id，POST /executor/tasks/<id>/claim，JSON 为 {"claim_id":"stable-worker-attempt-id"}。HTTP 200 表示已保留，409 表示被其他执行端领取或不可执行；不能在 409 后继续执行。相同 claim_id 重试返回同一状态，不再次领取。多个执行端竞争时只有一个领取成功。
3. GET /executor/tasks/<id>/manifest 获取完整任务，读取材料并按用户批准的范围执行。claimed 只表示保留，不证明已经执行；重复领取响应里的 finished/failed 是已完成任务，不要再次执行。
4. POST /executor/tasks/<id>/report，沿用完成报告格式并附上同一 claim_id：

```json
{
  "claim_id": "stable-worker-attempt-id",
  "event_id": "stable-completion-id",
  "status": "finished",
  "summary": "实际完成结果",
  "artifacts": []
}
```

失败使用 failed，并描述实际失败。queued 任务不能直接提交终态，claim_id 不匹配会返回 409。重复终态报告与完成回调去重沿用现有规则。执行端必须持久保存任务编号、claim_id、工作进度和报告编号，重启后恢复已有工作；执行端钥匙本身具有管理本实例执行结果的权限，claim_id 不是独立安全凭证。

## 提交与恢复语义

首次提交返回 HTTP 202、accepted=true、status=queued、transport=null。MCP 返回相同业务结果；没有 webhook HTTP 状态，也不会声称 Bot 已确认接收。相同 client_request_id 的重复提交仍返回原任务；领取后查询显示 claimed，终态显示 finished/failed。切换服务的 delivery mode 不会迁移已有任务，记录保留提交时的模式。

dry_run 验证并保存任务，但直接进入 dry_run 终态，不进入收件箱、不能领取、不会执行或发送完成通知。它不测试真实 Grok Bot 连通性。

领取没有自动过期和再分配：执行端崩溃时任务保持 claimed，避免未知执行结果被另一 Bot 重复执行。执行端应按保存的任务/claim_id 恢复；永久丢失执行端记录需要人工核对实际结果，目前没有自动恢复或重新分配接口。提交方可继续查询任务状态。

回调仍使用预登记 callback_target。主动回到企业微信等原聊天还需要消息适配器；取消 receiver webhook 不会取消通知适配器配置。

## 验证

npm test 包括原有 webhook 测试、生命周期测试和 pull 模式测试：无 webhook 提交、丰富材料、身份隔离、竞争领取、领取去重、重启恢复、完成校验与 dry run。测试使用本地 HTTP 和假凭证，不代表已在 Grok Bot 产品里端到端验证。
