// 隐藏调试设置页：用于排查启动卡顿、后台任务和阅读页行为。
(function () {
  const modal = document.getElementById("debug-modal");
  if (!modal) return;

  const KEY = "debugSettingsV1";
  const DEFAULTS = {
    bg_auto_import: true,
    bg_cover_preload: true,
    bg_fulltext_index: true,
    bg_semantic_index: true,
    bg_sync: true,
    bg_update_check: true,
    bg_tts_cache: true,
    bg_vocab_polling: true,
    reader_stats_report: true,
    reader_words_detect: true,
    reader_page_measure: true,
    reader_immersive: true,
    reader_cross_search: true,
    reader_footnotes: true,
  };
  const BG = [
    ["bg_auto_import", "自动导入"],
    ["bg_cover_preload", "封面预加载"],
    ["bg_fulltext_index", "全文索引"],
    ["bg_semantic_index", "语义索引"],
    ["bg_sync", "同步"],
    ["bg_update_check", "更新检查"],
    ["bg_tts_cache", "TTS 缓存"],
    ["bg_vocab_polling", "生词本轮询"],
  ];
  const READER = [
    ["reader_stats_report", "阅读统计上报"],
    ["reader_words_detect", "已读字数检测"],
    ["reader_page_measure", "页数测量"],
    ["reader_immersive", "沉浸模式"],
    ["reader_cross_search", "跨书搜索"],
    ["reader_footnotes", "脚注弹窗"],
  ];

  function readSettings() {
    try {
      return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || "{}"));
    } catch (_) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings(settings) {
    localStorage.setItem(KEY, JSON.stringify(settings));
  }
  function makeSwitch(key, label, settings) {
    const row = document.createElement("label");
    row.className = "debug-toggle-row";
    const text = document.createElement("span");
    text.textContent = label;
    const sw = document.createElement("span");
    sw.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key] !== false;
    const slider = document.createElement("span");
    slider.className = "slider";
    input.addEventListener("change", () => {
      const next = readSettings();
      next[key] = input.checked;
      saveSettings(next);
      renderSummary();
    });
    sw.append(input, slider);
    row.append(text, sw);
    return row;
  }
  function renderToggles() {
    const settings = readSettings();
    const bg = document.getElementById("debug-bg-toggles");
    const reader = document.getElementById("debug-reader-toggles");
    bg.innerHTML = "";
    reader.innerHTML = "";
    BG.forEach(([key, label]) => bg.appendChild(makeSwitch(key, label, settings)));
    READER.forEach(([key, label]) => reader.appendChild(makeSwitch(key, label, settings)));
  }
  function readPerfLog() {
    try {
      return JSON.parse(localStorage.getItem("startupPerfLogV1") || "[]");
    } catch (_) {
      return [];
    }
  }
  function renderPerf() {
    const el = document.getElementById("debug-perf");
    const logs = readPerfLog().slice(-28).reverse();
    el.innerHTML = "";
    if (!logs.length) {
      el.textContent = "暂无启动日志";
      return;
    }
    logs.forEach((log) => {
      const row = document.createElement("div");
      row.className = "debug-perf-row";
      row.innerHTML =
        '<span class="muted">+' + (log.at || 0) + "ms</span>" +
        "<span>" + escapeHtml(log.name || "") + " · " + escapeHtml(log.phase || "") + (log.detail ? " · " + escapeHtml(log.detail) : "") + "</span>" +
        '<span class="muted">' + escapeHtml(String(log.session || "").slice(11, 19)) + "</span>";
      el.appendChild(row);
    });
  }
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  }
  async function collectDiagnostics() {
    const settings = readSettings();
    const logs = readPerfLog();
    let version = "";
    let bookCount = 0;
    let runtimeDiagnostics = null;
    try {
      version = await invoke("app_version");
    } catch (_) {}
    try {
      const list = await invoke("list_books");
      bookCount = Array.isArray(list) ? list.length : 0;
    } catch (_) {}
    try {
      runtimeDiagnostics = await invoke("runtime_diagnostics");
    } catch (_) {
      runtimeDiagnostics = { unavailable: true };
    }
    return {
      exported_at: new Date().toISOString(),
      version,
      book_count: bookCount,
      db_size: "待接入后端诊断命令",
      debug_settings: settings,
      startup_logs: logs,
      runtime_diagnostics: runtimeDiagnostics,
      local_storage_keys: Object.keys(localStorage).filter((k) => /^debug|startup|shelf|sync|vocab|show|stats|reading|import/i.test(k)),
    };
  }
  async function renderSummary() {
    const el = document.getElementById("debug-summary");
    const settings = readSettings();
    const off = Object.keys(settings).filter((k) => settings[k] === false).length;
    let bookCount = "?";
    let version = "?";
    try {
      version = await invoke("app_version");
    } catch (_) {}
    try {
      const list = await invoke("list_books");
      bookCount = Array.isArray(list) ? list.length : "?";
    } catch (_) {}
    el.textContent = "版本 v" + version + " · 书籍 " + bookCount + " 本 · 已关闭 " + off + " 个调试开关 · 数据库大小待后端接入";
  }
  async function exportDiagnostics() {
    const data = await collectDiagnostics();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "kunpeng-reader-diagnostics-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function applySafeMode() {
    const settings = readSettings();
    BG.forEach(([key]) => {
      settings[key] = false;
    });
    settings.reader_stats_report = false;
    settings.reader_words_detect = false;
    settings.reader_page_measure = true;
    saveSettings(settings);
    renderToggles();
    renderSummary();
  }
  function openDebugModal() {
    renderToggles();
    renderPerf();
    renderSummary();
    modal.classList.add("show");
  }
  window.openDebugModal = openDebugModal;
  window.getDebugSetting = function getDebugSetting(key) {
    return readSettings()[key] !== false;
  };

  document.getElementById("debug-close")?.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("show");
  });
  document.getElementById("debug-safe-mode")?.addEventListener("click", applySafeMode);
  document.getElementById("debug-export")?.addEventListener("click", exportDiagnostics);

  let verClicks = 0;
  let verTimer = null;
  document.getElementById("about-ver")?.addEventListener("click", () => {
    verClicks += 1;
    if (verTimer) clearTimeout(verTimer);
    verTimer = setTimeout(() => {
      verClicks = 0;
    }, 1600);
    if (verClicks >= 5) {
      verClicks = 0;
      modal.classList.add("show");
      openDebugModal();
    }
  });
})();
