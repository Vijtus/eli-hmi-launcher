#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
local_root=${ELI_PHOEBUS_LOCAL_ROOT:-"$repo_root/.local/phoebus"}
output_dir=${1:-"$local_root/evidence"}
runner="$script_dir/phoebus.sh"
lock_file="$script_dir/artifacts.lock"

mkdir -p -- "$output_dir"
list_tmp=$(mktemp "$output_dir/.applications.XXXXXX")
if ! "$runner" -list > "$list_tmp" 2>&1; then
  mv -- "$list_tmp" "$output_dir/applications.failed.txt"
  printf 'Phoebus -list failed; output: %s\n' "$output_dir/applications.failed.txt" >&2
  exit 1
fi
mv -- "$list_tmp" "$output_dir/applications.raw.txt"
awk '
  /^Name[[:space:]]+Description[[:space:]]+File Extensions/ { table = 1 }
  table { print }
' "$output_dir/applications.raw.txt" > "$output_dir/applications.txt"
[[ -s $output_dir/applications.txt ]] || {
  printf 'Phoebus -list returned no application table; raw output: %s\n' \
    "$output_dir/applications.raw.txt" >&2
  exit 1
}

for application_id in display_runtime alarm_tree alarm_table alarm_area; do
  if ! grep -Eq "(^|[[:space:][:punct:]])${application_id}([[:space:][:punct:]]|$)" \
    "$output_dir/applications.txt"; then
    printf "Required application id '%s' is absent from real Phoebus -list output.\n" \
      "$application_id" >&2
    exit 1
  fi
done

"$local_root/jdk/bin/java" -version > "$output_dir/java-version.txt" 2>&1
sha256sum -- "$lock_file" > "$output_dir/artifacts-lock.sha256"
cp -- "$lock_file" "$output_dir/artifacts.lock"
printf 'Captured real application ids in %s\n' "$output_dir/applications.txt"
