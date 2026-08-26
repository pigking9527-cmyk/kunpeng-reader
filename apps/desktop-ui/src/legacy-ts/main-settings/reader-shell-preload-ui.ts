import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

const STORAGE_KEY = "readerShellPreloadEnabledV2";
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
  readonly innerEngineReadyShells: number;
  readonly innerEngineHeapBytes?: number;
  readonly processResidentBytes?: number;
  readonly preloadMemoryLimitBytes: number;
  readonly cache: PreloadCacheStatus;
  readonly recentOpen?: ActualReaderOpenStatus;
}

interface ActualReaderOpenStatus {
  readonly sampleCount: number;
  readonly format: string;
  readonly preloadPath: "preloaded_hit" | "cold_window" | "pdf_bypass" | "unknown";
  readonly clickToFirstScreenMs: number;
  readonly firstScreenToRefillMs: number;
  readonly clickToCompleteMs: number;
  readonly refillOutcome: "ready" | "disabled" | "timeout";
  readonly p50FirstScreenMs: number;
  readonly p95FirstScreenMs: number;
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
  readonly contentMs: number;
  readonly stylesMs: number;
  readonly domMs: number;
  readonly resourcesMs: number;
  readonly paginationMs: number;
  readonly layoutMs: number;
  readonly displayMs: number;
  readonly totalMs: number;
  readonly p95Ms: number;
  readonly detailed: boolean;
}

interface ShellBenchmark {
  readonly regularMedianMs: number;
  readonly preloadedMedianMs: number;
  readonly regularP95Ms: number;
  readonly preloadedP95Ms: number;
  readonly improvementMedianMs: number;
  readonly rounds: number;
  readonly samples: readonly ShellBenchmarkSample[];
}

type ReaderShellPreloadCommands = {
  reader_shell_preload_status: { readonly result: PreloadStatus };
  set_reader_shell_preload_enabled: {
    readonly args: { readonly enabled: boolean; readonly textConversion: "t2s" | "s2t" };
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

function activeTextConversion(storage: Storage | undefined): "t2s" | "s2t" {
  try {
    const settings = JSON.parse(storage?.getItem("readerSettings") || "{}") as Record<string, unknown>;
    return settings.textConversion === "s2t" ? "s2t" : "t2s";
  } catch {
    return "t2s";
  }
}

function saveEnabled(storage: Storage | undefined, enabled: boolean): void {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Keeping the in-memory choice is still safer than failing a settings UI.
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

export function formatBenchmarkSummary(result: ShellBenchmark): string {
  const improvement = Math.round(Number(result.improvementMedianMs) || 0);
  const waitingDelta = improvement >= 0
    ? `减少 ${Math.abs(improvement)} ms`
    : `增加 ${Math.abs(improvement)} ms`;
  return `${Math.max(1, Math.round(result.rounds))} 轮 EPUB 交替测速 · 完全冷开 P50 ${formatStageDuration(result.regularMedianMs)} / P95 ${formatStageDuration(result.regularP95Ms)} · 预加载命中 P50 ${formatStageDuration(result.preloadedMedianMs)} / P95 ${formatStageDuration(result.preloadedP95Ms)} · 点击后等待${waitingDelta}`;
}

export function formatActualReaderOpen(status: ActualReaderOpenStatus | undefined): string {
  if (!status) return "尚无本次启动后的书架实际打开记录";
  const path = status.preloadPath === "preloaded_hit"
    ? "命中外壳＋内层引擎"
    : status.preloadPath === "pdf_bypass"
      ? "PDF 独立冷开（不使用 EPUB 预加载）"
      : status.preloadPath === "cold_window"
        ? "未命中预加载，重新建窗"
        : "打开路径未确认";
  const refill = status.refillOutcome === "timeout"
    ? `补池等待 ${formatStageDuration(status.firstScreenToRefillMs)}（超时后转后台）`
    : status.refillOutcome === "disabled"
      ? "预加载已关闭"
      : `首屏后补池 ${formatStageDuration(status.firstScreenToRefillMs)}`;
  return `${status.format} · ${path} · 点击→首屏 ${formatStageDuration(status.clickToFirstScreenMs)} · ${refill} · 完整命令 ${formatStageDuration(status.clickToCompleteMs)} · 同路径最近 ${Math.max(1, Math.round(status.sampleCount))} 次 P50/P95 ${formatStageDuration(status.p50FirstScreenMs)}/${formatStageDuration(status.p95FirstScreenMs)}`;
}

export function measuredPreloadBytes(status: PreloadStatus): number {
  return Math.max(0, Number(status.innerEngineHeapBytes) || 0)
    + Math.max(0, Number(status.cache.chapterHtmlBytes) || 0);
}

export function formatCombinedPreloadMemory(status: PreloadStatus): string {
  const used = status.enabled ? measuredPreloadBytes(status) : 0;
  return `${formatPreloadBytes(used)} / ${formatPreloadBytes(status.preloadMemoryLimitBytes)}`;
}

export function formatPreloadComponents(status: PreloadStatus): string {
  if (!status.enabled) return "外壳 已关闭 · 引擎 已关闭 · 最近阅读缓存 已关闭";
  const cacheState = !status.cache.recentReadingChapterCacheEnabled
    ? "已关闭"
    : status.cache.recentReadingChapterBooks > 0
      ? "已就绪"
      : "准备中";
  return `外壳 ${status.readyShells}/${status.pooledShells} · 引擎 ${status.innerEngineReadyShells}/${status.pooledShells} · 最近阅读缓存 ${cacheState}`;
}

function benchmarkTimingCell(
  document: Document,
  timing: ShellBenchmarkTiming,
  preloadKind: "none" | "shell" | "engine",
): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.className = "reader-shell-preload-timing";
  const shellLabel = preloadKind === "engine" ? "外壳＋引擎" : preloadKind === "shell" ? "外壳" : "窗口与外壳";
  const shellValue = preloadKind !== "none" && timing.shellMs === 0 ? "已就绪" : formatStageDuration(timing.shellMs);
  const stages: readonly [string, string][] = timing.detailed ? [
    [shellLabel, shellValue],
    ["内容准备", formatStageDuration(timing.contentMs)],
    ["样式等待", formatStageDuration(timing.stylesMs)],
    ["DOM 构建", formatStageDuration(timing.domMs)],
    ["字体与图片", formatStageDuration(timing.resourcesMs)],
    ["分页定位", formatStageDuration(timing.paginationMs)],
    ["排版合计", formatStageDuration(timing.layoutMs)],
    ["显示确认", formatStageDuration(timing.displayMs)],
    ["总计 P50", formatStageDuration(timing.totalMs)],
    ["总计 P95", formatStageDuration(timing.p95Ms)],
  ] : [
    [shellLabel, shellValue],
    ["排版", formatStageDuration(timing.layoutMs)],
    ["显示确认", formatStageDuration(timing.displayMs)],
    ["总计 P50", formatStageDuration(timing.totalMs)],
    ["总计 P95", formatStageDuration(timing.p95Ms)],
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
  ["封面", "EPUB 完全冷开", "EPUB 预加载命中", "点击后等待降低"].forEach((copy) => {
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
    const regular = benchmarkTimingCell(document, sample.regular, "none");
    const preloaded = benchmarkTimingCell(document, sample.preloaded, "engine");
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
  const recentCacheStatus = element(runtime.document.getElementById("reader-shell-recent-cache-status"));
  const recentCacheClear = button(runtime.document.getElementById("reader-shell-recent-cache-clear"));
  const actualOpenStatus = element(runtime.document.getElementById("reader-shell-actual-open-status"));
  if (!enabledInput || !gear || !modal || !close || !statusElement || !benchmarkButton || !benchmarkResult || !benchmarkRows || !recentCacheStatus || !recentCacheClear || !actualOpenStatus) return null;

  const benchmarkDescription = benchmarkButton.closest("section")?.querySelector("p");
  if (benchmarkDescription) {
    benchmarkDescription.textContent = "仅以 EPUB 为样本：完全冷开会清除该书内存阅读缓存并新建窗口；预加载命中从缓存、外壳和内层引擎均已就绪后计时。下方另列书架真实点击到首屏耗时，PDF 不参与预加载命中测速。";
  }

  const api = createTauriApi<VerifiedReaderShellPreloadCommands>(transport);
  let enabled = safeEnabled(runtime.localStorage);
  let benchmarking = false;

  const clearBenchmark = (): void => {
    benchmarkResult.textContent = "";
    benchmarkResult.classList.remove("is-error");
    benchmarkResult.hidden = true;
    benchmarkRows.replaceChildren();
    benchmarkRows.hidden = true;
  };

  const renderStatus = (status: PreloadStatus): void => {
    enabled = status.enabled;
    enabledInput.checked = enabled;
    statusElement.textContent = formatPreloadComponents(status);
    recentCacheStatus.textContent = formatCombinedPreloadMemory(status);
    actualOpenStatus.textContent = formatActualReaderOpen(status.recentOpen);
    if (!enabled) {
      benchmarkButton.disabled = true;
      recentCacheClear.disabled = true;
      clearBenchmark();
      return;
    }
    benchmarkButton.disabled = benchmarking;
    recentCacheClear.disabled = !status.cache.recentReadingChapterCacheEnabled || status.cache.recentReadingChapterBooks === 0;
  };

  const refresh = async (): Promise<void> => {
    const status = await api.invoke("reader_shell_preload_status");
    renderStatus(status);
  };

  enabledInput.checked = enabled;
  enabledInput.addEventListener("change", () => {
    const requested = enabledInput.checked;
    enabledInput.disabled = true;
    void api.invoke("set_reader_shell_preload_enabled", {
      enabled: requested,
      textConversion: activeTextConversion(runtime.localStorage),
    })
      .then((status) => {
        saveEnabled(runtime.localStorage, status.enabled);
        renderStatus(status);
        // Shell creation/destruction is asynchronous on some platforms.
        runtime.setTimeout(() => void refresh().catch(() => undefined), 420);
      })
      .catch((error: unknown) => {
        enabledInput.checked = enabled;
        statusElement.textContent = `无法更新预加载设置：${String(error)}`;
      })
      .finally(() => { enabledInput.disabled = false; });
  });

  gear.addEventListener("click", () => {
    modal.classList.add("show");
    void refresh().catch(() => undefined);
  });
  close.addEventListener("click", () => modal.classList.remove("show"));
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("show");
  });

  recentCacheClear.addEventListener("click", () => {
    recentCacheClear.disabled = true;
    void api.invoke("clear_recent_reading_chapter_cache")
      .then((status) => renderStatus(status))
      .catch((error: unknown) => {
        recentCacheStatus.textContent = `无法清理最近阅读缓存：${String(error)}`;
        recentCacheClear.disabled = !enabled;
      });
  });

  benchmarkButton.addEventListener("click", () => {
    if (!enabled) return;
    benchmarking = true;
    benchmarkButton.disabled = true;
    benchmarkResult.classList.remove("is-error");
    benchmarkResult.hidden = false;
    benchmarkResult.textContent = "正在交替测试 EPUB 完全冷开与预加载命中；预加载的后台准备不计入点击后等待，PDF 不参与…";
    benchmarkRows.replaceChildren();
    benchmarkRows.hidden = true;
    void api.invoke("benchmark_reader_shell_opening")
      .then((result) => {
        renderBenchmarkRows(runtime.document, benchmarkRows, result);
        benchmarkResult.textContent = formatBenchmarkSummary(result);
        benchmarkResult.hidden = false;
        return refresh();
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

  void api.invoke("set_reader_shell_preload_enabled", {
    enabled,
    textConversion: activeTextConversion(runtime.localStorage),
  })
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
