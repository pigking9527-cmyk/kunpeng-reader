const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const root = path.join(ui, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("ui", "index.html");
const i18n = read("ui", "app-i18n.js");
const startupUi = read("ui", "startup-enhancement-ui.js");
const titlebar = read("ui", "titlebar.js");
const styles = read("ui", "styles.css");
const app = read("ui", "app.js");
const main = read("src", "main.rs");
const startup = read("src", "startup.rs");
const enhancement = read("src", "startup_enhancement.rs");
const windowCommands = read("src", "window_commands.rs");
const tasks = read("src", "background_tasks.rs");
const problemTrace = read("ui", "problem-trace-ui.js");

test("common settings expose startup boost with a gear and master switch", () => {
  assert.match(html, /data-i18n="startupEnhancement"[\s\S]*?id="startup-enhancement-gear"[\s\S]*?id="set-startup-enhancement"/);
  assert.match(html, /id="startup-enhancement-modal"[\s\S]*?data-i18n="continueProcessAfterClose"/);
  assert.match(html, /id="startup-enhancement-high-cost"/);
  assert.doesNotMatch(html, /立即完全退出/);
  assert.doesNotMatch(html, /tray|托盘/i);
  assert.match(html, /src="startup-enhancement-ui\.js"/);
});

test("startup boost settings are localized in all ten catalogs", () => {
  const section = i18n.slice(i18n.indexOf("const STARTUP_ENHANCEMENT_COPY"), i18n.indexOf("const END_RECOMMENDATION_COPY"));
  for (const locale of ["zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"]) {
    const marker = ["zh-CN", "zh-TW", "pt-BR"].includes(locale) ? `"${locale}": {` : `${locale}: {`;
    const start = section.indexOf(marker);
    const end = section.indexOf("\n    ", start + marker.length);
    const copy = section.slice(start, end < 0 ? undefined : end);
    assert.notEqual(start, -1, `missing startup boost copy for ${locale}`);
    for (const key of ["startupEnhancement", "startupEnhancementSettings", "continueProcessAfterClose", "continueHighCostAfterClose", "startupEnhancementNote", "startupEnhancementHighCostNote"]) {
      assert.match(copy, new RegExp(`${key}:`), `${locale} must define ${key}`);
    }
  }
});

test("master off means full exit while master on hides without a tray", () => {
  assert.match(enhancement, /StartupEnhancementConfig[\s\S]*?enabled: bool/);
  assert.match(enhancement, /fn should_keep_running/);
  assert.match(main, /CloseRequested \{ api, \.\. \}[\s\S]*?should_keep_running[\s\S]*?api\.prevent_close\(\)[\s\S]*?background_main/);
  assert.match(enhancement, /set_skip_taskbar\(true\)[\s\S]*?\.hide\(\)/);
  assert.match(enhancement, /set_skip_taskbar\(false\)[\s\S]*?\.show\(\)[\s\S]*?\.set_focus\(\)/);
  assert.doesNotMatch(enhancement, /TrayIconBuilder|tray::|plugin.*tray/i);
  assert.match(main, /manage\(startup_enhancement::StartupEnhancementState::load\(\)\)/);
  assert.match(titlebar, /closeBtn\?\.addEventListener\("click"[\s\S]*?invoke\("main_window_close"\)/);
  assert.doesNotMatch(titlebar, /syncBackend|Promise\.resolve/);
  assert.match(windowCommands, /should_keep_running\(&app\)[\s\S]*?persist_main_window_state\(&app, &window\)[\s\S]*?background_main\(&app\)[\s\S]*?return Ok\(\(\)\)/);
});

test("the custom titlebar close button dispatches immediately", () => {
  const handlers = {};
  const calls = [];
  const buttons = Object.fromEntries(["win-min", "win-max", "win-close"].map((id) => [id, {
    addEventListener: (type, handler) => { handlers[`${id}:${type}`] = handler; },
  }]));
  vm.runInNewContext(titlebar, {
    window: { __TAURI__: { core: { invoke: (command) => { calls.push(command); return Promise.resolve(); } } } },
    document: { getElementById: (id) => buttons[id] || null },
  });

  let prevented = false;
  let stopped = false;
  handlers["win-close:click"]({
    preventDefault: () => { prevented = true; },
    stopPropagation: () => { stopped = true; },
  });
  assert.deepEqual(calls, ["main_window_close"]);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});
test("a shortcut activation reaches a hidden instance even without a book path", () => {
  assert.match(startup, /struct AssociatedBookRequest[\s\S]*?activate: bool/);
  assert.match(startup, /AssociatedBookRequest \{[\s\S]*?activate: true,[\s\S]*?paths/);
  assert.match(startup, /startup_enhancement::activate_main\(&app, request\.id\)/);
  assert.match(startup, /FindWindowW[\s\S]*?ShowWindow\(hwnd, SW_RESTORE\)[\s\S]*?SetForegroundWindow\(hwnd\)/);
  assert.doesNotMatch(startup, /IsIconic/);
  assert.match(startup, /FindWindowW[\s\S]*?ShowWindow\(hwnd, SW_RESTORE\)[\s\S]*?SetForegroundWindow\(hwnd\)/);
  assert.doesNotMatch(startup, /IsIconic/);
  assert.match(enhancement, /"startup-enhancement"[\s\S]*?"activated"[\s\S]*?hot activation/);
});

test("closing pauses high-cost work by default and can explicitly allow it", () => {
  assert.match(startupUi, /continueHighCost: false/);
  assert.match(startupUi, /backgroundWorkAllowed: \(\) => !backgrounded \|\| config\.continueHighCost/);
  assert.match(enhancement, /if !config\.continue_high_cost[\s\S]*?request_pause_high_cost\(\)/);
  for (const kind of ["SemanticModel", "SemanticVectors", "Accelerator", "MultiProfile", "FullTextIndex", "PageCount", "CoverGeneration", "LibraryClassification"]) {
    assert.match(tasks, new RegExp(`Self::${kind}`));
  }
  assert.match(app, /runWhenNoReader[\s\S]*?ReaderStartupEnhancement\?\.backgroundWorkAllowed/);
  assert.match(app, /backgroundWorkAllowed\?\.\(\) \|\| !autoImport\.enabled/);
});

test("problem records summarize warm activation latency", () => {
  assert.match(problemTrace, /rust:startup-enhancement/);
  assert.match(problemTrace, /hot_activation: summarizeDurations\(hotActivations\)/);
});
