# 任务清单：让 Grok Bot 任务中转脱离这台电脑

用户已批准。按顺序做。做完一项再做下一项。不要把密钥写进回复、仓库或截图。

源码在这台 Windows 电脑：`C:\Users\yifug\grok-bot-mcp`。不要把源码或这份长说明塞进 webhook JSON。

## 1. 把代码拷到 relay

- 用已有的 SSH 登录 `82.157.187.207`。不要猜测新账号。
- 拷贝项目到 `/opt/grok-bot-task-relay`。
- 不要拷贝 `.env`、`.git`、`release.tgz`。
- 如果目录里已经有同一次部署留下的文件，在上面更新，不要另起一份。

完成：relay 上能看到 `src/http.js` 和 `deploy/grok-bot-task-relay.service`。

## 2. 安装并开机自启

- 需要 Node.js 22 或更新版本。项目没有第三方依赖。
- 使用包内的 `deploy/grok-bot-task-relay.service`。
- 监听 `127.0.0.1:8787`。

完成：`systemctl enable --now` 之后，本机 `http://127.0.0.1:8787/health` 返回 `status` 为 `up`。

## 3. 写入环境文件

- 从 Windows 的 `C:\Users\yifug\grok-bot-mcp\.env` 读取这些值：`GROK_BOT_WEBHOOK_URL`、`GROK_BOT_WEBHOOK_KEY`、`GROK_BOT_WEBHOOK_AUTH_HEADER`、`GROK_BOT_WEBHOOK_AUTH_SCHEME`、`RELAY_API_KEY`。
- 只写入 `/etc/grok-bot-task-relay.env`，权限 `0600`。另外写上 `PORT=8787` 和 `HOST=127.0.0.1`。
- 读不到本机 `.env` 时停下来，说明缺本地文件访问。不要让用户把密钥贴进聊天。
- 写完后确认 `/health` 里 `webhookConfigured` 为 `true`。不要打印文件内容。

完成：环境文件只有 root 可读，健康检查显示 webhook 已配置，回复里没有密钥。

## 4. 给出不依赖这台电脑的 HTTPS 地址

- 不要改现有 dashboard 的 Caddy 站点。
- 只有在 relay 上已经有可用的新域名时，才为它增加反代到 `127.0.0.1:8787`。改之前先校验配置。
- 没有新域名时，不要改 Caddy。回复里说明还缺哪一个域名。
- 有域名时，确认 `https://<域名>/mcp` 在不带钥匙时返回 401。

完成：要么给出可用的 `https://…/mcp`，要么明确写出还缺的域名。两种结果都要保证旧站点仍可访问。

## 5. 把代码放进私人远程仓库

- 不要提交 `.env`、`release.tgz` 或任何密钥。
- 这台 Windows 电脑不能创建 Cursor 托管仓库。使用用户已有的私人 Git 远程；如果没有，先完成前面的部署，再在回复里说明仓库还没地方放。
- 不要为了建仓库而把服务停掉。

完成：有远程仓库时给出仓库地址；没有时说明原因。两种情况都不含密钥。

## 不要做的事

- 不要登录 ChatGPT、Claude、Grok、Muse 去添加连接器。用户会自己加。
- 不要删除 relay 上的现有数据。
- 不要再发一次部署 webhook。
