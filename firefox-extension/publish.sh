#!/usr/bin/env bash
# Sign the Earmark Firefox extension (Mozilla "unlisted" signing) and publish the
# signed .xpi to the server, so installed copies auto-update.
#
# Prereqs (once):
#   - Bump "version" in manifest.json before running (Mozilla rejects a re-signed
#     duplicate version).
#   - Export credentials (get them at https://addons.mozilla.org/developers/addon/api/key/):
#       export AMO_KEY="user:XXXXXXXX:XX"     # JWT issuer
#       export AMO_SECRET="<64-hex secret>"   # JWT secret
#       export EARMARK_TOKEN="<your API token>"
#   - Optionally: export EARMARK_URL="https://readlater-mbent.fly.dev" (default)
#
# Usage:  ./publish.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${AMO_KEY:?set AMO_KEY (JWT issuer, e.g. user:123:45)}"
: "${AMO_SECRET:?set AMO_SECRET (JWT secret)}"
: "${EARMARK_TOKEN:?set EARMARK_TOKEN (server API token)}"
BASE="${EARMARK_URL:-https://readlater-mbent.fly.dev}"

VERSION=$(grep -oE '"version"[[:space:]]*:[[:space:]]*"[^"]+"' manifest.json | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
echo "Signing Earmark $VERSION …"

rm -rf signed
npx --yes web-ext sign \
  --channel=unlisted \
  --api-key="$AMO_KEY" \
  --api-secret="$AMO_SECRET" \
  --artifacts-dir=./signed \
  --ignore-files 'readlater-firefox-extension-*.zip'

XPI=$(ls signed/*.xpi | head -1)
echo "Uploading $XPI to $BASE …"
curl -fsS -X POST \
  -H "Authorization: Bearer $EARMARK_TOKEN" \
  -H "Content-Type: application/x-xpinstall" \
  --data-binary "@$XPI" \
  "$BASE/api/extension.xpi?version=$VERSION"
echo

echo "Published. Update manifest now serves:"
curl -fsS "$BASE/extension/updates.json"
echo
echo "Installed copies will auto-update within ~24h (or via about:addons → Check for Updates)."
