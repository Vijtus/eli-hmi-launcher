#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
handoff_root=$(CDPATH= cd -- "$repo_root/../.." && pwd)
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${ELI_LOCAL_ACCEPTANCE_EVIDENCE_DIR:-"$repo_root/.local/acceptance/$timestamp"}
if [[ $evidence_dir != /* ]]; then
  evidence_dir="$repo_root/$evidence_dir"
fi

ioc_name=${ELI_LOCAL_ACCEPTANCE_IOC_NAME:-csi744-local-ioc}
ioc_image=${ELI_LOCAL_ACCEPTANCE_IOC_IMAGE:-laser-mockup-ioc:ready}
lifecycle_port=${ELI_HMI_LIFECYCLE_PORT:-8765}
phoebus_port=${ELI_LOCAL_ACCEPTANCE_PHOEBUS_PORT:-14918}
debug_port=${ELI_LOCAL_ACCEPTANCE_DEBUG_PORT:-19223}

owned_ioc=false
lifecycle_pid=
lifecycle_start_identity=
xvfb_pid=
xvfb_start_identity=
wm_pid=
wm_start_identity=
electron_pid=
electron_start_identity=
phoebus_pid=
phoebus_start_identity=
layout_pid=
layout_start_identity=
display_value=
labview_capture_dir=
phoebus_audit_dir=

fail() {
  printf 'Local acceptance: %s\n' "$*" >&2
  exit 1
}

port_open() {
  local port=$1
  (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null
}

wait_for_port() {
  local port=$1
  local timeout_seconds=$2
  local deadline=$((SECONDS + timeout_seconds))
  until port_open "$port"; do
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

wait_for_port_close() {
  local port=$1
  local timeout_seconds=$2
  local deadline=$((SECONDS + timeout_seconds))
  while port_open "$port"; do
    (( SECONDS < deadline )) || return 1
    sleep 1
  done
}

process_start_identity() {
  local pid=${1:-}
  [[ $pid =~ ^[0-9]+$ && -r /proc/$pid/stat ]] || return 1
  sed 's/^.*) //' "/proc/$pid/stat" | awk '{print $20}'
}

process_group_id() {
  local pid=${1:-}
  [[ $pid =~ ^[0-9]+$ && -r /proc/$pid/stat ]] || return 1
  sed 's/^.*) //' "/proc/$pid/stat" | awk '{print $3}'
}

identity_matches() {
  local pid=${1:-}
  local expected_identity=${2:-}
  local current_identity
  [[ $pid =~ ^[0-9]+$ && $expected_identity =~ ^[0-9]+$ ]] || return 1
  current_identity=$(process_start_identity "$pid") || return 1
  [[ $current_identity == "$expected_identity" ]]
}

capture_start_identity() {
  local pid=$1
  local identity
  for _attempt in 1 2 3 4 5 6 7 8 9 10; do
    identity=$(process_start_identity "$pid" 2>/dev/null || true)
    if [[ $identity =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$identity"
      return 0
    fi
    sleep 0.01
  done
  return 1
}

signal_pid() {
  local pid=${1:-}
  local signal=${2:-TERM}
  local expected_identity=${3:-}
  if identity_matches "$pid" "$expected_identity"; then
    kill -"$signal" "$pid" 2>/dev/null || true
  fi
}

signal_group() {
  local pid=${1:-}
  local signal=${2:-TERM}
  local expected_identity=${3:-}
  local group_id
  if identity_matches "$pid" "$expected_identity"; then
    group_id=$(process_group_id "$pid") || return
    if [[ $group_id == "$pid" ]]; then
      kill -"$signal" -- "-$pid" 2>/dev/null || signal_pid "$pid" "$signal" "$expected_identity"
    else
      signal_pid "$pid" "$signal" "$expected_identity"
    fi
  fi
}

stop_owned_pid() {
  local pid=${1:-}
  local expected_identity=${2:-}
  local deadline
  signal_pid "$pid" TERM "$expected_identity"
  deadline=$((SECONDS + 3))
  while identity_matches "$pid" "$expected_identity" && (( SECONDS < deadline )); do
    sleep 0.1
  done
  if identity_matches "$pid" "$expected_identity"; then
    signal_pid "$pid" KILL "$expected_identity"
  fi
}

stop_owned_group() {
  local pid=${1:-}
  local expected_identity=${2:-}
  local deadline
  signal_group "$pid" TERM "$expected_identity"
  deadline=$((SECONDS + 5))
  while identity_matches "$pid" "$expected_identity" && (( SECONDS < deadline )); do
    sleep 0.1
  done
  if identity_matches "$pid" "$expected_identity"; then
    signal_group "$pid" KILL "$expected_identity"
  fi
}

discover_owned_phoebus_pid() {
  local audit_file audit_name identity_file candidate_pid candidate_identity
  if [[ $phoebus_pid =~ ^[0-9]+$ ]] || [[ ! -d $phoebus_audit_dir ]]; then
    return
  fi
  audit_file=$(find "$phoebus_audit_dir" -maxdepth 1 -type f -name '*.argv' | sort | head -n 1 || true)
  [[ -n $audit_file ]] || return
  audit_name=${audit_file##*/}
  candidate_pid=${audit_name%.argv}
  candidate_pid=${candidate_pid##*-}
  [[ $candidate_pid =~ ^[0-9]+$ ]] || return
  identity_file=${audit_file%.argv}.start-identity
  [[ -s $identity_file ]] || return
  candidate_identity=$(<"$identity_file")
  if identity_matches "$candidate_pid" "$candidate_identity"; then
    phoebus_pid=$candidate_pid
    phoebus_start_identity=$candidate_identity
  fi
}

signal_labview_fixtures() {
  local signal=$1
  local receipt identity_file pid start_identity
  [[ -d $labview_capture_dir ]] || return
  shopt -s nullglob
  for receipt in "$labview_capture_dir"/launch-*.pid; do
    pid=$(<"$receipt")
    identity_file=${receipt%.pid}.start-identity
    if [[ $pid =~ ^[0-9]+$ && -s $identity_file ]]; then
      start_identity=$(<"$identity_file")
      signal_group "$pid" "$signal" "$start_identity"
    fi
  done
  shopt -u nullglob
}

labview_fixtures_running() {
  local receipt identity_file pid start_identity
  [[ -d $labview_capture_dir ]] || return 1
  shopt -s nullglob
  for receipt in "$labview_capture_dir"/launch-*.pid; do
    pid=$(<"$receipt")
    identity_file=${receipt%.pid}.start-identity
    if [[ $pid =~ ^[0-9]+$ && -s $identity_file ]]; then
      start_identity=$(<"$identity_file")
      if identity_matches "$pid" "$start_identity"; then
        shopt -u nullglob
        return 0
      fi
    fi
  done
  shopt -u nullglob
  return 1
}

stop_labview_fixtures() {
  local deadline
  signal_labview_fixtures TERM
  deadline=$((SECONDS + 5))
  while labview_fixtures_running && (( SECONDS < deadline )); do
    sleep 0.1
  done
  if labview_fixtures_running; then
    signal_labview_fixtures KILL
    deadline=$((SECONDS + 2))
    while labview_fixtures_running && (( SECONDS < deadline )); do
      sleep 0.1
    done
  fi
  ! labview_fixtures_running
}

cleanup() {
  local status=$?
  trap - EXIT
  stop_owned_group "$electron_pid" "$electron_start_identity"
  stop_labview_fixtures || true
  discover_owned_phoebus_pid
  stop_owned_group "$phoebus_pid" "$phoebus_start_identity"
  stop_owned_group "$layout_pid" "$layout_start_identity"
  stop_owned_pid "$lifecycle_pid" "$lifecycle_start_identity"
  stop_owned_pid "$wm_pid" "$wm_start_identity"
  stop_owned_pid "$xvfb_pid" "$xvfb_start_identity"
  if [[ $owned_ioc == true ]]; then
    docker stop --time 5 "$ioc_name" >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT

for command_name in awk curl date dirname docker find grep head jq lsof mktemp npm scrot sed setsid sha256sum sort stat tee timeout tr Xvfb xwininfo; do
  command -v "$command_name" >/dev/null 2>&1 || fail "required command '$command_name' is unavailable"
done
[[ -x $repo_root/node_modules/.bin/electron ]] || fail "run npm ci before local acceptance"
[[ -x $repo_root/node_modules/.bin/tsx ]] || fail "run npm ci before local acceptance"
[[ $lifecycle_port =~ ^[0-9]+$ ]] || fail "ELI_HMI_LIFECYCLE_PORT must be numeric"
[[ $lifecycle_port == 8765 ]] || fail "the checked-in local config fixes lifecycle to port 8765"
[[ $phoebus_port == 14918 ]] || fail "the checked-in local config fixes Phoebus to port 14918"
[[ $debug_port =~ ^[0-9]+$ ]] || fail "ELI_LOCAL_ACCEPTANCE_DEBUG_PORT must be numeric"

evidence_parent=$(dirname -- "$evidence_dir")
mkdir -p -- "$evidence_parent"
if [[ -n ${ELI_LOCAL_ACCEPTANCE_EVIDENCE_DIR:-} ]]; then
  mkdir -- "$evidence_dir" || fail "evidence directory already exists: $evidence_dir"
else
  evidence_dir=$(mktemp -d "${evidence_dir}.XXXXXX")
fi
labview_capture_dir="$evidence_dir/labview-captures"
phoebus_audit_dir="$evidence_dir/phoebus-argv"
mkdir -- "$labview_capture_dir" "$phoebus_audit_dir"
printf 'Local acceptance evidence: %s\n' "$evidence_dir"

lifecycle_python=${ELI_HMI_LIFECYCLE_PYTHON:-}
if [[ -z $lifecycle_python ]]; then
  for candidate in \
    "$repo_root/.venv/bin/python" \
    "$handoff_root/epics/hmi-api-venv/bin/python" \
    python3; do
    if command -v "$candidate" >/dev/null 2>&1 && \
      "$candidate" -c 'import fastapi, uvicorn' >/dev/null 2>&1; then
      lifecycle_python=$candidate
      break
    fi
  done
fi
[[ -n $lifecycle_python ]] || fail \
  "no Python with FastAPI and uvicorn was found; set ELI_HMI_LIFECYCLE_PYTHON"

if ! docker image inspect "$ioc_image" >/dev/null 2>&1; then
  fail "Docker image '$ioc_image' is not loaded; follow $handoff_root/EPICS-SETUP-BRIEF.md"
fi
if docker inspect "$ioc_name" >/dev/null 2>&1; then
  running=$(docker inspect "$ioc_name" --format '{{.State.Running}}')
  [[ $running == true ]] || fail "container '$ioc_name' exists but is not running"
  configured_image=$(docker inspect "$ioc_name" --format '{{.Config.Image}}')
  [[ $configured_image == "$ioc_image" ]] || fail \
    "container '$ioc_name' uses '$configured_image', expected '$ioc_image'"
  printf 'Using existing IOC container: %s\n' "$ioc_name"
else
  docker run --detach --rm --network host --name "$ioc_name" "$ioc_image" \
    > "$evidence_dir/ioc-container-id.txt"
  owned_ioc=true
  printf 'Started IOC container: %s\n' "$ioc_name"
fi

ioc_deadline=$((SECONDS + 30))
until docker logs "$ioc_name" 2>&1 | grep -F 'iocRun: All initialization complete' >/dev/null; do
  (( SECONDS < ioc_deadline )) || fail "IOC did not report initialization within 30 seconds"
  sleep 1
done
docker logs "$ioc_name" > "$evidence_dir/ioc.log" 2>&1

docker exec "$ioc_name" env \
  EPICS_CA_AUTO_ADDR_LIST=NO EPICS_CA_ADDR_LIST=127.0.0.1 \
  caget -w 5 L4-NSOPCPA-NL1:TK6:44:DisplayTemperature \
  | tee "$evidence_dir/caget.txt"
caget_status=${PIPESTATUS[0]}
printf '%s\n' "$caget_status" > "$evidence_dir/caget.exit-status"
[[ $caget_status -eq 0 ]] || fail "caget failed with exit status $caget_status"

set +e
timeout --signal=INT 3 docker exec "$ioc_name" env \
  EPICS_CA_AUTO_ADDR_LIST=NO EPICS_CA_ADDR_LIST=127.0.0.1 \
  camonitor L4-NSOPCPA-NL1:SY3PL50M:32:State \
  | tee "$evidence_dir/camonitor.txt"
camonitor_status=${PIPESTATUS[0]}
set -e
printf '%s\n' "$camonitor_status" > "$evidence_dir/camonitor.exit-status"
[[ $camonitor_status -eq 0 || $camonitor_status -eq 124 ]] || fail \
  "camonitor returned unexpected exit status $camonitor_status"
grep -F 'L4-NSOPCPA-NL1:SY3PL50M:32:State' "$evidence_dir/camonitor.txt" >/dev/null || \
  fail "camonitor produced no initial state value"

# The supplied database seeds static records as UDF and its global flashlamp
# fanout drops the selected enum value. Prepare only this local mock runtime,
# retain the complete caput audit, and leave the image itself unchanged.
"$repo_root/tools/phoebus-local/prepare-mock-ioc.sh" \
  --docker-container "$ioc_name" \
  | tee "$evidence_dir/mock-ioc-preparation.log"

port_open "$lifecycle_port" && fail "lifecycle port $lifecycle_port is already in use"
ELI_HMI_LIFECYCLE_BIND=127.0.0.1 \
ELI_HMI_LIFECYCLE_PORT="$lifecycle_port" \
  "$lifecycle_python" "$repo_root/services/hmi-lifecycle-api/lifecycle_api.py" \
  > "$evidence_dir/lifecycle.log" 2>&1 &
lifecycle_pid=$!
lifecycle_start_identity=$(capture_start_identity "$lifecycle_pid") || fail \
  "could not capture lifecycle service process identity"
lifecycle_url="http://127.0.0.1:$lifecycle_port/api/lifecycle/v1"
lifecycle_deadline=$((SECONDS + 30))
until curl --fail --silent "$lifecycle_url/health/live" > "$evidence_dir/lifecycle-health.json"; do
  kill -0 "$lifecycle_pid" 2>/dev/null || fail "lifecycle service exited; see lifecycle.log"
  (( SECONDS < lifecycle_deadline )) || fail "lifecycle service did not become healthy"
  sleep 1
done

"$repo_root/tools/phoebus-local/bootstrap.sh"
"$repo_root/tools/phoebus-local/self-test.sh"
ELI_HMI_LIFECYCLE_URL="$lifecycle_url" \
  "$repo_root/node_modules/.bin/tsx" "$repo_root/scripts/smoke-hmi-lifecycle.ts" \
  | tee "$evidence_dir/lifecycle-smoke.txt"
"$repo_root/node_modules/.bin/tsx" "$repo_root/scripts/smoke-labview-contract.ts" \
  "$evidence_dir/labview-contract-smoke.json" \
  | tee "$evidence_dir/labview-smoke.txt"

if [[ -n ${ELI_LOCAL_ACCEPTANCE_DISPLAY:-} ]]; then
  display_value=$ELI_LOCAL_ACCEPTANCE_DISPLAY
else
  for display_number in 91 92 93 94 95 96 97 98 99; do
    if [[ ! -e /tmp/.X11-unix/X$display_number ]]; then
      display_value=:$display_number
      break
    fi
  done
  [[ -n $display_value ]] || fail "no free X display number from :91 through :99"
  Xvfb "$display_value" -screen 0 1280x900x24 -nolisten tcp \
    > "$evidence_dir/xvfb.log" 2>&1 &
  xvfb_pid=$!
  xvfb_start_identity=$(capture_start_identity "$xvfb_pid") || fail \
    "could not capture Xvfb process identity"
  display_deadline=$((SECONDS + 10))
  until DISPLAY="$display_value" xwininfo -root >/dev/null 2>&1; do
    kill -0 "$xvfb_pid" 2>/dev/null || fail "Xvfb exited; see xvfb.log"
    (( SECONDS < display_deadline )) || fail "Xvfb did not become ready"
    sleep 1
  done
  if command -v jwm >/dev/null 2>&1; then
    DISPLAY="$display_value" jwm > "$evidence_dir/jwm.log" 2>&1 &
    wm_pid=$!
    wm_start_identity=$(capture_start_identity "$wm_pid") || fail \
      "could not capture JWM process identity"
    sleep 1
  fi
fi
export DISPLAY=$display_value

port_open "$phoebus_port" && fail "Phoebus port $phoebus_port is already in use"
port_open "$debug_port" && fail "Electron debug port $debug_port is already in use"

export ELI_LABVIEW_FIXTURE_CAPTURE_DIR=$labview_capture_dir
export ELI_LABVIEW_FIXTURE_LIFETIME_SECONDS=120
export ELI_LABVIEW_CONTRACT_HOST='local-host; literal $()'
export ELI_LABVIEW_CONTRACT_IOC='local-ioc & literal |'
export ELI_LABVIEW_CONTRACT_ZONE='L4 local zone'
export ELI_LABVIEW_CONTRACT_GUI='Local overview; literal *'
export ELI_PHOEBUS_ARGV_AUDIT_DIR=$phoebus_audit_dir
export ELI_LAUNCHER_CONFIG="$repo_root/config/local-acceptance.yaml"
export ELI_HMI_LIFECYCLE_URL=$lifecycle_url

npm run build \
  | tee "$evidence_dir/build.txt"
"$repo_root/node_modules/.bin/tsx" "$repo_root/scripts/validate-config.ts" \
  "$repo_root/config/local-acceptance.yaml" \
  | tee "$evidence_dir/config-validation.txt"

setsid "$repo_root/node_modules/.bin/electron" \
  --no-sandbox --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$debug_port" \
  --user-data-dir="$evidence_dir/electron-profile" \
  "$repo_root" \
  > "$evidence_dir/electron.log" 2>&1 &
electron_pid=$!
electron_start_identity=$(capture_start_identity "$electron_pid") || fail \
  "could not capture Electron process identity"

timeout 180 "$repo_root/node_modules/.bin/tsx" \
  "$repo_root/scripts/drive-local-acceptance-electron.ts" \
  "$debug_port" "$evidence_dir" "$labview_capture_dir" "$phoebus_audit_dir" \
  | tee "$evidence_dir/electron-driver.txt"

electron_deadline=$((SECONDS + 20))
while kill -0 "$electron_pid" 2>/dev/null; do
  (( SECONDS < electron_deadline )) || fail "Electron did not exit after its window closed"
  sleep 1
done
electron_pid=

phoebus_pid=$(lsof -nP -t -iTCP:"$phoebus_port" -sTCP:LISTEN | head -n 1 || true)
[[ $phoebus_pid =~ ^[0-9]+$ ]] || fail "no Phoebus listener PID was found"
server_audit_file=$(find "$phoebus_audit_dir" -maxdepth 1 -type f -name '*.argv' | sort | head -n 1)
server_audit_name=${server_audit_file##*/}
server_audit_pid=${server_audit_name%.argv}
server_audit_pid=${server_audit_pid##*-}
[[ $server_audit_pid == "$phoebus_pid" ]] || fail \
  "Phoebus listener PID $phoebus_pid does not match owned wrapper receipt $server_audit_pid"
server_identity_file=${server_audit_file%.argv}.start-identity
[[ -s $server_identity_file ]] || fail "Phoebus server audit has no start identity"
phoebus_start_identity=$(<"$server_identity_file")
identity_matches "$phoebus_pid" "$phoebus_start_identity" || fail \
  "Phoebus listener process identity no longer matches its owned receipt"
tr '\0' ' ' < "/proc/$phoebus_pid/cmdline" > "$evidence_dir/phoebus-listener.cmdline"
grep -F 'product-' "$evidence_dir/phoebus-listener.cmdline" >/dev/null || fail \
  "port $phoebus_port listener is not the locked Phoebus product JAR"
DISPLAY="$display_value" scrot "$evidence_dir/phoebus-live.png"
DISPLAY="$display_value" xwininfo -root -tree > "$evidence_dir/phoebus-windows.txt"

lifecycle_empty=false
for _attempt in 1 2 3 4 5 6 7 8 9 10; do
  curl --fail --silent "$lifecycle_url/entries" > "$evidence_dir/lifecycle-after-electron.json"
  if jq -e '.entries | length == 0' "$evidence_dir/lifecycle-after-electron.json" >/dev/null; then
    lifecycle_empty=true
    break
  fi
  sleep 1
done
[[ $lifecycle_empty == true ]] || fail "Electron did not deregister lifecycle entries during quit"

stop_owned_group "$phoebus_pid" "$phoebus_start_identity"
wait_for_port_close "$phoebus_port" 20 || fail "Phoebus server did not stop"
phoebus_pid=
phoebus_start_identity=
stop_labview_fixtures || fail "LabVIEW contract fixtures did not stop after TERM/KILL"

layout_audit_dir="$evidence_dir/layout-argv"
mkdir -p -- "$layout_audit_dir" "$evidence_dir/layout-home" "$evidence_dir/layout-preferences"
memento_file="$repo_root/examples/phoebus-local/local-alarm-layout.memento"
memento_provenance="$memento_file.provenance"
expected_memento_hash=$(awk -F '=' '$1 == "memento_sha256" {print $2}' "$memento_provenance")
expected_memento_size=$(awk -F '=' '$1 == "memento_size" {print $2}' "$memento_provenance")
actual_memento_hash=$(sha256sum -- "$memento_file" | awk '{print $1}')
actual_memento_size=$(stat -c '%s' -- "$memento_file")
[[ $actual_memento_hash == "$expected_memento_hash" ]] || fail \
  "tracked memento hash does not match its Phoebus authoring provenance"
[[ $actual_memento_size == "$expected_memento_size" ]] || fail \
  "tracked memento size does not match its Phoebus authoring provenance"
for application_id in alarm_tree alarm_area alarm_table; do
  grep -F "application=\"$application_id\"" \
    "$memento_file" >/dev/null || fail \
    "tracked memento does not contain $application_id"
done

ELI_PHOEBUS_ARGV_AUDIT_DIR="$layout_audit_dir" \
ELI_PHOEBUS_USER_HOME="$evidence_dir/layout-home" \
ELI_PHOEBUS_PREFERENCES_ROOT="$evidence_dir/layout-preferences" \
setsid "$repo_root/tools/phoebus-local/phoebus.sh" \
  -server "$phoebus_port" \
  -settings "$repo_root/config/phoebus-local.properties" \
  -layout "$memento_file" \
  > "$evidence_dir/layout.log" 2>&1 &
layout_pid=$!
layout_start_identity=$(capture_start_identity "$layout_pid") || fail \
  "could not capture layout Phoebus process identity"
wait_for_port "$phoebus_port" 60 || fail "Phoebus layout restore did not open its server port"
sleep 10
DISPLAY="$display_value" scrot "$evidence_dir/layout-restored.png"
DISPLAY="$display_value" xwininfo -root -tree > "$evidence_dir/layout-windows.txt"
for window_title in \
  'CSI744_LOCAL Alarm Tree' \
  'CSI744_LOCAL Alarm Area' \
  'CSI744_LOCAL Alarm Table'; do
  grep -F "$window_title" "$evidence_dir/layout-windows.txt" >/dev/null || fail \
    "restored layout has no native window titled '$window_title'"
done
sha256sum "$memento_file" > "$evidence_dir/layout.sha256"
stop_owned_group "$layout_pid" "$layout_start_identity"
wait_for_port_close "$phoebus_port" 20 || fail "Phoebus layout restore did not stop"
layout_pid=
layout_start_identity=

jq -n \
  --arg observedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg evidenceDir "$evidence_dir" \
  --arg cagetStatus "$caget_status" \
  --arg camonitorStatus "$camonitor_status" \
  '{
    result: "passed",
    classification: "local-acceptance",
    observedAt: $observedAt,
    evidenceDir: $evidenceDir,
    ioc: {cagetExitStatus: ($cagetStatus | tonumber), camonitorExitStatus: ($camonitorStatus | tonumber)},
    mockPreparation: "static records processed, deliberate LOW/MINOR alarm proven, and local flashlamp fanout repaired in memory",
    electron: "six production launch IPC calls passed and lifecycle deregistration was observed",
    labview: "POSIX contract fixtures ran; NI LabVIEW was not executed",
    phoebus: "locked runtime exposed each BOB native title through one server",
    layout: "the provenance-matched memento restored all three native alarm window titles",
    siteClaim: "no site lifecycle, LabVIEW, alarm backend, or deployment value was asserted"
  }' > "$evidence_dir/summary.json"

printf 'Local acceptance passed. Evidence: %s\n' "$evidence_dir"
