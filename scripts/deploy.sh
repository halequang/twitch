#!/usr/bin/env bash
# Build, migrate, and deploy — authenticating with an API token.
#
# The token is read from a gitignored .env.deploy at the repo root and exported
# here, so `npm run deploy` behaves the same whatever is already in your shell.
# That matters because .env holds a DIFFERENT, R2-only token (upload-images.sh
# needs it); with that one exported, wrangler authenticates as R2-only and the
# deploy fails on the first D1 call — and `wrangler login` refuses to run at all,
# because any CLOUDFLARE_API_TOKEN looks to it like you are already logged in.
# Loading the deploy token last is what stops those two files fighting.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env.deploy ]; then
  set -a
  . ./.env.deploy
  set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  cat >&2 <<'MSG'
✗ No CLOUDFLARE_API_TOKEN.

  Create .env.deploy at the repo root (see .env.deploy.example) with a token
  scoped for this project:

    Account · Workers Scripts · Edit    the worker, its assets and cron trigger
    Account · D1 · Edit                 wrangler d1 migrations apply --remote
    Zone · Workers Routes · Edit        the two fungamingvn.shop routes
    Zone · Zone · Read                  resolves zone_name to a zone id

  Dashboard → My Profile → API Tokens → Create Token → Create Custom Token.
  Then `npm run deploy:check` names any permission the token is still missing.
MSG
  exit 1
fi

npm run build
npm run migrate
npx wrangler deploy
