import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

const STORAGE_KEY = "readerShellPreloadEnabledV2";
const RECENT_READING_CACHE_STORAGE_KEY = "readerShellRecentReadingCacheEnabledV1";
const DEFAULT_ENABLED = false;

interface PreloadCacheStatus {
  readonly epubDocuments: number;
  readonly metadataEntries: number;
  readonly chapterEntries: number;
  readonly chapterHtmlBytes: number;
  readonly recentReadingChapterCacheEnabled: boolean;
  readonly recentReadingChapterBooks: number;
  readonly recentReadingChapterLimitBytes: number;
}

interface PreloadStatus {
  readonly enabled: boolean;
  readonly pooledShells: number;
  readonly readyShells: number;
  readonly processResidentBytes?: number;
  readonly cache: PreloadCacheStatus;
}

interface ShellBenchmarkSample {
  readonly title: string;
  readonly coverUrl?: string;
  readonly regular: ShellBenchmarkTiming;
  readonly preloaded: ShellBenchmarkTiming;
  readonly improvementMs: number;
}

interface ShellBenchmarkTiming {
  readonly shellMs: number;
  readonly layoutMs: number;
  readonly displayMs: number;
  readonly totalMs: number;
}

interface ShellBenchmark {
  readonly regularMedianMs: number;
  readonly preloadedMedianMs: number;
  readonly improvementMedianMs: number;
  readonly samples: readonly ShellBenchmarkSample[];
}

type ReaderShellPreloadCommands = {
  reader_shell_preload_status: { readonly result: PreloadStatus };
  set_reader_shell_preload_enabled: {
    readonly args: { readonly enabled: boolean };
    readonly result: PreloadStatus;
  };
  set_recent_reading_chapter_cache_enabled: {
    readonly args: { readonly enabled: boolean };
    readonly result: PreloadStatus;
  };
  clear_recent_reading_chapter_cache: { readonly result: PreloadStatus };
  benchmark_reader_shell_opening: { readonly result: ShellBenchmark };
};

type VerifiedReaderShellPreloadCommands =
  ReaderShellPreloadCommands extends TauriCommandMap
    ? ReaderShellPreloadCommands
    : never;

interface ReaderShellPreloadSettingsApi {
  enabled(): boolean;
  refresh(): Promise<void>;
}

interface ReaderShellPreloadRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage?: Storage;
  setTimeout(handler: TimerHandler, timeout?: number): number;
  ReaderShellPreloadSettings?: ReaderShellPreloadSettingsApi;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : null;
}

function runtimeFrom(value: unknown): ReaderShellPreloadRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as ReaderShellPreloadRuntime;
}

function checkbox(value: Element | null): HTMLInputElement | null {
  return value instanceof HTMLInputElement ? value : null;
}

function element(value: Element | null): HTMLElement | null {
  return value instanceof HTMLElement ? value : null;
}

function button(value: Element | null): HTMLButtonElement | null {
  return value instanceof HTMLButtonElement ? value : null;
}

function safeEnabled(storage: Storage | undefined): boolean {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw === null || raw === undefined ? DEFAULT_ENABLED : raw === "1";
  } catch {
    return DEFAULT_ENABLED;
  }
}

function saveEnabled(storage: Storage | undefined, enabled: boolean): void {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Keeping the in-memory choice is still safer than failing a settings UI.
  }
}

function safeRecentReadingCacheEnabled(storage: Storage | undefined): boolean {
  try {
    return storage?.getItem(RECENT_READING_CACHE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function saveRecentReadingCacheEnabled(storage: Storage | undefined, enabled: boolean): void {
  try {
    storage?.setItem(RECENT_READING_CACHE_STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // The next launch simply uses the safe, disabled default.
  }
}

export function formatPreloadBytes(value: number | undefined): string {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatTimingDelta(value: number): string {
  const millis = Math.abs(Math.round(Number(value) || 0));
  return value >= 0 ? `节省 ${millis} ms` : `慢 ${millis} ms`;
}

export function formatStageDuration(value: number): string {
  const millis = Math.max(0, Math.round(Number(value) || 0));
  return millis === 0 ? "<1 ms" : `${millis} ms`;
}

export function formatRecentReadingCacheStatus(cache: PreloadCacheStatus, masterEnabled: boolean): string {
  if (!masterEnabled) return "预加载关闭时不保留最近阅读缓存。";
  if (!cache.recentReadingChapterCacheEnabled) return "已关闭；不会额外保留最近阅读章节。";
  return `已缓存 ${cache.recentReadingChapterBooks}/3 本 · ${formatPreloadBytes(cache.chapterHtmlBytes)} / ${formatPreloadBytes(cache.recentReadingChapterLimitBytes)}`;
}

function benchmarkTimingCell(
  document: Document,
  timing: ShellBenchmarkTiming,
  shellPreloaded: boolean,
): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.className = "reader-shell-preload-timing";
  const stages: readonly [string, string][] = [
    ["外壳", shellPreloaded && timing.shellMs === 0 ? "已就绪" : formatStageDuration(timing.shellMs)],
    ["排版", formatStageDuration(timing.layoutMs)],
    ["首屏加载", formatStageDuration(timing.displayMs)],
    ["总计", formatStageDuration(timing.totalMs)],
  ];
  stages.forEach(([label, value]) => {
    const stage = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = label;
    const duration = document.createElement("strong");
    duration.textContent = value;
    stage.append(name, duration);
    cell.appendChild(stage);
  });
  return cell;
}

function benchmarkCover(document: Document, sample: ShellBenchmarkSample): HTMLElement {
  const cover = document.createElement("div");
  cover.className = "reader-shell-preload-cover";
  cover.setAttribute("aria-label", sample.title);
  const fallback = (): void => {
    cover.replaceChildren();
    cover.classList.add("is-placeholder");
    const title = document.createElement("span");
    title.textContent = sample.title;
    cover.appendChild(title);
  };
  if (!sample.coverUrl) {
    fallback();
    return cover;
  }
  const image = document.createElement("img");
  image.src = sample.coverUrl;
  image.alt = sample.title;
  image.loading = "lazy";
  image.addEventListener("error", fallback, { once: true });
  cover.appendChild(image);
  return cover;
}

function renderBenchmarkRows(document: Document, target: HTMLElement, result: ShellBenchmark): void {
  target.replaceChildren();
  if (!result.samples.length) {
    target.hidden = true;
    return;
  }
  const table = document.createElement("table");
  table.className = "reader-shell-preload-table";
  const head = document.createElement("thead");
  const headerRow = document.createElement("tr");
  ["封面", "普通打开", "预加载", "差值"].forEach((copy) => {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = copy;
    headerRow.appendChild(cell);
  });
  head.appendChild(headerRow);
  const body = document.createElement("tbody");
  result.samples.forEach((sample) => {
    const row = document.createElement("tr");
    const cover = document.createElement("td");
    cover.className = "reader-shell-preload-cover-cell";
    cover.appendChild(benchmarkCover(document, sample));
    const regular = benchmarkTimingCell(document, sample.regular, false);
    const preloaded = benchmarkTimingCell(document, sample.preloaded, true);
    const improvement = document.createElement("td");
    improvement.className = sample.improvementMs >= 0 ? "is-faster" : "is-slower";
    improvement.textContent = formatTimingDelta(sample.improvementMs);
    row.append(cover, regular, preloaded, improvement);
    body.appendChild(row);
  });
  table.append(head, body);
  target.appendChild(table);
  target.hidden = false;
}

export function initializeReaderShellPreloadUi(
  runtime: ReaderShellPreloadRuntime,
  transport: TauriTransport,
): ReaderShellPreloadSettingsApi | null {
  const enabledInput = checkbox(runtime.document.getElementById("reader-shell-preload-enabled"));
  const gear = element(runtime.document.getElementById("reader-shell-preload-gear"));
  const modal = element(runtime.document.getElementById("reader-shell-preload-modal"));
  const close = element(runtime.document.getElementById("reader-shell-preload-close"));
  const statusElement = element(runtime.document.getElementById("reader-shell-preload-status"));
  const benchmarkButton = button(runtime.document.getElementById("reader-shell-preload-benchmark"));
  const benchmarkResult = element(runtime.document.getElementById("reader-shell-preload-benchmark-result"));
  const benchmarkRows = element(runtime.document.getElementById("reader-shell-preload-rows"));
  const recentCacheInput = checkbox(runtime.document.getElementById("reader-shell-recent-cache-enabled"));
  const recentCacheStatus = element(runtime.document.getElementById("reader-shell-recent-cache-status"));
  const recentCacheClear = button(runtime.document.getElementById("reader-shell-recent-cache-clear"));
  if (!enabledInput || !gear || !modal || !close || !statusElement || !benchmarkButton || !benchmarkResult || !benchmarkRows || !recentCacheInput || !recentCacheStatus || !recentCacheClear) return null;

  const api = createTauriApi<VerifiedReaderShellPreloadCommands>(transport);
  let enabled = safeEnabled(runtime.localStorage);
  let recentCacheRequested = safeRecentReadingCacheEnabled(runtime.localStorage);
  let previousResidentBytes: number | undefined;
  let benchmarking = false;

  const clearBenchmark = (): void => {
    benchmarkResult.textContent = "";
    benchmarkResult.classList.remove("is-error");
    benchmarkResult.hidden = true;
    benchmarkRows.replaceChildren();
    benchmarkRows.hidden = true;
  };

  const renderStatus = (status: PreloadStatus, beforeResident?: number): void => {
    enabled = status.enabled;
    enabledInput.checked = enabled;
    if (!enabled) {
      previousResidentBytes = undefined;
      statusElement.textContent = "预加载已关闭。开启后会创建隐藏阅读窗口，并增加进程内存占用。";
      benchmarkButton.disabled = true;
      recentCacheInput.checked = recentCacheRequested;
      recentCacheInput.disabled = true;
      recentCacheClear.disabled = true;
      recentCacheStatus.textContent = formatRecentReadingCacheStatus(status.cache, false);
      clearBenchmark();
      return;
    }
    const resident = status.processResidentBytes;
    const delta = typeof resident === "number" && typeof beforeResident === "number"
      ? resident - beforeResident
      : undefined;
    const residentText = typeof resident === "number"
      ? `进程驻留 ${formatPreloadBytes(resident)}`
      : "进程驻留内存暂不可读取";
    const deltaText = typeof delta === "number" && delta !== 0
      ? `（本次 ${delta > 0 ? "+" : "−"}${formatPreloadBytes(Math.abs(delta))}）`
      : "";
    statusElement.textContent = `隐藏外壳 ${status.readyShells}/${status.pooledShells} 已就绪 · ${residentText}${deltaText}`;
    previousResidentBytes = resident;
    benchmarkButton.disabled = benchmarking;
    recentCacheInput.checked = recentCacheRequested;
    recentCacheInput.disabled = false;
    recentCacheClear.disabled = !status.cache.recentReadingChapterCacheEnabled || status.cache.chapterEntries === 0;
    recentCacheStatus.textContent = formatRecentReadingCacheStatus(status.cache, true);
  };

  const refresh = async (beforeResident?: number): Promise<void> => {
    const status = await api.invoke("reader_shell_preload_status");
    renderStatus(status, beforeResident);
  };

  enabledInput.checked = enabled;
  enabledInput.addEventListener("change", () => {
    const before = previousResidentBytes;
    const requested = enabledInput.checked;
    enabledInput.disabled = true;
    void api.invoke("set_reader_shell_preload_enabled", { enabled: requested })
      .then((status) => api.invoke("set_recent_reading_chapter_cache_enabled", {
        enabled: status.enabled && recentCacheRequested,
      }))
      .then((status) => {
        saveEnabled(runtime.localStorage, status.enabled);
        renderStatus(status, before);
        // Shell creation/destruction is asynchronous on some platforms.
        runtime.setTimeout(() => void refresh(before).catch(() => undefined), 420);
      })
      .catch((error: unknown) => {
        enabledInput.checked = enabled;
        statusElement.textContent = `无法更新预加载设置：${String(error)}`;
      })
      .finally(() => { enabledInput.disabled = false; });
  });

  gear.addEventListener("click", () => {
    modal.classList.add("show");
    void refresh(previousResidentBytes).catch(() => undefined);
  });
  close.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("show");
  });

  recentCacheInput.checked = recentCacheRequested;
  recentCacheInput.addEventListener("change", () => {
    const requested = recentCacheInput.checked;
    recentCacheInput.disabled = true;
    void api.invoke("set_recent_reading_chapter_cache_enabled", { enabled: requested })
      .then((status) => {
        recentCacheRequested = requested;
        saveRecentReadingCacheEnabled(runtime.localStorage, requested);
        renderStatus(status, previousResidentBytes);
        runtime.setTimeout(() => void refresh(previousResidentBytes).catch(() => undefined), 620);
      })
      .catch((error: unknown) => {
        recentCacheInput.checked = recentCacheRequested;
        recentCacheStatus.textContent = `无法更新章节缓存：${String(error)}`;
      })
      .finally(() => { recentCacheInput.disabled = !enabled; });
  });

  recentCacheClear.addEventListener("click", () => {
    recentCacheClear.disabled = true;
    void api.invoke("clear_recent_reading_chapter_cache")
      .then((status) => renderStatus(status, previousResidentBytes))
      .catch((error: unknown) => {
        recentCacheStatus.textContent = `无法清理章节缓存：${String(error)}`;
        recentCacheClear.disabled = !enabled;
      });
  });

  benchmarkButton.addEventListener("click", () => {
    if (!enabled) return;
    benchmarking = true;
    benchmarkButton.disabled = true;
    benchmarkResult.classList.remove("is-error");
    benchmarkResult.hidden = false;
    benchmarkResult.textContent = "正在测速；窗口保持隐藏，不会改变阅读进度…";
    benchmarkRows.replaceChildren();
    benchmarkRows.hidden = true;
    void api.invoke("benchmark_reader_shell_opening")
      .then((result) => {
        renderBenchmarkRows(runtime.document, benchmarkRows, result);
        benchmarkResult.textContent = "";
        benchmarkResult.hidden = true;
        return refresh(previousResidentBytes);
      })
      .catch((error: unknown) => {
        benchmarkResult.classList.add("is-error");
        benchmarkResult.textContent = `测速失败：${String(error)}`;
      })
      .finally(() => {
        benchmarking = false;
        benchmarkButton.disabled = !enabled;
      });
  });

  void api.invoke("set_reader_shell_preload_enabled", { enabled })
    .then((status) => api.invoke("set_recent_reading_chapter_cache_enabled", {
      enabled: status.enabled && recentCacheRequested,
    }))
    .then((status) => renderStatus(status))
    .catch(() => void refresh().catch(() => undefined));

  const globalApi: ReaderShellPreloadSettingsApi = Object.freeze({
    enabled: () => enabled,
    refresh: () => refresh(),
  });
  runtime.ReaderShellPreloadSettings = globalApi;
  return globalApi;
}

/** Classic installer for the unique original settings page. */
export function installReaderShellPreloadUi(
  target: unknown,
  transport?: TauriTransport,
): ReaderShellPreloadSettingsApi | null {
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
  return initializeReaderShellPreloadUi(runtime, resolvedTransport);
}
