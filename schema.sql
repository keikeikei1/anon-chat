-- anon-chat 的键值表：聊天历史(m:)、举报记录(report:)、封禁名单(ban:) 全在这里
CREATE TABLE IF NOT EXISTS kv (
  k    TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_at ON kv(at);
