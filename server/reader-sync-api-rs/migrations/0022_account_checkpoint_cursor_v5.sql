-- Checkpoint requests only need the account generation and the latest entity
-- cursor. Persist that high-water mark on the account row so the hot endpoint
-- is a single primary-key lookup instead of probing the entity index.
ALTER TABLE account_data_generations
    ADD COLUMN server_cursor bigint NOT NULL DEFAULT 0 CHECK (server_cursor >= 0);

-- Every entity mutation maintains the account high-water mark in the same
-- transaction. Statement-level transition tables keep a multi-entity push to
-- one account-row update instead of one update per entity.
CREATE FUNCTION update_account_checkpoint_cursor_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        UPDATE account_data_generations AS account
        SET server_cursor=remaining.server_cursor
        FROM (
            SELECT affected.user_id,COALESCE(MAX(entity.server_cursor),0) AS server_cursor
            FROM (SELECT DISTINCT user_id FROM old_rows) AS affected
            LEFT JOIN sync_entities_v4 AS entity ON entity.user_id=affected.user_id
            GROUP BY affected.user_id
        ) AS remaining
        WHERE account.user_id=remaining.user_id
          AND account.server_cursor<>remaining.server_cursor;
    ELSIF TG_OP = 'UPDATE' THEN
        -- INSERT ... ON CONFLICT DO UPDATE runs the statement-level UPDATE
        -- trigger before the INSERT trigger. At this point every row change
        -- from the UPSERT is visible, so reading the indexed account maximum
        -- makes a mixed insert/update batch advance the account row once. The
        -- later INSERT trigger sees the same-or-lower cursor and is a no-op.
        UPDATE account_data_generations AS account
        SET server_cursor=changed.server_cursor
        FROM (
            SELECT affected.user_id,latest.server_cursor
            FROM (SELECT DISTINCT user_id FROM new_rows) AS affected
            CROSS JOIN LATERAL (
                SELECT entity.server_cursor
                FROM sync_entities_v4 AS entity
                WHERE entity.user_id=affected.user_id
                ORDER BY entity.server_cursor DESC
                LIMIT 1
            ) AS latest
        ) AS changed
        WHERE account.user_id=changed.user_id
          AND account.server_cursor<changed.server_cursor;
    ELSE
        UPDATE account_data_generations AS account
        SET server_cursor=GREATEST(account.server_cursor,changed.server_cursor)
        FROM (
            SELECT user_id,MAX(server_cursor) AS server_cursor
            FROM new_rows
            GROUP BY user_id
        ) AS changed
        WHERE account.user_id=changed.user_id
          AND account.server_cursor<changed.server_cursor;
    END IF;
    RETURN NULL;
END;
$$;

CREATE TRIGGER sync_entities_checkpoint_cursor_insert_v5
AFTER INSERT ON sync_entities_v4
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_account_checkpoint_cursor_v5();

CREATE TRIGGER sync_entities_checkpoint_cursor_update_v5
AFTER UPDATE ON sync_entities_v4
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_account_checkpoint_cursor_v5();

CREATE TRIGGER sync_entities_checkpoint_cursor_delete_v5
AFTER DELETE ON sync_entities_v4
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION update_account_checkpoint_cursor_v5();

-- Run the backfill after trigger installation. Concurrent writes that commit
-- before trigger creation are visible here; later writes maintain the column
-- themselves. GREATEST prevents the backfill from lowering a newer value.
UPDATE account_data_generations AS account
SET server_cursor=GREATEST(account.server_cursor,existing.server_cursor)
FROM (
    SELECT user_id,MAX(server_cursor) AS server_cursor
    FROM sync_entities_v4
    GROUP BY user_id
) AS existing
WHERE account.user_id=existing.user_id;
