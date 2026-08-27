#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
fixture_root=$(mktemp -d /tmp/eli-phoebus-wrapper-test.XXXXXX)
cleanup() {
  if [[ $fixture_root == /tmp/eli-phoebus-wrapper-test.* ]]; then
    rm -rf -- "$fixture_root"
  fi
}
trap cleanup EXIT

[[ -x "$script_dir/prepare-mock-ioc.sh" ]]
bash -n "$script_dir/prepare-mock-ioc.sh"

mkdir -p -- "$fixture_root/jdk/bin" "$fixture_root/runtime/with space" "$fixture_root/audit"
touch "$fixture_root/runtime/with space/product-test.jar"
capture_file="$fixture_root/java.argv"

cat > "$fixture_root/jdk/bin/java" <<'FAKE_JAVA'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" > "$ELI_PHOEBUS_FAKE_JAVA_CAPTURE"
FAKE_JAVA
chmod +x "$fixture_root/jdk/bin/java"

resource='/tmp/Panel & state.bob?app=display_runtime'
ELI_PHOEBUS_LOCAL_ROOT="$fixture_root" \
ELI_PHOEBUS_FAKE_JAVA_CAPTURE="$capture_file" \
ELI_PHOEBUS_ARGV_AUDIT_DIR="$fixture_root/audit" \
  "$script_dir/phoebus.sh" -server 14918 -resource "$resource"

mapfile -d '' java_argv < "$capture_file"
[[ ${java_argv[0]} == -Dfile.encoding=UTF-8 ]]
[[ ${java_argv[1]} == "-Duser.home=$fixture_root/user-home" ]]
[[ ${java_argv[2]} == "-Djava.util.prefs.userRoot=$fixture_root/preferences" ]]
[[ ${java_argv[3]} == -jar ]]
[[ ${java_argv[4]} == "$fixture_root/runtime/with space/product-test.jar" ]]
[[ ${java_argv[5]} == -server ]]
[[ ${java_argv[6]} == 14918 ]]
[[ ${java_argv[7]} == -resource ]]
[[ ${java_argv[8]} == "$resource" ]]
[[ ${#java_argv[@]} -eq 9 ]]

mapfile -d '' audit_files < <(find "$fixture_root/audit" -type f -name '*.argv' -print0)
[[ ${#audit_files[@]} -eq 1 ]]
audit_identity="${audit_files[0]%.argv}.start-identity"
[[ -s $audit_identity ]]
grep -Eq '^[0-9]+$' "$audit_identity"
mapfile -d '' audited_argv < "${audit_files[0]}"
[[ ${#audited_argv[@]} -eq 4 ]]
[[ ${audited_argv[0]} == -server ]]
[[ ${audited_argv[1]} == 14918 ]]
[[ ${audited_argv[2]} == -resource ]]
[[ ${audited_argv[3]} == "$resource" ]]

python3 - "$repo_root/tests/acceptance/assets" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

display_dir = Path(sys.argv[1])
cp = "L4-NSOPCPA-NL1"
expected = {
    "temperature.bob": {
        "BI_NL2_CONN",
        "BI_NL2_FULLP",
        "BI_NL2_SHUTTER",
        "BI_NL2_MSS_1",
        "BI_NL2_SEQUENCER_RUNNING",
        "BI_NL2_REGEN_STATE",
        "AI_TEMP_NL2_REGEN",
        "AI_NL2_ATT",
        "AI_NL2_PHD_MEAN",
        "AI_NL2_PHD2_MEAN",
        f"{cp}:SY3PL50M:32:State",
        f"{cp}:SY3PL50M:32:ErrorCode",
        f"{cp}:TK6:44:DisplayTemperature",
        f"{cp}:TK6:44:ErrorCode",
        f"{cp}:SM5-ATT:51:CurrentPosition",
        f"{cp}:SM5-ATT:51:ErrorCode",
        f"{cp}:SM5-SH:50:ErrorCode",
        f"{cp}:IO:15:ErrorCode",
        f"{cp}:LDM150V5:17:ErrorCode",
        f"{cp}:HV40W:40:ErrorCode",
        f"{cp}:PD1-REG:48:ErrorCode",
    },
    "flow.bob": {
        f"{cp}:PS1225:10:ErrorCode",
        f"{cp}:PS1225:10:Tout",
        f"{cp}:PS1225:10:Ttank",
        f"{cp}:PS1225:10:Treturn",
        f"{cp}:PS1225:10:Tsupply",
        f"{cp}:PS1225:10:MeasuredFlow",
        f"{cp}:PS1225:10:MeasuredLevel",
        *{
            f"BI_NL2_ERR_CHILLER_{chiller}"
            for chiller in range(11, 15)
        },
        *{
            f"AI_NL2_CHILLER_{chiller}_{measurement}"
            for chiller in range(11, 15)
            for measurement in ("TEMP", "FLOW", "LEVEL")
        },
    },
    "state.bob": {
        *{
            f"{cp}:PS5059:{unit}:ErrorCode"
            for unit in (22, 28)
        },
        *{
            f"{cp}:PS5059:{unit}:Ch{channel}{field}{suffix}"
            for unit in (22, 28)
            for channel in (1, 2)
            for field in ("State", "TriggeringDelay")
            for suffix in ("", ":SET")
        },
        "SetFlashlamps",
        "FLASHLAMPS_RUN",
        "FLASHLAMPS_STANDBY",
        "AI_NL2_TRIG_DELAY_CH1",
        "AI_NL2_TRIG_DELAY_CH2",
        "SET_DELAY",
        "BI_NL2_ERR_REGEN",
        "BI_NL2_ERR_FLASHLAMPS",
        "BI_NL2_SEQUENCER_RUNNING",
        *{
            f"SI_NL2_FL_{unit}_CH{channel}"
            for unit in range(22, 29)
            for channel in (1, 2)
        },
    },
}
writable = {
    *{
        f"{cp}:PS5059:{unit}:Ch{channel}{field}:SET"
        for unit in (22, 28)
        for channel in (1, 2)
        for field in ("State", "TriggeringDelay")
    },
    "SetFlashlamps",
    "FLASHLAMPS_RUN",
    "FLASHLAMPS_STANDBY",
    "SET_DELAY",
}

def expand_cp(pv: str) -> str:
    return pv.replace("$(CP)", cp)

for filename, expected_pvs in expected.items():
    root = ET.parse(display_dir / filename).getroot()
    assert root.tag == "display", filename
    assert root.findtext("name"), filename
    assert int(root.findtext("width", "0")) >= 1000, filename
    assert int(root.findtext("height", "0")) >= 700, filename
    assert root.findtext("macros/CP") == cp, filename

    mock_labels = [node.text or "" for node in root.findall(".//widget/text")]
    assert any("LOCAL MOCK IOC" in label for label in mock_labels), filename

    names = [node.findtext("name") for node in root.findall(".//widget")]
    assert all(names), filename
    assert len(names) == len(set(names)), (filename, "duplicate widget name")

    actual_pvs = {
        expand_cp(node.text)
        for node in root.findall(".//pv_name")
        if node.text
    }
    assert actual_pvs == expected_pvs, (
        filename,
        "missing",
        sorted(expected_pvs - actual_pvs),
        "unexpected",
        sorted(actual_pvs - expected_pvs),
    )

    for widget in root.findall(".//widget"):
        if widget.attrib.get("type") not in {"combo", "textentry"}:
            continue
        pv = widget.findtext("pv_name")
        assert pv and expand_cp(pv) in writable, (filename, widget.findtext("name"), pv)

    for action in root.findall(".//action"):
        if action.attrib.get("type") == "write_pv":
            pv = action.findtext("pv_name")
            assert pv and expand_cp(pv) in writable, (filename, "write action", pv)
        if action.attrib.get("type") == "open_display":
            target = action.findtext("file")
            assert target and (display_dir / target).is_file(), (filename, "display action", target)
PY

grep -Fx 'org.phoebus.pv.ca/addr_list=127.0.0.1' "$repo_root/tests/acceptance/config/phoebus.properties" >/dev/null
grep -Fx 'org.phoebus.pv.ca/auto_addr_list=false' "$repo_root/tests/acceptance/config/phoebus.properties" >/dev/null

printf 'Phoebus local asset self-test passed.\n'
