-- A stream row contains no title, source, URL, event body or account-facing
-- preference data. It is only a durable per-account wake-up signal; clients
-- must still use the normal authenticated feed/publication endpoints.
CREATE TABLE intelligence_delivery_events_v1 (
    cursor bigserial PRIMARY KEY,
    account_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    publication_id text NOT NULL REFERENCES intelligence_publications_v1(publication_id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('event', 'daily')),
    created_at bigint NOT NULL,
    UNIQUE (account_id, publication_id)
);

-- The SSE cursor lookup is always account-scoped. This prevents a reconnecting
-- client from observing another account's event IDs or timing.
CREATE INDEX idx_intelligence_delivery_events_v1_account_cursor
    ON intelligence_delivery_events_v1 (account_id, cursor);
