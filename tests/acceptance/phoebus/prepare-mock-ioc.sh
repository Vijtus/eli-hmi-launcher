#!/usr/bin/env bash
set -euo pipefail

# Prepare the supplied laser mock IOC for operator-panel acceptance.
#
# The image database seeds static input records with VAL fields, which leaves
# them UDF until first processing. It also links SetFlashlamps to FlashlampsCMD
# with FLNK, so the selected enum value is not transferred to the fanout, and
# FlashlampsCMD2 has no source for the second half of the chain. This script:
#
#   1. processes display-only records without changing their seeded values;
#   2. repairs those two runtime links without modifying the supplied image;
#   3. initializes explicit command records to safe mock values; and
#   4. proves the deliberate chiller-13 LOW/MINOR alarm and fanout state.
#
# Every caput is printed before execution so an acceptance log is a complete
# write audit. Nothing in this script is suitable for a site or production IOC.

container=
if [[ ${1:-} == --docker-container ]]; then
  [[ $# -eq 2 && -n ${2:-} ]] || {
    printf 'Usage: %s [--docker-container NAME]\n' "$0" >&2
    exit 2
  }
  container=$2
elif [[ $# -ne 0 ]]; then
  printf 'Usage: %s [--docker-container NAME]\n' "$0" >&2
  exit 2
fi

run_epics() {
  if [[ -n $container ]]; then
    docker exec "$container" env \
      EPICS_CA_AUTO_ADDR_LIST=NO \
      EPICS_CA_ADDR_LIST=127.0.0.1 \
      "$@"
  else
    "$@"
  fi
}

write_pv() {
  local pv=$1
  local value=$2
  printf 'caput %s %s\n' "$pv" "$value"
  run_epics caput -w 5 "$pv" "$value"
}

process_record() {
  local pv=$1
  write_pv "$pv.PROC" 1
}

cp_prefix=L4-NSOPCPA-NL1

read_only_pvs=(
  BI_NL2_CONN
  BI_NL2_FULLP
  BI_NL2_SHUTTER
  BI_NL2_MSS_1
  BI_NL2_REGEN_STATE
  BI_NL2_SEQUENCER_RUNNING
  AI_TEMP_NL2_REGEN
  AI_NL2_ATT
  AI_NL2_PHD_MEAN
  AI_NL2_PHD2_MEAN
  "$cp_prefix:SY3PL50M:32:State"
  "$cp_prefix:SY3PL50M:32:ErrorCode"
  "$cp_prefix:TK6:44:DisplayTemperature"
  "$cp_prefix:TK6:44:ErrorCode"
  "$cp_prefix:SM5-ATT:51:CurrentPosition"
  "$cp_prefix:SM5-ATT:51:ErrorCode"
  "$cp_prefix:SM5-SH:50:ErrorCode"
  "$cp_prefix:IO:15:ErrorCode"
  "$cp_prefix:LDM150V5:17:ErrorCode"
  "$cp_prefix:HV40W:40:ErrorCode"
  "$cp_prefix:PD1-REG:48:ErrorCode"
  "$cp_prefix:PS1225:10:ErrorCode"
  "$cp_prefix:PS1225:10:Tout"
  "$cp_prefix:PS1225:10:Ttank"
  "$cp_prefix:PS1225:10:Treturn"
  "$cp_prefix:PS1225:10:Tsupply"
  "$cp_prefix:PS1225:10:MeasuredFlow"
  "$cp_prefix:PS1225:10:MeasuredLevel"
  "$cp_prefix:PS5059:22:ErrorCode"
  "$cp_prefix:PS5059:28:ErrorCode"
  "$cp_prefix:PS5059:22:Ch1State"
  "$cp_prefix:PS5059:22:Ch2State"
  "$cp_prefix:PS5059:28:Ch1State"
  "$cp_prefix:PS5059:28:Ch2State"
  "$cp_prefix:PS5059:22:Ch1TriggeringDelay"
  "$cp_prefix:PS5059:22:Ch2TriggeringDelay"
  "$cp_prefix:PS5059:28:Ch1TriggeringDelay"
  "$cp_prefix:PS5059:28:Ch2TriggeringDelay"
  AI_NL2_TRIG_DELAY_CH1
  AI_NL2_TRIG_DELAY_CH2
  BI_NL2_ERR_REGEN
  BI_NL2_ERR_FLASHLAMPS
)

for chiller in 11 12 13 14; do
  read_only_pvs+=(
    "BI_NL2_ERR_CHILLER_$chiller"
    "AI_NL2_CHILLER_${chiller}_TEMP"
    "AI_NL2_CHILLER_${chiller}_FLOW"
    "AI_NL2_CHILLER_${chiller}_LEVEL"
  )
done

for unit in 22 23 24 25 26 27 28; do
  read_only_pvs+=("SI_NL2_FL_${unit}_CH1" "SI_NL2_FL_${unit}_CH2")
done

for pv in "${read_only_pvs[@]}"; do
  process_record "$pv"
done

# Repair the local mock's global flashlamp fanout in memory. The original IOC
# image remains byte-for-byte unchanged.
write_pv SetFlashlamps.OUT 'FlashlampsCMD PP'
write_pv FlashlampsCMD2.DOL 'FlashlampsCMD NPP'
write_pv FlashlampsCMD2.OMSL closed_loop

for unit in 22 28; do
  for channel in 1 2; do
    write_pv "$cp_prefix:PS5059:$unit:Ch${channel}State:SET" STANDBY
    write_pv "$cp_prefix:PS5059:$unit:Ch${channel}TriggeringDelay:SET" 50
  done
done
write_pv SetFlashlamps STANDBY
write_pv SET_DELAY 50

alarm_result=$(run_epics caget -a -w 5 AI_NL2_CHILLER_13_LEVEL)
printf '%s\n' "$alarm_result"
grep -F 'LOW MINOR' <<<"$alarm_result" >/dev/null || {
  printf 'Expected AI_NL2_CHILLER_13_LEVEL to report LOW MINOR.\n' >&2
  exit 1
}

fanout_result=$(run_epics caget -w 5 SI_NL2_FL_22_CH1 SI_NL2_FL_28_CH2)
printf '%s\n' "$fanout_result"
[[ $(grep -c 'STANDBY' <<<"$fanout_result") -eq 2 ]] || {
  printf 'Expected the repaired global fanout to initialize both ends to STANDBY.\n' >&2
  exit 1
}

printf 'Local mock IOC preparation passed.\n'
