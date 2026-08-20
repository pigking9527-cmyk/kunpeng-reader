-- Keep the pull response budget exact without repeatedly rendering JSONB to
-- text for every catch-up page.  The old query used this exact expression, so
-- the stored value preserves its 4 MiB page boundary and first-oversize-row
-- behavior while moving conversion work to the accepted entity write.
ALTER TABLE sync_entities_v4
    ADD COLUMN envelope_bytes bigint
    GENERATED ALWAYS AS (octet_length(envelope::text)) STORED;

-- Inventory reads are ordered by the primary-key prefix already, but their
-- metadata projection previously had to visit every heap tuple.  Include the
-- LWW and revision fields so PostgreSQL can use an index-only scan once the
-- visibility map is warm, without exposing or indexing the payload JSONB.
CREATE INDEX idx_sync_entities_v4_inventory_covering
    ON sync_entities_v4(user_id, kind, entity_id)
    INCLUDE (updated_at, deleted_at, device_id, sync_version, server_cursor);
