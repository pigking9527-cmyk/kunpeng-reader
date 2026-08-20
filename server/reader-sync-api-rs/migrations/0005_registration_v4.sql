ALTER TABLE users
    ADD COLUMN username_key text NOT NULL,
    ADD CONSTRAINT users_username_key_unique UNIQUE (username_key);

CREATE TABLE account_emails_v4 (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    email text NOT NULL UNIQUE,
    verified_at bigint NOT NULL
);

CREATE TABLE registration_challenges_v4 (
    id uuid PRIMARY KEY,
    username text NOT NULL,
    username_key text NOT NULL,
    email text NOT NULL,
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_registration_challenges_v4_lookup
    ON registration_challenges_v4(username_key, email, created_at DESC);

CREATE TABLE mail_outbox_v4 (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    recipient text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    available_at bigint NOT NULL,
    delivered_at bigint NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT ''
);

CREATE INDEX idx_mail_outbox_v4_pending
    ON mail_outbox_v4(available_at, created_at)
    WHERE delivered_at = 0;
