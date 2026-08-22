import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type DebugCommands = {
  app_version: { readonly result: unknown };
  list_books: { readonly result: unknown };
  runtime_diagnostics: { readonly result: unknown };
};

type VerifiedDebugCommands = DebugCommands extends TauriCommandMap
  ? DebugCommands
  : never;

type DebugSettingKey =
  | "bg_cover_preload"
  | "bg_fulltext_index"
  | "bg_semantic_index"
  | "bg_sync"
  | "bg_update_check"
  | "bg_tts_cache"
  | "bg_vocab_polling"
  | "reader_stats_report"
  | "reader_words_detect"
  | "reader_page_measure"
  | "reader_immersive"
  | "reader_cross_search"
  | "reader_footnotes";

type DebugSettings = Record<DebugSettingKey, boolean>;
type DebugPair = readonly [DebugSettingKey, string];

interface DebugRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Storage;
  readonly Blob: typeof Blob;
  readonly URL: typeof URL;
  readonly Date: DateConstructor;
  setTimeout(handler: () => void, timeout: number): number;
  clearTimeout(handle: number): void;
  openDebugModal?: () => void;
  getDebugSetting?: (key: string) => boolean;
}

export interface DebugUiApi {
  openDebugModal(): void;
  getDebugSetting(key: string): boolean;
}

const KEY = "debugSettingsV1";
const DEFAULTS: DebugSettings = Object.freeze({
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
});
const BG: readonly DebugPair[] = Object.freeze([
  ["bg_cover_preload", "封面预加载"],
  ["bg_fulltext_index", "全文索引"],
  ["bg_semantic_index", "语义索引"],
  ["bg_sync", "同步"],
  ["bg_update_check", "更新检查"],
  ["bg_tts_cache", "TTS 缓存"],
  ["bg_vocab_polling", "生词本轮询"],
]);
const READER: readonly DebugPair[] = Object.freeze([
  ["reader_stats_report", "阅读统计上报"],
  ["reader_words_detect", "已读字数检测"],
  ["reader_page_measure", "页数测量"],
  ["reader_immersive", "沉浸模式"],
  ["reader_cross_search", "跨书搜索"],
  ["reader_footnotes", "脚注弹窗"],
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): DebugRuntime | null {
  const target = record(value);
  if (!target || !record(target.document) || !record(target.localStorage)) return null;
  return target as unknown as DebugRuntime;
}

function htmlElement(value: Element | null): HTMLElement | null {
  return typeof HTMLElement !== "undefined" && value instanceof HTMLElement ? value : null;
}

function escapeHtml(value: unknown): string {
  const map: Readonly<Record<string, string>> = Object.freeze({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
  });
  return String(value || "").replace(/[&<>]/gu, (character) => map[character] ?? character);
}

export function initializeDebugUi(
  runtime: DebugRuntime,
  transport: TauriTransport,
): DebugUiApi | null {
  const { document, localStorage } = runtime;
  const modal = htmlElement(document.getElementById("debug-modal"));
  if (!modal) return null;
  const api = createTauriApi<VerifiedDebugCommands>(transport);

  const readSettings = (): DebugSettings => {
    try {
      const stored = record(JSON.parse(localStorage.getItem(KEY) || "{}")) ?? {};
      return Object.assign({}, DEFAULTS, stored) as DebugSettings;
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  };
  const saveSettings = (settings: DebugSettings): void => {
    localStorage.setItem(KEY, JSON.stringify(settings));
  };
  let renderSummary = async (): Promise<void> => undefined;
  const makeSwitch = (
    key: DebugSettingKey,
    label: string,
    settings: DebugSettings,
  ): HTMLLabelElement => {
    const row = document.createElement("label");
    row.className = "debug-toggle-row";
    const text = document.createElement("span");
    text.textContent = label;
    const switchElement = document.createElement("span");
    switchElement.className = "switch";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = settings[key] !== false;
    const slider = document.createElement("span");
    slider.className = "slider";
    input.addEventListener("change", () => {
      const next = readSettings();
      next[key] = input.checked;
      saveSettings(next);
      void renderSummary();
    });
    switchElement.append(input, slider);
    row.append(text, switchElement);
    return row;
  };
  const renderToggles = (): void => {
    const settings = readSettings();
    const background = htmlElement(document.getElementById("debug-bg-toggles"));
    const reader = htmlElement(document.getElementById("debug-reader-toggles"));
    if (!background || !reader) return;
    background.innerHTML = "";
    reader.innerHTML = "";
    BG.forEach(([key, label]) => background.appendChild(makeSwitch(key, label, settings)));
    READER.forEach(([key, label]) => reader.appendChild(makeSwitch(key, label, settings)));
  };
  const readPerfLog = (): unknown[] => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem("startupPerfLogV1") || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  };
  const renderPerf = (): void => {
    const element = htmlElement(document.getElementById("debug-perf"));
    if (!element) return;
    const logs = readPerfLog().slice(-28).reverse();
    element.innerHTML = "";
    if (!logs.length) {
      element.textContent = "暂无启动日志";
      return;
    }
    logs.forEach((rawLog) => {
      const log = record(rawLog) ?? {};
      const row = document.createElement("div");
      row.className = "debug-perf-row";
      row.innerHTML =
        `<span class="muted">+${Number(log.at) || 0}ms</span>` +
        `<span>${escapeHtml(log.name)} · ${escapeHtml(log.phase)}${log.detail ? ` · ${escapeHtml(log.detail)}` : ""}</span>` +
        `<span class="muted">${escapeHtml(String(log.session || "").slice(11, 19))}</span>`;
      element.appendChild(row);
    });
  };
  const collectDiagnostics = async (): Promise<Record<string, unknown>> => {
    let version: unknown = "";
    let bookCount = 0;
    let runtimeDiagnostics: unknown = null;
    try {
      version = await api.invoke("app_version");
    } catch {
      // Keep the original empty version fallback.
    }
    try {
      const list = await api.invoke("list_books");
      bookCount = Array.isArray(list) ? list.length : 0;
    } catch {
      // Keep the original zero book fallback.
    }
    try {
      runtimeDiagnostics = await api.invoke("runtime_diagnostics");
    } catch {
      runtimeDiagnostics = { unavailable: true };
    }
    return {
      exported_at: new runtime.Date().toISOString(),
      version,
      book_count: bookCount,
      db_size: "待接入后端诊断命令",
      debug_settings: readSettings(),
      startup_logs: readPerfLog(),
      runtime_diagnostics: runtimeDiagnostics,
      local_storage_keys: Object.keys(localStorage).filter((key) =>
        /^debug|startup|shelf|sync|vocab|show|stats|reading|import/iu.test(key),
      ),
    };
  };
  renderSummary = async (): Promise<void> => {
    const element = htmlElement(document.getElementById("debug-summary"));
    if (!element) return;
    const settings = readSettings();
    const off = Object.keys(settings).filter(
      (key) => settings[key as DebugSettingKey] === false,
    ).length;
    let bookCount: number | "?" = "?";
    let version: unknown = "?";
    try {
      version = await api.invoke("app_version");
    } catch {
      // Keep the original question-mark fallback.
    }
    try {
      const list = await api.invoke("list_books");
      bookCount = Array.isArray(list) ? list.length : "?";
    } catch {
      // Keep the original question-mark fallback.
    }
    element.textContent = `版本 v${String(version)} · 书籍 ${bookCount} 本 · 已关闭 ${off} 个调试开关 · 数据库大小待后端接入`;
  };
  const exportDiagnostics = async (): Promise<void> => {
    const data = await collectDiagnostics();
    const blob = new runtime.Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = runtime.URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `kunpeng-reader-diagnostics-${new runtime.Date().toISOString().replace(/[:.]/gu, "-")}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    runtime.setTimeout(() => runtime.URL.revokeObjectURL(url), 1_000);
  };
  const applySafeMode = (): void => {
    const settings = readSettings();
    BG.forEach(([key]) => {
      settings[key] = false;
    });
    settings.reader_stats_report = false;
    settings.reader_words_detect = false;
    settings.reader_page_measure = true;
    saveSettings(settings);
    renderToggles();
    void renderSummary();
  };
  const openDebugModal = (): void => {
    renderToggles();
    renderPerf();
    void renderSummary();
    modal.classList.add("show");
  };
  const getDebugSetting = (key: string): boolean => {
    const settings = readSettings() as Record<string, boolean>;
    return settings[key] !== false;
  };

  runtime.openDebugModal = openDebugModal;
  runtime.getDebugSetting = getDebugSetting;
  document.getElementById("debug-close")?.addEventListener("click", () =>
    modal.classList.remove("show"),
  );
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("show");
  });
  document.getElementById("debug-safe-mode")?.addEventListener("click", applySafeMode);
  document.getElementById("debug-export")?.addEventListener("click", () => {
    void exportDiagnostics();
  });
  let versionClicks = 0;
  let versionTimer: number | null = null;
  document.getElementById("about-ver")?.addEventListener("click", () => {
    versionClicks += 1;
    if (versionTimer !== null) runtime.clearTimeout(versionTimer);
    versionTimer = runtime.setTimeout(() => {
      versionClicks = 0;
    }, 1_600);
    if (versionClicks >= 5) {
      versionClicks = 0;
      modal.classList.add("show");
      openDebugModal();
    }
  });
  return Object.freeze({ openDebugModal, getDebugSetting });
}

export function installDebugUi(
  target: unknown,
  transport?: TauriTransport,
): DebugUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      return null;
    }
  }
  return initializeDebugUi(runtime, resolvedTransport);
}
