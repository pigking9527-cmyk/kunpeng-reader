#!/usr/bin/env bash
# Exercises refusal paths only; it never opens a PostgreSQL connection.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runner="$script_dir/run-postgres-backup-restore-rehearsal.sh"
confirmation='--confirm-destructive-postgres-backup-restore-rehearsal'
safe_tmp=$(mktemp -d)
trap 'rm -rf -- "$safe_tmp"' EXIT HUP INT TERM
fake_bin="$safe_tmp/bin"
mkdir -p "$fake_bin"

require_runner_fragment() {
  grep -F -- "$1" "$runner" >/dev/null || {
    printf 'backup/restore runner is missing required bytea integrity check: %s\n' "$1" >&2
    exit 1
  }
}

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
require_runner_fragment 'verify_restored_bytea_content'
require_runner_fragment "replace(encode(content, 'base64'), E'\n', '') FROM intelligence_assets_v1"
require_runner_fragment "replace(encode(content, 'base64'), E'\n', '') FROM intelligence_archive_jobs_v1"
require_runner_fragment 'restored image bytea SHA-256 verification'
require_runner_fragment 'restored historical-package bytea SHA-256 verification'

# Run the full content-integrity path with harmless tool shims.  This does not
# open a socket or expose a URL/content; it proves the runner hashes decoded
# bytea samples after its simulated restore instead of merely checking counts.
cat >"$fake_bin/psql" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
args=$*
asset_sha=ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
archive_sha=0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3
case "$args" in
  *rust_service_metadata*) printf '%s\n' '1|1|1|1|1|1|1|1|1|1|1|1' ;;
  *pg_catalog.pg_tables*) printf '%s\n' '0' ;;
  *"SELECT sha256 FROM intelligence_assets_v1"*) printf '%s\n' "$asset_sha" ;;
  *"SELECT job_id::text FROM intelligence_archive_jobs_v1"*) printf '%s\n' '11111111-1111-4111-8111-111111111111' ;;
  *"COPY (SELECT replace(encode(content, 'base64'), E'\\n', '') FROM intelligence_assets_v1"*) printf '%s' 'YWJj' ;;
  *"COPY (SELECT replace(encode(content, 'base64'), E'\\n', '') FROM intelligence_archive_jobs_v1"*) printf '%s' 'YXJjaGl2ZQ==' ;;
  *"SELECT encode(content_sha256, 'hex') FROM intelligence_archive_jobs_v1"*) printf '%s\n' "$archive_sha" ;;
  *) printf '%s\n' 'unexpected PostgreSQL rehearsal query' >&2; exit 1 ;;
esac
EOF
cat >"$fake_bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
while (($#)); do
  case "$1" in
    --file) printf '%s' 'synthetic dump' >"$2"; shift 2 ;;
    *) shift ;;
  esac
done
EOF
cat >"$fake_bin/pg_restore" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
chmod 700 "$fake_bin/psql" "$fake_bin/pg_dump" "$fake_bin/pg_restore"
PATH="$fake_bin:$PATH" \
  KUNPENG_SYNC_BACKUP_SOURCE_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_source' \
  KUNPENG_SYNC_BACKUP_TARGET_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_target' \
  KUNPENG_SYNC_BACKUP_REHEARSAL_DIR="$safe_tmp" \
  "$runner" "$confirmation" >/dev/null
printf '%s\n' 'PostgreSQL backup/restore rehearsal refusal checks passed.'
