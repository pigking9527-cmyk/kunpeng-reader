-- A PostgreSQL INSERT checks row constraints before resolving ON CONFLICT.
-- Consequently a statement-level delete/update delta cannot be inserted as a
-- negative provisional ledger row, even when an existing account row would
-- become exactly zero after the conflict update.  Keep the counter exact by
-- inserting only non-negative placeholders and applying the true signed delta
-- in the conflict branch.  New negative rows remain impossible by design.
CREATE FUNCTION apply_account_storage_usage_delta_v5(
    p_user_id text,
    p_entity_delta bigint,
    p_asset_delta bigint,
    p_history_delta bigint
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO account_storage_usage_v5(user_id,entity_bytes,asset_bytes,history_bytes)
    VALUES (
        p_user_id,
        GREATEST(p_entity_delta, 0),
        GREATEST(p_asset_delta, 0),
        GREATEST(p_history_delta, 0)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        entity_bytes=account_storage_usage_v5.entity_bytes+p_entity_delta,
        asset_bytes=account_storage_usage_v5.asset_bytes+p_asset_delta,
        history_bytes=account_storage_usage_v5.history_bytes+p_history_delta;
END;
$$;

CREATE OR REPLACE FUNCTION update_sync_entities_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR item IN
            SELECT user_id, SUM(octet_length(envelope::text)) AS bytes
            FROM new_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,item.bytes,0,0);
        END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
        FOR item IN
            SELECT user_id, SUM(delta) AS bytes
            FROM (
                SELECT user_id, octet_length(envelope::text) AS delta FROM new_rows
                UNION ALL
                SELECT user_id, -octet_length(envelope::text) AS delta FROM old_rows
            ) AS deltas
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,item.bytes,0,0);
        END LOOP;
    ELSE
        FOR item IN
            SELECT user_id, -SUM(octet_length(envelope::text)) AS bytes
            FROM old_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,item.bytes,0,0);
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION update_sync_assets_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR item IN
            SELECT user_id, SUM(octet_length(body)) AS bytes
            FROM new_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,item.bytes,0);
        END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
        FOR item IN
            SELECT user_id, SUM(delta) AS bytes
            FROM (
                SELECT user_id, octet_length(body) AS delta FROM new_rows
                UNION ALL
                SELECT user_id, -octet_length(body) AS delta FROM old_rows
            ) AS deltas
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,item.bytes,0);
        END LOOP;
    ELSE
        FOR item IN
            SELECT user_id, -SUM(octet_length(body)) AS bytes
            FROM old_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,item.bytes,0);
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION update_sync_history_storage_usage_batch_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    item record;
BEGIN
    IF TG_OP = 'INSERT' THEN
        FOR item IN
            SELECT user_id, SUM(octet_length(compressed_envelope)) AS bytes
            FROM new_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=new_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,0,item.bytes);
        END LOOP;
    ELSIF TG_OP = 'UPDATE' THEN
        FOR item IN
            SELECT user_id, SUM(delta) AS bytes
            FROM (
                SELECT user_id, octet_length(compressed_envelope) AS delta FROM new_rows
                UNION ALL
                SELECT user_id, -octet_length(compressed_envelope) AS delta FROM old_rows
            ) AS deltas
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=deltas.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,0,item.bytes);
        END LOOP;
    ELSE
        FOR item IN
            SELECT user_id, -SUM(octet_length(compressed_envelope)) AS bytes
            FROM old_rows
            WHERE EXISTS (SELECT 1 FROM users WHERE users.id=old_rows.user_id)
            GROUP BY user_id
        LOOP
            PERFORM apply_account_storage_usage_delta_v5(item.user_id,0,0,item.bytes);
        END LOOP;
    END IF;
    RETURN NULL;
END;
$$;
