/**
 * TypeScript entry points for repository contracts.
 *
 * The canonical definitions remain the JSON Schema and fixtures in
 * `contracts/`. These types deliberately model only the shared envelope and
 * a narrow app-settings fixture entry point; do not add product-only fields
 * here without first changing the contract.
 */

import { parseAppSettingsFixture as parseRuntimeAppSettingsFixture } from "./runtime.mjs";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];

/** Objects in sync payloads preserve unknown fields for forward compatibility. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface SyncEntity<
  TKind extends string = string,
  TPayload extends JsonObject = JsonObject,
> {
  readonly id: string;
  readonly kind: TKind;
  /** Canonical Unix epoch milliseconds. */
  readonly updated_at: number;
  /** Zero is active; a non-zero value is a tombstone timestamp. */
  readonly deleted_at: number;
  readonly device_id: string;
  readonly sync_version: number;
  readonly payload: TPayload;
}

/**
 * Required `app_settings_v1` fields. Optional and future fields remain in the
 * JSON object index signature and must be preserved by a writing client.
 */
export interface AppSettingsV1Payload extends JsonObject {
  readonly version: 1;
  readonly showReaderJumpBack: boolean;
  readonly readerJumpBackDismissMode: "pages" | "time";
  readonly readerJumpBackDismissSeconds: number;
  readonly readerJumpBackDismissPages: number;
  readonly readerJumpBackIconSizePx: number;
}

export type AppSettingsV1Entity = SyncEntity<"app_settings_v1", AppSettingsV1Payload>;

/** The stable shape used by `contracts/fixtures/app-settings.v1.json`. */
export interface AppSettingsFixture {
  /** Protocol v5 is a destructive fresh-baseline fixture. */
  readonly syncProtocolVersion: 5;
  readonly entities: readonly AppSettingsV1Entity[];
  /** Root-level future fields are preserved without assigning them semantics. */
  readonly [key: string]: JsonValue | readonly AppSettingsV1Entity[];
}

/**
 * Paths are repository-relative on purpose: JSON Schema is the authority and
 * consumers may choose their own standards-compliant JSON Schema validator.
 */
export const syncContractSchemaManifest = {
  entityEnvelope: "contracts/sync/entities.schema.json",
  appSettingsFixture: "contracts/fixtures/app-settings.v1.json",
} as const;

/**
 * Checks the stable, required portion of the app-settings fixture at a Node or
 * WebView boundary. It is not a replacement for full JSON Schema validation.
 */
export const parseAppSettingsFixture: (value: unknown) => AppSettingsFixture =
  parseRuntimeAppSettingsFixture;
