-- A multi-entity push already reaches the entity and history tables as one
-- INSERT/UPSERT.  The original ledger trigger nevertheless wrote the account
-- usage row once per affected tuple.  Use transition tables so one source SQL
-- statement produces one aggregated ledger update per account instead.
--
-- The explicit `users` existence check preserves the old cascade-delete
-- guard: deleting a user must not recreate their ledger row while dependent
-- rows are being removed.
CREATE FUNCTION update_sync_entities_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO account_storage_usage_v5(user_id,entity_bytes)
        SELECT user_id, SUM(octet_length(envelope::text))
        FROM new_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            entity_bytes=account_storage_usage_v5.entity_bytes+EXCLUDED.entity_bytes;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO account_storage_usage_v5(user_id,entity_bytes)
        SELECT user_id, SUM(delta)
        FROM (
            SELECT user_id, octet_length(envelope::text) AS delta FROM new_rows
            UNION ALL
            SELECT user_id, -octet_length(envelope::text) AS delta FROM old_rows
        ) AS deltas
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            entity_bytes=account_storage_usage_v5.entity_bytes+EXCLUDED.entity_bytes;
    ELSE
        INSERT INTO account_storage_usage_v5(user_id,entity_bytes)
        SELECT user_id, -SUM(octet_length(envelope::text))
        FROM old_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            entity_bytes=account_storage_usage_v5.entity_bytes+EXCLUDED.entity_bytes;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION update_sync_assets_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO account_storage_usage_v5(user_id,asset_bytes)
        SELECT user_id, SUM(octet_length(body))
        FROM new_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            asset_bytes=account_storage_usage_v5.asset_bytes+EXCLUDED.asset_bytes;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO account_storage_usage_v5(user_id,asset_bytes)
        SELECT user_id, SUM(delta)
        FROM (
            SELECT user_id, octet_length(body) AS delta FROM new_rows
            UNION ALL
            SELECT user_id, -octet_length(body) AS delta FROM old_rows
        ) AS deltas
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            asset_bytes=account_storage_usage_v5.asset_bytes+EXCLUDED.asset_bytes;
    ELSE
        INSERT INTO account_storage_usage_v5(user_id,asset_bytes)
        SELECT user_id, -SUM(octet_length(body))
        FROM old_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            asset_bytes=account_storage_usage_v5.asset_bytes+EXCLUDED.asset_bytes;
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION update_sync_history_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO account_storage_usage_v5(user_id,history_bytes)
        SELECT user_id, SUM(octet_length(compressed_envelope))
        FROM new_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            history_bytes=account_storage_usage_v5.history_bytes+EXCLUDED.history_bytes;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO account_storage_usage_v5(user_id,history_bytes)
        SELECT user_id, SUM(delta)
        FROM (
            SELECT user_id, octet_length(compressed_envelope) AS delta FROM new_rows
            UNION ALL
            SELECT user_id, -octet_length(compressed_envelope) AS delta FROM old_rows
        ) AS deltas
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            history_bytes=account_storage_usage_v5.history_bytes+EXCLUDED.history_bytes;
    ELSE
        INSERT INTO account_storage_usage_v5(user_id,history_bytes)
        SELECT user_id, -SUM(octet_length(compressed_envelope))
        FROM old_rows
        WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
        GROUP BY user_id
        ON CONFLICT(user_id) DO UPDATE SET
            history_bytes=account_storage_usage_v5.history_bytes+EXCLUDED.history_bytes;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER sync_entities_storage_usage_v5 ON sync_entities_v4;
DROP TRIGGER sync_assets_storage_usage_v5 ON sync_assets_v4;
DROP TRIGGER sync_history_storage_usage_v5 ON sync_entity_history_v4;

CREATE TRIGGER sync_entities_storage_usage_insert_v5
AFTER INSERT ON sync_entities_v4
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_entities_storage_usage_batch_v5();
CREATE TRIGGER sync_entities_storage_usage_update_v5
AFTER UPDATE ON sync_entities_v4
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_entities_storage_usage_batch_v5();
CREATE TRIGGER sync_entities_storage_usage_delete_v5
AFTER DELETE ON sync_entities_v4
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_entities_storage_usage_batch_v5();

CREATE TRIGGER sync_assets_storage_usage_insert_v5
AFTER INSERT ON sync_assets_v4
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_assets_storage_usage_batch_v5();
CREATE TRIGGER sync_assets_storage_usage_update_v5
AFTER UPDATE ON sync_assets_v4
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_assets_storage_usage_batch_v5();
CREATE TRIGGER sync_assets_storage_usage_delete_v5
AFTER DELETE ON sync_assets_v4
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_assets_storage_usage_batch_v5();

CREATE TRIGGER sync_history_storage_usage_insert_v5
AFTER INSERT ON sync_entity_history_v4
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_history_storage_usage_batch_v5();
CREATE TRIGGER sync_history_storage_usage_update_v5
AFTER UPDATE ON sync_entity_history_v4
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_history_storage_usage_batch_v5();
CREATE TRIGGER sync_history_storage_usage_delete_v5
AFTER DELETE ON sync_entity_history_v4
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_sync_history_storage_usage_batch_v5();

-- `MAX(recorded_at)` on every accepted push is an account-history scan.  Keep
-- the assigned server timestamp with the recovery-account metadata instead;
-- the backfill establishes the exact current high-water mark before the new
-- write path starts using it.
ALTER TABLE sync_recovery_accounts_v4
    ADD COLUMN last_recorded_at bigint NOT NULL DEFAULT 0;

UPDATE sync_recovery_accounts_v4 AS account
SET last_recorded_at=history.last_recorded_at
FROM (
    SELECT user_id, MAX(recorded_at) AS last_recorded_at
    FROM sync_entity_history_v4
    GROUP BY user_id
) AS history
WHERE history.user_id=account.user_id;
