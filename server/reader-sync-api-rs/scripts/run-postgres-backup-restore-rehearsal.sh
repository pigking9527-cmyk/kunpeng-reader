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
  printf '%s\n' 'KUNPENG_SYNC_BACKUP_RESTORE_ADMIN_DATABASE_URL is optional and is used only by pg_restore when extensions require an administrator.' >&2
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
      (SELECT count(*) FROM feedback_v4),
      (SELECT count(*) FROM intelligence_publications_v1),
      (SELECT count(*) FROM intelligence_assets_v1),
      (SELECT count(*) FROM intelligence_archive_jobs_v1),
      (SELECT count(*) FROM intelligence_archive_uploads_v1),
      (SELECT count(*) FROM intelligence_asset_uploads_v1),
      (SELECT count(*) FROM intelligence_delivery_events_v1);" \
    | tr -d '[:space:]'
}

require_empty_restore_target() {
  local url=$1 table_count
  table_count=$(psql "$url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';" \
    | tr -d '[:space:]')
  [[ "$table_count" == 0 ]] || fail 'restore target must be an empty database with no public tables'
}

sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  else
    fail 'required SHA-256 tool is unavailable: sha256sum or shasum'
  fi
}

base64_decode() {
  if base64 --decode </dev/null >/dev/null 2>&1; then
    base64 --decode
  elif base64 -D </dev/null >/dev/null 2>&1; then
    base64 -D
  else
    fail 'base64 decoder does not support --decode or -D'
  fi
}

content_hash() {
  local url=$1 query=$2 encoded
  # PostgreSQL's base64 encoder may wrap long values.  The stream is decoded
  # before hashing, so this is a digest of the actual bytea content, not a
  # digest of its textual representation.  No content reaches stdout.
  encoded=$(psql "$url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "COPY ($query) TO STDOUT WITH (FORMAT text)" | tr -d '\r\n')
  [[ -n "$encoded" ]] || fail 'required rehearsal content is missing'
  printf '%s' "$encoded" | base64_decode | sha256_stream
}

require_hex_sha256() {
  [[ "$1" =~ ^[a-f0-9]{64}$ ]] || fail 'content SHA-256 verification returned an invalid shape'
}

require_uuid() {
  [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
    || fail 'historical package verification returned an invalid identifier'
}

verify_restored_bytea_content() {
  local source_url=$1 target_url=$2 asset_sha archive_job_id source_asset_hash target_asset_hash
  local source_archive_hash target_archive_hash source_archive_declared target_archive_declared
  # Keep samples small: the aim is integrity coverage, not a second capacity
  # test.  Their identifiers are constrained before they are interpolated into
  # SQL, and neither identifiers, contents nor digests are printed.
  asset_sha=$(psql "$source_url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT sha256 FROM intelligence_assets_v1 WHERE octet_length(content) BETWEEN 1 AND 1048576 ORDER BY sha256 LIMIT 1;" \
    | tr -d '[:space:]')
  require_hex_sha256 "$asset_sha"
  archive_job_id=$(psql "$source_url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT job_id::text FROM intelligence_archive_jobs_v1 WHERE content IS NOT NULL AND content_sha256 IS NOT NULL AND octet_length(content) BETWEEN 1 AND 1048576 ORDER BY job_id LIMIT 1;" \
    | tr -d '[:space:]')
  require_uuid "$archive_job_id"

  source_asset_hash=$(content_hash "$source_url" "SELECT replace(encode(content, 'base64'), E'\n', '') FROM intelligence_assets_v1 WHERE sha256 = '$asset_sha'")
  target_asset_hash=$(content_hash "$target_url" "SELECT replace(encode(content, 'base64'), E'\n', '') FROM intelligence_assets_v1 WHERE sha256 = '$asset_sha'")
  require_hex_sha256 "$source_asset_hash"
  require_hex_sha256 "$target_asset_hash"
  [[ "$source_asset_hash" == "$asset_sha" && "$target_asset_hash" == "$asset_sha" ]] \
    || fail 'restored image bytea SHA-256 verification does not match source content'

  source_archive_hash=$(content_hash "$source_url" "SELECT replace(encode(content, 'base64'), E'\n', '') FROM intelligence_archive_jobs_v1 WHERE job_id = '$archive_job_id'::uuid")
  target_archive_hash=$(content_hash "$target_url" "SELECT replace(encode(content, 'base64'), E'\n', '') FROM intelligence_archive_jobs_v1 WHERE job_id = '$archive_job_id'::uuid")
  source_archive_declared=$(psql "$source_url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT encode(content_sha256, 'hex') FROM intelligence_archive_jobs_v1 WHERE job_id = '$archive_job_id'::uuid;" \
    | tr -d '[:space:]')
  target_archive_declared=$(psql "$target_url" --no-psqlrc --tuples-only --no-align --quiet --set ON_ERROR_STOP=1 \
    --command "SELECT encode(content_sha256, 'hex') FROM intelligence_archive_jobs_v1 WHERE job_id = '$archive_job_id'::uuid;" \
    | tr -d '[:space:]')
  require_hex_sha256 "$source_archive_hash"
  require_hex_sha256 "$target_archive_hash"
  require_hex_sha256 "$source_archive_declared"
  require_hex_sha256 "$target_archive_declared"
  [[ "$source_archive_hash" == "$source_archive_declared" && "$target_archive_hash" == "$target_archive_declared" && "$source_archive_hash" == "$target_archive_hash" ]] \
    || fail 'restored historical-package bytea SHA-256 verification does not match source content'
}

[[ $# -eq 1 && "$1" == "$confirmation" ]] || usage
source_url=${KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL-}
target_url=${KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL-}
restore_admin_url=${KUNPENG_SYNC_BACKUP_RESTORE_ADMIN_DATABASE_URL-}
scratch_root=${KUNPENG_SYNC_BACKUP_REHEARSAL_DIR-}
[[ -n "$source_url" ]] || fail 'KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL is not set'
[[ -n "$target_url" ]] || fail 'KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL is not set'
[[ -n "$scratch_root" ]] || fail 'KUNPENG_SYNC_BACKUP_REHEARSAL_DIR is not set'
source_name=$(database_name_from_url "$source_url")
target_name=$(database_name_from_url "$target_url")
if [[ -n "$restore_admin_url" ]]; then
  restore_name=$(database_name_from_url "$restore_admin_url")
  [[ "$restore_name" == "$target_name" ]] || fail 'restore administrator URL must target the same test database'
else
  restore_admin_url=$target_url
fi
[[ "$source_name" != "$target_name" ]] || fail 'source and restore target databases must differ'
[[ "$scratch_root" == /* ]] || fail 'rehearsal directory must be absolute'
[[ -d "$scratch_root" && ! -L "$scratch_root" ]] || fail 'rehearsal directory must be a real existing directory'
scratch_root=$(CDPATH= cd -- "$scratch_root" && pwd -P)
[[ -z "$repo_root" || ( "$scratch_root" != "$repo_root" && "$scratch_root" != "$repo_root"/* ) ]] \
  || fail 'rehearsal directory must be outside the repository'

for command in pg_dump pg_restore psql base64; do
  command -v "$command" >/dev/null 2>&1 || fail "required PostgreSQL tool is unavailable: $command"
done
"$script_dir/check-migrations.sh"

umask 077
scratch_dir=$(mktemp -d "$scratch_root/reader-sync-backup-restore.XXXXXXXX")
cleanup() { rm -rf -- "$scratch_dir"; }
trap cleanup EXIT HUP INT TERM
dump_file="$scratch_dir/reader-sync-api.backup"

source_summary=$(aggregate_snapshot "$source_url")
[[ "$source_summary" =~ ^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$ ]] \
  || fail 'source aggregate verification returned an invalid shape'
require_empty_restore_target "$target_url"
pg_dump "$source_url" --format=custom --no-owner --no-privileges --file "$dump_file"
[[ -f "$dump_file" && ! -L "$dump_file" && -s "$dump_file" ]] || fail 'logical backup was not created as a regular file'
pg_restore --dbname="$restore_admin_url" --clean --if-exists --no-owner --no-privileges --exit-on-error "$dump_file"
target_summary=$(aggregate_snapshot "$target_url")
[[ "$target_summary" == "$source_summary" ]] || fail 'restored aggregate verification does not match source'
verify_restored_bytea_content "$source_url" "$target_url"

IFS='|' read -r protocol users sessions entities assets feedback intelligence_publications intelligence_assets intelligence_archive_jobs intelligence_archive_uploads intelligence_asset_uploads intelligence_delivery_events <<<"$target_summary"
printf '%s\n' "PostgreSQL backup/restore rehearsal passed: protocol=$protocol users=$users sessions=$sessions entities=$entities assets=$assets feedback=$feedback intelligence_publications=$intelligence_publications intelligence_assets=$intelligence_assets intelligence_archive_jobs=$intelligence_archive_jobs intelligence_archive_uploads=$intelligence_archive_uploads intelligence_asset_uploads=$intelligence_asset_uploads intelligence_delivery_events=$intelligence_delivery_events"
