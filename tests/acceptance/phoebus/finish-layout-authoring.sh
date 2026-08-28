#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
local_root=${ELI_PHOEBUS_LOCAL_ROOT:-"$repo_root/.local/phoebus"}
layout_dir="$local_root/layouts"
session_file="$layout_dir/authoring-session"
layout_file=${1:-"$layout_dir/local-alarm-layout.memento"}

[[ -f $session_file ]] || {
  printf 'No layout authoring session is recorded at %s.\n' "$session_file" >&2
  exit 1
}
[[ -s $layout_file ]] || {
  printf 'Phoebus has not saved a non-empty memento at %s.\n' "$layout_file" >&2
  exit 1
}
[[ $layout_file -nt $session_file ]] || {
  printf 'The memento predates this authoring session; refusing it as evidence.\n' >&2
  exit 1
}

session_value() {
  local key=$1
  awk -F '=' -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); print; exit}' "$session_file"
}

server_pid=$(session_value pid)
start_identity=$(session_value start_identity)
if [[ -r /proc/$server_pid/stat ]]; then
  current_identity=$(awk '{print $22}' "/proc/$server_pid/stat")
  if [[ $current_identity == "$start_identity" ]]; then
    kill "$server_pid"
  else
    printf 'PID %s was reused; it was not signalled.\n' "$server_pid" >&2
  fi
fi

{
  printf 'memento_sha256=%s\n' "$(sha256sum -- "$layout_file" | awk '{print $1}')"
  printf 'memento_size=%s\n' "$(stat -c '%s' -- "$layout_file")"
  printf 'authoring_session=%s\n' "$(session_value started_utc)"
  printf 'accepted_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'phoebus_lock_sha256=%s\n' "$(sha256sum -- "$script_dir/artifacts.lock" | awk '{print $1}')"
} > "$layout_file.provenance"

printf 'Accepted Phoebus-saved memento: %s\n' "$layout_file"
printf 'Provenance: %s\n' "$layout_file.provenance"
