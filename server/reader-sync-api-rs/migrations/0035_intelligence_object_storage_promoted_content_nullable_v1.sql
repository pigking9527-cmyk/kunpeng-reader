-- `0025` made PostgreSQL bytea mandatory before secondary object storage
-- existed. Once a durable outbox PUT succeeds, S3 becomes the authoritative
-- location and the database copy must be releasable. This is a new migration
-- rather than an edit to `0031`, so already-migrated isolated and production
-- catalogs receive the same compatible transition.
ALTER TABLE intelligence_assets_v1
    ALTER COLUMN content DROP NOT NULL;
