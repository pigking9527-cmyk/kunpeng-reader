#!/usr/bin/env bash
# Validates the migration manifest without opening a database connection.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
migrations_dir="$service_dir/migrations"

fail() {
  printf '%s\n' "migration static check failed: $*" >&2
  exit 1
}

[[ -d "$migrations_dir" ]] || fail "migrations directory is missing"

shopt -s nullglob
migrations=("$migrations_dir"/*.sql)
shopt -u nullglob
(( ${#migrations[@]} > 0 )) || fail "no SQL migration files found"

expected=1
previous_name=''
for migration in "${migrations[@]}"; do
  name=$(basename -- "$migration")
  ordinal=${name%%_*}
  expected_ordinal=$(printf '%04d' "$expected")
  [[ "$name" =~ ^[0-9]{4}_.+\.sql$ ]] || fail "invalid migration filename: $name"
  [[ "$ordinal" == "$expected_ordinal" ]] || fail "expected $expected_ordinal, found $name"
  [[ -s "$migration" ]] || fail "migration is empty: $name"
  if [[ -n "$previous_name" && "$name" < "$previous_name" ]]; then
    fail "migration ordering is not lexical: $previous_name then $name"
  fi
  previous_name=$name
  expected=$((expected + 1))
done

grep -Fq 'sqlx::migrate!("./migrations")' "$service_dir/src/lib.rs" \
  || fail "the application no longer embeds the migration directory"

cargo metadata --manifest-path "$service_dir/Cargo.toml" --locked --no-deps --format-version 1 >/dev/null
printf 'Migration static check passed for %d contiguous SQL migrations.\n' "${#migrations[@]}"
