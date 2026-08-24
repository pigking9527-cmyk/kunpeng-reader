-- Archive packages use a separate outbox because their lifecycle and source
-- bytes are owned by archive jobs rather than publication assets.  PostgreSQL
-- remains the reader-visible fallback until the worker has completed S3 PUT
-- and atomically switched the job location.
CREATE TABLE intelligence_archive_object_write_outbox_v1 (
    outbox_id uuid PRIMARY KEY,
    job_id uuid NOT NULL UNIQUE REFERENCES intelligence_archive_jobs_v1(job_id) ON DELETE CASCADE,
    storage_backend text NOT NULL CHECK (storage_backend = 's3'),
    object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
    state text NOT NULL CHECK (state IN ('QUEUED', 'CLAIMED', 'COMPLETE')),
    not_before_at bigint NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    claimed_by text NULL,
    lease_expires_at bigint NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_at bigint NOT NULL DEFAULT 0,
    last_error_code text NULL CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128),
    CHECK ((state = 'CLAIMED') = (claimed_by IS NOT NULL)),
    CHECK ((state = 'COMPLETE') = (completed_at > 0)),
    CHECK ((state <> 'COMPLETE') = (completed_at = 0))
);

CREATE INDEX idx_intelligence_archive_object_write_outbox_v1_claim
    ON intelligence_archive_object_write_outbox_v1 (state, not_before_at, lease_expires_at)
    WHERE state IN ('QUEUED', 'CLAIMED');
