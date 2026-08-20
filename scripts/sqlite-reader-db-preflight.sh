#!/usr/bin/env bash
#
# Runs a deliberately narrow, read-only SQLite preflight against an explicitly
# authorized, external reader.db copy.  It never prints or writes the database
# path, entity values, metadata values, SQL text, or raw query-plan text.

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_dir/.." && pwd -P)"

usage() {
  local message="${1:-}"
  if [[ -n "$message" ]]; then
    printf '错误：%s\n' "$message" >&2
  fi
  cat >&2 <<'USAGE'
用法：
  scripts/sqlite-reader-db-preflight.sh \
    --db /受控副本/reader.db \
    --output /受控记录/sqlite-reader-db-preflight.json \
    --confirm-authorized-reader-db

仅可用于你明确有权读取的、仓库外 reader.db 副本。脚本以 SQLite readonly
模式运行 PRAGMA quick_check(1)、无内容聚合与固定 EXPLAIN QUERY PLAN 探针；报告
只包含汇总数和归类后的计划结论，绝不记录路径、实体/metadata 内容、SQL 或计划原文。
输出必须是不存在的、仓库外的绝对路径。
USAGE
  exit 2
}

db_path=""
output_path=""
authorized="false"

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --db)
      [[ "$#" -ge 2 ]] || usage '--db 缺少值'
      db_path="$2"
      shift 2
      ;;
    --output)
      [[ "$#" -ge 2 ]] || usage '--output 缺少值'
      output_path="$2"
      shift 2
      ;;
    --confirm-authorized-reader-db)
      authorized="true"
      shift
      ;;
    *)
      usage "不允许参数 $1"
      ;;
  esac
done

[[ "$authorized" == "true" ]] || usage '必须显式确认你有权读取该 reader.db 副本'
[[ -n "$db_path" && -n "$output_path" ]] || usage '必须同时提供 --db 和 --output'
[[ "$db_path" = /* ]] || usage '--db 必须是绝对路径'
[[ "$output_path" = /* ]] || usage '--output 必须是绝对路径'
[[ -f "$db_path" ]] || usage '指定的数据库副本不可读取'
command -v sqlite3 >/dev/null 2>&1 || usage '未找到 sqlite3 命令行工具'

output_parent="$(dirname -- "$output_path")"
output_name="$(basename -- "$output_path")"
[[ -d "$output_parent" && "$output_name" != '.' && "$output_name" != '..' ]] || usage '--output 的父目录必须已存在'
resolved_output_parent="$(cd -- "$output_parent" && pwd -P)"
resolved_output="$resolved_output_parent/$output_name"
case "$resolved_output" in
  "$repository_root"|"$repository_root"/*) usage '--output 必须位于仓库外，避免提交任何预检记录' ;;
esac
[[ ! -e "$resolved_output" ]] || usage '--output 已存在；预检不会覆盖记录'

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kunpeng-reader-db-preflight.XXXXXX")"
trap 'rm -rf -- "$temporary_directory"' EXIT
raw_result="$temporary_directory/result"
raw_error="$temporary_directory/error"

# `-readonly` prevents writes at open time.  `query_only` is an independent
# SQLite guard so the fixed script remains safe if a later probe is changed.
if ! sqlite3 -readonly -batch -noheader -separator '|' "$db_path" >"$raw_result" 2>"$raw_error" <<'SQL'
PRAGMA query_only = ON;
SELECT 'integrity' || '|' || CASE WHEN (SELECT * FROM pragma_quick_check LIMIT 1) = 'ok' THEN 'ok' ELSE 'failed' END;
SELECT 'page_count' || '|' || page_count FROM pragma_page_count;
SELECT 'page_size' || '|' || page_size FROM pragma_page_size;
SELECT 'freelist_pages' || '|' || freelist_count FROM pragma_freelist_count;
SELECT 'metadata_rows' || '|' || COUNT(*) FROM metadata;
SELECT 'entity_rows' || '|' || COUNT(*) FROM entities;
SELECT 'active_entity_rows' || '|' || COUNT(*) FROM entities WHERE deleted_at = 0;
SELECT 'deleted_entity_rows' || '|' || COUNT(*) FROM entities WHERE deleted_at <> 0;
SELECT 'entity_kind_count' || '|' || COUNT(*) FROM (SELECT kind FROM entities GROUP BY kind);
SELECT 'ack_rows' || '|' || COUNT(*) FROM sync_acknowledgements;
EXPLAIN QUERY PLAN
SELECT id, updated_at, sync_version
FROM entities
WHERE kind = ?1 AND deleted_at = 0
ORDER BY updated_at DESC
LIMIT 50;
SQL
then
  printf '预检失败：SQLite 未能以只读模式执行固定检查；未输出任何数据库内容。\n' >&2
  exit 1
fi

lookup_value() {
  local key="$1"
  awk -F'|' -v key="$key" '$1 == key { print $2; exit }' "$raw_result"
}

for required_key in integrity page_count page_size freelist_pages metadata_rows entity_rows active_entity_rows deleted_entity_rows entity_kind_count ack_rows; do
  value="$(lookup_value "$required_key")"
  [[ "$value" =~ ^(ok|failed|[0-9]+)$ ]] || {
    printf '预检失败：数据库不符合预期的 reader.db 表结构；未输出任何数据库内容。\n' >&2
    exit 1
  }
done

integrity="$(lookup_value integrity)"
[[ "$integrity" == 'ok' ]] || {
  printf '预检失败：quick_check 未通过；未生成报告。\n' >&2
  exit 1
}

# EXPLAIN is intentionally classified locally.  Neither its raw rows nor SQL
# text are persisted; names here only describe the fixed known index invariant.
if grep -Eq 'USING (COVERING )?INDEX idx_entities_kind_updated' "$raw_result"; then
  uses_kind_updated_index=true
else
  uses_kind_updated_index=false
fi
if grep -Eq '(^|[^[:alnum:]_])SCAN[[:space:]]+entities([^[:alnum:]_]|$)' "$raw_result"; then
  full_entity_scan=true
else
  full_entity_scan=false
fi
if grep -Eq 'USE TEMP B-TREE' "$raw_result"; then
  temporary_sort=true
else
  temporary_sort=false
fi

recorded_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
umask 077
set -o noclobber
{
  printf '{\n'
  printf '  "schemaVersion": 1,\n'
  printf '  "recordedAt": "%s",\n' "$recorded_at"
  printf '  "purpose": "authorized-reader-db-readonly-preflight",\n'
  printf '  "integrity": { "quickCheck": "ok" },\n'
  printf '  "aggregates": {\n'
  printf '    "pageCount": %s,\n' "$(lookup_value page_count)"
  printf '    "pageSizeBytes": %s,\n' "$(lookup_value page_size)"
  printf '    "freelistPages": %s,\n' "$(lookup_value freelist_pages)"
  printf '    "metadataRows": %s,\n' "$(lookup_value metadata_rows)"
  printf '    "entityRows": %s,\n' "$(lookup_value entity_rows)"
  printf '    "activeEntityRows": %s,\n' "$(lookup_value active_entity_rows)"
  printf '    "deletedEntityRows": %s,\n' "$(lookup_value deleted_entity_rows)"
  printf '    "entityKindCount": %s,\n' "$(lookup_value entity_kind_count)"
  printf '    "acknowledgementRows": %s\n' "$(lookup_value ack_rows)"
  printf '  },\n'
  printf '  "queryPlan": {\n'
  printf '    "entitiesKindUpdatedLatest": {\n'
  printf '      "usesExpectedKindUpdatedIndex": %s,\n' "$uses_kind_updated_index"
  printf '      "hasFullEntitiesScan": %s,\n' "$full_entity_scan"
  printf '      "hasTemporarySort": %s\n' "$temporary_sort"
  printf '    }\n'
  printf '  },\n'
  printf '  "privacy": {\n'
  printf '    "databasePathRecorded": false,\n'
  printf '    "metadataValuesRecorded": false,\n'
  printf '    "entityValuesRecorded": false,\n'
  printf '    "sqlRecorded": false,\n'
  printf '    "queryPlanTextRecorded": false\n'
  printf '  }\n'
  printf '}\n'
} >"$resolved_output"

printf '已写入仓库外的 SQLite 只读预检汇总记录。\n'
