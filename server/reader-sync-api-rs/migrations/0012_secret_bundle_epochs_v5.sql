-- v5 keeps the encrypted bundle's revocation epoch outside the encrypted
-- entity payload. Resetting it writes an authoritative tombstone so an
-- offline pre-reset bundle cannot silently become current again.
CREATE TABLE sync_secret_bundle_epochs_v5 (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    epoch bigint NOT NULL DEFAULT 1 CHECK (epoch >= 1),
    updated_at bigint NOT NULL
);
