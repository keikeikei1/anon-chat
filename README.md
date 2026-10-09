# anon-chat

**English** | [中文](README.zh-CN.md)

Anonymous random chat — **1-on-1 pairing** plus a **single public lobby** — running entirely on
Cloudflare Workers + Durable Objects. Zero servers, zero maintenance, and it fits in the free tier.

Text and images. Chinese UI. Mobile-first. No accounts, no cookies, no message log by default.

## Features

| | |
|---|---|
| **1-on-1 mode** | Queue → pair → talk. "Next" re-queues you. |
| **Lobby mode** | Everyone in one room (soft cap 500). Each member gets a number ("stranger #7"). |
| **Images** | Client-side canvas compression (≤1280px, JPEG ~300 KB) sent straight over the WebSocket — no R2, no file storage. |
| **History** | Lobby keeps the last 100 messages for N days (default **3**) so newcomers can catch up. Older images degrade to a `[image]` placeholder. |
| **Age gate** | 18+ acknowledgement before entering. |
| **Reports** | Reports are **recorded only** — nothing is auto-kicked or auto-banned. An operator reviews them in the admin panel and decides. |
| **Moderation** | Kill / ban / unban by IP hash (7 days default), plus keyword filters and per-connection rate limits. |
| **Heartbeat** | 3-minute ping/pong + stale-connection culling (5 min), so you never get paired with a ghost. |

## Architecture

```
browser ──WebSocket──> Worker ──> Lobby (single Durable Object)
                                    ├─ 1-on-1 pairing queue
                                    ├─ lobby broadcast (Set<conn>)
                                    ├─ report snapshots  (SQLite key: report:*)
                                    ├─ bans              (SQLite key: ban:*)
                                    └─ chat history      (SQLite key: m:<ts>:<rand>, TTL)
```

* One Durable Object (`idFromName('global')`) holds all live state, so pairing and broadcasting are trivial.
* Nothing is written to disk except: report snapshots (only when someone reports), bans, and the history window.
  Both are expired by a Durable Object **alarm**.
* Raw IPs never get stored — only `sha256(ip + IP_SALT)`, truncated nowhere but salted and one-way.

## Privacy notes (read this)

* It protects against **regular users**, not against legal process. Cloudflare sees connection metadata,
  and a "report" snapshot deliberately contains an IP *hash* so an operator can act on abuse.
* History retention means the server **does** hold recent messages for the configured window —
  if you want "store nothing at all", set `HISTORY_TTL_MS` and stop writing history, or drop the feature.
* Don't ship this as a place for illegal content. You, the operator, are the one who gets the letter.

## Deploy

```bash
git clone <this repo> && cd anon-chat

# 1) edit wrangler.jsonc: name, routes.pattern, ADMIN_KEY, IP_SALT
# 2) credentials (never commit them)
export CLOUDFLARE_API_KEY=...      # Global API Key, or use CLOUDFLARE_API_TOKEN
export CLOUDFLARE_EMAIL=...
export CLOUDFLARE_ACCOUNT_ID=...

./deploy.sh
```

`routes.pattern` with `custom_domain: true` creates the DNS record for you.
If your npm registry is slow, `deploy.sh` falls back to a mirror.

## Admin panel

```
https://<your-domain>/admin?key=<ADMIN_KEY>
```

* live counts: lobby members, 1-on-1 queue, total connections, reports, bans, retention days
* every report: time, mode, both IP hashes, who was present, and a message snapshot
* per report: **kick (online only)** · **ban 7 days** · **ban the reporter** · **mark handled**
* **kick all connections** and **clear reports** buttons

Reports are marked handled/unhandled so you can work through them.

## Tests

Node 22's built-in `WebSocket` — no dependencies.

```bash
WS_URL=wss://your-worker.example.com/ws BASE=https://your-worker.example.com ADMIN_KEY=... \
  node test_ws.mjs                  # 1-on-1: pair / text / image / link filter / report
WS_URL=... BASE=... node test_group.mjs        # lobby: join / broadcast / history
WS_URL=... BASE=... ADMIN_KEY=... node test_ban.mjs   # ban → connection refused → unban
WS_URL=... node test_report_semantics.mjs      # a report must NOT disconnect the other side
```

Note: run `GET /admin/reset?key=...` before a test round — leftover connections and rooms are the
number one source of false failures.

## Free-tier notes

* Durable Objects: 100k requests/day + 13,000 GB-s/day free.
  **Incoming WebSocket messages bill at 20:1** (100 messages = 5 requests); outgoing sends are free.
  A few hundred people chatting in one lobby still fits.
* If you need to save GB-s, switch to the WebSocket **Hibernation API**
  (`state.acceptWebSocket()` + `webSocketMessage()`); the trade-off is that in-memory state must move into storage.

## License

MIT
