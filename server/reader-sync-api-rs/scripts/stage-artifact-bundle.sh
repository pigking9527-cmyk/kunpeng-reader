#!/usr/bin/env bash
# Creates or verifies the smallest offline transfer directory for a provenance-checked candidate.
# This tool deliberately has no upload, SSH, database, SMTP, proxy, or deployment capability.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
provenance_tool="$script_dir/create-artifact-provenance.sh"

usage() {
  cat <<'USAGE'
Usage:
  stage-artifact-bundle.sh --binary PATH --manifest PATH --output-dir PATH [--service-dir PATH]
  stage-artifact-bundle.sh --verify --bundle-dir PATH [--service-dir PATH]

Creates or verifies an offline-only transfer directory containing exactly a verified candidate
binary and its provenance manifest. It never opens a network connection, reads deployment
configuration, uploads files, or prints supplied paths.
USAGE
}

fail() {
  printf '%s\n' "artifact bundle check failed: $*" >&2
  exit 1
}

require_safe_name() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'artifact name contains unsupported characters'
}

read_artifact_name() {
  local manifest_path=$1
  local artifact_lines artifact_name
  artifact_lines=$(LC_ALL=C grep -Ec '^artifact_name=[A-Za-z0-9][A-Za-z0-9._-]*$' "$manifest_path" || true)
  [[ "$artifact_lines" == 1 ]] || fail 'manifest must contain exactly one valid artifact_name entry'
  artifact_name=$(LC_ALL=C sed -n 's/^artifact_name=//p' "$manifest_path")
  require_safe_name "$artifact_name"
  printf '%s\n' "$artifact_name"
}

require_bundle_layout() {
  local bundle_dir=$1
  [[ -d "$bundle_dir" && ! -L "$bundle_dir" ]] || fail 'bundle directory must be a real directory'
  local entries=()
  while IFS= read -r entry; do entries+=("$entry"); done < <(LC_ALL=C find "$bundle_dir" -mindepth 1 -maxdepth 1 -print | LC_ALL=C sort)
  (( ${#entries[@]} == 2 )) || fail 'bundle must contain exactly the candidate binary and provenance manifest'
  [[ -f "$bundle_dir/provenance.txt" && ! -L "$bundle_dir/provenance.txt" ]] || fail 'bundle provenance manifest must be a regular file'
  [[ -r "$bundle_dir/provenance.txt" ]] || fail 'bundle provenance manifest is not readable'
}

mode=create
binary=''
manifest=''
output_dir=''
bundle_dir=''
service_dir=''
while (( $# > 0 )); do
  case "$1" in
    --binary)
      (( $# >= 2 )) || fail '--binary requires a path'
      binary=$2
      shift 2
      ;;
    --manifest)
      (( $# >= 2 )) || fail '--manifest requires a path'
      manifest=$2
      shift 2
      ;;
    --output-dir)
      (( $# >= 2 )) || fail '--output-dir requires a path'
      output_dir=$2
      shift 2
      ;;
    --bundle-dir)
      (( $# >= 2 )) || fail '--bundle-dir requires a path'
      bundle_dir=$2
      shift 2
      ;;
    --service-dir)
      (( $# >= 2 )) || fail '--service-dir requires a path'
      service_dir=$2
      shift 2
      ;;
    --verify)
      mode=verify
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *) fail 'unknown argument' ;;
  esac
done

[[ -x "$provenance_tool" ]] || fail 'artifact provenance tool is unavailable'

if [[ "$mode" == create ]]; then
  [[ -n "$binary" && -n "$manifest" && -n "$output_dir" && -z "$bundle_dir" ]] \
    || fail 'create requires --binary, --manifest and --output-dir only'
  [[ -f "$binary" && -s "$binary" && -x "$binary" ]] || fail 'binary must be a non-empty executable file'
  [[ -f "$manifest" && ! -L "$manifest" ]] || fail 'manifest must be a regular file'
  [[ ! -e "$output_dir" ]] || fail 'output directory already exists'
  output_parent=$(CDPATH= cd -- "$(dirname -- "$output_dir")" && pwd)
  output_name=$(basename -- "$output_dir")
  [[ "$output_name" != '.' && "$output_name" != '..' ]] || fail 'output directory name is invalid'
  output_dir="$output_parent/$output_name"
  artifact_name=$(read_artifact_name "$manifest")
  [[ "$(basename -- "$binary")" == "$artifact_name" ]] || fail 'binary filename does not match manifest artifact_name'
  verify_args=(--verify --binary "$binary" --manifest "$manifest")
  [[ -n "$service_dir" ]] && verify_args+=(--service-dir "$service_dir")
  "$provenance_tool" "${verify_args[@]}" >/dev/null

  umask 077
  mkdir -- "$output_dir"
  cleanup_output() { rm -rf -- "$output_dir"; }
  trap cleanup_output ERR INT TERM
  install -m 755 -- "$binary" "$output_dir/$artifact_name"
  install -m 600 -- "$manifest" "$output_dir/provenance.txt"
  verify_args=(--verify --binary "$output_dir/$artifact_name" --manifest "$output_dir/provenance.txt")
  [[ -n "$service_dir" ]] && verify_args+=(--service-dir "$service_dir")
  "$provenance_tool" "${verify_args[@]}" >/dev/null
  trap - ERR INT TERM
  printf '%s\n' 'Offline artifact bundle staged and verified.'
else
  [[ -n "$bundle_dir" && -z "$binary" && -z "$manifest" && -z "$output_dir" ]] \
    || fail 'verify requires --bundle-dir only'
  bundle_dir=$(CDPATH= cd -- "$bundle_dir" && pwd)
  require_bundle_layout "$bundle_dir"
  artifact_name=$(read_artifact_name "$bundle_dir/provenance.txt")
  [[ -f "$bundle_dir/$artifact_name" && ! -L "$bundle_dir/$artifact_name" && -s "$bundle_dir/$artifact_name" && -x "$bundle_dir/$artifact_name" ]] \
    || fail 'bundle candidate must be a non-empty executable regular file'
  verify_args=(--verify --binary "$bundle_dir/$artifact_name" --manifest "$bundle_dir/provenance.txt")
  [[ -n "$service_dir" ]] && verify_args+=(--service-dir "$service_dir")
  "$provenance_tool" "${verify_args[@]}" >/dev/null
  printf '%s\n' 'Offline artifact bundle verified.'
fi
