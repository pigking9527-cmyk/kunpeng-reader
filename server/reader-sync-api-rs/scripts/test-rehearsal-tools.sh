#!/usr/bin/env bash
# Exercises only refusal paths; it never opens a PostgreSQL connection.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runner="$script_dir/run-postgres-e2e.sh"
load_runner="$script_dir/run-postgres-load-rehearsal.sh"
config_checker="$script_dir/check-deployment-config.sh"
artifact_provenance_checker="$script_dir/test-artifact-provenance.sh"
artifact_bundle_checker="$script_dir/test-artifact-bundle.sh"
backup_restore_checker="$script_dir/test-postgres-backup-restore-rehearsal.sh"
capacity_runner_checker="$script_dir/test-run-capacity-test.sh"

expect_rejection() {
  if "$@" >/dev/null 2>&1; then
    printf 'expected refusal but command succeeded: %s\n' "$*" >&2
    exit 1
  fi
}

expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='' "$runner" --confirm-destructive-postgres-e2e
expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://localhost/not_a_test_database' "$runner" --confirm-destructive-postgres-e2e
expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_isolated' "$runner"
expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='' "$load_runner" --confirm-destructive-postgres-load-rehearsal
expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://localhost/not_a_test_database' "$load_runner" --confirm-destructive-postgres-load-rehearsal
expect_rejection env KUNPENG_SYNC_TEST_DATABASE_URL='postgresql://localhost/reader_sync_rust_test_isolated' "$load_runner"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='too-short' "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_BIND='0.0.0.0:8788' "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_DATABASE_MAX_CONNECTIONS=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_DATABASE_ACQUIRE_TIMEOUT_MILLIS=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_MAX_CONCURRENT_REQUESTS=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_MAX_CONCURRENT_PASSWORD_OPERATIONS=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_REQUEST_TIMEOUT_SECONDS=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_BODY_LIMIT_BYTES=0 "$config_checker"
expect_rejection env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' KUNPENG_SYNC_SMTP_HOST='smtp.invalid' KUNPENG_SYNC_SMTP_FROM='noreply@example.invalid' KUNPENG_SYNC_SMTP_PORT=0 "$config_checker"
env KUNPENG_SYNC_DATABASE_URL='postgresql://offline.invalid/reader_sync_rust_test_config' KUNPENG_SYNC_TOKEN_HMAC_KEY='test-only-key-with-at-least-32-bytes' "$config_checker" >/dev/null
"$script_dir/check-migrations.sh"
"$artifact_provenance_checker"
"$artifact_bundle_checker"
"$backup_restore_checker"
"$capacity_runner_checker"
printf '%s\n' 'PostgreSQL rehearsal tool refusal checks passed.'
