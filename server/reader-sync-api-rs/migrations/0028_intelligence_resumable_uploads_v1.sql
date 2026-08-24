-- Resumable uploads are isolated from sync assets and are deliberately
-- bounded.  A relay package is temporary; a publication image becomes
-- readable only after a completed published bundle creates its reference.

CREATE TABLE intelligence_archive_uploads_v1 (
    upload_id uuid PRIMARY KEY,
    job_id uuid NOT NULL UNIQUE REFERENCES intelligence_archive_jobs_v1(job_id) ON DELETE CASCADE,
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    content_sha256 bytea NOT NULL CHECK (octet_length(content_sha256) = 32),
    total_bytes bigint NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 134217728),
    received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= total_bytes),
    content bytea NOT NULL DEFAULT ''::bytea,
    expires_at bigint NOT NULL,
    completed_at bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    CHECK (octet_length(content) = received_bytes)
);

CREATE INDEX idx_intelligence_archive_uploads_v1_expiry
    ON intelligence_archive_uploads_v1 (expires_at, completed_at);

-- Staged publication images use the content hash as their stable upload id.
-- They have no public reference until `complete_upload` validates every
-- declared image and writes `intelligence_publication_asset_refs_v1` in the
-- same transaction as the publication.
CREATE TABLE intelligence_asset_uploads_v1 (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    publisher_token_digest bytea NOT NULL REFERENCES intelligence_publisher_credentials_v1(token_digest),
    mime text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
    total_bytes bigint NOT NULL CHECK (total_bytes > 0 AND total_bytes <= 26214400),
    received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0 AND received_bytes <= total_bytes),
    content bytea NOT NULL DEFAULT ''::bytea,
    expires_at bigint NOT NULL,
    completed_at bigint NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL,
    CHECK (octet_length(content) = received_bytes)
);

CREATE INDEX idx_intelligence_asset_uploads_v1_expiry
    ON intelligence_asset_uploads_v1 (expires_at, completed_at);
