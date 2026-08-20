CREATE TABLE auth_sessions_v4 (
    token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest) = 32),
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id text NOT NULL,
    device_name text NOT NULL DEFAULT '',
    created_at bigint NOT NULL,
    last_used_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint NOT NULL DEFAULT 0,
    UNIQUE (user_id, installation_id)
);

CREATE INDEX idx_auth_sessions_v4_user_last_used
    ON auth_sessions_v4(user_id, last_used_at DESC);
CREATE INDEX idx_auth_sessions_v4_expires
    ON auth_sessions_v4(expires_at);
