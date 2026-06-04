#!/usr/bin/env bash
#
# start.sh - Launch go2rtc to view your IP camera(s) in a browser.
#
# What it does:
#   1. Downloads the go2rtc binary (macOS arm64) into ./bin/ if missing.
#   2. Verifies ffmpeg is available (needed for H.265 -> H.264 transcoding).
#   3. Starts go2rtc in the background using ./go2rtc.yaml.
#   4. Opens the go2rtc web UI (http://localhost:1984).
#
# LAN use only. See README.md for security notes.

set -euo pipefail

# Resolve this script's directory so the script works from any CWD,
# without embedding any absolute/home paths.
SELF="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF"

# ---------------------------------------------------------------------------
# 0a. Load .env and export it so go2rtc (and the gen step) see the values.
#     go2rtc does NOT read .env itself; it resolves ${VAR} in go2rtc.yaml from
#     the process environment (pkg/creds -> os.LookupEnv). Export them here.
# ---------------------------------------------------------------------------
if [ -f "$SELF/.env" ]; then
  set -a            # auto-export everything assigned while sourcing .env
  . "$SELF/.env"
  set +a
fi

# ---------------------------------------------------------------------------
# 0b. Generate the gitignored cameras.json from the committed template
#     (single source of truth shared with the dashboard-only gen-config.sh).
# ---------------------------------------------------------------------------
"$SELF/gen-config.sh"

BIN_DIR="$SELF/bin"
GO2RTC_BIN="$BIN_DIR/go2rtc"
CONFIG="$SELF/go2rtc.yaml"
PID_FILE="$SELF/go2rtc.pid"
LOG_FILE="$SELF/go2rtc.log"
UI_URL="http://localhost:1984"

# go2rtc release asset for this platform (macOS / Apple Silicon).
# The asset is a .zip that extracts to a single binary named "go2rtc".
GO2RTC_ASSET="go2rtc_mac_arm64.zip"
GITHUB_REPO="AlexxIT/go2rtc"

# ---------------------------------------------------------------------------
# 0. Ensure Homebrew's bin is on PATH (ffmpeg, curl, unzip, etc.).
# ---------------------------------------------------------------------------
if [ -x /opt/homebrew/bin/brew ]; then
  PATH="/opt/homebrew/bin:$PATH"
fi
export PATH

# ---------------------------------------------------------------------------
# 1. Refuse to start a second instance.
# ---------------------------------------------------------------------------
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "go2rtc is already running (PID $OLD_PID)."
    echo "Web UI: $UI_URL"
    echo "Run ./stop.sh first if you want to restart it."
    exit 0
  fi
  # Stale PID file; clean it up.
  rm -f "$PID_FILE"
fi

# ---------------------------------------------------------------------------
# 2. Verify ffmpeg is installed (required for H.265 -> H.264 transcode).
# ---------------------------------------------------------------------------
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg was not found on PATH." >&2
  echo "go2rtc needs ffmpeg to transcode the camera's H.265 stream to H.264." >&2
  echo "Install it with:  brew install ffmpeg" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Download the go2rtc binary if it is not already present.
# ---------------------------------------------------------------------------
if [ ! -x "$GO2RTC_BIN" ]; then
  echo "go2rtc binary not found. Downloading $GO2RTC_ASSET ..."
  mkdir -p "$BIN_DIR"

  # Resolve the download URL for the latest release asset via the GitHub API,
  # falling back to a known-good pinned release if the API is unavailable.
  DL_URL=""
  if command -v curl >/dev/null 2>&1; then
    DL_URL="$(
      curl -fsSL "https://api.github.com/repos/$GITHUB_REPO/releases/latest" 2>/dev/null \
        | grep -o "https://[^\"]*$GO2RTC_ASSET" \
        | head -n 1 || true
    )"
  fi
  if [ -z "$DL_URL" ]; then
    echo "Could not resolve latest release from GitHub API; using pinned release." >&2
    DL_URL="https://github.com/$GITHUB_REPO/releases/download/v1.9.14/$GO2RTC_ASSET"
  fi

  TMP_ZIP="$BIN_DIR/$GO2RTC_ASSET"
  echo "Fetching: $DL_URL"
  curl -fL -o "$TMP_ZIP" "$DL_URL"

  # The archive contains a single binary named "go2rtc".
  unzip -o "$TMP_ZIP" -d "$BIN_DIR"
  rm -f "$TMP_ZIP"

  if [ ! -f "$GO2RTC_BIN" ]; then
    echo "ERROR: expected binary '$GO2RTC_BIN' was not found after unzip." >&2
    exit 1
  fi
  chmod +x "$GO2RTC_BIN"

  # macOS Gatekeeper quarantines downloaded binaries; clear it so it can run.
  if command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "$GO2RTC_BIN" 2>/dev/null || true
  fi
  echo "go2rtc installed at bin/go2rtc"
fi

# ---------------------------------------------------------------------------
# 4. Make sure the config file exists.
# ---------------------------------------------------------------------------
if [ ! -f "$CONFIG" ]; then
  echo "ERROR: config file not found: go2rtc.yaml" >&2
  echo "It should sit next to this script." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. Start go2rtc in the background.
# ---------------------------------------------------------------------------
echo "Starting go2rtc ..."
nohup "$GO2RTC_BIN" -config "$CONFIG" >"$LOG_FILE" 2>&1 &
GO2RTC_PID=$!
echo "$GO2RTC_PID" >"$PID_FILE"

# Give it a moment to bind its ports, and confirm it stayed up.
sleep 3
if ! kill -0 "$GO2RTC_PID" 2>/dev/null; then
  echo "ERROR: go2rtc failed to start. Recent log output:" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  rm -f "$PID_FILE"
  exit 1
fi

echo "go2rtc is running (PID $GO2RTC_PID)."
echo "  Web UI / viewer : $UI_URL"
echo "  Log file        : go2rtc.log"
echo "  Stop with       : ./stop.sh"

# ---------------------------------------------------------------------------
# 6. Open the viewer in the default browser (best effort).
# ---------------------------------------------------------------------------
if command -v open >/dev/null 2>&1; then
  open "$UI_URL" || true
fi
