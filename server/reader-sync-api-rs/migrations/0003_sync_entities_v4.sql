CREATE SEQUENCE sync_cursor_v4 AS bigint;

CREATE TABLE account_data_generations (
    user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    generation bigint NOT NULL DEFAULT 1 CHECK (generation >= 1),
    updated_at bigint NOT NULL
);

CREATE FUNCTION initialize_account_data_generation_v4()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO account_data_generations(user_id, generation, updated_at)
    VALUES (NEW.id, 1, NEW.created_at);
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_initialize_account_data_generation_v4
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION initialize_account_data_generation_v4();

CREATE TABLE sync_entities_v4 (
    user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    entity_id text NOT NULL,
    envelope jsonb NOT NULL,
    updated_at bigint NOT NULL,
    deleted_at bigint NOT NULL DEFAULT 0,
    device_id text NOT NULL,
    sync_version bigint NOT NULL,
    server_cursor bigint NOT NULL DEFAULT nextval('sync_cursor_v4'),
    PRIMARY KEY (user_id, kind, entity_id)
);

CREATE INDEX idx_sync_entities_v4_pull
    ON sync_entities_v4(user_id, server_cursor);
