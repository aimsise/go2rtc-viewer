#!/usr/bin/env bash
#
# gen-config.sh - Generate the gitignored cameras.json from the committed
# cameras.template.json, substituting ${VAR} from .env / the environment.
#
# Run this before starting the :8000 dashboard server. start.sh also calls it
# automatically. macOS-safe (no `envsubst`); only expands variables that are
# present, leaving any unmatched ${VAR} literal (fail-loud, not silently blank).

set -euo pipefail

SELF="$(cd "$(dirname "$0")" && pwd)"
cd "$SELF"

# Load .env so the placeholders resolve to the real values.
if [ -f "$SELF/.env" ]; then
  set -a
  . "$SELF/.env"
  set +a
fi

python3 -c 'import os,re,sys; sys.stdout.write(re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: os.environ.get(m.group(1), m.group(0)), sys.stdin.read()))' \
  < "$SELF/cameras.template.json" > "$SELF/cameras.json"

echo "Generated cameras.json from cameras.template.json"
