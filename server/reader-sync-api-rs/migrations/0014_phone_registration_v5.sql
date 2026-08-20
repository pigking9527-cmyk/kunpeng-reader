CREATE TABLE account_phones_v5 (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phone_digest bytea NOT NULL UNIQUE CHECK (octet_length(phone_digest) = 32),
    last_four text NOT NULL CHECK (last_four ~ '^[0-9]{4}$'),
    verified_at bigint NOT NULL
);

CREATE TABLE phone_registration_challenges_v5 (
    id uuid PRIMARY KEY,
    username text NOT NULL,
    username_key text NOT NULL,
    phone_digest bytea NOT NULL CHECK (octet_length(phone_digest) = 32),
    code_digest bytea NOT NULL CHECK (octet_length(code_digest) = 32),
    attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    consumed_at bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_phone_registration_challenges_v5_lookup
    ON phone_registration_challenges_v5(username_key, phone_digest, created_at DESC);

CREATE TABLE sms_outbox_v5 (
    id uuid PRIMARY KEY,
    challenge_id uuid NOT NULL REFERENCES phone_registration_challenges_v5(id) ON DELETE CASCADE,
    kind text NOT NULL,
    recipient text NOT NULL,
    payload jsonb NOT NULL,
    created_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    available_at bigint NOT NULL,
    delivered_at bigint NOT NULL DEFAULT 0,
    last_error text NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX idx_sms_outbox_v5_challenge
    ON sms_outbox_v5(challenge_id);

CREATE INDEX idx_sms_outbox_v5_pending
    ON sms_outbox_v5(available_at, created_at)
    WHERE delivered_at = 0;

CREATE TABLE sms_daily_usage_v5 (
    utc_day bigint PRIMARY KEY,
    reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    delivered integer NOT NULL DEFAULT 0 CHECK (delivered >= 0 AND delivered <= reserved)
);
