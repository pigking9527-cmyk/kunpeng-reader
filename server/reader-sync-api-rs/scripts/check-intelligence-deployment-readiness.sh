#!/usr/bin/env bash
# Validates deploy-time intelligence invariants without opening PostgreSQL,
# reading a deployment environment, starting a listener, or contacting a host.
# A successful result is intentionally only an offline source gate.  The
# protected PostgreSQL and recovery rehearsals listed in the companion guide
# remain mandatory before any deployment.
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
service_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
repo_root=$(git -C "$service_dir" rev-parse --show-toplevel 2>/dev/null || true)

usage() {
  printf '%s\n' "Usage: $0 --offline [--require-object-storage]" >&2
  exit 64
}

fail() {
  printf '%s\n' "intelligence deployment readiness check failed: $*" >&2
  exit 1
}

require_file() {
  [[ -s "$1" ]] || fail "required file is missing or empty: ${1#$repo_root/}"
}

require_text() {
  local path=$1 text=$2
  grep -Fq -- "$text" "$path" || fail "missing required invariant in ${path#$repo_root/}: $text"
}

[[ $# -ge 1 && $# -le 2 && "$1" == '--offline' ]] || usage
require_object_storage=0
if [[ $# -eq 2 ]]; then
  [[ "$2" == '--require-object-storage' ]] || usage
  require_object_storage=1
fi

"$script_dir/check-migrations.sh"

for migration in 0023_intelligence_capability_v1.sql 0024_intelligence_publications_v1.sql 0025_intelligence_delivery_v1.sql 0026_intelligence_archive_relay_v1.sql 0027_intelligence_retention_v1.sql 0028_intelligence_resumable_uploads_v1.sql 0029_intelligence_delivery_stream_v1.sql 0030_host_inference_relay_v1.sql 0031_intelligence_object_storage_foundation_v1.sql 0032_intelligence_object_write_outbox_v1.sql 0033_intelligence_archive_object_write_outbox_v1.sql 0034_intelligence_device_delivery_state_v1.sql 0035_intelligence_object_storage_promoted_content_nullable_v1.sql; do
  require_file "$service_dir/migrations/$migration"
done
require_file "$repo_root/contracts/intelligence/intelligence-v1.schema.json"
require_file "$repo_root/contracts/fixtures/intelligence-publication-bundle.v1.json"
require_file "$repo_root/docs/adr/0036-intelligence-distribution-v1.md"

publication_migration="$service_dir/migrations/0024_intelligence_publications_v1.sql"
asset_migration="$service_dir/migrations/0025_intelligence_delivery_v1.sql"
relay_migration="$service_dir/migrations/0026_intelligence_archive_relay_v1.sql"
upload_migration="$service_dir/migrations/0028_intelligence_resumable_uploads_v1.sql"
retention_source="$service_dir/src/intelligence_retention.rs"
intelligence_source="$service_dir/src/intelligence.rs"
archive_source="$service_dir/src/intelligence_archive.rs"
credential_source="$service_dir/src/credentials.rs"
object_store_source="$service_dir/src/intelligence_object_store.rs"
object_outbox_source="$service_dir/src/intelligence_object_outbox.rs"
object_foundation_migration="$service_dir/migrations/0031_intelligence_object_storage_foundation_v1.sql"
object_asset_outbox_migration="$service_dir/migrations/0032_intelligence_object_write_outbox_v1.sql"
object_archive_outbox_migration="$service_dir/migrations/0033_intelligence_archive_object_write_outbox_v1.sql"
device_delivery_migration="$service_dir/migrations/0034_intelligence_device_delivery_state_v1.sql"
object_storage_promotion_migration="$service_dir/migrations/0035_intelligence_object_storage_promoted_content_nullable_v1.sql"

# Publication, relay and retention schema boundaries.
require_text "$publication_migration" 'intelligence_publisher_credentials_v1'
require_text "$publication_migration" "CHECK (expires_at = published_at + 2592000000)"
require_text "$asset_migration" 'intelligence_assets_v1'
require_text "$asset_migration" 'intelligence_publication_asset_refs_v1'
require_text "$relay_migration" 'intelligence_archive_jobs_v1'
require_text "$relay_migration" "'HOST_OFFLINE'"
require_text "$upload_migration" 'intelligence_archive_uploads_v1'
require_text "$upload_migration" 'total_bytes <= 134217728'
require_text "$upload_migration" 'intelligence_asset_uploads_v1'
require_text "$upload_migration" 'total_bytes <= 26214400'
require_text "$retention_source" 'PURGING'
require_text "$retention_source" 'spawn_reclaimer'
require_text "$intelligence_source" 'expires_at>$1'
require_text "$archive_source" "state='HOST_OFFLINE'"
require_text "$device_delivery_migration" 'intelligence_device_delivery_cursors_v1'
require_text "$intelligence_source" 'persist_device_cursor'
require_text "$intelligence_source" 'ensure_active_device'
require_text "$object_storage_promotion_migration" 'ALTER COLUMN content DROP NOT NULL'

# Secrets must remain in separate publisher/relay namespaces, while the
# runtime configuration uses a non-displayable SecretString.
require_text "$credential_source" 'reader-sync/intelligence-publisher/v1'
require_text "$intelligence_source" "'intelligence:publish'"
require_text "$archive_source" "'intelligence:relay'"
require_text "$service_dir/src/config.rs" 'SecretString'

# Object storage is opt-in.  PostgreSQL bytea remains the durable staging and
# disabled-mode fallback, while enabled S3/MinIO uses a durable outbox and
# only switches metadata after a successful external PUT.
require_text "$asset_migration" 'content bytea NOT NULL'
require_text "$relay_migration" 'content bytea NULL'
require_text "$upload_migration" 'content bytea NOT NULL'
require_text "$object_foundation_migration" 'storage_backend'
require_text "$object_foundation_migration" 'intelligence_object_gc_outbox_v1'
require_text "$object_asset_outbox_migration" 'intelligence_object_write_outbox_v1'
require_text "$object_archive_outbox_migration" 'intelligence_archive_object_write_outbox_v1'
require_text "$object_store_source" 'S3IntelligenceObjectStore'
require_text "$object_store_source" 'get_range'
require_text "$object_outbox_source" 'enqueue_asset_write'
require_text "$object_outbox_source" 'enqueue_archive_write'
require_text "$archive_source" "storage_backend='s3'"
if (( require_object_storage )); then
  require_text "$object_outbox_source" 'mark_archive_write_complete'
  require_text "$archive_source" 'store.get_range'
fi

printf '%s\n' 'Offline intelligence deployment source gate passed.'
printf '%s\n' 'Storage fact: disabled mode uses PostgreSQL bytea; enabled mode stages in PostgreSQL and promotes images/archive packages through durable S3-compatible outboxes.'
printf '%s\n' 'Not deploy-ready until protected PostgreSQL migration/E2E, real object-store PUT/Range/GC/recovery, backup-restore, and worker credential revocation rehearsals pass; see docs/testing/intelligence-deployment-readiness.md.'
