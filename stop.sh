#!/usr/bin/env bash
#
# stop.sh - Stop the go2rtc process started by start.sh.
#
# Reads the PID from go2rtc.pid, terminates the process, and cleans up
# the PID file. Safe to run even if go2rtc is not currently running.

set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF"

PID_FILE="$SELF/go2rtc.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No go2rtc.pid file found; go2rtc does not appear to be running."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "${PID:-}" ]; then
  echo "go2rtc.pid is empty; removing it."
  rm -f "$PID_FILE"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  echo "Process $PID is not running; cleaning up stale go2rtc.pid."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping go2rtc (PID $PID) ..."
kill "$PID" 2>/dev/null || true

# Wait up to ~5 seconds for a graceful exit, then force-kill if needed.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done

if kill -0 "$PID" 2>/dev/null; then
  echo "go2rtc did not exit gracefully; sending SIGKILL."
  kill -9 "$PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "go2rtc stopped."
