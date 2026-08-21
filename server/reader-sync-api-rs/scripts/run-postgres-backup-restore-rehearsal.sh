#!/usr/bin/env bash
# Rehearses a logical PostgreSQL backup and restore only against explicitly
# confirmed, disposable test databases. It never prints connection strings.
set -euo pipefail

confirmation='--confirm-destructive-postgres-backup-restore-rehearsal'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(git -C "$service_dir" rev-parse --show-toplevel 2>/dev/null || true)

usage() {
  printf '%s\n' "Usage: $0 $confirmation" >&2
  printf '%s\n' 'Requires distinct KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL and KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL values for reader_sync_rust_test_* databases.' >&2
  printf '%s\n' 'Requires KUNPENG_SYNC_BACKUP_REHEARSAL_DIR to name an existing private directory outside the repository.' >&2
  exit 64
}

fail() {
  printf '%s\n' "Refusing PostgreSQL backup/restore rehearsal: $*" >&2
  exit 2
}

database_name_from_url() {
  local url=$1 without_query name
  [[ "$url" != *$'\n'* && "$url" != *$'\r'* ]] || fail 'database URL contains a line break'
  without_query=${url%%\?*}
  name=${without_query##*/}
  [[ "$name" == reader_sync_rust_test_* ]] || fail 'database name must begin with reader_sync_rust_test_'
  [[ "$name" != */* && "$name" != *'@'* && "$name" != *':'* ]] \
    || fail 'database name is not a plain test-database name'
  printf '%s\n' "$name"
}

aggregate_snapshot() {
  local url=$1
  psql "$url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT
      (SELECT value FROM rust_service_metadata WHERE key = 'sync_protocol_version'),
      (SELECT count(*) FROM users),
      (SELECT count(*) FROM auth_sessions_v4),
      (SELECT count(*) FROM sync_entities_v4),
      (SELECT count(*) FROM sync_assets_v4),
      (SELECT count(*) FROM feedback_v4);" \
    | tr -d '[:space:]'
}

require_empty_restore_target() {
  local url=$1 table_count
  table_count=$(psql "$url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';" \
    | tr -d '[:space:]')
  [[ "$table_count" == 0 ]] || fail 'restore target must be an empty database with no public tables'
}

[[ $# -eq 1 && "$1" == "$confirmation" ]] || usage
source_url=${KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL-}
target_url=${KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL-}
scratch_root=${KUNPENG_SYNC_BACKUP_REHEARSAL_DIR-}
[[ -n "$source_url" ]] || fail 'KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL is not set'
[[ -n "$target_url" ]] || fail 'KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL is not set'
[[ -n "$scratch_root" ]] || fail 'KUNPENG_SYNC_BACKUP_REHEARSAL_DIR is not set'
source_name=$(database_name_from_url "$source_url")
target_name=$(database_name_from_url "$target_url")
[[ "$source_name" != "$target_name" ]] || fail 'source and restore target databases must differ'
[[ "$scratch_root" == /* ]] || fail 'rehearsal directory must be absolute'
[[ -d "$scratch_root" && ! -L "$scratch_root" ]] || fail 'rehearsal directory must be a real existing directory'
scratch_root=$(CDPATH= cd -- "$scratch_root" && pwd -P)
[[ -n "$repo_root" && "$scratch_root" != "$repo_root" && "$scratch_root" != "$repo_root"/* ]] \
  || fail 'rehearsal directory must be outside the repository'

for command in pg_dump pg_restore psql; do
  command -v "$command" >/dev/null 2>&1 || fail "required PostgreSQL tool is unavailable: $command"
done
"$script_dir/check-migrations.sh"

umask 077
scratch_dir=$(mktemp -d "$scratch_root/reader-sync-backup-restore.XXXXXXXX")
cleanup() { rm -rf -- "$scratch_dir"; }
trap cleanup EXIT HUP INT TERM
dump_file="$scratch_dir/reader-sync-api.backup"

source_summary=$(aggregate_snapshot "$source_url")
[[ "$source_summary" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]] \
  || fail 'source aggregate verification returned an invalid shape'
require_empty_restore_target "$target_url"
pg_dump "$source_url" --format=custom --no-owner --no-privileges --file "$dump_file"
[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] || fail 'logical backup was not created as a regular file'
pg_restore --dbname="$target_url" --clean --if-exists --no-owner --no-privileges --exit-on-error "$dump_file"
target_summary=$(aggregate_snapshot "$target_url")
[[ "$target_summary" == "$source_summary" ]] || fail 'restored aggregate verification does not match source'

IFS='|' read -r protocol users sessions entities assets history feedback <<<"$target_summary"
printf '%s\n' "PostgreSQL backup/restore rehearsal passed: protocol=$protocol users=$users sessions=$sessions entities=$entities assets=$assets history=$history feedback=$feedback"
