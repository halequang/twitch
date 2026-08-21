#!/usr/bin/env bash
#
# Open or query the rental database.
#
#   scripts/db.sh                          # interactive sqlite3 shell (local)
#   scripts/db.sh "SELECT * FROM users"    # one query, column output (local)
#   scripts/db.sh --path                   # print the file, e.g. for a GUI client
#   scripts/db.sh --remote "SELECT 1"      # run against PRODUCTION via wrangler
#   scripts/db.sh --wrangler "SELECT 1"    # local, but through wrangler
#
# Why a script rather than a path: miniflare names the local D1 file after a hash,
# there are several such files in that directory, and more than one carries a
# steam_accounts table — an older state directory has that table but no `users`, so
# picking the first match silently gives you the wrong database. This scores the
# candidates against the real schema, the same way the dev server's shim does.
#
# sqlite3 talks to the file directly, which is fast and gives you .schema, .tables
# and column output. `wrangler d1 execute` goes through miniflare instead: slower,
# but it is the safe choice for WRITES while `wrangler dev` is running, since that
# process holds the file open.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
D1_DIR="$REPO/.wrangler/state/v3/d1/miniflare-D1DatabaseObject"
DB_NAME="fungaming-rentals"

find_db() {
  [[ -d "$D1_DIR" ]] || return 1
  local best="" best_score=-1 file score
  for file in "$D1_DIR"/*.sqlite; do
    [[ -f "$file" ]] || continue
    # Count how many of our tables this file has. A non-D1 sqlite (or a stale one)
    # scores 0 and loses.
    score="$(sqlite3 "$file" \
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table'
        AND name IN ('steam_accounts','orders','users','email_codes','account_reports');" \
      2>/dev/null || echo 0)"
    if [[ "$score" -gt "$best_score" ]]; then
      best_score="$score"
      best="$file"
    fi
  done
  [[ "$best_score" -gt 0 ]] || return 1
  echo "$best"
}

MODE=local
case "${1:-}" in
  --remote) MODE=remote; shift ;;
  --wrangler) MODE=wrangler; shift ;;
  --path)
    db="$(find_db)" || { echo "no local D1 found — run \`npx wrangler dev --local\` once" >&2; exit 1; }
    echo "$db"
    exit 0
    ;;
  -h|--help)
    sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

if [[ "$MODE" != local ]]; then
  # Through wrangler: the only correct way to reach production, and the safe way to
  # write locally while a dev server holds the file.
  [[ -n "${1:-}" ]] || { echo "a SQL statement is required with --remote/--wrangler" >&2; exit 2; }
  flag="--local"
  [[ "$MODE" == remote ]] && flag="--remote"
  cd "$REPO"
  exec npx wrangler d1 execute "$DB_NAME" "$flag" --command "$1"
fi

command -v sqlite3 >/dev/null || { echo "sqlite3 not found on PATH" >&2; exit 1; }
db="$(find_db)" || { echo "no local D1 found — run \`npx wrangler dev --local\` once" >&2; exit 1; }

if [[ -n "${1:-}" ]]; then
  exec sqlite3 -header -column "$db" "$1"
fi

echo "$db"
echo "(.tables to list, .schema steam_accounts for one table, .quit to leave)"
exec sqlite3 -header -column "$db"
