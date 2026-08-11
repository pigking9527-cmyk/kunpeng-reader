import { readFile } from "node:fs/promises";
import { parseAppSettingsFixture } from "../src/runtime.mjs";

const fixtureUrl = new URL("../../../contracts/fixtures/app-settings.v1.json", import.meta.url);
const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
const parsed = parseAppSettingsFixture(fixture);

if (parsed.entities[0]?.payload.futureDesktopSetting !== "preserve-me") {
  throw new Error("The parser must preserve forward-compatible app-settings fields.");
}

console.log("app-settings.v1.json passed the contracts-ts runtime gate.");
