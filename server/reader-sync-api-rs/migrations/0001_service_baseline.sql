-- Protocol v4 is a fresh database baseline. It intentionally does not import
-- the development-only Python schema or credentials.
CREATE TABLE rust_service_metadata (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id text PRIMARY KEY,
    username text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    created_at bigint NOT NULL,
    sync_verified_at bigint NOT NULL DEFAULT 0,
    disabled_at bigint NOT NULL DEFAULT 0,
    disabled_reason text NOT NULL DEFAULT ''
);

INSERT INTO rust_service_metadata(key, value)
VALUES ('sync_protocol_version', '4');
