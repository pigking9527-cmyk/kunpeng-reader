CREATE TABLE rate_limit_buckets_v4 (
    scope text NOT NULL,
    subject_digest bytea NOT NULL CHECK (octet_length(subject_digest) = 32),
    window_start bigint NOT NULL,
    hits integer NOT NULL CHECK (hits > 0),
    PRIMARY KEY (scope, subject_digest, window_start)
);

CREATE INDEX idx_rate_limit_buckets_v4_window
    ON rate_limit_buckets_v4(window_start);

CREATE TABLE account_daily_usage_v4 (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    utc_day bigint NOT NULL,
    accepted_entities bigint NOT NULL DEFAULT 0 CHECK (accepted_entities >= 0),
    accepted_bytes bigint NOT NULL DEFAULT 0 CHECK (accepted_bytes >= 0),
    PRIMARY KEY (user_id, utc_day)
);
