#!/usr/bin/env bash
# secret-guard.sh — behavioral test for .claude/hooks/secret-guard.py.
#
# Pipes PreToolUse-shaped JSON payloads on stdin and asserts the hook's EXIT
# CODE: 2 = BLOCK (deny), 0 = ALLOW. The hook is the source of truth for the
# repo's .env-hygiene convention:
#   BLOCK  a real RFC1918 private IP written into a COMMITTED file.
#   BLOCK  literal URL credentials (://user:pass@) into a committed file.
#   ALLOW  RFC5737 documentation IPs (192.0.2.x).
#   ALLOW  env-placeholder creds (${RTSP_USER}:${RTSP_PASS}@).
#   ALLOW  the same secrets when the target is .env / cameras.json (the secret
#          store) — exempt by design.
#   ALLOW  non-Write/Edit tools (e.g. a Read call) untouched.
#
# Dependency-free: bash + python3 only.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$ROOT/.claude/hooks/secret-guard.py"

fail=0
if [ ! -f "$HOOK" ]; then
  echo "FAIL: hook not found at $HOOK" >&2
  exit 1
fi

# run_case <expected_exit> <label> <json>
run_case() {
  local expected="$1" label="$2" json="$3" got
  # Discard the hook's stdout/stderr (deny JSON + reason); we assert on $?.
  printf '%s' "$json" | python3 "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" -eq "$expected" ]; then
    printf '  ok    [exit %s] %s\n' "$got" "$label"
  else
    printf 'FAIL: [exit %s, want %s] %s\n' "$got" "$expected" "$label" >&2
    fail=1
  fi
}

EXIT_BLOCK=2
EXIT_ALLOW=0

echo "== secret-guard behavior =="

# 1) Real private IP (192.168.1.50) into a committed file -> BLOCK.
run_case "$EXIT_BLOCK" "real 192.168.1.50 into web/app.js (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"web/app.js","content":"const cam = \"rtsp://192.168.1.50:554/stream\";"}}'

# 1b) Real 10/8 and 172.16/12 private IPs too.
run_case "$EXIT_BLOCK" "real 10.0.0.5 into go2rtc.yaml (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"go2rtc.yaml","content":"url: rtsp://10.0.0.5/s"}}'
run_case "$EXIT_BLOCK" "real 172.16.4.9 into go2rtc.yaml (Edit)" \
  '{"tool_name":"Edit","tool_input":{"file_path":"go2rtc.yaml","new_string":"host 172.16.4.9"}}'

# 2) RFC5737 documentation IP (192.0.2.50) into a committed file -> ALLOW.
run_case "$EXIT_ALLOW" "doc 192.0.2.50 into web/app.js (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"web/app.js","content":"const cam = \"rtsp://192.0.2.50:554/stream\";"}}'

# 3) Real literal URL credential into a committed file -> BLOCK.
run_case "$EXIT_BLOCK" "real cred admin:hunter2@ into go2rtc.yaml (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"go2rtc.yaml","content":"url: rtsp://admin:hunter2@192.0.2.50:554/s"}}'

# 4) Env-placeholder credential into a committed file -> ALLOW.
run_case "$EXIT_ALLOW" "env placeholder cred into go2rtc.yaml (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"go2rtc.yaml","content":"url: rtsp://${RTSP_USER}:${RTSP_PASS}@192.0.2.50:554/s"}}'

# 4b) Generic doc placeholder user:pass -> ALLOW.
run_case "$EXIT_ALLOW" "generic user:pass placeholder into web/streams.html (Write)" \
  '{"tool_name":"Write","tool_input":{"file_path":"web/streams.html","content":"placeholder rtsp://user:pass@192.0.2.50/s"}}'

# 5) Same real private IP, but target is .env (exempt store) -> ALLOW.
run_case "$EXIT_ALLOW" "real 192.168.1.50 into .env (exempt)" \
  '{"tool_name":"Write","tool_input":{"file_path":".env","content":"CAM_HOST=192.168.1.50"}}'
run_case "$EXIT_ALLOW" "real 192.168.1.50 into cameras.json (exempt)" \
  '{"tool_name":"Write","tool_input":{"file_path":"cameras.json","content":"{\"host\":\"192.168.1.50\"}"}}'

# 6) A Read tool call (not Write/Edit) -> ALLOW untouched.
run_case "$EXIT_ALLOW" "Read tool call is untouched" \
  '{"tool_name":"Read","tool_input":{"file_path":"web/app.js"}}'

if [ "$fail" -ne 0 ]; then
  echo "secret-guard: FAILED" >&2
  exit 1
fi
echo "secret-guard: OK"
