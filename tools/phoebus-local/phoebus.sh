#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
local_root=${ELI_PHOEBUS_LOCAL_ROOT:-"$repo_root/.local/phoebus"}
runtime_dir="$local_root/runtime"
java_executable="$local_root/jdk/bin/java"
user_home=${ELI_PHOEBUS_USER_HOME:-"$local_root/user-home"}
preferences_root=${ELI_PHOEBUS_PREFERENCES_ROOT:-"$local_root/preferences"}

if [[ ! -x $java_executable ]]; then
  printf 'Phoebus wrapper: JDK is missing at %s; run %s/bootstrap.sh first.\n' \
    "$java_executable" "$script_dir" >&2
  exit 1
fi

mapfile -d '' product_jars < <(find "$runtime_dir" -type f -name 'product-*.jar' -print0 2>/dev/null)
if [[ ${#product_jars[@]} -ne 1 ]]; then
  printf 'Phoebus wrapper: expected one product-*.jar below %s, found %d.\n' \
    "$runtime_dir" "${#product_jars[@]}" >&2
  exit 1
fi

mkdir -p -- "$user_home" "$preferences_root"

if [[ -n ${ELI_PHOEBUS_ARGV_AUDIT_DIR:-} ]]; then
  audit_dir=$ELI_PHOEBUS_ARGV_AUDIT_DIR
  if [[ $audit_dir != /* ]]; then
    audit_dir="$repo_root/$audit_dir"
  fi
  mkdir -p -- "$audit_dir"
  audit_tmp=$(mktemp "$audit_dir/.argv.XXXXXX")
  identity_tmp=$(mktemp "$audit_dir/.start-identity.XXXXXX")
  audit_stem="$audit_dir/$(date -u +%s%N)-$$"
  printf '%s\0' "$@" > "$audit_tmp"
  sed 's/^.*) //' "/proc/$$/stat" | awk '{print $20}' > "$identity_tmp"
  grep -Eq '^[0-9]+$' "$identity_tmp" || {
    rm -f -- "$audit_tmp" "$identity_tmp"
    printf 'Phoebus wrapper: could not capture process start identity.\n' >&2
    exit 1
  }
  # Publish identity first and argv last. Once an .argv receipt is visible,
  # cleanup can validate this exact process even in the brief shell-to-Java
  # exec window.
  mv -- "$identity_tmp" "$audit_stem.start-identity"
  mv -- "$audit_tmp" "$audit_stem.argv"
fi

# The upstream phoebus.sh injects '-server 4918' and backgrounds Java. Calling
# the product JAR directly leaves server ownership and every Phoebus argv item
# with the Electron launcher's two-phase manager.
exec "$java_executable" \
  -Dfile.encoding=UTF-8 \
  "-Duser.home=$user_home" \
  "-Djava.util.prefs.userRoot=$preferences_root" \
  -jar "${product_jars[0]}" "$@"
