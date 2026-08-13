-- Idempotent production migration for registration v2 and bounded devices.
-- Apply while the API services are stopped, before deploying the matching app.py.

BEGIN;

ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS installation_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE tokens
    ADD COLUMN IF NOT EXISTS device_name text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_tokens_user_last_used_at
    ON tokens(user_id,last_used_at DESC);

CREATE TABLE IF NOT EXISTS pending_registrations (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    email text NOT NULL UNIQUE,
    code_hash text NOT NULL,
    created_at bigint NOT NULL,
    expires_at bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0
);

ALTER TABLE security_alerts
    ADD COLUMN IF NOT EXISTS count bigint NOT NULL DEFAULT 1;

INSERT INTO schema_migrations(version,applied_at)
VALUES (18,(extract(epoch from clock_timestamp()) * 1000)::bigint)
ON CONFLICT(version) DO NOTHING;

COMMIT;
