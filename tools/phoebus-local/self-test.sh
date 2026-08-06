#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
fixture_root=$(mktemp -d /tmp/eli-phoebus-wrapper-test.XXXXXX)
cleanup() {
  if [[ $fixture_root == /tmp/eli-phoebus-wrapper-test.* ]]; then
    rm -rf -- "$fixture_root"
  fi
}
trap cleanup EXIT

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

python3 - "$repo_root/examples/phoebus-local" <<'PY'
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

display_dir = Path(sys.argv[1])
expected = {
    "temperature.bob": "L4-NSOPCPA-NL1:TK6:44:DisplayTemperature",
    "state.bob": "L4-NSOPCPA-NL1:SY3PL50M:32:State",
    "flow.bob": "L4-NSOPCPA-NL1:PS1225:10:MeasuredFlow",
}
for filename, pv in expected.items():
    root = ET.parse(display_dir / filename).getroot()
    assert root.tag == "display", filename
    assert pv in [node.text for node in root.findall(".//pv_name")], (filename, pv)
PY

grep -Fx 'org.phoebus.pv.ca/addr_list=127.0.0.1' "$repo_root/config/phoebus-local.properties" >/dev/null
grep -Fx 'org.phoebus.pv.ca/auto_addr_list=false' "$repo_root/config/phoebus-local.properties" >/dev/null

printf 'Phoebus local asset self-test passed.\n'
