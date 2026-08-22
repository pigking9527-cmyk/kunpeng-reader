import assert from "node:assert/strict";
import test from "node:test";

import { installDebugUi } from "./debug-ui.ts";

test("debug UI fails closed without the original modal or typed transport", () => {
  const storage = { getItem: () => null } as unknown as Storage;
  assert.equal(
    installDebugUi({
      document: { getElementById: () => null } as unknown as Document,
      localStorage: storage,
    }),
    null,
  );
});

test("debug UI keeps original storage, diagnostics and safe-mode contracts", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("./debug-ui.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /debugSettingsV1/);
  assert.match(source, /startupPerfLogV1/);
  assert.match(source, /runtime_diagnostics/);
  assert.match(source, /reader_page_measure = true/);
  assert.match(source, /openDebugModal/);
  assert.match(source, /getDebugSetting/);
  assert.doesNotMatch(source, /__TAURI__|React|\.tsx/u);
});
