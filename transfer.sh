#!/usr/bin/env bash
# 数据搬迁：把当前 DO 实例的聊天历史/举报/封禁导出成文件，便于换实例名后导入。
# 用法：
#   ./transfer.sh export [目录]        # 导出（默认 ./backup-<时间>）
#   ./transfer.sh import <目录>        # 导入到当前实例
# 依赖同目录的 .env（ADMIN_KEY 等）与 wrangler（重新部署用）。
set -euo pipefail
cd "$(dirname "$0")"
ENVF="${ENVF:-/data/hermes-home/.env}"
BASE="${BASE:-https://anon-chat.example.workers.dev}"
KEY="$(grep -m1 '^ANON_CHAT_ADMIN_KEY=' "$ENVF" | cut -d= -f2-)"
[ -z "$KEY" ] && { echo "缺少 ADMIN_KEY"; exit 1; }

cmd="${1:-export}"
case "$cmd" in
  export)
    out="${2:-backup-$(date +%Y%m%d-%H%M%S)}"
    mkdir -p "$out"
    for p in m: report: ban:; do
      after=""; n=0; > "$out/${p%%:*}.jsonl"
      while :; do
        r="$(curl -sS -m 60 --retry 3 -H "x-admin-key: $KEY" \
             "$BASE/admin/export?prefix=$(printf %s "$p" | sed 's/:/%3A/')&after=$after&limit=500")"
        cnt="$(printf %s "$r" | python3 -c 'import sys,json;print(len(json.load(sys.stdin).get("entries",[])))')"
        [ "$cnt" = "0" ] && break
        printf %s "$r" | python3 -c 'import sys,json;[print(json.dumps(e,ensure_ascii=False)) for e in json.load(sys.stdin)["entries"]]' >> "$out/${p%%:*}.jsonl"
        n=$((n+cnt)); after="$(printf %s "$r" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("next") or "")')"
        [ -z "$after" ] && break
      done
      echo "  导出 ${p} → $n 条"
    done
    echo "✅ 已存到 $out"
    ;;
  import)
    dir="${2:?需要指定目录}"; tot=0
    for p in m: report: ban:; do
      f="$dir/${p%%:*}.jsonl"; [ -f "$f" ] || continue
      n=0
      while read -r line; do
        [ -z "$line" ] && continue
        printf '{"entries":[%s]}' "$line" | curl -sS -m 60 --retry 3 -X POST -H "x-admin-key: $KEY" \
          -H 'content-type: application/json' --data-binary @- "$BASE/admin/import" > /dev/null
        n=$((n+1))
      done < "$f"
      echo "  导入 ${p} ← $n 条"; tot=$((tot+n))
    done
    echo "✅ 共导入 $tot 条"
    ;;
  *) echo "用法: $0 export [目录] | $0 import <目录>"; exit 1;;
esac
