import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import type { ReaderShellApi } from "../reader-entries/reader-shell-state.js";

type UnknownRecord = Record<string, unknown>;
type LegacyInvoke = TauriTransport["invoke"];

interface AiProfile extends UnknownRecord {
  readonly id?: string;
  readonly name?: string;
  readonly model?: string;
  readonly configured?: boolean;
}

interface AiHistoryEntry extends UnknownRecord {
  readonly id?: string;
  readonly task?: string;
  readonly question?: string;
  readonly content?: string;
  readonly sources?: readonly AiSource[];
  readonly at?: string;
  readonly cloudSaved?: boolean;
  readonly deletedAt?: string;
}

interface AiSource extends UnknownRecord {
  readonly sourceKind?: string;
  readonly chapter?: number;
  readonly excerpt?: string;
}

interface AiHistorySnapshot extends UnknownRecord {
  readonly syncEnabled?: boolean;
  readonly syncMode?: string;
  readonly entries?: readonly AiHistoryEntry[];
}

interface AiAnswer extends UnknownRecord {
  readonly content?: string;
  readonly sources?: readonly AiSource[];
  readonly retrievalStages?: readonly string[];
  readonly citationChecked?: boolean;
}

interface ReaderMediaVideoStatus extends UnknownRecord {
  readonly taskId?: string;
  readonly status?: string;
  readonly absolutePath?: string;
  readonly message?: string;
}

interface ReaderMediaImageResult extends UnknownRecord {
  readonly images?: readonly { readonly absolutePath?: string }[];
}

interface ReaderMediaGenerationCycle extends UnknownRecord {
  readonly cycleId?: string;
}

interface ReaderCompanionSettings extends UnknownRecord {
  readonly bookId?: string;
  readonly stylePrompt?: string;
  readonly negativePrompt?: string;
  readonly characterNotes?: string;
}

type ReaderContextMediaPlacement = "anchor" | "chapterStart" | "chapterEnd";
interface ReaderContextMediaAsset {
  readonly kind: "image" | "video";
  readonly absolutePath: string;
  readonly chapter: number;
  readonly anchorStart: number;
  readonly anchorEnd: number;
  readonly caption: string;
  readonly placement: ReaderContextMediaPlacement;
}

interface MindMapNode extends UnknownRecord {
  readonly title?: string;
  readonly children?: readonly MindMapNode[];
}

interface AiHistoryRules {
  readonly TOMBSTONE_LIMIT: number;
  historyEntryId(entry: AiHistoryEntry): string;
  isHistoryDeleted(entry: AiHistoryEntry): boolean;
  mergeEntries(...groups: readonly (readonly AiHistoryEntry[])[]): AiHistoryEntry[];
  prependSessionEntry(entries: readonly AiHistoryEntry[], entry: AiHistoryEntry): AiHistoryEntry[];
  sessionPrompt(entries: readonly AiHistoryEntry[], label: (task?: string) => string): unknown;
}

interface AnchorRange { readonly start: number; readonly end: number }

interface JumpPoint extends UnknownRecord { readonly chapter: number; readonly chFrac: number; readonly progress: number }
interface JumpRequest extends UnknownRecord { readonly chapter?: number; readonly term?: string }
interface VirtualChapter extends UnknownRecord { readonly ch: number; readonly frag: string }
interface ReadingAnchor extends UnknownRecord {
  readonly text_offset?: number;
  readonly viewport_offset?: number;
}
interface SameBookResumePosition {
  readonly chapter: number;
  readonly anchor: { readonly text_offset: number; readonly viewport_offset: number };
}
interface SameBookResumeState extends UnknownRecord {
  readonly reason?: unknown;
  readonly before_page?: unknown;
  readonly after_page?: unknown;
  readonly before_anchor_offset?: unknown;
  readonly after_anchor_offset?: unknown;
  readonly resize_sequence?: unknown;
  readonly layout_width?: unknown;
  readonly layout_height?: unknown;
  readonly restore_pending?: unknown;
}
interface ProgressRequest extends UnknownRecord {
  readonly progress: number; readonly chapter: number; readonly frac: number;
  readonly anchor: ReadingAnchor | null; readonly sequence: number;
}
interface PendingSnapshot {
  readonly requestId: number;
  readonly resolve: (ready: boolean) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface ReadPageData extends UnknownRecord {
  readonly pageChars?: number; readonly gPage?: number; readonly page?: number; readonly chapter?: number;
}
interface ReadSegment { readonly key: string; chars: number; readonly startedAt: number; credited: number }
interface ReadTrackConfig {
  readonly minDwellMs: number; readonly idleCapMs: number; readonly fastTurnRatio: number;
  readonly fastTurnStreak: number; readonly fastTurnCredit: number; readonly backtrackCooldownMs: number;
  readonly readingTimeMaxCreditSec: number; readonly readingTimeTickMs: number; readonly periodicCreditMs: number;
}
interface ReadingMetricsApi {
  readonly READ_TRACK: ReadTrackConfig;
  requiredDwellMs(chars: number): number;
  clamp(value: number, minimum: number, maximum: number): number;
  pageKey(data: ReadPageData, chapter: number): string;
  pagePosition(data: ReadPageData, chapter: number): number;
}
interface JumpBackRulesApi {
  normalizeIconSizePx(value: unknown): number;
  iconHeightPx(value: number): number;
  normalizePosition(value: unknown, fallback: number): number;
  trackPoint(length: number, iconSize: number, hitSize: number, position: number): number;
}
interface NavigationDismissState { readonly visible: boolean; readonly awaitingLanding: boolean; readonly lastPageSignature: string; readonly pagesMoved: number; readonly dismissed?: boolean }
interface NavigationRulesApi {
  appendHistory(entries: readonly JumpPoint[], point: unknown, fallback: JumpPoint): { readonly history: JumpPoint[]; readonly added: boolean };
  pageSignature(data: unknown): string;
  trackPageDismissal(state: NavigationDismissState, data: unknown, limit: number): NavigationDismissState;
}
interface BookInfo extends UnknownRecord {
  readonly id?: string; readonly content_id?: string; readonly title?: string; readonly format?: string;
  readonly resume_chapter?: number; readonly resume_frac?: number; readonly progress?: number;
  readonly resume_position?: { readonly anchor?: ReadingAnchor }; readonly bookmarks?: readonly unknown[];
  readonly highlights?: readonly unknown[]; readonly word_count?: number; readonly url?: string;
  readonly toc?: readonly { readonly chapter?: number; readonly frag?: string }[]; readonly chapter_count?: number;
  readonly initial_chapter?: { readonly chapter?: number; readonly conversion?: string; readonly inline?: boolean; readonly body?: string; readonly head?: string };
}
interface ReaderFrameData extends UnknownRecord {
  readonly progress?: number; readonly chapter?: number; readonly chFrac?: number; readonly anchor?: ReadingAnchor;
  readonly totalCh?: number; readonly logicalCh?: number; readonly logicalTotal?: number; readonly page?: number;
  readonly total?: number; readonly gPage?: number; readonly gTotal?: number; readonly positionRestored?: number;
  readonly positionCommit?: number; readonly positionSnapshotRequestId?: number; readonly dualContinuationChapter?: number;
  readonly sameBookResumeState?: SameBookResumeState | null;
  readonly readerPerf?: string; readonly readerPerfMetrics?: UnknownRecord; readonly ttsState?: unknown;
  readonly ttsSynth?: { readonly text?: unknown; readonly voice?: unknown; readonly rate?: unknown; readonly seq?: unknown; readonly idx?: unknown };
  readonly pdfState?: UnknownRecord;
  readonly pageCache?: { readonly sig?: unknown; readonly pages?: readonly unknown[]; readonly complete?: unknown };
  readonly downloadImage?: { readonly dataUrl?: unknown; readonly name?: unknown };
  readonly webSearch?: string | { readonly term?: unknown; readonly engine?: unknown };
  readonly aiReader?: { readonly text?: unknown; readonly anchorStart?: unknown; readonly anchorEnd?: unknown };
  readonly vocabAdd?: { readonly word?: unknown; readonly lang?: unknown; readonly def?: unknown; readonly def_en?: unknown; readonly phonetic?: unknown; readonly example?: unknown };
  readonly addHighlightCorrectDraft?: UnknownRecord; readonly setHighlightNote?: UnknownRecord;
  readonly setHighlightText?: UnknownRecord; readonly setHighlightColor?: UnknownRecord;
  readonly addBookmark?: { readonly chapter?: unknown; readonly frac?: unknown; readonly text?: unknown };
  readonly tocResolved?: { readonly chapter?: unknown; readonly frag?: unknown };
  readonly translateText?: UnknownRecord; readonly saveTranslationCredential?: UnknownRecord;
  readonly readerHighlightMenuPreferencesReady?: unknown;
  readonly readerHighlightMenuSettings?: { readonly requestId?: unknown; readonly settings?: unknown };
  readonly readerHighlightMenuPreferences?: unknown;
  readonly readerGesture?: unknown;
  readonly readerGestureSurfaceClosed?: unknown;
  readonly bugTrace?: unknown;
  readonly bookEnd?: unknown;
  readonly layoutBusy?: unknown;
  readonly readerJump?: unknown;
  readonly ready?: unknown;
  readonly readerEngineWarmReady?: unknown;
  readonly readerEngineHeapBytes?: unknown;
  readonly dict?: unknown;
  readonly dictContext?: unknown;
  readonly dictPrefetch?: unknown;
  readonly dictSpeak?: unknown;
  readonly ttsErr?: unknown;
  readonly ttsNoSystemVoice?: unknown;
  readonly getTranslationCredentialStatus?: unknown;
  readonly getTranslationProfiles?: unknown;
  readonly setTranslationActiveProvider?: unknown;
  readonly addHighlight?: unknown;
  readonly addHighlightCorrect?: unknown;
  readonly addHighlightNote?: unknown;
  readonly openAnnotations?: unknown;
  readonly removeHighlight?: unknown;
  readonly crossSearch?: unknown;
  readonly semanticSearch?: unknown;
}

interface ReaderElement extends HTMLElement {
  checked: boolean;
  disabled: boolean;
  value: string;
  src: string;
  contentWindow: Window | null;
}

interface ReaderDocument extends Document {
  getElementById(elementId: string): ReaderElement;
}

interface ReaderShellRuntime extends Window, UnknownRecord {
  readonly document: ReaderDocument;
  frame?: HTMLIFrameElement;
  readonly ReaderShell: ReaderShellApi;
  readonly ReaderI18n?: { t?(key: string, values?: Readonly<Record<string, unknown>>): string };
  readonly ReaderAnimationSettings?: {
    readonly STORAGE_KEY?: string;
    applyReader?(document: Document): void;
    read?(): UnknownRecord;
  };
  readonly ReaderBugTrace?: {
    record?(kind: string, detail: Readonly<Record<string, unknown>>): void;
    capture?(reason: string): Promise<unknown>;
    checkpoint?(delay: number): void;
    reset?(): void;
    setContextProvider?(provider: () => UnknownRecord): void;
    ingestPageEvent?(event: unknown): void;
  };
  readonly ReaderAiHistoryRules: AiHistoryRules;
  readonly ReaderReadingMetrics: ReadingMetricsApi;
  readonly ReaderJumpBackRules: JumpBackRulesApi;
  readonly ReaderNavigationRules?: NavigationRulesApi;
  readonly ReaderSettings?: { get?(): UnknownRecord; setBookContext?(id: string): void };
  readonly ReaderMessageGuard?: { normalizeEvent?(event: MessageEvent, frame: HTMLIFrameElement, location: Location): ReaderFrameData | null };
  readonly ReaderGestureClose?: { activate?(): void; fromFrame?(value: unknown): void; frameSurfaceClosed?(value: unknown): void };
  readonly ReaderStartupGuard?: { markFrameReady?(): void; markScriptReady?(): void; beginBookLoad?(): void; beginFrameNavigation?(url: string): boolean; failBookLoad?(error: unknown): void };
  readonly ReaderRecommendationSettings?: { isEnabled?(): boolean; createPrefetcher?(options: UnknownRecord): ReaderEndRecommendations };
  readonly ReaderBookInfoPanel: { mount(options: UnknownRecord): ReaderBookInfoPanel };
  readonly ReaderBookInfoRelated: { mount(options: UnknownRecord): ReaderBookInfoRelated };
  consumePendingCrossSearch?: () => void;
  updateCrossReturnButton?: () => void;
  initializeReaderNotes?: (snapshot: UnknownRecord) => void;
  pauseReadTracking?: (reason: string) => void;
  readonly settings: UnknownRecord;
  readonly sendToPage: (message: unknown) => void;
  readonly initSettingsUI: () => void;
  readonly applyShellTheme: (theme: unknown) => void;
  readonly toggleSearch: (show: unknown) => void;
  readonly renderResults: (term: unknown, hits: unknown) => void;
  openCrossSearch?: (request: unknown) => void;
  openSemanticSearch?: (request: unknown) => void;
  prefetchMicrosoftWord?: (word: unknown) => void;
  speakMicrosoftWord?: (word: unknown) => void;
  scheduleTocBuild?: (toc: unknown) => void;
  addHighlight?: (...args: unknown[]) => void;
  addCorrectedHighlight?: (...args: unknown[]) => void;
  openAnnotations?: (index: unknown) => void;
  renderHighlights?: () => void;
  renderBookmarks?: () => void;
  markToc?: (element: unknown) => void;
  setReaderSettingsOpen?: (open: boolean) => void;
  vocabAutoSpeak?: boolean;
  rsearchInput?: HTMLInputElement;
  highlights?: unknown;
  bookmarks?: unknown;
  closeReaderWindow?: () => Promise<void>;
  readerDebugSettingOn?: (key: string) => boolean;
}

interface ReaderWindowDiagnosticState {
  readonly window_role: string;
  readonly window_visible: boolean;
  readonly book_bound: boolean;
  readonly registered: boolean;
}

interface ReaderEndRecommendations {
  loadAtEnd(): Promise<unknown>;
  reset(id: string, options: UnknownRecord): void;
  observe(data: unknown): void;
}

interface BookMeta extends UnknownRecord { readonly title?: string }
interface ReaderBookInfoPanel {
  setLoading(): void;
  setError(error: unknown): void;
  render(meta: BookMeta): void;
  configure(options: {
    onRating(rating: unknown): void;
    onTitle(title: string): void;
    onDescription(description: unknown): void;
    onAction(action: string): void;
  }): void;
}
interface ReaderBookInfoRelated {
  openSimilar(bookId: unknown, meta: UnknownRecord): Promise<unknown>;
  openTimeline(bookId: unknown): Promise<unknown>;
}

interface TtsAudioResponse extends UnknownRecord {
  readonly audio?: unknown;
  readonly marks?: unknown;
}

interface PdfState extends UnknownRecord {
  readonly scale?: number;
  readonly dual?: boolean;
}

export function installReaderShellRuntime(
  target: unknown,
  transport: TauriTransport = transportFromTauriGlobal(target),
): void {
const window = target as ReaderShellRuntime;
const document = window.document;
const frame = document.getElementById("frame") as unknown as HTMLIFrameElement;
window.frame = frame;
const localStorage = window.localStorage;
const performance = window.performance;
const ReaderShell = window.ReaderShell;
const sendToPage = window.sendToPage.bind(window);
const settings = window.settings;
const initSettingsUI = window.initSettingsUI.bind(window);
const applyShellTheme = window.applyShellTheme.bind(window);
const toggleSearch = window.toggleSearch.bind(window);
const renderResults = window.renderResults.bind(window);
const openCrossSearch = (request: unknown): void => window.openCrossSearch?.(request);
const openSemanticSearch = (request: unknown): void => window.openSemanticSearch?.(request);
const prefetchMicrosoftWord = (word: unknown): void => window.prefetchMicrosoftWord?.(word);
const speakMicrosoftWord = (word: unknown): void => window.speakMicrosoftWord?.(word);
const scheduleTocBuild = (toc: unknown): void => window.scheduleTocBuild?.(toc);
const addHighlight = (...args: unknown[]): void => window.addHighlight?.(...args);
const addCorrectedHighlight = (...args: unknown[]): void => window.addCorrectedHighlight?.(...args);
const openAnnotations = (index: unknown): void => window.openAnnotations?.(index);
const renderHighlights = (): void => window.renderHighlights?.();
const renderBookmarks = (): void => window.renderBookmarks?.();
const markToc = (element: unknown): void => window.markToc?.(element);
const tocPane = document.getElementById("toc-pane") as HTMLElement;
const invoke: LegacyInvoke = (command, args) => transport.invoke(command, args);
const listen = transport.listen?.bind(transport);
const emitTransport = transport.emit?.bind(transport);
if (!listen || !emitTransport) throw new Error("Reader shell requires Tauri event transport.");
const emit = emitTransport;
let readerShellStartedAt = performance.now();
let readerPerformanceOpeningId = Date.now();
const isCleanPooledShell = new URLSearchParams(window.location.search).get("pool") === "1";
const isReaderShellBenchmark = new URLSearchParams(window.location.search).get("benchmark") === "1";
const preloadInnerReaderEngine = isCleanPooledShell && new URLSearchParams(window.location.search).get("inner") !== "0";
let readerBookBound = !isCleanPooledShell;
let readerBookLoadInFlight = false;
let readerBookActivationPending = false;
let innerReaderEngineReady = false;
let readerStartupPhase = "idle";
let readerStartupFailureCategory = "none";
function readerWindowRole(): string {
  if (isReaderShellBenchmark) return isCleanPooledShell ? "benchmark_preloaded" : "benchmark_regular";
  if (isCleanPooledShell) return readerBookBound ? "pooled_reader" : "preload_pool";
  return "reader";
}
function readerDocumentVisible(): boolean {
  return document.visibilityState ? document.visibilityState === "visible" : document.hidden !== true;
}
function readerStartupErrorCategory(error: unknown): string {
  const message = String(error || "").toLowerCase();
  if (message.includes("未绑定图书") || message.includes("not bound")) return "unbound_window";
  if (message.includes("找不到这本书") || message.includes("book not found")) return "book_missing";
  if (message.includes("正文地址") || message.includes("invalid") || message.includes("url")) return "invalid_source";
  if (message.includes("invoke") || message.includes("ipc") || message.includes("channel")) return "ipc_failure";
  return "unknown";
}
function recordReaderStartupFailure(phase: string, error: unknown): void {
  readerStartupPhase = phase;
  readerStartupFailureCategory = readerStartupErrorCategory(error);
  window.ReaderBugTrace?.record?.("book_load_failed", {
    source: "reader_shell",
    phase,
    outcome: "failed",
    failure_category: readerStartupFailureCategory,
    window_role: readerWindowRole(),
    document_visible: readerDocumentVisible(),
    book_bound: readerBookBound,
    book_info_loaded: Boolean(currentBookId),
    inner_engine_ready: innerReaderEngineReady,
  });
  window.ReaderBugTrace?.checkpoint?.(0);
}
const readerText = (key: string, fallback: string, values?: Readonly<Record<string, unknown>>): string => {
  const value = window.ReaderI18n?.t?.(key, values);
  return value && value !== key ? value : fallback;
};
const READER_PERFORMANCE_METRIC_KEYS = [
  "stylesheet_count", "stylesheet_reused", "stylesheet_cssom_ready",
  "stylesheet_load_event", "stylesheet_error_event", "stylesheet_timeout",
  "image_total", "image_blocking", "image_deferred", "resource_timeout",
  "payload_inline_hit",
  "layout_frame_wait_ms", "layout_apply_ms", "layout_finalize_ms", "layout_compute_ms", "display_frame_wait_ms",
] as const;
function boundedReaderPerformanceMetrics(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as UnknownRecord;
  const metrics: Record<string, number> = {};
  for (const key of READER_PERFORMANCE_METRIC_KEYS) {
    const numeric = Number(source[key]);
    if (Number.isFinite(numeric)) {
      const limit = key.endsWith("_ms") ? 30000 : 64;
      const bounded = Math.max(0, Math.min(limit, numeric));
      metrics[key] = key.endsWith("_ms") ? Number(bounded.toFixed(1)) : Math.round(bounded);
    }
  }
  return metrics;
}
function recordReaderPerformance(stage: string, durationMs = performance.now() - readerShellStartedAt, metricsValue?: unknown): void {
  const elapsed = Math.max(0, Math.min(30000, Number(durationMs) || 0));
  const metrics = boundedReaderPerformanceMetrics(metricsValue);
  window.ReaderBugTrace?.record?.("open_stage", {
    source: "reader_shell",
    outcome: stage,
    duration_ms: Number(elapsed.toFixed(1)),
    ...metrics,
  });
  emit("reader-performance-trace", {
    openingId: readerPerformanceOpeningId,
    stage,
    durationMs: Number(elapsed.toFixed(1)),
    ...metrics,
  }).catch(() => {});
}
const OPENING_READER_PAGE_PERFORMANCE_STAGES = new Set([
  "chapter_payload_ready",
  "chapter_styles_ready",
  "chapter_dom_ready",
  "chapter_resources_ready",
  "page_layout_ready",
  "page_displayed",
]);
let currentBookTitle = "";
let currentBookId = "";
let currentBookContentId = "";
// 页面测量仍在阅读 WebView 中完成；该 id 把它纳入统一任务中心，
// 以便暂停/取消和可观察进度不再是另一套孤立状态。
let pageCountTaskId = "";
window.currentBookId = "";
window.currentBookContentId = "";
window.ReaderAnimationSettings?.applyReader?.(document);
function syncAnimationSettingsToPage(animationSettings?: unknown): void {
  if (!frameReady || isPdf || typeof sendToPage !== "function") return;
  sendToPage({ animationSettings: animationSettings || window.ReaderAnimationSettings?.read?.() || {} });
}
window.addEventListener("reader-animation-settings-changed", ((event: CustomEvent<unknown>) => {
  window.ReaderAnimationSettings?.applyReader?.(document);
  syncAnimationSettingsToPage(event.detail);
}) as EventListener);
window.addEventListener("storage", (event) => {
  if (event.key !== window.ReaderAnimationSettings?.STORAGE_KEY) return;
  window.ReaderAnimationSettings?.applyReader?.(document);
  syncAnimationSettingsToPage();
});
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单
function readerDebugSettingOn(key: string): boolean {
  try {
    const debugSettings = JSON.parse(localStorage.getItem("debugSettingsV1") || "{}") as UnknownRecord;
    return debugSettings[key] !== false;
  } catch {
    return true;
  }
}
window.readerDebugSettingOn = readerDebugSettingOn;
const DIAG_DISABLE_READER_REPORTS = !readerDebugSettingOn("reader_stats_report");
let windowDraggingUntil = 0;
let windowDragReleaseTimer: ReturnType<typeof setTimeout> | null = null;
function markWindowDragging(): void {
  // Tauri 的原生拖窗过程不总能把 move/up 事件稳定回传给 WebView。
  // 给一个较长保护窗，松手事件回来时再缩短，避免拖动数秒后后台写盘插入造成卡顿。
  windowDraggingUntil = Date.now() + 20000;
  window.ReaderBugTrace?.record?.("window_drag", { source: "title_bar", outcome: "start" });
  if (typeof sendToPage === "function") sendToPage({ windowDragging: 1 });
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 20500);
}
function isWindowDragging(): boolean {
  return Date.now() < windowDraggingUntil;
}
function endWindowDraggingSoon(): void {
  windowDraggingUntil = Date.now() + 500;
  window.ReaderBugTrace?.record?.("window_drag", { source: "title_bar", outcome: "release" });
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 650);
}

function initWindowControls(): void {
  document.querySelector(".reader-drag-space")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("reader-progress-group")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("chapter-progress")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("progress")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("win-min")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_minimize").catch(() => {});
  });
  document.getElementById("win-max")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_toggle_maximize").catch(() => {});
  });
  document.getElementById("win-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeReaderWindow();
  });
  window.addEventListener("pointerup", endWindowDraggingSoon);
  window.addEventListener("mouseup", endWindowDraggingSoon);
}
initWindowControls();

// 禁用浏览器自带查找（Ctrl+F / F3），用阅读器自带搜索
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

// 沉浸模式和外壳浮层统一交给 ReaderShell 状态机。
let immersive = ReaderShell.isImmersive();
function setImmersive(on: unknown): void {
  ReaderShell.dispatch({ type: "SET_IMMERSIVE", on: !!on });
  immersive = ReaderShell.isImmersive();
}
function toggleReaderToolbar(): void {
  ReaderShell.dispatch({ type: "TOGGLE_TOOLBAR" });
  immersive = ReaderShell.isImmersive();
}
window.toggleReaderToolbar = toggleReaderToolbar;
const readerToolbar = document.querySelector(".toolbar");
const aiReaderSide = document.getElementById("ai-reader-side");
const aiReaderStatus = document.getElementById("ai-reader-status");
const aiReaderAnswer = document.getElementById("ai-reader-answer");
const aiReaderSources = document.getElementById("ai-reader-sources");
const aiReaderQuestion = document.getElementById("ai-reader-question");
const aiReaderHistory = document.getElementById("ai-reader-history");
const aiReaderHistoryMenu = document.getElementById("ai-reader-history-menu");
const aiReaderHistorySettingsButton = document.getElementById("ai-reader-history-settings-btn");
const aiReaderSourcePreview = document.getElementById("ai-reader-source-preview");
const aiReaderMediaComposer = document.getElementById("ai-reader-media-composer");
const aiReaderMediaTitle = document.getElementById("ai-reader-media-title");
const aiReaderMediaPrompt = document.getElementById("ai-reader-media-prompt") as unknown as HTMLTextAreaElement | null;
const aiReaderMediaConsent = document.getElementById("ai-reader-media-consent") as unknown as HTMLInputElement | null;
const aiReaderMediaConsentCopy = document.getElementById("ai-reader-media-consent-copy");
const aiReaderMediaSubmit = document.getElementById("ai-reader-media-submit") as unknown as HTMLButtonElement | null;
const aiReaderMediaResult = document.getElementById("ai-reader-media-result");
const aiReaderCompanionSettingsPanel = document.getElementById("ai-reader-companion-settings-panel");
const aiReaderCompanionStyle = document.getElementById("ai-reader-companion-style") as unknown as HTMLTextAreaElement | null;
const aiReaderCompanionNegative = document.getElementById("ai-reader-companion-negative") as unknown as HTMLTextAreaElement | null;
const aiReaderCompanionCharacters = document.getElementById("ai-reader-companion-characters") as unknown as HTMLTextAreaElement | null;
const aiReaderCompanionSettingsStatus = document.getElementById("ai-reader-companion-settings-status");
let aiReaderMediaKind: "image" | "video" | null = null;
let aiReaderMediaPollToken = 0;
let aiReaderMediaCycleToken = "";
let readerContextMediaBatchRunning = false;
let readerContextMediaBatchTimer = 0;
let readerContextMediaLastChapter = -1;
let readerContextMediaLastBookKey = "";
let readerContextMediaBatchFailureCount = 0;
const readerContextMediaPending = new Map<number, number>();
const readerContextMediaProcessed = new Set<string>();
const READER_CONTEXT_MEDIA_CACHE_KEY = "readerContextMediaCacheV1";
let readerCompanionSettings: ReaderCompanionSettings = {};
let readerMemoryCaptureInFlight = false;
const readerMemoryCaptureQueued = new Set<string>();
type ReadingMemoryCaptureJob = {
  readonly completedChapter: number;
  readonly observedCurrentChapter: number;
  readonly observedCurrentFraction: number;
  readonly retries: number;
};
// Chapter memories must be generated in reading order.  A fast reader can
// complete another short chapter while the model is still handling the
// previous one; keeping these jobs locally prevents that later chapter from
// being silently dropped just because one capture is in flight.
const readerMemoryCapturePending = new Map<string, ReadingMemoryCaptureJob>();
let readerMemoryCaptureStartTimer = 0;
let aiReaderSelectedText = "";
let aiReaderSelectedAnchor: AnchorRange | null = null;
let aiReaderPreviewCitation: HTMLElement | null = null;
let aiReaderRequestRunning = false;
let aiReaderProgressTimer = 0;
let aiReaderHistorySync: { syncEnabled: boolean; syncMode: string; cloudIds: Set<string> } = { syncEnabled: false, syncMode: "off", cloudIds: new Set() };
let readerFirstReadyLogged = false;
const AI_READER_WIDTH_KEY = "aiReaderSideWidthV1";
function setAiReaderSideWidth(mode: unknown): void {
  const selected = ["current", "half", "full"].includes(String(mode)) ? String(mode) : "current";
  if (aiReaderSide) {
    if (selected === "current") aiReaderSide.style.removeProperty("--ai-reader-width");
    else aiReaderSide.style.setProperty("--ai-reader-width", selected === "half" ? "50%" : "100%");
  }
  document.querySelectorAll<HTMLElement>("[data-ai-reader-width]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.aiReaderWidth === selected);
  });
  try { localStorage.setItem(AI_READER_WIDTH_KEY, selected); } catch { /* local settings are optional */ }
}
function restoreAiReaderSideWidth(): void {
  try { setAiReaderSideWidth(localStorage.getItem(AI_READER_WIDTH_KEY) || "current"); } catch { setAiReaderSideWidth("current"); }
}
function setAiReaderSide(open: unknown): void {
  // 智读为覆盖层：不改变正文 iframe 宽度，因此不需要在重排后猜测或恢复锚点。
  ReaderShell.setSidePanel(ReaderShell.SIDE_PANEL.AI_READER, !!open);
}
function closeAiReaderSide(): void {
  if (!ReaderShell.isSidePanel(ReaderShell.SIDE_PANEL.AI_READER)) return;
  setAiReaderSide(false);
}
window.closeAiReaderSide = closeAiReaderSide;
function aiReaderSetStatus(value: unknown): void { if (aiReaderStatus) aiReaderStatus.textContent = String(value || ""); }
const aiReaderProfileInput = document.getElementById("ai-reader-profile");
function renderAiReaderProfiles(statusValue: unknown): void {
  if (!aiReaderProfileInput) return;
  const status = (typeof statusValue === "object" && statusValue !== null ? statusValue : {}) as { readonly profiles?: readonly AiProfile[]; readonly assignments?: { readonly readingId?: string }; readonly activeId?: string };
  const profiles = Array.isArray(status.profiles) ? status.profiles.filter((profile) => profile.configured) : [];
  aiReaderProfileInput.replaceChildren();
  if (!profiles.length) {
    const option = document.createElement("option"); option.value = ""; option.textContent = readerText("noConfiguredModel", "请先在书架设置中配置大模型");
    aiReaderProfileInput.appendChild(option); aiReaderProfileInput.disabled = true; return;
  }
  profiles.forEach((profile) => {
    const option = document.createElement("option"); option.value = profile.id; option.textContent = profile.name || profile.model || readerText("configuredModel", "已配置大模型");
    aiReaderProfileInput.appendChild(option);
  });
  const readingId = status.assignments?.readingId || status.activeId;
  aiReaderProfileInput.value = profiles.some((profile) => profile.id === readingId) ? String(readingId) : String(profiles[0]?.id || "");
  aiReaderProfileInput.disabled = false;
}
aiReaderProfileInput?.addEventListener("change", async () => {
  const id = aiReaderProfileInput.value;
  if (!id) return;
  aiReaderProfileInput.disabled = true;
  try {
    const profiles = await invoke<{ readonly profiles?: readonly AiProfile[] }>("assign_ai_reader_profile", { request: { purpose: "reading", id } });
    renderAiReaderProfiles(profiles);
    const selected = profiles?.profiles?.find((profile) => profile.id === id);
    aiReaderSetStatus(selected?.configured ? readerText("modelSwitched", "已切换大模型") : readerText("modelIncomplete", "所选大模型配置不完整"));
  } catch (error) { aiReaderSetStatus(readerText("modelSwitchFailed", "切换大模型失败：{error}", { error })); }
  finally { aiReaderProfileInput.disabled = false; }
});
function aiReaderHistoryIdentity(): string { return String(window.currentBookContentId || currentBookContentId || window.currentBookId || currentBookId || "unknown"); }
function aiReaderHistoryKey(): string { return "aiReaderHistoryV1:" + aiReaderHistoryIdentity(); }
function aiReaderSessionMemoryKey(): string { return "aiReaderSessionMemoryV1:" + aiReaderHistoryIdentity(); }
function aiReaderTaskLabel(task?: string): string { return task === "summary" ? readerText("summaryTask", "总结已读内容") : task === "mindmap" ? readerText("mindMapTask", "生成脑图") : readerText("askTask", "提问"); }
const readerAiHistoryRules = window.ReaderAiHistoryRules;
const AI_READER_HISTORY_TOMBSTONE_LIMIT = readerAiHistoryRules.TOMBSTONE_LIMIT;
void AI_READER_HISTORY_TOMBSTONE_LIMIT;
function aiReaderHistoryEntryId(entry: AiHistoryEntry): string { return readerAiHistoryRules.historyEntryId(entry); }
function aiReaderHistoryDeleted(entry: AiHistoryEntry): boolean { return readerAiHistoryRules.isHistoryDeleted(entry); }
function aiReaderNewHistoryId(): string {
  const suffix = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `reader:${new Date().toISOString()}:${suffix}`;
}
function aiReaderMergeHistoryEntries(...groups: readonly (readonly AiHistoryEntry[])[]): AiHistoryEntry[] {
  return readerAiHistoryRules.mergeEntries(...groups);
}
function aiReaderReadHistory(): AiHistoryEntry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(aiReaderHistoryKey()) || "[]");
    return Array.isArray(entries) ? aiReaderMergeHistoryEntries(entries) : [];
  } catch { return []; }
}
function aiReaderSaveHistory(entry: AiHistoryEntry): void {
  const savedEntry = { ...entry, id: entry?.id || aiReaderNewHistoryId() };
  try {
    const entries = aiReaderReadHistory();
    localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(aiReaderMergeHistoryEntries([savedEntry], entries)));
  } catch { /* 历史不可用不影响本次问答。 */ }
  if (currentBookContentId) {
    invoke("private_sync_history_merge", { request: { contentId: currentBookContentId, entries: [savedEntry] } }).catch(() => {
      // 未开启历史同步、旧数据库或离线均不影响本地智读。
    });
  }
}
function aiReaderReadSessionMemory(): AiHistoryEntry[] {
  try {
    const entries = JSON.parse(localStorage.getItem(aiReaderSessionMemoryKey()) || "[]");
    return Array.isArray(entries) ? entries.slice(0, 8) : [];
  } catch { return []; }
}
function aiReaderRememberSession(entry: AiHistoryEntry): void {
  // This is deliberately separate from history sync: it only keeps a short
  // local continuity recap for the book currently being read.
  try {
    const entries = aiReaderReadSessionMemory();
    localStorage.setItem(aiReaderSessionMemoryKey(), JSON.stringify(readerAiHistoryRules.prependSessionEntry(entries, entry)));
  } catch { /* 本机会话记忆不可用不影响本次智读。 */ }
}
function aiReaderSessionMemory(): unknown {
  return readerAiHistoryRules.sessionPrompt(aiReaderReadSessionMemory(), aiReaderTaskLabel);
}
function aiReaderApplyHistorySnapshot(snapshot: AiHistorySnapshot | null | undefined): void {
  if (!snapshot || !Array.isArray(snapshot.entries)) return;
  aiReaderHistorySync = {
    syncEnabled: snapshot.syncEnabled === true,
    syncMode: String(snapshot.syncMode || "off"),
    cloudIds: new Set(snapshot.entries
      .filter((entry) => !aiReaderHistoryDeleted(entry) && entry.cloudSaved === true)
      .map(aiReaderHistoryEntryId)),
  };
  const known = aiReaderReadHistory();
  // Recent mode derives the blue Cloud label from the account-wide projection;
  // it must not turn that display-only result into a saved manual selection.
  const remoteEntries = aiReaderHistorySync.syncMode === "recent"
    ? snapshot.entries.map((entry) => { const copy = { ...entry }; delete copy.cloudSaved; return copy; })
    : snapshot.entries;
  const merged = aiReaderMergeHistoryEntries(known, remoteEntries);
  localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(merged));
  document.querySelectorAll<HTMLElement>("[data-ai-reader-sync-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.aiReaderSyncMode === aiReaderHistorySync.syncMode);
  });
}
async function aiReaderMergeSyncedHistory() {
  if (!currentBookContentId) return;
  try {
    const snapshot = await invoke<AiHistorySnapshot>("private_sync_reader_history_snapshot", { contentId: currentBookContentId });
    aiReaderApplyHistorySnapshot(snapshot);
    if (aiReaderHistory?.classList.contains("show")) aiReaderShowHistory(true);
  } catch { /* 同步 history unavailable: keep local records. */ }
}
async function aiReaderSetHistorySyncMode(syncMode: unknown): Promise<void> {
  if (!currentBookContentId) return;
  try {
    const snapshot = await invoke<AiHistorySnapshot>("private_sync_set_reader_history_mode", { request: { contentId: currentBookContentId, syncMode } });
    aiReaderApplyHistorySnapshot(snapshot);
    aiReaderHistoryMenu.hidden = true;
    aiReaderShowHistory(true);
    aiReaderSetStatus(syncMode === "manual"
      ? readerText("aiHistoryManualEnabled", "已切换为手动同步；点击每条记录旁的“云端”选择。")
      : readerText("aiHistoryRecentEnabled", "已同步最近 100 条智读与脑图记录。"));
  } catch (error) { aiReaderSetStatus(readerText("aiHistorySyncFailed", "更新智读历史同步设置失败：{error}", { error })); }
}
async function aiReaderToggleHistoryCloud(entry: AiHistoryEntry): Promise<void> {
  if (!currentBookContentId) return;
  try {
    if (aiReaderHistorySync.syncMode !== "manual") {
      await aiReaderSetHistorySyncMode("manual");
    }
    const snapshot = await invoke<AiHistorySnapshot>("private_sync_set_reader_history_cloud_saved", {
      request: {
        contentId: currentBookContentId,
        id: aiReaderHistoryEntryId(entry),
        cloudSaved: !entry.cloudSaved,
      },
    });
    aiReaderApplyHistorySnapshot(snapshot);
    aiReaderShowHistory(true);
  } catch (error) { aiReaderSetStatus(readerText("aiHistoryCloudFailed", "更新云端记录失败：{error}", { error })); }
}
function aiReaderSourceLabel(source: AiSource | undefined, index: number): string {
  const kind = String(source?.sourceKind || "已读正文");
  return `来源 ${index + 1}｜${kind}｜第 ${Number(source?.chapter || 0) + 1} 章`;
}
function aiReaderJumpToSource(source: AiSource | undefined): void {
  const chapter = Number(source?.chapter);
  if (Number.isFinite(chapter) && chapter >= 0 && !isPdf) {
    sendToPage({ gotoChapter: Math.floor(chapter) });
    aiReaderSetStatus(`已跳转至第 ${Math.floor(chapter) + 1} 章`);
  }
}
function aiReaderHideSourcePreview(): void {
  if (!aiReaderSourcePreview) return;
  aiReaderSourcePreview.hidden = true;
  aiReaderSourcePreview.replaceChildren();
  aiReaderPreviewCitation?.setAttribute("aria-expanded", "false");
  aiReaderPreviewCitation = null;
}
ReaderShell.registerSidePanel(ReaderShell.SIDE_PANEL.AI_READER, {
  onClose() {
    aiReaderHideSourcePreview();
  },
});
function aiReaderShowSourcePreview(source: AiSource, index: number, citation: HTMLElement): void {
  if (!aiReaderSourcePreview || !citation) return;
  if (aiReaderPreviewCitation === citation && !aiReaderSourcePreview.hidden) {
    aiReaderHideSourcePreview();
    return;
  }
  aiReaderHideSourcePreview();
  const label = document.createElement("div");
  label.className = "ai-reader-source-preview-label";
  label.textContent = aiReaderSourceLabel(source, index);
  const excerpt = document.createElement("div");
  excerpt.className = "ai-reader-source-preview-excerpt";
  excerpt.textContent = String(source?.excerpt || "").trim() || readerText("sourcePreviewMissing", "这条历史记录没有保存引用文字。");
  aiReaderSourcePreview.append(label, excerpt);
  const chapter = Number(source?.chapter);
  if (!isPdf && Number.isFinite(chapter) && chapter >= 0) {
    const actions = document.createElement("div");
    actions.className = "ai-reader-source-preview-actions";
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "ai-reader-source-preview-jump";
    jump.textContent = readerText("jumpToSource", "跳转原文");
    jump.addEventListener("click", () => {
      aiReaderHideSourcePreview();
      aiReaderJumpToSource(source);
    });
    actions.appendChild(jump);
    aiReaderSourcePreview.appendChild(actions);
  }
  aiReaderSourcePreview.hidden = false;
  aiReaderPreviewCitation = citation;
  citation.setAttribute("aria-expanded", "true");
  const sideRect = aiReaderSide.getBoundingClientRect();
  const citationRect = citation.getBoundingClientRect();
  const previewWidth = aiReaderSourcePreview.offsetWidth;
  const previewHeight = aiReaderSourcePreview.offsetHeight;
  const left = Math.max(12, Math.min(sideRect.width - previewWidth - 12, citationRect.left - sideRect.left));
  const below = citationRect.bottom - sideRect.top + 7;
  const above = citationRect.top - sideRect.top - previewHeight - 7;
  const top = below + previewHeight <= sideRect.height - 12 ? below : Math.max(12, above);
  aiReaderSourcePreview.style.left = `${left}px`;
  aiReaderSourcePreview.style.top = `${top}px`;
}
function aiReaderAppendInline(parent: HTMLElement, value: unknown, sources: readonly AiSource[]): void {
  const text = String(value || "");
  const token = /(\[来源\s*(\d+)\])|(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)/g;
  let cursor = 0; let match: RegExpExecArray | null;
  while ((match = token.exec(text))) {
    parent.append(document.createTextNode(text.slice(cursor, match.index)));
    if (match[2] !== undefined) {
      const index = Number(match[2]) - 1;
      const source = sources[index];
      if (!source) parent.append(document.createTextNode(match[1] ?? ""));
      else {
        const citation = document.createElement("button");
        citation.type = "button";
        citation.className = "ai-reader-citation";
        citation.textContent = `[来源 ${index + 1}]`;
        citation.setAttribute("aria-label", `查看并跳转${aiReaderSourceLabel(source, index)}`);
        citation.setAttribute("aria-controls", "ai-reader-source-preview");
        citation.setAttribute("aria-expanded", "false");
        citation.addEventListener("click", () => {
          aiReaderShowSourcePreview(source, index, citation);
          aiReaderJumpToSource(source);
        });
        parent.append(citation);
      }
    } else if (match[4] !== undefined) {
      const strong = document.createElement("strong");
      aiReaderAppendInline(strong, match[4], sources);
      parent.append(strong);
    } else {
      const code = document.createElement("code");
      code.textContent = match[6] ?? "";
      parent.append(code);
    }
    cursor = token.lastIndex;
  }
  parent.append(document.createTextNode(text.slice(cursor)));
}
function aiReaderRenderMarkdown(content: unknown, sources: readonly AiSource[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = String(content || "没有得到可显示的回答。").replace(/\r/g, "").split("\n");
  let paragraph: string[] = [], list: HTMLElement | null = null, listKind = "", codeLines: string[] | null = null;
  const closeList = () => { list = null; listKind = ""; };
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const element = document.createElement("p");
    aiReaderAppendInline(element, paragraph.join(" "), sources);
    fragment.append(element); paragraph = [];
  };
  const appendList = (kind: "ul" | "ol", text: string) => {
    flushParagraph();
    if (!list || listKind !== kind) {
      list = document.createElement(kind); listKind = kind; fragment.append(list);
    }
    const item = document.createElement("li");
    aiReaderAppendInline(item, text, sources); list?.append(item);
  };
  lines.forEach((raw) => {
    const line = raw.trim();
    if (/^```/.test(line)) {
      if (codeLines) {
        const block = document.createElement("pre"); const code = document.createElement("code");
        code.textContent = codeLines.join("\n"); block.append(code); fragment.append(block); codeLines = null;
      } else { flushParagraph(); closeList(); codeLines = []; }
      return;
    }
    if (codeLines) { codeLines.push(raw); return; }
    if (!line) { flushParagraph(); closeList(); return; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const element = document.createElement((heading[1]?.length ?? 0) === 1 ? "h3" : "h4");
      aiReaderAppendInline(element, heading[2] ?? "", sources); fragment.append(element); return;
    }
    const bullet = line.match(/^[-*+]\s+(.+)$/);
    if (bullet) { appendList("ul", bullet[1] ?? ""); return; }
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) { appendList("ol", numbered[1] ?? ""); return; }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph(); closeList(); const block = document.createElement("blockquote");
      aiReaderAppendInline(block, quote[1] ?? "", sources); fragment.append(block); return;
    }
    closeList(); paragraph.push(line);
  });
  const trailingCodeLines = codeLines as string[] | null;
  if (trailingCodeLines) {
    const block = document.createElement("pre"); const code = document.createElement("code");
    code.textContent = trailingCodeLines.join("\n"); block.append(code); fragment.append(block);
  }
  flushParagraph();
  return fragment;
}
function aiReaderRenderSources(sources: readonly AiSource[] | undefined): void {
  if (!aiReaderSources) return;
  const list = aiReaderSources.querySelector("ul");
  if (!sources || !sources.length) { aiReaderSources.hidden = true; return; }
  list?.replaceChildren(...sources.map((source, index) => {
    const item = document.createElement("li");
    const excerpt = String(source.excerpt || "").replace(/\s+/g, " ").slice(0, 260);
    item.textContent = `[${aiReaderSourceLabel(source, index)}] ${excerpt}`;
    item.title = String(source.excerpt || "");
    item.addEventListener("click", () => aiReaderJumpToSource(source));
    return item;
  }));
  aiReaderSources.hidden = false;
}
function aiReaderParseMindmap(content: unknown): MindMapNode | null {
  let text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = text.indexOf("{"); const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  try {
    const root = JSON.parse(text) as unknown;
    return root && typeof root === "object" && typeof (root as MindMapNode).title === "string" ? root as MindMapNode : null;
  } catch { return null; }
}
function aiReaderMindmapNode(title: unknown, x: number, y: number, root: boolean): SVGGElement {
  const ns = "http://www.w3.org/2000/svg";
  const group = document.createElementNS(ns, "g");
  if (root) group.setAttribute("class", "root");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", String(x)); rect.setAttribute("y", String(y - 19));
  rect.setAttribute("width", "158"); rect.setAttribute("height", "38"); rect.setAttribute("rx", "9");
  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", String(x + 79)); label.setAttribute("y", String(y + 5)); label.setAttribute("text-anchor", "middle");
  label.textContent = String(title || "未命名").replace(/\s+/g, " ").slice(0, 16);
  group.append(rect, label);
  return group;
}
function aiReaderRenderMindmap(tree: MindMapNode): HTMLElement {
  const wrap = document.createElement("div"); wrap.className = "ai-reader-mindmap";
  const ns = "http://www.w3.org/2000/svg";
  const leaves = (node: MindMapNode): number => {
    const children = Array.isArray(node.children) ? node.children.filter((child) => child && typeof child === "object") : [];
    return children.length ? children.reduce((total, child) => total + leaves(child), 0) : 1;
  };
  const depth = (node: MindMapNode): number => {
    const children = Array.isArray(node.children) ? node.children : [];
    return children.length ? 1 + Math.max(...children.map(depth)) : 1;
  };
  const svg = document.createElementNS(ns, "svg");
  const leafCount = Math.min(80, leaves(tree));
  svg.setAttribute("width", String(Math.max(420, depth(tree) * 194 + 28)));
  svg.setAttribute("height", String(Math.max(180, leafCount * 62 + 32)));
  let nextLeaf = 0;
  const draw = (node: MindMapNode, level: number): { x: number; y: number } => {
    const children = Array.isArray(node.children) ? node.children.filter((child) => child && typeof child === "object") : [];
    const childLayouts = children.map((child) => draw(child, level + 1));
    const y = childLayouts.length ? childLayouts.reduce((sum, child) => sum + child.y, 0) / childLayouts.length : 32 + (nextLeaf++) * 62;
    const x = 14 + level * 194;
    childLayouts.forEach((child) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", `M ${x + 158} ${y} C ${x + 178} ${y}, ${child.x - 20} ${child.y}, ${child.x} ${child.y}`);
      svg.appendChild(path);
    });
    svg.appendChild(aiReaderMindmapNode(node.title, x, y, level === 0));
    return { x, y };
  };
  draw(tree, 0); wrap.appendChild(svg); return wrap;
}
function aiReaderRenderAnswer(answer: AiAnswer, task: string): void {
  if (!aiReaderAnswer) return;
  aiReaderHideSourcePreview();
  const content = String(answer.content || "");
  if (task === "mindmap") {
    const tree = aiReaderParseMindmap(content);
    if (tree) {
      const wrap = document.createElement("div"); wrap.className = "ai-reader-mindmap-wrap";
      const collapse = document.createElement("button"); collapse.type = "button"; collapse.className = "ai-reader-mindmap-collapse";
      collapse.textContent = readerText("collapseMindMap", "收起脑图");
      collapse.addEventListener("click", () => aiReaderShowHistory(true));
      wrap.append(collapse, aiReaderRenderMindmap(tree));
      aiReaderAnswer.replaceChildren(wrap);
    } else aiReaderAnswer.textContent = content || readerText("noMindMap", "模型没有返回可绘制的脑图，请重试。");
  } else aiReaderAnswer.replaceChildren(aiReaderRenderMarkdown(content, Array.isArray(answer.sources) ? answer.sources : []));
  aiReaderAnswer.hidden = false;
  aiReaderHistory?.classList.remove("show");
  aiReaderAnswer.classList.remove("empty");
  aiReaderRenderSources(answer.sources);
  const audit = document.getElementById("ai-reader-audit");
  if (audit) {
    const stages = Array.isArray(answer.retrievalStages) ? answer.retrievalStages.filter(Boolean) : [];
    audit.textContent = stages.length
      ? `本次流程：${stages.join(" · ")}${answer.citationChecked ? " · 已完成引用自检" : ""}`
      : readerText("currentEvidence", "本次依据来自当前已读内容。");
    audit.hidden = false;
  }
}
function aiReaderShowHistory(forceOpen = false): void {
  if (!aiReaderHistory) return;
  aiReaderHideSourcePreview();
  const showing = forceOpen ? true : aiReaderHistory.classList.toggle("show");
  if (forceOpen) aiReaderHistory.classList.add("show");
  if (!showing) { aiReaderAnswer.hidden = false; return; }
  aiReaderAnswer.hidden = true;
  aiReaderSources.hidden = true;
  const entries = aiReaderReadHistory().filter((entry) => !aiReaderHistoryDeleted(entry));
  aiReaderHistory.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div"); empty.className = "ai-reader-history-empty"; empty.textContent = readerText("aiHistoryEmpty", "这本书还没有智读记录。"); aiReaderHistory.appendChild(empty); return;
  }
  entries.forEach((entry) => {
    const row = document.createElement("div"); row.className = "ai-reader-history-row";
    const item = document.createElement("button"); item.type = "button"; item.className = "ai-reader-history-item";
    const question = document.createElement("span"); question.className = "ai-reader-history-question";
    question.textContent = entry.question || aiReaderTaskLabel(entry.task);
    const meta = document.createElement("span"); meta.className = "ai-reader-history-meta";
    meta.textContent = `${aiReaderTaskLabel(entry.task)} · ${entry.at ? new Date(entry.at).toLocaleString() : readerText("historyRecord", "历史记录")}`;
    item.append(question, meta);
    item.addEventListener("click", () => aiReaderRenderAnswer(entry, entry.task || "question"));
    const cloud = document.createElement("button"); cloud.type = "button"; cloud.className = "ai-reader-history-cloud";
    const cloudSaved = aiReaderHistorySync.syncEnabled && (
      aiReaderHistorySync.syncMode === "recent"
        ? aiReaderHistorySync.cloudIds.has(aiReaderHistoryEntryId(entry))
        : entry.cloudSaved === true
    );
    cloud.classList.toggle("is-synced", cloudSaved);
    cloud.textContent = readerText("cloud", "云端");
    cloud.title = cloudSaved ? readerText("cloudSynced", "已同步到云端") : readerText("cloudNotSynced", "未同步到云端");
    cloud.setAttribute("aria-label", cloud.title + ": " + question.textContent);
    cloud.addEventListener("click", async (event) => {
      event.preventDefault(); event.stopPropagation();
      await aiReaderToggleHistoryCloud(entry);
    });
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ai-reader-history-delete"; remove.textContent = readerText("delete", "删除");
    remove.setAttribute("aria-label", readerText("delete", "删除") + ": " + question.textContent);
    remove.addEventListener("click", async (event) => {
      event.preventDefault(); event.stopPropagation();
      if (window.confirm && !window.confirm(readerText("deleteAiHistory", "删除这条智读记录？删除后会同步到其他设备。"))) return;
      const tombstone = { id: aiReaderHistoryEntryId(entry), deletedAt: new Date().toISOString() };
      try {
        const local = aiReaderMergeHistoryEntries(aiReaderReadHistory(), [tombstone]);
        localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(local));
        if (currentBookContentId) {
          const snapshot = await invoke("private_sync_history_delete", { request: { contentId: currentBookContentId, id: tombstone.id } });
          if (Array.isArray(snapshot)) localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(aiReaderMergeHistoryEntries(snapshot, local)));
        }
        aiReaderShowHistory(true);
        aiReaderSetStatus(readerText("historyDeleted", "已删除智读记录；删除会在下次同步时传到其他设备。"));
      } catch (error) {
        aiReaderSetStatus(readerText("historyDeleteFailed", "删除智读记录失败：{error}", { error }));
      }
    });
    row.append(item, cloud, remove);
    aiReaderHistory.appendChild(row);
  });
}
async function openAiReader(prefill = "", focusAnchor: AnchorRange | null = null): Promise<void> {
  setAiReaderSide(true);
  if (typeof closeSettings === "function") closeSettings();
  aiReaderMergeSyncedHistory();
  aiReaderSelectedText = String(prefill || "").trim().slice(0, 2400);
  aiReaderSelectedAnchor = focusAnchor && Number.isFinite(Number(focusAnchor.start)) && Number.isFinite(Number(focusAnchor.end))
    ? { start: Math.max(0, Number(focusAnchor.start)), end: Math.max(0, Number(focusAnchor.end)) }
    : null;
  if (prefill && aiReaderQuestion) {
    // 选中的原文已随请求一并传给智读；输入框只保留用户真正要问的内容。
    aiReaderQuestion.value = String(prefill).trim().slice(0, 900);
    setTimeout(() => aiReaderQuestion.focus(), 0);
  }
  try {
    const [status, profiles] = await Promise.all([
      invoke<{ readonly configured?: boolean }>("ai_reader_status"),
      invoke<{ readonly profiles?: readonly AiProfile[] }>("ai_reader_profiles"),
    ]);
    renderAiReaderProfiles(profiles);
    aiReaderSetStatus(status.configured ? readerText("modelSelected", "已选择本机大模型") : readerText("noConfiguredModel", "请先在书架设置中配置大模型"));
  } catch (error) { aiReaderSetStatus(readerText("readConfigFailed", "读取配置失败：{error}", { error })); }
}
function aiReaderStartProgress(task: string): void {
  const stages = task === "mindmap"
    ? ["定位当前选句和已读范围", "检索相关已读正文", "筛选脑图依据", "整理脑图"]
    : ["定位当前选句和邻近正文", "混合检索已读内容", "筛选并重排证据", "生成回答并核对引用"];
  let index = 0;
  const show = () => aiReaderSetStatus(readerText("processing", "正在 {current}/{total}：{stage}…", { current: index + 1, total: stages.length, stage: stages[index] }));
  show();
  window.clearInterval(aiReaderProgressTimer);
  aiReaderProgressTimer = window.setInterval(() => {
    index = Math.min(index + 1, stages.length - 1);
    show();
  }, 1900);
}
function aiReaderStopProgress(): void {
  window.clearInterval(aiReaderProgressTimer);
  aiReaderProgressTimer = 0;
}
async function runAiReader(task: string): Promise<void> {
  if (aiReaderRequestRunning) return;
  const question = aiReaderQuestion?.value?.trim() || (task === "summary" ? readerText("summaryTask", "总结已读内容") : task === "mindmap" ? readerText("mindMapTask", "生成脑图") : "");
  if (task === "question" && !question) { aiReaderSetStatus(readerText("enterQuestion", "请输入问题")); aiReaderQuestion?.focus(); return; }
  aiReaderRequestRunning = true;
  aiReaderStartProgress(task);
  aiReaderHistory?.classList.remove("show");
  aiReaderAnswer.hidden = false;
  aiReaderAnswer.textContent = readerText("aiRequesting", "正在请求模型…");
  aiReaderAnswer.classList.add("empty");
  aiReaderSources.hidden = true;
  document.getElementById("ai-reader-audit")?.setAttribute("hidden", "");
  try {
    const answer = await invoke<AiAnswer>("ask_reading_assistant", { request: {
      task,
      question,
      currentChapter: curChapter,
      currentFraction: curChFrac,
      selectedText: aiReaderSelectedText,
      selectedStart: aiReaderSelectedAnchor?.start,
      selectedEnd: aiReaderSelectedAnchor?.end,
      sessionMemory: aiReaderSessionMemory(),
    } });
    aiReaderRenderAnswer(answer, task);
    const entry = { task, question, content: answer.content || "", sources: answer.sources || [], at: new Date().toISOString() };
    aiReaderSaveHistory(entry);
    aiReaderRememberSession(entry);
    const stages = Array.isArray(answer.retrievalStages) ? answer.retrievalStages.join(" · ") : "";
    aiReaderSetStatus(stages ? readerText("completeWithStages", "完成：{stages}", { stages }) : readerText("complete", "完成"));
  } catch (error) {
    aiReaderAnswer.textContent = readerText("aiFailed", "智读失败：{error}", { error: String(error) });
    aiReaderAnswer.classList.remove("empty");
    aiReaderSetStatus(readerText("failed", "失败"));
  } finally { aiReaderStopProgress(); aiReaderRequestRunning = false; }
}

function readerMediaFileUrl(path: string): string {
  const tauri = (window as unknown as {
    readonly __TAURI__?: { readonly core?: { convertFileSrc?(value: string): string } };
  }).__TAURI__;
  return tauri?.core?.convertFileSrc?.(path) || path;
}

function resetReaderMediaComposer(): void {
  aiReaderMediaPollToken += 1;
  aiReaderMediaKind = null;
  aiReaderMediaComposer?.setAttribute("hidden", "");
  if (aiReaderMediaPrompt) aiReaderMediaPrompt.value = "";
  if (aiReaderMediaConsent) aiReaderMediaConsent.checked = false;
  if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = true;
  if (aiReaderMediaResult) {
    aiReaderMediaResult.replaceChildren();
    aiReaderMediaResult.setAttribute("hidden", "");
  }
}

function readerCompanionBookId(): string {
  return String(currentBookContentId || currentBookId || "").trim();
}

function setReaderCompanionSettingsStatus(message: string): void {
  if (!aiReaderCompanionSettingsStatus) return;
  aiReaderCompanionSettingsStatus.textContent = message;
  aiReaderCompanionSettingsStatus.toggleAttribute("hidden", !message);
}

function renderReaderCompanionSettings(settings: ReaderCompanionSettings): void {
  if (aiReaderCompanionStyle) aiReaderCompanionStyle.value = String(settings.stylePrompt || "");
  if (aiReaderCompanionNegative) aiReaderCompanionNegative.value = String(settings.negativePrompt || "");
  if (aiReaderCompanionCharacters) aiReaderCompanionCharacters.value = String(settings.characterNotes || "");
}

async function loadReaderCompanionSettings(): Promise<void> {
  const bookId = readerCompanionBookId();
  if (!bookId) return;
  try {
    const settings = await invoke<ReaderCompanionSettings>("reader_companion_settings_get", { bookId });
    if (readerCompanionBookId() !== bookId) return;
    readerCompanionSettings = settings;
    renderReaderCompanionSettings(settings);
  } catch (error) {
    if (readerCompanionBookId() === bookId) setReaderCompanionSettingsStatus(`读取本机伴读设定失败：${error}`);
  }
}

function companionVisualGuidance(): string {
  const style = String(readerCompanionSettings.stylePrompt || "").trim();
  const negative = String(readerCompanionSettings.negativePrompt || "").trim();
  const characters = String(readerCompanionSettings.characterNotes || "").trim();
  if (!style && !negative && !characters) return "";
  const parts: string[] = ["必须遵守本书已保存的伴读设定；设定只约束视觉表现，不能补写正文不存在的事实。"];
  if (style) parts.push(`画风设定：${style}`);
  if (negative) parts.push(`避免内容：${negative}`);
  if (characters) parts.push(`人物设定：${characters}`);
  return parts.join("\n");
}

function companionPromptWithGuidance(prompt: string, maxLength: number): string {
  const guidance = companionVisualGuidance();
  return `${prompt.trim()}${guidance ? `\n\n${guidance}` : ""}`.slice(0, maxLength).trim();
}

async function openReaderCompanionSettings(): Promise<void> {
  if (!readerCompanionBookId()) {
    aiReaderSetStatus("请先打开图书再编辑伴读设定");
    return;
  }
  aiReaderCompanionSettingsPanel?.removeAttribute("hidden");
  setReaderCompanionSettingsStatus("正在读取当前图书的本机设定…");
  await loadReaderCompanionSettings();
  if (!aiReaderCompanionSettingsStatus?.textContent?.startsWith("读取本机")) {
    setReaderCompanionSettingsStatus("仅保存在本机；保存后用于后续图片和视频提示词。");
  }
}

async function saveReaderCompanionSettings(): Promise<void> {
  const bookId = readerCompanionBookId();
  if (!bookId) return;
  const settings: ReaderCompanionSettings = {
    bookId,
    stylePrompt: aiReaderCompanionStyle?.value || "",
    negativePrompt: aiReaderCompanionNegative?.value || "",
    characterNotes: aiReaderCompanionCharacters?.value || "",
  };
  setReaderCompanionSettingsStatus("正在保存到本机…");
  try {
    const saved = await invoke<ReaderCompanionSettings>("reader_companion_settings_save", { settings });
    if (readerCompanionBookId() !== bookId) return;
    readerCompanionSettings = saved;
    renderReaderCompanionSettings(saved);
    setReaderCompanionSettingsStatus("已保存到本机；不会同步或上传。");
  } catch (error) {
    setReaderCompanionSettingsStatus(`保存本机伴读设定失败：${error}`);
  }
}

async function prepareReaderMedia(kind: "image" | "video"): Promise<void> {
  if (aiReaderRequestRunning) return;
  aiReaderRequestRunning = true;
  aiReaderStartProgress("summary");
  aiReaderSetStatus(kind === "image" ? "正在提取可视化场景…" : "正在提取视频分镜…");
  try {
    const instruction = kind === "image"
      ? "根据当前选中文字和已经读到的相关正文，生成一段可直接用于文生图的中文提示词。必须包含场景、人物外貌与服装、动作、环境、光线、构图和风格；只输出提示词，不要解释，不得补写原文没有的身份或情节。"
      : "根据当前选中文字和已经读到的相关正文，生成一段可直接用于视频生成的中文分镜提示词。必须包含场景、人物外貌与服装、动作或打斗、关键对话、镜头运动、环境声音和节奏；只输出提示词，不要解释，不得补写原文没有的身份或情节。";
    const answer = await invoke<AiAnswer>("ask_reading_assistant", { request: {
      task: "question",
      question: `${instruction}${companionVisualGuidance() ? `\n\n${companionVisualGuidance()}` : ""}`,
      currentChapter: curChapter,
      currentFraction: curChFrac,
      selectedText: aiReaderSelectedText,
      selectedStart: aiReaderSelectedAnchor?.start,
      selectedEnd: aiReaderSelectedAnchor?.end,
      sessionMemory: aiReaderSessionMemory(),
    } });
    const prompt = String(answer.content || "").trim();
    if (!prompt) throw new Error("本地模型没有返回可用场景提示词");
    aiReaderMediaKind = kind;
    aiReaderMediaComposer?.removeAttribute("hidden");
    if (aiReaderMediaTitle) aiReaderMediaTitle.textContent = kind === "image" ? "图片生成提示词" : "生成带声音的视频";
    if (aiReaderMediaPrompt) {
      aiReaderMediaPrompt.maxLength = kind === "image" ? 1500 : 7000;
      aiReaderMediaPrompt.value = companionPromptWithGuidance(prompt, aiReaderMediaPrompt.maxLength);
      aiReaderMediaPrompt.focus();
    }
    if (aiReaderMediaConsent) aiReaderMediaConsent.checked = false;
    if (aiReaderMediaConsentCopy) {
      aiReaderMediaConsentCopy.textContent = kind === "image"
        ? "我已检查提示词，同意交给本机 MiniMax-H3 生成代表帧；内容不会上传"
        : "我已检查提示词，同意交给本机 MiniMax-H3 生成；内容不会上传";
    }
    if (aiReaderMediaSubmit) {
      aiReaderMediaSubmit.disabled = true;
      aiReaderMediaSubmit.textContent = kind === "image" ? "确认生成图片" : "确认生成视频";
    }
    aiReaderSetStatus(kind === "image"
      ? "图片提示词已生成，请检查后交给本机 MiniMax-H3"
      : "视频提示词已生成，请检查后交给本机 MiniMax-H3");
  } catch (error) {
    aiReaderSetStatus(`准备伴读提示词失败：${error}`);
  } finally {
    aiReaderStopProgress();
    aiReaderRequestRunning = false;
  }
}

interface ReaderContextMediaCacheEntry extends ReaderContextMediaAsset { readonly bookKey: string }
interface ReaderContextMediaPromptPlan {
  readonly kind: "image" | "video";
  readonly prompt: string;
  readonly caption: string;
  readonly placement: ReaderContextMediaPlacement;
  readonly chapter: number;
  readonly anchorStart: number;
  readonly anchorEnd: number;
}

function readerContextMediaBookKey(): string {
  return String(currentBookContentId || currentBookId || "").trim();
}

function readerContextMediaChapterKey(chapter: number): string {
  return `${readerContextMediaBookKey()}|${chapter}`;
}

function resetReaderContextMediaQueueForBook(nextBookKey: string): void {
  if (!readerContextMediaLastBookKey || readerContextMediaLastBookKey === nextBookKey) return;
  readerContextMediaPending.clear();
  window.clearTimeout(readerContextMediaBatchTimer);
  readerContextMediaBatchTimer = 0;
  readerContextMediaBatchFailureCount = 0;
  readerContextMediaLastChapter = -1;
}

function readReaderContextMediaCache(): ReaderContextMediaCacheEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(READER_CONTEXT_MEDIA_CACHE_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is ReaderContextMediaCacheEntry => {
      const item = value as Partial<ReaderContextMediaCacheEntry>;
      return typeof item.bookKey === "string" && (item.kind === "image" || item.kind === "video") &&
        typeof item.absolutePath === "string" && Number.isInteger(item.chapter) && item.chapter! >= 0;
    }).slice(-240);
  } catch {
    return [];
  }
}

function sendReaderContextMediaAsset(asset: ReaderContextMediaAsset): void {
  if (isPdf || asset.chapter !== curChapter || !asset.absolutePath) return;
  sendToPage({ contextMediaAsset: {
    kind: asset.kind,
    assetUrl: readerMediaFileUrl(asset.absolutePath),
    chapter: asset.chapter,
    anchorStart: asset.anchorStart,
    anchorEnd: asset.anchorEnd,
    caption: asset.caption,
    placement: asset.placement,
  } });
}

function cacheReaderContextMediaAsset(asset: ReaderContextMediaAsset): void {
  const bookKey = readerContextMediaBookKey();
  if (!bookKey) return;
  const cache = readReaderContextMediaCache();
  const signature = `${bookKey}|${asset.chapter}|${asset.kind}|${asset.placement}|${asset.anchorStart}|${asset.anchorEnd}`;
  const filtered = cache.filter((item) =>
    `${item.bookKey}|${item.chapter}|${item.kind}|${item.placement}|${item.anchorStart}|${item.anchorEnd}` !== signature);
  filtered.push({ ...asset, bookKey, caption: asset.caption.slice(0, 320) });
  try { localStorage.setItem(READER_CONTEXT_MEDIA_CACHE_KEY, JSON.stringify(filtered.slice(-240))); } catch { /* local cache is optional */ }
}

function restoreReaderContextMediaAssets(chapter: number): void {
  const bookKey = readerContextMediaBookKey();
  if (!bookKey) return;
  const assets = readReaderContextMediaCache().filter((item) => item.bookKey === bookKey && item.chapter === chapter);
  if (assets.length) readerContextMediaProcessed.add(readerContextMediaChapterKey(chapter));
  for (const asset of assets) sendReaderContextMediaAsset(asset);
}

function renderReaderMediaAsset(kind: "image" | "video", absolutePath: string, plan?: Omit<ReaderContextMediaAsset, "kind" | "absolutePath">): void {
  if (!aiReaderMediaResult) return;
  const status = document.createElement("div");
  status.textContent = kind === "image" ? "图片已生成并保存到本机缓存" : "视频已生成并保存到本机缓存";
  const media = document.createElement(kind === "image" ? "img" : "video");
  media.src = readerMediaFileUrl(absolutePath);
  if (media instanceof HTMLImageElement) media.alt = "根据当前已读场景生成的图片";
  if (media instanceof HTMLVideoElement) media.controls = true;
  aiReaderMediaResult.replaceChildren(status, media);
  aiReaderMediaResult.removeAttribute("hidden");
  if (plan) {
    const asset: ReaderContextMediaAsset = { kind, absolutePath, ...plan };
    cacheReaderContextMediaAsset(asset);
    sendReaderContextMediaAsset(asset);
  }
}

async function pollReaderMediaVideo(taskId: string, token: number): Promise<string> {
  for (let attempt = 0; attempt < 120 && token === aiReaderMediaPollToken; attempt += 1) {
    const result = await invoke<ReaderMediaVideoStatus>("query_reader_media_video", { taskId });
    if (result.status === "success" && result.absolutePath) {
      aiReaderSetStatus("视频生成完成");
      if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = false;
      return result.absolutePath;
    }
    if (result.status === "failed") throw new Error(result.message || "MiniMax 视频生成失败");
    if (aiReaderMediaResult) {
      aiReaderMediaResult.textContent = `本机 MiniMax-H3 正在生成视频，首次加载或分层卸载时可能需要较长时间…（${attempt + 1}）`;
      aiReaderMediaResult.removeAttribute("hidden");
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 4000));
  }
  if (token === aiReaderMediaPollToken) throw new Error("视频任务等待超时，可稍后重新查询");
  throw new Error("视频任务已取消");
}

async function beginReaderMediaCycle(): Promise<string> {
  const cycle = await invoke<ReaderMediaGenerationCycle>("begin_reader_media_generation_cycle");
  const cycleId = String(cycle.cycleId || "");
  if (!cycleId) throw new Error("本机影像生成没有返回显存轮换标识");
  aiReaderMediaCycleToken = cycleId;
  return cycleId;
}

async function finishReaderMediaCycle(cycleId: string): Promise<void> {
  if (!cycleId) return;
  await invoke("finish_reader_media_generation_cycle", { cycleId });
  if (aiReaderMediaCycleToken === cycleId) aiReaderMediaCycleToken = "";
}

async function submitReaderMedia(): Promise<void> {
  const prompt = aiReaderMediaPrompt?.value.trim() || "";
  if (!aiReaderMediaKind || !prompt || !aiReaderMediaConsent?.checked) return;
  const kind = aiReaderMediaKind;
  const token = ++aiReaderMediaPollToken;
  const anchorStart = Math.max(0, Math.round(aiReaderSelectedAnchor?.start ?? curReadingAnchor?.text_offset ?? 0));
  const anchorEnd = Math.max(anchorStart + 1, Math.round(aiReaderSelectedAnchor?.end ?? anchorStart + 1));
  const plan = { chapter: curChapter, anchorStart, anchorEnd, caption: kind === "image" ? "根据此处正文生成的情境图片" : "根据此处正文生成的情境视频", placement: "anchor" as const };
  let cycleId = "";
  if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = true;
  if (aiReaderMediaResult) {
    aiReaderMediaResult.textContent = kind === "image" ? "正在切换显存并由本机 MiniMax-H3 生成图片…" : "正在切换显存并提交本机 MiniMax-H3 视频任务…";
    aiReaderMediaResult.removeAttribute("hidden");
  }
  try {
    cycleId = await beginReaderMediaCycle();
    if (kind === "image") {
      const result = await invoke<ReaderMediaImageResult>("generate_reader_media_image", { request: {
        prompt, aspectRatio: "16:9", n: 1, promptOptimizer: true,
      } });
      const absolutePath = result.images?.[0]?.absolutePath;
      if (!absolutePath) throw new Error("MiniMax-H3 未返回图片结果");
      renderReaderMediaAsset("image", absolutePath, plan);
      aiReaderSetStatus("图片已生成并插入对应正文下方");
    } else {
      const created = await invoke<ReaderMediaVideoStatus>("create_reader_media_video", { request: {
        prompt, resolution: "768P", duration: 5, ratio: "16:9",
      } });
      if (!created.taskId) throw new Error("MiniMax 未返回视频任务编号");
      const absolutePath = await pollReaderMediaVideo(created.taskId, token);
      renderReaderMediaAsset("video", absolutePath, plan);
    }
  } catch (error) {
    if (aiReaderMediaResult) {
      aiReaderMediaResult.textContent = `生成失败：${error}`;
      aiReaderMediaResult.removeAttribute("hidden");
    }
    aiReaderSetStatus("伴读生成失败");
  } finally {
    if (cycleId) {
      try { await finishReaderMediaCycle(cycleId); }
      catch (error) { aiReaderSetStatus(`影像已完成，但恢复本地模型失败：${error}`); }
    }
    if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = !aiReaderMediaConsent?.checked;
  }
}

function readerContextMediaPolicy(): string {
  try { return localStorage.getItem("readerMediaPolicyV1") || "suggest"; }
  catch { return "suggest"; }
}

function readerContextMediaSetting(): UnknownRecord {
  return (window.ReaderSettings?.get?.() || {}) as UnknownRecord;
}

function contextMediaCadence(kind: "image" | "video", density: unknown): number {
  const value = ["low", "medium", "high"].includes(String(density)) ? String(density) : "medium";
  if (kind === "image") return value === "low" ? 3 : value === "medium" ? 2 : 1;
  return value === "low" ? 12 : value === "medium" ? 6 : 3;
}

function requestedContextMediaPlacements(chapter: number): Array<{ kind: "image" | "video"; placement: ReaderContextMediaPlacement }> {
  const settings = readerContextMediaSetting();
  const placements: Array<{ kind: "image" | "video"; placement: ReaderContextMediaPlacement }> = [];
  if (chapter % contextMediaCadence("image", settings.readerMediaImageDensity) === 0) placements.push({ kind: "image", placement: "anchor" });
  if (chapter % contextMediaCadence("video", settings.readerMediaVideoDensity) === 0) placements.push({ kind: "video", placement: "anchor" });
  if (settings.showReaderMediaImageSummaryAtChapterStart === true) placements.push({ kind: "image", placement: "chapterStart" });
  if (settings.showReaderMediaImageSummaryAtChapterEnd === true) placements.push({ kind: "image", placement: "chapterEnd" });
  if (settings.showReaderMediaVideoSummaryAtChapterStart === true) placements.push({ kind: "video", placement: "chapterStart" });
  if (settings.showReaderMediaVideoSummaryAtChapterEnd === true) placements.push({ kind: "video", placement: "chapterEnd" });
  return placements.slice(0, 5);
}

function parseContextMediaPromptPlans(content: string, chapter: number, anchorOffset: number): ReaderContextMediaPromptPlan[] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(content.slice(start, end + 1)) as { readonly items?: readonly UnknownRecord[] };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.flatMap((item): ReaderContextMediaPromptPlan[] => {
      const kind = item.kind === "video" ? "video" : item.kind === "image" ? "image" : null;
      const placement = ["anchor", "chapterStart", "chapterEnd"].includes(String(item.placement))
        ? String(item.placement) as ReaderContextMediaPlacement : null;
      const prompt = String(item.prompt || "").trim();
      if (!kind || !placement || !prompt) return [];
      const boundedPrompt = prompt.slice(0, kind === "image" ? 1500 : 7000);
      return [{
        kind,
        placement,
        prompt: boundedPrompt,
        caption: String(item.caption || (kind === "image" ? "本章情境图片" : "本章情境视频")).trim().slice(0, 240),
        chapter,
        anchorStart: placement === "anchor" ? anchorOffset : 0,
        anchorEnd: placement === "anchor" ? anchorOffset + 1 : 1,
      }];
    }).slice(0, 5);
  } catch {
    return [];
  }
}

async function buildContextMediaPromptPlans(chapter: number, anchorOffset: number): Promise<ReaderContextMediaPromptPlan[]> {
  const placements = requestedContextMediaPlacements(chapter);
  if (!placements.length) return [];
  const specification = placements.map((item) => `${item.kind}:${item.placement}`).join(", ");
  const answer = await invoke<AiAnswer>("ask_reading_assistant", { request: {
    task: "companion_prompt",
    question: `阅读并理解已经完整读完的第 ${chapter + 1} 章正文证据，为下列位置分别生成视觉提示词：${specification}。image 要包含场景、人物外貌服装、动作、环境、光线、构图和风格；video 要包含场景、人物、动作或打斗、关键对话、镜头运动、环境声音与节奏。不得添加原文没有的身份、事实或情节。${companionVisualGuidance() ? `\n\n${companionVisualGuidance()}` : ""}\n\n只返回严格 JSON：{"items":[{"kind":"image或video","placement":"anchor或chapterStart或chapterEnd","caption":"不超过40字的中文说明","prompt":"提示词"}]}，不要 Markdown。`,
    currentChapter: chapter,
    currentFraction: 1,
    selectedText: "",
    sessionMemory: [],
  } });
  const plans = parseContextMediaPromptPlans(String(answer.content || ""), chapter, anchorOffset);
  const allowed = new Set(placements.map((item) => `${item.kind}:${item.placement}`));
  return plans
    .filter((plan) => allowed.has(`${plan.kind}:${plan.placement}`))
    .map((plan) => ({
      ...plan,
      prompt: companionPromptWithGuidance(plan.prompt, plan.kind === "image" ? 1500 : 7000),
    }));
}

async function waitReaderContextMediaVideo(taskId: string): Promise<string> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const result = await invoke<ReaderMediaVideoStatus>("query_reader_media_video", { taskId });
    if (result.status === "success" && result.absolutePath) return result.absolutePath;
    if (result.status === "failed") throw new Error(result.message || "MiniMax-H3 视频生成失败");
    await new Promise<void>((resolve) => window.setTimeout(resolve, 4000));
  }
  throw new Error("MiniMax-H3 视频生成超时");
}

async function generateReaderContextMediaPlan(plan: ReaderContextMediaPromptPlan, expectedBookKey: string): Promise<void> {
  if (readerContextMediaBookKey() !== expectedBookKey) throw new Error("图书已切换，取消旧书影像任务");
  let absolutePath = "";
  if (plan.kind === "image") {
    const result = await invoke<ReaderMediaImageResult>("generate_reader_media_image", { request: {
      prompt: plan.prompt, aspectRatio: "16:9", n: 1, promptOptimizer: true,
    } });
    absolutePath = String(result.images?.[0]?.absolutePath || "");
  } else {
    const created = await invoke<ReaderMediaVideoStatus>("create_reader_media_video", { request: {
      prompt: plan.prompt, resolution: "544P", duration: 5, ratio: "16:9",
    } });
    if (!created.taskId) throw new Error("MiniMax-H3 未返回视频任务编号");
    absolutePath = await waitReaderContextMediaVideo(created.taskId);
  }
  if (!absolutePath) throw new Error("MiniMax-H3 未返回本机媒体文件");
  if (readerContextMediaBookKey() !== expectedBookKey) throw new Error("图书已切换，不保存旧书影像结果");
  const asset: ReaderContextMediaAsset = { ...plan, absolutePath };
  cacheReaderContextMediaAsset(asset);
  sendReaderContextMediaAsset(asset);
}

async function flushReaderContextMediaBatch(): Promise<void> {
  if (readerContextMediaBatchRunning || readerContextMediaPolicy() !== "auto" || aiReaderRequestRunning) {
    if (readerContextMediaPending.size) readerContextMediaBatchTimer = window.setTimeout(() => void flushReaderContextMediaBatch(), 5000);
    return;
  }
  const chapters = Array.from(readerContextMediaPending.entries()).slice(0, 3);
  if (!chapters.length) return;
  const batchBookKey = readerContextMediaBookKey();
  if (!batchBookKey) return;
  for (const [chapter] of chapters) readerContextMediaPending.delete(chapter);
  readerContextMediaBatchRunning = true;
  aiReaderRequestRunning = true;
  let cycleId = "";
  try {
    // 提示词必须在大模型仍运行时按章全部准备好；只有这一阶段完成后才
    // 释放显存并启动 H3，避免两个大模型同时驻留。
    const plans: ReaderContextMediaPromptPlan[] = [];
    for (const [chapter, anchorOffset] of chapters) {
      plans.push(...await buildContextMediaPromptPlans(chapter, anchorOffset));
      if (readerContextMediaBookKey() !== batchBookKey) throw new Error("图书已切换，取消旧书提示词批次");
    }
    if (!plans.length) throw new Error("大模型未返回可用的伴读提示词");
    cycleId = await beginReaderMediaCycle();
    const failedChapters = new Set<number>();
    for (const plan of plans) {
      try { await generateReaderContextMediaPlan(plan, batchBookKey); }
      catch (error) {
        failedChapters.add(plan.chapter);
        window.ReaderBugTrace?.record?.("context_media", { phase: "asset_failed", kind: plan.kind, chapter: plan.chapter, error: String(error).slice(0, 160) });
      }
    }
    for (const [chapter, anchor] of chapters) {
      if (failedChapters.has(chapter)) readerContextMediaPending.set(chapter, anchor);
      else readerContextMediaProcessed.add(readerContextMediaChapterKey(chapter));
    }
    readerContextMediaBatchFailureCount = failedChapters.size ? readerContextMediaBatchFailureCount + 1 : 0;
  } catch (error) {
    if (readerContextMediaBookKey() === batchBookKey) {
      for (const [chapter, anchor] of chapters) readerContextMediaPending.set(chapter, anchor);
    }
    readerContextMediaBatchFailureCount += 1;
    window.ReaderBugTrace?.record?.("context_media", { phase: "batch_failed", chapters: chapters.length, error: String(error).slice(0, 160) });
  } finally {
    if (cycleId) {
      try { await finishReaderMediaCycle(cycleId); }
      catch (error) { window.ReaderBugTrace?.record?.("context_media", { phase: "restore_failed", error: String(error).slice(0, 160) }); }
    }
    aiReaderRequestRunning = false;
    readerContextMediaBatchRunning = false;
    if (readerContextMediaBookKey() === batchBookKey && readerContextMediaPending.size && readerContextMediaPolicy() === "auto") {
      const retryDelay = readerContextMediaBatchFailureCount > 0
        ? Math.min(15 * 60_000, 30_000 * (2 ** Math.min(readerContextMediaBatchFailureCount - 1, 5)))
        : 5000;
      readerContextMediaBatchTimer = window.setTimeout(() => void flushReaderContextMediaBatch(), retryDelay);
    }
  }
}

function observeReaderContextMediaChapter(
  chapter: number,
  anchor: ReadingAnchor | null,
  previousChapter = -1,
  previousFraction = 0,
  previousAnchor: ReadingAnchor | null = null,
): void {
  const bookKey = readerContextMediaBookKey();
  if (!bookKey) return;
  if (chapter === readerContextMediaLastChapter && bookKey === readerContextMediaLastBookKey) return;
  readerContextMediaLastChapter = chapter;
  readerContextMediaLastBookKey = bookKey;
  restoreReaderContextMediaAssets(chapter);
  // 陪读只能在读者离开且真正读完一章后处理该章；之前的实现会在刚
  // 进入新章时把新章前 50% 提供给模型，既抢资源也可能泄露未读情节。
  const completedChapter = previousChapter >= 0 && chapter > previousChapter && previousFraction >= 0.98
    ? previousChapter : -1;
  if (readerContextMediaPolicy() !== "auto" || completedChapter < 0 || readerContextMediaProcessed.has(readerContextMediaChapterKey(completedChapter))) return;
  const anchorOffset = Math.max(0, Math.round(Number(previousAnchor?.text_offset) || 0));
  readerContextMediaPending.set(completedChapter, anchorOffset);
  if (readerContextMediaPending.size >= 3) void flushReaderContextMediaBatch();
  else {
    window.clearTimeout(readerContextMediaBatchTimer);
    readerContextMediaBatchTimer = window.setTimeout(() => void flushReaderContextMediaBatch(), 12_000);
  }
}

type ReadingMemoryCaptureStatus = { readonly status: string; readonly chapter: number; readonly message: string };

function readerMemoryCaptureKey(chapter: number): string {
  return `${readerContextMediaBookKey()}|${chapter}`;
}

function queueCompletedReadingMemory(
  completedChapter: number,
  observedCurrentChapter: number,
  observedCurrentFraction: number,
): void {
  if (isPdf || completedChapter < 0 || observedCurrentChapter <= completedChapter) return;
  const key = readerMemoryCaptureKey(completedChapter);
  if (!key || readerMemoryCaptureQueued.has(key)) return;
  readerMemoryCaptureQueued.add(key);
  readerMemoryCapturePending.set(key, {
    completedChapter,
    observedCurrentChapter,
    observedCurrentFraction,
    retries: 0,
  });
  // Let the normal reader progress write settle first; a memory task never
  // delays page turning, progress reporting, or user-initiated 智读.
  window.clearTimeout(readerMemoryCaptureStartTimer);
  readerMemoryCaptureStartTimer = window.setTimeout(() => void drainReadingMemoryCaptureQueue(), 900);
}

async function drainReadingMemoryCaptureQueue(): Promise<void> {
  if (readerMemoryCaptureInFlight) return;
  const next = readerMemoryCapturePending.entries().next().value as [string, ReadingMemoryCaptureJob] | undefined;
  if (!next) return;
  const [key, job] = next;
  readerMemoryCapturePending.delete(key);
  readerMemoryCaptureInFlight = true;
  let retryScheduled = false;
  try {
    const result = await invoke<ReadingMemoryCaptureStatus>("capture_reading_memory", { request: {
      completedChapter: job.completedChapter,
      observedCurrentChapter: job.observedCurrentChapter,
      observedCurrentFraction: job.observedCurrentFraction,
    } });
    // The backend checks persisted progress independently. A single delayed
    // retry handles ordinary progress-write throttling while allowing later
    // completed chapters to continue through the queue immediately.
    if (result.status === "skipped" && job.retries < 1) {
      retryScheduled = true;
      window.setTimeout(() => {
        readerMemoryCapturePending.set(key, { ...job, retries: job.retries + 1 });
        void drainReadingMemoryCaptureQueue();
      }, 3500);
      return;
    }
    window.ReaderBugTrace?.record?.("reading_memory", {
      phase: "capture",
      chapter: job.completedChapter,
      status: result.status,
    });
  } catch (error) {
    window.ReaderBugTrace?.record?.("reading_memory", {
      phase: "capture_failed",
      chapter: job.completedChapter,
      error: String(error).slice(0, 160),
    });
  } finally {
    readerMemoryCaptureInFlight = false;
    if (!retryScheduled) readerMemoryCaptureQueued.delete(key);
    void drainReadingMemoryCaptureQueue();
  }
}
document.getElementById("ai-reader-btn")?.addEventListener("click", (event) => { event.stopPropagation(); openAiReader(); });
document.getElementById("ai-reader-close")?.addEventListener("click", closeAiReaderSide);
document.getElementById("ai-reader-history-btn")?.addEventListener("click", () => aiReaderShowHistory());
aiReaderHistorySettingsButton?.addEventListener("click", (event) => {
  event.stopPropagation();
  aiReaderHistoryMenu.hidden = !aiReaderHistoryMenu.hidden;
});
document.querySelectorAll<HTMLElement>("[data-ai-reader-sync-mode]").forEach((button) => button.addEventListener("click", () => aiReaderSetHistorySyncMode(button.dataset.aiReaderSyncMode)));
document.querySelectorAll<HTMLElement>("[data-ai-reader-width]").forEach((button) => button.addEventListener("click", () => setAiReaderSideWidth(button.dataset.aiReaderWidth)));
restoreAiReaderSideWidth();
document.getElementById("ai-reader-enter-submit")?.addEventListener("click", () => runAiReader("question"));
aiReaderQuestion?.addEventListener("keydown", (event) => {
  // Enter 提问，Shift + Enter 换行；候选词确认的 Enter 不得提前请求 API。
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.stopPropagation();
    runAiReader("question");
  }
});
document.addEventListener("click", (event) => {
  const targetElement = event.target instanceof Element ? event.target : null;
  if (aiReaderHistoryMenu && !aiReaderHistoryMenu.hidden && !targetElement?.closest(".ai-reader-history-controls")) aiReaderHistoryMenu.hidden = true;
  if (aiReaderSourcePreview?.hidden || aiReaderSourcePreview?.contains(targetElement) || targetElement?.closest(".ai-reader-citation")) return;
  aiReaderHideSourcePreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && aiReaderSourcePreview && !aiReaderSourcePreview.hidden) aiReaderHideSourcePreview();
});
aiReaderAnswer?.addEventListener("scroll", aiReaderHideSourcePreview);
document.getElementById("ai-reader-ask")?.addEventListener("click", () => runAiReader("question"));
document.getElementById("ai-reader-summary")?.addEventListener("click", () => runAiReader("summary"));
document.getElementById("ai-reader-mindmap")?.addEventListener("click", () => runAiReader("mindmap"));
document.getElementById("ai-reader-image")?.addEventListener("click", () => prepareReaderMedia("image"));
document.getElementById("ai-reader-video")?.addEventListener("click", () => prepareReaderMedia("video"));
document.getElementById("ai-reader-companion-settings")?.addEventListener("click", () => void openReaderCompanionSettings());
document.getElementById("ai-reader-companion-settings-close")?.addEventListener("click", () => aiReaderCompanionSettingsPanel?.setAttribute("hidden", ""));
document.getElementById("ai-reader-companion-settings-save")?.addEventListener("click", () => void saveReaderCompanionSettings());
document.getElementById("ai-reader-media-cancel")?.addEventListener("click", resetReaderMediaComposer);
aiReaderMediaConsent?.addEventListener("change", () => {
  if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = !aiReaderMediaConsent.checked || !aiReaderMediaPrompt?.value.trim();
});
aiReaderMediaPrompt?.addEventListener("input", () => {
  if (aiReaderMediaSubmit) aiReaderMediaSubmit.disabled = !aiReaderMediaConsent?.checked || !aiReaderMediaPrompt.value.trim();
});
aiReaderMediaSubmit?.addEventListener("click", () => void submitReaderMedia());
readerToolbar?.addEventListener("pointerenter", () => {
  ReaderShell.dispatch({ type: "TOOLBAR_POINTER_ENTER" });
});
readerToolbar?.addEventListener("pointerleave", () => {
  ReaderShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
});
document.getElementById("immersive-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setImmersive(!immersive);
});
setImmersive(immersive); // 应用上次的沉浸状态
// PDF 缩放
document.getElementById("zoom-in").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "in" }); });
document.getElementById("zoom-out").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "out" }); });
let pdfDual = false;
let pdfStateTimer: ReturnType<typeof setTimeout> | null = null;
document.getElementById("pdf-dual").addEventListener("click", (e) => {
  e.stopPropagation();
  pdfDual = !pdfDual;
  document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
  sendToPage({ dual: pdfDual });
});
// 朗读
let ttsPlaying = false,
  ttsNoSystemVoiceWarned = false;
const ttsBtn = document.getElementById("tts-btn");
ttsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ttsPlaying = !ttsPlaying;
  sendToPage({ tts: ttsPlaying ? "start" : "stop" });
});

// 书架检索点击 → 跳到命中章节并高亮（等合并页就绪后再发）
let frameReady = false;
let pendingJump: JumpRequest | null = null;
interface ReaderSwitchRequest {
  readonly id: string;
  readonly reuseClosedSave: boolean;
}
interface QueuedReaderSwitchRequest extends ReaderSwitchRequest {
  readonly sequence: number;
  readonly queuedAt: number;
}
// 与原生隐藏阅读外壳的最近保存窗口一致。关闭快照或本机磁盘偶发变慢时，
// 第一次点击仍必须兑现；不能因为结算超过 3 秒又把已排队请求丢掉。
const READER_SWITCH_QUEUE_MAX_AGE_MS = 15_000;
let readerCloseSettlementPending = false;
let queuedReaderSwitchRequest: QueuedReaderSwitchRequest | null = null;
let readerSwitchRequestSequence = 0;
function doJump(j: JumpRequest | null | undefined): void {
  if (!j) {
    window.consumePendingCrossSearch?.();
    return;
  }
  if (frameReady) {
    sendToPage({ gotoChapter: j.chapter || 0, search: j.term || "" });
    if (!j.term) setTimeout(() => window.consumePendingCrossSearch?.(), 120);
  } else {
    pendingJump = j;
  }
}
listen("shelf-jump", (e) => doJump(e.payload as JumpRequest));
function readerSwitchRequest(event: { readonly payload?: unknown } | null | undefined): ReaderSwitchRequest | null {
  const payload = event?.payload as { readonly bookId?: unknown; readonly skipFinalSave?: unknown } | undefined;
  const id = String(payload?.bookId || "");
  return /^\d+$/.test(id) ? { id, reuseClosedSave: payload?.skipFinalSave === true } : null;
}
function recordReaderSwitchQueue(phase: string, outcome: string, detail: UnknownRecord = {}): void {
  window.ReaderBugTrace?.record?.("switch_request_queue", {
    source: "reader_shell",
    phase,
    outcome,
    ...detail,
  });
}
function queueReaderSwitchRequest(request: ReaderSwitchRequest): void {
  const now = performance.now();
  const queued = queuedReaderSwitchRequest;
  if (queued?.id === request.id) {
    queuedReaderSwitchRequest = {
      ...request,
      sequence: queued.sequence,
      queuedAt: queued.queuedAt,
    };
    recordReaderSwitchQueue("queued", "deduplicated", {
      reason: "close_pending",
      sequence: queued.sequence,
      duration_ms: Math.max(0, Math.round(now - queued.queuedAt)),
    });
    return;
  }
  const sequence = ++readerSwitchRequestSequence;
  queuedReaderSwitchRequest = { ...request, sequence, queuedAt: now };
  recordReaderSwitchQueue("queued", queued ? "replaced" : "queued", {
    reason: "close_pending",
    sequence,
  });
}
function replayQueuedReaderSwitchRequest(): void {
  const queued = queuedReaderSwitchRequest;
  queuedReaderSwitchRequest = null;
  if (!queued) return;
  const age = Math.max(0, performance.now() - queued.queuedAt);
  if (age > READER_SWITCH_QUEUE_MAX_AGE_MS || !readerBookBound || !currentBookId) {
    recordReaderSwitchQueue("dropped", age > READER_SWITCH_QUEUE_MAX_AGE_MS ? "expired" : "invalid_binding", {
      reason: age > READER_SWITCH_QUEUE_MAX_AGE_MS ? "expired" : "reader_unbound",
      sequence: queued.sequence,
      duration_ms: Math.round(age),
    });
    return;
  }
  recordReaderSwitchQueue("replayed", "started", {
    reason: "close_completed",
    sequence: queued.sequence,
    duration_ms: Math.round(age),
  });
  void executeReaderSwitchRequest(queued);
}
async function executeReaderSwitchRequest(request: ReaderSwitchRequest): Promise<void> {
  if (readerWindowClosePending || !readerBookBound || !currentBookId) return;
  const { id, reuseClosedSave } = request;
  readerWindowClosePending = true;
  let preparedTarget: Promise<boolean> | null = null;
  let switchCompleted = false;
  try {
    // 点击时立刻把已就绪的隐藏外壳绑定到目标书。它在后台取 book_info、创建
    // iframe、加载章节；旧书的位置保存与读字统计在这里并行进行，成功后才显示。
    preparedTarget = invoke<boolean>("prepare_reader_switch_target", { id })
      .then((prepared) => !!prepared)
      .catch((error) => {
        window.ReaderBugTrace?.record?.("switch_target_prepare", {
          source: "reader_shell",
          outcome: "failed",
          error: String(error).slice(0, 120),
        });
        return false;
      });
    if (reuseClosedSave) {
      // 刚刚关闭的隐藏阅读页已确认写入当前位置；它在隐藏期间没有新的用户输入，
      // 因此无需再等待一次 iframe 快照和 progress IPC。仍立即结算已积累的读字数。
      window.ReaderBugTrace?.record?.("switch_position_snapshot", {
        source: "reader_shell",
        outcome: "reused_closed_save",
      });
    } else {
      // 切书不能为了等待一段尚未完成的章节转场而停住整个窗口。正文页会在
      // 短暂等待后立刻回传稳定锚点；超时则保存壳已收到的最近一次确认位置。
      // 关闭窗口仍沿用较长的完整排版等待，避免把两条路径的可靠性要求混在一起。
      const snapshotConfirmed = await requestPagePositionSnapshot({
        turnWaitMs: 180,
        responseTimeoutMs: 420,
      });
      window.ReaderBugTrace?.record?.("switch_position_snapshot", {
        source: "reader_shell",
        outcome: snapshotConfirmed ? "confirmed" : "recent_position",
      });
      const resumeRestoreWasPending = sameBookResumePending;
      const saved = await sendProgressNow();
      // 同书恢复事务尚未完成时没有任何新用户位置可保存；沿用关闭前已落盘的
      // 锚点即可安全切书，但不能把这次“未写入”伪装成 hidden-after-save。
      if (!saved && !resumeRestoreWasPending) throw new Error("旧图书阅读位置保存失败");
    }
    pauseReadTracking("switch-book");
    await flushReadWords(true);
    await preparedTarget;
    await invoke("complete_reader_switch", { id });
    switchCompleted = true;
  } catch (error) {
    if (!switchCompleted && preparedTarget) {
      void preparedTarget.then((prepared) => {
        if (prepared) return invoke("cancel_prepared_reader_switch_target", { id });
        return undefined;
      }).catch(() => {});
    }
    readerWindowClosePending = false;
    console.warn("切换图书失败", error);
  }
}
listen("reader-switch-request", (event) => {
  const request = readerSwitchRequest(event);
  if (!request || !readerBookBound || !currentBookId) return;
  if (readerWindowClosePending) {
    if (readerCloseSettlementPending) queueReaderSwitchRequest(request);
    else recordReaderSwitchQueue("dropped", "busy", { reason: "switch_in_progress" });
    return;
  }
  void executeReaderSwitchRequest(request);
});
listen("reader-hide-request", () => closeReaderWindow().catch(() => {}));
listen("reader-shell-resume", () => {
  resumeHiddenReaderShell();
});
const bugTraceRequestReady = listen("reader-bug-trace-request", async (event) => {
  const payload = event?.payload as { readonly request_id?: unknown } | undefined;
  const requestId = String(payload?.request_id || "").slice(0, 96);
  if (!requestId || !window.ReaderBugTrace?.capture) return;
  const snapshot = await window.ReaderBugTrace.capture("main_menu") as UnknownRecord;
  const nativeWindowState = await invoke<ReaderWindowDiagnosticState>("reader_window_diagnostic_state")
    .catch(() => null);
  const readerState = snapshot.reader_state && typeof snapshot.reader_state === "object"
    ? snapshot.reader_state as UnknownRecord
    : {};
  const enrichedSnapshot = nativeWindowState ? {
    ...snapshot,
    reader_state: {
      ...readerState,
      window_role: nativeWindowState.window_role,
      window_visible: nativeWindowState.window_visible,
      book_bound: nativeWindowState.book_bound,
      window_registered: nativeWindowState.registered,
    },
  } : snapshot;
  await emit("reader-bug-trace-response", { request_id: requestId, snapshot: enrichedSnapshot });
});
Promise.resolve(bugTraceRequestReady).then(() => window.ReaderBugTrace?.checkpoint?.(0)).catch(() => {});
listen("reader-bug-trace-reset", () => window.ReaderBugTrace?.reset?.());

const tocEl = document.getElementById("toc");
const backdropEl = document.getElementById("backdrop");
const loadingEl = document.getElementById("loading");
let loadingHidden = false;
function hideLoading() {
  if (!loadingHidden) {
    loadingHidden = true;
    loadingEl.classList.add("hide");
  }
}
const settingsEl = document.getElementById("settings");
void tocEl;
void backdropEl;
void settingsEl;
const chapterProgressEl = document.getElementById("chapter-progress");
const chapterNumberEl = document.getElementById("chapter-number");
const chapterPageEl = document.getElementById("chapter-page");
const progressPercentageEl = document.getElementById("progress-percentage");
const progressEl = document.getElementById("progress");
const readerProgressGroupEl = document.getElementById("reader-progress-group");
const PAGE_INFO_ITEM_IDS = ["chapter", "chapterPage", "percentage", "totalPages"] as const;
let pageCountMeasuring = true;
function pageInfoEnabled(key: string): boolean {
  const settings = window.ReaderSettings?.get?.() || {};
  return settings.showPageInfo !== false && settings[key] !== false;
}
function normalizedPageInfoOrder(value: unknown): readonly string[] {
  const known = new Set<string>(PAGE_INFO_ITEM_IDS);
  const seen = new Set<string>();
  const order: string[] = [];
  if (Array.isArray(value)) value.forEach((item) => {
    const id = String(item);
    if (known.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  });
  PAGE_INFO_ITEM_IDS.forEach((id) => { if (!seen.has(id)) order.push(id); });
  return order;
}
function applyPageInfoOrder(): void {
  const settings = window.ReaderSettings?.get?.() || {};
  const items: Readonly<Record<string, HTMLElement | null>> = {
    chapter: chapterNumberEl,
    chapterPage: chapterPageEl,
    percentage: progressPercentageEl,
    totalPages: progressEl,
  };
  normalizedPageInfoOrder(settings.pageInfoOrder).forEach((id) => {
    const item = items[id];
    if (item) readerProgressGroupEl?.append(item);
  });
}
function applyPageInfoVisibility(): void {
  const showChapter = pageInfoEnabled("showChapterNumber");
  const showChapterPage = pageInfoEnabled("showChapterPageNumber");
  const showPercentage = pageInfoEnabled("showProgressPercentage");
  chapterNumberEl?.toggleAttribute("hidden", !showChapter);
  chapterPageEl?.toggleAttribute("hidden", !showChapterPage);
  progressPercentageEl?.toggleAttribute("hidden", !showPercentage);
  chapterProgressEl?.toggleAttribute("hidden", !showChapter && !showChapterPage && !showPercentage);
  progressEl?.toggleAttribute("hidden", !pageInfoEnabled("showTotalPageNumber"));
  applyPageInfoOrder();
}
function showProgressLoading() {
  if (isPdf) {
    progressEl.innerHTML = '<span class="mini-spinner" aria-label="' + readerText("loading", "加载中…") + '"></span>';
    applyPageInfoVisibility();
    return;
  }
  pageCountMeasuring = true;
  progressEl.classList.remove("page-count-total");
  progressEl.classList.add("page-count-loading");
  progressEl.title = readerText("measuringPages", "全书页数统计中");
  progressEl.setAttribute("aria-label", readerText("measuringPages", "全书页数统计中"));
  progressEl.innerHTML = '<span class="mini-spinner" aria-label="' + readerText("measuringPages", "全书页数统计中") + '"></span>';
  applyPageInfoVisibility();
}
function showWholeBookPages(page: unknown, total: unknown): void {
  pageCountMeasuring = false;
  progressEl.classList.remove("page-count-loading");
  progressEl.classList.add("page-count-total");
  const text = readerText("wholeBookPages", "{page}/{total}页", { page, total });
  progressEl.title = text;
  progressEl.setAttribute("aria-label", text);
  progressEl.textContent = text;
  applyPageInfoVisibility();
}
function showChapterProgress(page: unknown, total: unknown, progress: number, dualContinuationChapter: unknown): void {
  if (!chapterProgressEl) return;
  const continuation = Number(dualContinuationChapter);
  const values = {
    chapter: curVchap + 1, chapters: vchapTotal, page: page || 1, total: total || 1, progress: progress.toFixed(1),
    nextChapter: continuation + 1,
  };
  const chapterText = Number.isInteger(continuation) && continuation >= 0
    ? readerText("dualChapterNumber", "第{chapter}/{chapters}章 · 右页 第{nextChapter}章开头", values)
    : readerText("chapterNumber", "第{chapter}/{chapters}章", values);
  const pageText = readerText("chapterPages", "本章 {page}/{total}页", values);
  const percentageText = readerText("progressPercentage", "{progress}%", values);
  if (chapterNumberEl) chapterNumberEl.textContent = chapterText;
  if (chapterPageEl) chapterPageEl.textContent = pageText;
  if (progressPercentageEl) progressPercentageEl.textContent = percentageText;
  const text = [
    pageInfoEnabled("showChapterNumber") ? chapterText : "",
    pageInfoEnabled("showChapterPageNumber") ? pageText : "",
    pageInfoEnabled("showProgressPercentage") ? percentageText : "",
  ].filter(Boolean).join(" · ");
  chapterProgressEl.title = text;
  chapterProgressEl.setAttribute("aria-label", text);
  applyPageInfoVisibility();
}

window.addEventListener("reader-settings-changed", applyPageInfoVisibility);
applyPageInfoVisibility();

let resumeChapter = 0;
let resumeFrac = 0;
// 当前位置（由合并页上报）
let curProgress = 0; // 全书进度 0~100
let curChapter = 0;
let curChFrac = 0; // 章内比例
let curReadingAnchor: ReadingAnchor | null = null; // 排版无关的正文字符锚点，供下次续读恢复
let curTotalCh = 1;

// 阅读偏好中的双页预览是另一张真正的 reader:// 阅读页，而不是手工拼出的
// 文字或图片。原页面始终保持不动，避免拖动中缝时重排当前阅读位置。
window.ReaderLayoutPreview = Object.freeze({
  source(dualPageGap: unknown): string {
    if (isPdf || !frameReady || !frame.src) return "";
    try {
      const url = new URL(frame.src, window.location.href);
      const settings = Object.assign({}, window.ReaderSettings?.get?.() || {}, {
        flowMode: "paged",
        pageMode: "dual",
        dualPageGap: Math.max(0, Math.min(120, Math.round(Number(dualPageGap) || 0))),
      });
      url.searchParams.set("rc", String(Math.max(0, Math.floor(Number(curChapter) || 0))));
      url.searchParams.set("rf", String(Math.max(0, Math.min(1, Number(curChFrac) || 0))));
      url.searchParams.set("ra", JSON.stringify(curReadingAnchor || null));
      url.searchParams.set("s", JSON.stringify(settings));
      return url.href;
    } catch {
      return "";
    }
  },
});
let isPdf = false; // PDF.js 模式
let lastPosSig = ""; // 阅读位置签名，用于沉浸模式翻页时自动收起工具栏
let keepImmersiveBarUntil = 0;
window.keepImmersiveBarAfterNav = function () {
  keepImmersiveBarUntil = Date.now() + 1800;
  ReaderShell.dispatch({ type: "SHOW_TOOLBAR" });
};
// 逻辑（虚拟）章节：按目录把大文件细分。vchaps 为 [{ch:spine序号, frag}]
let vchaps: VirtualChapter[] = [];
let curVchap = 0;
let vchapTotal = 1;

// The classic scripts loaded after reader.js historically resolved these
// names through the shared page scope.  The generated IIFE keeps one source
// of truth and exposes read-only global accessors instead of duplicating the
// state in a second runtime.
const exposeReaderState = (name: string, read: () => unknown): void => {
  Object.defineProperty(window, name, { configurable: true, enumerable: false, get: read });
};
exposeReaderState("curChapter", () => curChapter);
exposeReaderState("curProgress", () => curProgress);
exposeReaderState("curChFrac", () => curChFrac);
exposeReaderState("curReadingAnchor", () => curReadingAnchor);
exposeReaderState("isPdf", () => isPdf);
showProgressLoading();
  window.ReaderBugTrace?.setContextProvider?.(() => {
  const shell = ReaderShell.getState();
  return {
    book: {
      title: currentBookTitle,
      format: isPdf ? "pdf" : "epub",
    },
    state: {
      chapter: curChapter,
      progress: curProgress,
      chapter_frac: curChFrac,
      total_chapters: curTotalCh,
      overlay: shell.overlay,
      side_panel: shell.sidePanel,
      toolbar: shell.toolbar,
      frame_ready: frameReady,
      loading: !loadingHidden,
      is_pdf: isPdf,
      immersive: ReaderShell.isImmersive(),
      window_role: readerWindowRole(),
      document_visible: readerDocumentVisible(),
      book_bound: readerBookBound,
      book_info_loaded: Boolean(currentBookId),
      inner_engine_ready: innerReaderEngineReady,
      startup_phase: readerStartupPhase,
      startup_failure_category: readerStartupFailureCategory,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
    },
  };
});

function setSettingsOpen(open: unknown): void {
  ReaderShell.setOverlay(ReaderShell.OVERLAY.SETTINGS, !!open);
}
window.setReaderSettingsOpen = (open: boolean): void => {
  setSettingsOpen(open);
};
function closeSettings(): void {
  setSettingsOpen(false);
}
function isSearchInputEditActive(): boolean {
  return typeof window.isReaderSearchEditing === "function" && window.isReaderSearchEditing();
}
// 把"搜索框/设置面板是否打开"同步给合并页：打开时正文点击只用于关闭浮层
function syncOverlay(): void {
  const open = ReaderShell.hasOverlay();
  if (open) pauseReadTracking("overlay");
  sendToPage({ overlayOpen: open ? 1 : 0 });
}
window.addEventListener("reader-shell-statechange", ((e: CustomEvent<{ readonly previous?: UnknownRecord; readonly next?: UnknownRecord }>) => {
  window.ReaderBugTrace?.record?.("shell_state", {
    source: "reader_shell",
    overlay: e.detail?.next?.overlay || "none",
    side_panel: e.detail?.next?.sidePanel || "none",
    outcome: e.detail?.next?.toolbar || "normal",
  });
  if (e.detail?.previous?.overlay !== e.detail?.next?.overlay) syncOverlay();
}) as EventListener);

// 把阅读位置回传后端（节流，避免频繁写盘）
let progTimer: ReturnType<typeof setTimeout> | null = null;
let lastProgressReportChapter: number | null = null;
let readerWindowClosePending = false;
let readerShellHidden = false;
let hiddenReaderResumePosition: SameBookResumePosition | null = null;
let sameBookResumePending = false;
let sameBookResumeStartedAt = 0;
let sameBookResumeTimer: ReturnType<typeof setTimeout> | null = null;
let lastReportedReaderPage = 0;
let progressSaveSequence = 0;
let positionSnapshotSequence = 0;
let pendingPositionSnapshot: PendingSnapshot | null = null;
interface PositionSnapshotOptions {
  readonly turnWaitMs?: number;
  readonly responseTimeoutMs?: number;
}
function requestPagePositionSnapshot(options: PositionSnapshotOptions = {}): Promise<boolean> {
  if (isPdf || !frameReady || typeof sendToPage !== "function") return Promise.resolve(false);
  const requestedTurnWaitMs = Number(options.turnWaitMs);
  const requestedResponseTimeoutMs = Number(options.responseTimeoutMs);
  const turnWaitMs = Math.max(0, Math.min(2400, Math.round(Number.isFinite(requestedTurnWaitMs) ? requestedTurnWaitMs : 2400)));
  const responseTimeoutMs = Math.max(turnWaitMs + 120, Math.min(2600, Math.round(Number.isFinite(requestedResponseTimeoutMs) ? requestedResponseTimeoutMs : 2600)));
  const requestId = ++positionSnapshotSequence;
  if (pendingPositionSnapshot) {
    clearTimeout(pendingPositionSnapshot.timer);
    pendingPositionSnapshot.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      if (pendingPositionSnapshot?.requestId === requestId) pendingPositionSnapshot = null;
      resolve(false);
    }, responseTimeoutMs);
    pendingPositionSnapshot = { requestId, resolve, timer };
    sendToPage({ positionSnapshotRequest: requestId, positionSnapshotTurnWaitMs: turnWaitMs });
  });
}
function progressSaveDetail(sequence: number, request: ProgressRequest, outcome: string): UnknownRecord {
  const anchorOffset = Number(request.anchor?.text_offset);
  const chapterFrac = Number(request.frac);
  const progress = Number(request.progress);
  return {
    source: "reader_shell",
    sequence,
    chapter: request.chapter,
    chapter_frac: Number.isFinite(chapterFrac) ? Number(chapterFrac.toFixed(6)) : 0,
    progress: Number.isFinite(progress) ? Number(progress.toFixed(4)) : 0,
    anchor_offset: Number.isFinite(anchorOffset) ? Math.max(0, Math.round(anchorOffset)) : null,
    outcome,
  };
}
function sendProgressNow(): Promise<boolean> {
  // 同书隐藏窗口刚恢复时，原生几何会先触发一轮 resize/relayout。正文页会用
  // 关闭前的字符锚点在稳定尺寸上复位；在确认消息回来前，任何中间位置都不能
  // 覆盖数据库，否则反复打开同一本书会在两个分页断点之间来回漂移。
  if (sameBookResumePending) {
    window.ReaderBugTrace?.record?.("same_book_resume", {
      source: "reader_shell",
      phase: "save",
      outcome: "suppressed",
      restore_pending: true,
      save_suppressed: true,
    });
    return Promise.resolve(false);
  }
  if (progTimer) {
    clearTimeout(progTimer);
    progTimer = null;
  }
  lastProgressReportChapter = curChapter;
  const sequence = ++progressSaveSequence;
  const request: ProgressRequest = {
    progress: curProgress,
    chapter: curChapter,
    frac: curChFrac,
    anchor: curReadingAnchor,
    sequence,
  };
  const requested = progressSaveDetail(sequence, request, "requested");
  const fields = `seq=${sequence} chapter=${requested.chapter} frac=${requested.chapter_frac} progress=${requested.progress} anchor_offset=${requested.anchor_offset ?? "none"}`;
  window.ReaderBugTrace?.record?.("progress_save", requested);
  return invoke("set_progress", {
    request: request,
  }).then(() => {
    window.ReaderBugTrace?.record?.("progress_save", progressSaveDetail(sequence, request, "ok"));
    return true;
  }).catch((error) => {
    // 位置保存不能静默失败，否则重开图书只会回到首页而没有任何线索。
    // 统计诊断开关只影响统计，绝不能影响续读位置。
    console.warn("保存阅读位置失败", error);
    window.ReaderBugTrace?.record?.("progress_save", progressSaveDetail(sequence, request, "failed"));
    invoke("reader_perf_log", { event: `progress_save_failed ${fields} error=${String(error).slice(0, 160)}` }).catch(() => {});
    return false;
  });
}
async function closeReaderWindow(): Promise<void> {
  if (readerWindowClosePending) return;
  readerWindowClosePending = true;
  readerCloseSettlementPending = true;
  // 先向正文页索取最新锚点，但不再让可见窗口等待完整排版。阅读 WebView 会被
  // 隐藏缓存，隐藏后仍能在这个短窗口内回传位置并完成最终写盘。
  const positionSnapshot = requestPagePositionSnapshot({
    turnWaitMs: 180,
    responseTimeoutMs: 420,
  });
  try {
    await invoke("main_window_close");
    pauseHiddenReaderShell({ preservePositionSnapshot: true });
  } catch (error) {
    if (pendingPositionSnapshot) {
      clearTimeout(pendingPositionSnapshot.timer);
      pendingPositionSnapshot.resolve(false);
      pendingPositionSnapshot = null;
    }
    readerCloseSettlementPending = false;
    readerWindowClosePending = false;
    replayQueuedReaderSwitchRequest();
    console.warn("关闭阅读窗口失败", error);
    throw error;
  }

  void (async () => {
    const snapshotConfirmed = await positionSnapshot;
    window.ReaderBugTrace?.record?.("close_position_snapshot", {
      source: "reader_shell",
      outcome: snapshotConfirmed ? "confirmed" : "recent_position",
    });
    const saved = await sendProgressNow();
    if (saved) {
      // 这条命令只给原生层标记“下次切书可跳过一次重复保存”，并不影响
      // 当前关闭已完成的位置持久化。WebView2 偶发会让该 IPC 的响应迟到；
      // 绝不能因此一直占住 closePending，导致下一次从书架打开阅读器只停在
      // open_reuse / save_requested。
      void invoke("reader_shell_hidden_after_save").then(() => {
        window.ReaderBugTrace?.record?.("close_save_marker", {
          source: "reader_shell",
          outcome: "confirmed",
        });
      }).catch((error) => {
        window.ReaderBugTrace?.record?.("close_save_marker", {
          source: "reader_shell",
          outcome: "failed",
          error: String(error).slice(0, 120),
        });
      });
    }
  })().catch((error) => {
    console.warn("阅读窗口隐藏后的最终保存失败", error);
  }).finally(() => {
    // 阅读 WebView 会被隐藏缓存而不是销毁；最终保存结算后解除关闭门闩，才能
    // 安全重放关闭期间到达的最后一条 reader-switch-request。
    readerCloseSettlementPending = false;
    readerWindowClosePending = false;
    replayQueuedReaderSwitchRequest();
  });
}
window.closeReaderWindow = closeReaderWindow;
interface PauseHiddenReaderShellOptions {
  readonly preservePositionSnapshot?: boolean;
}
function sameBookResumePosition(chapter: unknown, anchor: ReadingAnchor | null | undefined): SameBookResumePosition | null {
  const textOffset = Number(anchor?.text_offset);
  const viewportOffset = Number(anchor?.viewport_offset);
  return Number.isFinite(textOffset)
    ? {
        chapter: Math.max(0, Math.floor(Number(chapter) || 0)),
        anchor: {
          text_offset: Math.max(0, Math.round(textOffset)),
          viewport_offset: Number.isFinite(viewportOffset) ? Math.max(0, Math.round(viewportOffset)) : 0,
        },
      }
    : null;
}
function pauseHiddenReaderShell(options: PauseHiddenReaderShellOptions = {}): void {
  hiddenReaderResumePosition = sameBookResumePosition(curChapter, curReadingAnchor);
  readerShellHidden = true;
  if (progTimer) {
    clearTimeout(progTimer);
    progTimer = null;
  }
  if (pendingPositionSnapshot && !options.preservePositionSnapshot) {
    clearTimeout(pendingPositionSnapshot.timer);
    pendingPositionSnapshot.resolve(false);
    pendingPositionSnapshot = null;
  }
  if (rwBacktrackResumeTimer) {
    clearTimeout(rwBacktrackResumeTimer);
    rwBacktrackResumeTimer = null;
  }
  pauseReadTracking("window-hidden");
  void flushReadWords(true);
  resetReadingTimeClock();
}
function resumeHiddenReaderShell(): void {
  if (!readerShellHidden) return;
  readerShellHidden = false;
  resetReadingTimeClock();
  if (isPdf || !frameReady || !hiddenReaderResumePosition) {
    sameBookResumePending = false;
    return;
  }
  sameBookResumePending = true;
  sameBookResumeStartedAt = performance.now();
  if (sameBookResumeTimer) clearTimeout(sameBookResumeTimer);
  const position = hiddenReaderResumePosition;
  window.ReaderBugTrace?.record?.("same_book_resume", {
    source: "reader_shell",
    phase: "requested",
    outcome: "pending",
    before_page: lastReportedReaderPage,
    before_anchor_offset: position.anchor.text_offset,
    viewport_width: Math.max(0, Math.round(window.innerWidth || 0)),
    viewport_height: Math.max(0, Math.round(window.innerHeight || 0)),
    restore_pending: true,
    save_suppressed: false,
  });
  sendToPage({ sameBookResume: position });
  sameBookResumeTimer = setTimeout(() => {
    sameBookResumeTimer = null;
    if (!sameBookResumePending) return;
    sameBookResumePending = false;
    window.ReaderBugTrace?.record?.("same_book_resume", {
      source: "reader_shell",
      phase: "completed",
      outcome: "timeout",
      duration_ms: Math.max(0, Math.round(performance.now() - sameBookResumeStartedAt)),
      restore_pending: false,
      save_suppressed: false,
    });
  }, 1_600);
}
function reportProgress(immediate = false): void {
  if (!readerBookBound || readerShellHidden || sameBookResumePending) return;
  // 续读位置是核心状态，不属于可关闭的阅读统计。此前复用
  // reader_stats_report 开关，会让关闭统计的用户永远不保存位置。
  // 原生拖窗期间也不丢弃位置，松手后再保存；关闭窗口时则立即保存。
  if (isWindowDragging() && !immediate) {
    if (progTimer) clearTimeout(progTimer);
    const wait = Math.max(550, windowDraggingUntil - Date.now() + 80);
    progTimer = setTimeout(() => reportProgress(), wait);
    return;
  }
  if (progTimer) clearTimeout(progTimer);
  // 一本书由大量短章节组成时，连续翻页会不断触发位置消息。若每次都重置
  // 节流定时器，用户在关闭窗口前可能从未等到一次写盘，重开就又回到首页。
  // 跨章节是稀疏且有意义的续读边界，立即保存；同一章内的滚动仍保持节流。
  if (immediate || lastProgressReportChapter !== curChapter) {
    sendProgressNow();
    return;
  }
  progTimer = setTimeout(() => {
    progTimer = null;
    sendProgressNow();
  }, 800);
}
window.addEventListener("pagehide", () => reportProgress(true));
window.addEventListener("beforeunload", () => reportProgress(true));

// ---- 已读字数统计：按可见字数、停留时间、短页和快速翻页折算，避免大窗口短停虚高 ----
const readerReadingMetrics = window.ReaderReadingMetrics;
const READ_TRACK = readerReadingMetrics.READ_TRACK;
let rwSegment: ReadSegment | null = null,
  rwAccum = 0,
  rwTimer: ReturnType<typeof setTimeout> | null = null,
  rwFastStreak = 0;
let rwLastPosition = 0,
  rwLastPageData: ReadPageData | null = null,
  rwBacktrackBlockedUntil = 0,
  rwBacktrackResumeTimer: ReturnType<typeof setTimeout> | null = null,
  rtLastActiveAt = Date.now();
function flushReadWords(immediate = false): Promise<boolean> {
  if (DIAG_DISABLE_READER_REPORTS) return Promise.resolve(false);
  if (isWindowDragging() && !immediate) return Promise.resolve(false);
  if (rwTimer) {
    clearTimeout(rwTimer);
    rwTimer = null;
  }
  const flush = () => {
    if (isWindowDragging() && !immediate) return Promise.resolve(false);
    const charsToAdd = Math.floor(rwAccum);
    if (charsToAdd > 0) {
      rwAccum -= charsToAdd;
      return invoke("add_read_words", { words: charsToAdd }).then(() => true).catch(() => false);
    }
    return Promise.resolve(true);
  };
  if (immediate) {
    return flush();
  }
  rwTimer = setTimeout(() => {
    rwTimer = null;
    void flush();
  }, 1500);
  return Promise.resolve(false);
}
function readTrackingBlocked(): boolean {
  if (isWindowDragging()) return true;
  if (!document.hasFocus() || document.hidden) return true;
  if (Date.now() < rwBacktrackBlockedUntil) return true;
  return ReaderShell.hasOverlay();
}
function creditReadSegment(reason: string, options: { readonly keep?: boolean; readonly discard?: boolean } = {}): void {
  if (!rwSegment) return;
  const seg = rwSegment;
  if (!options.keep) rwSegment = null;
  if (options.discard) return;
  const rawDwell = Math.max(0, Date.now() - seg.startedAt);
  const chars = Math.max(0, seg.chars || 0);
  if (chars <= 0 || rawDwell < READ_TRACK.minDwellMs) return;
  const required = readerReadingMetrics.requiredDwellMs(chars);
  if (required <= 0) return;
  const dwellCap = Math.max(READ_TRACK.idleCapMs, required);
  const dwell = readerReadingMetrics.clamp(rawDwell, 0, dwellCap);
  const ratio = readerReadingMetrics.clamp(dwell / required, 0, 1);
  if (ratio < READ_TRACK.fastTurnRatio) rwFastStreak += 1;
  else rwFastStreak = 0;
  const creditRatio = rwFastStreak >= READ_TRACK.fastTurnStreak ? ratio * READ_TRACK.fastTurnCredit : ratio;
  const totalCreditForPage = Math.floor(chars * creditRatio);
  // 同一次停留会周期性结算，只补本次停留尚未计入的部分；重新进入该页则
  // 创建新的 segment，让用户实际重读的内容再次进入阅读统计。
  const alreadyCredited = seg.credited || 0;
  const delta = Math.max(0, totalCreditForPage - alreadyCredited);
  if (delta <= 0) return;
  seg.credited = alreadyCredited + delta;
  rwAccum += delta;
  if (window.__kunpengReadDebug) {
    console.debug("read-track", {
      key: seg.key,
      reason,
      chars,
      rawDwell,
      dwell,
      required,
      ratio,
      creditRatio,
      totalCreditForPage,
      alreadyCredited,
      delta,
    });
  }
  flushReadWords();
}
function pauseReadTracking(reason: string): void {
  creditReadSegment(reason || "pause");
}
function discardReadTracking(reason: string): void {
  if (window.__kunpengReadDebug && rwSegment) console.debug("read-track-discard", { key: rwSegment.key, reason });
  rwSegment = null;
}
function resetReadingTimeClock(): void {
  rtLastActiveAt = readTrackingBlocked() ? 0 : Date.now();
}
function scheduleBacktrackResume(d: ReadPageData): void {
  rwLastPageData = d;
  if (rwBacktrackResumeTimer) clearTimeout(rwBacktrackResumeTimer);
  const delay = Math.max(READ_TRACK.backtrackCooldownMs, rwBacktrackBlockedUntil - Date.now() + 20);
  rwBacktrackResumeTimer = setTimeout(() => {
    rwBacktrackResumeTimer = null;
    if (rwLastPageData === d && !readTrackingBlocked()) trackReadWords(d, { resumeAfterBacktrack: true });
  }, delay);
}
function trackReadWords(d: ReadPageData, options?: { readonly resumeAfterBacktrack?: boolean }): void {
  void options;
  if (!readerDebugSettingOn("reader_words_detect")) return;
  const key = readerReadingMetrics.pageKey(d, curChapter);
  const chars = Math.max(0, d.pageChars || 0);
  if (!key || chars <= 0) return;
  const pos = readerReadingMetrics.pagePosition(d, curChapter);
  if (pos > 0 && rwLastPosition > 0 && pos < rwLastPosition) {
    rwBacktrackBlockedUntil = Date.now() + READ_TRACK.backtrackCooldownMs;
    discardReadTracking("backtrack");
    resetReadingTimeClock();
    rwLastPosition = pos;
    scheduleBacktrackResume(d);
    return;
  }
  if (pos > 0) rwLastPosition = pos;
  rwLastPageData = d;
  if (readTrackingBlocked()) {
    pauseReadTracking("blocked");
    scheduleBacktrackResume(d);
    return;
  }
  if (rwSegment && rwSegment.key === key) {
    rwSegment.chars = Math.max(rwSegment.chars, chars);
    return;
  }
  creditReadSegment("page_change");
  rwSegment = { key, chars, startedAt: Date.now(), credited: 0 };
}
function creditCurrentReadPage() {
  if (!readerDebugSettingOn("reader_words_detect")) return;
  if (readTrackingBlocked()) {
    pauseReadTracking("periodic_blocked");
    return;
  }
  creditReadSegment("periodic", { keep: true });
}
function tickReadingTime() {
  if (DIAG_DISABLE_READER_REPORTS) return;
  const now = Date.now();
  if (readTrackingBlocked()) {
    rtLastActiveAt = 0;
    return;
  }
  if (!rtLastActiveAt) {
    rtLastActiveAt = now;
    return;
  }
  const seconds = Math.floor(Math.min((now - rtLastActiveAt) / 1000, READ_TRACK.readingTimeMaxCreditSec));
  rtLastActiveAt = now;
  if (seconds > 0) invoke("add_reading_time", { seconds }).catch(() => {});
}
window.addEventListener("blur", () => {
  pauseReadTracking("blur");
  resetReadingTimeClock();
});
window.addEventListener("focus", resetReadingTimeClock);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pauseReadTracking("hidden");
    flushReadWords(true);
    resetReadingTimeClock();
  } else {
    resetReadingTimeClock();
  }
});
window.addEventListener("beforeunload", () => {
  pauseReadTracking("beforeunload");
  flushReadWords(true);
});
window.pauseReadTracking = pauseReadTracking;
window.discardReadTracking = discardReadTracking;
// ---- 底部整本书进度条（与顶部阅读工具栏同现同隐）----
const vbar = document.getElementById("vbar");
const vthumb = document.getElementById("vthumb");
const bookProgressEl = document.getElementById("book-progress");
const bookProgressTrack = document.getElementById("book-progress-track");
const bookProgressFill = document.getElementById("book-progress-fill");
const bookProgressThumb = document.getElementById("book-progress-thumb");
const bookProgressRestore = document.getElementById("book-progress-restore");
const readerJumpBack = document.getElementById("reader-jump-back");
let vdragging = false;
let bookProgressDragging = false;
let bookProgressPinned = false;
// A single in-session stack owns every explicit reading jump.  Keeping a
// second stack for the bottom progress bar made the visible restore buttons
// disagree with link/TOC/footnote navigation.
const readerNavigationHistory: JumpPoint[] = [];
let readerNavigationBackVisible = false;
let readerNavigationDismissTimer: ReturnType<typeof setTimeout> | null = null;
let readerNavigationAwaitingLanding = false;
let readerNavigationLastPageSignature = "";
let readerNavigationPagesMoved = 0;
let readerJumpBackSettingsSignature = "";
let bookProgressLastFrac = 0;
let bookProgressLastSent = 0;
let bookProgressPreviewFrac: number | null = null;
let bookProgressPreviewTimer: ReturnType<typeof setTimeout> | null = null;
const readerJumpBackRules = window.ReaderJumpBackRules;
if (!readerJumpBackRules) throw new Error("ReaderJumpBackRules is required");
const readerNavigationRules: NavigationRulesApi = window.ReaderNavigationRules || (() => {
  const limit = 100;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const normalizePoint = (point: unknown, fallback: Partial<JumpPoint> = {}): JumpPoint => {
    const source = point && typeof point === "object" ? point as Partial<JumpPoint> : {};
    return {
      chapter: Math.max(0, Number(source.chapter ?? fallback.chapter) || 0),
      chFrac: clamp(Number(source.chFrac ?? fallback.chFrac) || 0, 0, 1),
      progress: clamp(Number(source.progress ?? fallback.progress) || 0, 0, 100),
    };
  };
  const samePoint = (left: JumpPoint | undefined, right: JumpPoint | undefined): boolean => !!left && !!right
    && left.chapter === right.chapter && Math.abs(left.chFrac - right.chFrac) < 0.0001;
  return {
    HISTORY_LIMIT: limit,
    normalizePoint,
    samePoint,
    appendHistory(entries: readonly JumpPoint[], point: unknown, fallback: JumpPoint, max = limit) {
      const history = Array.isArray(entries) ? entries : [];
      const next = normalizePoint(point, fallback);
      const added = !samePoint(history[history.length - 1], next);
      return { point: next, added, history: (added ? [...history, next] : history.slice()).slice(-Math.max(1, Math.floor(Number(max) || limit)))};
    },
    pageSignature(data: UnknownRecord) {
      return `${Number(data?.gPage) || 0}_${Number(data?.page) || 0}_${Number(data?.chapter) || 0}`;
    },
    trackPageDismissal(state: NavigationDismissState, data: unknown, pageLimit: number) {
      const current = state && typeof state === "object" ? state : { visible: false, awaitingLanding: false, lastPageSignature: "", pagesMoved: 0 };
      const visible = current.visible === true;
      const awaitingLanding = current.awaitingLanding === true;
      const lastPageSignature = String(current.lastPageSignature || "");
      const pagesMoved = Math.max(0, Math.floor(Number(current.pagesMoved) || 0));
      if (!visible) return { visible, awaitingLanding, lastPageSignature, pagesMoved, dismissed: false };
      const signature = this.pageSignature(data);
      if (awaitingLanding) return { visible: true, awaitingLanding: false, lastPageSignature: signature, pagesMoved: 0, dismissed: false };
      const moved = lastPageSignature && signature !== lastPageSignature ? pagesMoved + 1 : pagesMoved;
      if (moved >= Math.max(1, Math.floor(Number(pageLimit) || 1))) return { visible: false, awaitingLanding: false, lastPageSignature: "", pagesMoved: 0, dismissed: true };
      return { visible: true, awaitingLanding: false, lastPageSignature: signature, pagesMoved: moved, dismissed: false };
    },
  };
})();
function readerJumpBackConfig() {
  const current = window.ReaderSettings?.get?.() || {};
  return {
    enabled: current.showReaderJumpBack !== false,
    mode: current.readerJumpBackDismissMode === "time" ? "time" : "pages",
    seconds: Math.max(1, Math.min(600, Number(current.readerJumpBackDismissSeconds) || 30)),
    pages: Math.max(1, Math.min(100, Number(current.readerJumpBackDismissPages) || 3)),
    iconSizePx: readerJumpBackRules.normalizeIconSizePx(current.readerJumpBackIconSizePx),
    positionX: readerJumpBackRules.normalizePosition(current.readerJumpBackPositionX, 950),
    positionY: readerJumpBackRules.normalizePosition(current.readerJumpBackPositionY, 500),
  };
}
function applyReaderJumpBackPlacement(iconSizePx: unknown, positionX: number, positionY: number): void {
  if (!readerJumpBack) return;
  const iconSize = readerJumpBackRules.normalizeIconSizePx(iconSizePx);
  const iconHeight = readerJumpBackRules.iconHeightPx(iconSize);
  const hitSize = Math.max(44, iconSize + 12);
  readerJumpBack.style.setProperty("--reader-jump-back-icon-size", `${iconSize}px`);
  readerJumpBack.style.setProperty("--reader-jump-back-icon-height", `${iconHeight}px`);
  readerJumpBack.style.setProperty("--reader-jump-back-hit-size", `${hitSize}px`);
  const container = readerJumpBack.offsetParent;
  const width = Number(container?.clientWidth) || 0;
  const height = Number(container?.clientHeight) || 0;
  if (!width || !height) return;
  readerJumpBack.style.left = `${Math.round(readerJumpBackRules.trackPoint(width, iconSize, hitSize, positionX))}px`;
  readerJumpBack.style.top = `${Math.round(readerJumpBackRules.trackPoint(height, iconHeight, hitSize, positionY))}px`;
}
function clearReaderNavigationDismissTimer() {
  if (readerNavigationDismissTimer) clearTimeout(readerNavigationDismissTimer);
  readerNavigationDismissTimer = null;
}
function dismissReaderNavigationBack(clearHistory = false) {
  clearReaderNavigationDismissTimer();
  readerNavigationBackVisible = false;
  readerNavigationAwaitingLanding = false;
  readerNavigationLastPageSignature = "";
  readerNavigationPagesMoved = 0;
  if (clearHistory) readerNavigationHistory.length = 0;
  updateBookProgress();
}
function armReaderNavigationBackVisibility() {
  clearReaderNavigationDismissTimer();
  const config = readerJumpBackConfig();
  if (!config.enabled || readerNavigationHistory.length === 0) {
    readerNavigationBackVisible = false;
    updateBookProgress();
    return;
  }
  readerNavigationBackVisible = true;
  readerNavigationAwaitingLanding = true;
  readerNavigationLastPageSignature = "";
  readerNavigationPagesMoved = 0;
  if (config.mode === "time") {
    readerNavigationDismissTimer = setTimeout(() => dismissReaderNavigationBack(false), config.seconds * 1000);
  }
  updateBookProgress();
}
function trackReaderNavigationBackProgress(data: unknown): void {
  const config = readerJumpBackConfig();
  if (!readerNavigationBackVisible || config.mode !== "pages") return;
  const next = readerNavigationRules.trackPageDismissal({
    visible: readerNavigationBackVisible,
    awaitingLanding: readerNavigationAwaitingLanding,
    lastPageSignature: readerNavigationLastPageSignature,
    pagesMoved: readerNavigationPagesMoved,
  }, data, config.pages);
  readerNavigationBackVisible = next.visible;
  readerNavigationAwaitingLanding = next.awaitingLanding;
  readerNavigationLastPageSignature = next.lastPageSignature;
  readerNavigationPagesMoved = next.pagesMoved;
  if (next.dismissed) dismissReaderNavigationBack(false);
}
function syncReaderJumpBackSettings() {
  const config = readerJumpBackConfig();
  const signature = `${config.enabled}_${config.mode}_${config.seconds}_${config.pages}_${config.iconSizePx}_${config.positionX}_${config.positionY}`;
  if (signature === readerJumpBackSettingsSignature) return;
  readerJumpBackSettingsSignature = signature;
  applyReaderJumpBackPlacement(config.iconSizePx, config.positionX, config.positionY);
  // Hiding the floating arrow is visual preference only.  The same history is
  // still available from the progress control and the restore-jump gesture.
  if (!config.enabled) dismissReaderNavigationBack(false);
  else if (readerNavigationHistory.length) armReaderNavigationBackVisibility();
  else updateBookProgress();
}
function showBookProgress() {
  document.body.classList.remove("book-progress-hidden");
  ReaderShell.dispatch({ type: "SHOW_TOOLBAR" });
  updateBookProgress();
}
function pinBookProgress() {
  bookProgressPinned = true;
  showBookProgress();
}
function hideBookProgress() {
  bookProgressPinned = false;
  if (!ReaderShell.isImmersive()) document.body.classList.add("book-progress-hidden");
  ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
}
function hideBookProgressAfterReadingAction() {
  bookProgressPinned = false;
  // 关闭沉浸模式后顶部菜单常驻，但底部横向整书进度不应遮挡正文。
  // 沉浸模式继续完全跟随工具栏，不在这里改变其既有显隐行为。
  if (!ReaderShell.isImmersive()) document.body.classList.add("book-progress-hidden");
}
function toggleBookProgressFromCenterTap() {
  if (ReaderShell.isImmersive()) return;
  if (document.body.classList.contains("book-progress-hidden")) {
    showBookProgress();
  } else {
    hideBookProgressAfterReadingAction();
  }
}
function updateThumb() {
  const h = vbar.clientHeight;
  if (h > 0) {
    const th = 30;
    let top = (curProgress / 100) * (h - th);
    top = Math.max(0, Math.min(h - th, top));
    vthumb.style.height = th + "px";
    vthumb.style.top = top + "px";
  }
  updateBookProgress();
}
function updateBookProgress() {
  if (!bookProgressTrack) return;
  const percent = bookProgressPreviewFrac === null
    ? Math.max(0, Math.min(100, Number(curProgress) || 0))
    : bookProgressPreviewFrac * 100;
  paintBookProgress(percent);
  const canRestoreProgress = readerNavigationHistory.length > 0;
  bookProgressEl.classList.toggle("can-restore", canRestoreProgress);
  if (readerJumpBack) readerJumpBack.hidden = !readerJumpBackConfig().enabled || !readerNavigationBackVisible || readerNavigationHistory.length === 0;
}
function clearBookProgressPreviewTimer() {
  if (bookProgressPreviewTimer) clearTimeout(bookProgressPreviewTimer);
  bookProgressPreviewTimer = null;
}
function setBookProgressPreview(frac: unknown): void {
  bookProgressPreviewFrac = Math.max(0.01, Math.min(1, Number(frac) || 0.01));
  paintBookProgress(bookProgressPreviewFrac * 100);
}
function scheduleBookProgressPreviewSettle() {
  clearBookProgressPreviewTimer();
  bookProgressPreviewTimer = setTimeout(() => {
    bookProgressPreviewTimer = null;
    if (bookProgressDragging) return;
    bookProgressPreviewFrac = null;
    updateBookProgress();
  }, 900);
}
function settleBookProgressPreview() {
  if (bookProgressDragging || bookProgressPreviewFrac === null) return;
  const actual = Math.max(0, Math.min(1, (Number(curProgress) || 0) / 100));
  if (Math.abs(actual - bookProgressPreviewFrac) > 0.015) return;
  clearBookProgressPreviewTimer();
  bookProgressPreviewFrac = null;
}
function paintBookProgress(percent: number): void {
  if (!bookProgressTrack) return;
  bookProgressFill.style.width = percent + "%";
  bookProgressThumb.style.left = percent + "%";
  bookProgressTrack.setAttribute("aria-valuenow", String(Math.max(1, Math.round(percent))));
}
function rememberReaderNavigationPoint(point?: unknown): void {
  const result = readerNavigationRules.appendHistory(readerNavigationHistory, point, {
    chapter: curChapter,
    chFrac: curChFrac,
    progress: curProgress,
  });
  readerNavigationHistory.splice(0, readerNavigationHistory.length, ...result.history);
  if (result.added) {
    // The gesture manager combines this checkpoint with closed reader surfaces
    // so “撤销上一步” follows the real order of user-visible operations.
    window.dispatchEvent(new CustomEvent("reader-undo-checkpoint"));
  }
  if (readerJumpBackConfig().enabled) armReaderNavigationBackVisibility();
  else updateBookProgress();
}
function rememberBookProgressRestorePoint(point?: unknown): void {
  // Compatibility name for the bottom progress control; it now feeds the
  // exact same history used by TOC, links and footnotes.
  rememberReaderNavigationPoint(point);
}
window.rememberReaderJumpPosition = function (point: unknown) {
  rememberReaderNavigationPoint(point);
};
function bookProgressFracFromX(clientX: number): number {
  const rect = bookProgressTrack.getBoundingClientRect();
  if (!rect.width) return 0.01;
  return Math.max(0.01, Math.min(1, (clientX - rect.left) / rect.width));
}
function jumpByBookProgress(frac: number, remember = true): void {
  if (isPdf) return;
  if (remember) rememberBookProgressRestorePoint();
  const target = Math.max(0.01, Math.min(1, frac));
  setBookProgressPreview(target);
  sendToPage({ gotoFrac: target });
  // 进度条是本次导航的发起控件，跳转后持续保留，直到用户回到正文翻页。
  pinBookProgress();
  requestAnimationFrame(pinBookProgress);
  if (!bookProgressDragging) scheduleBookProgressPreviewSettle();
}
bookProgressThumb?.addEventListener("mousedown", (e) => {
  if (isPdf) return;
  e.preventDefault();
  e.stopPropagation();
  pinBookProgress();
  rememberBookProgressRestorePoint();
  bookProgressDragging = true;
  bookProgressLastFrac = Math.max(0.01, Math.min(1, (Number(curProgress) || 0) / 100));
  clearBookProgressPreviewTimer();
  setBookProgressPreview(bookProgressLastFrac);
  bookProgressLastSent = 0;
  document.body.style.userSelect = "none";
  frame.style.pointerEvents = "none";
});
bookProgressTrack?.addEventListener("mousedown", (e) => {
  if (isPdf || e.target === bookProgressThumb) return;
  e.preventDefault();
  e.stopPropagation();
  showBookProgress();
  jumpByBookProgress(bookProgressFracFromX(e.clientX));
});
function restorePreviousBookProgress(e?: Event): boolean {
  return restorePreviousReaderNavigation(e);
}
function restorePreviousReaderNavigation(e?: Event): boolean {
  e?.preventDefault?.();
  e?.stopPropagation?.();
  const point = readerNavigationHistory.pop();
  if (!point) return false;
  if (readerNavigationHistory.length && readerJumpBackConfig().enabled) armReaderNavigationBackVisibility();
  else dismissReaderNavigationBack(false);
  sendToPage({ gotoChapter: point.chapter, chFrac: point.chFrac });
  pinBookProgress();
  return true;
}
bookProgressRestore?.addEventListener("click", restorePreviousBookProgress);
readerJumpBack?.addEventListener("click", restorePreviousReaderNavigation);
window.restoreReaderJumpPosition = restorePreviousReaderNavigation;
window.hasReaderJumpHistory = () => readerNavigationHistory.length > 0;
window.addEventListener("reader-settings-changed", syncReaderJumpBackSettings);
window.addEventListener("resize", () => {
  const config = readerJumpBackConfig();
  applyReaderJumpBackPlacement(config.iconSizePx, config.positionX, config.positionY);
});
syncReaderJumpBackSettings();
function fracFromY(clientY: number): number {
  const rect = vbar.getBoundingClientRect();
  const th = vthumb.offsetHeight;
  let top = clientY - rect.top - th / 2;
  const range = rect.height - th;
  top = Math.max(0, Math.min(range, top));
  vthumb.style.top = top + "px";
  return range > 0 ? top / range : 0;
}
vthumb.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  hideBookProgress();
  rememberReaderNavigationPoint();
  vdragging = true;
  document.body.style.userSelect = "none";
  frame.style.pointerEvents = "none";
});
vbar.addEventListener("mousedown", (e) => {
  if (e.target === vthumb) return;
  hideBookProgress();
  rememberReaderNavigationPoint();
  sendToPage({ gotoFrac: fracFromY(e.clientY) });
});
let vLastFrac = 0;
let vLastSent = 0;
document.addEventListener("mousemove", (e) => {
  if (bookProgressDragging) {
    bookProgressLastFrac = bookProgressFracFromX(e.clientX);
    setBookProgressPreview(bookProgressLastFrac); // 拖动时只跟随本地预览，正文跳转节流处理
    const now = Date.now();
    if (now - bookProgressLastSent >= 40) {
      bookProgressLastSent = now;
      jumpByBookProgress(bookProgressLastFrac, false);
    }
    return;
  }
  if (!vdragging) return;
  vLastFrac = fracFromY(e.clientY);
  const now = Date.now();
  if (now - vLastSent >= 40) {
    vLastSent = now;
    sendToPage({ gotoFrac: vLastFrac });
  }
});
document.addEventListener("mouseup", () => {
  if (bookProgressDragging) {
    jumpByBookProgress(bookProgressLastFrac, false); // 松手时确保精确落到最后位置
    bookProgressDragging = false;
    document.body.style.userSelect = "";
    frame.style.pointerEvents = "";
    scheduleBookProgressPreviewSettle();
    return;
  }
  if (vdragging) {
    vdragging = false;
    document.body.style.userSelect = "";
    frame.style.pointerEvents = "";
    sendToPage({ gotoFrac: vLastFrac });
  }
});
window.addEventListener("resize", () => {
  if (!isPdf) {
    showProgressLoading();
    if (frameReady) {
      sendToPage({
        pageCountViewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 1),
      });
    }
  }
  updateBookProgress();
});

// ---- 书籍信息弹窗 ----
const infoModal = document.getElementById("info-modal");
const readerInfoPanel = window.ReaderBookInfoPanel.mount({ root: document, host: infoModal, prefix: "info" });
const readerBookInfoRelated = window.ReaderBookInfoRelated.mount({
  root: document,
  invoke,
  onOpenBook(book: UnknownRecord) {
    ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
    invoke("open_book_at", { request: { id: String(book.id), chapter: 0, term: "" } }).catch(() => {});
  },
});
let readerInfoMeta: UnknownRecord = {};
ReaderShell.registerOverlay(ReaderShell.OVERLAY.INFO, {
  onOpen() {
    window.pauseReadTracking?.("book-info");
  },
});
invoke<BookMeta>("book_meta").then((m) => { currentBookTitle = m.title || ""; }).catch(() => {});

async function openReaderBookInfo() {
  readerInfoPanel.setLoading();
  ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, true);
  try {
    const m = await invoke<BookMeta>("book_meta");
    currentBookTitle = m.title || "";
    readerInfoMeta = m;
    readerInfoPanel.render(m);
  } catch (e) {
    readerInfoPanel.setError(e);
  }
}
window.openReaderBookInfo = openReaderBookInfo;
document.getElementById("info-btn")?.addEventListener("click", () => {
  void openReaderBookInfo();
});
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
});
function openReaderOrganization(field: string): void {
  if (!currentBookId) return;
  emit("reader-gesture-action", { action: "book_organization", field, bookId: String(currentBookId) }).catch(() => {});
  ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
}
readerInfoPanel.configure({
  onRating(rating: unknown) {
    if (currentBookId) invoke("set_book_rating", { id: String(currentBookId), rating }).catch(() => {});
  },
  onTitle(title: string) {
    if (!currentBookId || !title || title === currentBookTitle) return;
    invoke("set_book_title", { id: String(currentBookId), title }).then(() => { currentBookTitle = title; }).catch(() => {});
  },
  onDescription(description: unknown) {
    if (currentBookId) invoke("set_book_description", { id: String(currentBookId), description }).catch(() => {});
  },
  onAction(action: string) {
    if (action === "tags" || action === "collections") {
      openReaderOrganization(action);
    } else if (action === "cover" && currentBookId) {
      emit("reader-gesture-action", { action: "change_cover", bookId: String(currentBookId) }).catch(() => {});
      ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
    } else if (action === "similar") {
      void readerBookInfoRelated.openSimilar(currentBookId, readerInfoMeta);
    } else if (action === "timeline" && currentBookId) {
      void readerBookInfoRelated.openTimeline(currentBookId);
    }
  },
});

const readerEndModal = document.getElementById("reader-end-modal");
const readerEndList = document.getElementById("reader-end-list");
const readerEndRecommendations = window.ReaderRecommendationSettings?.createPrefetcher?.({ invoke });
function closeReaderEnd() {
  ReaderShell.setOverlay(ReaderShell.OVERLAY.END_RECOMMENDATIONS, false);
}
async function openReaderEnd() {
  if (!readerEndModal || !readerEndList || !currentBookId) return;
  try {
    const list = readerEndRecommendations
      ? await readerEndRecommendations.loadAtEnd()
      : await invoke("similar_books", { id: String(currentBookId) });
    if (list === null) return;
    ReaderShell.setOverlay(ReaderShell.OVERLAY.END_RECOMMENDATIONS, true);
    readerEndList.replaceChildren();
    if (!Array.isArray(list) || !list.length) {
      const empty = document.createElement("div");
      empty.className = "reader-end-empty";
      empty.textContent = "暂时没有相似图书。可以先在语义索引中完成建库。";
      readerEndList.appendChild(empty);
      return;
    }
    list.slice(0, 5).forEach((book) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "reader-end-item";
      const cover = document.createElement("div");
      cover.className = "reader-end-cover";
      if (book.cover) {
        const image = document.createElement("img");
        image.src = book.cover;
        image.alt = book.title || "";
        cover.appendChild(image);
      } else {
        cover.textContent = book.title || "未命名";
      }
      const body = document.createElement("div");
      body.className = "reader-end-body";
      const title = document.createElement("div");
      title.className = "reader-end-title";
      title.textContent = book.title || "未命名";
      const author = document.createElement("div");
      author.className = "reader-end-author";
      author.textContent = book.author || "未知作者";
      const scoreRow = document.createElement("div");
      scoreRow.className = "reader-end-score";
      const score = Math.round(Math.max(0, Math.min(1, Number(book.score) || 0)) * 100);
      const scoreLabel = document.createElement("span");
      scoreLabel.textContent = "相关度";
      const scoreValue = document.createElement("strong");
      scoreValue.textContent = score + "%";
      scoreRow.append(scoreLabel, scoreValue);
      body.append(title, author, scoreRow);
      item.append(cover, body);
      item.addEventListener("click", () => {
        closeReaderEnd();
        invoke("open_book_at", {
          request: { id: String(book.id), chapter: 0, term: "" },
        }).catch((error) => {
          ReaderShell.setOverlay(ReaderShell.OVERLAY.END_RECOMMENDATIONS, true);
          readerEndList.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "reader-end-empty";
          empty.textContent = "打开失败：" + error;
          readerEndList.appendChild(empty);
        });
      });
      readerEndList.appendChild(item);
    });
  } catch (error) {
    ReaderShell.setOverlay(ReaderShell.OVERLAY.END_RECOMMENDATIONS, true);
    readerEndList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "reader-end-empty";
    empty.textContent = "读取失败：" + error;
    readerEndList.appendChild(empty);
  }
}
document.getElementById("reader-end-close")?.addEventListener("click", closeReaderEnd);
readerEndModal?.addEventListener("click", (event) => {
  if (event.target === readerEndModal) closeReaderEnd();
});

// 全书搜索 UI 与 sendToPage 消息桥在 reader-search-ui.js。

// 正文 iframe 使用 reader:// 协议，不能把它自己的 Web 存储当成跨重开
// 阅读器仍可用的唯一来源。外壳只保存高亮菜单的外观和动作开关，不接收选文、
// 正文、批注或图书标识；正文每次加载后再恢复这份受限快照。
const READER_HIGHLIGHT_MENU_PREFERENCES_KEY = "readerHighlightMenuPreferencesV1";
function savedHighlightMenuPreferences() {
  try {
    const value = JSON.parse(localStorage.getItem(READER_HIGHLIGHT_MENU_PREFERENCES_KEY) || "null");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
function persistHighlightMenuPreferences(value: unknown): void {
  try {
    localStorage.setItem(READER_HIGHLIGHT_MENU_PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // 本机设置不可写时，本次会话的正文仍可继续使用当前菜单配置。
  }
}
function restoreHighlightMenuPreferences() {
  if (isPdf || !frame.contentWindow) return;
  const preferences = savedHighlightMenuPreferences();
  const operation = preferences ? "update" : "get";
  sendToPage({
    readerHighlightMenuSettings: { requestId: 1, operation, settings: preferences },
  });
}
function activateHighlightMenuPreferences() {
  if (isPdf || !frame.contentWindow) return;
  sendToPage({
    readerHighlightMenuSettings: { requestId: 2, operation: "activate" },
  });
}

// 接收合并页上报：阅读进度 / 正文被点击 / 搜索结果数
window.addEventListener("message", (event) => {
  const data = window.ReaderMessageGuard?.normalizeEvent?.(event, frame, window.location);
  if (!data) return;
  if (data.readerEngineWarmReady) {
    innerReaderEngineReady = true;
    const heapBytes = Math.max(0, Math.floor(Number(data.readerEngineHeapBytes) || 0));
    void invoke("reader_shell_inner_engine_ready", { heapBytes: heapBytes || null });
    if (isReaderShellBenchmark) {
      invoke("reader_perf_log", { event: "shell_prepared" }).catch(() => {});
    }
    return;
  }
  // A cached hidden reader has already persisted its final position. Late
  // iframe messages must not restart progress timers or report a delayed
  // frame-ready after the user has returned to the shelf. The one exception is
  // the explicitly requested final position snapshot: it must refresh the
  // hidden resume anchor and resolve the close transaction without touching UI.
  if (readerShellHidden) {
    if (
      typeof data.progress === "number" &&
      pendingPositionSnapshot &&
      Number(data.positionSnapshotRequestId) === pendingPositionSnapshot.requestId
    ) {
      curProgress = data.progress;
      curChapter = data.chapter || 0;
      curChFrac = data.chFrac || 0;
      curReadingAnchor = data.anchor || null;
      lastReportedReaderPage = Math.max(0, Math.round(Number(data.page) || 0));
      hiddenReaderResumePosition = sameBookResumePosition(curChapter, curReadingAnchor);
      const pending = pendingPositionSnapshot;
      pendingPositionSnapshot = null;
      clearTimeout(pending.timer);
      pending.resolve(true);
    }
    return;
  }
  const e = { data };
  if (e.data.readerHighlightMenuPreferencesReady) {
    restoreHighlightMenuPreferences();
    return;
  }
  if (e.data.readerHighlightMenuSettings) {
    if (e.data.readerHighlightMenuSettings.requestId === 1) {
      persistHighlightMenuPreferences(e.data.readerHighlightMenuSettings.settings);
      activateHighlightMenuPreferences();
    }
    return;
  }
  if (e.data.readerHighlightMenuPreferences) {
    persistHighlightMenuPreferences(e.data.readerHighlightMenuPreferences);
    return;
  }
  if (e.data.readerGesture) { window.ReaderGestureClose?.fromFrame?.(e.data.readerGesture); return; }
  if (e.data.readerGestureSurfaceClosed !== undefined) { window.ReaderGestureClose?.frameSurfaceClosed?.(e.data.readerGestureSurfaceClosed); return; }
  if (e.data.bugTrace) {
    window.ReaderBugTrace?.ingestPageEvent?.(e.data.bugTrace);
    return;
  }
  if (e.data.bookEnd) {
    if (window.ReaderRecommendationSettings?.isEnabled?.()) openReaderEnd();
    return;
  }
  if (typeof e.data.readerPerf === "string") {
    if (OPENING_READER_PAGE_PERFORMANCE_STAGES.has(e.data.readerPerf)) {
      recordReaderPerformance(e.data.readerPerf, undefined, e.data.readerPerfMetrics);
    }
    invoke("reader_perf_log", { event: e.data.readerPerf }).catch(() => {});
    return;
  }
  if (e.data.layoutBusy) {
    if (!isPdf) showProgressLoading();
    return;
  }
  if (e.data.readerJump) {
    rememberReaderNavigationPoint(e.data.readerJump);
  }
  if (typeof e.data.progress === "number") {
    const previousChapter = curChapter;
    const previousFraction = curChFrac;
    const previousAnchor = curReadingAnchor;
    curProgress = e.data.progress;
    settleBookProgressPreview();
    curChapter = e.data.chapter || 0;
    curChFrac = e.data.chFrac || 0;
    curReadingAnchor = e.data.anchor || null;
    if (!isPdf) {
      observeReaderContextMediaChapter(
        curChapter,
        curReadingAnchor,
        previousChapter,
        previousFraction,
        previousAnchor,
      );
      if (curChapter > previousChapter && previousFraction >= 0.98) {
        queueCompletedReadingMemory(previousChapter, curChapter, curChFrac);
      }
    }
    lastReportedReaderPage = Math.max(0, Math.round(Number(e.data.page) || 0));
    curTotalCh = e.data.totalCh || 1;
    if (pendingPositionSnapshot && Number(e.data.positionSnapshotRequestId) === pendingPositionSnapshot.requestId) {
      const latestResumePosition = sameBookResumePosition(curChapter, curReadingAnchor);
      if (latestResumePosition) {
        hiddenReaderResumePosition = latestResumePosition;
        if (sameBookResumePending) sendToPage({ sameBookResume: latestResumePosition });
      }
      const pending = pendingPositionSnapshot;
      pendingPositionSnapshot = null;
      clearTimeout(pending.timer);
      pending.resolve(true);
    }
    if (typeof e.data.logicalCh === "number") curVchap = e.data.logicalCh;
    if (e.data.logicalTotal) vchapTotal = e.data.logicalTotal;
    if (e.data.positionRestored === 1 && sameBookResumePending) {
      sameBookResumePending = false;
      if (sameBookResumeTimer) {
        clearTimeout(sameBookResumeTimer);
        sameBookResumeTimer = null;
      }
      const restoredOffset = Number(e.data.anchor?.text_offset);
      const resumeState = e.data.sameBookResumeState;
      const boundedInteger = (value: unknown, maximum: number): number | undefined => {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(0, Math.min(maximum, Math.round(number))) : undefined;
      };
      const reason = resumeState?.reason === "timeout" ? "timeout" : "stable";
      window.ReaderBugTrace?.record?.("same_book_resume", {
        source: "reader_shell",
        phase: "completed",
        outcome: "restored",
        reason,
        duration_ms: Math.max(0, Math.round(performance.now() - sameBookResumeStartedAt)),
        before_page: boundedInteger(resumeState?.before_page, 1_000_000),
        after_page: boundedInteger(resumeState?.after_page, 1_000_000) ?? lastReportedReaderPage,
        before_anchor_offset: boundedInteger(resumeState?.before_anchor_offset, 1_000_000_000),
        after_anchor_offset: boundedInteger(resumeState?.after_anchor_offset, 1_000_000_000)
          ?? (Number.isFinite(restoredOffset) ? Math.max(0, Math.round(restoredOffset)) : undefined),
        resize_sequence: boundedInteger(resumeState?.resize_sequence, 1_000_000),
        layout_width: boundedInteger(resumeState?.layout_width, 100_000),
        layout_height: boundedInteger(resumeState?.layout_height, 100_000),
        viewport_width: Math.max(0, Math.round(window.innerWidth || 0)),
        viewport_height: Math.max(0, Math.round(window.innerHeight || 0)),
        restore_pending: false,
        save_suppressed: false,
      });
      hiddenReaderResumePosition = null;
    }
    if (isPdf) {
      const values = { page: e.data.page || 1, total: e.data.total || 1, progress: curProgress.toFixed(1) };
      if (progressPercentageEl) progressPercentageEl.textContent = readerText("progressPercentage", "{progress}%", values);
      showWholeBookPages(values.page, values.total);
      applyPageInfoVisibility();
    } else {
      // 全书页数是补充信息，不能覆盖原有的章节、本章页数和百分比。
      showChapterProgress(e.data.page, e.data.total, curProgress, e.data.dualContinuationChapter);
      const gP = e.data.gPage || 0,
        gT = e.data.gTotal || 0;
      if (gT > 0) {
        showWholeBookPages(gP, gT);
      } else if (pageCountMeasuring) {
        // 章节位置上报不能把右上角的全书测量状态覆盖掉。
        showProgressLoading();
      }
    }
    if (!isPdf) readerEndRecommendations?.observe(e.data);
    // 初次恢复消息只用于刷新页码。若在这里自动保存，浏览器尚未稳定的
    // 首帧采样会反向覆盖关闭前的准确位置。
    if (e.data.positionRestored !== 1) reportProgress(e.data.positionCommit === 1);
    trackReadWords(e.data); // 累计真正读过的字数
    trackReaderNavigationBackProgress(e.data);
    if (!vdragging && !isPdf) updateThumb();
    else updateBookProgress();
    hideLoading(); // 当前章/页排版完成
    // 沉浸模式下：翻页/滚到新页 → 自动收起浮现的工具栏，避免挡住正文。
    // 但若设置面板/搜索框正开着，则不收——否则调节滑块时正文重排会改变页码签名，
    // 误判为“翻页”而把工具栏（连同打开的设置面板）一起隐藏。
    const sig = (e.data.gPage || 0) + "_" + (e.data.page || 0) + "_" + (e.data.chapter || 0);
    const panelOpen = ReaderShell.hasOverlay();
    const toolbarPinned = ReaderShell.getState().toolbar === ReaderShell.TOOLBAR.IMMERSIVE_PINNED;
    if (lastPosSig && sig !== lastPosSig && immersive && toolbarPinned && !panelOpen && !bookProgressPinned && Date.now() > keepImmersiveBarUntil) {
      ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
    }
    lastPosSig = sig;
  }
  if (e.data.ttsState !== undefined) {
    ttsPlaying = !!e.data.ttsState;
    ttsBtn.textContent = ttsPlaying ? "⏸" : "🔊";
    ttsBtn.classList.toggle("active", ttsPlaying);
  }
  if (e.data.ttsSynth) {
    // 合并页要某句的在线音频 → 调 edge_tts → 回传音频+词时间戳
    const r = e.data.ttsSynth;
    invoke<TtsAudioResponse>("edge_tts", { request: { text: r.text, voice: r.voice, rate: r.rate } })
      .then((res) => sendToPage({ ttsAudio: { seq: r.seq, idx: r.idx, audio: res.audio, marks: res.marks } }))
      .catch((err) => sendToPage({ ttsAudioErr: { seq: r.seq, idx: r.idx, err: String(err) } }));
  }
  if (e.data.dictPrefetch) prefetchMicrosoftWord(e.data.dictPrefetch);
  if (e.data.dictSpeak) speakMicrosoftWord(e.data.dictSpeak);
  if (e.data.ttsErr) {
    const m = e.data.ttsErr;
    alert(typeof m === "string"
      ? readerText("ttsOnlineFailed", "Online speech failed: {error}", { error: m })
      : m === 1 ? readerText("ttsUnsupported", "Speech is unavailable in this environment.")
      : readerText("ttsReadFailed", "Online speech could not read this text."));
  }
  if (e.data.ttsNoSystemVoice && !ttsNoSystemVoiceWarned) {
    ttsNoSystemVoiceWarned = true;
    alert(readerText("ttsNoSystemVoice", "No system voice matches the text language."));
  }
  if (e.data.outline) scheduleTocBuild(e.data.outline); // PDF 内置目录也避免同步创建大量节点
  if (e.data.pdfState) {
    // PDF 缩放/双页变化 → 记住（节流写盘），并同步双页按钮高亮
    const st = e.data.pdfState;
    pdfDual = !!st.dual;
    document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
    if (pdfStateTimer) clearTimeout(pdfStateTimer);
    pdfStateTimer = setTimeout(() => {
      invoke("set_pdf_state", { scale: st.scale, dual: !!st.dual }).catch(() => {});
    }, 600);
  }
  if (e.data.searchResults && isPdf) renderResults(window.rsearchInput?.value ?? "", e.data.searchResults); // PDF 书内搜索结果
  if (e.data.uiClick) {
    // 正文被点击：关闭外壳浮层（沉浸与非沉浸一致）。
    if (!isSearchInputEditActive()) ReaderShell.closeOverlay();
  }
  if (e.data.userNav) {
    // 正文区键盘/滚轮翻页：收起搜索框与沉浸工具栏。
    // 不在这里关设置面板——设置途中（滑块/数字框调节）可能触发翻页类事件，会误关；
    // 设置面板只在“点设置页之外”时关闭（见 uiClick 与下方 document 点击处理）。
    if (ReaderShell.isOverlay(ReaderShell.OVERLAY.SEARCH) && !isSearchInputEditActive()) toggleSearch(false);
    hideBookProgressAfterReadingAction();
    ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
  }
  if (e.data.readerNavigated) {
    hideBookProgressAfterReadingAction();
    hideBookProgress();
  }
  if (e.data.centerTap) {
    // 普通模式的中部点击切换底部整书进度；顶部菜单本来就常驻。
    // 沉浸模式则只保留既有的工具栏切换行为。
    toggleBookProgressFromCenterTap();
    toggleReaderToolbar();
  }
  if (e.data.ready) {
    hideLoading();
    frameReady = true;
    window.ReaderStartupGuard?.markFrameReady?.();
    if (!readerFirstReadyLogged) {
      readerFirstReadyLogged = true;
      const readyElapsedMs = performance.now() - readerShellStartedAt;
      invoke("reader_perf_log", { event: `shell_ready elapsed_ms=${readyElapsedMs.toFixed(1)}` }).catch(() => {});
      recordReaderPerformance("frame_ready", readyElapsedMs);
    }
    window.ReaderBugTrace?.record?.("frame_ready", {
      source: "reader_page",
      ready: true,
      is_pdf: isPdf,
      chapter: curChapter,
    });
    // 设置页的中缝预览使用另一张真实 reader:// 页面。通知其在用户拖动前
    // 完成后台首帧，避免第一次拖动时才初始化而没有预览。
    window.dispatchEvent(new CustomEvent("reader-frame-ready"));
    syncAnimationSettingsToPage();
    if (vchaps.length) sendToPage({ vchaps }); // 把逻辑章节表交给合并页
    sendToPage({ highlights: window.highlights }); // 把高亮交给合并页渲染
    if (!isPdf) {
      // 页数使用阅读窗口的稳定宽度；智读侧栏之后只压缩正文，不生成另一套缓存。
      sendToPage({
        pageCountViewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 1),
      });
      const chapterTotal = Array.isArray(vchaps) ? vchaps.length : 0;
      invoke("begin_page_count_task", { total: chapterTotal })
        .then((id) => {
          pageCountTaskId = String(id || "");
          // 取上次测好的页数缓存：版式一致则合并页直接采用，免重算。
          // 必须在任务登记后发送，完整缓存才能立即把该任务收口为完成。
          return invoke("get_page_cache");
        })
        .then((pc) => { if (pc) sendToPage({ pageCache: pc }); })
        .catch(() => {
          pageCountTaskId = "";
          invoke("get_page_cache")
            .then((pc) => { if (pc) sendToPage({ pageCache: pc }); })
            .catch(() => {});
        });
    }
    if (pendingJump) {
      doJump(pendingJump);
      pendingJump = null;
    }
  }
  if (e.data.pageCache) {
    // 每 4 章保存一次：超大书中途关闭后，下次按当前版式继续测量。
    const pc = e.data.pageCache;
    invoke("save_page_cache", {
      request: {
        sig: pc.sig,
        pages: pc.pages,
        complete: !!pc.complete,
      },
    }).catch(() => {});
    const done = Array.isArray(pc.pages)
      ? pc.pages.reduce((sum, pageCount) => sum + (Number(pageCount) > 0 ? 1 : 0), 0)
      : 0;
    if (pageCountTaskId || pc.pages?.length) {
      invoke("report_page_count_task", {
        request: {
          done,
          total: Array.isArray(pc.pages) ? pc.pages.length : 0,
          sig: String(pc.sig || ""),
          complete: !!pc.complete,
        },
      }).then((control) => {
        if (control === "pause" || control === "cancel") {
          sendToPage({ pageCountTaskControl: control });
        }
        if (control === "complete" || control === "cancel") pageCountTaskId = "";
      }).catch(() => {});
    }
  }
  if (e.data.downloadImage) {
    const img = e.data.downloadImage || {};
    const dataUrl = String(img.dataUrl || "");
    if (dataUrl.startsWith("data:image/")) {
      invoke("save_download_image", {
        name: String(img.name || readerText("excerptImageName", "excerpt.png")),
        dataUrl,
      })
        .then((path) => sendToPage({ excerptSaved: path || "" }))
        .catch((err) => {
          sendToPage({ excerptSaveError: String(err || readerText("saveImageFailed", "Could not save image")) });
          const a = document.createElement("a");
          a.download = String(img.name || readerText("excerptImageName", "excerpt.png")).replace(/[\\/:*?"<>|]/g, "_");
          a.href = dataUrl;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
    }
  }
  if (e.data.webSearch) {
    const request = typeof e.data.webSearch === "string"
      ? { term: e.data.webSearch, engine: "baidu" }
      : e.data.webSearch;
    invoke("web_search", { term: request.term, engine: request.engine || "baidu" }).catch(() => {});
  }
  if (e.data.crossSearch) {
    openCrossSearch(e.data.crossSearch);
  }
  if (e.data.semanticSearch) {
    openSemanticSearch(e.data.semanticSearch);
  }
  if (e.data.aiReader) {
    const request = e.data.aiReader;
    openAiReader(String(request.text || ""), {
      start: Number(request.anchorStart),
      end: Number(request.anchorEnd),
    });
  }
  if (e.data.getTranslationCredentialStatus) {
    const provider = String(e.data.getTranslationCredentialStatus || "");
    invoke("translation_credential_status", { provider })
      .then((status) => sendToPage({ translationCredentialStatus: status }))
      .catch((err) => sendToPage({ translationCredentialStatus: { provider, configured: false, error: String(err) } }));
  }
  if (e.data.getTranslationProfiles) {
    invoke("translation_credentials_status")
      .then((status) => sendToPage({ translationProfiles: status }))
      .catch((err) => sendToPage({ translationProfiles: { profiles: [], error: String(err) } }));
  }
  if (e.data.setTranslationActiveProvider) {
    invoke("set_translation_active_provider", { provider: String(e.data.setTranslationActiveProvider || "") })
      .then((status) => sendToPage({ translationProfiles: status }))
      .catch((err) => sendToPage({ translationProfiles: { profiles: [], error: String(err) } }));
  }
  if (e.data.saveTranslationCredential) {
    const credential = e.data.saveTranslationCredential;
    invoke("save_translation_credential", {
      request: {
        provider: credential.provider || "",
        apiId: credential.apiId || "",
        apiKey: credential.apiKey || "",
      },
    })
      .then((status) => sendToPage({ translationCredentialSaved: status }))
      .catch((err) => sendToPage({ translationCredentialSaved: { provider: credential.provider || "", configured: false, error: String(err) } }));
  }
  if (e.data.translateText) {
    const req = e.data.translateText;
    invoke("translate_text", {
      request: {
        text: req.text || "",
        sourceLang: req.source || "auto",
        targetLang: req.target || "system",
        provider: req.provider || "baidu",
        credentialConfigId: req.credentialConfigId || "",
      },
    })
      .then((r) => sendToPage({ translateResult: r }))
      .catch((err) =>
        sendToPage({
          translateResult: {
            ok: false,
            provider: req.provider || "baidu",
            source_lang: req.source || "auto",
            target_lang: req.target || "system",
            original: req.text || "",
            translated: "",
            error: String(err || readerText("translationFailed", "Translation failed")),
          },
        }),
      );
  }
  if (e.data.dict !== undefined) {
    invoke("dict_lookup", { term: e.data.dict, context: e.data.dictContext || "" })
      .then((r) => sendToPage({ dictResult: { ...(typeof r === "object" && r !== null ? r : {}), autoSpeak: window.vocabAutoSpeak } }))
      .catch(() => sendToPage({ dictResult: { found: false, word: e.data.dict } }));
  }
  if (e.data.vocabAdd) {
    const v = e.data.vocabAdd;
    invoke("vocab_add", {
      entry: {
        word: v.word,
        lang: v.lang,
        def: v.def || "",
        def_en: v.def_en || "",
        phonetic: v.phonetic || "",
        example: v.example || "",
        book_title: currentBookTitle || "",
      },
    }).catch(() => {});
  }
  if (e.data.addHighlight) {
    addHighlight(e.data.addHighlight, "");
  }
  if (e.data.addHighlightCorrect) {
    addHighlight(e.data.addHighlightCorrect, "", false, true);
  }
  if (e.data.addHighlightCorrectDraft) {
    const d = e.data.addHighlightCorrectDraft;
    addCorrectedHighlight(d, d.correctedText || "");
  }
  if (e.data.addHighlightNote) {
    addHighlight(e.data.addHighlightNote, "", true); // 先建高亮，随即打开批注面板
  }
  if (typeof e.data.openAnnotations === "number") {
    openAnnotations(e.data.openAnnotations);
  }
  if (typeof e.data.removeHighlight === "number") {
    invoke("remove_highlight", { index: e.data.removeHighlight }).then((list) => {
      window.highlights = list;
      sendToPage({ highlights: window.highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightNote) {
    const { index, note } = e.data.setHighlightNote;
    invoke("set_highlight_note", { index, note }).then((list) => {
      window.highlights = list;
      sendToPage({ highlights: window.highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightText) {
    const { index, text } = e.data.setHighlightText;
    invoke("set_highlight_text", { index, text }).then((list) => {
      window.highlights = list;
      sendToPage({ highlights: window.highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightColor) {
    const { index, color } = e.data.setHighlightColor;
    invoke("set_highlight_color", { index, color }).then((list) => {
      window.highlights = list;
      sendToPage({ highlights: window.highlights });
      renderHighlights();
    });
  }
  if (e.data.addBookmark) {
    const o = e.data.addBookmark;
    // 统一标签：第 N 页/章 · 百分比 ·（选中的文字片段，若有）
    const pageNo = Number(o.chapter || 0) + 1;
    let label = readerText("bookmarkLabel", "{kind} {number} · {progress}%", {
      kind: isPdf ? readerText("bookmarkPage", "Page") : readerText("bookmarkChapter", "Chapter"),
      number: pageNo,
      progress: curProgress.toFixed(1),
    });
    if (o.text) label += " · " + o.text;
    invoke("add_bookmark", {
      chapter: o.chapter || 0,
      frac: o.frac || 0,
      label,
    }).then((list) => {
      window.bookmarks = list;
      renderBookmarks();
    });
  }
  if (e.data.tocResolved && ReaderShell.isOverlay(ReaderShell.OVERLAY.TOC)) {
    const r = e.data.tocResolved;
    if (r.chapter === curChapter) {
      const items = [...tocPane.querySelectorAll<HTMLElement>(".toc-item")];
      let el = items.find(
        (it) => parseInt(it.dataset.chapter ?? "", 10) === curChapter && (it.dataset.frag || "") === (r.frag || "")
      );
      if (!el) el = items.find((it) => parseInt(it.dataset.chapter ?? "", 10) === curChapter);
      markToc(el);
    }
  }
});

// 外壳内点击：只要不是点在齿轮按钮/设置面板上，就关闭设置面板
document.addEventListener("click", (e) => {
  if (!ReaderShell.isOverlay(ReaderShell.OVERLAY.SETTINGS)) return;
  if (e.target instanceof Element && e.target.closest(".gear-wrap")) return; // 点齿轮或面板内部，不关
  closeSettings();
});

// 焦点在外壳时，把翻页键转发给合并页
window.addEventListener("keydown", (e) => {
  // 中文输入法候选/上屏会发 Process（keyCode 229）及组合键事件；
  // 这些事件不能触发阅读器的翻页和关闭浮层逻辑。
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
  // 焦点在输入控件（搜索框、设置里的滑块/数字框/下拉）时，方向键用于调节数值，
  // 不能抢去翻页，否则会 preventDefault 掉调节、还顺手关掉设置面板
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
  let dir = 0;
  if (e.key === "PageDown" || e.key === "ArrowRight" || e.key === "ArrowDown" || (e.key === " " && !e.shiftKey)) dir = 1;
  else if (e.key === "PageUp" || e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey)) dir = -1;
  if (dir !== 0) {
    window.ReaderBugTrace?.record?.("shell_key", {
      source: "reader_shell",
      outcome: dir > 0 ? "page_next" : "page_prev",
      direction: dir > 0 ? "forward" : "backward",
      key: e.key === " " ? "space" : e.key,
    });
    e.preventDefault();
    // 翻页同时收起浮层与沉浸工具栏
    if (
      ReaderShell.isOverlay(ReaderShell.OVERLAY.SEARCH) ||
      ReaderShell.isOverlay(ReaderShell.OVERLAY.SETTINGS)
    ) ReaderShell.closeOverlay();
    hideBookProgressAfterReadingAction();
    ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
    sendToPage({ pageTurn: dir });
  }
});

// ---------- 阅读设置 ----------
// 阅读设置状态与面板绑定在 reader-settings-ui.js。

// 合并页加载完成后，PDF 直接由 WebView 渲染，加载事件即可关掉遮罩。
frame.addEventListener("load", () => {
  if (document.body.classList.contains("pdf-mode")) hideLoading();
});

// 阅读统计：只在有效阅读状态下按真实间隔累计；当前页也会定期结算字数。
// 隐藏测速壳仅用于测量启动阶段，绝不计入阅读时长或字数。
if (!isReaderShellBenchmark) {
  setInterval(tickReadingTime, READ_TRACK.readingTimeTickMs);
  setInterval(creditCurrentReadPage, READ_TRACK.periodicCreditMs);
}

// 目录、书签、批注/高亮 UI 在 reader-notes-ui.js。

// From here on, startup only performs asynchronous book loading. The emergency
// close path may now hand control back to the normal save-and-close flow.
window.ReaderStartupGuard?.markScriptReady?.();

async function loadBoundReaderBook() {
  readerStartupPhase = "book_info";
  readerStartupFailureCategory = "none";
  try {
    window.ReaderStartupGuard?.beginBookLoad?.();
    const requestedTextConversion = settings.textConversion === "t2s" || settings.textConversion === "s2t"
      ? settings.textConversion
      : "original";
    const info = await invoke<BookInfo>("book_info", innerReaderEngineReady ? {
      includeInitialChapter: true,
      textConversion: requestedTextConversion,
    } : undefined);
    readerStartupPhase = "book_info_loaded";
    const infoElapsedMs = performance.now() - readerShellStartedAt;
    invoke("reader_perf_log", { event: `shell_info elapsed_ms=${infoElapsedMs.toFixed(1)}` }).catch(() => {});
    recordReaderPerformance("book_info", infoElapsedMs);
    resetReaderContextMediaQueueForBook(String(info.content_id || info.id || "").trim());
    currentBookId = info.id || "";
    window.currentBookId = currentBookId;
    currentBookContentId = info.content_id || "";
    window.currentBookContentId = currentBookContentId;
    currentBookTitle = info.title || currentBookTitle || "";
    readerCompanionSettings = {};
    renderReaderCompanionSettings(readerCompanionSettings);
    void loadReaderCompanionSettings();
    window.ReaderBugTrace?.record?.("book_opened", {
      source: "reader_shell",
      format: String(info.format || "unknown"),
      chapter: Number(info.resume_chapter || 0),
    });
    const readerNotesSnapshot = {
      bookmarks: info.bookmarks || [],
      highlights: info.highlights || [],
    };
    window.pendingReaderNotesSnapshot = readerNotesSnapshot;
    const initializeAncillaryReaderUi = () => {
      window.ReaderSettings?.setBookContext?.(currentBookId);
      readerEndRecommendations?.reset(currentBookId, { wordCount: info.word_count });
      aiReaderMergeSyncedHistory();
      window.updateCrossReturnButton?.();
      window.consumePendingCrossSearch?.();
      window.initializeReaderNotes?.(readerNotesSnapshot);
      if (frameReady) sendToPage({ highlights: readerNotesSnapshot.highlights });
    };
    const scheduleAncillaryReaderUi = () => {
      if (typeof requestIdleCallback === "function") requestIdleCallback(initializeAncillaryReaderUi, { timeout: 250 });
      else setTimeout(initializeAncillaryReaderUi, 0);
    };
    if (info.format === "pdf") {
      document.body.classList.add("pdf-mode");
      isPdf = true;
      const rp = (info.resume_chapter || 0) + 1; // resume_chapter 存的是页码-1
      // 恢复这本 PDF 上次的缩放/双页
      let pscale = 0, pdual = 0;
      try {
        const ps = await invoke<PdfState>("get_pdf_state");
        if (ps) { pscale = ps.scale || 0; pdual = ps.dual ? 1 : 0; }
      } catch {}
      if (pdual) {
        pdfDual = true;
        document.getElementById("pdf-dual").classList.add("active");
      }
      const pdfSource =
        "pdfview.html?u=" + encodeURIComponent(info.url ?? "") +
        "&p=" + rp +
        "&scale=" + pscale +
        "&dual=" + pdual +
        "&s=" + encodeURIComponent(JSON.stringify(settings));
      readerStartupPhase = "frame_navigation";
      if (!window.ReaderStartupGuard?.beginFrameNavigation?.(pdfSource)) {
        recordReaderStartupFailure("frame_navigation", "invalid source");
        return;
      }
      frame.src = pdfSource;
      scheduleAncillaryReaderUi();
      return;
    }
    resumeChapter = info.resume_chapter || 0;
    resumeFrac = info.resume_frac || 0;
    curChapter = resumeChapter;
    curChFrac = resumeFrac;
    curProgress = Number(info.progress || 0);
    curReadingAnchor = info.resume_position?.anchor || null;
    observeReaderContextMediaChapter(curChapter, curReadingAnchor);
    // 逻辑章节 = 目录条目按"所在文件(spine)"去重，每个文件取第一条：
    // 金庸全集每"回"是独立文件 → 保留到回级；Python Cookbook 上千个"#锚点小节"同属十几个章节文件 → 合并回章级。
    const toc = info.toc || [];
    vchaps = [];
    const seenCh = new Set();
    for (const e of toc) {
      const ch = e.chapter || 0;
      if (seenCh.has(ch)) continue;
      seenCh.add(ch);
      vchaps.push({ ch, frag: e.frag || "" });
    }
    vchapTotal = vchaps.length || (info.chapter_count || 1);
    const textConversion = requestedTextConversion;
    // 设置 + 续读位置（章节/章内比例）随 URL 传给合并页：据此只加载该章并定位
    const q =
      "?rc=" + resumeChapter +
      "&rf=" + resumeFrac +
      "&ra=" + encodeURIComponent(JSON.stringify(info.resume_position || null)) +
      "&s=" + encodeURIComponent(JSON.stringify(settings)) +
      "&tc=" + encodeURIComponent(textConversion) +
      (isReaderShellBenchmark ? "&benchmark=1" : "");
    const readerSource = info.url + q;
    readerStartupPhase = "frame_navigation";
    if (!window.ReaderStartupGuard?.beginFrameNavigation?.(readerSource)) {
      recordReaderStartupFailure("frame_navigation", "invalid source");
      return;
    }
    if (innerReaderEngineReady && frame.contentWindow) {
      innerReaderEngineReady = false;
      frame.contentWindow.postMessage({ readerEngineBind: {
        id: info.id,
        chapterCount: info.chapter_count || 1,
        resumeChapter,
        resumeFrac,
        resumePosition: info.resume_position || null,
        settings,
        textConversion,
        benchmark: isReaderShellBenchmark,
        initialChapter: info.initial_chapter || null,
      } }, "*");
    } else {
      frame.src = readerSource;
    }
    // 正文导航已经开始后再分批构建目录；超大目录不再阻塞首屏。
    // reader-notes-ui 在外壳之后加载；极快的本机 IPC 可能比 HTML 解析更早返回。
    // 先保存目录，辅助脚本就绪后会接手，避免首屏因未定义函数而中断。
    window.pendingReaderToc = toc;
    window.scheduleTocBuild?.(toc);
    scheduleAncillaryReaderUi();
    // 若本次是从书架检索点开的，取走待跳转位置，合并页就绪后跳过去
    invoke<JumpRequest | null>("take_pending_jump").then((j) => { if (j) doJump(j); }).catch(() => {});
  } catch (e) {
    // Keep the native close control and outer shell alive. Replacing body here
    // used to leave an uncloseable reader with its iframe at about:blank.
    recordReaderStartupFailure(readerStartupPhase, e);
    window.ReaderStartupGuard?.failBookLoad?.(e);
  }
}

(async () => {
  initSettingsUI();
  applyShellTheme(settings.theme);
  if (isReaderShellBenchmark) {
    const bootstrapElapsedMs = performance.now() - readerShellStartedAt;
    invoke("reader_perf_log", { event: `shell_bootstrap elapsed_ms=${bootstrapElapsedMs.toFixed(1)}` }).catch(() => {});
  }
  if (isCleanPooledShell) {
    // 隐藏 WebView 先完成外壳，再用同一套 reader-page 代码启动一个未绑定
    // 图书的内层引擎。激活时只注入图书 ID、续读位置和首章缓存，不再导航
    // 或重跑内层脚本；不会提前读取正文或写入阅读进度。
    await listen("reader-shell-activate", async () => {
      if (currentBookId) return;
      if (readerBookLoadInFlight) {
        readerBookActivationPending = true;
        return;
      }
      do {
        readerBookActivationPending = false;
        readerBookBound = true;
        readerShellStartedAt = performance.now();
        readerPerformanceOpeningId = Date.now();
        recordReaderPerformance("shell_activate_received", 0);
        window.ReaderGestureClose?.activate?.();
        readerBookLoadInFlight = true;
        try {
          await loadBoundReaderBook();
        } finally {
          readerBookLoadInFlight = false;
        }
      } while (readerBookActivationPending && !currentBookId);
    });
    if (preloadInnerReaderEngine) {
      const engineUrl = await invoke<string>("reader_shell_inner_engine_url");
      frame.src = engineUrl;
    } else {
      await invoke("reader_shell_pool_ready").catch(() => {});
      if (isReaderShellBenchmark) {
        invoke("reader_perf_log", { event: "shell_prepared" }).catch(() => {});
      }
    }
    return;
  }
  await loadBoundReaderBook();
})();
}
