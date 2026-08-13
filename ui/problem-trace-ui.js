// 反馈附件用的问题记录桥接。阅读器窗口与主窗口持续保留脱敏的最近两分钟轨迹，
// 仅在用户点“提交问题记录”时向主窗口返回快照。
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderProblemTraceUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const WINDOW_MS = 2 * 60 * 1000;
  const MAX_SHELL_EVENTS = 320;
  const shellEvents = [];
  let latestReaderSnapshot = null;

  function safeLabel(value, fallback = "other") {
    const label = String(value || "").trim();
    return /^[a-z0-9_.:-]{1,80}$/i.test(label) ? label : fallback;
  }

  function pruneShellEvents(now = Date.now()) {
    const cutoff = now - WINDOW_MS;
    while (shellEvents.length && shellEvents[0].at_ms < cutoff) shellEvents.shift();
    while (shellEvents.length > MAX_SHELL_EVENTS) shellEvents.shift();
  }

  function traceArea(target) {
    const id = String(target?.id || "");
    if (/library-ai/i.test(id) || target?.closest?.("#library-ai-page")) return "library_qa";
    if (/newsnow/i.test(id) || target?.closest?.("#newsnow-page,#newsnow-reader")) return "news";
    if (/stats|reading-timeline/i.test(id) || target?.closest?.("#stats-modal,#reading-timeline-modal")) return "reading_stats";
    if (/bookmark|favorite|collection|book-organization/i.test(id) || target?.closest?.("#book-info-modal,#book-organization-modal")) return "book_organization";
    if (/settings|api-|dict|animation|auto-import|recommendation/i.test(id) || target?.closest?.("#fp-settings-modal,#api-settings-modal,#animation-settings-modal,#external-dict-modal,#auto-import-modal,#reader-recommendation-settings-modal,#newsnow-settings-modal")) return "settings";
    if (/shelf|book-card|mi-|filter|sort/i.test(id) || target?.closest?.("#shelf,#filter-panel")) return "shelf";
    return "main_window";
  }

  function pushShellEvent(type, detail) {
    const now = Date.now();
    pruneShellEvents(now);
    shellEvents.push({
      at_ms: now,
      type: safeLabel(type, "shell_operation"),
      detail,
    });
    pruneShellEvents(now);
  }

  function recordShellOperation(kind, target) {
    pushShellEvent("shell_" + safeLabel(kind, "operation"), {
      source: "main_window",
      area: traceArea(target),
      target: safeLabel(target?.dataset?.problemTarget || target?.id || target?.tagName?.toLowerCase(), "control"),
    });
  }

  function recordShelfBookOpen(outcome, input) {
    pushShellEvent("book_open", {
      source: "main_window",
      area: "shelf",
      outcome: safeLabel(outcome),
      input: safeLabel(input),
    });
  }

  function wireShellOperations(doc = root.document) {
    if (!doc || doc.__problemTraceShellWired) return;
    doc.__problemTraceShellWired = true;
    const record = (event, kind) => {
      const target = event.target?.closest?.("button,[role=button],input,select,textarea,a,[contenteditable=true],[data-problem-target]");
      if (!target || target.matches("textarea,[contenteditable=true]")) return;
      recordShellOperation(kind, target);
    };
    doc.addEventListener("click", (event) => record(event, "click"), true);
    doc.addEventListener("change", (event) => record(event, "change"), true);
  }

  function summarizeDurations(values) {
    const samples = values.filter((value) => Number.isFinite(value) && value >= 0);
    if (!samples.length) return { count: 0, min_ms: 0, avg_ms: 0, max_ms: 0, latest_ms: 0 };
    const total = samples.reduce((sum, value) => sum + value, 0);
    return {
      count: samples.length,
      min_ms: Number(Math.min(...samples).toFixed(1)),
      avg_ms: Number((total / samples.length).toFixed(1)),
      max_ms: Number(Math.max(...samples).toFixed(1)),
      latest_ms: Number(samples.at(-1).toFixed(1)),
    };
  }

  function summarizeReaderPerformance(events) {
    const durations = (predicate) => events
      .filter(predicate)
      .map((event) => Number(event.detail?.duration_ms));
    return {
      window_build: summarizeDurations(durations((event) =>
        event.type === "reader_window" && event.detail?.phase === "open_build" && event.detail?.outcome === "ok")),
      book_info: summarizeDurations(durations((event) =>
        event.type === "reader_performance" && event.detail?.stage === "book_info")),
      first_page_ready: summarizeDurations(durations((event) =>
        event.type === "reader_performance" && event.detail?.stage === "frame_ready")),
      close_destroy: summarizeDurations(durations((event) =>
        event.type === "reader_window" && event.detail?.phase === "destroyed" && event.detail?.outcome === "closed")),
    };
  }

  function startupDuration(detail) {
    const match = String(detail || "").match(/^\s*(\d+(?:\.\d+)?)ms\b/i);
    return match ? Number(match[1]) : NaN;
  }

  function summarizeStartupPerformance(logs) {
    const sessions = new Map();
    (Array.isArray(logs) ? logs : []).forEach((entry) => {
      const session = String(entry?.session || "");
      if (!session) return;
      if (!sessions.has(session)) sessions.set(session, {});
      if (entry?.name === "startup" && ["webview_script", "dom_ready", "shelf_painted"].includes(entry?.phase)) {
        sessions.get(session)[entry.phase] = startupDuration(entry.detail);
      }
    });
    const values = (stage) => [...sessions.values()].map((session) => session[stage]);
    const hotActivations = logs
      .filter((entry) => entry?.name === "rust:startup-enhancement" && entry?.phase === "activated")
      .map((entry) => startupDuration(entry.detail));
    return {
      sessions: sessions.size,
      process_to_webview_script: summarizeDurations(values("webview_script")),
      process_to_dom_ready: summarizeDurations(values("dom_ready")),
      process_to_shelf_painted: summarizeDurations(values("shelf_painted")),
      hot_activation: summarizeDurations(hotActivations),
    };
  }

  function readStartupPerformance(storage = root.localStorage) {
    try {
      return summarizeStartupPerformance(JSON.parse(storage?.getItem?.("startupPerfLogV1") || "[]"));
    } catch (_) {
      return summarizeStartupPerformance([]);
    }
  }

  function storageValue(storage, key) {
    try { return storage?.getItem?.(key); } catch (_) { return null; }
  }

  function storageJson(storage, key, fallback) {
    try {
      const value = storageValue(storage, key);
      return value == null ? fallback : JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }

  function boundedInteger(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
  }

  function choice(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  function safePreferenceText(value) {
    const text = String(value || "").trim();
    return text && text.length <= 80 && !/[\\/\u0000-\u001f]/.test(text) && !/^(?:data:|https?:)/i.test(text) ? text : "";
  }

  function booleanFlags(value, keys, defaults = true) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return Object.fromEntries(keys.map((key) => [key, source[key] !== false && (source[key] !== true ? defaults : source[key]) ]));
  }

  // The problem record is an opt-in support attachment. Keep a strict allowlist
  // of settings that affect behavior or layout, never serializing raw localStorage.
  function collectSoftwareSettings(storage = root.localStorage) {
    const reader = storageJson(storage, "readerSettings", {});
    const palettes = storageJson(storage, "readerCustomPalettesV1", []);
    const bookAppearance = storageJson(storage, "readerBookAppearanceV1", {});
    const animations = storageJson(storage, "readerAnimationSettingsV1", {});
    const debug = storageJson(storage, "debugSettingsV1", {});
    const experimental = storageJson(storage, "kunpeng.reader.experimental-features.v1", {});
    const gesture = storageJson(storage, "kunpeng.reader.news.back-gesture.v2", null);
    const newsSources = storageJson(storage, "kunpeng.reader.news.sources.v2", []);
    const tiebaBars = storageJson(storage, "kunpeng.reader.news.tieba-bars.v1", []);
    const readerAppearance = reader && typeof reader === "object" && !Array.isArray(reader) ? reader : {};
    const settings = {
      language: choice(root.ReaderAppI18n?.selectedLanguage?.(), ["system", "zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"], "system"),
      shelf: {
        sort: choice(storageValue(storage, "shelfSort"), ["title", "author", "imported", "folder", "recent", "reading_time", "size", "progress"], "title"),
        layout: choice(storageValue(storage, "shelfLayout"), ["grid", "list"], "grid"),
        grid_columns: boundedInteger(storageValue(storage, "shelfGridColumnsValue"), 3, 1, 12),
        show_cover_progress: storageValue(storage, "showCoverProgress") !== "0",
        show_cover_rating: storageValue(storage, "showCoverRating") !== "0",
        show_cover_title: storageValue(storage, "showCoverTitle") === "1",
        single_click_opens_book: storageValue(storage, "shelfSingleClickOpen") !== "0",
        search_enabled: storageValue(storage, "shelfSearchEnabled") === "1",
      },
      reader: {
        theme: choice(readerAppearance.theme, ["light", "dark", "sepia"], "light"),
        font_family: safePreferenceText(readerAppearance.fontFamily),
        style_mode: choice(readerAppearance.styleMode, ["local", "book"], "local"),
        text_conversion: choice(readerAppearance.textConversion, ["t2s", "s2t", "none"], "t2s"),
        font_size: boundedInteger(readerAppearance.fontSize, 18, 8, 96),
        note_font_size: boundedInteger(readerAppearance.noteFontSize, 14, 8, 96),
        line_height: boundedInteger(Number(readerAppearance.lineHeight || 1.7) * 100, 170, 80, 400) / 100,
        paragraph_spacing: boundedInteger(Number(readerAppearance.paraSpacing || 0.6) * 100, 60, 0, 1000) / 100,
        letter_spacing: boundedInteger(Number(readerAppearance.letterSpacing || 0) * 100, 0, -1000, 1000) / 100,
        page_mode: choice(readerAppearance.pageMode, ["single", "double"], "single"),
        flow_mode: choice(readerAppearance.flowMode, ["paged", "scroll"], "paged"),
        page_turn_effect: choice(readerAppearance.pageTurnEffect, ["off", "horizontal"], "horizontal"),
        page_turn_speed: boundedInteger(Number(readerAppearance.pageTurnSpeed || 1) * 100, 100, 25, 300) / 100,
        tts_source: choice(readerAppearance.ttsSource, ["edge", "system", "online"], "edge"),
        tts_rate: boundedInteger(Number(readerAppearance.ttsRate || 1) * 100, 100, 25, 400) / 100,
        background_preset: choice(readerAppearance.backgroundPreset, ["light", "dark", "sepia", "custom"], "light"),
        custom_background_color: /^#[0-9a-f]{3,8}$/i.test(String(readerAppearance.customBackgroundColor || "")) ? readerAppearance.customBackgroundColor : "",
        custom_background_image_configured: Boolean(String(readerAppearance.customBackgroundImage || "")),
        custom_palette_count: Array.isArray(palettes) ? Math.min(15, palettes.length) : 0,
        per_book_appearance_count: bookAppearance && typeof bookAppearance === "object" && !Array.isArray(bookAppearance) ? Math.min(10000, Object.keys(bookAppearance).length) : 0,
        show_text_conversion: readerAppearance.showTextConversion !== false,
        show_toc_button: readerAppearance.showTocButton !== false,
        show_chapter_buttons: readerAppearance.showChapterButtons !== false,
        show_vocabulary_button: readerAppearance.showVocabularyButton !== false,
        show_tts_button: readerAppearance.showTtsButton !== false,
        show_annotation_button: readerAppearance.showAnnotationButton !== false,
        show_page_info: readerAppearance.showPageInfo !== false,
        show_reader_jump_back: readerAppearance.showReaderJumpBack !== false,
        jump_back_dismiss_mode: choice(readerAppearance.readerJumpBackDismissMode, ["pages", "time"], "pages"),
        jump_back_dismiss_seconds: boundedInteger(readerAppearance.readerJumpBackDismissSeconds, 30, 1, 600),
        jump_back_dismiss_pages: boundedInteger(readerAppearance.readerJumpBackDismissPages, 3, 1, 100),
        jump_back_icon_size_px: boundedInteger(readerAppearance.readerJumpBackIconSizePx, 32, 30, 160),
      },
      gestures: {
        enabled: storageValue(storage, "kunpeng.reader.news.back-gesture.enabled.v1") !== "0" && storageValue(storage, "kunpeng.reader.news.back-gesture.enabled.v1") !== "false",
        precision: boundedInteger(storageValue(storage, "kunpeng.reader.news.back-gesture.precision.v1"), 5, 1, 10),
        path_saved: Array.isArray(gesture?.points || gesture),
      },
      animations: booleanFlags(animations, ["allAnimations", "mainWindow", "readerPage", "searchPopup", "shelfSearchToggle", "commonSettingsSwitch", "filterButton", "annotationAdd", "readingMode", "pageTurn", "highlightSettings", "booklistSort"]),
      experimental_features: booleanFlags(experimental, ["newsnow", "newsnowPrefetch", "newsnowHideReturnIcon"], false),
      recommendations: {
        enabled: storageValue(storage, "readerEndRecommendationsV1") !== "0",
        min_words: boundedInteger(storageValue(storage, "readerRecommendationMinWordsV1"), 10000, 0, 100000000),
      },
      vocabulary: {
        show_count: storageValue(storage, "vocabShowCount") !== "0",
        sort: choice(storageValue(storage, "vocabSort"), ["time", "word", "count"], "time"),
        auto_speak: storageValue(storage, "vocabAutoSpeak") !== "0",
        disk_audio_cache: storageValue(storage, "wordAudioDiskCache") === "1",
      },
      reading_statistics: {
        chart_metric: choice(storageValue(storage, "statChartMetricV1"), ["time", "words"], "time"),
      },
      news: {
        layout: choice(storageValue(storage, "kunpeng.reader.news.layout.v1"), ["list", "grid"], "list"),
        order: choice(storageValue(storage, "kunpeng.reader.news.order.v1"), ["mixed", "source"], "mixed"),
        selected_source_count: Array.isArray(newsSources) ? Math.min(24, newsSources.length) : 0,
        custom_forum_count: Array.isArray(tiebaBars) ? Math.min(8, tiebaBars.length) : 0,
      },
      debug: booleanFlags(debug, ["bg_cover_preload", "bg_fulltext_index", "bg_semantic_index", "bg_sync", "bg_update_check", "bg_tts_cache", "bg_vocab_polling", "reader_stats_report", "reader_words_detect", "reader_page_measure", "reader_immersive", "reader_cross_search", "reader_footnotes"]),
      omitted_sensitive_settings: ["sync_account", "api_credentials", "translation_credentials", "auto_import_paths", "background_image_content", "saved_queries", "history"],
    };
    const startup = root.ReaderStartupEnhancement?.snapshot?.();
    if (startup && typeof startup === "object") {
      settings.startup_enhancement = {
        enabled: startup.enabled === true,
        continue_high_cost: startup.continueHighCost === true,
        launch_at_login: startup.launchAtLogin === true,
      };
    }
    return settings;
  }
  function mergeShellEvents(snapshot) {
    const capturedAt = Date.now();
    pruneShellEvents(capturedAt);
    const readerEvents = Array.isArray(snapshot.events) ? snapshot.events : [];
    const recentShell = shellEvents.map((event) => ({
      at: new Date(event.at_ms).toISOString(),
      age_ms: Math.max(0, capturedAt - event.at_ms),
      type: event.type,
      detail: event.detail,
    }));
    return {
      ...snapshot,
      captured_at: new Date(capturedAt).toISOString(),
      window_ms: WINDOW_MS,
      privacy: "No book text, selection text, URLs, file paths, account data, API credentials, form values, or raw sensitive settings. Includes an allowlisted snapshot of non-sensitive software settings.",
      software_settings: collectSoftwareSettings(),
      startup_performance: readStartupPerformance(),
      reader_performance: summarizeReaderPerformance(recentShell),
      events: [...readerEvents, ...recentShell].sort((left, right) => String(left.at).localeCompare(String(right.at))),
    };
  }

  function rememberReaderSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const capturedAt = Date.parse(String(snapshot.captured_at || ""));
    if (!Number.isFinite(capturedAt)) return false;
    latestReaderSnapshot = snapshot;
    return true;
  }

  function recentReaderSnapshot(now = Date.now()) {
    if (!latestReaderSnapshot) return null;
    const capturedAt = Date.parse(String(latestReaderSnapshot.captured_at || ""));
    const age = Number(now) - capturedAt;
    return Number.isFinite(age) && age >= -5000 && age <= WINDOW_MS ? latestReaderSnapshot : null;
  }

  function shellOnlySnapshot(now = Date.now()) {
    const navigator = root.navigator || {};
    return {
      schema_version: 1,
      captured_at: new Date(now).toISOString(),
      window_ms: WINDOW_MS,
      privacy: "No book text, selection text, URLs, file paths, account data, API credentials, or form values.",
      version: "",
      system: {
        platform: String(navigator.platform || "").slice(0, 80),
        language: String(navigator.language || "").slice(0, 32),
      },
      book: { title: "", format: "unknown" },
      reader_state: {
        chapter: 0, progress: 0, chapter_frac: 0, total_chapters: 0,
        overlay: "none", toolbar: "normal", frame_ready: false,
        loading: false, is_pdf: false, immersive: false,
        viewport: { width: Number(root.innerWidth) || 0, height: Number(root.innerHeight) || 0 },
      },
      last_click_blocker: "none",
      runtime_diagnostics: null,
      events: [],
    };
  }

  function wireReaderCheckpoints(eventApi = root.__TAURI__?.event) {
    if (!eventApi?.listen) return;
    Promise.resolve(eventApi.listen("reader-bug-trace-checkpoint", (event) => {
      rememberReaderSnapshot(event?.payload?.snapshot);
    })).catch(() => {});
  }

  function restoreShelfDocumentFocus(payload, doc = root.document) {
    if (payload?.phase !== "focus_restore" || !["focused", "requested"].includes(payload?.outcome)) return;
    try { root.focus?.(); } catch (_) {}
    let attempts = 0;
    const verifyFocus = () => {
      try { root.focus?.(); } catch (_) {}
      try { doc?.querySelector?.(".content")?.focus?.({ preventScroll: true }); } catch (_) {}
      attempts += 1;
      if (!doc?.hasFocus?.() && attempts < 6) {
        root.setTimeout?.(verifyFocus, 20);
        return;
      }
      pushShellEvent("main_focus", {
        source: "main_window",
        outcome: doc?.hasFocus?.() ? "focused" : "not_focused",
      });
    };
    root.requestAnimationFrame?.(verifyFocus);
  }
  function wireReaderWindowLifecycle(eventApi = root.__TAURI__?.event) {
    if (!eventApi?.listen) return;
    Promise.resolve(eventApi.listen("reader-window-trace", (event) => {
      const payload = event?.payload || {};
      restoreShelfDocumentFocus(payload);
      pushShellEvent("reader_window", {
        source: "window_backend",
        phase: safeLabel(payload.phase),
        outcome: safeLabel(payload.outcome),
        duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
      });
    })).catch(() => {});
    Promise.resolve(eventApi.listen("reader-performance-trace", (event) => {
      const payload = event?.payload || {};
      pushShellEvent("reader_performance", {
        source: "reader_shell",
        stage: safeLabel(payload.stage),
        duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
      });
    })).catch(() => {});
  }

  async function loadNativeCheckpoint(invoke = root.__TAURI__?.core?.invoke) {
    if (typeof invoke !== "function") return recentReaderSnapshot();
    try {
      const snapshot = await invoke("problem_trace_checkpoint", { snapshot: null });
      if (snapshot) rememberReaderSnapshot(snapshot);
    } catch (_) {}
    return recentReaderSnapshot();
  }

  async function capture({ eventApi = root.__TAURI__?.event, timeoutMs } = {}) {
    await loadNativeCheckpoint();
    if (!eventApi?.listen || !eventApi?.emit) {
      return mergeShellEvents(recentReaderSnapshot() || shellOnlySnapshot());
    }
    const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    const fallbackWaitMs = recentReaderSnapshot() ? 500 : 2500;
    const waitMs = Math.max(10, Number.isFinite(timeoutMs) ? Number(timeoutMs) : fallbackWaitMs);
    return new Promise(async (resolve, reject) => {
      let settled = false;
      let unlisten = null;
      let retryTimer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        root.clearTimeout(timer);
        root.clearTimeout(retryTimer);
        try { unlisten?.(); } catch (_) {}
        callback(value);
      };
      const timer = root.setTimeout(() => {
        const cached = recentReaderSnapshot();
        finish(resolve, mergeShellEvents(cached || shellOnlySnapshot()));
      }, waitMs);
      try {
        unlisten = await eventApi.listen("reader-bug-trace-response", (event) => {
          const payload = event?.payload || {};
          if (payload.request_id !== requestId || !payload.snapshot || typeof payload.snapshot !== "object") return;
          rememberReaderSnapshot(payload.snapshot);
          finish(resolve, mergeShellEvents(payload.snapshot));
        });
        const request = () => eventApi.emit("reader-bug-trace-request", { request_id: requestId });
        await request();
        retryTimer = root.setTimeout(() => {
          if (!settled) Promise.resolve(request()).catch(() => {});
        }, Math.max(5, Math.min(250, waitMs / 3)));
      } catch (error) {
        const cached = recentReaderSnapshot();
        finish(resolve, mergeShellEvents(cached || shellOnlySnapshot()));
      }
    });
  }

  wireShellOperations();
  wireReaderCheckpoints();
  wireReaderWindowLifecycle();
  loadNativeCheckpoint();
  return Object.freeze({
    WINDOW_MS,
    MAX_SHELL_EVENTS,
    capture,
    recordShelfBookOpen,
    _rememberReaderSnapshotForTests: rememberReaderSnapshot,
    _recentReaderSnapshotForTests: recentReaderSnapshot,
    _shellEventsForTests: () => shellEvents.map((event) => ({ ...event, detail: { ...event.detail } })),
    _summarizeStartupPerformanceForTests: summarizeStartupPerformance,
    _collectSoftwareSettingsForTests: collectSoftwareSettings,
  });
});
