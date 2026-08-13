CREATE TABLE feedback_v4 (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('bug', 'feature')),
    text text NOT NULL,
    images_json jsonb NOT NULL,
    attachments_json jsonb NOT NULL DEFAULT '[]'::jsonb,
    app_version text NOT NULL,
    platform text NOT NULL,
    client_ip_digest bytea NOT NULL CHECK (octet_length(client_ip_digest) = 32),
    created_at bigint NOT NULL
);

CREATE INDEX idx_feedback_v4_created_at ON feedback_v4(created_at DESC);
