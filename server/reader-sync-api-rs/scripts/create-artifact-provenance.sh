#!/usr/bin/env bash
# Creates or verifies an offline, secret-free provenance manifest for a Linux release binary.
# It deliberately refuses untracked or modified service sources: a Git commit alone would not
# describe such a binary well enough to approve an upload.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
default_service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

usage() {
  cat <<'USAGE'
Usage:
  create-artifact-provenance.sh --binary PATH --output PATH [--service-dir PATH]
  create-artifact-provenance.sh --verify --binary PATH --manifest PATH [--service-dir PATH]

Creates or verifies a local, line-oriented manifest containing only the source commit/tree,
Cargo.lock, migration and binary SHA-256 digests. It never opens a network connection, reads
deployment configuration or prints the supplied paths. The service source must be fully tracked
and clean relative to HEAD; this prevents a manifest from falsely attributing an uncommitted
binary to an older commit.
USAGE
}

fail() {
  printf '%s\n' "artifact provenance check failed: $*" >&2
  exit 1
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -- "$1" | awk '{print $1}'
  else
    fail 'neither shasum nor sha256sum is available'
  fi
}

mode=create
binary=''
output=''
manifest=''
service_dir="$default_service_dir"
while (( $# > 0 )); do
  case "$1" in
    --binary)
      (( $# >= 2 )) || fail '--binary requires a path'
      binary=$2
      shift 2
      ;;
    --output)
      (( $# >= 2 )) || fail '--output requires a path'
      output=$2
      shift 2
      ;;
    --manifest)
      (( $# >= 2 )) || fail '--manifest requires a path'
      manifest=$2
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
    *) fail "unknown argument" ;;
  esac
done

[[ -n "$binary" ]] || fail '--binary is required'
[[ -f "$binary" && -s "$binary" && -x "$binary" ]] || fail 'binary must be a non-empty executable file'
binary_name=$(basename -- "$binary")
[[ "$binary_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || fail 'binary filename contains unsupported characters'

if [[ "$mode" == create ]]; then
  [[ -n "$output" && -z "$manifest" ]] || fail 'create requires --output and does not accept --manifest'
  [[ ! -e "$output" ]] || fail 'output already exists; use a new manifest path'
else
  [[ -n "$manifest" && -z "$output" ]] || fail 'verify requires --manifest and does not accept --output'
  [[ -f "$manifest" ]] || fail 'manifest is not a regular file'
fi

service_dir=$(CDPATH= cd -- "$service_dir" && pwd)
[[ -f "$service_dir/Cargo.toml" && -f "$service_dir/Cargo.lock" ]] || fail 'service directory is missing Cargo.toml or Cargo.lock'
repo_root=$(git -C "$service_dir" rev-parse --show-toplevel 2>/dev/null) || fail 'service directory is not inside a Git worktree'
repo_root=$(CDPATH= cd -- "$repo_root" && pwd)
service_relative=$(git -C "$service_dir" rev-parse --show-prefix 2>/dev/null) || fail 'cannot resolve service directory inside its Git worktree'
service_relative=${service_relative%/}
[[ -n "$service_relative" ]] || fail 'refusing to use the repository root as a service directory'

# A release manifest may identify a commit only if every source input is actually represented
# by it. Check both tracked modifications and untracked service files, including migrations.
git -C "$repo_root" ls-files --error-unmatch -- "$service_relative/Cargo.toml" "$service_relative/Cargo.lock" >/dev/null 2>&1 \
  || fail 'service manifest inputs are not tracked by Git; commit the service source before release'
git -C "$repo_root" diff --quiet HEAD -- "$service_relative" \
  || fail 'service source has unstaged changes; commit or revert them before release'
git -C "$repo_root" diff --cached --quiet HEAD -- "$service_relative" \
  || fail 'service source has staged but uncommitted changes; commit them before release'
if [[ -n $(git -C "$repo_root" ls-files --others --exclude-standard -- "$service_relative") ]]; then
  fail 'service source has untracked files; commit or remove them before release'
fi

migrations_dir="$service_dir/migrations"
[[ -d "$migrations_dir" ]] || fail 'migrations directory is missing'
mapfile_supported=false
if [[ ${BASH_VERSINFO[0]} -ge 4 ]]; then
  mapfile_supported=true
fi
if [[ "$mapfile_supported" == true ]]; then
  mapfile -t migrations < <(LC_ALL=C find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
else
  migrations=()
  while IFS= read -r migration; do migrations+=("$migration"); done < <(LC_ALL=C find "$migrations_dir" -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort)
fi
(( ${#migrations[@]} > 0 )) || fail 'no SQL migration files found'

expected_ordinal=1
for migration in "${migrations[@]}"; do
  migration_name=$(basename -- "$migration")
  expected_name=$(printf '%04d' "$expected_ordinal")
  [[ "$migration_name" =~ ^[0-9]{4}_[A-Za-z0-9._-]+\.sql$ ]] || fail 'migration filename is invalid'
  [[ ${migration_name%%_*} == "$expected_name" ]] || fail 'migration sequence is not contiguous'
  git -C "$repo_root" ls-files --error-unmatch -- "$service_relative/migrations/$migration_name" >/dev/null 2>&1 \
    || fail 'a migration is not tracked by Git'
  expected_ordinal=$((expected_ordinal + 1))
done

source_commit=$(git -C "$repo_root" rev-parse HEAD)
source_tree=$(git -C "$repo_root" rev-parse "HEAD:$service_relative")
cargo_lock_sha256=$(sha256_file "$service_dir/Cargo.lock")
binary_sha256=$(sha256_file "$binary")

emit_manifest() {
  printf '%s\n' 'schema=kunpeng-reader-sync-api-artifact-provenance-v1'
  printf 'artifact_name=%s\n' "$binary_name"
  printf 'source_commit=%s\n' "$source_commit"
  printf 'source_tree=%s\n' "$source_tree"
  printf 'cargo_lock_sha256=%s\n' "$cargo_lock_sha256"
  printf 'migration_count=%s\n' "${#migrations[@]}"
  for migration in "${migrations[@]}"; do
    printf 'migration=%s:%s\n' "$(basename -- "$migration")" "$(sha256_file "$migration")"
  done
  printf 'binary_sha256=%s\n' "$binary_sha256"
}

if [[ "$mode" == create ]]; then
  output_dir=$(CDPATH= cd -- "$(dirname -- "$output")" && pwd)
  umask 077
  temporary=$(mktemp "$output_dir/.reader-sync-api-provenance.XXXXXX")
  trap 'rm -f -- "$temporary"' EXIT
  emit_manifest > "$temporary"
  mv -- "$temporary" "$output"
  trap - EXIT
  printf '%s\n' 'Artifact provenance manifest created.'
else
  expected=$(mktemp)
  trap 'rm -f -- "$expected"' EXIT
  emit_manifest > "$expected"
  cmp -s -- "$expected" "$manifest" || fail 'manifest does not match this committed source tree, migrations, Cargo.lock and binary'
  printf '%s\n' 'Artifact provenance manifest verified.'
fi
