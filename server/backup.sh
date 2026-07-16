#!/usr/bin/env bash
# Pull a full Earmark backup (articles incl. HTML, highlights, saved views) to
# a local directory, gzipped and dated, and prune old ones.
#
# Verifies the download before it replaces anything: the export ends with an
# {"type":"end",...} trailer whose counts must match both the header's counts
# and the lines actually received. A truncated NDJSON file otherwise looks
# perfectly valid line by line, so without this check a silent half-backup
# would overwrite a good one.
#
# Usage:
#   export EARMARK_TOKEN="<API token from /settings>"
#   ./backup.sh [dest-dir]            # default ./backups
#
# Cron it (daily at 03:30):
#   30 3 * * * EARMARK_TOKEN=… /path/to/backup.sh /path/to/backups >> /path/to/backup.log 2>&1
set -euo pipefail

: "${EARMARK_TOKEN:?set EARMARK_TOKEN (API token, see /settings)}"
BASE="${EARMARK_URL:-https://readlater-mbent.fly.dev}"
DEST="${1:-./backups}"
KEEP_DAYS="${EARMARK_BACKUP_KEEP_DAYS:-30}"

mkdir -p "$DEST"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TMP="$DEST/.earmark-$STAMP.ndjson"
OUT="$DEST/earmark-$STAMP.ndjson.gz"
trap 'rm -f "$TMP"' EXIT

echo "[$(date -u +%FT%TZ)] fetching $BASE/api/export.ndjson"
curl -fsS --retry 3 --retry-delay 5 \
  -H "Authorization: Bearer $EARMARK_TOKEN" \
  "$BASE/api/export.ndjson" -o "$TMP"

# --- verify before we trust it -------------------------------------------
# header counts (line 1), trailer counts (last line), and the real line counts.
read -r HDR_A HDR_H < <(head -n 1 "$TMP" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const h=JSON.parse(d);
    if(h.format!=="earmark-export/1") throw new Error("unexpected format: "+h.format);
    console.log(h.counts.articles, h.counts.highlights);
  });')

read -r END_A END_H < <(tail -n 1 "$TMP" | node -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    const t=JSON.parse(d);
    if(t.type!=="end") throw new Error("no end trailer — download truncated");
    console.log(t.articles, t.highlights);
  });')

GOT_A=$(grep -c '^{"type":"article"' "$TMP" || true)
GOT_H=$(grep -c '^{"type":"highlight"' "$TMP" || true)

echo "  header: $HDR_A articles / $HDR_H highlights"
echo "  trailer: $END_A articles / $END_H highlights"
echo "  received: $GOT_A articles / $GOT_H highlights"

[ "$HDR_A" = "$END_A" ] && [ "$END_A" = "$GOT_A" ] || { echo "ARTICLE COUNT MISMATCH — refusing to store"; exit 1; }
[ "$HDR_H" = "$END_H" ] && [ "$END_H" = "$GOT_H" ] || { echo "HIGHLIGHT COUNT MISMATCH — refusing to store"; exit 1; }

# An empty account is legal, but a *newly* empty one usually means disaster.
if [ "$GOT_A" -eq 0 ]; then
  LATEST=$(ls -1t "$DEST"/earmark-*.ndjson.gz 2>/dev/null | head -1 || true)
  if [ -n "$LATEST" ]; then
    echo "REFUSING: export has 0 articles but $LATEST exists. Delete it by hand if this is real."
    exit 1
  fi
fi

gzip -c "$TMP" > "$OUT"
gzip -t "$OUT"
echo "[$(date -u +%FT%TZ)] wrote $OUT ($(du -h "$OUT" | cut -f1))"

DELETED=$(find "$DEST" -name 'earmark-*.ndjson.gz' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)
[ "$DELETED" -gt 0 ] && echo "pruned $DELETED backup(s) older than $KEEP_DAYS days"
exit 0
