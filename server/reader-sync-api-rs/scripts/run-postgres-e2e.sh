#!/usr/bin/env bash
# Runs destructive PostgreSQL E2E tests only against an explicitly confirmed test database.
set -euo pipefail

confirmation='--confirm-destructive-postgres-e2e'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

usage() {
  printf '%s\n' "Usage: $0 $confirmation" >&2
  printf '%s\n' 'Requires KUNPENG_SYNC_TEST_DATABASE_URL for a disposable reader_sync_rust_test_* database.' >&2
  exit 64
}

fail() {
  printf '%s\n' "Refusing PostgreSQL E2E run: $*" >&2
  exit 2
}

[[ $# -eq 1 && "$1" == "$confirmation" ]] || usage
test_url=${KUNPENG_SYNC_TEST_DATABASE_URL-}
[[ -n "$test_url" ]] || fail 'KUNPENG_SYNC_TEST_DATABASE_URL is not set'
[[ "$test_url" != *$'\n'* && "$test_url" != *$'\r'* ]] || fail 'database URL contains a line break'

# Do not print the URL: it may include credentials. PostgreSQL URLs place the
# database name after the final slash; a query string is irrelevant to the
# destructive-database-name guard.
url_without_query=${test_url%%\?*}
database_name=${url_without_query##*/}
[[ "$database_name" == reader_sync_rust_test_* ]] \
  || fail 'database name must begin with reader_sync_rust_test_'
[[ "$database_name" != */* && "$database_name" != *'@'* && "$database_name" != *':'* ]] \
  || fail 'database name is not a plain test-database name'

"$script_dir/check-migrations.sh"
# All cases use the same destructive, explicitly approved database.  Running
# them in parallel makes independent `TRUNCATE ... CASCADE` setup phases lock
# each other's tables and can turn a healthy database into a false deadlock.
exec cargo +1.97.1 test --manifest-path "$service_dir/Cargo.toml" \
  --test postgres_e2e \
  --test postgres_intelligence_e2e \
  --test postgres_intelligence_asset_upload_e2e \
  --test postgres_intelligence_archive_recovery_e2e \
  --test postgres_intelligence_route_e2e \
  --test postgres_intelligence_retention_route_e2e \
  -- --test-threads=1
