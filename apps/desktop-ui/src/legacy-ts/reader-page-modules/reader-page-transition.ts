// 阅读正文 WebView 的诊断、翻页过渡与共享视口辅助。
// 本模块安装回原 classic global，保留后续/先前拼接脚本使用的裸符号契约。

interface ReaderPageTransitionSettings {
  readonly [key: string]: unknown;
  readonly flowMode?: unknown;
  readonly pageMode?: unknown;
  readonly pageTurnEffect?: unknown;
  readonly pageTurnSpeed?: unknown;
  readonly theme?: unknown;
}

interface ReaderPageAnchor {
  readonly range?: Range;
  readonly el?: Element;
}

interface ReaderPagePort extends HTMLElement {
  scrollTop: number;
}

interface ReaderPageTransitionParent {
  postMessage(message: Record<string, unknown>, targetOrigin: "*"): void;
}

type ChapterPosition = unknown;

export interface ReaderPageTransitionRuntime extends Record<string, unknown> {
  readonly localStorage: Pick<Storage, "getItem">;
  readonly document: Document;
  readonly window: Pick<Window, "innerHeight" | "innerWidth">;
  readonly parent: ReaderPageTransitionParent;
  readonly performance: Pick<Performance, "now">;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly setTimeout: (handler: () => void, timeout?: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  S?: ReaderPageTransitionSettings;
  root?: HTMLElement | null;
  pager?: HTMLElement | null;
  scroller?: ReaderPagePort | null;
  curCh?: number;
  pageInCh?: number;
  pagesInCh?: number;
  viewOffset?: number;
  scrollPagedView?: unknown;
  curTopAnchor?: ReaderPageAnchor | null;
  virtualPage?: HTMLElement | null;
  scrollPreview?: HTMLElement | null;
  pagedImagePreview?: HTMLElement | null;
  IS_MAC_WEBKIT?: unknown;
  FAST_CHAPTER_LAYOUT_CHARS?: number;
  fastChapterLayout?: boolean;
  scrollCaptureTimer?: ReturnType<typeof setTimeout> | null;
  turnFxTimer?: ReturnType<typeof setTimeout> | null;
  turnFxSheet?: HTMLElement | null;
  chapterBoundarySnapshots?: Map<string, HTMLElement>;
  chapterTurnPending?: boolean;
  chapterLoadFailed?: boolean;
  pendingChapterTurnDirection?: number;
  replayQueuedChapterTurn?: (direction: number) => void;
  modeSwitchDiagSeq?: number;
  modeSwitchDiagUntil?: number;
  modeSwitchDiagExpected?: number | null;
  readerAnimationSettingOn?: (key: string) => boolean;
  isScrollMode?: () => boolean;
  currentScrollPageClipBlank?: () => number;
  showChapter?: (chapter: number, where: ChapterPosition) => Promise<unknown>;
  notifyReaderEndIfReached?: (direction: number) => unknown;
  lineHeightPx?: () => number;
  viewportHeight?: () => number;
  sourceTextAround?: (start: number, end: number, prefix: number, suffix: number) => string;
  anchorRect?: (anchor: ReaderPageAnchor | null | undefined) => DOMRect | null | undefined;
  topAnchor?: () => ReaderPageAnchor | null;
  anchorTextOffset?: (anchor: ReaderPageAnchor | null | undefined) => number | null;
  sourceAnchorRangeForOffset?: (offset: number) => Range | null;
  pageDebugSettingOn?: (key: string) => boolean;
  userNav?: () => void;
  reportReaderPaintPerf?: (name: string, started: number, detail?: string) => void;
  turnFxName?: () => "off" | "horizontal";
  turnFxSpeed?: () => number;
  turnFxDuration?: (base: number) => number;
  ensureTurnFxSheet?: () => HTMLElement | null;
  turnFxBg?: () => string;
  captureTurnFxPage?: (role?: string) => boolean;
  cacheChapterBoundarySnapshot?: (chapter: number, boundary: "start" | "end", page: HTMLElement) => void;
  clearTurnFx?: () => void;
  waitForChapterPaint?: () => Promise<void>;
  beginTurnFx?: (direction: number, move: () => void) => void;
  beginChapterTurnFx?: (direction: number, chapter: number, where: ChapterPosition) => Promise<unknown>;
  largeChapterFastLayout?: (html: unknown) => boolean;
  scrollPort?: () => ReaderPagePort | HTMLElement | null;
  viewRect?: () => DOMRect;
  scrollGlyphSafePx?: () => number;
  scrollBottomSafePx?: () => number;
  scrollStartEpsilonPx?: () => number;
  perfLog?: (name: unknown, detail?: unknown) => void;
  modeSwitchDiagLayerVisible?: (layer: HTMLElement | null | undefined) => boolean;
  modeSwitchDiagSnippet?: (offset: number | null | undefined) => string;
  modeSwitchDiagRect?: (anchor: ReaderPageAnchor | null | undefined) => Record<string, number> | null;
  modeSwitchDiagLog?: (
    sequence: number,
    phase: string,
    expectedOffset: number | null,
    extra?: Record<string, unknown> | null,
  ) => void;
  modeSwitchDiagBegin?: (
    previousFlow: unknown,
    nextFlow: unknown,
    previousPageMode: unknown,
    nextPageMode: unknown,
    expectedOffset: number | null,
    storedBefore: unknown,
  ) => number;
  modeSwitchDiagSchedule?: (sequence: number, expectedOffset: number | null) => void;
  modeSwitchDiagEvent?: (phase: string) => void;
}

export interface ReaderPageTransitionApi {
  readonly pageDebugSettingOn: NonNullable<ReaderPageTransitionRuntime["pageDebugSettingOn"]>;
  readonly userNav: NonNullable<ReaderPageTransitionRuntime["userNav"]>;
  readonly reportReaderPaintPerf: NonNullable<ReaderPageTransitionRuntime["reportReaderPaintPerf"]>;
  readonly turnFxName: NonNullable<ReaderPageTransitionRuntime["turnFxName"]>;
  readonly turnFxSpeed: NonNullable<ReaderPageTransitionRuntime["turnFxSpeed"]>;
  readonly turnFxDuration: NonNullable<ReaderPageTransitionRuntime["turnFxDuration"]>;
  readonly ensureTurnFxSheet: NonNullable<ReaderPageTransitionRuntime["ensureTurnFxSheet"]>;
  readonly turnFxBg: NonNullable<ReaderPageTransitionRuntime["turnFxBg"]>;
  readonly captureTurnFxPage: NonNullable<ReaderPageTransitionRuntime["captureTurnFxPage"]>;
  readonly cacheChapterBoundarySnapshot: NonNullable<ReaderPageTransitionRuntime["cacheChapterBoundarySnapshot"]>;
  readonly clearTurnFx: NonNullable<ReaderPageTransitionRuntime["clearTurnFx"]>;
  readonly waitForChapterPaint: NonNullable<ReaderPageTransitionRuntime["waitForChapterPaint"]>;
  readonly beginTurnFx: NonNullable<ReaderPageTransitionRuntime["beginTurnFx"]>;
  readonly beginChapterTurnFx: NonNullable<ReaderPageTransitionRuntime["beginChapterTurnFx"]>;
  readonly queueChapterTurnInput: (direction: number) => boolean;
  readonly largeChapterFastLayout: NonNullable<ReaderPageTransitionRuntime["largeChapterFastLayout"]>;
  readonly scrollPort: NonNullable<ReaderPageTransitionRuntime["scrollPort"]>;
  readonly viewRect: NonNullable<ReaderPageTransitionRuntime["viewRect"]>;
  readonly scrollGlyphSafePx: NonNullable<ReaderPageTransitionRuntime["scrollGlyphSafePx"]>;
  readonly scrollBottomSafePx: NonNullable<ReaderPageTransitionRuntime["scrollBottomSafePx"]>;
  readonly scrollStartEpsilonPx: NonNullable<ReaderPageTransitionRuntime["scrollStartEpsilonPx"]>;
  readonly perfLog: NonNullable<ReaderPageTransitionRuntime["perfLog"]>;
  readonly modeSwitchDiagLayerVisible: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagLayerVisible"]>;
  readonly modeSwitchDiagSnippet: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagSnippet"]>;
  readonly modeSwitchDiagRect: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagRect"]>;
  readonly modeSwitchDiagLog: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagLog"]>;
  readonly modeSwitchDiagBegin: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagBegin"]>;
  readonly modeSwitchDiagSchedule: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagSchedule"]>;
  readonly modeSwitchDiagEvent: NonNullable<ReaderPageTransitionRuntime["modeSwitchDiagEvent"]>;
}

function numberValue(value: unknown): number {
  return Number(value) || 0;
}

function finiteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function installReaderPageTransition(
  global: ReaderPageTransitionRuntime,
): ReaderPageTransitionApi {
  global.turnFxTimer = null;
  global.turnFxSheet = null;
  global.chapterBoundarySnapshots = new Map<string, HTMLElement>();
  global.chapterTurnPending = false;
  global.pendingChapterTurnDirection = 0;
  global.scrollCaptureTimer = null;
  // macOS 兼容排版会在显示当前页时再做一次逐字精确测量，因此整章页表只需
  // 提供稳定的粗边界。较短章节也走快速页表，避免跨章首开为几 KB 正文同步
  // 扫描整章；其他平台继续沿用更保守的阈值。
  global.FAST_CHAPTER_LAYOUT_CHARS = (global.IS_MAC_WEBKIT ? 4 : 120) * 1024;
  global.fastChapterLayout = false;
  global.modeSwitchDiagSeq = 0;
  global.modeSwitchDiagUntil = 0;
  global.modeSwitchDiagExpected = null;

  function settings(): ReaderPageTransitionSettings {
    return global.S ?? {};
  }

  function pageDebugSettingOn(key: string): boolean {
    try {
      const parsed = JSON.parse(global.localStorage.getItem("debugSettingsV1") || "{}") as Record<string, unknown>;
      return parsed[key] !== false;
    } catch {
      return true;
    }
  }

  function userNav(): void {
    global.parent.postMessage({ userNav: 1 }, "*");
  }

  function reportReaderPaintPerf(name: string, started: number, detail?: string): void {
    global.requestAnimationFrame(() => {
      global.requestAnimationFrame(() => {
        const elapsed = Math.max(0, global.performance.now() - started);
        global.parent.postMessage({
          readerPerf: `${name} elapsed_ms=${elapsed.toFixed(1)}${detail ? ` ${detail}` : ""}`,
        }, "*");
      });
    });
  }

  function turnFxName(): "off" | "horizontal" {
    if (typeof global.readerAnimationSettingOn === "function" && !global.readerAnimationSettingOn("pageTurn")) return "off";
    const effect = settings().pageTurnEffect || "horizontal";
    return /^(off|horizontal)$/u.test(String(effect)) ? effect as "off" | "horizontal" : "horizontal";
  }

  function turnFxSpeed(): number {
    let speed = Number.parseFloat(String(settings().pageTurnSpeed));
    if (!Number.isFinite(speed)) speed = 1;
    return Math.max(0.5, Math.min(2, speed));
  }

  function turnFxDuration(base: number): number {
    return Math.max(80, Math.round(base / turnFxSpeed()));
  }

  function ensureTurnFxSheet(): HTMLElement | null {
    if (global.turnFxSheet?.isConnected) return global.turnFxSheet;
    const pager = global.pager;
    if (!pager) return null;
    let sheet = global.document.getElementById("turn-fx-sheet");
    if (!sheet) {
      sheet = global.document.createElement("div");
      sheet.id = "turn-fx-sheet";
      pager.appendChild(sheet);
    }
    global.turnFxSheet = sheet;
    return sheet;
  }

  function turnFxBg(): string {
    if (settings().theme === "dark") return "#1c1c1e";
    if (settings().theme === "sepia") return "#f4ecd8";
    return "#fff";
  }

  function scrollPort(): ReaderPagePort | HTMLElement | null {
    return global.scroller ?? global.pager ?? null;
  }

  function captureTurnFxPage(role?: string): boolean {
    const sheet = ensureTurnFxSheet();
    const root = global.root;
    const pager = global.pager;
    if (!sheet || !root || !pager) return false;
    sheet.style.setProperty("--turn-fx-bg", turnFxBg());
    const page = global.document.createElement("div");
    page.className = `turn-fx-page ${role || "turn-fx-outgoing"}`;
    const visibleVirtualPage = global.isScrollMode?.()
      && global.virtualPage?.style.display === "block"
      ? global.virtualPage
      : null;
    if (global.isScrollMode?.()) {
      const port = scrollPort();
      const viewHeight = Math.max(1, port?.clientHeight || global.window.innerHeight || 1);
      // 兼容排版在 macOS 上真正显示的是逐行重绘的 virtual page。它自身已经
      // 包含完整页界，不能再用原始滚动正文的裁切空白缩短快照。
      const blank = visibleVirtualPage ? 0 : numberValue(global.currentScrollPageClipBlank?.());
      page.style.bottom = "auto";
      page.style.height = `${Math.max(1, viewHeight - blank)}px`;
    }
    const clone = (visibleVirtualPage ?? root).cloneNode(true) as HTMLElement;
    if (visibleVirtualPage) {
      // 过去这里总是复制 root；兼容排版的可见 virtual page 与 root 的段距收敛、
      // 页尾完整字形布局不同，跨章时便会先显示 root 的错误页，再闪到 virtual
      // page。快照直接复制当前可见表面，撤下遮挡层前后内容保持逐字一致。
      // 保留 virtual-page 的标识，使现有逐行/注释样式原样作用于短暂快照；
      // 产品逻辑始终使用 global.virtualPage，不会把这个惰性副本当作活动页面。
      clone.id = "virtual-page";
      clone.classList.add("turn-fx-virtual-page");
      clone.style.position = "absolute";
      clone.style.inset = "0";
      clone.style.display = "block";
      clone.style.pointerEvents = "none";
      clone.style.zIndex = "auto";
      clone.style.transform = "none";
      clone.style.top = "0";
      clone.style.width = "100%";
      clone.style.height = "100%";
    } else {
      clone.removeAttribute("id");
      clone.classList.remove("turn-fx-moving");
      clone.style.transform = root.style.transform || "";
      clone.style.width = root.style.width || `${root.scrollWidth}px`;
      clone.style.height = root.style.height || `${root.scrollHeight}px`;
      if (global.isScrollMode?.()) clone.style.top = `-${numberValue(scrollPort()?.scrollTop)}px`;
    }
    page.appendChild(clone);
    sheet.appendChild(page);
    return true;
  }

  function chapterBoundarySnapshotKey(chapter: number, boundary: "start" | "end"): string {
    const pager = global.pager;
    return [
      chapter, boundary,
      global.window.innerWidth || 0, global.window.innerHeight || 0,
      pager?.clientWidth || 0, pager?.clientHeight || 0,
      JSON.stringify(settings()),
    ].join("|");
  }

  function cacheChapterBoundarySnapshot(
    chapter: number,
    boundary: "start" | "end",
    page: HTMLElement,
  ): void {
    const cache = global.chapterBoundarySnapshots;
    if (!cache || !page) return;
    const key = chapterBoundarySnapshotKey(chapter, boundary);
    cache.delete(key);
    cache.set(key, page.cloneNode(true) as HTMLElement);
    while (cache.size > 4) {
      const oldest = cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function rememberCurrentChapterBoundarySnapshot(): void {
    const sheet = global.turnFxSheet;
    const page = sheet?.lastElementChild as HTMLElement | null | undefined;
    if (!page) return;
    const chapter = numberValue(global.curCh);
    const pageIndex = numberValue(global.pageInCh);
    const pageCount = Math.max(1, numberValue(global.pagesInCh));
    const boundaries: Array<"start" | "end"> = [];
    if (pageIndex <= 0) boundaries.push("start");
    if (pageIndex >= pageCount - 1) boundaries.push("end");
    for (const boundary of boundaries) {
      cacheChapterBoundarySnapshot(chapter, boundary, page);
    }
  }

  function showCachedChapterBoundary(chapter: number, where: ChapterPosition): boolean {
    const boundary = where === "start" ? "start" : where === "end" ? "end" : null;
    const cache = global.chapterBoundarySnapshots;
    if (!boundary || !cache) return false;
    const cached = cache.get(chapterBoundarySnapshotKey(chapter, boundary));
    const sheet = ensureTurnFxSheet();
    if (!cached || !sheet) return false;
    sheet.innerHTML = "";
    sheet.appendChild(cached.cloneNode(true));
    return true;
  }

  function clearTurnFx(): void {
    if (global.turnFxTimer) {
      global.clearTimeout(global.turnFxTimer);
      global.turnFxTimer = null;
    }
    if (global.turnFxSheet) global.turnFxSheet.innerHTML = "";
    global.pager?.classList.remove(
      "turn-fx", "turn-fx-hold", "turn-fx-next", "turn-fx-prev", "turn-fx-horizontal",
    );
  }

  function waitForChapterPaint(): Promise<void> {
    return new Promise((resolve) => {
      global.requestAnimationFrame(() => {
        global.requestAnimationFrame(() => resolve());
      });
    });
  }

  function beginTurnFx(direction: number, move: () => void): void {
    const effect = turnFxName();
    const pager = global.pager;
    const root = global.root;
    if (!direction || !pager || !root || effect === "off") {
      clearTurnFx();
      move();
      return;
    }
    clearTurnFx();
    captureTurnFxPage("turn-fx-outgoing");
    move();
    captureTurnFxPage("turn-fx-incoming");
    const duration = turnFxDuration(360);
    ensureTurnFxSheet()?.style.setProperty("--turn-fx-duration", `${duration}ms`);
    pager.classList.add("turn-fx", `turn-fx-${effect}`, direction > 0 ? "turn-fx-next" : "turn-fx-prev");
    void root.offsetWidth;
    global.turnFxTimer = global.setTimeout(clearTurnFx, duration + 40);
  }

  function beginChapterTurnFx(
    direction: number,
    chapter: number,
    where: ChapterPosition,
  ): Promise<unknown> {
    if (global.chapterTurnPending) {
      queueChapterTurnInput(direction);
      return Promise.resolve();
    }
    global.chapterTurnPending = true;
    global.chapterLoadFailed = false;
    const done = (replayQueued = false): void => {
      global.chapterTurnPending = false;
      const queuedDirection = global.pendingChapterTurnDirection ?? 0;
      global.pendingChapterTurnDirection = 0;
      // 只保留加载期间最后一次有效方向。等当前 Promise 完整结束后下一帧再
      // 重放，避免第二次点击与尚未完成的章节布局争用同一套页表。
      if (replayQueued && queuedDirection && global.replayQueuedChapterTurn) {
        global.requestAnimationFrame(() => global.replayQueuedChapterTurn?.(queuedDirection));
      }
    };
    const showChapter = global.showChapter;
    if (!showChapter) {
      done(false);
      return Promise.reject(new Error("showChapter is unavailable"));
    }
    const effect = turnFxName();
    if (!direction || !global.pager || !global.root) {
      let succeeded = false;
      return showChapter(chapter, where)
        .then((value) => { succeeded = !global.chapterLoadFailed; global.notifyReaderEndIfReached?.(direction); return value; })
        .finally(() => done(succeeded));
    }
    if (effect === "off") {
      clearTurnFx();
      const held = captureTurnFxPage("turn-fx-outgoing");
      if (held) rememberCurrentChapterBoundarySnapshot();
      // 相邻章节已经显示过时，先把其稳定边界快照立即放到遮挡层；真实章节
      // 仍在下面按原流程获取、重排和逐字稳定，完成后再无缝撤下快照。
      // 必须先给 WebKit 两帧提交快照，再启动会同步占用主线程的兼容分页。
      // fetch 即使命中本地协议缓存，也可能在下一次绘制前继续执行 promise，
      // 旧实现因此虽然命中了快照，用户仍会看着原页等待整章重排完成。
      const cachedTarget = showCachedChapterBoundary(chapter, where);
      if (held || cachedTarget) global.pager.classList.add("turn-fx", "turn-fx-hold");
      const chapterReady = cachedTarget
        ? waitForChapterPaint().then(() => showChapter(chapter, where))
        : showChapter(chapter, where);
      let succeeded = false;
      return chapterReady
        .then(async (value) => {
          succeeded = !global.chapterLoadFailed;
          global.notifyReaderEndIfReached?.(direction);
          if (held || cachedTarget) await waitForChapterPaint();
          return value;
        })
        .finally(() => { clearTurnFx(); done(succeeded); });
    }
    clearTurnFx();
    captureTurnFxPage("turn-fx-outgoing");
    global.pager.classList.add("turn-fx");
    let succeeded = false;
    return showChapter(chapter, where)
      .then((value) => {
        succeeded = !global.chapterLoadFailed;
        global.notifyReaderEndIfReached?.(direction);
        if (global.curCh !== chapter) {
          clearTurnFx();
          return value;
        }
        captureTurnFxPage("turn-fx-incoming");
        const duration = turnFxDuration(360);
        ensureTurnFxSheet()?.style.setProperty("--turn-fx-duration", `${duration}ms`);
        global.pager?.classList.add(
          `turn-fx-${effect}`,
          direction > 0 ? "turn-fx-next" : "turn-fx-prev",
        );
        if (global.root) void global.root.offsetWidth;
        global.turnFxTimer = global.setTimeout(clearTurnFx, duration + 40);
        return value;
      })
      .finally(() => done(succeeded));
  }

  function queueChapterTurnInput(direction: number): boolean {
    if (!global.chapterTurnPending) return false;
    const normalizedDirection = direction < 0 ? -1 : direction > 0 ? 1 : 0;
    if (!normalizedDirection) return false;
    global.pendingChapterTurnDirection = normalizedDirection;
    return true;
  }

  function largeChapterFastLayout(html: unknown): boolean {
    return String(html || "").length >= (global.FAST_CHAPTER_LAYOUT_CHARS ?? 120 * 1024);
  }

  function viewRect(): DOMRect {
    const port = scrollPort();
    const target = global.isScrollMode?.() && port ? port : global.pager;
    if (!target) throw new Error("reader viewport is unavailable");
    return target.getBoundingClientRect();
  }

  function scrollGlyphSafePx(): number {
    return Math.max(4, Math.min(8, Math.ceil(numberValue(global.lineHeightPx?.()) * 0.16)));
  }

  function scrollBottomSafePx(): number {
    return Math.max(4, Math.min(10, Math.ceil(numberValue(global.lineHeightPx?.()) * 0.14)));
  }

  function scrollStartEpsilonPx(): number {
    return Math.max(16, Math.ceil(numberValue(global.lineHeightPx?.()) * 0.65));
  }

  function perfLog(..._arguments: readonly unknown[]): void {
    void _arguments;
  }

  function modeSwitchDiagLayerVisible(layer: HTMLElement | null | undefined): boolean {
    if (!layer?.isConnected || layer.style.display === "none") return false;
    let rectangle: DOMRect | null = null;
    try { rectangle = layer.getBoundingClientRect(); } catch { rectangle = null; }
    return Boolean(
      rectangle && rectangle.width > 1 && rectangle.height > 1 &&
      rectangle.bottom > 0 && rectangle.top < numberValue(global.viewportHeight?.()),
    );
  }

  function modeSwitchDiagSnippet(offset: number | null | undefined): string {
    if (!finiteOffset(offset)) return "";
    try {
      return (global.sourceTextAround?.(
        Math.max(0, offset), Math.max(0, offset) + 1, 12, 32,
      ) ?? "").replace(/\s+/gu, " ").slice(0, 48);
    } catch {
      return "";
    }
  }

  function modeSwitchDiagRect(
    anchor: ReaderPageAnchor | null | undefined,
  ): Record<string, number> | null {
    const rectangle = global.anchorRect?.(anchor);
    return rectangle ? {
      left: Math.round(rectangle.left),
      top: Math.round(rectangle.top),
      right: Math.round(rectangle.right),
      bottom: Math.round(rectangle.bottom),
    } : null;
  }

  function modeSwitchDiagLog(
    sequence: number,
    phase: string,
    expectedOffset: number | null,
    extra?: Record<string, unknown> | null,
  ): void {
    if (!sequence) return;
    let sampled: ReaderPageAnchor | null = null;
    let sampledOffset: number | null = null;
    try {
      sampled = global.topAnchor?.() ?? null;
      sampledOffset = global.anchorTextOffset?.(sampled) ?? null;
    } catch {
      sampled = null;
      sampledOffset = null;
    }
    let expectedRange: Range | null = null;
    if (expectedOffset !== null) {
      try { expectedRange = global.sourceAnchorRangeForOffset?.(expectedOffset) ?? null; } catch { expectedRange = null; }
    }
    const port = scrollPort();
    let storedOffset: number | null = null;
    try { storedOffset = global.anchorTextOffset?.(global.curTopAnchor) ?? null; } catch { storedOffset = null; }
    const payload: Record<string, unknown> = {
      seq: sequence,
      phase,
      ts: Math.round(global.performance.now()),
      chapter: global.curCh,
      flow: settings().flowMode,
      pageMode: settings().pageMode,
      page: numberValue(global.pageInCh) + 1,
      pages: global.pagesInCh,
      scrollTop: port ? Math.round(numberValue(port.scrollTop)) : null,
      viewOffset: Math.round(numberValue(global.viewOffset)),
      scrollPaged: Boolean(global.scrollPagedView),
      expectedOffset,
      sampledOffset,
      storedOffset,
      expectedRect: expectedRange ? modeSwitchDiagRect({ range: expectedRange }) : null,
      sampledRect: sampled ? modeSwitchDiagRect(sampled) : null,
      expectedText: modeSwitchDiagSnippet(expectedOffset),
      sampledText: modeSwitchDiagSnippet(sampledOffset),
      virtualVisible: modeSwitchDiagLayerVisible(global.virtualPage),
      scrollPreviewVisible: modeSwitchDiagLayerVisible(global.scrollPreview),
      pagedPreviewVisible: modeSwitchDiagLayerVisible(global.pagedImagePreview),
      rootTransform: global.root ? String(global.root.style.transform || "") : "",
    };
    if (extra) Object.assign(payload, extra);
    global.parent.postMessage({ readerPerf: `mode_diag ${JSON.stringify(payload)}` }, "*");
  }

  function modeSwitchDiagBegin(
    previousFlow: unknown,
    nextFlow: unknown,
    previousPageMode: unknown,
    nextPageMode: unknown,
    expectedOffset: number | null,
    storedBefore: unknown,
  ): number {
    const sequence = numberValue(global.modeSwitchDiagSeq) + 1;
    global.modeSwitchDiagSeq = sequence;
    global.modeSwitchDiagUntil = Date.now() + 1500;
    global.modeSwitchDiagExpected = expectedOffset;
    modeSwitchDiagLog(sequence, "before", expectedOffset, {
      transition: `${String(previousFlow)}/${String(previousPageMode)}->${String(nextFlow)}/${String(nextPageMode)}`,
      storedBefore,
    });
    return sequence;
  }

  function modeSwitchDiagSchedule(sequence: number, expectedOffset: number | null): void {
    global.requestAnimationFrame(() => {
      modeSwitchDiagLog(sequence, "raf1", expectedOffset);
      global.requestAnimationFrame(() => modeSwitchDiagLog(sequence, "raf2", expectedOffset));
    });
    global.setTimeout(() => modeSwitchDiagLog(sequence, "t80", expectedOffset), 80);
    global.setTimeout(() => modeSwitchDiagLog(sequence, "t250", expectedOffset), 250);
    global.setTimeout(() => modeSwitchDiagLog(sequence, "t800", expectedOffset), 800);
  }

  function modeSwitchDiagEvent(phase: string): void {
    if (Date.now() > numberValue(global.modeSwitchDiagUntil) || !global.modeSwitchDiagSeq) return;
    modeSwitchDiagLog(global.modeSwitchDiagSeq, phase, global.modeSwitchDiagExpected ?? null);
  }

  const api: ReaderPageTransitionApi = Object.freeze({
    pageDebugSettingOn, userNav, reportReaderPaintPerf,
    turnFxName, turnFxSpeed, turnFxDuration, ensureTurnFxSheet, turnFxBg,
    captureTurnFxPage, cacheChapterBoundarySnapshot, clearTurnFx, waitForChapterPaint, beginTurnFx, beginChapterTurnFx,
    queueChapterTurnInput,
    largeChapterFastLayout, scrollPort, viewRect,
    scrollGlyphSafePx, scrollBottomSafePx, scrollStartEpsilonPx, perfLog,
    modeSwitchDiagLayerVisible, modeSwitchDiagSnippet, modeSwitchDiagRect,
    modeSwitchDiagLog, modeSwitchDiagBegin, modeSwitchDiagSchedule, modeSwitchDiagEvent,
  });
  Object.assign(global, api);
  return api;
}
