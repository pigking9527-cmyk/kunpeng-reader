#!/usr/bin/env bash
# Self-test for the offline artifact provenance gate. No server or database is contacted.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
creator="$script_dir/create-artifact-provenance.sh"
workspace=$(mktemp -d)
trap 'rm -rf -- "$workspace"' EXIT

service="$workspace/repository/server"
fixture="$workspace/repository/contracts/fixtures/api-v5-entity-envelope.json"
mkdir -p "$service/migrations" "$(dirname -- "$fixture")" "$workspace/output"
printf '[package]\nname = "fixture"\nversion = "0.0.0"\n' > "$service/Cargo.toml"
printf '# fixture lock\n' > "$service/Cargo.lock"
printf 'SELECT 1;\n' > "$service/migrations/0001_fixture.sql"
printf '{"entity": "fixture"}\n' > "$fixture"
printf '#!/bin/sh\nexit 0\n' > "$workspace/reader-sync-api"
chmod 755 "$workspace/reader-sync-api"

git -C "$workspace/repository" init --quiet
git -C "$workspace/repository" add server contracts/fixtures/api-v5-entity-envelope.json
git -C "$workspace/repository" -c user.name=fixture -c user.email=fixture@example.invalid commit --quiet -m fixture

manifest="$workspace/output/manifest"
"$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --output "$manifest" >/dev/null
"$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --verify --manifest "$manifest" >/dev/null
grep -Fqx 'contract_fixture=contracts/fixtures/api-v5-entity-envelope.json:'"$(shasum -a 256 "$fixture" | awk '{print $1}')" "$manifest"

printf '# modified\n' >> "$service/Cargo.lock"
if "$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --verify --manifest "$manifest" >/dev/null 2>&1; then
  printf '%s\n' 'expected modified source rejection' >&2
  exit 1
fi
git -C "$workspace/repository" checkout -- server/Cargo.lock
printf '# modified fixture\n' >> "$fixture"
if "$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --verify --manifest "$manifest" >/dev/null 2>&1; then
  printf '%s\n' 'expected modified fixture rejection' >&2
  exit 1
fi
git -C "$workspace/repository" checkout -- contracts/fixtures/api-v5-entity-envelope.json
printf '# changed binary\n' >> "$workspace/reader-sync-api"
if "$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --verify --manifest "$manifest" >/dev/null 2>&1; then
  printf '%s\n' 'expected binary digest rejection' >&2
  exit 1
fi

printf '%s\n' 'Artifact provenance tool checks passed.'
