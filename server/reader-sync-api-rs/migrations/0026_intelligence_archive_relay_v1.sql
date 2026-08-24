-- Historical content is a short-lived relay only.  It is deliberately
-- independent from sync entities, user sync assets and normal publications.
CREATE TABLE intelligence_archive_jobs_v1 (
    job_id uuid PRIMARY KEY,
    request_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(request_fingerprint) = 32),
    request jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('QUEUED','CLAIMED','UPLOADING','READY','NOT_FOUND','FAILED','HOST_OFFLINE','REQUEST_EXPIRED','PURGED')),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    claimed_by bytea NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    lease_expires_at bigint NOT NULL DEFAULT 0,
    content bytea NULL,
    content_sha256 bytea NULL CHECK (content_sha256 IS NULL OR octet_length(content_sha256) = 32),
    content_expires_at bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    CHECK (expires_at > created_at),
    CHECK ((content IS NULL) = (content_sha256 IS NULL))
);
CREATE INDEX idx_intelligence_archive_jobs_v1_queue
    ON intelligence_archive_jobs_v1 (state, created_at) WHERE state = 'QUEUED';
CREATE INDEX idx_intelligence_archive_jobs_v1_expiry
    ON intelligence_archive_jobs_v1 (expires_at, content_expires_at);

CREATE TABLE intelligence_archive_requests_v1 (
    request_id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_fingerprint bytea NOT NULL CHECK (octet_length(request_fingerprint) = 32),
    job_id uuid NOT NULL REFERENCES intelligence_archive_jobs_v1(job_id),
    request jsonb NOT NULL,
    state text NOT NULL CHECK (state IN ('REQUESTED','QUEUED','CLAIMED','UPLOADING','READY','DOWNLOADED','ACKED','PURGED','HOST_OFFLINE','NOT_FOUND','FAILED','REQUEST_EXPIRED')),
    requested_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    downloaded_at bigint NOT NULL DEFAULT 0,
    acknowledged_at bigint NOT NULL DEFAULT 0,
    purge_at bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    UNIQUE (user_id, request_fingerprint),
    CHECK (expires_at > requested_at)
);
CREATE INDEX idx_intelligence_archive_requests_v1_user
    ON intelligence_archive_requests_v1 (user_id, requested_at DESC);
CREATE INDEX idx_intelligence_archive_requests_v1_job
    ON intelligence_archive_requests_v1 (job_id, state);
CREATE INDEX idx_intelligence_archive_requests_v1_expiry
    ON intelligence_archive_requests_v1 (expires_at, purge_at);

-- Receipts are isolated by credential namespace and are kept only with the
-- relay state; they cannot collide with publication upload idempotency keys.
CREATE TABLE intelligence_archive_request_receipts_v1 (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (user_id, idempotency_key)
);
CREATE TABLE intelligence_archive_relay_receipts_v1 (
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (publisher_token_digest, idempotency_key)
);
