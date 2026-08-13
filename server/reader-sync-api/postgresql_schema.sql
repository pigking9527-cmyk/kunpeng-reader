-- PostgreSQL migration target for reader-sync-api.
-- This is a complete schema-equivalence baseline, not an instruction to
-- dual-write production. Apply only to an empty, access-restricted database.

CREATE TABLE schema_migrations (
    version integer PRIMARY KEY,
    applied_at bigint NOT NULL
);

CREATE TABLE users (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at bigint NOT NULL,
    sync_verified_at bigint NOT NULL DEFAULT 0,
    disabled_at bigint NOT NULL DEFAULT 0,
    disabled_reason text NOT NULL DEFAULT ''
);

CREATE TABLE tokens (
    token text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at bigint NOT NULL,
    last_used_at bigint NOT NULL,
    installation_id text NOT NULL DEFAULT 'legacy',
    device_name text NOT NULL DEFAULT ''
);
CREATE INDEX idx_tokens_user_last_used_at ON tokens(user_id,last_used_at DESC);
CREATE INDEX idx_tokens_created_at ON tokens(created_at);

CREATE TABLE entities (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    id text NOT NULL,
    json text NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint NOT NULL DEFAULT 0,
    device_id text NOT NULL DEFAULT '',
    sync_version bigint NOT NULL DEFAULT 0,
    server_updated_at bigint NOT NULL,
    PRIMARY KEY(user_id,kind,id)
);
CREATE INDEX idx_entities_user_server_updated_at ON entities(user_id,server_updated_at);

CREATE SEQUENCE sync_clock_seq AS bigint;

CREATE TABLE sync_clock (
    id integer PRIMARY KEY CHECK (id = 1),
    value bigint NOT NULL
);

CREATE TABLE entity_history (
    sequence bigserial PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    entity_id text NOT NULL,
    payload_zlib bytea NOT NULL,
    payload_bytes bigint NOT NULL,
    payload_sha256 text NOT NULL,
    payload_kind text NOT NULL DEFAULT 'snapshot',
    base_sequence bigint NOT NULL DEFAULT 0,
    state_bytes bigint NOT NULL DEFAULT 0,
    state_sha256 text NOT NULL DEFAULT '',
    updated_at bigint NOT NULL,
    deleted_at bigint NOT NULL DEFAULT 0,
    device_id text NOT NULL DEFAULT '',
    sync_version bigint NOT NULL DEFAULT 0,
    recorded_at bigint NOT NULL,
    source text NOT NULL,
    UNIQUE(user_id,kind,entity_id,recorded_at,source)
);
CREATE INDEX idx_entity_history_user_recorded ON entity_history(user_id,recorded_at,sequence);
CREATE INDEX idx_entity_history_entity_recorded ON entity_history(user_id,kind,entity_id,recorded_at DESC,sequence DESC);

CREATE TABLE account_usage (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    storage_limit_bytes bigint NOT NULL,
    storage_bytes bigint NOT NULL DEFAULT 0,
    daily_window_at bigint NOT NULL DEFAULT 0,
    daily_written_bytes bigint NOT NULL DEFAULT 0,
    daily_entity_writes bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL
);

CREATE TABLE account_emails (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL UNIQUE,
    verified_at bigint NOT NULL
);

CREATE TABLE account_codes (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose text NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    used_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_account_codes_lookup
    ON account_codes(user_id,purpose,email,expires_at);

CREATE TABLE pending_registrations (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    email text NOT NULL UNIQUE,
    code_hash text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0
);

CREATE TABLE secret_bundle_epochs (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    epoch bigint NOT NULL DEFAULT 1,
    updated_at bigint NOT NULL
);

CREATE TABLE account_data_generations (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generation bigint NOT NULL DEFAULT 1,
    updated_at bigint NOT NULL
);

CREATE TABLE recovery_accounts (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled_at bigint NOT NULL,
    last_pruned_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE feedback (
    id text PRIMARY KEY,
    kind text NOT NULL,
    text text NOT NULL,
    images_json text NOT NULL DEFAULT '[]',
    attachments_json text NOT NULL DEFAULT '[]',
    app_version text NOT NULL,
    platform text NOT NULL,
    client_ip text NOT NULL,
    created_at bigint NOT NULL,
    emailed_at bigint NOT NULL DEFAULT 0,
    mail_error text NOT NULL DEFAULT ''
);
CREATE INDEX idx_feedback_email_queue ON feedback(emailed_at,created_at);

CREATE TABLE rate_limit_buckets (
    scope text NOT NULL,
    bucket_key text NOT NULL,
    tokens double precision NOT NULL,
    last_seen_at bigint NOT NULL,
    PRIMARY KEY(scope,bucket_key)
);
CREATE INDEX idx_rate_limit_buckets_seen ON rate_limit_buckets(last_seen_at);

CREATE TABLE security_audit (
    id bigserial PRIMARY KEY,
    occurred_at bigint NOT NULL,
    event text NOT NULL,
    severity text NOT NULL,
    user_id text NOT NULL DEFAULT '',
    subject text NOT NULL DEFAULT '',
    detail_json text NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_security_audit_time ON security_audit(occurred_at DESC);

CREATE TABLE security_alerts (
    id bigserial PRIMARY KEY,
    occurred_at bigint NOT NULL,
    event text NOT NULL,
    severity text NOT NULL,
    subject text NOT NULL,
    count bigint NOT NULL DEFAULT 1,
    notified_at bigint NOT NULL DEFAULT 0,
    detail_json text NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_security_alerts_pending
    ON security_alerts(notified_at,occurred_at);

CREATE TABLE reader_assets (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id text NOT NULL,
    sha256 text NOT NULL,
    mime text NOT NULL,
    byte_size bigint NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY(user_id,asset_id)
);
CREATE INDEX idx_reader_assets_user_created
    ON reader_assets(user_id,created_at);

CREATE TABLE reader_asset_uploads (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id text NOT NULL,
    sha256 text NOT NULL,
    mime text NOT NULL,
    total_bytes bigint NOT NULL,
    received_bytes bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    PRIMARY KEY(user_id,asset_id)
);

-- Keep the same O(1) storage ledger as SQLite. Migration tooling must seed
-- account_usage before enabling these triggers.
CREATE OR REPLACE FUNCTION reader_sync_storage_delta() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    owner text;
    delta bigint := 0;
BEGIN
    IF TG_OP = 'DELETE' THEN
        owner := OLD.user_id;
    ELSE
        owner := NEW.user_id;
    END IF;
    IF TG_TABLE_NAME = 'entities' THEN
        delta := CASE WHEN TG_OP = 'DELETE' THEN
            -octet_length(OLD.json)
        WHEN TG_OP = 'INSERT' THEN
            octet_length(NEW.json)
        ELSE
            octet_length(NEW.json) - octet_length(OLD.json)
        END;
    ELSIF TG_TABLE_NAME = 'entity_history' THEN
        delta := CASE WHEN TG_OP = 'DELETE' THEN -octet_length(OLD.payload_zlib)
                      WHEN TG_OP = 'INSERT' THEN octet_length(NEW.payload_zlib)
                      ELSE octet_length(NEW.payload_zlib) - octet_length(OLD.payload_zlib) END;
    ELSE
        delta := CASE WHEN TG_OP = 'DELETE' THEN -OLD.byte_size
                      WHEN TG_OP = 'INSERT' THEN NEW.byte_size
                      ELSE NEW.byte_size - OLD.byte_size END;
    END IF;
    UPDATE account_usage
       SET storage_bytes = GREATEST(0, storage_bytes + delta)
     WHERE user_id = owner;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER entities_storage_delta
AFTER INSERT OR UPDATE OR DELETE ON entities
FOR EACH ROW EXECUTE FUNCTION reader_sync_storage_delta();
CREATE TRIGGER history_storage_delta
AFTER INSERT OR UPDATE OR DELETE ON entity_history
FOR EACH ROW EXECUTE FUNCTION reader_sync_storage_delta();
CREATE TRIGGER assets_storage_delta
AFTER INSERT OR UPDATE OR DELETE ON reader_assets
FOR EACH ROW EXECUTE FUNCTION reader_sync_storage_delta();

-- Binary asset files remain in object/file storage; PostgreSQL stores only
-- metadata. A cutover still requires connection pooling, TLS, PITR backups,
-- a stop-write window, content-free count/digest comparison, and rollback.
