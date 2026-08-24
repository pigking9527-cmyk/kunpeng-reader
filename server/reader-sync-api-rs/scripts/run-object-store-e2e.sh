#!/usr/bin/env bash
# Runs opt-in real S3/MinIO checks.  This script intentionally never prints
# endpoints, bucket names, credentials, database URLs, object keys, or data.
set -euo pipefail

confirmation='--confirm-real-object-store-e2e'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)

usage() {
  printf '%s\n' "Usage: $0 $confirmation" >&2
  printf '%s\n' 'Requires protected KUNPENG_SYNC_TEST_DATABASE_URL and KUNPENG_SYNC_OBJECT_STORE_E2E_* variables.' >&2
  exit 64
}

fail() {
  printf '%s\n' "Refusing real object-store E2E: $*" >&2
  exit 2
}

required() {
  local name=$1 value=${!1-}
  [[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "$name is not set"
}

[[ $# -eq 1 && "$1" == "$confirmation" ]] || usage
required KUNPENG_SYNC_TEST_DATABASE_URL
required KUNPENG_SYNC_OBJECT_STORE_E2E_ENDPOINT
required KUNPENG_SYNC_OBJECT_STORE_E2E_BUCKET
required KUNPENG_SYNC_OBJECT_STORE_E2E_ACCESS_KEY_ID
required KUNPENG_SYNC_OBJECT_STORE_E2E_SECRET_ACCESS_KEY

database_name=${KUNPENG_SYNC_TEST_DATABASE_URL%%\?*}
database_name=${database_name##*/}
[[ "$database_name" == reader_sync_rust_test_* && "$database_name" != */* && "$database_name" != *'@'* && "$database_name" != *':'* ]] \
  || fail 'test database name must begin with reader_sync_rust_test_'

"$script_dir/check-migrations.sh"
# The durable-outbox test intentionally disables automatic migrations so its
# S3 transition is the only behavior under test.  Apply and verify the
# explicit disposable catalog first; never assume a bucket test has prepared
# PostgreSQL as a side effect.
cargo +1.97.1 test --manifest-path "$service_dir/Cargo.toml" --test postgres_intelligence_e2e \
  intelligence_migrations_create_isolated_blob_and_delivery_schema \
  -- --exact --test-threads=1
cargo +1.97.1 test --manifest-path "$service_dir/Cargo.toml" --test object_store_e2e -- --ignored --test-threads=1
cargo +1.97.1 test --manifest-path "$service_dir/Cargo.toml" --lib \
  intelligence_object_outbox::tests::real_s3_asset_outbox_promotes_only_after_a_successful_put \
  -- --ignored --exact --test-threads=1
printf '%s\n' 'Real object-store E2E passed: PUT, Range, delete, and durable outbox promotion.'
