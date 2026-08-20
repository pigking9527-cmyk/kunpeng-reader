-- Theme background assets are now strictly limited to 5 MiB. Existing larger
-- blobs are intentionally unsupported and removed during upgrade so they can
-- no longer consume an account's storage quota or resume an old upload.
DELETE FROM sync_assets_v4 WHERE byte_size > 5242880;

ALTER TABLE sync_assets_v4
    DROP CONSTRAINT IF EXISTS sync_assets_v4_byte_size_check;
ALTER TABLE sync_assets_v4
    ADD CONSTRAINT sync_assets_v4_byte_size_check
    CHECK (byte_size > 0 AND byte_size <= 5242880);

-- A removed palette marks its now-unreferenced image. The application waits
-- seven days before deleting it, allowing a user to restore a theme without
-- consuming quota forever. Zero means currently referenced or not yet marked.
ALTER TABLE sync_assets_v4
    ADD COLUMN IF NOT EXISTS orphaned_at bigint NOT NULL DEFAULT 0
    CHECK (orphaned_at >= 0);

CREATE INDEX IF NOT EXISTS idx_sync_assets_v4_orphan_reclaim
    ON sync_assets_v4(user_id, orphaned_at)
    WHERE orphaned_at <> 0;
