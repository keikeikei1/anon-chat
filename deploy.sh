#!/bin/bash
# Deploy anon-chat to Cloudflare Workers.
#
# Required environment variables (never commit them):
#   CLOUDFLARE_API_KEY   - your Global API Key  (or use CLOUDFLARE_API_TOKEN)
#   CLOUDFLARE_EMAIL     - the account email
#   CLOUDFLARE_ACCOUNT_ID
#
# Also remember to edit wrangler.jsonc: ADMIN_KEY / IP_SALT / routes.pattern.
set -e
cd "$(dirname "$0")"

if [ -z "$CLOUDFLARE_API_KEY" ] || [ -z "$CLOUDFLARE_EMAIL" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "Please export CLOUDFLARE_API_KEY / CLOUDFLARE_EMAIL / CLOUDFLARE_ACCOUNT_ID first." >&2
  exit 1
fi
unset CLOUDFLARE_API_TOKEN
export CI=true

# First run: use a fast npm mirror if you are behind a slow link
[ -x ./node_modules/.bin/wrangler ] || npm install wrangler --no-save --registry=https://registry.npmmirror.com

./node_modules/.bin/wrangler deploy
