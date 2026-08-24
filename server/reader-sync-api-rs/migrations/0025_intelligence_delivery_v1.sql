-- Account-scoped intelligence state deliberately lives outside sync entities.
-- Public content remains global; no account row contains a title, body or URL.
CREATE TABLE intelligence_preferences_v1 (
    account_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    topics text[] NOT NULL DEFAULT ARRAY[]::text[],
    minimum_importance integer NOT NULL DEFAULT 0 CHECK (minimum_importance BETWEEN 0 AND 100),
    updated_at bigint NOT NULL
);

CREATE TABLE intelligence_delivery_state_v1 (
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    publication_id text NOT NULL REFERENCES intelligence_publications_v1(publication_id) ON DELETE CASCADE,
    acknowledged_at bigint NOT NULL,
    PRIMARY KEY (account_id, publication_id)
);

-- `push_token` is deliberately not retained in this first server slice: V1
-- registers device capability and silent-hours only. A future push provider
-- must add encrypted provider credentials rather than reuse sync assets.
CREATE TABLE intelligence_devices_v1 (
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id text NOT NULL,
    platform text NOT NULL CHECK (platform IN ('windows', 'macos', 'linux', 'android', 'ios')),
    quiet_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at bigint NOT NULL,
    revoked_at bigint NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, device_id)
);

-- Body bytes are an isolated 30-day content store. The publication worker
-- writes this table through its asset path; the reader route additionally
-- requires a non-expired published reference before returning an image.
CREATE TABLE intelligence_assets_v1 (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    content bytea NOT NULL,
    bytes bigint NOT NULL CHECK (bytes > 0 AND bytes <= 26214400),
    expires_at bigint NOT NULL
);

CREATE TABLE intelligence_publication_asset_refs_v1 (
    publication_id text NOT NULL REFERENCES intelligence_publications_v1(publication_id) ON DELETE CASCADE,
    sha256 text NOT NULL REFERENCES intelligence_assets_v1(sha256) ON DELETE CASCADE,
    PRIMARY KEY (publication_id, sha256)
);

CREATE INDEX idx_intelligence_asset_refs_v1_sha256
    ON intelligence_publication_asset_refs_v1 (sha256, publication_id);

-- Idempotency is account- and operation-scoped: a key cannot expose one
-- account's receipt to another account, nor collide with publisher receipts.
CREATE TABLE intelligence_account_receipts_v1 (
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    operation text NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 256),
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (account_id, operation, idempotency_key)
);

CREATE INDEX idx_intelligence_account_receipts_v1_created
    ON intelligence_account_receipts_v1 (created_at);
