#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/.." && pwd -P)"

if ! command -v sqlite3 >/dev/null 2>&1; then
  printf 'sqlite3 不可用，跳过 SQLite 只读预检脚本自检。\n'
  exit 0
fi

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kunpeng-reader-db-preflight-test.XXXXXX")"
trap 'rm -rf -- "$temporary_directory"' EXIT
db_path="$temporary_directory/reader.db"
output_path="$temporary_directory/preflight.json"

sqlite3 "$db_path" <<'SQL'
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  sync_version INTEGER NOT NULL
);
CREATE INDEX idx_entities_kind_updated ON entities(kind, updated_at);
CREATE TABLE sync_acknowledgements (id TEXT PRIMARY KEY);
INSERT INTO metadata VALUES ('private-key', 'private-value');
INSERT INTO entities VALUES ('private-id', 'book_state_v2', '{"private":"value"}', 11, 0, 1);
INSERT INTO sync_acknowledgements VALUES ('private-ack');
SQL

[[ ! -e "$db_path-wal" && ! -e "$db_path-shm" ]] || {
  printf '预检自测准备失败：临时数据库意外保留 WAL 或 SHM sidecar。\n' >&2
  exit 1
}
database_sha256_before="$(shasum -a 256 "$db_path" | awk '{print $1}')"

"$script_dir/sqlite-reader-db-preflight.sh" \
  --db "$db_path" \
  --output "$output_path" \
  --confirm-authorized-reader-db

node --input-type=module - "$output_path" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const record = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(record.schemaVersion, 1);
assert.equal(record.integrity.quickCheck, "ok");
assert.equal(record.aggregates.entityRows, 1);
assert.equal(record.aggregates.metadataRows, 1);
assert.equal(record.aggregates.acknowledgementRows, 1);
assert.equal(record.queryPlan.entitiesKindUpdatedLatest.usesExpectedKindUpdatedIndex, true);
assert.equal(record.privacy.databasePathRecorded, false);
assert.equal(record.privacy.entityValuesRecorded, false);
const serialized = JSON.stringify(record);
for (const forbidden of ["private-id", "private-value", "private-key", "private-ack", "SELECT", "EXPLAIN"]) {
  assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`);
}
NODE

if "$script_dir/sqlite-reader-db-preflight.sh" --db "$db_path" --output "$temporary_directory/rejected.json" >/dev/null 2>&1; then
  printf '预期拒绝未确认授权的调用，但脚本成功了。\n' >&2
  exit 1
fi

if "$script_dir/sqlite-reader-db-preflight.sh" \
  --db "$db_path" \
  --output "$repository_root/docs/testing/forbidden-preflight.json" \
  --confirm-authorized-reader-db >/dev/null 2>&1; then
  printf '预期拒绝仓库内输出，但脚本成功了。\n' >&2
  exit 1
fi

[[ "$(sqlite3 -readonly "$db_path" 'SELECT COUNT(*) FROM entities;')" == "1" ]]
database_sha256_after="$(shasum -a 256 "$db_path" | awk '{print $1}')"
[[ "$database_sha256_before" == "$database_sha256_after" ]] || {
  printf 'SQLite 只读预检意外修改了临时数据库。\n' >&2
  exit 1
}
[[ ! -e "$db_path-wal" && ! -e "$db_path-shm" ]] || {
  printf 'SQLite 只读预检意外创建了 WAL 或 SHM sidecar。\n' >&2
  exit 1
}
printf 'SQLite reader.db 只读预检脚本自检通过。\n'
