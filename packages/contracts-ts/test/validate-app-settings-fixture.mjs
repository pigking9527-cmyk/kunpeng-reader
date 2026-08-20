import { readFile } from "node:fs/promises";
import { parseAppSettingsFixture } from "../src/runtime.mjs";

const fixtureUrl = new URL("../../../contracts/fixtures/app-settings.v1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const parsed = parseAppSettingsFixture(fixture);

if (parsed.entities[0]?.payload.futureDesktopSetting !== "preserve-me") {
  throw new Error("The parser must preserve forward-compatible app-settings fields.");
}

const legacyLevelFixture = structuredClone(fixture);
legacyLevelFixture.entities[0].payload.readerJumpBackSizeLevel = "6";
if (!(() => {
  try {
    parseAppSettingsFixture(legacyLevelFixture);
    return false;
  } catch (error) {
    return error instanceof TypeError && error.message.includes("retired");
  }
})()) {
  throw new Error("The parser must reject the retired jump-back size level.");
}

console.log("app-settings.v1.json passed the contracts-ts runtime gate.");
