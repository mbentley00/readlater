#!/usr/bin/env bash
# Sign the Earmark Firefox extension (Mozilla "unlisted" signing) and publish the
# signed .xpi to the server, so installed copies auto-update.
#
# This script OWNS the version bump — you do not bump manifest.json yourself.
# The two used to be separate steps, which let them drift: the tooltip-shortcut
# feature sat written-and-committed in the tree for weeks while every browser
# kept running the last signed build, because the manifest had been bumped but
# nothing was ever signed. Bumping and publishing are now the same action, so
# "it's in the repo" and "it's in the browser" can't quietly disagree.
#
# Prereqs (once) — get the key/secret at
# https://addons.mozilla.org/developers/addon/api/key/ :
#     export AMO_KEY="user:XXXXXXXX:XX"     # JWT issuer
#     export AMO_SECRET="<64-hex secret>"   # JWT secret
#     export EARMARK_TOKEN="<your API token>"   # from /settings
#   Optionally: export EARMARK_URL="https://readlater-mbent.fly.dev" (default)
#
# Usage:
#   ./publish.sh            # bump the patch version if needed, sign, publish
#   ./publish.sh 1.1.0      # publish as an explicit version
#   ./publish.sh --check    # report drift (manifest vs published); no creds needed
set -euo pipefail
cd "$(dirname "$0")"

BASE="${EARMARK_URL:-https://readlater-mbent.fly.dev}"

version_in_manifest() {
  grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' manifest.json |
    head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'
}

# What the server currently advertises to installed copies. Empty if nothing has
# been published yet or the server is unreachable.
version_published() {
  curl -fsS --max-time 15 "$BASE/extension/updates.json" 2>/dev/null |
    grep -oE '"version"[[:space:]]*:[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' |
    head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true
}

bump_patch() { echo "$1" | awk -F. '{printf "%d.%d.%d\n", $1, $2, $3 + 1}'; }
highest() { printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1; }

VERSION=$(version_in_manifest)
[ -n "$VERSION" ] || { echo "Could not read \"version\" from manifest.json" >&2; exit 1; }
PUBLISHED=$(version_published)

# --check: is what's in the tree what browsers are actually running?
if [ "${1:-}" = "--check" ]; then
  echo "manifest:  $VERSION"
  echo "published: ${PUBLISHED:-<nothing published>}"
  if [ "$VERSION" = "$PUBLISHED" ]; then
    echo "OK — the signed build matches the manifest."
    exit 0
  fi
  echo "DRIFT — the tree and the published build differ. Run ./publish.sh to ship." >&2
  exit 1
fi

: "${AMO_KEY:?set AMO_KEY (JWT issuer, e.g. user:123:45)}"
: "${AMO_SECRET:?set AMO_SECRET (JWT secret)}"
: "${EARMARK_TOKEN:?set EARMARK_TOKEN (server API token)}"

# Decide the version to ship. Mozilla refuses to re-sign a version that already
# exists, so anything already published must be bumped past.
if [ -n "${1:-}" ]; then
  TARGET="$1"
  echo "$TARGET" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "Bad version '$TARGET' (want N.N.N)" >&2; exit 1; }
elif [ -z "$PUBLISHED" ]; then
  TARGET="$VERSION" # nothing published yet — ship what's in the manifest
elif [ "$VERSION" = "$PUBLISHED" ] || [ "$(highest "$VERSION" "$PUBLISHED")" != "$VERSION" ]; then
  TARGET=$(bump_patch "$(highest "$VERSION" "$PUBLISHED")")
else
  TARGET="$VERSION" # manifest is already ahead of what's published — ship it
fi

if [ "$TARGET" != "$VERSION" ]; then
  echo "Bumping manifest.json $VERSION → $TARGET (published: ${PUBLISHED:-none})"
  # Anchored on the exact current version so it can't touch manifest_version or
  # strict_min_version.
  sed -i -E "s/(\"version\"[[:space:]]*:[[:space:]]*\")${VERSION//./\\.}(\")/\1${TARGET}\2/" manifest.json
  [ "$(version_in_manifest)" = "$TARGET" ] || { echo "Failed to rewrite manifest.json" >&2; exit 1; }
fi

echo "Signing Earmark $TARGET …"
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
  "$BASE/api/extension.xpi?version=$TARGET"
echo

# Don't just print the update manifest — check it. A successful upload that
# advertises the wrong version still means nobody gets the new build.
SERVED=$(version_published)
if [ "$SERVED" != "$TARGET" ]; then
  echo "PUBLISH VERIFY FAILED: updates.json serves '${SERVED:-nothing}', expected '$TARGET'" >&2
  exit 1
fi

echo "Published $TARGET — updates.json now serves it. ✔"
echo "Installed copies auto-update within ~24h (or via about:addons → Check for Updates)."
if ! git diff --quiet -- manifest.json 2>/dev/null; then
  echo
  echo "NOTE: manifest.json was bumped to $TARGET — commit it so the tree matches what's live:"
  echo "      git add firefox-extension/manifest.json && git commit -m 'Publish extension $TARGET'"
fi
