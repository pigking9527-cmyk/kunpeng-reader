import assert from "node:assert/strict";
import test from "node:test";

import { installLibraryAiEntry } from "./library-ai-entry.ts";

test("library AI entry fails closed outside the original main-window DOM", () => {
  assert.equal(installLibraryAiEntry({}), null);
  assert.equal(
    installLibraryAiEntry({
      document: { getElementById: () => null, querySelector: () => null },
      addEventListener: () => undefined,
    }),
    null,
  );
});

test("library AI entry preserves the original single-WebView shell contract", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./library-ai-entry.ts", import.meta.url), "utf8");
  assert.match(source, /library-ai-toolbar-btn/);
  assert.match(source, /\.content-shell/);
  assert.match(source, /ReaderLibraryAiUI\.init\(\{ root \}\)/);
  assert.match(source, /ReaderNewsUI\?\.instance\?\.close/);
  assert.match(source, /ReaderIntelligenceWorkspace\?\.instance\?\.close/);
  assert.match(source, /intelligence-workspace-page/);
  assert.match(source, /library-ai-active/);
  assert.match(source, /preventScroll: true/);
  assert.doesNotMatch(source, /__TAURI__|React|\.tsx|createElement\(/u);
});
