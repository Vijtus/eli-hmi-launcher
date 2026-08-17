#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
lock_file="$script_dir/artifacts.lock"
local_root=${ELI_PHOEBUS_LOCAL_ROOT:-"$repo_root/.local/phoebus"}
artifact_dir="$local_root/artifacts"
runtime_dir="$local_root/runtime"
jdk_dir="$local_root/jdk"
install_marker="$local_root/install.lock"

phoebus_name=phoebus-linux.zip
phoebus_url=https://controlssoftware.sns.ornl.gov/css_phoebus/nightly/phoebus-linux.zip
jdk_name=OpenJDK25U-jdk_x64_linux_hotspot_25.0.3_9.tar.gz
jdk_url=https://controlssoftware.sns.ornl.gov/css_phoebus/nightly/OpenJDK25U-jdk_x64_linux_hotspot_25.0.3_9.tar.gz

mode=install
case "${1:-}" in
  "") ;;
  --reinstall) mode=reinstall ;;
  --refresh-lock) mode=refresh-lock ;;
  *)
    printf 'Usage: %s [--reinstall|--refresh-lock]\n' "$0" >&2
    exit 2
    ;;
esac

fail() {
  printf 'Phoebus bootstrap: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command '$1' is not installed"
}

for command_name in awk curl date find sha256sum stat tar unzip; do
  require_command "$command_name"
done

[[ $(uname -s) == Linux ]] || fail "the locked artifacts support Linux only"
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "the locked JDK supports x86_64 only; got $(uname -m)" ;;
esac

mkdir -p -- "$artifact_dir"

lock_value() {
  local artifact=$1
  local column=$2
  awk -F '\t' -v artifact="$artifact" -v column="$column" '
    $1 == artifact { value = $column; count += 1 }
    END {
      if (count != 1 || value == "") exit 1
      print value
    }
  ' "$lock_file"
}

verify_locked_artifact() {
  local artifact=$1
  local file_path=$2
  local expected_hash expected_size actual_hash actual_size
  expected_hash=$(lock_value "$artifact" 4) || fail "lock has no unique hash for '$artifact'"
  expected_size=$(lock_value "$artifact" 5) || fail "lock has no unique size for '$artifact'"
  actual_hash=$(sha256sum -- "$file_path" | awk '{print $1}')
  actual_size=$(stat -c '%s' -- "$file_path")
  if [[ $actual_hash != "$expected_hash" ]]; then
    printf '%s hash mismatch: expected %s, got %s\n' \
      "$artifact" "$expected_hash" "$actual_hash" >&2
    return 1
  fi
  if [[ $actual_size != "$expected_size" ]]; then
    printf '%s size mismatch: expected %s, got %s\n' \
      "$artifact" "$expected_size" "$actual_size" >&2
    return 1
  fi
}

download_locked_artifact() {
  local artifact=$1
  local filename url destination partial rejected_stamp
  filename=$(lock_value "$artifact" 2) || fail "lock has no unique filename for '$artifact'"
  url=$(lock_value "$artifact" 3) || fail "lock has no unique URL for '$artifact'"
  destination="$artifact_dir/$filename"

  if [[ -f $destination ]]; then
    verify_locked_artifact "$artifact" "$destination" || fail \
      "cached artifact does not match artifacts.lock: $destination"
    printf 'Using locked %s artifact: %s\n' "$artifact" "$destination"
    return
  fi

  partial=$(mktemp "$artifact_dir/.${filename}.part.XXXXXX")
  if ! curl --fail --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --output "$partial" "$url"; then
    mv -- "$partial" "$partial.download-failed"
    fail "download failed for $url; partial data kept at $partial.download-failed"
  fi
  if ! verify_locked_artifact "$artifact" "$partial"; then
    rejected_stamp=$(date -u +%Y%m%dT%H%M%SZ)
    mv -- "$partial" "$artifact_dir/${filename}.rejected.$rejected_stamp"
    fail "the mutable upstream artifact no longer matches artifacts.lock; review it and use --refresh-lock explicitly"
  fi
  mv -- "$partial" "$destination"
  printf 'Downloaded and verified %s\n' "$destination"
}

http_last_modified() {
  local url=$1
  curl --fail --silent --show-error --location --head --proto '=https' --tlsv1.2 "$url" \
    | tr -d '\r' \
    | awk -F ': ' 'tolower($1) == "last-modified" { print $2; exit }'
}

http_date_to_utc() {
  local header_date=$1
  date -u -d "$header_date" +%Y-%m-%dT%H:%M:%SZ
}

refresh_one() {
  local artifact=$1
  local filename=$2
  local url=$3
  local output_file=$4
  local partial hash size modified retrieved
  partial=$(mktemp "$artifact_dir/.${filename}.refresh.XXXXXX")
  curl --fail --location --proto '=https' --tlsv1.2 \
    --retry 3 --retry-delay 2 --output "$partial" "$url"
  hash=$(sha256sum -- "$partial" | awk '{print $1}')
  size=$(stat -c '%s' -- "$partial")
  modified=$(http_last_modified "$url")
  modified=$(http_date_to_utc "$modified")
  retrieved=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$artifact" "$filename" "$url" "$hash" "$size" "$modified" "$retrieved" >> "$output_file"
  mv -- "$partial" "$artifact_dir/$filename"
}

refresh_lock() {
  local new_lock
  new_lock=$(mktemp "$script_dir/.artifacts.lock.XXXXXX")
  printf '%s\n' \
    '# artifact<TAB>filename<TAB>url<TAB>sha256<TAB>size_bytes<TAB>last_modified_utc<TAB>retrieved_utc' \
    > "$new_lock"
  refresh_one phoebus "$phoebus_name" "$phoebus_url" "$new_lock"
  refresh_one jdk "$jdk_name" "$jdk_url" "$new_lock"
  mv -- "$new_lock" "$lock_file"
  printf 'Refreshed %s. Review and commit that change before relying on it.\n' "$lock_file"
}

if [[ $mode == refresh-lock ]]; then
  refresh_lock
  exit 0
fi

download_locked_artifact phoebus
download_locked_artifact jdk

phoebus_artifact="$artifact_dir/$(lock_value phoebus 2)"
jdk_artifact="$artifact_dir/$(lock_value jdk 2)"
lock_hash=$(sha256sum -- "$lock_file" | awk '{print $1}')

installed_lock_hash=
if [[ -f $install_marker ]]; then
  installed_lock_hash=$(awk -F '=' '$1 == "artifacts_lock_sha256" {print $2}' "$install_marker")
fi
if [[ $installed_lock_hash == "$lock_hash" && -d $runtime_dir && -x $jdk_dir/bin/java ]]; then
  mapfile -d '' installed_jars < <(find "$runtime_dir" -type f -name 'product-*.jar' -print0)
  if [[ ${#installed_jars[@]} -eq 1 ]]; then
    printf 'Phoebus runtime already matches artifacts.lock: %s\n' "$runtime_dir"
    exit 0
  fi
fi

if [[ $mode != reinstall && ( -e $runtime_dir || -e $jdk_dir || -e $install_marker ) ]]; then
  fail "an install exists but does not match artifacts.lock; inspect it, then run with --reinstall"
fi

stage=$(mktemp -d "$local_root/.install.XXXXXX")
cleanup_stage() {
  if [[ -n ${stage:-} && $stage == "$local_root"/.install.* && -d $stage ]]; then
    rm -rf -- "$stage"
  fi
}
trap cleanup_stage EXIT

mkdir -p -- "$stage/runtime" "$stage/jdk"
unzip -q "$phoebus_artifact" -d "$stage/runtime"
tar -xzf "$jdk_artifact" --strip-components=1 -C "$stage/jdk"

mapfile -d '' product_jars < <(find "$stage/runtime" -type f -name 'product-*.jar' -print0)
[[ ${#product_jars[@]} -eq 1 ]] || fail \
  "expected exactly one product-*.jar in the Phoebus archive, found ${#product_jars[@]}"
[[ -x $stage/jdk/bin/java ]] || fail "extracted JDK has no executable bin/java"

if [[ $mode == reinstall ]]; then
  backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
  [[ ! -e $local_root/runtime.previous.$backup_stamp ]] || fail "runtime backup path already exists"
  [[ ! -e $local_root/jdk.previous.$backup_stamp ]] || fail "JDK backup path already exists"
  [[ ! -e $runtime_dir ]] || mv -- "$runtime_dir" "$local_root/runtime.previous.$backup_stamp"
  [[ ! -e $jdk_dir ]] || mv -- "$jdk_dir" "$local_root/jdk.previous.$backup_stamp"
fi

mv -- "$stage/runtime" "$runtime_dir"
mv -- "$stage/jdk" "$jdk_dir"
marker_tmp=$(mktemp "$local_root/.install.lock.XXXXXX")
{
  printf 'artifacts_lock_sha256=%s\n' "$lock_hash"
  printf 'phoebus_sha256=%s\n' "$(lock_value phoebus 4)"
  printf 'jdk_sha256=%s\n' "$(lock_value jdk 4)"
  printf 'installed_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$marker_tmp"
mv -- "$marker_tmp" "$install_marker"

printf 'Installed locked Phoebus runtime: %s\n' "$runtime_dir"
printf 'Installed locked JDK: %s\n' "$jdk_dir"
printf 'Product JAR: %s\n' "${product_jars[0]#"$stage/runtime/"}"
