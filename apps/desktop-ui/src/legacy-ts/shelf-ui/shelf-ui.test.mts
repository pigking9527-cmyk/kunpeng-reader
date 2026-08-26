import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./shelf-ui.ts", import.meta.url), "utf8");

test("strict shelf keeps the frozen DOM, storage, and command surfaces", () => {
  const ids = [
    "shelf", "empty", "shelf-scrollbar", "shelf-scrollbar-thumb", "filter-btn",
    "filter-stars", "tag-filter-list", "collection-filter-list", "organization-match-mode",
    "organization-filter-modal", "batch-organization-modal", "booklist-description", "booklist-books", "del-group",
    "del-btn", "book-info-btn", "batch-add-booklist-btn", "del-cancel", "mi-selectall", "mi-random",
  ];
  ids.forEach((id) => assert.match(source, new RegExp(`(?:getElementById|required(?:<[^>]+>)?)\\("${id}"\\)`)));

  const storageKeys = [
    "shelfSort", "shelfSortMigrationRevision", "shelfLayout", "shelfGridColumns", "shelfGridColumnsValue",
    "readingFilter", "minRating", "shelfTagFilter", "shelfCollectionFilter",
    "shelfOrganizationMatchMode", "showCoverProgress", "showCoverRating",
    "showCoverTitle",
  ];
  storageKeys.forEach((key) => assert.match(source, new RegExp(`"${key}"`)));

  const commands = [
    "add_books_organization", "book_file_sizes", "list_booklists", "list_books",
    "open_book", "prewarm_book", "relocate_book", "remove_books", "set_cover",
    "update_booklist",
  ];
  commands.forEach((command) => assert.match(source, new RegExp(`tauriApi\\.invoke\\([^\\n]*"${command}"`)));
});

test("strict shelf has one direct-open interaction without a persisted click-mode preference", () => {
  assert.doesNotMatch(source, /shelfSingleClickOpen|shelfOpenInteractionRevision|singleClickOpensBook/);
});

test("strict shelf migrates historical sorting to recent browsing once", () => {
  assert.match(source, /shelfRules\.resolveShelfSortPreference\(/);
  assert.match(source, /localStorage\.getItem\("shelfSortMigrationRevision"\)/);
  assert.match(source, /if \(sortPreference\.shouldPersist\)/);
  assert.match(source, /localStorage\.setItem\("shelfSort", sortPreference\.sortKey\)/);
  assert.match(source, /localStorage\.setItem\("shelfSortMigrationRevision", sortPreference\.revision\)/);
  assert.match(source, /sortKey = radio\.value as ShelfSortKey/);
  assert.match(source, /localStorage\.setItem\("shelfSort", sortKey\)/);
});

test("strict shelf opens immediately with left click and toggles selection with right click", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /tauriApi\.invoke\("prewarm_book", \{ id: b\.id \}\)/);
  assert.match(card, /addEventListener\("pointerenter", \(\) => prewarmBook\(\), \{ once: true \}\)/);
  assert.match(card, /addEventListener\("focus", \(\) => prewarmBook\(\), \{ once: true \}\)/);
  assert.match(card, /shelfRules\.shouldOpenBookOnPrimaryPointerDown\(\{/);
  assert.match(card, /prewarmBook\(true\);\s*openBook\("pointerdown"\)/);
  assert.match(card, /if \(suppressPrimaryMouseClick && e\.detail > 0\)[\s\S]*?openBook\("click"\)/);
  assert.match(card, /addEventListener\("contextmenu",[\s\S]*?e\.preventDefault\(\)[\s\S]*?toggleSelect\(b\.id, card\)/);
  assert.doesNotMatch(card, /primaryOpenTimer|selectionTimer|setTimeout\([\s\S]*?160|addEventListener\("dblclick"|prepare_shelf_reader_target|complete_shelf_reader_target/);
});

test("strict shelf serializes native opens and retains only the latest queued book", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(source, /let shelfBookOpenInFlightId: string \| null = null/);
  assert.match(source, /let queuedShelfBookOpen: \{ readonly id: string; readonly run: \(\) => void \} \| null = null/);
  assert.match(card, /if \(shelfBookOpenInFlightId !== null\)[\s\S]*?queuedShelfBookOpen = \{ id: bookId, run: \(\) => openBook\(input\) \}/);
  assert.match(card, /const finishOpen = \(\) => \{[\s\S]*?queuedShelfBookOpen = null;[\s\S]*?Promise\.resolve\(\)\.then\(queued\.run\)/);
  assert.doesNotMatch(card, /let openingBook = false/);
});

test("strict shelf remains an injectable installer without direct Tauri access", () => {
  assert.match(source, /createTauriApi<ShelfCommands>/);
  assert.match(source, /export function installShelfUi\(target: unknown\)/);
  assert.doesNotMatch(source, /__TAURI__/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);
  assert.doesNotMatch(source, /\bany\b\s*[\[<]|:\s*any\b|\bas\s+any\b/);
});

test("booklist add returns to the shelf and preselects that booklist for multi-select", () => {
  const start = source.indexOf("function appendBooklistAddPicker");
  const end = source.indexOf("function renderBooklist", start);
  const action = source.slice(start, end);
  assert.match(action, /pendingBooklistTarget = list\.name/);
  assert.match(action, /booklistModal\?\.classList\.remove\("show"\)/);
  assert.match(action, /focusShelf\(\)/);
  assert.match(source, /names\.set\(organizationKey\(pendingBooklistTarget\), pendingBooklistTarget\)/);
  assert.doesNotMatch(source, /booklistAddCandidates|搜索可添加到书单的图书|加入已选/);
  assert.doesNotMatch(source, /isFavorite\("booklist"|kind: "booklist"/);
});

test("multi-select exposes an explicit target-booklist action", () => {
  assert.match(source, /required\("batch-add-booklist-btn"\)/);
  assert.match(source, /batchAddBooklistButton\.addEventListener\("click", \(\) => openBatchOrganization\("collections"\)\)/);
  assert.match(source, /title: "书单", action: "加入书单", placeholder: "新建书单"/);
});
