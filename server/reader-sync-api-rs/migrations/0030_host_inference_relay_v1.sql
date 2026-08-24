-- Private host-inference relay V1.  These are deliberately independent from
-- sync entities and public intelligence publications.  The service stores
-- only opaque, endpoint-encrypted envelopes and routing metadata.
CREATE TABLE intelligence_host_pairing_offers_v1 (
    offer_id uuid PRIMARY KEY,
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offer_digest bytea NOT NULL UNIQUE CHECK (octet_length(offer_digest) = 32),
    client_key_id text NOT NULL,
    client_public_key text NOT NULL,
    state text NOT NULL CHECK (state IN ('PENDING','CLAIMED','EXPIRED','REVOKED')),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    claimed_at bigint NOT NULL DEFAULT 0,
    CHECK (expires_at > created_at)
);
CREATE INDEX idx_intelligence_host_pairing_offers_expiry
    ON intelligence_host_pairing_offers_v1 (state, expires_at);

CREATE TABLE intelligence_host_pairings_v1 (
    pair_id uuid PRIMARY KEY,
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_installation_id text NOT NULL,
    host_key_id text NOT NULL,
    host_public_key text NOT NULL,
    host_key_fingerprint text NOT NULL CHECK (length(host_key_fingerprint) = 64),
    client_key_id text NOT NULL,
    client_public_key text NOT NULL,
    capability_revision integer NOT NULL CHECK (capability_revision >= 1),
    capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 32),
    state text NOT NULL CHECK (state IN ('ACTIVE','REVOKED','EXPIRED')),
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    revoked_at bigint NOT NULL DEFAULT 0
);
CREATE INDEX idx_intelligence_host_pairings_account
    ON intelligence_host_pairings_v1 (account_id, state);
CREATE INDEX idx_intelligence_host_pairings_installation
    ON intelligence_host_pairings_v1 (account_id, host_installation_id, state);

CREATE TABLE intelligence_host_credentials_v1 (
    credential_digest bytea PRIMARY KEY CHECK (octet_length(credential_digest) = 32),
    pair_id uuid NOT NULL REFERENCES intelligence_host_pairings_v1(pair_id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    host_installation_id text NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint NOT NULL DEFAULT 0,
    created_at bigint NOT NULL,
    last_used_at bigint NOT NULL DEFAULT 0,
    UNIQUE (pair_id, host_installation_id)
);
CREATE INDEX idx_intelligence_host_credentials_active
    ON intelligence_host_credentials_v1 (credential_digest, expires_at)
    WHERE revoked_at = 0;

CREATE TABLE intelligence_host_tasks_v1 (
    task_id text PRIMARY KEY,
    pair_id uuid NOT NULL REFERENCES intelligence_host_pairings_v1(pair_id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation text NOT NULL CHECK (operation IN ('library_answer','library_compare','reading_deep_analysis','reading_memory','news_preference','news_evidence_review','companion_prompt')),
    capability_revision integer NOT NULL CHECK (capability_revision >= 1),
    state text NOT NULL CHECK (state IN ('QUEUED','CLAIMED','RUNNING','RESULT_READY','CANCEL_REQUESTED','CANCELLED','EXPIRED','FAILED','PURGED')),
    request_envelope jsonb NULL,
    request_ciphertext_sha256 bytea NULL CHECK (request_ciphertext_sha256 IS NULL OR octet_length(request_ciphertext_sha256) = 32),
    result_envelope jsonb NULL,
    result_ciphertext_sha256 bytea NULL CHECK (result_ciphertext_sha256 IS NULL OR octet_length(result_ciphertext_sha256) = 32),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    claimed_at bigint NOT NULL DEFAULT 0,
    cancelled_at bigint NOT NULL DEFAULT 0,
    completed_at bigint NOT NULL DEFAULT 0,
    result_expires_at bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    CHECK (expires_at > created_at),
    CHECK ((request_envelope IS NULL) = (request_ciphertext_sha256 IS NULL)),
    CHECK ((result_envelope IS NULL) = (result_ciphertext_sha256 IS NULL))
);
CREATE INDEX idx_intelligence_host_tasks_host_queue
    ON intelligence_host_tasks_v1 (pair_id, state, created_at)
    WHERE state IN ('QUEUED','CANCEL_REQUESTED');
CREATE INDEX idx_intelligence_host_tasks_expiry
    ON intelligence_host_tasks_v1 (expires_at, result_expires_at);

-- Idempotency receipts only contain fixed protocol response metadata.  They
-- must never contain envelopes, prompts, results, public keys or secrets.
CREATE TABLE intelligence_host_request_receipts_v1 (
    actor_kind text NOT NULL CHECK (actor_kind IN ('account','host')),
    actor_id text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (actor_kind, actor_id, idempotency_key)
);
CREATE INDEX idx_intelligence_host_request_receipts_expiry
    ON intelligence_host_request_receipts_v1 (created_at);
