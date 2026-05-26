#!/usr/bin/env bash
# Bulk-upload everything in pending-images/ to R2, preserving folder structure.
#   pending-images/foo.png             -> cdn.fungamingvn.shop/foo.png
#   pending-images/feedback/x.png      -> cdn.fungamingvn.shop/feedback/x.png
#   pending-images/guides/poe/y.png    -> cdn.fungamingvn.shop/guides/poe/y.png
# Prints a markdown snippet per file. Uploaded files are moved to .uploaded/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/pending-images"
ARCHIVE="$SRC/.uploaded"
BUCKET="poe-skins-assets"
CDN="https://cdn.fungamingvn.shop"
PARALLEL="${PARALLEL:-8}"

mkdir -p "$ARCHIVE"

FILE_LIST="$(find "$SRC" -type f ! -path "*/.uploaded/*" ! -name ".*" | sort)"
COUNT="$(printf '%s\n' "$FILE_LIST" | grep -c . || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "No files in $SRC — drop images there and rerun." >&2
  exit 0
fi

echo "Uploading $COUNT file(s) to R2 (parallel=$PARALLEL)…" >&2

printf '%s\n' "$FILE_LIST" | xargs -I {} -P "$PARALLEL" sh -c '
  f="$1"
  rel="${f#'"$SRC"'/}"
  if npx --yes wrangler r2 object put "'"$BUCKET"'/$rel" --file "$f" --remote >/dev/null 2>&1; then
    mkdir -p "'"$ARCHIVE"'/$(dirname "$rel")"
    mv "$f" "'"$ARCHIVE"'/$rel"
    base="$(basename "$rel")"
    printf "![%s](%s/%s)\n" "${base%.*}" "'"$CDN"'" "$rel"
  else
    printf "FAILED %s\n" "$f" >&2
  fi
' _ {}
