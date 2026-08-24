-- The intelligence server is a strictly bounded 30-day distribution cache.
-- These tables deliberately retain only operational and archive-availability
-- metadata after a publication is physically purged.  In particular, they do
-- not contain a title, summary, source URL, body, note, image bytes or bundle.

CREATE TABLE intelligence_retention_runs_v1 (
    run_id uuid PRIMARY KEY,
    state text NOT NULL CHECK (state IN ('PURGING', 'COMPLETE', 'FAILED')),
    cutoff_at bigint NOT NULL,
    started_at bigint NOT NULL,
    finished_at bigint NOT NULL DEFAULT 0,
    publications_purged bigint NOT NULL DEFAULT 0,
    delivery_refs_deleted bigint NOT NULL DEFAULT 0,
    asset_refs_deleted bigint NOT NULL DEFAULT 0,
    assets_deleted bigint NOT NULL DEFAULT 0,
    draft_rows_deleted bigint NOT NULL DEFAULT 0,
    receipts_deleted bigint NOT NULL DEFAULT 0
);

CREATE INDEX idx_intelligence_retention_runs_v1_state
    ON intelligence_retention_runs_v1 (state, started_at DESC);

-- This queue is transient cleanup state, not historical content.  It is
-- deleted with the completed purge run.  Keeping it explicit makes the first
-- cleanup phase observable and prevents a second worker from deleting the
-- same publication concurrently.
CREATE TABLE intelligence_publication_purge_queue_v1 (
    run_id uuid NOT NULL REFERENCES intelligence_retention_runs_v1(run_id) ON DELETE CASCADE,
    publication_id text NOT NULL REFERENCES intelligence_publications_v1(publication_id) ON DELETE CASCADE,
    state text NOT NULL CHECK (state = 'PURGING'),
    queued_at bigint NOT NULL,
    PRIMARY KEY (run_id, publication_id),
    UNIQUE (publication_id)
);

CREATE INDEX idx_intelligence_publication_purge_queue_v1_run
    ON intelligence_publication_purge_queue_v1 (run_id, publication_id);

-- A deletion receipt contains only the permitted archive-calendar facts and
-- a package hash receipt.  `published_day` is deliberately a date rather than
-- a publication id, and is all calendar clients may use once hot content is
-- gone.
CREATE TABLE intelligence_purged_publication_receipts_v1 (
    published_day date NOT NULL,
    kind text NOT NULL CHECK (kind IN ('event', 'daily')),
    revision_no integer NOT NULL CHECK (revision_no >= 1),
    bundle_sha256 bytea NOT NULL CHECK (octet_length(bundle_sha256) = 32),
    publisher_installation_id text NOT NULL,
    purged_at bigint NOT NULL,
    PRIMARY KEY (published_day, kind, revision_no, bundle_sha256)
);

CREATE TABLE intelligence_archive_calendar_v1 (
    archive_day date PRIMARY KEY,
    purged_publication_count bigint NOT NULL DEFAULT 0 CHECK (purged_publication_count >= 0),
    updated_at bigint NOT NULL
);

-- No retention metadata table may silently become a secondary content store.
-- Keep this schema guard in migration form so a PostgreSQL review can audit
-- it without relying on application code.
COMMENT ON TABLE intelligence_purged_publication_receipts_v1 IS
    'Content-free 30-day purge receipt: day/kind/revision/hash/publisher only.';
