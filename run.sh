#!/usr/bin/env bash
#
# Run the ELI HMI Launcher (L4) from a source checkout.
#
#   ./run.sh
#
# Thin wrapper: the real logic lives in scripts/run.mjs so that Linux, macOS and
# Windows all run exactly the same startup path.
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  printf '\033[1;31m[run] ERROR:\033[0m %s\n' \
    "Node.js not found. Install Node 20.19+ (https://nodejs.org) and re-run." >&2
  exit 1
fi

exec node scripts/run.mjs "$@"
