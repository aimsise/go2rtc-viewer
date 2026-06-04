#!/usr/bin/env bash
# syntax-checks.sh — static syntax validation for every script in the repo.
#
#   1. JS : `node --check` on every *.js under web/, recordings/, tests/.
#   2. Bash: `bash -n` on every *.sh in the repo.
#   3. Py  : `python3 -m py_compile` on the secret-guard hook.
#
# No app, no browser, no go2rtc, no network. Pure parse-time checks.
# Dependency-free: node, bash, python3, coreutils (find).
set -u

# Resolve repo root from this script's location so it runs from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT" || exit 1

fail=0
note() { printf '%s\n' "$*"; }
err()  { printf 'FAIL: %s\n' "$*" >&2; fail=1; }

# --- 1. JavaScript: node --check -------------------------------------------
note "== JS syntax (node --check) =="
js_count=0
while IFS= read -r f; do
  js_count=$((js_count + 1))
  if node --check "$f"; then
    note "  ok   $f"
  else
    err "node --check failed: $f"
  fi
done < <(find web recordings tests -type f -name '*.js' \
           -not -path '*/node_modules/*' | sort)
note "  checked $js_count .js file(s)"

# --- 2. Bash: bash -n -------------------------------------------------------
note "== Bash syntax (bash -n) =="
sh_count=0
while IFS= read -r f; do
  sh_count=$((sh_count + 1))
  if bash -n "$f"; then
    note "  ok   $f"
  else
    err "bash -n failed: $f"
  fi
done < <(find . -type f -name '*.sh' \
           -not -path './node_modules/*' \
           -not -path './bin/*' \
           -not -path './.git/*' | sort)
note "  checked $sh_count .sh file(s)"

# --- 3. Python: py_compile --------------------------------------------------
note "== Python syntax (py_compile) =="
PY_HOOK=".claude/hooks/secret-guard.py"
if [ -f "$PY_HOOK" ]; then
  if python3 -m py_compile "$PY_HOOK"; then
    note "  ok   $PY_HOOK"
  else
    err "py_compile failed: $PY_HOOK"
  fi
else
  err "missing $PY_HOOK"
fi

if [ "$fail" -ne 0 ]; then
  note "syntax-checks: FAILED"
  exit 1
fi
note "syntax-checks: OK"
