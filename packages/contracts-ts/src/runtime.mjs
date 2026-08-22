function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value, path) {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value;
}

function requireString(value, path) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string.`);
  }
  return value;
}

function requireIntegerInRange(value, path, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requireBoolean(value, path) {
  if (typeof value !== "boolean") {
    throw new TypeError(`${path} must be a boolean.`);
  }
  return value;
}

/**
 * A deliberately narrow runtime gate for the real app-settings fixture.
 *
 * JSON Schema remains authoritative. This only checks the required envelope
 * and `app_settings_v1` fields that a TypeScript client relies on, while
 * retaining every unknown root/entity/payload field unchanged.
 */
export function parseAppSettingsFixture(value) {
  const fixture = requireRecord(value, "app-settings fixture");
  if (fixture.syncProtocolVersion !== 5) {
    throw new TypeError("syncProtocolVersion must be 5.");
  }
  if (!Array.isArray(fixture.entities) || fixture.entities.length === 0) {
    throw new TypeError("entities must be a non-empty array.");
  }

  fixture.entities.forEach((candidate, index) => {
    const path = `entities[${index}]`;
    const entity = requireRecord(candidate, path);
    requireString(entity.id, `${path}.id`);
    if (entity.kind !== "app_settings_v1") {
      throw new TypeError(`${path}.kind must be app_settings_v1.`);
    }
    requireIntegerInRange(entity.updated_at, `${path}.updated_at`, 0, Number.MAX_SAFE_INTEGER);
    requireIntegerInRange(entity.deleted_at, `${path}.deleted_at`, 0, Number.MAX_SAFE_INTEGER);
    requireString(entity.device_id, `${path}.device_id`);
    requireIntegerInRange(entity.sync_version, `${path}.sync_version`, 1, Number.MAX_SAFE_INTEGER);

    const payload = requireRecord(entity.payload, `${path}.payload`);
    if (payload.version !== 1) {
      throw new TypeError(`${path}.payload.version must be 1.`);
    }
    requireBoolean(payload.showReaderJumpBack, `${path}.payload.showReaderJumpBack`);
    if (payload.readerJumpBackDismissMode !== "pages" && payload.readerJumpBackDismissMode !== "time") {
      throw new TypeError(`${path}.payload.readerJumpBackDismissMode must be pages or time.`);
    }
    requireIntegerInRange(payload.readerJumpBackDismissSeconds, `${path}.payload.readerJumpBackDismissSeconds`, 1, 600);
    requireIntegerInRange(payload.readerJumpBackDismissPages, `${path}.payload.readerJumpBackDismissPages`, 1, 100);
    requireIntegerInRange(payload.readerJumpBackIconSizePx, `${path}.payload.readerJumpBackIconSizePx`, 30, 160);
    if (Object.prototype.hasOwnProperty.call(payload, "readerJumpBackSizeLevel")) {
      throw new TypeError(`${path}.payload.readerJumpBackSizeLevel is retired by sync protocol version 5.`);
    }
  });

  return fixture;
}
