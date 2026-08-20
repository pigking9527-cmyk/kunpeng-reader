-- Content-addressed binary background assets.  Incomplete uploads retain only
-- their verified sequential prefix so a client can resume safely.
CREATE TABLE sync_assets_v4 (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset_id text NOT NULL CHECK (asset_id ~ '^[0-9a-f]{64}$'),
    sha256 text NOT NULL CHECK (sha256 = asset_id),
    mime text NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif')),
    byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 10485760),
    received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= byte_size),
    body bytea NOT NULL DEFAULT ''::bytea,
    completed_at bigint NOT NULL DEFAULT 0 CHECK (completed_at >= 0),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    PRIMARY KEY (user_id, asset_id),
    CHECK (octet_length(body) = received_bytes),
    CHECK ((completed_at = 0) OR (received_bytes = byte_size))
);

CREATE INDEX idx_sync_assets_v4_account_completed
    ON sync_assets_v4(user_id, completed_at);
