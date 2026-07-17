const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("data import is protected by a recovery point and applied immediately", () => {
  const main = read("src", "main.rs");
  const start = main.indexOf("fn import_data_package");
  const end = main.indexOf("/// 首次加载", start);
  const command = main.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(command.indexOf("backup::create") < command.indexOf("db.import_package"));
  assert.match(command, /data_migration::apply_sqlite_to_runtime/);
  assert.match(main, /backup::spawn_daily/);
});

test("portable entity model is identical on client and sync server", () => {
  const db = read("src", "db.rs");
  const server = read("server", "reader-sync-api", "app.py");
  for (const kind of ["book_state_v2", "vocab", "reading_bucket_v2"]) {
    assert.match(db, new RegExp(`SUPPORTED_ENTITY_KINDS[\\s\\S]*${kind}`));
    assert.match(server, new RegExp(`SUPPORTED_ENTITY_KINDS[\\s\\S]*${kind}`));
  }
  assert.match(db, /purge_legacy_entities/);
  assert.match(server, /record_migration\(conn, 6\)/);
});

test("reader injection is composed from responsibility-focused modules", () => {
  const rust = read("src", "reader_page.rs");
  const modules = [
    "reader-page-style.html",
    "reader-page-layout.js",
    "reader-page-annotations.js",
    "reader-page-runtime.js",
  ];
  for (const name of modules) {
    assert.match(rust, new RegExp(name.replaceAll(".", "\\.")));
    assert.ok(fs.statSync(path.join(root, "ui", name)).size > 0);
  }
  assert.ok(!fs.existsSync(path.join(root, "ui", "reader-page-head.html")));
});

test("reader performance events are bounded and forwarded to the backend", () => {
  const guard = read("ui", "reader-message.js");
  const reader = read("ui", "reader.js");
  const layout = read("ui", "reader-page-layout.js");
  assert.match(guard, /"readerPerf"/);
  assert.match(guard, /action === "readerPerf"[^\n]*1000/);
  assert.match(reader, /invoke\("reader_perf_log", \{ event: e\.data\.readerPerf \}\)/);
  assert.match(layout, /function reportReaderPaintPerf\(name,started,detail\)/);
});

test("reader cross and semantic search keep results from the current book", () => {
  const cross = read("ui", "reader-cross-search-ui.js");
  assert.match(cross, /const list = crossLastResults;/);
  assert.doesNotMatch(cross, /crossLastResults\.filter\([\s\S]*currentId/);
  assert.match(cross, /invoke\("shelf_search", \{ term: crossTerm, ids: null \}\)/);
  assert.match(cross, /invoke\("semantic_search", \{ query: crossTerm, ids: null \}\)/);
});
test("release assets include a sha256 manifest", () => {
  const release = read("scripts", "release.ps1");
  assert.match(release, /Get-FileHash[^\n]+SHA256/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /release upload[^\n]+\$assets\[2\]/);
});

test("search index and memory caches have explicit budgets", () => {
  const cache = read("src", "search_cache.rs");
  const index = read("src", "search_index.rs");
  assert.match(cache, /SEARCH_TEXT_CACHE_BUDGET[^\n]+384 \* 1024 \* 1024/);
  assert.match(index, /INDEX_DISK_BUDGET[^\n]+3 \* 1024 \* 1024 \* 1024/);
  assert.match(index, /INDEX_MAGIC[^\n]+KPIDX003/);
  assert.match(index, /orphan_files/);
});
