#!/usr/bin/env bash
# NEBU.QUEST Track 5 verify rig.
# Starts a local static server, screenshots desktop + mobile with headless
# Chrome, asserts HTTP 200 on the core assets, and checks index.html for
# #scene-hero, #room-widget and og: tags. Prints PASS/FAIL per check.
set -u

PORT="${PORT:-8811}"
BASE="http://localhost:${PORT}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_SHOT="${SCREENSHOT_DESKTOP:-${SCRIPT_DIR}/verify-desktop.png}"
MOBILE_SHOT="${SCREENSHOT_MOBILE:-${SCRIPT_DIR}/verify-mobile.png}"

PASS=0
FAIL=0

report() {
  local status="$1"
  local label="$2"
  if [ "$status" = "PASS" ]; then
    PASS=$((PASS + 1))
    printf 'PASS  %s\n' "$label"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL  %s\n' "$label"
  fi
}

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'FAIL  required command missing: %s\n' "$1"
    exit 1
  fi
}

need_cmd python3
need_cmd curl

if [ ! -x "$CHROME" ]; then
  printf 'FAIL  headless Chrome not found at %s\n' "$CHROME"
  exit 1
fi

# Start the static server in the background; clean it up on exit.
cd "$SCRIPT_DIR"
python3 -m http.server "$PORT" >/tmp/nebu-verify-http.log 2>&1 &
SERVER_PID=$!
cleanup() {
  kill "$SERVER_PID" >/dev/null 2>&1 || true
  wait "$SERVER_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Wait for the server to answer (up to ~10s).
READY=0
for _ in $(seq 1 50); do
  if curl -fs -o /dev/null "$BASE/" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.2
done
if [ "$READY" != "1" ]; then
  printf 'FAIL  local server did not start on %s\n' "$BASE"
  exit 1
fi
printf 'PASS  local server up on %s\n' "$BASE"
PASS=$((PASS + 1))

# HTTP 200 assertions on each core asset.
check_200() {
  local label="$1"
  local url="$2"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || echo 000)"
  if [ "$code" = "200" ]; then
    report PASS "HTTP 200 $label"
  else
    report FAIL "HTTP 200 $label (got $code)"
  fi
}

check_200 "/" "$BASE/"
for asset in styles.css app.js scene.js sections.html room.js; do
  check_200 "/$asset" "$BASE/$asset"
done

# index.html content assertions.
INDEX="$(curl -s "$BASE/" || true)"
if printf '%s' "$INDEX" | grep -q 'id="scene-hero"'; then
  report PASS 'index.html contains #scene-hero'
else
  report FAIL 'index.html contains #scene-hero'
fi
if printf '%s' "$INDEX" | grep -q 'id="room-widget"'; then
  report PASS 'index.html contains #room-widget'
else
  report FAIL 'index.html contains #room-widget'
fi
if printf '%s' "$INDEX" | grep -q 'property="og:'; then
  report PASS 'index.html contains og: tags'
else
  report FAIL 'index.html contains og: tags'
fi

# Screenshots: desktop 1440x900, mobile 390x844.
if "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  "--screenshot=${DESKTOP_SHOT}" --window-size=1440,900 \
  "${BASE}/" >/tmp/nebu-verify-desktop.log 2>&1 \
  && [ -s "$DESKTOP_SHOT" ]; then
  report PASS "desktop screenshot 1440x900 -> ${DESKTOP_SHOT}"
else
  report FAIL "desktop screenshot 1440x900 -> ${DESKTOP_SHOT}"
fi

if "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
  "--screenshot=${MOBILE_SHOT}" --window-size=390,844 \
  "${BASE}/" >/tmp/nebu-verify-mobile.log 2>&1 \
  && [ -s "$MOBILE_SHOT" ]; then
  report PASS "mobile screenshot 390x844 -> ${MOBILE_SHOT}"
else
  report FAIL "mobile screenshot 390x844 -> ${MOBILE_SHOT}"
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
