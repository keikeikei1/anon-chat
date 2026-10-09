# anon-chat · 匿名随机聊天

[English](README.md) | **中文**

基于 **Cloudflare Workers + Durable Objects** 的匿名随机聊天：**一对一随机配对** 加一个 **公共大厅**。
没有服务器、不用运维，整个跑在 Cloudflare 免费额度里。

支持文字和图片，界面中文，手机优先。不用注册、不写 Cookie、默认不留聊天记录。

## 功能

| | |
|---|---|
| **一对一模式** | 排队 → 配对 → 聊天，「换一个」重新排队 |
| **大厅模式** | 所有人同一个群（软上限 500 人），每人分配编号（「陌生人 7」）|
| **发图片** | 前端 canvas 压到 ≤1280px、JPEG ≤300KB，直接走 WebSocket，不落盘、不用对象存储 |
| **聊天历史** | 大厅给后进来的人补最近 100 条，默认保留 **3 天**；更早的图片降级成「[图片]」占位 |
| **年龄门** | 进入前必须勾选已满 18 岁 |
| **举报** | 举报**只上报、不自动处置** —— 不自动踢人也不自动封禁，由管理员在面板里看过再决定 |
| **管理** | 按 IP 哈希踢出 / 封禁 / 解封（默认 7 天），加关键词过滤和连接级限频 |
| **心跳** | 3 分钟 ping/pong + 僵尸连接清理（5 分钟判定），不会把你配对给一个死人 |

## 架构

```
浏览器 ──WebSocket──> Worker ──> Lobby（单个 Durable Object）
                                   ├─ 一对一配对队列
                                   ├─ 大厅广播（Set<conn>）
                                   ├─ 举报快照   （SQLite key: report:*）
                                   ├─ 封禁名单   （SQLite key: ban:*）
                                   └─ 聊天历史   （SQLite key: m:<时间戳>:<随机>，带 TTL）
```

* 所有在线状态放在一个 Durable Object 里（`idFromName('global')`），配对和广播因此非常简单。
* 只有三种情况会写盘：有人举报时的快照、封禁名单、历史窗口。后两者由 Durable Object 的 **alarm** 定期清理过期数据。
* **从不存原始 IP** —— 只存 `sha256(IP + IP_SALT)`，加盐且单向。

## 隐私说明（务必读）

* 它防得住**普通用户**，防不住**法律程序**。Cloudflare 侧能看到连接元数据；而「举报快照」里故意保留了 IP **哈希**，是为了让管理员能处理滥用。
* 历史保留意味着服务器**确实**持有最近几天的消息 —— 想做到「什么都不存」，就把 `HISTORY_TTL_MS` 关掉或直接删掉这段逻辑。
* 别把它当违法内容的窝点。出事时收到信的是你，运营者。

## 部署

```bash
git clone <本仓库> && cd anon-chat

# 1) 改 wrangler.jsonc：name、routes.pattern、ADMIN_KEY、IP_SALT 四个都要改
# 2) 配置凭据（不要提交进仓库）
export CLOUDFLARE_API_KEY=...      # Global API Key，或者用 CLOUDFLARE_API_TOKEN
export CLOUDFLARE_EMAIL=...
export CLOUDFLARE_ACCOUNT_ID=...

./deploy.sh
```

`routes.pattern` 配了 `custom_domain: true` 会自动帮你建 DNS 记录。
如果 npm 源很慢，`deploy.sh` 里带了国内镜像的兜底。

## 管理面板

```
https://你的域名/admin?key=<ADMIN_KEY>
```

* 实时数字：大厅在线、一对一排队、总连接、举报数、封禁数、记录保留天数
* 每条举报：时间、模式（一对一/大厅）、双方 IP 哈希、当时在场的人、消息快照
* 每条举报的操作：**踢出（只踢在线）** · **封禁 7 天** · **封禁举报方** · **标记已处理**
* 页面级操作：**清场（踢掉所有连接）**、**清空举报记录**

举报有「未处理 / 已处理」两种状态，方便你一条条过。

## 测试

用 Node 22 内置的 `WebSocket`，不需要装任何依赖。

```bash
# 每轮开跑前先清场：残留连接和残留房间是最大的假失败源
curl "https://你的域名/admin/reset?key=$ADMIN_KEY"

WS_URL=wss://你的域名/ws BASE=https://你的域名 ADMIN_KEY=... node test_ws.mjs            # 一对一：配对/文字/图片/外链拦截/举报
WS_URL=... BASE=...                                   node test_group.mjs                # 大厅：进厅/广播/历史
WS_URL=... BASE=... ADMIN_KEY=...                     node test_ban.mjs                  # 封禁→连接被拒→解封
WS_URL=...                                            node test_report_semantics.mjs     # 举报不得断开对方（人工审核语义）
```

> ⚠️ 两个环境的坑：① 从国内连 Cloudflare 的 WebSocket 偶尔十几秒才连上，同一轮里开 4 条连接更容易失败 —— 先清场、连接之间留间隔再判断；② 部署完**第一次**测试可能仍是旧行为（Durable Object 实例切换有延迟），复跑一次再下结论。

## 免费额度参考

* Durable Objects 免费档：**10 万请求/天 + 13,000 GB-s/天**。
  **入站 WebSocket 消息按 20:1 折算**（100 条 = 5 个请求），**服务端出站发送不计费**。
  一个大厅几百人聊天仍然在额度内。
* 想省 GB-s 可以换 **WebSocket Hibernation API**（`state.acceptWebSocket()` + `webSocketMessage()`），代价是内存里的状态要挪进 storage。

## 许可

MIT
