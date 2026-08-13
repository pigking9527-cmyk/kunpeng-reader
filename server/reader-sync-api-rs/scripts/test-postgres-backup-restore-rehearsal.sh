#!/usr/bin/env bash
# Exercises refusal paths only; it never opens a PostgreSQL connection.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runner="$script_dir/run-postgres-backup-restore-rehearsal.sh"
confirmation='--confirm-destructive-postgres-backup-restore-rehearsal'
safe_tmp=$(mktemp -d)
trap 'rm -rf -- "$safe_tmp"' EXIT HUP INT TERM

expect_rejection() {
  if "$@" >/dev/null 2>&1; then
    printf 'expected refusal but command succeeded: %s\n' "$*" >&2
    exit 1
  fi
}

expect_rejection "$runner"
expect_rejection env KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_target' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR="$safe_tmp" "$runner" "$confirmation"
expect_rejection env KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://localhost/not_a_test_database' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_target' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR="$safe_tmp" "$runner" "$confirmation"
expect_rejection env KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_same' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_same' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR="$safe_tmp" "$runner" "$confirmation"
expect_rejection env KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_source' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_target' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR="$script_dir" "$runner" "$confirmation"
expect_rejection env KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_source' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_target' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR='/not/a/real/private/directory' "$runner" "$confirmation"
printf '%s\n' 'PostgreSQL backup/restore rehearsal refusal checks passed.'
