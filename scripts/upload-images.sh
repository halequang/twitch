#!/usr/bin/env bash
# Bulk-upload everything in pending-images/ to R2 under guides/<filename>.
# Prints a markdown snippet per file you can paste into a .md guide.
# Uploaded files are moved to pending-images/.uploaded/ so reruns don't redo work.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/pending-images"
ARCHIVE="$SRC/.uploaded"
BUCKET="poe-skins-assets"
PREFIX="guides"
CDN="https://cdn.fungamingvn.shop"
PARALLEL="${PARALLEL:-8}"

mkdir -p "$ARCHIVE"

FILE_LIST="$(find "$SRC" -maxdepth 1 -type f ! -name ".*" | sort)"
COUNT="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No files in $SRC — drop images there and rerun." >&2
  exit 0
fi

echo "Uploading $COUNT file(s) to R2 (parallel=$PARALLEL)…" >&2

printf '%s\n' "$FILE_LIST" | xargs -I {} -P "$PARALLEL" sh -c '
  f="$1"
  name="$(basename "$f")"
  key="'"$PREFIX"'/$name"
  if npx --yes wrangler r2 object put "'"$BUCKET"'/$key" --file "$f" --remote >/dev/null 2>&1; then
    mv "$f" "'"$ARCHIVE"'/$name"
    printf "![%s](%s/%s)\n" "${name%.*}" "'"$CDN"'" "$key"
  else
    printf "FAILED %s\n" "$f" >&2
  fi
' _ {}
