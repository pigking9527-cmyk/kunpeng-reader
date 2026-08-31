import assert from "node:assert/strict";
import test from "node:test";

import {
  installReaderPageBugTrace,
  type ReaderPageBugTraceRuntime,
  type ReaderPageTraceEvent,
} from "./reader-page-bug-trace.ts";

interface PostedTrace {
  readonly bugTrace: Record<string, unknown>;
}

function createRuntime(messages: PostedTrace[]): ReaderPageBugTraceRuntime {
  let now = 100;
  return {
    root: null,
    pager: null,
    S: { flowMode: "paged", pageMode: "single" },
    curCh: 2,
    pageInCh: 3,
    pagesInCh: 5,
    fastChapterLayout: false,
    scrollPagedView: true,
    window: { innerWidth: 1_000, innerHeight: 800 },
    document: {} as Document,
    NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: () => ({}) as CSSStyleDeclaration,
    performance: { now: () => (now += 25) },
    parent: {
      postMessage(message) {
        messages.push(message as PostedTrace);
      },
    },
  };
}

test("installer exposes every original bare global and initializes shared state", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const api = installReaderPageBugTrace(runtime);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), [
    "pagedLayoutSnapshot", "readerBugTrace", "markPageTurnInput", "pageTurnTraceData",
    "beginPageTurnBugTrace", "finishPageTurnBugTrace", "beginChapterBugTrace",
    "finishChapterBugTrace",
  ]);
  for (const key of Object.keys(api) as Array<keyof typeof api>) {
    assert.equal(runtime[key], api[key]);
  }
  assert.equal(runtime.chapterPending, 0);
  assert.equal(runtime.pageTurnTraceSequence, 0);
  assert.equal(runtime.pageTurnTraceInput, "unknown");
  assert.equal(runtime.pageTurnTraceDetail, null);
});

test("redacted event trace preserves target priority, geometry, and exact allowlist", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const api = installReaderPageBugTrace(runtime);
  const matched: string[] = [];
  const event: ReaderPageTraceEvent = {
    clientX: 950,
    clientY: 400,
    target: {
      tagName: "SPAN",
      closest(selector) {
        matched.push(selector);
        return selector === "button" ? {} : null;
      },
    },
  };
  api.readerBugTrace("click", "page_next", event, {
    direction: "forward",
    wheel_delta_px: 18.5,
    image_candidate_page: 4,
    text: "正文绝不可外发",
    href: "https://secret.invalid",
  });
  assert.deepEqual(matched, [
    "a", "button",
    '[data-vnote-badge="1"],.rr-note-badge,.rr-note-ref,[data-rr-note-ref="1"],.vp-inline',
  ]);
  assert.equal(messages.length, 1);
  const data = messages[0]?.bugTrace;
  assert.ok(data);
  assert.deepEqual({
    kind: data.kind,
    source: data.source,
    outcome: data.outcome,
    target: data.target,
    chapter: data.chapter,
    page: data.page,
    pages: data.pages,
    chapter_pending: data.chapter_pending,
    scroll_paged: data.scroll_paged,
    flow_mode: data.flow_mode,
    page_mode: data.page_mode,
    x_pct: data.x_pct,
    y_pct: data.y_pct,
    zone: data.zone,
    direction: data.direction,
    wheel_delta_px: data.wheel_delta_px,
    image_candidate_page: data.image_candidate_page,
  }, {
    kind: "click", source: "reader_page", outcome: "page_next", target: "button",
    chapter: 2, page: 3, pages: 5, chapter_pending: 0, scroll_paged: true,
    flow_mode: "paged", page_mode: "single", x_pct: 95, y_pct: 50, zone: "right",
    direction: "forward", wheel_delta_px: 18.5, image_candidate_page: 4,
  });
  assert.equal(data.text, undefined);
  assert.equal(data.href, undefined);
});

test("footnote target diagnostics expose only structural booleans", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const api = installReaderPageBugTrace(runtime);
  const anchor = { getAttribute: (name: string) => name === "href" ? "chapter.xhtml#private-fragment" : null };
  const marker = {};
  api.readerBugTrace("click", "page_next", {
    target: {
      tagName: "SPAN",
      closest(selector) {
        if (selector.includes(".rr-note-badge")) return marker;
        if (selector.includes(".vp-inline")) return marker;
        if (selector === "a[href]") return anchor;
        return null;
      },
    },
  });
  const data = messages[0]?.bugTrace;
  assert.equal(data?.note_marker, true);
  assert.equal(data?.note_virtual, true);
  assert.equal(data?.note_link_present, true);
  assert.equal(data?.note_fragment_present, true);
  assert.equal(data?.href, undefined);
  assert.equal(data?.fragment, undefined);
});

test("macOS native clip diagnostics preserve only bounded geometry", () => {
  const messages: PostedTrace[] = [];
  const api = installReaderPageBugTrace(createRuntime(messages));
  api.readerBugTrace("layout", "mac_native_clip", null, {
    mac_clip_native_notes: true,
    mac_clip_page_inline_notes: true,
    mac_clip_view_height: 768,
    mac_clip_scroll_top: 4_096,
    mac_clip_measured_blank: 0,
    mac_clip_virtual_blank: 31,
    mac_clip_partial_blank: 0,
    mac_clip_applied_blank: 0,
    mac_clip_has_extra_virtual: true,
    mac_clip_path_active: false,
    media_count: 2,
    media_background_count: 1,
    media_table_count: 1,
    media_positioned_count: 1,
    media_visible_count: 1,
    media_text_overlap_count: 1,
    media_background_text_overlap_count: 1,
    text: "正文绝不可外发",
  });
  const data = messages[0]?.bugTrace;
  assert.equal(data?.mac_clip_native_notes, true);
  assert.equal(data?.mac_clip_page_inline_notes, true);
  assert.equal(data?.mac_clip_virtual_blank, 31);
  assert.equal(data?.mac_clip_has_extra_virtual, true);
  assert.equal(data?.media_background_text_overlap_count, 1);
  assert.equal(data?.text, undefined);
});

test("page-turn trace keeps sequence, wheel-only detail, outcomes, and reinitialization", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const api = installReaderPageBugTrace(runtime);
  api.markPageTurnInput("wheel", {
    wheel_delta_px: 17,
    wheel_gap_ms: 31,
    direction: "must-not-copy-from-detail",
  });
  const token = api.beginPageTurnBugTrace("forward");
  assert.deepEqual(token, {
    id: 1,
    direction: "forward",
    chapter: 2,
    page: 3,
    input: "wheel",
    detail: { wheel_delta_px: 17, wheel_gap_ms: 31, direction: "must-not-copy-from-detail" },
  });
  const requested = messages.at(-1)?.bugTrace;
  assert.equal(requested?.outcome, "requested");
  assert.equal(requested?.wheel_delta_px, 17);
  assert.equal(requested?.wheel_gap_ms, 31);
  assert.equal(requested?.direction, "forward");
  assert.equal(runtime.pageTurnTraceInput, "unknown");
  assert.equal(runtime.pageTurnTraceDetail, null);

  runtime.chapterTurnPending = true;
  api.finishPageTurnBugTrace(token);
  assert.equal(messages.at(-1)?.bugTrace.outcome, "turn_busy");
  runtime.chapterTurnPending = false;
  runtime.pageInCh = 4;
  api.finishPageTurnBugTrace(token);
  assert.equal(messages.at(-1)?.bugTrace.outcome, "applied");
  assert.equal(messages.at(-1)?.bugTrace.after_page, 4);
});

test("chapter trace counts overlapping loads and records bounded completion metadata", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const api = installReaderPageBugTrace(runtime);
  const first = api.beginChapterBugTrace(4, "end");
  const second = api.beginChapterBugTrace(5, "start");
  assert.equal(runtime.chapterPending, 2);
  assert.equal(messages[0]?.bugTrace.direction, "backward");
  assert.equal(messages[1]?.bugTrace.direction, "forward");
  api.finishChapterBugTrace(first, true, 8);
  assert.equal(runtime.chapterPending, 1);
  assert.equal(messages.at(-1)?.bugTrace.outcome, "chapter_ready");
  assert.equal(messages.at(-1)?.bugTrace.page, 8);
  api.finishChapterBugTrace(second, false, 9);
  assert.equal(runtime.chapterPending, 0);
  assert.equal(messages.at(-1)?.bugTrace.outcome, "chapter_error");
  assert.equal(messages.at(-1)?.bugTrace.page, 0);
});

test("paged layout snapshot preserves line grouping and tail geometry without text", () => {
  const messages: PostedTrace[] = [];
  const runtime = createRuntime(messages);
  const textNodes = [
    { nodeValue: "第一行" },
    { nodeValue: "  " },
    { nodeValue: "下一页" },
  ] as unknown as Node[];
  let selected: Node | null = null;
  let index = 0;
  const ranges = new Map<Node, DOMRect[]>([
    [textNodes[0] as Node, [
      { left: 10, right: 110, top: 20, bottom: 40, width: 100, height: 20 } as DOMRect,
      { left: 10, right: 150, top: 20.2, bottom: 40.2, width: 140, height: 20 } as DOMRect,
    ]],
    [textNodes[2] as Node, [
      { left: 1_010, right: 1_110, top: 15, bottom: 35, width: 100, height: 20 } as DOMRect,
    ]],
  ]);
  const root = {
    style: { height: "760px" },
    __rrPageTailTightStats: { cross: 3, fit: 4, tightened: 1 },
    getBoundingClientRect: () => ({ height: 760 } as DOMRect),
  } as unknown as NonNullable<ReaderPageBugTraceRuntime["root"]>;
  runtime.root = root;
  runtime.pager = {
    getBoundingClientRect: () => ({
      left: 0, right: 1_000, top: 0, bottom: 800, width: 1_000, height: 800,
    } as DOMRect),
  } as HTMLElement;
  runtime.pageLayout = () => ({ pageStep: 1_000 });
  runtime.document = {
    createTreeWalker: () => ({
      nextNode: () => textNodes[index++] ?? null,
    }),
    createRange: () => ({
      selectNodeContents: (node: Node) => { selected = node; },
      getClientRects: () => ranges.get(selected as Node) ?? [],
    }),
  } as unknown as Document;
  runtime.getComputedStyle = () => ({ paddingBottom: "20px", lineHeight: "24px" }) as CSSStyleDeclaration;
  const snapshot = installReaderPageBugTrace(runtime).pagedLayoutSnapshot();
  assert.deepEqual(snapshot, {
    layout_fast: false,
    layout_view_height: 800,
    layout_root_height: 760,
    layout_root_style_height: 760,
    layout_padding_bottom: 20,
    layout_line_height: 24,
    layout_step: 1_000,
    layout_current_line_count: 1,
    layout_last_top: 20,
    layout_last_bottom: 40,
    layout_last_height: 20,
    layout_next_top: 15,
    layout_next_bottom: 35,
    layout_next_height: 20,
    layout_visible_free: 760,
    layout_content_free: 740,
    layout_tail_cross: 3,
    layout_tail_fit: 4,
    layout_tail_tightened: 1,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /第一行|下一页/u);
});
