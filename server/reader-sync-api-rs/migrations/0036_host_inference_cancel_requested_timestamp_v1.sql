-- A cancellation request is distinct from a completed cancellation.  Keeping
-- both timestamps lets the server notify an in-flight host without claiming
-- that its in-memory plaintext has already been destroyed.
ALTER TABLE intelligence_host_tasks_v1
    ADD COLUMN cancel_requested_at bigint NOT NULL DEFAULT 0;

ALTER TABLE intelligence_host_tasks_v1
    ADD CONSTRAINT intelligence_host_tasks_cancel_request_timestamp_check
    CHECK (state <> 'CANCEL_REQUESTED' OR cancel_requested_at > 0);
