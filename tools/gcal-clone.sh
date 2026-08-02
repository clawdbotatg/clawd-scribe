#!/usr/bin/env bash
# Clone the user's logged-in Chrome profile into data/gcal-profile so
# tools/gcal-peek.mjs can read calendar.google.com as them, headlessly.
#
# Run once to set up (and again if the clone's Google session ever expires —
# gcal-peek exits with "session expired" when that happens). The clone carries
# the login because the same Chrome binary decrypts cookies with the same
# macOS Keychain key. The user's real browser is not touched.
#
#   tools/gcal-clone.sh ["Google Chrome"] ["Default"]
set -euo pipefail

APP="${1:-Google Chrome}"
SRC_PROFILE="${2:-Default}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
DST="$HERE/data/gcal-profile"

SUPPORT_SUBDIR="${APP#Google }"
SRC="$HOME/Library/Application Support/Google/$SUPPORT_SUBDIR/$SRC_PROFILE"
BIN="/Applications/$APP.app/Contents/MacOS/$APP"

[ -d "$SRC" ] || { echo "Source profile not found: $SRC" >&2; exit 1; }
[ -x "$BIN" ] || { echo "Browser binary not found: $BIN" >&2; exit 1; }

# stop any headless clone still running against the old copy
pkill -f -- "--user-data-dir=$DST" 2>/dev/null && sleep 1 || true

echo "Cloning '$APP / $SRC_PROFILE' -> $DST (skipping caches)..."
rm -rf "$DST"
mkdir -p "$DST/Default"
rsync -a \
  --exclude 'Service Worker' --exclude 'GPUCache' --exclude 'DawnWebGPUCache' \
  --exclude 'DawnGraphiteCache' --exclude 'Code Cache' --exclude 'Cache' \
  --exclude 'Application Cache' --exclude 'CacheStorage' \
  "$SRC/" "$DST/Default/"
echo "  clone size: $(du -sh "$DST" | cut -f1)"
if [ -e "$DST/Default/Cookies" ] || [ -e "$DST/Default/Network/Cookies" ]; then
  echo "  cookies: present"
else
  echo "  WARNING: no Cookies file copied — is this the right profile?" >&2
fi
echo "Done. gcal-peek launches the headless clone itself on first use."
echo "  probe: node $HERE/tools/gcal-peek.mjs"
