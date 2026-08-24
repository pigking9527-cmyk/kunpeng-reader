-- Account-wide preferences remain the product preference source of truth.
-- Delivery acknowledgement and stream progress are additionally persisted per
-- registered device, so a reconnect on one device can never advance another
-- device's cursor or acknowledgement state.
CREATE TABLE intelligence_device_delivery_state_v1 (
    account_id text NOT NULL,
    device_id text NOT NULL,
    publication_id text NOT NULL REFERENCES intelligence_publications_v1(publication_id) ON DELETE CASCADE,
    acknowledged_at bigint NOT NULL,
    PRIMARY KEY (account_id, device_id, publication_id),
    FOREIGN KEY (account_id, device_id)
        REFERENCES intelligence_devices_v1(account_id, device_id) ON DELETE CASCADE
);

CREATE TABLE intelligence_device_delivery_cursors_v1 (
    account_id text NOT NULL,
    device_id text NOT NULL,
    cursor bigint NOT NULL DEFAULT 0 CHECK (cursor >= 0),
    updated_at bigint NOT NULL,
    PRIMARY KEY (account_id, device_id),
    FOREIGN KEY (account_id, device_id)
        REFERENCES intelligence_devices_v1(account_id, device_id) ON DELETE CASCADE
);

CREATE INDEX idx_intelligence_device_delivery_state_v1_publication
    ON intelligence_device_delivery_state_v1 (publication_id, account_id, device_id);
