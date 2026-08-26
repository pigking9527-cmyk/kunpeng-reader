import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";

export const READER_BUG_TRACE_WINDOW_MS = 2 * 60 * 1_000;

const SAFE_EVENT_KEYS = new Set([
  "source", "outcome", "zone", "target", "direction", "key", "overlay",
  "gesture_id", "phase", "action", "score", "threshold", "points", "tail_points", "fallback", "cancelled", "can_apply", "route", "handled", "profile_count",
  "direct_action", "direct_score", "direct_threshold", "preview_action", "preview_score", "preview_threshold", "history_count", "history_kind",
  "chapter", "page", "progress", "chapter_frac", "anchor_offset", "sequence", "total_chapters", "x_pct",
  "y_pct", "duration_ms", "format", "reason", "open", "ready", "is_pdf",
  "document_focused", "active_element", "viewport_width", "viewport_height", "layout_width", "layout_height",
  "before_anchor_offset", "after_anchor_offset", "resize_sequence", "restore_pending", "save_suppressed",
  "frame_ready", "immersive", "loading", "pages", "turn_id", "input",
  "window_role", "window_visible", "document_visible", "book_bound", "book_info_loaded", "inner_engine_ready", "failure_category",
  "before_chapter", "before_page", "after_chapter", "after_page",
  "chapter_pending", "chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "flow_mode", "page_mode",
  "wheel_seq", "wheel_delta_x", "wheel_delta_y", "wheel_delta_px", "wheel_delta_mode", "wheel_gap_ms", "wheel_accumulated_px", "wheel_threshold_px", "wheel_quiet_ms", "wheel_gesture_age_ms", "wheel_gesture_active", "wheel_timer_active", "wheel_event_cancelable", "wheel_replay", "wheel_mode_pending",
  "image_mode", "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
  "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text", "image_near_top", "image_text_before", "image_probed",
  "note_marker", "note_virtual", "note_link_present", "note_fragment_present", "note_click_consumed", "note_popup_visible", "note_target_chapter", "note_search_chapters",
  "layout_fast", "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
  "scroll_top", "scroll_view_height", "scroll_content_height", "scroll_item_count", "scroll_slice_start", "scroll_slice_end", "scroll_slice_next", "scroll_slice_top", "scroll_slice_bottom", "scroll_mask_top", "scroll_mask_blank", "scroll_clip_active",
  "scroll_tail_bottom", "scroll_tail_overflow", "scroll_next_top", "scroll_next_bottom", "scroll_next_overflow", "scroll_page_tolerance", "scroll_page_guard", "scroll_break_count", "scroll_break_last",
  "preview_created", "preview_connected", "preview_parent", "preview_position", "preview_z_index", "preview_display", "preview_visibility", "preview_width", "preview_height", "preview_top", "preview_left", "preview_type", "preview_phase",
  "modal_position", "modal_z_index", "modal_display", "modal_parent", "modal_contains_preview",
]);

const BLOCKERS = new Set(["selection", "drag", "link", "overlay", "chapter_pending", "turn_busy"]);
const ACTIVE_ELEMENT_CATEGORIES = new Set([
  "none", "document", "other", "book_card", "shelf_content", "control",
  "reader_frame", "reader_shell", "titlebar",
]);

type TraceDetail = Record<string, boolean | number | string>;

interface TraceEvent {
  readonly at_ms: number;
  readonly type: string;
  readonly detail: TraceDetail;
}

interface RecentTraceEvent {
  readonly at: string;
  readonly age_ms: number;
  readonly type: string;
  readonly detail: TraceDetail;
}

interface ReaderTraceSnapshot {
  readonly schema_version: 1;
  readonly captured_at: string;
  readonly window_ms: number;
  readonly operation_anchor_at: string;
  readonly operation_anchor_type: string;
  readonly privacy: string;
  readonly version: string;
  readonly system: Readonly<Record<string, unknown>>;
  readonly book: Readonly<Record<string, unknown>>;
  readonly reader_state: Readonly<Record<string, unknown>>;
  readonly last_click_blocker: string;
  readonly runtime_diagnostics: unknown;
  readonly events: readonly RecentTraceEvent[];
}

// Only actual user intent advances the diagnostic window.  Periodic captures,
// progress saves and asynchronous layout work must not make an older action
// disappear merely because the reader was left open for observation.
const USER_OPERATION_TYPES = new Set([
  "shell_click", "shell_key", "page_click", "page_key", "page_turn",
  "gesture", "gesture_start", "gesture_execute", "gesture_finish",
  "reader_settings_dispatch", "book_opened", "window_drag",
]);

interface TraceI18n {
  readonly t?: (key: string, values?: Readonly<Record<string, unknown>>) => string;
}

interface TraceRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly navigator?: {
    readonly userAgent?: unknown;
    readonly platform?: unknown;
    readonly language?: unknown;
    readonly clipboard?: { readonly writeText: (text: string) => Promise<void> };
  };
  readonly screen?: { readonly width?: unknown; readonly height?: unknown };
  readonly devicePixelRatio?: number;
  readonly ReaderI18n?: TraceI18n;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  readonly addEventListener?: Window["addEventListener"];
}

export interface ReaderBugTraceApi {
  readonly WINDOW_MS: number;
  readonly record: (type: unknown, detail?: unknown) => void;
  readonly ingestPageEvent: (payload: unknown) => void;
  readonly capture: (source?: string) => Promise<ReaderTraceSnapshot>;
  readonly checkpoint: (delayMs?: unknown) => void;
  readonly reset: () => void;
  readonly setContextProvider: (provider: unknown) => void;
  readonly _snapshotForTests: (now?: unknown) => readonly TraceEvent[];
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function createReaderBugTrace(
  root: TraceRuntime,
  transport: TauriTransport | null,
): ReaderBugTraceApi {
  const events: TraceEvent[] = [];
  let contextProvider: () => unknown = () => ({});
  let frozenSnapshot: ReaderTraceSnapshot | null = null;
  let checkpointTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let checkpointInFlight = false;
  let checkpointPending = false;
  let closingCheckpointRequested = false;
  let cachedVersion = "";
  let cachedRuntimeDiagnostics: unknown = null;
  let operationAnchorAt = Date.now();
  let operationAnchorType = "reader_open";

  function traceText(key: string, fallback: string, values?: Readonly<Record<string, unknown>>): string {
    const value = root.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  }

  function safeLabel(value: unknown, fallback?: string): string {
    const label = String(value || "").trim();
    return /^[a-z0-9_.:-]{1,64}$/i.test(label) ? label : fallback || "other";
  }

  function safeNumber(value: unknown, min: number, max: number): number | undefined {
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return Math.max(min, Math.min(max, Math.round(number * 1_000) / 1_000));
  }

  function cleanEventDetail(value: unknown): TraceDetail {
    const result: TraceDetail = {};
    const source = recordValue(value);
    Object.keys(source).forEach((key) => {
      if (!SAFE_EVENT_KEYS.has(key)) return;
      const item = source[key];
      if (typeof item === "boolean") result[key] = item;
      else if (typeof item === "number") {
        const number = key === "anchor_offset"
          ? safeNumber(item, 0, 1_000_000_000)
          : safeNumber(item, -1_000_000, 1_000_000);
        if (number !== undefined) result[key] = number;
      } else if (typeof item === "string") {
        result[key] = key === "active_element"
          ? ACTIVE_ELEMENT_CATEGORIES.has(item) ? item : "other"
          : safeLabel(item);
      }
    });
    return result;
  }

  function prune(anchorAt = operationAnchorAt): void {
    // Keep the bounded context leading into the most recent user action.  Idle
    // checkpoint traffic must not erase the action that a diagnostic captures.
    const cutoff = anchorAt - READER_BUG_TRACE_WINDOW_MS;
    while (events.length && (events[0]?.at_ms ?? operationAnchorAt) < cutoff) events.shift();
  }

  function record(type: unknown, detail?: unknown): void {
    const now = Date.now();
    const cleanType = safeLabel(type);
    const isUserOperation = USER_OPERATION_TYPES.has(cleanType);
    if (isUserOperation) {
      operationAnchorAt = now;
      operationAnchorType = cleanType;
    }
    prune();
    // Once the reaction window has elapsed, checkpoint traffic must not keep
    // extending it.  The next user operation moves the anchor and starts a new
    // two-minute diagnostic window with its own preceding history.
    if (!isUserOperation && now > operationAnchorAt + READER_BUG_TRACE_WINDOW_MS) return;
    events.push({ at_ms: now, type: cleanType, detail: cleanEventDetail(detail) });
    prune();
    if (cleanType !== "capture") checkpoint();
  }

  function cleanBook(value: unknown): Readonly<Record<string, unknown>> {
    const book = recordValue(value);
    return {
      title: String(book.title || "").slice(0, 200),
      format: safeLabel(book.format || "unknown"),
    };
  }

  function cleanReaderState(value: unknown): Readonly<Record<string, unknown>> {
    const state = recordValue(value);
    const viewport = recordValue(state.viewport);
    return {
      chapter: safeNumber(state.chapter, 0, 1_000_000) || 0,
      progress: safeNumber(state.progress, 0, 100) || 0,
      chapter_frac: safeNumber(state.chapter_frac, 0, 1) || 0,
      total_chapters: safeNumber(state.total_chapters, 1, 1_000_000) || 1,
      overlay: safeLabel(state.overlay || "none"),
      toolbar: safeLabel(state.toolbar || "normal"),
      frame_ready: Boolean(state.frame_ready),
      loading: Boolean(state.loading),
      is_pdf: Boolean(state.is_pdf),
      immersive: Boolean(state.immersive),
      window_role: safeLabel(state.window_role || "reader"),
      window_visible: typeof state.window_visible === "boolean" ? state.window_visible : null,
      document_visible: Boolean(state.document_visible),
      book_bound: Boolean(state.book_bound),
      book_info_loaded: Boolean(state.book_info_loaded),
      inner_engine_ready: Boolean(state.inner_engine_ready),
      startup_phase: safeLabel(state.startup_phase || "idle"),
      startup_failure_category: safeLabel(state.startup_failure_category || "none"),
      viewport: {
        width: safeNumber(viewport.width, 0, 100_000) || 0,
        height: safeNumber(viewport.height, 0, 100_000) || 0,
      },
    };
  }

  function systemSnapshot(): Readonly<Record<string, unknown>> {
    const navigator = root.navigator;
    const screen = root.screen;
    return {
      user_agent: String(navigator?.userAgent || "").slice(0, 512),
      platform: String(navigator?.platform || "").slice(0, 80),
      language: String(navigator?.language || "").slice(0, 32),
      screen: {
        width: safeNumber(screen?.width, 0, 100_000) || 0,
        height: safeNumber(screen?.height, 0, 100_000) || 0,
        pixel_ratio: safeNumber(root.devicePixelRatio, 0, 16) || 1,
      },
    };
  }

  function lastBlocker(recent: readonly RecentTraceEvent[]): string {
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      const outcome = recent[index]?.detail.outcome;
      if (typeof outcome === "string" && BLOCKERS.has(outcome)) return outcome;
    }
    return "none";
  }

  async function capture(source = "manual"): Promise<ReaderTraceSnapshot> {
    record("capture", { source: safeLabel(source, "manual") });
    const capturedAt = Date.now();
    prune();
    let context: Record<string, unknown> = {};
    try { context = recordValue(contextProvider()); } catch { context = {}; }
    let version = cachedVersion;
    let runtimeDiagnostics = cachedRuntimeDiagnostics;
    const refreshRuntime = source !== "checkpoint" || (!cachedVersion && cachedRuntimeDiagnostics === null);
    if (transport && refreshRuntime) {
      try { version = cachedVersion = String(await transport.invoke<unknown>("app_version")); } catch { /* optional */ }
      try {
        runtimeDiagnostics = cachedRuntimeDiagnostics = await transport.invoke<unknown>("runtime_diagnostics");
      } catch {
        runtimeDiagnostics = cachedRuntimeDiagnostics = { unavailable: true };
      }
    }
    const recent = events.map((event) => ({
      at: new Date(event.at_ms).toISOString(),
      age_ms: capturedAt - event.at_ms,
      type: event.type,
      detail: event.detail,
    }));
    frozenSnapshot = {
      schema_version: 1,
      captured_at: new Date(capturedAt).toISOString(),
      window_ms: READER_BUG_TRACE_WINDOW_MS,
      operation_anchor_at: new Date(operationAnchorAt).toISOString(),
      operation_anchor_type: operationAnchorType,
      privacy: "No book text, selection text, URLs, file paths, account data, or API credentials.",
      version,
      system: systemSnapshot(),
      book: cleanBook(context.book),
      reader_state: cleanReaderState(context.state),
      last_click_blocker: lastBlocker(recent),
      runtime_diagnostics: runtimeDiagnostics,
      events: recent,
    };
    return frozenSnapshot;
  }

  function checkpoint(delayMs: unknown = 350): void {
    if ((!transport?.emit && !transport) || typeof root.setTimeout !== "function") return;
    if (checkpointTimer !== null) root.clearTimeout?.(checkpointTimer);
    checkpointTimer = root.setTimeout(async () => {
      checkpointTimer = null;
      if (checkpointInFlight) {
        checkpointPending = true;
        return;
      }
      checkpointInFlight = true;
      try {
        const snapshot = await capture("checkpoint");
        const writes: Promise<unknown>[] = [];
        if (transport?.emit) writes.push(transport.emit("reader-bug-trace-checkpoint", { snapshot }));
        if (transport) writes.push(transport.invoke("problem_trace_checkpoint", { snapshot }));
        await Promise.allSettled(writes);
      } catch {
        // Diagnostics must not affect reading.
      } finally {
        checkpointInFlight = false;
        if (checkpointPending) {
          checkpointPending = false;
          checkpoint(100);
        }
      }
    }, Math.max(0, Number(delayMs) || 0));
  }

  function ingestPageEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const recordPayload = recordValue(payload);
    record(`page_${safeLabel(recordPayload.kind)}`, recordPayload);
  }

  function reset(): void {
    events.length = 0;
    frozenSnapshot = null;
    operationAnchorAt = Date.now();
    operationAnchorType = "trace_reset";
    record("trace_started", { source: "manual" });
  }

  function setContextProvider(provider: unknown): void {
    if (typeof provider === "function") contextProvider = provider as () => unknown;
  }

  function snapshotForTests(now?: unknown): readonly TraceEvent[] {
    prune(typeof now === "number" && Number.isFinite(now) ? now : operationAnchorAt);
    return events.map((event) => ({ ...event, detail: { ...event.detail } }));
  }

  function wireUi(): void {
    const candidateDocument = root.document;
    if (!candidateDocument) return;
    const document: Document = candidateDocument;
    const modal = document.getElementById("bug-trace-modal");
    const openButton = document.getElementById("bug-trace-btn");
    const closeButton = document.getElementById("bug-trace-close");
    const metaElement = document.getElementById("bug-trace-meta") as HTMLElement;
    const eventListElement = document.getElementById("bug-trace-events") as HTMLElement;
    const statusElement = document.getElementById("bug-trace-status") as HTMLElement;

    function appendMeta(label: string, value: unknown): void {
      const row = document.createElement("div");
      row.className = "bug-trace-meta-row";
      const key = document.createElement("span");
      key.textContent = label;
      const content = document.createElement("strong");
      content.textContent = String(value ?? "");
      row.append(key, content);
      metaElement.appendChild(row);
    }

    function render(snapshot: ReaderTraceSnapshot): void {
      metaElement.innerHTML = "";
      eventListElement.innerHTML = "";
      const system = recordValue(snapshot.system);
      const book = recordValue(snapshot.book);
      const state = recordValue(snapshot.reader_state);
      appendMeta(traceText("traceVersionSystem", "版本 / 系统"), `v${String(snapshot.version || "?")} · ${String(system.platform || "unknown")}`);
      appendMeta(traceText("traceOpenBook", "打开图书"), book.title || traceText("traceUnavailable", "未获取"));
      appendMeta(traceText("tracePosition", "位置"), traceText("tracePositionValue", "第 {chapter} 章 · {progress}%", { chapter: Number(state.chapter) + 1, progress: Number(state.progress).toFixed(1) }));
      appendMeta(traceText("traceOverlay", "当前浮层"), state.overlay);
      appendMeta(traceText("traceBlocker", "最近一次点击拦截"), snapshot.last_click_blocker === "none" ? traceText("traceNone", "未发现") : snapshot.last_click_blocker);
      snapshot.events.slice().reverse().forEach((event) => {
        const row = document.createElement("div");
        row.className = "bug-trace-event";
        const time = document.createElement("time");
        time.textContent = `-${Math.round(event.age_ms / 100) / 10}s`;
        const name = document.createElement("strong");
        name.textContent = event.type;
        const detail = document.createElement("code");
        detail.textContent = JSON.stringify(event.detail);
        row.append(time, name, detail);
        eventListElement.appendChild(row);
      });
      statusElement.textContent = traceText("traceFrozen", "已按最后一次操作冻结两分钟诊断窗口，共 {count} 条；不含正文、选中文字、链接和文件路径。", { count: snapshot.events.length });
    }

    async function open(): Promise<void> {
      if (!modal) return;
      document.getElementById("settings")?.classList.remove("show");
      modal.classList.add("show");
      statusElement.textContent = traceText("traceFreezing", "正在冻结最近一分钟状态…");
      render(await capture());
    }

    const ensureSnapshot = async (): Promise<ReaderTraceSnapshot> => frozenSnapshot || capture();
    openButton?.addEventListener("click", () => { void open(); });
    closeButton?.addEventListener("click", () => modal?.classList.remove("show"));
    modal?.addEventListener("click", (event) => { if (event.target === modal) modal.classList.remove("show"); });
    document.getElementById("bug-trace-export")?.addEventListener("click", () => {
      void ensureSnapshot().then((snapshot) => {
        const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `kunpeng-reader-bug-state-${snapshot.captured_at.replace(/[:.]/g, "-")}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        statusElement.textContent = traceText("traceExported", "问题记录 JSON 已导出。");
      });
    });
    document.getElementById("bug-trace-copy")?.addEventListener("click", () => {
      void ensureSnapshot().then(async (snapshot) => {
        try {
          const clipboard = root.navigator?.clipboard;
          if (!clipboard) throw new Error("Clipboard unavailable.");
          await clipboard.writeText(JSON.stringify(snapshot, null, 2));
          statusElement.textContent = traceText("traceCopied", "问题记录已复制。");
        } catch {
          statusElement.textContent = traceText("traceCopyFailed", "复制失败，请使用“导出 JSON”。");
        }
      });
    });
    document.getElementById("bug-trace-reset")?.addEventListener("click", () => {
      reset(); metaElement.innerHTML = ""; eventListElement.innerHTML = "";
      statusElement.textContent = traceText("traceReset", "已清空，重新记录接下来一分钟。");
    });
    root.addEventListener?.("reader-language-changed", () => {
      if (frozenSnapshot && modal?.classList.contains("show")) render(frozenSnapshot);
    });
    document.addEventListener("click", (event) => {
      const target = event.target instanceof Element
        ? event.target.closest("button,[role=button],input,select,textarea,a")
        : null;
      if (!target) return;
      record("shell_click", { source: "reader_shell", target: target.id || target.tagName.toLowerCase() || "control" });
    }, true);
    root.addEventListener?.("error", (event: Event) => {
      const error = "error" in event ? (event as ErrorEvent).error as { readonly name?: unknown } | null : null;
      record("window_error", { reason: error?.name || "error" });
    });
    root.addEventListener?.("unhandledrejection", (event: Event) => {
      const reason = "reason" in event ? (event as PromiseRejectionEvent).reason as { readonly name?: unknown } | null : null;
      record("unhandled_rejection", { reason: reason?.name || "error" });
    });
  }

  record("trace_started", { source: "reader_open" });
  const checkpointBeforeClose = (): void => {
    if (closingCheckpointRequested) return;
    closingCheckpointRequested = true;
    record("reader_closing", { source: "reader_shell" });
    checkpoint(0);
  };
  root.addEventListener?.("pagehide", checkpointBeforeClose);
  root.addEventListener?.("beforeunload", checkpointBeforeClose);
  if (root.document) {
    if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", wireUi);
    else wireUi();
  }
  return Object.freeze({
    WINDOW_MS: READER_BUG_TRACE_WINDOW_MS,
    record,
    ingestPageEvent,
    capture,
    checkpoint,
    reset,
    setContextProvider,
    _snapshotForTests: snapshotForTests,
  });
}

export function installReaderBugTrace(
  target: TraceRuntime,
  transport?: TauriTransport | null,
): ReaderBugTraceApi {
  let resolvedTransport = transport ?? null;
  if (transport === undefined) {
    try { resolvedTransport = transportFromTauriGlobal(target); } catch { resolvedTransport = null; }
  }
  const api = createReaderBugTrace(target, resolvedTransport);
  target.ReaderBugTrace = api;
  const commonJsModule = (target as TraceRuntime & {
    readonly module?: { exports?: unknown };
  }).module;
  if (commonJsModule && typeof commonJsModule === "object") {
    commonJsModule.exports = api;
  }
  return api;
}
