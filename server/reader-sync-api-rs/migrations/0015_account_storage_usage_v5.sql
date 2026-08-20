-- Keep exact per-account storage totals as transactional deltas.  Runtime
-- quota checks must not scan every entity, recovery record and asset on each
-- accepted write.  The three source-table triggers also cover recovery,
-- resets and asset uploads without relying on individual HTTP handlers to
-- remember to update a second ledger.
CREATE TABLE account_storage_usage_v5 (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    entity_bytes bigint NOT NULL DEFAULT 0 CHECK (entity_bytes >= 0),
    asset_bytes bigint NOT NULL DEFAULT 0 CHECK (asset_bytes >= 0),
    history_bytes bigint NOT NULL DEFAULT 0 CHECK (history_bytes >= 0)
);

INSERT INTO account_storage_usage_v5(user_id,entity_bytes,asset_bytes,history_bytes)
SELECT users.id,
       COALESCE(entities.bytes, 0),
       COALESCE(assets.bytes, 0),
       COALESCE(history.bytes, 0)
FROM users
LEFT JOIN LATERAL (
    SELECT SUM(octet_length(envelope::text)) AS bytes
    FROM sync_entities_v4
    WHERE user_id=users.id
) AS entities ON TRUE
LEFT JOIN LATERAL (
    SELECT SUM(octet_length(body)) AS bytes
    FROM sync_assets_v4
    WHERE user_id=users.id
) AS assets ON TRUE
LEFT JOIN LATERAL (
    SELECT SUM(octet_length(compressed_envelope)) AS bytes
    FROM sync_entity_history_v4
    WHERE user_id=users.id
) AS history ON TRUE;

CREATE FUNCTION initialize_account_storage_usage_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO account_storage_usage_v5(user_id) VALUES (NEW.id)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_initialize_account_storage_usage_v5
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION initialize_account_storage_usage_v5();

CREATE FUNCTION update_account_storage_usage_v5()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    target_user text;
    entity_delta bigint := 0;
    asset_delta bigint := 0;
    history_delta bigint := 0;
BEGIN
    target_user := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;

    IF TG_TABLE_NAME = 'sync_entities_v4' THEN
        entity_delta := CASE
            WHEN TG_OP = 'INSERT' THEN octet_length(NEW.envelope::text)
            WHEN TG_OP = 'DELETE' THEN -octet_length(OLD.envelope::text)
            ELSE octet_length(NEW.envelope::text) - octet_length(OLD.envelope::text)
        END;
    ELSIF TG_TABLE_NAME = 'sync_assets_v4' THEN
        asset_delta := CASE
            WHEN TG_OP = 'INSERT' THEN octet_length(NEW.body)
            WHEN TG_OP = 'DELETE' THEN -octet_length(OLD.body)
            ELSE octet_length(NEW.body) - octet_length(OLD.body)
        END;
    ELSE
        history_delta := CASE
            WHEN TG_OP = 'INSERT' THEN octet_length(NEW.compressed_envelope)
            WHEN TG_OP = 'DELETE' THEN -octet_length(OLD.compressed_envelope)
            ELSE octet_length(NEW.compressed_envelope) - octet_length(OLD.compressed_envelope)
        END;
    END IF;

    -- Cascading account deletion removes all dependent rows.  Do not recreate
    -- a ledger row if a deferred cascade has already removed its parent.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM users WHERE id=target_user) THEN
        RETURN OLD;
    END IF;

    INSERT INTO account_storage_usage_v5(user_id,entity_bytes,asset_bytes,history_bytes)
    VALUES (target_user,entity_delta,asset_delta,history_delta)
    ON CONFLICT (user_id) DO UPDATE SET
        entity_bytes=account_storage_usage_v5.entity_bytes+EXCLUDED.entity_bytes,
        asset_bytes=account_storage_usage_v5.asset_bytes+EXCLUDED.asset_bytes,
        history_bytes=account_storage_usage_v5.history_bytes+EXCLUDED.history_bytes;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER sync_entities_storage_usage_v5
AFTER INSERT OR UPDATE OF envelope OR DELETE ON sync_entities_v4
FOR EACH ROW EXECUTE FUNCTION update_account_storage_usage_v5();

CREATE TRIGGER sync_assets_storage_usage_v5
AFTER INSERT OR UPDATE OF body OR DELETE ON sync_assets_v4
FOR EACH ROW EXECUTE FUNCTION update_account_storage_usage_v5();

CREATE TRIGGER sync_history_storage_usage_v5
AFTER INSERT OR UPDATE OF compressed_envelope OR DELETE ON sync_entity_history_v4
FOR EACH ROW EXECUTE FUNCTION update_account_storage_usage_v5();
