import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriEvent,
  type TauriTransport,
  type TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.js";

const WINDOW_MS = 2 * 60 * 1000;
const MAX_SHELL_EVENTS = 320;

type ProblemTraceCommands = {
  readonly problem_trace_checkpoint: {
    readonly args: { readonly snapshot: TraceSnapshot | Record<string, unknown> | null };
    readonly result: TraceSnapshot | null;
  };
};

type VerifiedProblemTraceCommands = ProblemTraceCommands extends TauriCommandMap
  ? ProblemTraceCommands
  : never;

interface TraceSnapshot extends Record<string, unknown> {
  readonly captured_at?: unknown;
  readonly events?: unknown;
}

interface ShellTraceEvent {
  readonly at_ms: number;
  readonly type: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

interface DurationSummary {
  readonly count: number;
  readonly min_ms: number;
  readonly avg_ms: number;
  readonly max_ms: number;
  readonly latest_ms: number;
}

interface TraceEventApi {
  listen<TPayload>(
    event: string,
    handler: (event: TauriEvent<TPayload>) => void,
  ): Promise<TauriUnlisten>;
  emit<TPayload>(event: string, payload?: TPayload): Promise<void>;
}

interface TraceStorage {
  getItem(key: string): string | null;
}

interface ProblemTraceDocument extends Document {
  __problemTraceShellWired?: boolean;
}

interface TraceTarget extends Element {
  readonly id: string;
  readonly tagName: string;
  readonly dataset: DOMStringMap;
}

interface StartupEnhancementSnapshot {
  readonly enabled?: unknown;
  readonly continueHighCost?: unknown;
  readonly launchAtLogin?: unknown;
}

interface ProblemTraceRuntime extends Record<string, unknown> {
  readonly document?: ProblemTraceDocument;
  readonly localStorage?: TraceStorage;
  readonly navigator?: Pick<Navigator, "platform" | "language">;
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly ReaderAppI18n?: { selectedLanguage?(): unknown };
  readonly ReaderStartupEnhancement?: { snapshot?(): StartupEnhancementSnapshot | null };
  focus?(): void;
  addEventListener?(type: "focus" | "blur", listener: () => void, options?: boolean): void;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle?: number | null): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
}

export interface ProblemTraceCaptureOptions {
  readonly eventApi?: TraceEventApi;
  readonly timeoutMs?: number;
}

export interface ProblemTraceUiApi {
  readonly WINDOW_MS: number;
  readonly MAX_SHELL_EVENTS: number;
  readonly capture: (options?: ProblemTraceCaptureOptions) => Promise<Record<string, unknown>>;
  readonly recordShelfBookOpen: (outcome: unknown, input: unknown) => void;
  /** Records only a redacted news-reader phase, never a URL or article text. */
  readonly recordNewsArticleTiming: (
    stage: unknown,
    outcome: unknown,
    durationMs: unknown,
    sequence: unknown,
  ) => void;
  /** Records only audit render timing and aggregate counts; never news text or URLs. */
  readonly recordIntelligenceAuditTiming: (
    action: unknown,
    phase: unknown,
    durationMs: unknown,
    stageId: unknown,
    itemCount: unknown,
  ) => void;
  /** Records window-control delivery and native-command outcome without errors or paths. */
  readonly recordWindowControl: (
    control: unknown,
    phase: unknown,
    outcome: unknown,
  ) => void;
  /** Records a gesture lifecycle only; it never stores cursor coordinates or paths. */
  readonly recordGesture: (
    input: unknown,
    phase: unknown,
    outcome: unknown,
    sampleCount: unknown,
    action: unknown,
  ) => void;
  readonly _rememberReaderSnapshotForTests: (snapshot: unknown) => boolean;
  readonly _recentReaderSnapshotForTests: (now?: number) => TraceSnapshot | null;
  readonly _shellEventsForTests: () => ShellTraceEvent[];
  readonly _summarizeStartupPerformanceForTests: (
    logs: unknown,
  ) => Readonly<Record<string, unknown>>;
  readonly _collectSoftwareSettingsForTests: (
    storage?: TraceStorage,
  ) => Readonly<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ProblemTraceRuntime | null {
  const runtime = record(value);
  if (
    !runtime ||
    typeof runtime.setTimeout !== "function" ||
    typeof runtime.clearTimeout !== "function"
  ) {
    return null;
  }
  return runtime as unknown as ProblemTraceRuntime;
}

function eventRecord(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function eventTargetElement(value: unknown): Element | null {
  if (!value || typeof value !== "object") return null;
  if (typeof Element !== "undefined" && value instanceof Element) return value;
  return typeof (value as { readonly closest?: unknown }).closest === "function"
    ? value as Element
    : null;
}

function safeLabel(value: unknown, fallback = "other"): string {
  const label = String(value || "").trim();
  return /^[a-z0-9_.:-]{1,80}$/iu.test(label) ? label : fallback;
}

function numberField(value: unknown, key: string): number {
  return Number(record(value)?.[key]);
}

function stringField(value: unknown, key: string): string {
  return String(record(value)?.[key] || "");
}

function summarizeDurations(values: readonly number[]): DurationSummary {
  const samples = values.filter((value) => Number.isFinite(value) && value >= 0);
  if (!samples.length) {
    return { count: 0, min_ms: 0, avg_ms: 0, max_ms: 0, latest_ms: 0 };
  }
  const total = samples.reduce((sum, value) => sum + value, 0);
  const latest = samples.at(-1) ?? 0;
  return {
    count: samples.length,
    min_ms: Number(Math.min(...samples).toFixed(1)),
    avg_ms: Number((total / samples.length).toFixed(1)),
    max_ms: Number(Math.max(...samples).toFixed(1)),
    latest_ms: Number(latest.toFixed(1)),
  };
}

function summarizeReaderPerformance(events: readonly Record<string, unknown>[]) {
  const durations = (predicate: (event: Record<string, unknown>) => boolean): number[] =>
    events.filter(predicate).map((event) => numberField(event.detail, "duration_ms"));
  return {
    window_build: summarizeDurations(
      durations(
        (event) =>
          event.type === "reader_window" &&
          stringField(event.detail, "phase") === "open_build" &&
          stringField(event.detail, "outcome") === "ok",
      ),
    ),
    book_info: summarizeDurations(
      durations(
        (event) =>
          event.type === "reader_performance" &&
          stringField(event.detail, "stage") === "book_info",
      ),
    ),
    first_page_ready: summarizeDurations(
      durations(
        (event) =>
          event.type === "reader_performance" &&
          stringField(event.detail, "stage") === "frame_ready",
      ),
    ),
    close_destroy: summarizeDurations(
      durations(
        (event) =>
          event.type === "reader_window" &&
          stringField(event.detail, "phase") === "destroyed" &&
          stringField(event.detail, "outcome") === "closed",
      ),
    ),
  };
}

function startupDuration(detail: unknown): number {
  const match = String(detail || "").match(/^\s*(\d+(?:\.\d+)?)ms\b/iu);
  return match?.[1] ? Number(match[1]) : Number.NaN;
}

function summarizeStartupPerformance(logs: unknown): Readonly<Record<string, unknown>> {
  const entries = Array.isArray(logs) ? logs : [];
  const sessions = new Map<string, Record<string, number>>();
  entries.forEach((rawEntry) => {
    const entry = eventRecord(rawEntry);
    const session = String(entry.session || "");
    if (!session) return;
    const stages = sessions.get(session) ?? {};
    sessions.set(session, stages);
    const phase = String(entry.phase || "");
    if (
      entry.name === "startup" &&
      ["webview_script", "dom_ready", "shelf_painted"].includes(phase)
    ) {
      stages[phase] = startupDuration(entry.detail);
    }
  });
  const values = (stage: string): number[] =>
    [...sessions.values()].map((session) => Number(session[stage]));
  const hotActivations = entries
    .map(eventRecord)
    .filter(
      (entry) =>
        entry.name === "rust:startup-enhancement" && entry.phase === "activated",
    )
    .map((entry) => startupDuration(entry.detail));
  return {
    sessions: sessions.size,
    process_to_webview_script: summarizeDurations(values("webview_script")),
    process_to_dom_ready: summarizeDurations(values("dom_ready")),
    process_to_shelf_painted: summarizeDurations(values("shelf_painted")),
    hot_activation: summarizeDurations(hotActivations),
  };
}

function storageValue(storage: TraceStorage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageJson(storage: TraceStorage | undefined, key: string, fallback: unknown): unknown {
  try {
    const value = storageValue(storage, key);
    return value === null ? fallback : (JSON.parse(value) as unknown);
  } catch {
    return fallback;
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? Math.max(minimum, Math.min(maximum, Math.round(number)))
    : fallback;
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function safePreferenceText(value: unknown): string {
  const text = String(value || "").trim();
  return text &&
    text.length <= 80 &&
    !/[\\/\u0000-\u001f]/u.test(text) &&
    !/^(?:data:|https?:)/iu.test(text)
    ? text
    : "";
}

function booleanFlags(
  value: unknown,
  keys: readonly string[],
  defaults = true,
): Record<string, boolean> {
  const source = record(value) ?? {};
  return Object.fromEntries(
    keys.map((key) => [
      key,
      source[key] !== false && (source[key] !== true ? defaults : source[key]),
    ]),
  );
}

/** A bounded numeric rectangle only; never accepts a monitor name, title, path, or URL. */
function geometryDetail(value: unknown): Readonly<Record<string, number>> | null {
  const geometry = record(value);
  if (!geometry) return null;
  const width = boundedInteger(geometry.w, 0, 0, 32_768);
  const height = boundedInteger(geometry.h, 0, 0, 32_768);
  if (width < 100 || height < 100) return null;
  return {
    x: boundedInteger(geometry.x, 0, -65_536, 65_536),
    y: boundedInteger(geometry.y, 0, -65_536, 65_536),
    w: width,
    h: height,
  };
}

function geometryRestoreDetail(value: unknown): Readonly<Record<string, unknown>> | null {
  const restore = record(value);
  if (!restore) return null;
  return {
    space: safeLabel(restore.space, "unknown"),
    size_applied: restore.size_applied === true,
    position_applied: restore.position_applied === true,
    clamped: restore.clamped === true,
    target_width: boundedInteger(restore.target_width, 0, 0, 32_768),
    target_height: boundedInteger(restore.target_height, 0, 0, 32_768),
  };
}

function activeElementCategory(document?: ProblemTraceDocument): string {
  const active = eventTargetElement(document?.activeElement);
  if (!active) return "none";
  if (active.closest('[data-problem-target="book-card"]')) return "book_card";
  if (active.closest("#shelf,.content")) return "shelf_content";
  if (active.matches("button,input,select,textarea,a,[contenteditable=true]")) return "control";
  if (active.matches("body,html")) return "document";
  return "other";
}

function activeElementLabel(value: unknown): string {
  return choice(
    value,
    ["none", "document", "other", "book_card", "shelf_content", "control", "reader_frame", "reader_shell", "titlebar"] as const,
    "other",
  );
}

function focusDetail(document?: ProblemTraceDocument): Readonly<Record<string, unknown>> {
  return {
    document_focused: document?.hasFocus() === true,
    active_element: activeElementCategory(document),
  };
}

function readerResumeNumericDetail(value: unknown): Readonly<Record<string, number>> {
  const payload = eventRecord(value);
  const result: Record<string, number> = {};
  const numericFields = [
    ["viewport_width", "viewportWidth", 0, 32_768],
    ["viewport_height", "viewportHeight", 0, 32_768],
    ["layout_width", "layoutWidth", 0, 32_768],
    ["layout_height", "layoutHeight", 0, 32_768],
    ["page", "page", 0, 1_000_000],
    ["before_page", "beforePage", 0, 1_000_000],
    ["after_page", "afterPage", 0, 1_000_000],
    ["anchor_offset", "anchorOffset", 0, 1_000_000_000],
    ["before_anchor_offset", "beforeAnchorOffset", 0, 1_000_000_000],
    ["after_anchor_offset", "afterAnchorOffset", 0, 1_000_000_000],
    ["resize_sequence", "resizeSequence", 0, 1_000_000],
  ] as const;
  numericFields.forEach(([outputKey, camelKey, minimum, maximum]) => {
    const raw = payload[camelKey] ?? payload[outputKey];
    if (!Number.isFinite(Number(raw))) return;
    result[outputKey] = boundedInteger(raw, 0, minimum, maximum);
  });
  return result;
}

function optionalTransport(target: Record<string, unknown>): TauriTransport | undefined {
  try {
    return transportFromTauriGlobal(target);
  } catch {
    return undefined;
  }
}

export function initializeProblemTraceUi(
  runtime: ProblemTraceRuntime,
  transport?: TauriTransport,
): ProblemTraceUiApi {
  const shellEvents: ShellTraceEvent[] = [];
  let latestReaderSnapshot: TraceSnapshot | null = null;
  let checkpointTimer: number | null = null;
  let lastWindowFocused = runtime.document?.hasFocus() === true;
  let lastWindowFocusChangedAt = Date.now();
  const api = transport ? createTauriApi<VerifiedProblemTraceCommands>(transport) : null;
  const defaultEventApi: TraceEventApi | undefined = transport?.listen && transport.emit
    ? {
        listen: (event, handler) => transport.listen!(event, handler),
        emit: (event, payload) => transport.emit!(event, payload),
      }
    : undefined;

  // Keep the two-minute causal window before the most recent operation.  A
  // user may wait before opening the feedback dialog; that wait must not erase
  // the operation sequence that led to the problem.
  const pruneShellEvents = (referenceAt = shellEvents.at(-1)?.at_ms ?? Date.now()): void => {
    const cutoff = referenceAt - WINDOW_MS;
    while ((shellEvents[0]?.at_ms ?? Number.POSITIVE_INFINITY) < cutoff) shellEvents.shift();
    while (shellEvents.length > MAX_SHELL_EVENTS) shellEvents.shift();
  };

  const pushShellEvent = (
    type: unknown,
    detail: Readonly<Record<string, unknown>>,
  ): void => {
    const now = Date.now();
    pruneShellEvents(now);
    shellEvents.push({ at_ms: now, type: safeLabel(type, "shell_operation"), detail });
    pruneShellEvents(now);
  };

  const inputFocusTransitionDetail = (
    document = runtime.document,
  ): Readonly<Record<string, unknown>> => {
    const ageMs = Math.max(0, Math.min(30_000, Date.now() - lastWindowFocusChangedAt));
    return {
      ...focusDetail(document),
      window_focused_before_input: lastWindowFocused,
      focus_transition_age_ms: ageMs,
      recently_activated: lastWindowFocused && ageMs <= 250,
    };
  };

  const traceArea = (target: TraceTarget | null): string => {
    const id = String(target?.id || "");
    if (/library-ai/iu.test(id) || target?.closest("#library-ai-page")) return "library_qa";
    if (/newsnow/iu.test(id) || target?.closest("#newsnow-page,#newsnow-reader")) return "news";
    if (/stats|reading-timeline/iu.test(id) || target?.closest("#stats-modal,#reading-timeline-modal")) return "reading_stats";
    if (/bookmark|favorite|collection|book-organization/iu.test(id) || target?.closest("#book-info-modal,#book-organization-modal")) return "book_organization";
    if (/settings|api-|dict|animation|auto-import|recommendation/iu.test(id) || target?.closest("#fp-settings-modal,#api-settings-modal,#animation-settings-modal,#external-dict-modal,#auto-import-modal,#reader-recommendation-settings-modal,#newsnow-settings-modal")) return "settings";
    if (/shelf|book-card|mi-|filter|sort/iu.test(id) || target?.closest("#shelf,#filter-panel")) return "shelf";
    return "main_window";
  };

  const recordShellOperation = (kind: unknown, target: TraceTarget): void => {
    pushShellEvent(`shell_${safeLabel(kind, "operation")}`, {
      source: "main_window",
      area: traceArea(target),
      target: safeLabel(
        target.dataset.problemTarget || target.id || target.tagName.toLowerCase(),
        "control",
      ),
    });
    scheduleShellCheckpoint();
  };

  const recordShelfBookOpen = (outcome: unknown, input: unknown): void => {
    pushShellEvent("book_open", {
      source: "main_window",
      area: "shelf",
      outcome: safeLabel(outcome),
      input: safeLabel(input),
      ...focusDetail(runtime.document),
    });
    scheduleShellCheckpoint();
  };

  const recordNewsArticleTiming = (
    stage: unknown,
    outcome: unknown,
    durationMs: unknown,
    sequence: unknown,
  ): void => {
    pushShellEvent("news_article", {
      source: "newsnow",
      stage: safeLabel(stage, "unknown"),
      outcome: safeLabel(outcome, "unknown"),
      duration_ms: Math.max(0, Math.min(30_000, Number(durationMs) || 0)),
      sequence: Math.max(0, Math.min(1_000_000, Math.floor(Number(sequence) || 0))),
    });
    scheduleShellCheckpoint();
  };

  const recordIntelligenceAuditTiming = (
    action: unknown,
    phase: unknown,
    durationMs: unknown,
    stageId: unknown,
    itemCount: unknown,
  ): void => {
    pushShellEvent("intelligence_audit", {
      source: "intelligence",
      action: safeLabel(action, "unknown"),
      phase: safeLabel(phase, "unknown"),
      duration_ms: Math.max(0, Math.min(30_000, Number(durationMs) || 0)),
      stage_id: safeLabel(stageId, "none"),
      item_count: boundedInteger(itemCount, 0, 0, 999_999),
    });
    scheduleShellCheckpoint();
  };

  const recordWindowControl = (
    control: unknown,
    phase: unknown,
    outcome: unknown,
  ): void => {
    pushShellEvent("window_control", {
      source: "main_window",
      control: safeLabel(control, "unknown"),
      phase: safeLabel(phase, "unknown"),
      outcome: safeLabel(outcome, "unknown"),
    });
    scheduleShellCheckpoint();
  };

  const recordGesture = (
    input: unknown,
    phase: unknown,
    outcome: unknown,
    sampleCount: unknown,
    action: unknown,
  ): void => {
    pushShellEvent("gesture", {
      source: "main_window",
      input: safeLabel(input, "unknown"),
      phase: safeLabel(phase, "unknown"),
      outcome: safeLabel(outcome, "unknown"),
      sample_count: boundedInteger(sampleCount, 0, 0, 160),
      action: safeLabel(action, "none"),
    });
    scheduleShellCheckpoint();
  };

  const wireShellOperations = (document = runtime.document): void => {
    if (!document || document.__problemTraceShellWired) return;
    document.__problemTraceShellWired = true;
    const recordOperation = (event: Event, kind: string): void => {
      const eventTarget = eventTargetElement(event.target);
      const target = eventTarget?.closest<TraceTarget>(
        "button,[role=button],input,select,textarea,a,[contenteditable=true],[data-problem-target]",
      );
      if (!target || target.matches("textarea,[contenteditable=true]")) return;
      if (target.dataset.problemTarget === "book-card") {
        pushShellEvent("shelf_input", {
          source: "main_window",
          phase: safeLabel(kind, "input"),
          ...inputFocusTransitionDetail(document),
        });
      }
      recordShellOperation(kind, target);
    };
    document.addEventListener("pointerdown", (event) => recordOperation(event, "pointerdown"), true);
    document.addEventListener("click", (event) => recordOperation(event, "click"), true);
    document.addEventListener("change", (event) => recordOperation(event, "change"), true);
  };

  const wireWindowFocusTransitions = (): void => {
    if (typeof runtime.addEventListener !== "function") return;
    runtime.addEventListener("focus", () => {
      lastWindowFocused = true;
      lastWindowFocusChangedAt = Date.now();
    }, true);
    runtime.addEventListener("blur", () => {
      lastWindowFocused = false;
      lastWindowFocusChangedAt = Date.now();
    }, true);
  };

  const readStartupPerformance = (storage = runtime.localStorage): Readonly<Record<string, unknown>> => {
    try {
      return summarizeStartupPerformance(
        JSON.parse(storage?.getItem("startupPerfLogV1") || "[]") as unknown,
      );
    } catch {
      return summarizeStartupPerformance([]);
    }
  };

  const collectSoftwareSettings = (
    storage = runtime.localStorage,
  ): Readonly<Record<string, unknown>> => {
    const reader = record(storageJson(storage, "readerSettings", {})) ?? {};
    const palettes = storageJson(storage, "readerCustomPalettesV1", []);
    const bookAppearance = storageJson(storage, "readerBookAppearanceV1", {});
    const animations = storageJson(storage, "readerAnimationSettingsV1", {});
    const debug = storageJson(storage, "debugSettingsV1", {});
    const experimental = storageJson(storage, "kunpeng.reader.experimental-features.v1", {});
    const gesture = storageJson(storage, "kunpeng.reader.news.back-gesture.v2", null);
    const newsSources = storageJson(storage, "kunpeng.reader.news.sources.v2", []);
    const tiebaBars = storageJson(storage, "kunpeng.reader.news.tieba-bars.v1", []);
    const gestureRecord = record(gesture);
    const settings: Record<string, unknown> = {
      language: choice(runtime.ReaderAppI18n?.selectedLanguage?.(), ["system", "zh-CN", "zh-TW", "en", "ja", "ko", "fr", "de", "es", "ru", "pt-BR"], "system"),
      shelf: {
        sort: choice(storageValue(storage, "shelfSort"), ["title", "author", "added", "dir", "read", "reading-time", "size", "progress"], "read"),
        layout: choice(storageValue(storage, "shelfLayout"), ["grid", "list"], "grid"),
        grid_columns: boundedInteger(storageValue(storage, "shelfGridColumnsValue"), 3, 1, 12),
        show_cover_progress: storageValue(storage, "showCoverProgress") !== "0",
        show_cover_rating: storageValue(storage, "showCoverRating") !== "0",
        show_cover_title: storageValue(storage, "showCoverTitle") === "1",
        single_click_opens_book: storageValue(storage, "shelfSingleClickOpen") !== "0",
        search_enabled: storageValue(storage, "shelfSearchEnabled") === "1",
      },
      reader: {
        theme: choice(reader.theme, ["light", "dark", "sepia"], "light"),
        font_family: safePreferenceText(reader.fontFamily),
        style_mode: choice(reader.styleMode, ["local", "book"], "local"),
        text_conversion: choice(reader.textConversion, ["t2s", "s2t", "none"], "t2s"),
        font_size: boundedInteger(reader.fontSize, 18, 8, 96),
        note_font_size: boundedInteger(reader.noteFontSize, 14, 8, 96),
        line_height: boundedInteger(Number(reader.lineHeight || 1.7) * 100, 170, 80, 400) / 100,
        paragraph_spacing: boundedInteger(Number(reader.paraSpacing || 0.6) * 100, 60, 0, 1000) / 100,
        letter_spacing: boundedInteger(Number(reader.letterSpacing || 0) * 100, 0, -1000, 1000) / 100,
        page_mode: choice(reader.pageMode, ["single", "double"], "single"),
        flow_mode: choice(reader.flowMode, ["paged", "scroll"], "paged"),
        page_turn_effect: choice(reader.pageTurnEffect, ["off", "horizontal"], "horizontal"),
        page_turn_speed: boundedInteger(Number(reader.pageTurnSpeed || 1) * 100, 100, 25, 300) / 100,
        tts_source: choice(reader.ttsSource, ["edge", "system", "online"], "edge"),
        tts_rate: boundedInteger(Number(reader.ttsRate || 1) * 100, 100, 25, 400) / 100,
        background_preset: choice(reader.backgroundPreset, ["light", "dark", "sepia", "custom"], "light"),
        custom_background_color: /^#[0-9a-f]{3,8}$/iu.test(String(reader.customBackgroundColor || "")) ? reader.customBackgroundColor : "",
        custom_background_image_configured: Boolean(String(reader.customBackgroundImage || "")),
        custom_palette_count: Array.isArray(palettes) ? Math.min(15, palettes.length) : 0,
        per_book_appearance_count: record(bookAppearance) ? Math.min(10000, Object.keys(record(bookAppearance)!).length) : 0,
        show_text_conversion: reader.showTextConversion !== false,
        show_toc_button: reader.showTocButton !== false,
        show_chapter_buttons: reader.showChapterButtons !== false,
        show_vocabulary_button: reader.showVocabularyButton !== false,
        show_tts_button: reader.showTtsButton !== false,
        show_annotation_button: reader.showAnnotationButton !== false,
        show_page_info: reader.showPageInfo !== false,
        show_reader_jump_back: reader.showReaderJumpBack !== false,
        jump_back_dismiss_mode: choice(reader.readerJumpBackDismissMode, ["pages", "time"], "pages"),
        jump_back_dismiss_seconds: boundedInteger(reader.readerJumpBackDismissSeconds, 30, 1, 600),
        jump_back_dismiss_pages: boundedInteger(reader.readerJumpBackDismissPages, 3, 1, 100),
        jump_back_icon_size_px: boundedInteger(reader.readerJumpBackIconSizePx, 32, 30, 160),
      },
      gestures: {
        enabled: storageValue(storage, "kunpeng.reader.news.back-gesture.enabled.v1") !== "0" && storageValue(storage, "kunpeng.reader.news.back-gesture.enabled.v1") !== "false",
        precision: boundedInteger(storageValue(storage, "kunpeng.reader.news.back-gesture.precision.v1"), 5, 1, 10),
        path_saved: Array.isArray(gestureRecord?.points ?? gesture),
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
    const startup = runtime.ReaderStartupEnhancement?.snapshot?.();
    if (startup && typeof startup === "object") {
      settings.startup_enhancement = {
        enabled: startup.enabled === true,
        continue_high_cost: startup.continueHighCost === true,
        launch_at_login: startup.launchAtLogin === true,
      };
    }
    return settings;
  };

  const mergeShellEvents = (snapshot: TraceSnapshot): Record<string, unknown> => {
    const capturedAt = Date.now();
    pruneShellEvents();
    const readerEvents = Array.isArray(snapshot.events)
      ? snapshot.events.map(eventRecord)
      : [];
    const recentShell: Record<string, unknown>[] = shellEvents.map((event) => ({
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
      events: [...readerEvents, ...recentShell].sort((left, right) =>
        String(left.at).localeCompare(String(right.at)),
      ),
    };
  };

  // A delayed checkpoint makes a just-reproduced navigation trace available to
  // native diagnostics even when the user cannot immediately use the feedback UI.
  // It contains only the same redacted allowlist produced by mergeShellEvents.
  const scheduleShellCheckpoint = (): void => {
    if (!api || checkpointTimer !== null) return;
    checkpointTimer = runtime.setTimeout(() => {
      checkpointTimer = null;
      const snapshot = mergeShellEvents(recentReaderSnapshot() ?? shellOnlySnapshot());
      void api.invoke("problem_trace_checkpoint", { snapshot }).catch(() => undefined);
    }, 300);
  };

  const rememberReaderSnapshot = (snapshot: unknown): boolean => {
    const value = record(snapshot);
    if (!value) return false;
    const capturedAt = Date.parse(String(value.captured_at || ""));
    if (!Number.isFinite(capturedAt)) return false;
    latestReaderSnapshot = value;
    return true;
  };

  const recentReaderSnapshot = (now = Date.now()): TraceSnapshot | null => {
    if (!latestReaderSnapshot) return null;
    const capturedAt = Date.parse(String(latestReaderSnapshot.captured_at || ""));
    const age = Number(now) - capturedAt;
    return Number.isFinite(age) && age >= -5000 && age <= WINDOW_MS
      ? latestReaderSnapshot
      : null;
  };

  const shellOnlySnapshot = (now = Date.now()): TraceSnapshot => ({
    schema_version: 1,
    captured_at: new Date(now).toISOString(),
    window_ms: WINDOW_MS,
    privacy: "No book text, selection text, URLs, file paths, account data, API credentials, or form values.",
    version: "",
    system: {
      platform: String(runtime.navigator?.platform || "").slice(0, 80),
      language: String(runtime.navigator?.language || "").slice(0, 32),
    },
    book: { title: "", format: "unknown" },
    reader_state: {
      chapter: 0,
      progress: 0,
      chapter_frac: 0,
      total_chapters: 0,
      overlay: "none",
      toolbar: "normal",
      frame_ready: false,
      loading: false,
      is_pdf: false,
      immersive: false,
      viewport: {
        width: Number(runtime.innerWidth) || 0,
        height: Number(runtime.innerHeight) || 0,
      },
    },
    last_click_blocker: "none",
    runtime_diagnostics: null,
    events: [],
  });

  const restoreShelfDocumentFocus = (
    payload: unknown,
    document = runtime.document,
  ): void => {
    const value = eventRecord(payload);
    if (
      value.phase !== "focus_restore" ||
      !["focused", "requested", "focused_after_retry"].includes(String(value.outcome))
    ) {
      return;
    }
    const startedAt = Date.now();
    pushShellEvent("focus_handoff", {
      source: "main_window",
      phase: "native_result",
      outcome: safeLabel(value.outcome, "unknown"),
      duration_ms: 0,
      ...focusDetail(document),
    });
    try { runtime.focus?.(); } catch { /* Best effort. */ }
    let attempts = 0;
    const verifyFocus = (): void => {
      try { runtime.focus?.(); } catch { /* Best effort. */ }
      try { document?.querySelector<HTMLElement>(".content")?.focus({ preventScroll: true }); } catch { /* Best effort. */ }
      attempts += 1;
      if (!document?.hasFocus() && attempts < 6) {
        runtime.setTimeout(verifyFocus, 20);
        return;
      }
      pushShellEvent("focus_handoff", {
        source: "main_window",
        phase: "document_verified",
        outcome: document?.hasFocus() ? "focused" : "not_focused",
        duration_ms: Math.max(0, Math.min(30_000, Date.now() - startedAt)),
        attempts,
        ...focusDetail(document),
      });
      scheduleShellCheckpoint();
    };
    if (runtime.requestAnimationFrame) runtime.requestAnimationFrame(verifyFocus);
    else runtime.setTimeout(verifyFocus, 0);
  };

  const wireReaderCheckpoints = (eventApi = defaultEventApi): void => {
    if (!eventApi) return;
    void eventApi
      .listen<{ readonly snapshot?: unknown }>("reader-bug-trace-checkpoint", (event) => {
        if (rememberReaderSnapshot(event.payload?.snapshot)) scheduleShellCheckpoint();
      })
      .catch(() => undefined);
  };

  const wireReaderWindowLifecycle = (eventApi = defaultEventApi): void => {
    if (!eventApi) return;
    void eventApi
      .listen<Record<string, unknown>>("main-window-close-trace", (event) => {
        const payload = event.payload ?? {};
        pushShellEvent("window_control_native", {
          source: "window_backend",
          control: "close",
          phase: safeLabel(payload.phase),
          outcome: safeLabel(payload.outcome),
        });
        scheduleShellCheckpoint();
      })
      .catch(() => undefined);
    void eventApi
      .listen<Record<string, unknown>>("reader-window-trace", (event) => {
        const payload = event.payload ?? {};
        restoreShelfDocumentFocus(payload);
        const detail: Record<string, unknown> = {
          source: "window_backend",
          phase: safeLabel(payload.phase),
          outcome: safeLabel(payload.outcome),
          duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
        };
        const source = safeLabel(payload.source, "window_backend");
        if (source !== "window_backend") detail.open_source = source;
        const geometry = geometryDetail(payload.geometry);
        if (geometry) detail.geometry = geometry;
        const requested = geometryDetail(payload.requested);
        if (requested) detail.requested = requested;
        const restore = geometryRestoreDetail(payload.restore);
        if (restore) detail.restore = restore;
        const resumeNumbers = readerResumeNumericDetail(payload);
        if (Object.keys(resumeNumbers).length) detail.resume_state = resumeNumbers;
        if ("documentFocused" in payload || "document_focused" in payload) {
          detail.document_focused = (payload.documentFocused ?? payload.document_focused) === true;
        }
        if ("activeElement" in payload || "active_element" in payload) {
          detail.active_element = activeElementLabel(payload.activeElement ?? payload.active_element);
        }
        const focusBooleans = [
          ["window_requested", payload.windowRequested ?? payload.window_requested],
          ["window_focused", payload.windowFocused ?? payload.window_focused],
          ["native_focused", payload.nativeFocused ?? payload.native_focused],
          ["webview_requested", payload.webviewRequested ?? payload.webview_requested],
          ["webview_focused", payload.webviewFocused ?? payload.webview_focused],
          ["visible", payload.visible],
        ] as const;
        focusBooleans.forEach(([key, value]) => {
          if (typeof value === "boolean") detail[key] = value;
        });
        if (Number.isFinite(Number(payload.attempt))) {
          detail.attempt = boundedInteger(payload.attempt, 0, 0, 32);
        }
        pushShellEvent("reader_window", detail);
        scheduleShellCheckpoint();
      })
      .catch(() => undefined);
    void eventApi
      .listen<Record<string, unknown>>("reader-performance-trace", (event) => {
        const payload = event.payload ?? {};
        pushShellEvent("reader_performance", {
          source: "reader_shell",
          stage: safeLabel(payload.stage),
          duration_ms: Math.max(0, Math.min(30000, Number(payload.durationMs) || 0)),
        });
      })
      .catch(() => undefined);
  };

  const loadNativeCheckpoint = async (): Promise<TraceSnapshot | null> => {
    if (!api) return recentReaderSnapshot();
    try {
      const snapshot = await api.invoke("problem_trace_checkpoint", { snapshot: null });
      if (snapshot) rememberReaderSnapshot(snapshot);
    } catch {
      // A missing native checkpoint falls back to the bounded in-memory snapshot.
    }
    return recentReaderSnapshot();
  };

  const capture = async (options: ProblemTraceCaptureOptions = {}): Promise<Record<string, unknown>> => {
    await loadNativeCheckpoint();
    const eventApi = options.eventApi ?? defaultEventApi;
    if (!eventApi) return mergeShellEvents(recentReaderSnapshot() ?? shellOnlySnapshot());
    const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const fallbackWaitMs = recentReaderSnapshot() ? 500 : 2500;
    const waitMs = Math.max(
      10,
      Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : fallbackWaitMs,
    );
    return new Promise((resolve) => {
      let settled = false;
      let unlisten: TauriUnlisten | null = null;
      let retryTimer: number | null = null;
      let timer = 0;
      const finish = (snapshot: TraceSnapshot): void => {
        if (settled) return;
        settled = true;
        runtime.clearTimeout(timer);
        runtime.clearTimeout(retryTimer);
        try { unlisten?.(); } catch { /* Best effort. */ }
        resolve(mergeShellEvents(snapshot));
      };
      timer = runtime.setTimeout(() => {
        finish(recentReaderSnapshot() ?? shellOnlySnapshot());
      }, waitMs);
      void (async () => {
        try {
          unlisten = await eventApi.listen<{
            readonly request_id?: unknown;
            readonly snapshot?: unknown;
          }>("reader-bug-trace-response", (event) => {
            const payload = event.payload ?? {};
            const snapshot = record(payload.snapshot);
            if (payload.request_id !== requestId || !snapshot) return;
            rememberReaderSnapshot(snapshot);
            finish(snapshot);
          });
          const request = (): Promise<void> =>
            eventApi.emit("reader-bug-trace-request", { request_id: requestId });
          await request();
          retryTimer = runtime.setTimeout(() => {
            if (!settled) void request().catch(() => undefined);
          }, Math.max(5, Math.min(250, waitMs / 3)));
        } catch {
          finish(recentReaderSnapshot() ?? shellOnlySnapshot());
        }
      })();
    });
  };

  wireWindowFocusTransitions();
  wireShellOperations();
  wireReaderCheckpoints();
  wireReaderWindowLifecycle();
  void loadNativeCheckpoint();

  return Object.freeze({
    WINDOW_MS,
    MAX_SHELL_EVENTS,
    capture,
    recordShelfBookOpen,
    recordNewsArticleTiming,
    recordIntelligenceAuditTiming,
    recordWindowControl,
    recordGesture,
    _rememberReaderSnapshotForTests: rememberReaderSnapshot,
    _recentReaderSnapshotForTests: recentReaderSnapshot,
    _shellEventsForTests: () =>
      shellEvents.map((event) => ({ ...event, detail: { ...event.detail } })),
    _summarizeStartupPerformanceForTests: summarizeStartupPerformance,
    _collectSoftwareSettingsForTests: collectSoftwareSettings,
  });
}

export function installProblemTraceUi(
  target: Record<string, unknown>,
  transport: TauriTransport | undefined = optionalTransport(target),
): ProblemTraceUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = initializeProblemTraceUi(runtime, transport);
  target.ReaderProblemTraceUI = api;
  return api;
}
