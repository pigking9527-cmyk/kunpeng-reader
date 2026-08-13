#!/usr/bin/env bash
# Self-test for the offline-only candidate bundle gate. No server or database is contacted.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
creator="$script_dir/create-artifact-provenance.sh"
stager="$script_dir/stage-artifact-bundle.sh"
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

manifest="$workspace/output/provenance"
"$creator" --service-dir "$service" --binary "$workspace/reader-sync-api" --output "$manifest" >/dev/null
bundle="$workspace/output/candidate"
"$stager" --service-dir "$service" --binary "$workspace/reader-sync-api" --manifest "$manifest" --output-dir "$bundle" >/dev/null
"$stager" --service-dir "$service" --verify --bundle-dir "$bundle" >/dev/null

printf '# drift\n' >> "$bundle/reader-sync-api"
if "$stager" --service-dir "$service" --verify --bundle-dir "$bundle" >/dev/null 2>&1; then
  printf '%s\n' 'expected altered bundle binary rejection' >&2
  exit 1
fi
rm -- "$bundle/reader-sync-api"
cp "$workspace/reader-sync-api" "$bundle/reader-sync-api"
chmod 755 "$bundle/reader-sync-api"
touch "$bundle/unexpected"
if "$stager" --service-dir "$service" --verify --bundle-dir "$bundle" >/dev/null 2>&1; then
  printf '%s\n' 'expected extra bundle file rejection' >&2
  exit 1
fi

printf '%s\n' 'Offline artifact bundle tool checks passed.'
