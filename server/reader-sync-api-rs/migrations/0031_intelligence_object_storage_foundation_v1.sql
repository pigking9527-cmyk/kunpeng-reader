-- Object storage migration foundation.  Existing deployments stay on the
-- PostgreSQL bytea path: every pre-existing row is assigned `postgres` and no
-- handler reads or writes `object_key` until a later dual-write rollout.
ALTER TABLE intelligence_assets_v1
    ADD COLUMN storage_backend text NOT NULL DEFAULT 'postgres'
        CHECK (storage_backend IN ('postgres', 's3')),
    ADD COLUMN object_key text NULL,
    ADD CONSTRAINT intelligence_assets_v1_storage_location
        CHECK (
            (storage_backend = 'postgres' AND object_key IS NULL)
            OR (storage_backend = 's3' AND object_key IS NOT NULL AND char_length(object_key) BETWEEN 1 AND 1024)
        );

ALTER TABLE intelligence_archive_jobs_v1
    ADD COLUMN storage_backend text NOT NULL DEFAULT 'postgres'
        CHECK (storage_backend IN ('postgres', 's3')),
    ADD COLUMN object_key text NULL,
    ADD CONSTRAINT intelligence_archive_jobs_v1_storage_location
        CHECK (
            (storage_backend = 'postgres' AND object_key IS NULL)
            OR (storage_backend = 's3' AND object_key IS NOT NULL AND char_length(object_key) BETWEEN 1 AND 1024)
        );

-- Deletion is intentionally asynchronous.  A future object-store worker must
-- claim this durable outbox after the database reference transaction commits;
-- it must never delete a key directly from a request path.
CREATE TABLE intelligence_object_gc_outbox_v1 (
    outbox_id uuid PRIMARY KEY,
    storage_backend text NOT NULL CHECK (storage_backend = 's3'),
    object_key text NOT NULL CHECK (char_length(object_key) BETWEEN 1 AND 1024),
    state text NOT NULL CHECK (state IN ('QUEUED', 'CLAIMED', 'COMPLETE', 'FAILED')),
    not_before_at bigint NOT NULL,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL,
    claimed_by text NULL,
    lease_expires_at bigint NOT NULL DEFAULT 0,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_at bigint NOT NULL DEFAULT 0,
    last_error_code text NULL CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 128),
    UNIQUE (storage_backend, object_key),
    CHECK ((state = 'CLAIMED') = (claimed_by IS NOT NULL)),
    CHECK ((state = 'COMPLETE') = (completed_at > 0)),
    CHECK ((state <> 'COMPLETE') = (completed_at = 0))
);
CREATE INDEX idx_intelligence_object_gc_outbox_v1_claim
    ON intelligence_object_gc_outbox_v1 (state, not_before_at, lease_expires_at)
    WHERE state IN ('QUEUED', 'CLAIMED', 'FAILED');
