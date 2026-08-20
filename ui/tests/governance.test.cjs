const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const lineCount = (...parts) => read(...parts).split(/\r?\n/).length;

test("desktop product keeps exactly one UI implementation", () => {
  const packageJson = JSON.parse(read("package.json"));
  const mainHtml = read("ui", "index.html");
  const searchHtml = read("ui", "search.html");
  const desktopSource = path.join(root, "apps", "desktop-ui", "src");
  const visualAlternatives = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (/\.(?:jsx|tsx)$/i.test(entry.name)) visualAlternatives.push(target);
    }
  };
  visit(desktopSource);

  assert.deepEqual(visualAlternatives, [], "a second JSX/TSX page implementation is forbidden");
  assert.equal(packageJson.dependencies?.react, undefined);
  assert.equal(packageJson.dependencies?.["react-dom"], undefined);
  assert.equal(packageJson.devDependencies?.["@vitejs/plugin-react"], undefined);
  assert.doesNotMatch(mainHtml, /react-(?:bridge|low-risk)|shelf-react-loader|about-support-host/i);
  assert.doesNotMatch(searchHtml, /react|loader/i);
  assert.match(searchHtml, /<script src="generated-ts\/search\.js"><\/script>/);

  for (const removedPath of [
    ["ui", "react-low-risk-host.js"],
    ["ui", "shelf-react-loader.js"],
    ["ui", "search-react-loader.js"],
    ["apps", "desktop-ui", "src", "main.tsx"],
  ]) {
    assert.equal(fs.existsSync(path.join(root, ...removedPath)), false, removedPath.join("/") + " must stay removed");
  }

  const visibleSource = [
    ...fs.readdirSync(path.join(root, "ui"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:html|js)$/i.test(entry.name))
      .map((entry) => read("ui", entry.name)),
  ].join("\n");
  assert.doesNotMatch(visibleSource, /打开旧版完整/);
});

test("top-level assembly files stay within anti-monolith budgets", () => {
  assert.ok(
    lineCount("src", "main.rs") <= 510,
    "main.rs must remain a thin Tauri assembly",
  );
  assert.ok(
    lineCount("src", "semantic.rs") <= 350,
    "semantic.rs must remain a facade over semantic submodules",
  );
  assert.ok(
    lineCount("ui", "generated-ts", "app.js") <= 1350,
    "app.js must delegate feature UI modules",
  );
  assert.ok(
    lineCount("apps", "desktop-ui", "src", "legacy-ts", "reader-page-modules", "reader-page-layout-annotations.ts") <= 6000,
    "the combined reader-page migration source must stay within its temporary consolidation budget",
  );
});

test("data import is protected by a recovery point and applied immediately", () => {
  const main = read("src", "main.rs");
  const commands = read("src", "data_commands.rs");
  const start = commands.indexOf("fn import_data_package");
  const command = commands.slice(start);
  assert.match(main, /mod data_commands;/);
  assert.ok(start >= 0);
  assert.ok(
    command.indexOf("backup::create") < command.indexOf("db.import_package"),
  );
  assert.match(command, /data_migration::apply_sqlite_to_runtime/);
  assert.match(main, /backup::spawn_daily/);
});

test("recovery points can be selected and restored with a current-state safeguard", () => {
  const main = read("src", "main.rs");
  const commands = read("src", "data_commands.rs");
  const backup = read("src", "backup.rs");
  const html = read("ui", "index.html");
  const app = read("ui", "generated-ts", "app.js");
  assert.match(main, /data_commands::restore_recovery_backup/);
  assert.match(commands, /fn restore_recovery_backup/);
  assert.match(commands, /webview_windows/);
  const stagedRecovery = backup.indexOf("let mut plans = stage_restore_files");
  const currentStateSafeguard = backup.indexOf(
    "create_locked_with_data(&mut data, true)",
  );
  const databaseCheckpoint = backup.indexOf(
    "*data.db = None;",
    currentStateSafeguard,
  );
  const refreshedBaseline = backup.indexOf(
    "refresh_restore_plan_originals(&mut plans)",
    currentStateSafeguard,
  );
  assert.ok(stagedRecovery >= 0);
  assert.ok(currentStateSafeguard > stagedRecovery);
  assert.ok(databaseCheckpoint > currentStateSafeguard);
  assert.ok(
    refreshedBaseline > databaseCheckpoint,
    "WAL must checkpoint before hashing the live restore baseline",
  );
  assert.match(backup, /reset_runtime_caches_after_restore/);
  assert.match(html, /settings-restore-backup/);
  assert.match(app, /invoke\("restore_recovery_backup", \{ backupId \}\)/);
  assert.match(app, /AppDialog\?\.confirm/);
  assert.match(app, /recoveryConfirmMessage/);
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
  assert.match(startup, /fn supported_existing_book_paths/);
  assert.match(startup, /pub\(crate\) fn open_associated_book_paths/);
  assert.match(main, /tauri::RunEvent::Opened \{ urls \}/);
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
  assert.match(main, /window_commands::persist_main_window_state/);
  assert.doesNotMatch(main, /WindowEvent::(?:Moved|Resized)/);
  assert.match(windows, /library\s*\.try_lock\(\)/);
  assert.doesNotMatch(main, /fn ensure_reader_window/);
  assert.doesNotMatch(main, /fn capture_geom/);
  assert.match(windows, /fn reader_window_id/);
  assert.match(windows, /WebviewWindowBuilder::new/);
  assert.match(windows, /WindowEvent::CloseRequested/);
  for (const dependent of [readerCommands, stats, pdf]) {
    assert.match(dependent, /window_commands::reader_window_id/);
  }
});

test("cold start reveals the shelf only after its first painted frame", () => {
  const config = JSON.parse(read("tauri.conf.json"));
  const main = read("src", "main.rs");
  const state = read("src", "app_state.rs");
  const windows = read("src", "window_commands.rs");
  const app = read("ui", "generated-ts", "app.js");
  assert.equal(config.app.windows[0].visible, false);
  assert.equal(config.app.windows[0].create, false);
  assert.match(
    main,
    /main_config\.width = saved\.w;[\s\S]*?WebviewWindowBuilder::from_config\(app, &main_config\)/,
  );
  assert.match(main, /window_commands::main_window_show/);
  assert.match(
    windows,
    /fn main_window_show[\s\S]*?let app = window\.app_handle\(\)\.clone\(\);[\s\S]*?startup_enhancement::reveal_main\(&app\)/,
  );
  assert.match(app, /function revealMainWindowAfterFirstPaint/);
  assert.match(
    app,
    /shelfUI\.render\(list\);[\s\S]{0,240}revealMainWindowAfterFirstPaint\(\)/,
  );
  const applyGeometry = windows.slice(
    windows.indexOf("pub(crate) fn apply_geom_safe"),
  );
  assert.doesNotMatch(applyGeometry, /window\.show\(\)/);
});

test("desktop bundles re-embed frontend-only changes", () => {
  const build = read("build.rs");
  assert.match(build, /fn watch_tree\(root: &Path, hasher: &mut impl Hasher\)/);
  assert.match(build, /watch_tree\(Path::new\("ui"\), &mut ui_fingerprint\)/);
  assert.match(build, /cargo:rerun-if-changed=\{\}/);
  assert.match(build, /cargo:rustc-env=KUNPENG_UI_ASSET_FINGERPRINT=/);
  assert.doesNotMatch(build, /cargo:rerun-if-changed=ui/);
  assert.match(build, /tauri_build::build\(\)/);
  assert.match(read("src", "main.rs"), /\.build\(tauri::generate_context!\("tauri\.conf\.json"\)\)/);
  const installer = read("scripts", "install-macos-app.sh");
  assert.match(installer, /cargo tauri build --target "\$target_triple"/);
  assert.doesNotMatch(installer, /cargo clean --release --target/);
  assert.match(build, /ensure_embedded_reader_page_output/);
});

test("the CSP-protected main page contains no inline executable script", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.doesNotMatch(html, /<script>\s*[^<]/);
});

test("EPUB runtime, virtual chapters and reader protocol are isolated from app assembly", () => {
  const main = read("src", "main.rs");
  const state = read("src", "app_state.rs");
  const runtime = read("src", "epub_runtime.rs");
  const virtualChapters = read("src", "epub_runtime", "virtual_chapters.rs");
  const protocol = read("src", "reader_protocol.rs");
  const search = read("src", "search.rs");
  assert.match(main, /mod epub_runtime;/);
  assert.match(main, /mod app_state;/);
  assert.match(state, /epub_runtime: crate::epub_runtime::EpubRuntime/);
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
  assert.match(runtime, /use virtual_chapters::\{[\s\S]*?clamp_char_boundary[\s\S]*?split_body_ranges/);
  assert.match(virtualChapters, /fn split_body_ranges/);
  assert.match(runtime, /fn process_virtual_chapter/);
  assert.match(runtime, /public, max-age=604800, immutable/);
  assert.match(runtime, /Access-Control-Allow-Origin/);
  assert.match(protocol, /pub\(crate\) fn strip_tags/);
  assert.match(search, /reader_protocol::strip_tags/);
});

test("library DTOs and shelf commands are isolated from app assembly", () => {
  const main = read("src", "main.rs");
  const state = read("src", "app_state.rs");
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
  assert.match(
    imports,
    /library_commands::\{(?:snapshot, BookDto|BookDto, snapshot)\}/,
  );
});

test("runtime helpers and utility commands stay outside app assembly", () => {
  const main = read("src", "main.rs");
  const state = read("src", "app_state.rs");
  const runtime = read("src", "runtime_support.rs");
  const commands = read("src", "app_commands.rs");
  const startup = read("src", "startup.rs");
  assert.match(main, /mod runtime_support;/);
  assert.match(main, /mod app_commands;/);
  assert.match(state, /BackgroundTaskRegistry::new_persistent_default\(\)/);
  for (const command of [
    "background_task_status",
    "app_version",
    "save_download_image",
    "save_problem_trace_to_desktop",
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
    [
      "src/app_commands.rs",
      "save_translation_credential",
      "SaveTranslationCredentialRequest",
    ],
    ["src/sync.rs", "auth_register_start", "RegistrationStartRequest"],
    ["src/sync.rs", "auth_register_confirm", "RegistrationConfirmRequest"],
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
    assert.match(
      source,
      dtoPattern,
      `${command} request must deserialize camelCase fields`,
    );

    const signature = source.match(
      new RegExp(
        `(?:pub\\(crate\\)\\s+)?(?:async\\s+)?fn\\s+${command}\\s*\\(([\\s\\S]*?)\\)\\s*->`,
      ),
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
    ["generated-ts/reader-notes-ui.js", "add_highlight"],
    ["generated-ts/reader.js", "set_progress"],
    ["generated-ts/reader.js", "edge_tts"],
    ["generated-ts/reader.js", "save_page_cache"],
    ["generated-ts/reader.js", "save_translation_credential"],
    ["generated-ts/reader.js", "translate_text"],
    ["generated-ts/search.js", "open_book_at"],
    ["generated-ts/reader-cross-search-ui.js", "open_book_at"],
  ]) {
    assert.match(
      read("ui", file),
      new RegExp(`invoke\\("${command}",\\s*\\{\\s*request(?:\\s*:)?`),
      `${file} must wrap ${command} fields in request`,
    );
  }
  const syncUi = read("ui", "generated-ts", "sync-ui.js");
  assert.match(syncUi, /invoke\("auth_login",\s*\{\s*request\s*:/);
  assert.match(syncUi, /invoke\("auth_register_start",\s*\{\s*request\s*:/);
  assert.match(syncUi, /invoke\("auth_register_confirm",\s*\{\s*request\s*\}/);
  assert.doesNotMatch(syncUi, /invoke\("auth_register",/);
});

test("portable entity model is identical on client and sync server", () => {
  const db = read("src", "db.rs");
  const server = read("server", "reader-sync-api-rs", "src", "sync.rs");
  for (const kind of [
    "book_state_v2",
    "reading_progress_v1",
    "reading_data_v1",
    "reading_statistics_v1",
    "model_book_tags_v1",
    "user_book_tags_v1",
    "book_collections_v1",
    "booklist_v1",
    "vocab",
    "reading_bucket_v2",
    "ai_reader_config_v1",
    "translation_config_v1",
    "ai_reader_history_entry_v2",
    "secret_bundle_v1",
    "reader_palette_v1",
    "reader_palette_order_v1",
    "app_settings_v1",
  ]) {
    assert.match(db, new RegExp(`SUPPORTED_ENTITY_KINDS[\\s\\S]*${kind}`));
  }
  assert.match(db, /purge_legacy_entities/);
  assert.match(server, /MAX_KIND_BYTES/);
  assert.match(server, /if self\.kind\.is_empty\(\) \|\| self\.kind\.len\(\) > MAX_KIND_BYTES/);
  const privateSync = read("src", "private_sync.rs");
  assert.match(
    privateSync,
    /"reading_data_v1"\s*\|\s*"user_book_tags_v1"\s*\|\s*"book_collections_v1"\s*\|\s*"booklist_v1"/,
  );
  assert.match(
    privateSync,
    /entity_enabled_for_options\(&options, kind\)\.unwrap_or\(false\)/,
  );
});

test("reader injection is composed from responsibility-focused modules", () => {
  const rust = read("src", "reader_page.rs");
  const modules = [
    "reader-page-style.html",
    "generated-reader-page-ts/reader-page-bug-trace.js",
    "generated-reader-page-ts/reader-page-scroll-rules.js",
    "generated-reader-page-ts/reader-page-layout-annotations.js",
    "generated-reader-page-ts/reader-page-mode-switch.js",
    "generated-reader-page-ts/reader-page-runtime.js",
    "generated-reader-page-ts/reader-page-transition.js",
  ];
  for (const name of modules) {
    assert.match(rust, new RegExp(name.replaceAll(".", "\\.")));
    assert.ok(fs.statSync(path.join(root, "ui", name)).size > 0);
  }
  const positions = modules.map((name) => rust.indexOf(name));
  assert.ok(
    positions.every(
      (position, index) => index === 0 || position > positions[index - 1],
    ),
  );
  assert.ok(!fs.existsSync(path.join(root, "ui", "reader-page-head.html")));
  const layout = read("ui", "generated-reader-page-ts", "reader-page-layout-annotations.js");
  const scrollRules = read("ui", "generated-reader-page-ts", "reader-page-scroll-rules.js");
  const pagination = layout;
  const measurement = layout;
  const highlightRules = layout;
  assert.match(scrollRules, /global\.ReaderPageScrollRules = readerPageScrollRules/);
  assert.match(layout, /ReaderPageScrollRules\.pageIndexForTop/);
  assert.match(pagination, /function pageCountSig\(/);
  assert.match(highlightRules, /const ReaderPageHighlightRules =/);
  assert.match(pagination, /function pageLayout\(/);
  assert.match(measurement, /function measureAll\(/);
  assert.match(measurement, /function applyPageCache\(/);
});

test("shelf semantic settings are isolated behind explicit browser APIs", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "generated-ts", "app.js");
  const semanticUi = read("ui", "generated-ts", "semantic-ui.js");
  const cache = read("ui", "generated-ts", "semantic-status-cache.js");
  assert.match(app, /window\.ReaderSemanticUI\.init\(/);
  assert.doesNotMatch(
    app,
    /build_semantic_vectors|semantic_tasks|sem-vector-build/,
  );
  assert.match(semanticUi, /global\.ReaderSemanticUI = Object\.freeze/);
  assert.match(cache, /target\.ReaderSemanticStatusCache = api/);
  assert.ok(
    html.indexOf("generated-ts/semantic-status-cache.js") < html.indexOf("generated-ts/semantic-ui.js"),
  );
  assert.ok(html.indexOf("generated-ts/semantic-ui.js") < html.indexOf("app.js"));
  assert.match(
    read("ui", "generated-ts", "animation-settings-ui.js"),
    /ReaderAnimationSettingsUI/,
  );
  assert.ok(html.indexOf("animation-settings-ui.js") < html.indexOf("app.js"));
});

test("sync and statistics panels expose explicit dependency-injected APIs", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "generated-ts", "app.js");
  const syncUi = read("ui", "generated-ts", "sync-ui.js");
  const statsUi = read("ui", "generated-ts", "stats-ui.js");
  assert.match(app, /window\.ReaderSyncUI\.init\(\{/);
  assert.match(app, /window\.ReaderStatsUI\.init\(\{/);
  assert.doesNotMatch(app, /invoke\("sync_now"|invoke\("reading_stats_range"/);
  assert.match(syncUi, /const publicApi = Object\.freeze/);
  assert.match(syncUi, /global\.ReaderSyncUI = publicApi/);
  assert.match(statsUi, /const publicApi = Object\.freeze/);
  assert.match(statsUi, /global\.ReaderStatsUI = publicApi/);
  assert.ok(html.indexOf("sync-ui.js") < html.indexOf("app.js"));
  assert.ok(html.indexOf("stats-ui.js") < html.indexOf("app.js"));
});

test("shelf rendering, filters and selection are owned by ReaderShelfUI", () => {
  const html = read("ui", "index.html");
  const app = read("ui", "generated-ts", "app.js");
  const shelf = read("ui", "generated-ts", "shelf-ui.js");
  const search = read("ui", "generated-ts", "search-ui.js");
  assert.match(app, /window\.ReaderShelfUI\.init\(\{/);
  assert.doesNotMatch(
    app,
    /let books\s*=|let selected\s*=|function applyView\(|invoke\("remove_books"/,
  );
  assert.doesNotMatch(
    app,
    /getElementById\("filter-stars"|getElementById\("del-btn"|getElementById\("shelf"/,
  );
  assert.match(shelf, /const shelfUi = Object\.freeze/);
  assert.match(shelf, /global\.ReaderShelfUI = shelfUi/);
  assert.match(shelf, /tauriApi\.invoke\("remove_books", \{ ids \}\)/);
  assert.match(shelf, /required\("filter-stars"\)/);
  assert.match(search, /ReaderShelfUI\.setSearchQuery/);
  assert.match(search, /ReaderShelfUI\.getSelectedIds/);
  assert.ok(html.indexOf("generated-ts/shelf-ui.js") < html.indexOf("app.js"));
});

test("reader performance events are bounded and forwarded to the backend", () => {
  const guard = read("ui", "generated-ts", "reader-message.js");
  const reader = read("ui", "generated-ts", "reader.js");
  const transition = read("ui", "generated-reader-page-ts", "reader-page-transition.js");
  assert.match(guard, /"readerPerf"/);
  assert.match(guard, /action === "readerPerf"[^\n]*1e3/);
  assert.match(
    reader,
    /invoke\("reader_perf_log", \{ event: e\.data\.readerPerf \}\)/,
  );
  assert.match(
    transition,
    /function reportReaderPaintPerf\(name, started, detail\)/,
  );
});

test("reader cross and semantic search keep results from the current book", () => {
  const cross = read("ui", "generated-ts", "reader-cross-search-ui.js");
  assert.match(cross, /const list = crossLastResults;/);
  assert.doesNotMatch(cross, /crossLastResults\.filter\([\s\S]*currentId/);
  assert.match(
    cross,
    /invoke\("shelf_search", \{ term: crossTerm, ids: null \}\)/,
  );
  assert.match(
    cross,
    /invoke\("semantic_search", \{ query: crossTerm, ids: null \}\)/,
  );
  assert.match(cross, /invoke\("warm_semantic_model"\)/);
  assert.doesNotMatch(cross, /invoke\("prepare_semantic_search"\)/);
});

test("main-window search keeps typing responsive while large results render", () => {
  const searchUi = read("ui", "generated-ts", "search.js");
  const searchBackend = read("src", "search.rs");
  const semanticBackend = read("src", "semantic", "search.rs");
  const runtime = read("src", "runtime_support.rs");
  assert.match(searchUi, /RESULT_GROUPS_PER_FRAME = 8/);
  assert.match(searchUi, /INITIAL_EXPANDED_BOOKS = 1/);
  assert.match(searchUi, /runtime\.requestAnimationFrame\(appendNextFrame\)/);
  assert.match(searchUi, /if \(group\.classList\.contains\("collapsed"\)\) ensureHits\(\)/);
  assert.match(searchUi, /renderGeneration \+= 1/);
  assert.match(
    searchUi,
    /qEl\.addEventListener\("input", \(\) => \{[\s\S]{0,180}searchSeq \+= 1/,
  );
  const hitScan = read("src", "search", "hit_scan.rs");
  assert.match(hitScan, /const MAX_PREVIEW_HITS: usize = 8/);
  assert.match(hitScan, /previews\.len\(\) < MAX_PREVIEW_HITS/);
  assert.match(searchBackend, /source_fingerprint_from_content_id/);
  assert.match(searchBackend, /pub\(crate\) async fn shelf_search_book_hits/);
  assert.match(searchBackend, /INDEX_BUILD_RUNNING/);
  assert.match(searchBackend, /fn search_one_book_indexed/);
  assert.match(searchBackend, /pending_books: usize/);
  assert.match(
    searchUi,
    /api\.invoke\("shelf_search_book_hits", \{[\s\S]{0,180}limit: 10/,
  );
  assert.match(searchUi, /keywordResponse\.results \?\? \[\]/);
  assert.match(searchUi, /pendingBooks/);
  assert.match(
    searchUi,
    /const inputTerm = qEl\.value\.trim\(\);[\s\S]{0,80}runSearch\(inputTerm\)/,
  );
  assert.doesNotMatch(searchUi, /BM25/);
  assert.match(
    searchBackend,
    /interactive_search_workers\(ready_targets\.len\(\)\)/,
  );
  assert.match(
    semanticBackend,
    /interactive_search_workers\(targets\.len\(\)\)/,
  );
  assert.doesNotMatch(searchUi, /semReady \? invoke\("semantic_search"/);
  assert.doesNotMatch(searchUi, /prepare_semantic_search/);
  assert.match(searchUi, /invoke\("warm_semantic_model"\)/);
  assert.doesNotMatch(semanticBackend, /let _ = prepare\(app\.clone\(\)\)/);
  assert.match(runtime, /saturating_sub\(2\)[\s\S]*\.clamp\(1, 2\)/);
  const interactiveBody = searchBackend.slice(
    searchBackend.indexOf("fn shelf_search_blocking"),
    searchBackend.indexOf(
      "#[tauri::command]\npub(crate) async fn open_search_window",
    ),
  );
  assert.doesNotMatch(interactiveBody, /ensure_search_assets\(/);
  assert.match(interactiveBody, /spawn_build_index\(app\.clone\(\), true\)/);
});
test("release assets include a sha256 manifest", () => {
  const release = read("scripts", "release.ps1");
  assert.match(release, /Get-FileHash[^\n]+SHA256/);
  assert.match(release, /SHA256SUMS\.txt/);
  assert.match(release, /release upload[^\n]+\$assets\[2\]/);
});

test("news webpages may only be framed from HTTPS sources", () => {
  const config = read("tauri.conf.json");
  const news = read("ui", "generated-ts", "news-ui.js");
  assert.match(config, /frame-src[^;]*https:/);
  assert.match(news, /url\.protocol === "https:" \? url\.href : ""/);
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
