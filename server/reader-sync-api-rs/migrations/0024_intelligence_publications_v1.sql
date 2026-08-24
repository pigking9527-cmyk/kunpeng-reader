-- Public intelligence content is intentionally isolated from both sync entities
-- and per-account sync assets.  The server stores only published 30-day
-- bundles and their bounded pre-publication drafts.
CREATE TABLE intelligence_publisher_credentials_v1 (
    token_digest bytea PRIMARY KEY CHECK (octet_length(token_digest) = 32),
    installation_id text NOT NULL,
    capabilities text[] NOT NULL,
    expires_at bigint NOT NULL,
    revoked_at bigint NOT NULL DEFAULT 0,
    created_at bigint NOT NULL,
    CHECK (cardinality(capabilities) > 0)
);

CREATE TABLE intelligence_publication_drafts_v1 (
    publication_id text PRIMARY KEY,
    bundle jsonb NOT NULL,
    bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    completed_at bigint NOT NULL DEFAULT 0
);

CREATE TABLE intelligence_publications_v1 (
    publication_id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('event', 'daily')),
    published_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    issued_at bigint NOT NULL,
    revision_no integer NOT NULL CHECK (revision_no >= 1),
    importance integer NOT NULL DEFAULT 0 CHECK (importance BETWEEN 0 AND 100),
    bundle jsonb NOT NULL,
    bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    completed_at bigint NOT NULL,
    CHECK (expires_at = published_at + 2592000000),
    CHECK (expires_at > published_at)
);

CREATE INDEX idx_intelligence_publications_v1_visible
    ON intelligence_publications_v1 (expires_at, published_at DESC, publication_id DESC);

CREATE TABLE intelligence_publication_receipts_v1 (
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (publisher_token_digest, idempotency_key)
);

CREATE INDEX idx_intelligence_publication_receipts_v1_created_at
    ON intelligence_publication_receipts_v1 (created_at);
