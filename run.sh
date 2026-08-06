#!/usr/bin/env bash
#
# Run the ELI HMI Launcher (L4) on Linux or macOS.
#
#   ./run.sh
#
# Installs dependencies on first run, validates the YAML config, then starts the
# app (electron-vite dev). Mock launches log to <OS-temp>/eli-hmi-launcher-mock.log.
#
set -euo pipefail

# Always run from the directory this script lives in.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

info() { printf '\033[1;36m[run]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[run] ERROR:\033[0m %s\n' "$*" >&2; }

# --- prerequisites ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  err "Node.js not found. Install Node 18+ (https://nodejs.org) and re-run."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  err "npm not found (ships with Node.js). Install Node 18+ and re-run."
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  err "Node $(node -v) is too old; need Node 18 or newer."
  exit 1
fi
info "Node $(node -v), npm $(npm -v)"

# --- graphical display check (Linux only; macOS always has one) ------------
if [ "$(uname -s)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  err "No graphical display detected (DISPLAY/WAYLAND_DISPLAY unset). Electron needs a desktop session."
  exit 1
fi

# --- install dependencies if needed ----------------------------------------
if [ ! -d node_modules ] || [ ! -e node_modules/.bin/electron-vite ]; then
  info "Installing dependencies (first run downloads Electron, ~100-200 MB)..."
  # npm ci installs exactly what package-lock.json pins and does not rewrite the
  # lockfile, matching .github/workflows/ci.yml and work order section 7.
  npm ci
else
  info "Dependencies present (delete node_modules to force a clean reinstall)."
fi

# --- validate the config before starting -----------------------------------
info "Validating config/launcher.yaml..."
if ! out="$(npm run --silent validate-config 2>&1)"; then
  err "Config validation failed:"
  printf '%s\n' "$out" >&2
  err "Fix config/launcher.yaml and re-run."
  exit 1
fi

info "Starting launcher...  (mock launches -> \${TMPDIR:-/tmp}/eli-hmi-launcher-mock.log)"
exec npm start
