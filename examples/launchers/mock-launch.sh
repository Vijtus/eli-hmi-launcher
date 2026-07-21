#!/usr/bin/env sh
set -eu

NAME="${1:-Unknown target}"
LOG_FILE="${TMPDIR:-/tmp}/eli-hmi-launcher-mock.log"

printf '%s Mock launch: %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$NAME" >> "$LOG_FILE"

if command -v notify-send >/dev/null 2>&1; then
  notify-send "ELI Launcher mock" "$NAME" >/dev/null 2>&1 || true
elif command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"$NAME\" with title \"ELI Launcher mock\"" >/dev/null 2>&1 || true
fi

exit 0
