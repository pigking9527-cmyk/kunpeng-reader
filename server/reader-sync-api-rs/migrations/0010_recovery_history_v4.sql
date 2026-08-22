-- ADR-0017 recovery history. Payloads are compressed by the application with
-- zlib level 6 so integrity can be verified before any restore is applied.
CREATE TABLE sync_entity_history_v4 (
    id bigserial PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    entity_id text NOT NULL,
    recorded_at bigint NOT NULL,
    compressed_envelope bytea NOT NULL,
    uncompressed_bytes integer NOT NULL CHECK (uncompressed_bytes > 0 AND uncompressed_bytes <= 1048576),
    envelope_sha256 bytea NOT NULL CHECK (octet_length(envelope_sha256) = 32)
);

CREATE INDEX idx_sync_entity_history_v4_account_time
    ON sync_entity_history_v4(user_id, recorded_at, id);
CREATE INDEX idx_sync_entity_history_v4_entity_time
    ON sync_entity_history_v4(user_id, kind, entity_id, recorded_at DESC, id DESC);

-- A row exists only once a recoverable baseline has been written. This avoids
-- claiming recovery coverage for data that predates the feature rollout.
CREATE TABLE sync_recovery_accounts_v4 (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled_at bigint NOT NULL,
    last_pruned_at bigint NOT NULL DEFAULT 0
);
