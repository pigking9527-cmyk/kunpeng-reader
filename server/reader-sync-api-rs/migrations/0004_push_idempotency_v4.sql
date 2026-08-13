CREATE TABLE sync_push_receipts_v4 (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mutation_id uuid NOT NULL,
    request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
    response jsonb NOT NULL,
    created_at bigint NOT NULL,
    PRIMARY KEY (user_id, mutation_id)
);

CREATE INDEX idx_sync_push_receipts_v4_created_at
    ON sync_push_receipts_v4(created_at);
