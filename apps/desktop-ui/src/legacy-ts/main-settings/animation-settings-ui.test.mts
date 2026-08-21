import assert from "node:assert/strict";
import test from "node:test";

import { installAnimationSettingsUi } from "./animation-settings-ui.ts";

test("animation settings UI fails closed without the original browser runtime", () => {
  assert.equal(installAnimationSettingsUi({ document: {} }), null);
});

test("animation settings UI keeps the original global contract and selectors", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./animation-settings-ui.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /ReaderAnimationSettingsUI/);
  assert.match(source, /set-animation-master/);
  assert.match(source, /data-animation-setting/);
  assert.match(source, /data-animation-group/);
  assert.match(source, /reader-animation-settings-changed/);
  assert.doesNotMatch(source, /__TAURI__|React|\.tsx/u);
});
