const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const lineCount = (...parts) => read(...parts).split(/\r?\n/).length;

test("top-level assembly files stay within anti-monolith budgets", () => {
  assert.ok(lineCount("src", "main.rs") <= 500, "main.rs must remain a thin Tauri assembly");
  assert.ok(
    lineCount("src", "semantic.rs") <= 350,
    "semantic.rs must remain a facade over semantic submodules",
  );
  assert.ok(lineCount("ui", "app.js") <= 1350, "app.js must delegate feature UI modules");
  assert.ok(
    lineCount("ui", "reader-page-layout.js") <= 2500,
    "reader-page-layout.js must delegate pagination and measurement",
  );
});

test("data import is protected by a recovery point and applied immediately", () => {
  const main = read("src", "main.rs");
  const commands = read("src", "data_commands.rs");
  const start = commands.indexOf("fn import_data_package");
  const command = commands.slice(start);
  assert.match(main, /mod data_commands;/);
  assert.ok(start >= 0);
  assert.ok(command.indexOf("backup::create") < command.indexOf("db.import_package"));
  assert.match(command, /data_migration::apply_sqlite_to_runtime/);
  assert.match(main, /backup::spawn_daily/);
});

test("recovery points can be selected and restored with a current-state safeguard", () => {
  const main = read("src", "main.rs");
  const commands = read("src", "data_commands.rs");
  const backup = read("src", "backup.rs");
  const html = read("ui", "index.html");
  const app = read("ui", "app.js");
  assert.match(main, /data_commands::restore_recovery_backup/);
  assert.match(commands, /fn restore_recovery_backup/);
  assert.match(commands, /webview_windows/);
  const stagedRecovery = backup.indexOf("let plans = stage_restore_files");
  const currentStateSafeguard = backup.indexOf("create_locked_with_data(&mut data, true)");
  assert.ok(stagedRecovery >= 0);
  assert.ok(currentStateSafeguard > stagedRecovery);
  assert.match(backup, /reset_runtime_caches_after_restore/);
  assert.match(html, /settings-restore-backup/);
  assert.match(app, /invoke\("restore_recovery_backup", \{ backupId \}\)/);
  assert.match(app, /软件会先自动创建一个当前数据的保护恢复点/);
});

test("startup file association and single-instance forwarding are isolated from app assembly", () => {
  const main = read("src", "main.rs");
  const startup = read("src", "startup.rs");
  assert.match(main, /mod startup;/);
  assert.match(main, /startup::startup_book_paths\(\)/);
  assert.match(main, /startup::ensure_single_instance/);
  assert.match(main, /startup::spawn_associated_book_watcher/);
  assert.match(main, /startup::spawn_maintenance/);
  assert.match(main, /startup::take_startup_book_paths/);
  assert.doesNotMatch(main, /fn associated_book_paths/);
  assert.doesNotMatch(main, /fn ensure_single_instance/);
  assert.match(startup, /AssociatedBookRequest/);
  assert.match(startup, /atomic_file::write_json/);
  assert.match(startup, /associated-book-open/);
});

test("window lifecycle and geometry are isolated behind window commands", () => {
  const main = read("src", "main.rs");
  const library = read("src", "library_commands.rs");
  const windows = read("src", "window_commands.rs");
  const readerCommands = read("src", "reader_commands.rs");
  const stats = read("src", "stats.rs");
  const pdf = read("src", "pdf_support.rs");
  assert.match(main, /window_commands::reader_window_open/);
  assert.match(library, /window_commands::ensure_reader_window/);
  assert.match(main, /window_commands::apply_geom_safe/);
  assert.match(main, /window_commands::capture_geom/);
  assert.doesNotMatch(main, /fn ensure_reader_window/);
  assert.doesNotMatch(main, /fn capture_geom/);
  assert.match(windows, /fn reader_window_id/);
  assert.match(windows, /WebviewWindowBuilder::new/);
  assert.match(windows, /WindowEvent::CloseRequested/);
  for (const dependent of [readerCommands, stats, pdf]) {
    assert.match(dependent, /window_commands::reader_window_id/);
  }
});

test("EPUB runtime, virtual chapters and reader protocol are isolated from app assembly", () => {
  const main = read("src", "main.rs");
  const runtime = read("src", "epub_runtime.rs");
  const protocol = read("src", "reader_protocol.rs");
  const search = read("src", "search.rs");
  assert.match(main, /mod epub_runtime;/);
  assert.match(main, /epub_runtime: epub_runtime::EpubRuntime/);
  assert.match(
    main,
    /register_asynchronous_uri_scheme_protocol\("reader", epub_runtime::handle_protocol_request\)/,
  );
  assert.match(main, /epub_runtime::book_info/);
  assert.match(main, /epub_runtime::search_book/);
  assert.doesNotMatch(main, /fn ensure_epub_loaded/);
  assert.doesNotMatch(main, /fn handle_request/);
  assert.doesNotMatch(main, /VIRTUAL_CHAPTER_TARGET_BYTES/);
  assert.match(runtime, /pub\(crate\) const CACHE_VERSION: u32 = 3/);
  assert.match(runtime, /CACHE_COMPAT_VERSIONS: &\[u32\] = &\[2, 3\]/);
  assert.match(runtime, /fn split_body_ranges/);
  assert.match(runtime, /fn process_virtual_chapter/);
  assert.match(runtime, /public, max-age=604800, immutable/);
  assert.match(runtime, /Access-Control-Allow-Origin/);
  assert.match(protocol, /pub\(crate\) fn strip_tags/);
  assert.match(search, /reader_protocol::strip_tags/);
});

test("library DTOs and shelf commands are isolated from app assembly", () => {
  const main = read("src", "main.rs");
  const library = read("src", "library_commands.rs");
  const imports = read("src", "import.rs");
  assert.match(main, /mod library_commands;/);
  for (const command of [
    "list_books",
    "shelf_books",
    "set_progress",
    "open_book",
    "open_book_at",
    "take_pending_jump",
    "set_cover",
    "remove_books",
    "relocate_book",
  ]) {
    assert.match(main, new RegExp(`library_commands::${command}`));
  }
  assert.doesNotMatch(main, /struct BookDto/);
  assert.doesNotMatch(main, /fn list_books/);
  assert.doesNotMatch(main, /fn open_book_at/);
  assert.match(library, /pub\(crate\) struct BookDto/);
  assert.match(library, /pub\(crate\) fn snapshot/);
  assert.match(library, /epub_runtime::map_physical_chapter_for_book/);
  assert.match(imports, /library_commands::\{snapshot, BookDto\}/);
});

test("runtime helpers and utility commands stay outside app assembly", () => {
  const main = read("src", "main.rs");
  const runtime = read("src", "runtime_support.rs");
  const commands = read("src", "app_commands.rs");
  const startup = read("src", "startup.rs");
  assert.match(main, /mod runtime_support;/);
  assert.match(main, /mod app_commands;/);
  assert.match(main, /BackgroundTaskRegistry::new_persistent_default\(\)/);
  for (const command of [
    "background_task_status",
    "app_version",
    "save_download_image",
    "dict_lookup",
    "translate_text",
    "reader_perf_log",
    "open_url",
  ]) {
    assert.match(main, new RegExp(`app_commands::${command}`));
  }
  assert.doesNotMatch(main, /fn reader_perf_log/);
  assert.doesNotMatch(main, /fn translate_text/);
  assert.doesNotMatch(main, /fn spawn_startup_maintenance/);
  assert.match(runtime, /pub\(crate\) fn log/);
  assert.match(runtime, /pub\(crate\) fn now_ms/);
  assert.match(runtime, /pub\(crate\) const RES_BASE/);
  assert.match(startup, /pub\(crate\) fn spawn_maintenance/);
  assert.match(startup, /library_commands::spawn_fingerprint_fill/);
});

test("complex Tauri commands keep business fields behind one camelCase request DTO", () => {
  const commands = [
    ["src/reader_commands.rs", "add_highlight", "AddHighlightRequest"],
    ["src/app_commands.rs", "translate_text", "TranslateTextRequest"],
    ["src/app_commands.rs", "save_translation_credential", "SaveTranslationCredentialRequest"],
    ["src/sync.rs", "auth_register", "AuthRequest"],
    ["src/sync.rs", "auth_login", "AuthRequest"],
    ["src/pdf_support.rs", "save_page_cache", "SavePageCacheRequest"],
    ["src/library_commands.rs", "set_progress", "SetProgressRequest"],
    ["src/library_commands.rs", "open_book_at", "OpenBookAtRequest"],
    ["src/tts.rs", "edge_tts", "EdgeTtsRequest"],
  ];

  for (const [relativePath, command, dto] of commands) {
    const source = read(...relativePath.split("/"));
    const dtoPattern = new RegExp(
      `#\\[derive\\([^\\]]*Deserialize[^\\]]*\\)\\][\\s\\S]{0,160}` +
      `#\\[serde\\(rename_all = "camelCase"\\)\\][\\s\\S]{0,80}` +
      `pub\\(crate\\) struct ${dto}\\b`,
    );
    assert.match(source, dtoPattern, `${command} request must deserialize camelCase fields`);

    const signature = source.match(
      new RegExp(`(?:pub\\(crate\\)\\s+)?(?:async\\s+)?fn\\s+${command}\\s*\\(([\\s\\S]*?)\\)\\s*->`),
    );
    assert.ok(signature, `${command} signature must be discoverable`);
    const businessArguments = signature[1]
      .replace(
        /(?:window:\s*tauri::WebviewWindow|app:\s*tauri::AppHandle|state:\s*tauri::State(?:<'_,\s*AppState>|<AppState>))\s*,?/g,
        "",
      )
      .replace(/^\s*,|,\s*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    assert.equal(
      businessArguments,
      `request: ${dto}`,
      `${command} must not expose raw business arguments`,
    );
  }

  for (const [file, command] of [
    ["reader-notes-ui.js", "add_highlight"],
    ["reader.js", "set_progress"],
    ["reader.js", "edge_tts"],
    ["reader.js", "save_page_cache"],
    ["reader.js", "save_translation_credential"],
    ["reader.js", "translate_text"],
    ["search.js", "open_book_at"],
    ["reader-cross-search-ui.js", "open_book_at"],
  ]) {
    assert.match(
      read("ui", file),
      new RegExp(`invoke\\("${command}",\\s*\\{\\s*request\\s*:`),
      `${file} must wrap ${command} fields in request`,
    );
  }
  assert.match(
    read("ui", "sync-ui.js"),
    /invoke\(isRegister \? "auth_register" : "auth_login",\s*\{\s*request\s*:/,
  );
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
    "reader-page-pagination.js",
    "reader-page-measurement.js",
    "reader-page-annotations.js",
    "reader-page-runtime.js",
  ];
  for (const name of modules) {
    assert.match(rust, new RegExp(name.replaceAll(".", "\\.")));
    assert.ok(fs.statSync(path.join(root, "ui", name)).size > 0);
  }
  const positions = modules.map((name) => rust.indexOf(name));
  assert.ok(positions.every((position, index) => index === 0 || position > positions[index - 1]));
  assert.ok(!fs.existsSync(path.join(root, "ui", "reader-page-head.html")));
  const layout = read("ui", "reader-page-layout.js");
  const pagination = read("ui", "reader-page-pagination.js");
  const measurement = read("ui", "reader-page-measurement.js");
  assert.doesNotMatch(layout, /function pageCountSig\(/);
  assert.doesNotMatch(layout, /function measureAll\(/);
  assert.match(pagination, /function pageCountSig\(/);
  assert.match(pagination, /function pageLayout\(/);
  assert.match(measurement, /function measureAll\(/);
  assert.match(measurement, /function applyPageCache\(/);
});

test("shelf semantic settings are isolated behind explicit browser APIs", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "app.js");
  const semanticUi = read("ui", "semantic-ui.js");
  const cache = read("ui", "semantic-status-cache.js");
  assert.match(app, /window\.ReaderSemanticUI\.init\(/);
  assert.doesNotMatch(app, /build_semantic_vectors|semantic_tasks|sem-vector-build/);
  assert.match(semanticUi, /global\.ReaderSemanticUI = Object\.freeze/);
  assert.match(cache, /global\.ReaderSemanticStatusCache = Object\.freeze/);
  assert.ok(html.indexOf("semantic-status-cache.js") < html.indexOf("semantic-ui.js"));
  assert.ok(html.indexOf("semantic-ui.js") < html.indexOf("app.js"));
});

test("sync and statistics panels expose explicit dependency-injected APIs", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "app.js");
  const syncUi = read("ui", "sync-ui.js");
  const statsUi = read("ui", "stats-ui.js");
  assert.match(app, /window\.ReaderSyncUI\.init\(\{/);
  assert.match(app, /window\.ReaderStatsUI\.init\(\{/);
  assert.doesNotMatch(app, /invoke\("sync_now"|invoke\("reading_stats_range"/);
  assert.match(syncUi, /global\.ReaderSyncUI = Object\.freeze/);
  assert.match(statsUi, /global\.ReaderStatsUI = Object\.freeze/);
  assert.ok(html.indexOf("sync-ui.js") < html.indexOf("app.js"));
  assert.ok(html.indexOf("stats-ui.js") < html.indexOf("app.js"));
});

test("shelf rendering, filters and selection are owned by ReaderShelfUI", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "app.js");
  const shelf = read("ui", "shelf-ui.js");
  const search = read("ui", "search-ui.js");
  assert.match(app, /window\.ReaderShelfUI\.init\(\{/);
  assert.doesNotMatch(app, /let books\s*=|let selected\s*=|function applyView\(|invoke\("remove_books"/);
  assert.doesNotMatch(app, /getElementById\("filter-stars"|getElementById\("del-btn"|getElementById\("shelf"/);
  assert.match(shelf, /global\.ReaderShelfUI = Object\.freeze/);
  assert.match(shelf, /invoke\("remove_books", \{ ids \}\)/);
  assert.match(shelf, /getElementById\("filter-stars"\)/);
  assert.match(search, /window\.ReaderShelfUI\.setSearchQuery/);
  assert.match(search, /window\.ReaderShelfUI\.getSelectedIds/);
  assert.ok(html.indexOf("shelf-ui.js") < html.indexOf("app.js"));
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
  assert.match(cross, /invoke\("warm_semantic_model"\)/);
  assert.doesNotMatch(cross, /invoke\("prepare_semantic_search"\)/);
});

test("main-window search keeps typing responsive while large results render", () => {
  const searchUi = read("ui", "search.js");
  const searchBackend = read("src", "search.rs");
  const semanticBackend = read("src", "semantic", "search.rs");
  const runtime = read("src", "runtime_support.rs");
  assert.match(searchUi, /RESULT_GROUPS_PER_FRAME = 8/);
  assert.match(searchUi, /INITIAL_EXPANDED_BOOKS = 1/);
  assert.match(searchUi, /window\.requestAnimationFrame\(appendNextFrame\)/);
  assert.match(searchUi, /if \(willOpen\) ensureHits\(\)/);
  assert.match(searchUi, /renderGeneration \+= 1/);
  assert.match(searchUi, /qEl\.addEventListener\("input", \(\) => \{[\s\S]{0,180}searchSeq \+= 1/);
  assert.match(searchBackend, /hits\.len\(\) < 8/);
  assert.match(searchBackend, /source_fingerprint_from_content_id/);
  assert.match(searchBackend, /pub\(crate\) async fn shelf_search_book_hits/);
  assert.match(searchBackend, /INDEX_BUILD_RUNNING/);
  assert.match(searchBackend, /fn search_one_book_indexed/);
  assert.match(searchBackend, /pending_books: usize/);
  assert.match(searchUi, /invoke\("shelf_search_book_hits", \{[\s\S]{0,180}limit: 10/);
  assert.match(searchUi, /response\?\.results/);
  assert.match(searchUi, /pendingBooks/);
  assert.match(searchUi, /const inputTerm = qEl\.value\.trim\(\);[\s\S]{0,80}runSearch\(inputTerm\)/);
  assert.doesNotMatch(searchUi, /BM25/);
  assert.match(searchBackend, /interactive_search_workers\(ready_targets\.len\(\)\)/);
  assert.match(semanticBackend, /interactive_search_workers\(targets\.len\(\)\)/);
  assert.doesNotMatch(searchUi, /semReady \? invoke\("semantic_search"/);
  assert.doesNotMatch(searchUi, /prepare_semantic_search/);
  assert.match(searchUi, /invoke\("warm_semantic_model"\)/);
  assert.doesNotMatch(semanticBackend, /let _ = prepare\(app\.clone\(\)\)/);
  assert.match(runtime, /saturating_sub\(2\)[\s\S]*\.clamp\(1, 2\)/);
  const interactiveBody = searchBackend.slice(
    searchBackend.indexOf("fn shelf_search_blocking"),
    searchBackend.indexOf("#[tauri::command]\npub(crate) async fn open_search_window"),
  );
  assert.doesNotMatch(interactiveBody, /ensure_search_assets\(/);
  assert.match(interactiveBody, /spawn_build_index\(app\.clone\(\)\)/);
});
test("release assets include a sha256 manifest", () => {
  const release = read("scripts", "release.ps1");
  assert.match(release, /Get-FileHash[^\n]+SHA256/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /release upload[^\n]+\$assets\[2\]/);
});

test("search index and memory caches have explicit budgets", () => {
  const cache = read("src", "search_cache.rs");
  const memory = read("src", "memory_budget.rs");
  const index = read("src", "search_index.rs");
  assert.match(cache, /memory_budget::plan\(\)\.search_text_bytes/);
  assert.match(memory, /struct RuntimeMemoryBudget/);
  assert.match(memory, /semantic_graph_bytes/);
  assert.match(memory, /cache_total_bytes/);
  assert.match(index, /INDEX_DISK_BUDGET[^\n]+3 \* 1024 \* 1024 \* 1024/);
  assert.match(index, /INDEX_MAGIC[^\n]+KPIDX004/);
  assert.match(index, /struct SourceFingerprint/);
  assert.match(index, /sha256: \[u8; 32\]/);
  assert.match(index, /orphan_files/);
});
