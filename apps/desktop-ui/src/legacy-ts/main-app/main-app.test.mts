import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("./app.ts", import.meta.url);

test("main app preserves the frozen original shell contract", async () => {
  const source = await readFile(sourceUrl, "utf8");

  for (const command of [
    "main_window_show",
    "reader_window_open",
    "set_auto_import",
    "external_dict_import",
    "add_books",
    "export_data_package",
    "import_data_package",
    "notes_summary",
    "library_health",
    "open_book",
    "list_books",
    "take_startup_book_paths",
  ]) {
    assert.match(source, new RegExp(`invoke\\(\"${command}\"`), `missing command ${command}`);
  }

  for (const event of [
    "startup-perf",
    "shelf-book-read",
    "book-import-progress",
    "associated-book-open",
    "tauri://drag-enter",
    "tauri://drag-leave",
    "tauri://drag-drop",
    "reader-gesture-action",
  ]) {
    assert.ok(source.includes(`tauriEvent.listen("${event}"`), `missing event ${event}`);
  }

  for (const id of [
    "menu",
    "filter-panel",
    "search-wrap",
    "set-auto-import",
    "fp-settings-modal",
    "external-dict-modal",
    "notes-modal",
    "library-health-modal",
    "drop-hint",
    "book-info-modal",
  ]) {
    assert.ok(source.includes(`getElementById("${id}")`), `missing original DOM id ${id}`);
  }

  assert.match(source, /ReaderSyncUI\.init\(/);
  assert.match(source, /ReaderShelfUI\.init\(/);
  assert.match(source, /ReaderStatsUI\.init\(/);
  assert.match(source, /ReaderSemanticUI\.init\(/);
  assert.match(source, /ReaderBookInfo = Object\.freeze/);
  assert.match(source, /addEventListener\("DOMContentLoaded"/);
  assert.match(source, /transportFromTauriGlobal\(runtime\)/);
  assert.match(source, /dialogsFromTauriGlobal\(runtime\)/);
  assert.doesNotMatch(source, /window\.__TAURI__|runtime\.__TAURI__/);
  assert.doesNotMatch(source, /\bany\b|@ts-ignore|@ts-expect-error|eval\s*\(/);
});

test("sensitive native paths stay in dialog to invoke call stacks", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /const sel = await dialog\.open\([\s\S]*?await importBookPaths\(paths\)/);
  assert.match(source, /const path = await dialog\.save\([\s\S]*?invoke\("export_data_package", \{ path \}\)/);
  assert.match(source, /const path = await dialog\.open\([\s\S]*?invoke\("import_data_package", \{ path \}\)/);
  assert.doesNotMatch(source, /localStorage\.(?:setItem|getItem)\([^\n]*(?:path|paths|dirs)/i);
  assert.doesNotMatch(source, /innerHTML\s*=\s*[^;]*(?:source_path|\.path)/);
});
