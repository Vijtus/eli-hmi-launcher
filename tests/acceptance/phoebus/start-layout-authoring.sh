#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
local_root=${ELI_PHOEBUS_LOCAL_ROOT:-"$repo_root/.local/phoebus"}
runner="$script_dir/phoebus.sh"
settings="$repo_root/tests/acceptance/config/phoebus.properties"
port=${ELI_PHOEBUS_LAYOUT_PORT:-14919}
layout_dir="$local_root/layouts"
layout_file=${1:-"$layout_dir/local-alarm-layout.memento"}
session_file="$layout_dir/authoring-session"
log_file="$layout_dir/authoring.log"
authoring_home="$local_root/layout-authoring-home"
authoring_preferences="$local_root/layout-authoring-preferences"
ui_ready_delay=${ELI_PHOEBUS_UI_READY_DELAY_SECONDS:-8}

run_authoring_phoebus() {
  ELI_PHOEBUS_USER_HOME="$authoring_home" \
  ELI_PHOEBUS_PREFERENCES_ROOT="$authoring_preferences" \
    "$runner" "$@"
}

[[ -n ${DISPLAY:-} ]] || {
  printf 'Layout authoring needs a real or Xvfb DISPLAY.\n' >&2
  exit 1
}
[[ ! -e $layout_file ]] || {
  printf 'Refusing to overwrite existing layout: %s\n' "$layout_file" >&2
  exit 1
}
mkdir -p -- "$layout_dir"
[[ $ui_ready_delay =~ ^[0-9]+$ ]] || {
  printf 'ELI_PHOEBUS_UI_READY_DELAY_SECONDS must be a non-negative integer.\n' >&2
  exit 2
}

if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
  printf 'Port 127.0.0.1:%s is already in use; refusing to claim its process.\n' "$port" >&2
  exit 1
fi

"$script_dir/capture-app-list.sh" "$layout_dir/application-evidence"

# Invoke the external wrapper directly here instead of backgrounding the shell
# function. The wrapper execs Java, so $! is the Java PID that the provenance
# check and cleanup logic can identify safely.
ELI_PHOEBUS_USER_HOME="$authoring_home" \
ELI_PHOEBUS_PREFERENCES_ROOT="$authoring_preferences" \
  "$runner" -server "$port" -settings "$settings" -clean > "$log_file" 2>&1 &
server_pid=$!
start_identity=$(awk '{print $22}' "/proc/$server_pid/stat")
deadline=$((SECONDS + 60))
until (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'Phoebus exited before opening its server port. See %s\n' "$log_file" >&2
    exit 1
  fi
  (( SECONDS < deadline )) || {
    printf 'Phoebus did not open port %s within 60 seconds. See %s\n' "$port" "$log_file" >&2
    exit 1
  }
  sleep 1
done

# The instance TCP socket becomes reachable before JavaFX has installed its
# resource argument handler. Requests sent in that gap are accepted by the
# socket but discarded with "No argument handler installed". Allow the real UI
# to finish initialization before sending the three follow-up resources.
sleep "$ui_ready_delay"

# Follow-up server requests support resource handlers, not a bare -app request.
# The explicit local alarm URI supplies the application selector while keeping
# the site alarm root/backend an unresolved deployment input.
run_authoring_phoebus -server "$port" -resource 'alarm://localhost/CSI744_LOCAL?app=alarm_tree'
run_authoring_phoebus -server "$port" -resource 'alarm://localhost/CSI744_LOCAL?app=alarm_area'
run_authoring_phoebus -server "$port" -resource 'alarm://localhost/CSI744_LOCAL?app=alarm_table'

{
  printf 'pid=%s\n' "$server_pid"
  printf 'start_identity=%s\n' "$start_identity"
  printf 'port=%s\n' "$port"
  printf 'layout_file=%s\n' "$layout_file"
  printf 'started_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$session_file"

printf 'Phoebus opened alarm_tree, alarm_area, and alarm_table on port %s.\n' "$port"
printf 'Arrange those panels, then use Window -> Save Layout As... and save exactly:\n%s\n' "$layout_file"
printf 'After saving, run: %s/finish-layout-authoring.sh %q\n' "$script_dir" "$layout_file"

# CI/agent execution environments often terminate background descendants when
# the command exits. Waiting keeps the owning session alive while a separate UI
# driver arranges and saves the layout; finish-layout-authoring.sh stops this
# exact PID after checking its recorded start identity.
if [[ ${ELI_PHOEBUS_LAYOUT_WAIT_FOR_FINISH:-false} == true ]]; then
  wait "$server_pid"
fi
