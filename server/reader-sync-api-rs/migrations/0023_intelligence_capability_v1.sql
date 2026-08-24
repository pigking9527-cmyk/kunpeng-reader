-- Intelligence delivery is opt-in per account.  A newly migrated or created
-- account must never gain access to a future content feed by default.
ALTER TABLE users
    ADD COLUMN intelligence_feed_enabled boolean NOT NULL DEFAULT false;
