#!/usr/bin/env bash
# Exercises the local Axum router's idempotency and rate-limit paths only
# against an explicitly confirmed, disposable PostgreSQL test database.
set -euo pipefail

confirmation='--confirm-destructive-postgres-load-rehearsal'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

usage() {
  printf '%s\n' "Usage: $0 $confirmation" >&2
  printf '%s\n' 'Requires KUNPENG_SYNC_TEST_DATABASE_URL for a disposable reader_sync_rust_test_* database.' >&2
  exit 64
}

fail() {
  printf '%s\n' "Refusing PostgreSQL load rehearsal: $*" >&2
  exit 2
}

[[ $# -eq 1 && "$1" == "$confirmation" ]] || usage
test_url=${KUNPENG_SYNC_TEST_DATABASE_URL-}
[[ -n "$test_url" ]] || fail 'KUNPENG_SYNC_TEST_DATABASE_URL is not set'
[[ "$test_url" != *$'\n'* && "$test_url" != *$'\r'* ]] || fail 'database URL contains a line break'

# Never echo this URL: it can contain credentials. Only a plain test database
# name after the final slash is accepted; query parameters do not affect it.
url_without_query=${test_url%%\?*}
database_name=${url_without_query##*/}
[[ "$database_name" == reader_sync_rust_test_* ]] \
  || fail 'database name must begin with reader_sync_rust_test_'
[[ "$database_name" != */* && "$database_name" != *'@'* && "$database_name" != *':'* ]] \
  || fail 'database name is not a plain test-database name'

"$script_dir/check-migrations.sh"
exec cargo +1.97.1 test --manifest-path "$service_dir/Cargo.toml" --test postgres_e2e load_rehearsal_
