-- The external protocol gate is deliberately destructive: protocol 4 clients
-- must upgrade. Existing storage tables retain their *_v4 names because the
-- v5 gate does not change their payload or layout.
UPDATE rust_service_metadata
SET value = '5', updated_at = now()
WHERE key = 'sync_protocol_version';
