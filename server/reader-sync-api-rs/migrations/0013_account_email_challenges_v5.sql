CREATE TABLE account_email_challenges_v5 (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    purpose text NOT NULL CHECK (purpose IN ('bind_email', 'rebind_old', 'rebind_new')),
    email text NOT NULL,
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_account_email_challenges_v5_lookup
    ON account_email_challenges_v5(user_id, purpose, email, created_at DESC);

CREATE TABLE account_email_rebind_grants_v5 (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    old_email text NOT NULL,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_account_email_rebind_grants_v5_lookup
    ON account_email_rebind_grants_v5(user_id, old_email, created_at DESC);
