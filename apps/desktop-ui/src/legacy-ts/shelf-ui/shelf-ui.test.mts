import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./shelf-ui.ts", import.meta.url), "utf8");

test("strict shelf keeps the frozen DOM, storage, and command surfaces", () => {
  const ids = [
    "shelf", "empty", "shelf-scrollbar", "shelf-scrollbar-thumb", "filter-btn",
    "filter-stars", "tag-filter-list", "collection-filter-list", "organization-match-mode",
    "organization-filter-modal", "booklist-description", "booklist-books", "del-group",
    "del-btn", "book-info-btn", "del-cancel", "mi-selectall", "mi-random",
  ];
  ids.forEach((id) => assert.match(source, new RegExp(`(?:getElementById|required(?:<[^>]+>)?)\\("${id}"\\)`)));

  const storageKeys = [
    "shelfSort", "shelfLayout", "shelfGridColumns", "shelfGridColumnsValue",
    "readingFilter", "minRating", "shelfTagFilter", "shelfCollectionFilter",
    "shelfOrganizationMatchMode", "showCoverProgress", "showCoverRating",
    "showCoverTitle", "shelfSingleClickOpen",
  ];
  storageKeys.forEach((key) => assert.match(source, new RegExp(`"${key}"`)));

  const commands = [
    "add_books_organization", "book_file_sizes", "list_booklists", "list_books",
    "open_book", "prewarm_book", "relocate_book", "remove_books", "set_cover",
    "update_booklist",
  ];
  commands.forEach((command) => assert.match(source, new RegExp(`tauriApi\\.invoke\\("${command}"`)));
});

test("strict shelf preserves the current immediate-open and prewarm contract", () => {
  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /tauriApi\.invoke\("prewarm_book", \{ id: b\.id \}\)/);
  assert.match(card, /addEventListener\("pointerenter", prewarmBook, \{ once: true \}\)/);
  assert.match(card, /addEventListener\("pointerdown", prewarmBook, \{ once: true \}\)/);
  assert.match(card, /addEventListener\("focus", prewarmBook, \{ once: true \}\)/);
  assert.match(card, /if \(e\.metaKey \|\| e\.ctrlKey \|\| selected\.size > 0\)/);
  assert.match(card, /if \(e\.detail > 1\) return;[\s\S]*?openBook\("single"\)/);
  assert.match(card, /selectionTimer = setTimeout\([\s\S]*?\}, 180\)/);
  assert.doesNotMatch(card, /openTimer|220/);
});

test("strict shelf remains an injectable installer without direct Tauri access", () => {
  assert.match(source, /createTauriApi<ShelfCommands>/);
  assert.match(source, /export function installShelfUi\(target: unknown\)/);
  assert.doesNotMatch(source, /__TAURI__/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);
  assert.doesNotMatch(source, /\bany\b\s*[\[<]|:\s*any\b|\bas\s+any\b/);
});
