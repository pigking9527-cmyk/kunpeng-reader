// 正文 WebView 的脱敏问题轨迹。该模块只采集交互与分页几何，
// 不读取、保存或发送正文文字。

type TraceData = Record<string, unknown>;

interface ReaderPageSettings {
  readonly flowMode?: unknown;
  readonly pageMode?: unknown;
}

interface ReaderPageTailStats {
  readonly cross?: unknown;
  readonly fit?: unknown;
  readonly tightened?: unknown;
}

interface ReaderPageRoot extends HTMLElement {
  readonly __rrPageTailTightStats?: ReaderPageTailStats;
}

interface ReaderTraceTarget {
  readonly tagName?: unknown;
  readonly closest?: (selector: string) => ReaderTraceTarget | null;
  readonly getAttribute?: (name: string) => string | null;
}

export interface ReaderPageTraceEvent {
  readonly clientX?: number;
  readonly clientY?: number;
  readonly target?: ReaderTraceTarget | null;
}

export interface ReaderPageTurnToken {
  readonly id: number;
  readonly direction: unknown;
  readonly chapter: unknown;
  readonly page: unknown;
  readonly input: unknown;
  readonly detail: TraceData | null;
}

export interface ReaderChapterTraceToken {
  readonly chapter: unknown;
  readonly started: number;
}

export interface ReaderPageBugTraceRuntime extends Record<string, unknown> {
  root?: ReaderPageRoot | null;
  pager?: HTMLElement | null;
  S?: ReaderPageSettings | null;
  curCh?: unknown;
  pageInCh?: unknown;
  pagesInCh?: unknown;
  fastChapterLayout?: unknown;
  scrollPagedView?: unknown;
  chapterTurnPending?: unknown;
  turnFxTimer?: unknown;
  pageLayout?: (() => unknown) | null;
  chapterPending?: number;
  pageTurnTraceSequence?: number;
  pageTurnTraceInput?: unknown;
  pageTurnTraceDetail?: TraceData | null;
  window: { readonly innerWidth: number; readonly innerHeight: number };
  document: Document;
  NodeFilter: { readonly SHOW_TEXT: number };
  getComputedStyle: (element: Element) => CSSStyleDeclaration;
  performance: { now(): number };
  parent: { postMessage(message: unknown, targetOrigin: "*"): void };
  pagedLayoutSnapshot?: () => TraceData | null;
  readerBugTrace?: (
    kind: unknown,
    outcome: unknown,
    event?: ReaderPageTraceEvent | null,
    extra?: unknown,
  ) => void;
  markPageTurnInput?: (input: unknown, detail?: unknown) => void;
  pageTurnTraceData?: (token: ReaderPageTurnToken, extra?: TraceData | null) => TraceData;
  beginPageTurnBugTrace?: (direction: unknown) => ReaderPageTurnToken;
  finishPageTurnBugTrace?: (token?: ReaderPageTurnToken | null) => void;
  beginChapterBugTrace?: (chapter: unknown, where: unknown) => ReaderChapterTraceToken;
  finishChapterBugTrace?: (
    token: ReaderChapterTraceToken,
    ready: unknown,
    page: unknown,
  ) => void;
}

export interface ReaderPageBugTraceApi {
  readonly pagedLayoutSnapshot: () => TraceData | null;
  readonly readerBugTrace: NonNullable<ReaderPageBugTraceRuntime["readerBugTrace"]>;
  readonly markPageTurnInput: NonNullable<ReaderPageBugTraceRuntime["markPageTurnInput"]>;
  readonly pageTurnTraceData: NonNullable<ReaderPageBugTraceRuntime["pageTurnTraceData"]>;
  readonly beginPageTurnBugTrace: NonNullable<ReaderPageBugTraceRuntime["beginPageTurnBugTrace"]>;
  readonly finishPageTurnBugTrace: NonNullable<ReaderPageBugTraceRuntime["finishPageTurnBugTrace"]>;
  readonly beginChapterBugTrace: NonNullable<ReaderPageBugTraceRuntime["beginChapterBugTrace"]>;
  readonly finishChapterBugTrace: NonNullable<ReaderPageBugTraceRuntime["finishChapterBugTrace"]>;
}

const copiedExtraKeys = Object.freeze([
  "direction", "key", "duration_ms", "chapter", "page", "pages", "turn_id", "input",
  "before_chapter", "before_page", "after_chapter", "after_page",
  "wheel_seq", "wheel_delta_x", "wheel_delta_y", "wheel_delta_px", "wheel_delta_mode",
  "wheel_gap_ms", "wheel_accumulated_px", "wheel_threshold_px", "wheel_quiet_ms",
  "wheel_gesture_age_ms", "wheel_gesture_active", "wheel_timer_active",
  "wheel_event_cancelable", "wheel_replay", "wheel_mode_pending",
  "image_mode", "image_source_page", "image_candidate_page", "image_top", "image_width",
  "image_height", "image_free_height", "image_preview_height", "image_next_count",
  "image_future_count", "image_skipped_text", "image_near_top", "image_text_before",
  "image_probed",
  "note_marker", "note_virtual", "note_link_present", "note_fragment_present",
  "note_click_consumed", "note_popup_visible", "note_target_chapter", "note_search_chapters",
  "mac_clip_native_notes", "mac_clip_page_inline_notes", "mac_clip_view_height", "mac_clip_scroll_top",
  "mac_clip_measured_blank", "mac_clip_virtual_blank", "mac_clip_partial_blank",
  "mac_clip_applied_blank", "mac_clip_has_extra_virtual", "mac_clip_path_active",
  "media_count", "media_background_count", "media_table_count", "media_positioned_count",
  "media_visible_count", "media_text_overlap_count", "media_background_text_overlap_count",
] as const);

function record(value: unknown): TraceData | null {
  return value !== null && typeof value === "object"
    ? value as TraceData
    : null;
}

function numberOrZero(value: unknown): number {
  return Number(value) || 0;
}

export function installReaderPageBugTrace(
  global: ReaderPageBugTraceRuntime,
): ReaderPageBugTraceApi {
  global.chapterPending = 0;
  global.pageTurnTraceSequence = 0;
  global.pageTurnTraceInput = "unknown";
  global.pageTurnTraceDetail = null;

  function pagedLayoutSnapshot(): TraceData | null {
    const root = global.root;
    const pager = global.pager;
    if (!root || !pager || global.S?.flowMode === "scroll") return null;
    try {
      const pagerRect = pager.getBoundingClientRect();
      const rootRect = root.getBoundingClientRect();
      const layout = record(typeof global.pageLayout === "function" ? global.pageLayout() : null);
      const step = Math.max(1, numberOrZero(layout?.pageStep) || global.window.innerWidth || 1);
      const current: Record<string, { top: number; bottom: number; height: number }> = {};
      const following: Record<string, { top: number; bottom: number; height: number }> = {};
      const walker = global.document.createTreeWalker(root, global.NodeFilter.SHOW_TEXT, null);
      const range = global.document.createRange();

      function addLine(
        bucket: Record<string, { top: number; bottom: number; height: number }>,
        rect: DOMRect,
      ): void {
        const key = `${Math.round(rect.top)}:${Math.round(rect.bottom)}`;
        const old = bucket[key];
        if (!old) bucket[key] = { top: rect.top, bottom: rect.bottom, height: rect.height };
        else {
          old.top = Math.min(old.top, rect.top);
          old.bottom = Math.max(old.bottom, rect.bottom);
          old.height = Math.max(old.height, rect.height);
        }
      }

      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!(node.nodeValue || "").trim()) continue;
        try {
          range.selectNodeContents(node);
        } catch {
          continue;
        }
        const rects = range.getClientRects();
        for (let index = 0; index < rects.length; index += 1) {
          const rect = rects[index];
          if (!rect || rect.width < 1 || rect.height < 3) continue;
          const pageIndex = Math.floor((rect.left - pagerRect.left + 1) / step);
          if (pageIndex === 0 && rect.right > pagerRect.left - 1 && rect.left < pagerRect.right + 1) {
            addLine(current, rect);
          } else if (pageIndex === 1 && rect.left < pagerRect.right + step + 1) {
            addLine(following, rect);
          }
        }
      }
      const here = Object.values(current)
        .sort((left, right) => left.bottom - right.bottom);
      const next = Object.values(following)
        .sort((left, right) => left.top - right.top);
      const last = here.at(-1) ?? null;
      const first = next[0] ?? null;
      const style = global.getComputedStyle(root);
      const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
      const pixels = (value: unknown): number => Math.round(numberOrZero(value));
      const tailStats = root.__rrPageTailTightStats ?? {};
      return {
        layout_fast: Boolean(global.fastChapterLayout),
        layout_view_height: pixels(pagerRect.height),
        layout_root_height: pixels(rootRect.height),
        layout_root_style_height: pixels(Number.parseFloat(root.style.height)),
        layout_padding_bottom: pixels(paddingBottom),
        layout_line_height: pixels(Number.parseFloat(style.lineHeight)),
        layout_step: pixels(step),
        layout_current_line_count: here.length,
        layout_last_top: last ? pixels(last.top - pagerRect.top) : -1,
        layout_last_bottom: last ? pixels(last.bottom - pagerRect.top) : -1,
        layout_last_height: last ? pixels(last.height) : 0,
        layout_next_top: first ? pixels(first.top - pagerRect.top) : -1,
        layout_next_bottom: first ? pixels(first.bottom - pagerRect.top) : -1,
        layout_next_height: first ? pixels(first.height) : 0,
        layout_visible_free: last ? pixels(pagerRect.bottom - last.bottom) : -1,
        layout_content_free: last ? pixels(pagerRect.bottom - paddingBottom - last.bottom) : -1,
        layout_tail_cross: pixels(tailStats.cross),
        layout_tail_fit: pixels(tailStats.fit),
        layout_tail_tightened: pixels(tailStats.tightened),
      };
    } catch {
      return null;
    }
  }

  function readerBugTrace(
    kind: unknown,
    outcome: unknown,
    event?: ReaderPageTraceEvent | null,
    extra?: unknown,
  ): void {
    const x = event && Number.isFinite(event.clientX) ? event.clientX ?? null : null;
    const y = event && Number.isFinite(event.clientY) ? event.clientY ?? null : null;
    const target = event?.target;
    let tag = target?.tagName ? String(target.tagName).toLowerCase() : "unknown";
    if (target?.closest) {
      if (target.closest("a")) tag = "link";
      else if (target.closest("button")) tag = "button";
      else if (target.closest("input,select,textarea")) tag = "input";
      else if (target.closest(".hl-rect[data-hi],mark.hl")) tag = "highlight";
      else if (target.closest("img,svg,canvas")) tag = "media";
    }
    const data: TraceData = {
      kind: kind || "event",
      source: "reader_page",
      outcome: outcome || "handled",
      target: tag,
      chapter: global.curCh,
      page: global.pageInCh,
      pages: Math.max(0, numberOrZero(global.pagesInCh)),
      chapter_pending: Math.max(0, numberOrZero(global.chapterPending)),
      chapter_turn_pending: Boolean(global.chapterTurnPending),
      turn_fx_active: Boolean(global.pager?.classList?.contains("turn-fx")),
      turn_timer_active: Boolean(global.turnFxTimer),
      scroll_paged: Boolean(global.scrollPagedView),
      flow_mode: global.S?.flowMode || "unknown",
      page_mode: global.S?.pageMode || "unknown",
    };
    if (target?.closest) {
      const noteMarker = target.closest('[data-vnote-badge="1"],.rr-note-badge,.rr-note-ref,[data-rr-note-ref="1"],.vp-inline');
      if (noteMarker) {
        const noteVirtual = target.closest('[data-vnote-badge="1"],.vp-inline');
        const noteAnchor = target.closest('a[href]');
        const noteHref = noteAnchor?.getAttribute?.('href') || '';
        data.note_marker = true;
        data.note_virtual = Boolean(noteVirtual);
        data.note_link_present = Boolean(noteAnchor);
        data.note_fragment_present = noteHref.includes('#');
      }
    }
    if (kind === "turn" || kind === "chapter") Object.assign(data, pagedLayoutSnapshot() ?? {});
    if (x !== null) {
      data.x_pct = Math.max(0, Math.min(100, Math.round(x / Math.max(1, global.window.innerWidth) * 1_000) / 10));
      data.zone = x < global.window.innerWidth * 0.4
        ? "left"
        : x > global.window.innerWidth * 0.6 ? "right" : "center";
    }
    if (y !== null) {
      data.y_pct = Math.max(0, Math.min(100, Math.round(y / Math.max(1, global.window.innerHeight) * 1_000) / 10));
    }
    const extraData = record(extra);
    if (extraData) {
      for (const key of copiedExtraKeys) {
        if (extraData[key] !== undefined) data[key] = extraData[key];
      }
    }
    global.parent.postMessage({ bugTrace: data }, "*");
  }

  function markPageTurnInput(input: unknown, detail?: unknown): void {
    global.pageTurnTraceInput = input || "unknown";
    global.pageTurnTraceDetail = record(detail);
  }

  function pageTurnTraceData(token: ReaderPageTurnToken, extra?: TraceData | null): TraceData {
    const data: TraceData = {
      turn_id: token.id,
      direction: token.direction,
      input: token.input,
      before_chapter: token.chapter,
      before_page: token.page,
    };
    if (extra) {
      for (const key of Object.keys(extra)) if (/^wheel_/u.test(key)) data[key] = extra[key];
    }
    return data;
  }

  function beginPageTurnBugTrace(direction: unknown): ReaderPageTurnToken {
    const token: ReaderPageTurnToken = {
      id: numberOrZero(global.pageTurnTraceSequence) + 1,
      direction,
      chapter: global.curCh,
      page: global.pageInCh,
      input: global.pageTurnTraceInput || "unknown",
      detail: global.pageTurnTraceDetail ?? null,
    };
    global.pageTurnTraceSequence = token.id;
    global.pageTurnTraceInput = "unknown";
    global.pageTurnTraceDetail = null;
    readerBugTrace("turn", "requested", null, pageTurnTraceData(token, token.detail));
    return token;
  }

  function finishPageTurnBugTrace(token?: ReaderPageTurnToken | null): void {
    if (!token) return;
    const moved = token.chapter !== global.curCh || token.page !== global.pageInCh;
    const busy = numberOrZero(global.chapterPending) > 0 || Boolean(global.chapterTurnPending);
    const data = pageTurnTraceData(token, token.detail);
    data.after_chapter = global.curCh;
    data.after_page = global.pageInCh;
    readerBugTrace("turn", moved ? "applied" : busy ? "turn_busy" : "no_change", null, data);
  }

  function beginChapterBugTrace(chapter: unknown, where: unknown): ReaderChapterTraceToken {
    global.chapterPending = numberOrZero(global.chapterPending) + 1;
    const token = { chapter, started: global.performance.now() };
    readerBugTrace("chapter", "chapter_start", null, {
      direction: where === "end" ? "backward" : "forward",
      chapter,
      page: 0,
    });
    return token;
  }

  function finishChapterBugTrace(
    token: ReaderChapterTraceToken,
    ready: unknown,
    page: unknown,
  ): void {
    global.chapterPending = Math.max(0, numberOrZero(global.chapterPending) - 1);
    readerBugTrace("chapter", ready ? "chapter_ready" : "chapter_error", null, {
      duration_ms: global.performance.now() - token.started,
      chapter: token.chapter,
      page: ready ? page : 0,
    });
  }

  Object.assign(global, {
    pagedLayoutSnapshot,
    readerBugTrace,
    markPageTurnInput,
    pageTurnTraceData,
    beginPageTurnBugTrace,
    finishPageTurnBugTrace,
    beginChapterBugTrace,
    finishChapterBugTrace,
  });

  return Object.freeze({
    pagedLayoutSnapshot,
    readerBugTrace,
    markPageTurnInput,
    pageTurnTraceData,
    beginPageTurnBugTrace,
    finishPageTurnBugTrace,
    beginChapterBugTrace,
    finishChapterBugTrace,
  });
}
