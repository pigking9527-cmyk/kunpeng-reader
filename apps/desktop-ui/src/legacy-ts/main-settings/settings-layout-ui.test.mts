import assert from "node:assert/strict";
import test from "node:test";

import { installSettingsLayout } from "./settings-layout-ui.ts";

test("settings layout installer fails closed without the original page DOM", () => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
  assert.equal(
    installSettingsLayout({
      document: { getElementById: () => null } as unknown as Document,
      localStorage: storage,
    }),
    null,
  );
});

test("settings layout source keeps the original persistence keys", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./settings-layout-ui.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /commonSettingsSectionV1/);
  assert.match(source, /commonSettingsNavCollapsedV1/);
  assert.match(source, /settingsCollapseNavigation/);
  assert.match(source, /settingsExpandNavigation/);
  assert.match(source, /set-cover-title/);
  assert.doesNotMatch(source, /__TAURI__|React|\.tsx/u);
});
