const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..", "..");
const app = fs.readFileSync(path.join(root, "ui", "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const controller = fs.readFileSync(path.join(root, "ui", "auto-import-ui.js"), "utf8");
const backend = fs.readFileSync(path.join(root, "src", "import.rs"), "utf8");
const watcher = fs.readFileSync(path.join(root, "src", "auto_import_watch.rs"), "utf8");
const cargo = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");

test("automatic directory imports serialize scans and refresh the shelf while importing", () => {
  assert.ok(html.indexOf("auto-import-ui.js") < html.indexOf("app.js"));
  assert.match(app, /ReaderAutoImportUI\.create/);
  assert.match(controller, /let scanPromise = null/);
  assert.match(controller, /if \(scanPromise\)[\s\S]*?scanQueued = true/);
  assert.match(controller, /while \(scanQueued && isEnabled\(\) && getDirs\(\)\.length\)/);
  assert.match(controller, /progress\.phase === "import"[\s\S]*?scheduleRefresh\(\)/);
  assert.match(controller, /progress\.phase === "done"[\s\S]*?scheduleRefresh\(0\)/);
  assert.match(controller, /refreshShelf[\s\S]*?invoke\("list_books"\)[\s\S]*?renderShelf/);
});

test("the automatic-import switch only changes its enabled state", () => {
  assert.match(html, /data-i18n="autoImport">自动导入<\/span\s*>/);
  assert.doesNotMatch(html, /id="import-dirs-enabled(?:-row|-switch)?"/);
  assert.doesNotMatch(app, /importDirsEnabled(?:Chk|Row)/);
  assert.doesNotMatch(app, /enabled && !autoImport\.dirs\.length/);
  assert.match(app, /dirsGearBtn\.addEventListener\("click",[\s\S]*?openImportDirsSettings\(\)/);
});

test("overlapping automatic scan requests run sequentially and progress refreshes current books", async () => {
  const timers = [];
  const context = {
    clearTimeout() {},
    setTimeout(callback) { timers.push(callback); return timers.length; },
  };
  context.window = context;
  vm.runInNewContext(controller, context);
  const scanResolvers = [];
  const calls = [];
  const rendered = [];
  const ui = context.ReaderAutoImportUI.create({
    invoke(command) {
      calls.push(command);
      if (command === "auto_import_scan") {
        return new Promise((resolve) => scanResolvers.push(resolve));
      }
      if (command === "list_books") return Promise.resolve([{ id: "live" }]);
      throw new Error("unexpected command: " + command);
    },
    isEnabled: () => true,
    getDirs: () => ["D:\\books"],
    countShelf: () => 0,
    renderShelf: (books) => rendered.push(Array.from(books, (book) => book.id)),
    setStatus() {},
    startPerformance: () => () => {},
    logPerformance() {},
    afterAdded() {},
  });

  const first = ui.start("first");
  const second = ui.start("second");
  assert.equal(first, second);
  assert.equal(calls.filter((command) => command === "auto_import_scan").length, 1);
  scanResolvers.shift()([{ id: "first" }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((command) => command === "auto_import_scan").length, 2);
  scanResolvers.shift()([{ id: "first" }, { id: "second" }]);
  await first;
  assert.deepEqual(rendered.slice(0, 2), [["first"], ["first", "second"]]);

  ui.handleProgress({ phase: "import", processed: 5, total: 20, added: 5 });
  timers.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(rendered.at(-1), ["live"]);
});

test("large automatic imports checkpoint completed batches without opening a book", () => {
  const autoImport = backend.slice(
    backend.indexOf("fn run_auto_import_with_progress"),
    backend.indexOf("pub(crate) fn get_auto_import"),
  );
  assert.match(autoImport, /if save_after >= 50[\s\S]*?state\.library\.lock\(\)\.unwrap\(\)\.save\(\)/);
  assert.doesNotMatch(autoImport, /open_book|ensure_reader_window/);
});

test("automatic imports use native recursive watching with debounce and fallback scans", () => {
  assert.match(cargo, /^notify = "8\.2"$/m);
  assert.match(watcher, /notify::recommended_watcher/);
  assert.match(watcher, /RecursiveMode::Recursive/);
  assert.match(watcher, /CHANGE_DEBOUNCE:[^=]*= Duration::from_secs\(3\)/);
  assert.match(watcher, /FALLBACK_SCAN_INTERVAL:[^=]*= Duration::from_secs\(5 \* 60\)/);
  assert.match(watcher, /"auto-import-change"/);
  assert.match(controller, /eventApi\.listen\("auto-import-change"/);
  assert.match(app, /autoImportUI\.bindEvents\(tauriEvent\)/);
  assert.doesNotMatch(app, /debugSettingOn\("bg_auto_import"\)/);
});

test("copying files wait until stable and inaccessible directories return visible errors", () => {
  assert.match(backend, /AUTO_IMPORT_FILE_STABLE_AGE[^=]*= std::time::Duration::from_secs\(3\)/);
  assert.match(backend, /phase: String,[\s\S]*deferred: usize/);
  assert.match(backend, /无法读取自动导入目录/);
  assert.match(controller, /progress\.phase === "waiting"/);
  assert.match(controller, /仍在复制的文件/);
  assert.match(controller, /start\("正在重新检查尚未复制完成的文件…"\)/);
});
