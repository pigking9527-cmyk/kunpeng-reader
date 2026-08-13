CREATE TABLE password_reset_challenges_v4 (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username_key text NOT NULL,
    email text NOT NULL,
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_password_reset_challenges_v4_lookup
    ON password_reset_challenges_v4(username_key, created_at DESC);
