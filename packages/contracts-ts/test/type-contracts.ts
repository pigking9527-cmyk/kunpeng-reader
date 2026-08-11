import {
  parseAppSettingsFixture,
  syncContractSchemaManifest,
  type AppSettingsFixture,
  type JsonObject,
} from "../src/index.js";

declare function expectType<TExpected>(value: TExpected): void;

const unknownFixture: unknown = {
  syncProtocolVersion: 1,
  entities: [],
};

expectType<AppSettingsFixture>(parseAppSettingsFixture(unknownFixture));
expectType<"contracts/sync/entities.schema.json">(syncContractSchemaManifest.entityEnvelope);

const futurePayload: JsonObject = { futureDesktopSetting: "preserve-me" };
expectType<string>(futurePayload.futureDesktopSetting as string);
