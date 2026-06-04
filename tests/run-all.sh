#!/usr/bin/env bash
# run-all.sh — run every CI test in order and fail if any fails.
# Each sub-test is self-contained (resolves the repo root from its own path),
# needs only node / bash / python3 + coreutils, and runs headless with NO
# cameras / go2rtc / browser. Mirrors what .github/workflows/test.yml runs.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 1

rc=0
run() {
  local label="$1"; shift
  echo ""
  echo "############################################################"
  echo "# $label"
  echo "############################################################"
  if "$@"; then
    echo "[PASS] $label"
  else
    echo "[FAIL] $label" >&2
    rc=1
  fi
}

run "syntax-checks"   bash  "$SCRIPT_DIR/syntax-checks.sh"
run "i18n-parity"     node  "$SCRIPT_DIR/i18n-parity.js"
run "secret-guard"    bash  "$SCRIPT_DIR/secret-guard.sh"
run "no-real-secrets" node  "$SCRIPT_DIR/no-real-secrets.js"
run "onvif-client"    node  "$SCRIPT_DIR/onvif-client.js"

echo ""
if [ "$rc" -ne 0 ]; then
  echo "==> SOME TESTS FAILED"
  exit 1
fi
echo "==> ALL TESTS PASSED"
