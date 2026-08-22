-- Cloud sync history restore has been retired. Keep migrations 0010, 0015 and
-- 0017 immutable for databases that already recorded them, then remove every
-- persisted history artifact here for both upgraded and fresh databases.
DROP TABLE IF EXISTS sync_entity_history_v4;
DROP TABLE IF EXISTS sync_recovery_accounts_v4;

DROP FUNCTION IF EXISTS update_sync_history_storage_usage_batch_v5();
DROP FUNCTION IF EXISTS update_account_storage_usage_v5();

ALTER TABLE account_storage_usage_v5
    DROP COLUMN IF EXISTS history_bytes;
