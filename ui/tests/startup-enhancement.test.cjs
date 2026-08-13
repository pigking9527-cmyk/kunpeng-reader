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
  assert.match(
    html,
    /data-i18n="startupEnhancement"[\s\S]*?id="startup-enhancement-gear"[\s\S]*?id="set-startup-enhancement"/,
  );
  assert.match(
    html,
    /id="startup-enhancement-modal"[\s\S]*?data-i18n="continueProcessAfterClose"/,
  );
  assert.match(
    html,
    /id="startup-enhancement-autostart-row"[\s\S]*?data-i18n="launchAtLogin"[\s\S]*?id="startup-enhancement-autostart"/,
  );
  assert.match(
    html,
    /id="startup-enhancement-autostart-background-row"[\s\S]*?data-i18n="launchAtLoginBackground"[\s\S]*?id="startup-enhancement-autostart-background"/,
  );
  assert.match(html, /id="startup-enhancement-high-cost"/);
  assert.doesNotMatch(html, /立即完全退出/);
  assert.doesNotMatch(html, /tray|托盘/i);
  assert.match(html, /src="startup-enhancement-ui\.js"/);
});

test("startup boost settings are localized in all ten catalogs", () => {
  const section = i18n.slice(
    i18n.indexOf("const STARTUP_ENHANCEMENT_COPY"),
    i18n.indexOf("const END_RECOMMENDATION_COPY"),
  );
  for (const locale of [
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "ru",
    "pt-BR",
  ]) {
    const marker = ["zh-CN", "zh-TW", "pt-BR"].includes(locale)
      ? `"${locale}": {`
      : `${locale}: {`;
    const start = section.indexOf(marker);
    assert.notEqual(start, -1, `missing startup boost copy for ${locale}`);
    const nextLocale = section.indexOf("\n  },\n  ", start + marker.length);
    const copy = section.slice(start, nextLocale < 0 ? undefined : nextLocale);
    for (const key of [
      "startupEnhancement",
      "startupEnhancementSettings",
      "launchAtLogin",
      "continueProcessAfterClose",
      "continueHighCostAfterClose",
      "startupEnhancementNote",
      "startupEnhancementHighCostNote",
    ]) {
      assert.match(copy, new RegExp(`${key}:`), `${locale} must define ${key}`);
    }
  }
  for (const locale of [
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "ru",
    "pt-BR",
  ]) {
    const marker = ["zh-CN", "zh-TW", "pt-BR"].includes(locale)
      ? `"${locale}": {`
      : `${locale}: {`;
    const start = section.indexOf(
      marker,
      section.indexOf("const LOGIN_BACKGROUND_COPY"),
    );
    assert.notEqual(start, -1, `missing login background copy for ${locale}`);
    const nextLocale = section.indexOf("\n  },\n  ", start + marker.length);
    const copy = section.slice(start, nextLocale < 0 ? undefined : nextLocale);
    assert.match(
      copy,
      /launchAtLoginBackground:/,
      `${locale} must define launchAtLoginBackground`,
    );
  }
});

test("master off means full exit while master on hides without a tray", () => {
  assert.match(enhancement, /StartupEnhancementConfig[\s\S]*?enabled: bool/);
  assert.match(enhancement, /fn should_keep_running/);
  assert.match(
    main,
    /CloseRequested \{ api, \.\. \}[\s\S]*?should_keep_running[\s\S]*?api\.prevent_close\(\)[\s\S]*?background_main/,
  );
  assert.match(enhancement, /set_skip_taskbar\(true\)[\s\S]*?\.hide\(\)/);
  assert.match(
    enhancement,
    /set_skip_taskbar\(false\)[\s\S]*?\.show\(\)[\s\S]*?\.set_focus\(\)/,
  );
  assert.match(enhancement, /pub\(crate\) fn reveal_main/);
  assert.match(
    enhancement,
    /fn activate_main[\s\S]*?let _ = reveal_main\(app\);/,
  );
  assert.match(
    windowCommands,
    /fn main_window_show[\s\S]*?startup_enhancement::reveal_main\(window\.app_handle\(\)\)/,
  );
  assert.doesNotMatch(enhancement, /TrayIconBuilder|tray::|plugin.*tray/i);
  assert.match(
    main,
    /manage\(startup_enhancement::StartupEnhancementState::load\(\)\)/,
  );
  assert.doesNotMatch(
    enhancement,
    /should_exit_after_update|disabled; exiting|app\.exit\(0\)/,
  );
  assert.match(
    titlebar,
    /closeBtn\?\.addEventListener\("click"[\s\S]*?invoke\("main_window_close"\)/,
  );
  assert.doesNotMatch(titlebar, /syncBackend|Promise\.resolve/);
  assert.match(
    windowCommands,
    /should_keep_running\(&app\)[\s\S]*?persist_main_window_state\(&app, &window\)[\s\S]*?background_main\(&app\)[\s\S]*?return Ok\(\(\)\)/,
  );
  assert.match(
    windowCommands,
    /fn main_window_exit[\s\S]*?EXPLICIT_APPLICATION_EXIT_REQUESTED\.store\(true[\s\S]*?app\.exit\(0\)/,
  );
  assert.match(
    main,
    /ExitRequested \{ api, \.\. \}[\s\S]*?should_keep_running\(app\)[\s\S]*?!window_commands::take_explicit_application_exit_request\(\)[\s\S]*?api\.prevent_exit\(\)/,
  );
  assert.doesNotMatch(html, /id="mi-exit-app"/);
  assert.doesNotMatch(app, /getElementById\("mi-exit-app"\)/);
});

test("cold start reveals natively without waiting for a hidden WebView animation frame", () => {
  const reveal = app.slice(
    app.indexOf("function revealMainWindowAfterFirstPaint"),
    app.indexOf("function debugSettingOn"),
  );
  assert.match(reveal, /mainWindowRevealed = true;[\s\S]*?invoke\("main_window_show"\)/);
  assert.doesNotMatch(reveal, /requestAnimationFrame/);
  assert.match(reveal, /startupPerfLog\([\s\S]*?"main-window-show"[\s\S]*?"error"/);
  assert.match(
    enhancement,
    /fn activate_main[\s\S]*?login_backgrounded[\s\S]*?store\(false[\s\S]*?reveal_main\(app\)/,
  );
});

test("the custom titlebar close button dispatches immediately", () => {
  const handlers = {};
  const calls = [];
  const buttons = Object.fromEntries(
    ["win-min", "win-max", "win-close"].map((id) => [
      id,
      {
        addEventListener: (type, handler) => {
          handlers[`${id}:${type}`] = handler;
        },
      },
    ]),
  );
  vm.runInNewContext(titlebar, {
    window: {
      __TAURI__: {
        core: {
          invoke: (command) => {
            calls.push(command);
            return Promise.resolve();
          },
        },
      },
    },
    document: { getElementById: (id) => buttons[id] || null },
  });

  let prevented = false;
  let stopped = false;
  handlers["win-close:click"]({
    preventDefault: () => {
      prevented = true;
    },
    stopPropagation: () => {
      stopped = true;
    },
  });
  assert.deepEqual(calls, ["main_window_close"]);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});
test("a shortcut activation reaches a hidden instance even without a book path", () => {
  assert.match(startup, /struct AssociatedBookRequest[\s\S]*?activate: bool/);
  assert.match(
    startup,
    /AssociatedBookRequest \{[\s\S]*?activate: true,[\s\S]*?paths/,
  );
  assert.match(
    startup,
    /startup_enhancement::activate_main\(&app, request\.id\)/,
  );
  assert.match(
    startup,
    /fn instance_scope_key\(\) -> String[\s\S]*?crate::profile::instance_scope_key\(\)/,
  );
  assert.doesNotMatch(startup, /CARGO_PKG_VERSION/);
  assert.match(startup, /KunpengReader_\{\}_SingleInstance_Mutex/);
  assert.match(main, /set_title\(startup::VERSIONED_MAIN_WINDOW_TITLE\)/);
  assert.match(startup, /associated-book-request-\{\}\.json/);
  assert.match(
    enhancement,
    /"startup-enhancement"[\s\S]*?"activated"[\s\S]*?hot activation/,
  );
});

test("reader versions share one process scope because their local task state is shared", () => {
  assert.match(startup, /所有版本共享同一实例锁和唤醒通道/);
  assert.match(startup, /升级前后的进程也使用同一锁与文件转发通道/);
  assert.match(startup, /associated-book-request-\{\}\.json/);
});

test("closing pauses high-cost work by default and can explicitly allow it", () => {
  assert.match(startupUi, /continueHighCost: false/);
  assert.match(startupUi, /highCostResumeAtMs/);
  assert.match(
    startupUi,
    /backgroundWorkAllowed:[\s\S]*?Date\.now\(\) >= highCostResumeAtMs/,
  );
  assert.match(
    startupUi,
    /highCostRetryDelay:[\s\S]*?highCostResumeAtMs - Date\.now\(\)/,
  );
  assert.match(
    enhancement,
    /if !config\.continue_high_cost[\s\S]*?request_pause_high_cost\(\)/,
  );
  assert.match(enhancement, /HOT_ACTIVATION_HIGH_COST_GRACE_MS: u64 = 15_000/);
  assert.match(enhancement, /high-cost work delayed 15s/);
  for (const kind of [
    "SemanticModel",
    "SemanticVectors",
    "Accelerator",
    "MultiProfile",
    "FullTextIndex",
    "PageCount",
    "CoverGeneration",
    "LibraryClassification",
  ]) {
    assert.match(tasks, new RegExp(`Self::${kind}`));
  }
  assert.match(
    app,
    /runWhenNoReader[\s\S]*?ReaderStartupEnhancement\?\.backgroundWorkAllowed/,
  );
  assert.match(
    app,
    /highCostRetryDelay[\s\S]*?setTimeout\(\(\) => runWhenNoReader/,
  );
  assert.match(app, /backgroundWorkAllowed\?\.\(\) \|\| !autoImport\.enabled/);
});

test("problem records summarize warm activation latency", () => {
  assert.match(problemTrace, /rust:startup-enhancement/);
  assert.match(
    problemTrace,
    /hot_activation: summarizeDurations\(hotActivations\)/,
  );
});

test("launch at login supports silent Windows and macOS background startup", () => {
  assert.match(enhancement, /launch_at_login: bool/);
  assert.match(enhancement, /launch_at_login_background: bool/);
  assert.match(
    enhancement,
    /launch_at_login_available: cfg!\(any\(target_os = "windows", target_os = "macos"\)\)/,
  );
  assert.match(
    enhancement,
    /HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Run/,
  );
  assert.match(enhancement, /windows_registry_command\(\)[\s\S]*?"add"/);
  assert.match(
    enhancement,
    /background_argument = config[\s\S]*?LOGIN_BACKGROUND_ARGUMENT/,
  );
  assert.match(enhancement, /windows_registry_command\(\)[\s\S]*?"delete"/);
  assert.match(
    enhancement,
    /CommandExt[\s\S]*?creation_flags\(CREATE_NO_WINDOW\)/,
  );
  assert.match(enhancement, /std::env::current_exe\(\)/);
  assert.match(
    enhancement,
    /MACOS_LAUNCH_AGENT_FILE: &str = "com\.kunpeng\.reader\.plist"/,
  );
  assert.match(
    enhancement,
    /\.join\("Library"\)[\s\S]*?\.join\("LaunchAgents"\)/,
  );
  assert.match(enhancement, /macos_launch_agent_plist/);
  assert.match(enhancement, /LOGIN_BACKGROUND_ARGUMENT/);
  assert.match(enhancement, /fn login_background_requested\(\)/);
  assert.match(enhancement, /should_start_login_background/);
  assert.match(
    enhancement,
    /fn reveal_main[\s\S]*?should_start_login_background\(app\)[\s\S]*?return Ok\(\(\)\)/,
  );
  assert.match(enhancement, /atomic_file::write\(&path, plist\.as_bytes\(\)\)/);
  assert.match(startupUi, /launchAtLoginAvailable/);
  assert.match(
    startupUi,
    /launchAtLoginRow\.hidden = !config\.launchAtLoginAvailable/,
  );
  assert.match(
    startupUi,
    /launchAtLoginBackgroundRow\.hidden\s*=\s*!config\.launchAtLoginBackgroundAvailable/,
  );
  assert.match(
    startupUi,
    /launchAtLoginBackground\.disabled\s*=\s*!config\.launchAtLogin\s*\|\|\s*!config\.launchAtLoginBackgroundAvailable/,
  );
  assert.match(
    startupUi,
    /set_startup_enhancement_config[\s\S]*?\.then\(\(saved\)/,
  );
  assert.match(
    main,
    /tauri::RunEvent::Reopen \{[\s\S]*?has_visible_windows: false,[\s\S]*?\.\.[\s\S]*?startup_enhancement::activate_main/,
  );
});
