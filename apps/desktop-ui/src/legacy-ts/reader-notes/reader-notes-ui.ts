import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface TocEntry {
  readonly chapter: number;
  readonly frag?: string;
  readonly label: string;
  readonly level: number;
}

interface Bookmark {
  readonly chapter?: number;
  readonly frac?: number;
  readonly label?: string;
}

interface HighlightRequest {
  readonly chapter: number;
  readonly start: number;
  readonly end: number;
  readonly text?: string;
  readonly context?: string;
  readonly rects?: string;
  readonly color?: string;
  readonly range_anchor?: unknown;
}

interface Highlight {
  readonly chapter?: number;
  readonly text?: string;
  readonly corrected_text?: string;
  note?: string;
}

interface ReaderNotesSnapshot {
  readonly bookmarks?: readonly Bookmark[];
  readonly highlights?: readonly Highlight[];
}

type ReaderNotesCommands = {
  remove_bookmark: {
    readonly args: { readonly index: number };
    readonly result: Bookmark[];
  };
  add_bookmark: {
    readonly args: {
      readonly chapter: number;
      readonly frac: number;
      readonly label: string;
      readonly position: {
        readonly chapter: number;
        readonly anchor: unknown;
        readonly fraction: number;
      } | null;
    };
    readonly result: Bookmark[];
  };
  add_highlight: {
    readonly args: {
      readonly request: {
        readonly chapter: number;
        readonly start: number;
        readonly end: number;
        readonly text: string;
        readonly context: string;
        readonly rects: string;
        readonly color: string;
        readonly note: string;
        readonly rangeAnchor: unknown;
      };
    };
    readonly result: Highlight[];
  };
  set_highlight_text: {
    readonly args: { readonly index: number; readonly text: string };
    readonly result: Highlight[];
  };
  remove_highlight: {
    readonly args: { readonly index: number };
    readonly result: Highlight[];
  };
  set_highlight_note: {
    readonly args: { readonly index: number; readonly note: string };
    readonly result: Highlight[];
  };
};

type VerifiedReaderNotesCommands = ReaderNotesCommands extends TauriCommandMap
  ? ReaderNotesCommands
  : never;

interface ReaderShellApi {
  readonly OVERLAY: {
    readonly TOC: unknown;
    readonly SETTINGS: unknown;
    readonly ANNOTATIONS: unknown;
  };
  setOverlay(overlay: unknown, open: boolean): void;
  registerOverlay(overlay: unknown, handlers: { readonly onOpen: () => void }): void;
  isOverlay(overlay: unknown): boolean;
  closeOverlay(): void;
}

interface ReaderNotesRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly ReaderShell: ReaderShellApi;
  readonly ReaderI18n?: {
    t?(key: string, values?: Readonly<Record<string, unknown>>): string;
  };
  readonly ReaderSettings?: {
    clickActionAt?(x: number, y: number, width: number, height: number): string;
  };
  readonly curChapter?: unknown;
  readonly curProgress?: unknown;
  readonly curChFrac?: unknown;
  readonly curReadingAnchor?: unknown;
  readonly isPdf?: unknown;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly performance: Pick<Performance, "now">;
  readonly requestIdleCallback?: (
    callback: (deadline: IdleDeadline | null) => void,
    options?: IdleRequestOptions,
  ) => number;
  readonly pauseReadTracking?: (source: string) => void;
  readonly toggleReaderToolbar?: () => void;
  readonly keepImmersiveBarAfterNav?: () => void;
  readonly setReaderSettingsOpen?: (open: boolean) => void;
  readonly rememberReaderJumpPosition?: (source: string | { readonly kind: string }) => void;
  pendingReaderToc?: unknown;
  pendingReaderNotesSnapshot?: unknown;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  scheduleTocBuild?: (toc: unknown) => void;
  initializeReaderNotes?: (snapshot: ReaderNotesSnapshot) => void;
  markToc?: (element: Element | null) => void;
  renderBookmarks?: () => void;
  renderHighlights?: () => void;
  addHighlight?: (
    request: HighlightRequest,
    note?: string,
    openNote?: boolean,
    openCorrect?: boolean,
  ) => Promise<void>;
  addCorrectedHighlight?: (request: HighlightRequest, correctedText: string) => Promise<void>;
  openAnnotations?: (index?: number, animateAdded?: boolean) => void;
  buildToc?: (toc: readonly TocEntry[]) => void;
}

export interface ReaderNotesHost {
  readonly currentChapter: number;
  readonly currentProgress: number;
  readonly currentChapterFraction: number;
  readonly currentReadingAnchor: unknown;
  readonly pdf: boolean;
  sendToPage(message: Readonly<Record<string, unknown>>): void;
  setSettingsOpen(open: boolean): void;
}

export interface ReaderNotesUiController {
  readonly addCorrectedHighlight: (
    request: HighlightRequest,
    correctedText: string,
  ) => Promise<void>;
  readonly addHighlight: (
    request: HighlightRequest,
    note?: string,
    openNote?: boolean,
    openCorrect?: boolean,
  ) => Promise<void>;
  readonly buildToc: (toc: readonly TocEntry[]) => void;
  readonly initializeReaderNotes: (snapshot: ReaderNotesSnapshot) => void;
  readonly markToc: (element: Element | null) => void;
  readonly openAnnotations: (index?: number, animateAdded?: boolean) => void;
  readonly renderBookmarks: () => void;
  readonly renderHighlights: () => void;
  readonly scheduleTocBuild: (toc: unknown) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ReaderNotesRuntime | null {
  const runtime = record(value);
  if (
    !runtime ||
    !record(runtime.document) ||
    !record(runtime.ReaderShell) ||
    !record(runtime.performance) ||
    typeof runtime.innerWidth !== "number" ||
    typeof runtime.innerHeight !== "number" ||
    typeof runtime.setTimeout !== "function"
  ) {
    return null;
  }
  return runtime as unknown as ReaderNotesRuntime;
}

function requiredElement<TElement extends HTMLElement>(document: Document, id: string): TElement {
  return document.getElementById(id) as TElement;
}

function classicReaderNotesHost(runtime: ReaderNotesRuntime): ReaderNotesHost {
  return {
    get currentChapter(): number {
      return Number(runtime.curChapter) || 0;
    },
    get currentProgress(): number {
      return Number(runtime.curProgress) || 0;
    },
    get currentChapterFraction(): number {
      return Number(runtime.curChFrac) || 0;
    },
    get currentReadingAnchor(): unknown {
      return runtime.curReadingAnchor ?? null;
    },
    get pdf(): boolean {
      return runtime.isPdf === true;
    },
    sendToPage(message): void {
      const sender = runtime.sendToPage;
      if (typeof sender === "function") sender(message);
    },
    setSettingsOpen(open): void {
      runtime.setReaderSettingsOpen?.(open);
    },
  };
}

export function initializeReaderNotesUi(
  runtime: ReaderNotesRuntime,
  transport: TauriTransport,
  host: ReaderNotesHost,
): ReaderNotesUiController {
  const api = createTauriApi<VerifiedReaderNotesCommands>(transport);
  const document = runtime.document;
  const shell = runtime.ReaderShell;
  const tocPane = requiredElement<HTMLElement>(document, "toc-pane");
  const bmPane = requiredElement<HTMLElement>(document, "bm-pane");
  const bmList = requiredElement<HTMLElement>(document, "bm-list2");
  const annoModal = requiredElement<HTMLElement>(document, "anno-modal");
  const annoList = requiredElement<HTMLElement>(document, "anno-list");
  let tocBuildVersion = 0;
  let bookmarks: Bookmark[] = [];
  let highlights: Highlight[] = [];

  const readerNotesText = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ): string => {
    const value = runtime.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  };
  const setToc = (open: unknown): void => {
    shell.setOverlay(shell.OVERLAY.TOC, Boolean(open));
  };
  const markToc = (element: Element | null): void => {
    tocPane
      .querySelectorAll<HTMLElement>(".toc-item")
      .forEach((item) => item.classList.remove("toc-current"));
    if (!element) return;
    element.classList.add("toc-current");
    element.scrollIntoView({ block: "center" });
  };
  const highlightCurrentToc = (): void => {
    const items = [...tocPane.querySelectorAll<HTMLElement>(".toc-item")];
    items.forEach((item) => item.classList.remove("toc-current"));
    const inChapter = items.filter(
      (item) => Number.parseInt(item.dataset.chapter || "-1", 10) === host.currentChapter,
    );
    if (inChapter.length > 1) {
      host.sendToPage({ resolveToc: inChapter.map((item) => item.dataset.frag || "") });
      return;
    }
    let best: HTMLElement | null = null;
    let bestChapter = -1;
    items.forEach((item) => {
      const chapter = Number.parseInt(item.dataset.chapter || "-1", 10);
      if (chapter <= host.currentChapter && chapter > bestChapter) {
        best = item;
        bestChapter = chapter;
      }
    });
    markToc(best);
  };
  const renderBookmarks = (): void => {
    bmList.innerHTML = "";
    if (!bookmarks.length) {
      const empty = document.createElement("div");
      empty.className = "bm-empty";
      empty.textContent = readerNotesText("noBookmarks", "暂无书签");
      bmList.appendChild(empty);
      return;
    }
    bookmarks.forEach((bookmark, index) => {
      const item = document.createElement("div");
      item.className = "bm-item";
      const text = document.createElement("span");
      text.className = "bm-text";
      let label =
        bookmark.label ||
        readerNotesText("bookmarkLocation", "第 {chapter} {part}", {
          chapter: (bookmark.chapter || 0) + 1,
          part: host.pdf
            ? readerNotesText("page", "页")
            : readerNotesText("chapter", "章"),
        });
      if (host.pdf) {
        label = label.replace(
          /^(第\s*\d+\s*)章/u,
          `$1${readerNotesText("page", "页")}`,
        );
      }
      text.textContent = label;
      const remove = document.createElement("span");
      remove.className = "bm-del";
      remove.textContent = "✕";
      item.append(text, remove);
      item.addEventListener("click", async (event) => {
        if (event.target === remove) {
          bookmarks = await api.invoke("remove_bookmark", { index });
          renderBookmarks();
          return;
        }
        runtime.rememberReaderJumpPosition?.({ kind: "bookmark" });
        host.sendToPage({
          gotoChapter: bookmark.chapter || 0,
          chFrac: bookmark.frac || 0,
        });
      });
      bmList.appendChild(item);
    });
  };
  const renderHighlights = (): void => {
    if (shell.isOverlay(shell.OVERLAY.ANNOTATIONS)) renderAnnotations();
  };
  const setTocTab = (which: string): void => {
    const isToc = which === "toc";
    requiredElement<HTMLElement>(document, "tab-toc").classList.toggle("active", isToc);
    requiredElement<HTMLElement>(document, "tab-bm").classList.toggle("active", !isToc);
    tocPane.hidden = !isToc;
    bmPane.hidden = isToc;
    if (isToc) highlightCurrentToc();
    else renderBookmarks();
  };
  shell.registerOverlay(shell.OVERLAY.TOC, {
    onOpen(): void {
      runtime.pauseReadTracking?.("toc");
      setTocTab("toc");
    },
  });
  requiredElement<HTMLElement>(document, "tab-toc").addEventListener("click", () =>
    setTocTab("toc"),
  );
  requiredElement<HTMLElement>(document, "tab-bm").addEventListener("click", () =>
    setTocTab("bm"),
  );
  requiredElement<HTMLElement>(document, "toc-btn").addEventListener("click", () => {
    setToc(!shell.isOverlay(shell.OVERLAY.TOC));
  });
  requiredElement<HTMLElement>(document, "backdrop").addEventListener("click", (event) => {
    shell.closeOverlay();
    const pointer = event as MouseEvent;
    if (
      runtime.ReaderSettings?.clickActionAt?.(
        pointer.clientX,
        pointer.clientY,
        runtime.innerWidth,
        runtime.innerHeight,
      ) === "center"
    ) {
      runtime.toggleReaderToolbar?.();
    }
  });
  requiredElement<HTMLElement>(document, "gear-btn").addEventListener("click", () => {
    host.setSettingsOpen(!shell.isOverlay(shell.OVERLAY.SETTINGS));
  });
  requiredElement<HTMLElement>(document, "prev-btn").addEventListener("click", () => {
    runtime.keepImmersiveBarAfterNav?.();
    runtime.rememberReaderJumpPosition?.({ kind: "chapter" });
    host.sendToPage({ gotoChapter: Math.max(0, host.currentChapter - 1) });
  });
  requiredElement<HTMLElement>(document, "next-btn").addEventListener("click", () => {
    runtime.keepImmersiveBarAfterNav?.();
    runtime.rememberReaderJumpPosition?.({ kind: "chapter" });
    host.sendToPage({ gotoChapter: host.currentChapter + 1 });
  });

  const createTocItem = (entry: TocEntry): HTMLElement => {
    const item = document.createElement("div");
    item.className = "toc-item";
    item.style.paddingLeft = `${8 + entry.level * 14}px`;
    item.textContent = entry.label;
    item.title = entry.label;
    item.dataset.chapter = String(entry.chapter);
    item.dataset.frag = entry.frag || "";
    item.addEventListener("click", () => {
      runtime.rememberReaderJumpPosition?.("toc");
      host.sendToPage({ gotoChapter: entry.chapter, frag: entry.frag || undefined });
      setToc(false);
    });
    return item;
  };
  const renderEmptyToc = (): void => {
    const hint = document.createElement("div");
    hint.className = "toc-item";
    hint.style.color = "#999";
    hint.textContent = readerNotesText("noToc", "（无目录）");
    tocPane.appendChild(hint);
  };
  const buildToc = (toc: readonly TocEntry[]): void => {
    tocBuildVersion += 1;
    tocPane.innerHTML = "";
    if (!toc.length) {
      renderEmptyToc();
      return;
    }
    toc.forEach((entry) => tocPane.appendChild(createTocItem(entry)));
  };
  const scheduleTocBuild = (toc: unknown): void => {
    const entries = Array.isArray(toc) ? (toc as TocEntry[]) : [];
    const version = ++tocBuildVersion;
    tocPane.innerHTML = "";
    if (!entries.length) {
      renderEmptyToc();
      return;
    }
    const loading = document.createElement("div");
    loading.className = "toc-item";
    loading.style.color = "#999";
    loading.textContent = readerNotesText("loading", "加载中…");
    tocPane.appendChild(loading);
    let index = 0;
    const schedule = (callback: (deadline: IdleDeadline | null) => void): void => {
      if (typeof runtime.requestIdleCallback === "function") {
        runtime.requestIdleCallback(callback, { timeout: 500 });
      } else {
        runtime.setTimeout(() => callback(null), 16);
      }
    };
    const appendBatch = (deadline: IdleDeadline | null): void => {
      if (version !== tocBuildVersion) return;
      const fragment = document.createDocumentFragment();
      const started = runtime.performance.now();
      let added = 0;
      while (index < entries.length && added < 120) {
        if (added >= 20 && runtime.performance.now() - started >= 6) break;
        if (added >= 20 && deadline?.timeRemaining && deadline.timeRemaining() < 2) break;
        const entry = entries[index];
        if (entry) fragment.appendChild(createTocItem(entry));
        index += 1;
        added += 1;
      }
      if (loading.isConnected) loading.remove();
      tocPane.appendChild(fragment);
      if (index < entries.length) schedule(appendBatch);
      else if (shell.isOverlay(shell.OVERLAY.TOC)) highlightCurrentToc();
    };
    schedule(appendBatch);
  };

  const initializeReaderNotes = (snapshot: ReaderNotesSnapshot): void => {
    bookmarks = Array.isArray(snapshot?.bookmarks) ? [...snapshot.bookmarks] : [];
    highlights = Array.isArray(snapshot?.highlights) ? [...snapshot.highlights] : [];
    renderBookmarks();
    renderHighlights();
  };
  const addHighlight = async (
    request: HighlightRequest,
    note = "",
    openNote = false,
    openCorrect = false,
  ): Promise<void> => {
    highlights = await api.invoke("add_highlight", {
      request: {
        chapter: request.chapter,
        start: request.start,
        end: request.end,
        text: request.text || "",
        context: request.context || "",
        rects: request.rects || "",
        color: request.color || "y",
        note: note || "",
        rangeAnchor: request.range_anchor || null,
      },
    });
    host.sendToPage({ highlights });
    if (openNote) openAnnotations(highlights.length - 1, true);
    else if (openCorrect && !host.pdf) {
      host.sendToPage({ editHighlightTextFor: highlights.length - 1 });
    }
  };
  const addCorrectedHighlight = async (
    request: HighlightRequest,
    correctedText: string,
  ): Promise<void> => {
    const text = (correctedText || "").trim();
    if (!text) return;
    highlights = await api.invoke("add_highlight", {
      request: {
        chapter: request.chapter,
        start: request.start,
        end: request.end,
        text: request.text || "",
        context: request.context || "",
        rects: request.rects || "",
        color: request.color || "y",
        note: "",
        rangeAnchor: request.range_anchor || null,
      },
    });
    const index = highlights.length - 1;
    highlights = await api.invoke("set_highlight_text", { index, text });
    host.sendToPage({ highlights });
    renderHighlights();
  };
  const contextHtml = (highlight: Highlight): string => {
    const display = (highlight.corrected_text || highlight.text || "").trim();
    return display.replace(/[&<>]/gu, (character) => {
      const escaped: Readonly<Record<string, string>> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
      };
      return escaped[character] ?? character;
    });
  };
  function renderAnnotations(targetIndex?: number, animateTarget?: boolean): void {
    annoList.innerHTML = "";
    if (!highlights.length) {
      annoList.innerHTML =
        '<div class="anno-empty">' +
        readerNotesText(
          "noAnnotations",
          "还没有批注 / 高亮。<br>在正文里选中文字 → 点「高亮」或「批注」即可添加。",
        ) +
        "</div>";
      return;
    }
    highlights.forEach((highlight, index) => {
      const item = document.createElement("div");
      item.className = "anno-item";
      if (index === targetIndex) item.classList.add("target");
      if (index === targetIndex && animateTarget) item.classList.add("annotation-added");
      const meta = document.createElement("div");
      meta.className = "anno-meta";
      const chapter = document.createElement("span");
      chapter.className = "anno-ch";
      chapter.textContent = readerNotesText("annotationChapter", "第 {chapter} 章 · 跳转", {
        chapter: (highlight.chapter || 0) + 1,
      });
      chapter.addEventListener("click", () => {
        host.sendToPage({ gotoHighlight: index });
        shell.setOverlay(shell.OVERLAY.ANNOTATIONS, false);
      });
      const editButton = document.createElement("span");
      editButton.className = "anno-edit-btn";
      editButton.textContent = highlight.note
        ? readerNotesText("editAnnotation", "编辑批注")
        : readerNotesText("addAnnotation", "添加批注");
      const remove = document.createElement("span");
      remove.className = "anno-del";
      remove.textContent = readerNotesText("delete", "删除");
      remove.addEventListener("click", async () => {
        highlights = await api.invoke("remove_highlight", { index });
        host.sendToPage({ highlights });
        renderAnnotations();
      });
      meta.append(chapter, editButton, remove);
      const context = document.createElement("div");
      context.className = "anno-ctx";
      context.title = readerNotesText("highlightedText", "高亮文字");
      context.innerHTML = contextHtml(highlight);
      const noteView = document.createElement("div");
      noteView.className = "anno-note-view";
      noteView.textContent = highlight.note || "";
      if (!highlight.note) noteView.style.display = "none";
      const edit = document.createElement("div");
      edit.className = "anno-edit";
      const textarea = document.createElement("textarea");
      textarea.className = "anno-note";
      textarea.value = highlight.note || "";
      const actions = document.createElement("div");
      actions.className = "anno-edit-actions";
      const cancel = document.createElement("button");
      cancel.textContent = readerNotesText("cancel", "取消");
      cancel.className = "cancel";
      const save = document.createElement("button");
      save.textContent = readerNotesText("save", "保存");
      save.className = "save";
      actions.append(cancel, save);
      edit.append(textarea, actions);
      editButton.addEventListener("click", () => {
        const opening = !edit.classList.contains("open");
        edit.classList.toggle("open", opening);
        if (opening) {
          textarea.value = highlight.note || "";
          textarea.focus();
        }
      });
      cancel.addEventListener("click", () => edit.classList.remove("open"));
      save.addEventListener("click", async () => {
        highlights = await api.invoke("set_highlight_note", {
          index,
          note: textarea.value,
        });
        host.sendToPage({ highlights });
        highlight.note = textarea.value;
        noteView.textContent = textarea.value;
        noteView.style.display = textarea.value ? "" : "none";
        editButton.textContent = textarea.value
          ? readerNotesText("editAnnotation", "编辑批注")
          : readerNotesText("addAnnotation", "添加批注");
        edit.classList.remove("open");
      });
      item.append(meta, context, noteView, edit);
      annoList.appendChild(item);
    });
  }
  const openAnnotations = (index?: number, animateAdded?: boolean): void => {
    shell.setOverlay(shell.OVERLAY.ANNOTATIONS, true);
    renderAnnotations(index, animateAdded);
    if (typeof index === "number") {
      const items = annoList.querySelectorAll<HTMLElement>(".anno-item");
      const item = items[index];
      if (item) {
        item.scrollIntoView({ block: "center" });
        item.querySelector<HTMLElement>(".anno-edit")?.classList.add("open");
        const textarea = item.querySelector<HTMLTextAreaElement>(".anno-note");
        if (textarea) runtime.setTimeout(() => textarea.focus(), 50);
      }
    }
  };
  shell.registerOverlay(shell.OVERLAY.ANNOTATIONS, {
    onOpen(): void {
      runtime.pauseReadTracking?.("annotations");
    },
  });
  requiredElement<HTMLElement>(document, "hl-btn").addEventListener("click", (event) => {
    event.stopPropagation();
    openAnnotations();
  });
  requiredElement<HTMLElement>(document, "anno-close").addEventListener("click", () => {
    shell.setOverlay(shell.OVERLAY.ANNOTATIONS, false);
  });
  annoModal.addEventListener("click", (event) => {
    if (event.target === annoModal) shell.setOverlay(shell.OVERLAY.ANNOTATIONS, false);
  });
  requiredElement<HTMLElement>(document, "bm-add2").addEventListener("click", async () => {
    const label = readerNotesText("bookmarkProgress", "第 {chapter} {part} · {progress}%", {
      chapter: host.currentChapter + 1,
      part: host.pdf ? readerNotesText("page", "页") : readerNotesText("chapter", "章"),
      progress: host.currentProgress.toFixed(1),
    });
    bookmarks = await api.invoke("add_bookmark", {
      chapter: host.currentChapter,
      frac: host.currentChapterFraction,
      label,
      position: host.currentReadingAnchor
        ? {
            chapter: host.currentChapter,
            anchor: host.currentReadingAnchor,
            fraction: host.currentChapterFraction,
          }
        : null,
    });
    renderBookmarks();
  });

  const controller: ReaderNotesUiController = {
    addCorrectedHighlight,
    addHighlight,
    buildToc,
    initializeReaderNotes,
    markToc,
    openAnnotations,
    renderBookmarks,
    renderHighlights,
    scheduleTocBuild,
  };
  runtime.scheduleTocBuild = scheduleTocBuild;
  runtime.initializeReaderNotes = initializeReaderNotes;
  runtime.markToc = markToc;
  runtime.renderBookmarks = renderBookmarks;
  runtime.renderHighlights = renderHighlights;
  runtime.addHighlight = addHighlight;
  runtime.addCorrectedHighlight = addCorrectedHighlight;
  runtime.openAnnotations = openAnnotations;
  runtime.buildToc = buildToc;
  Object.defineProperty(runtime, "bookmarks", {
    configurable: true,
    get: () => bookmarks,
    set: (value: unknown) => {
      bookmarks = Array.isArray(value) ? (value as Bookmark[]) : [];
    },
  });
  Object.defineProperty(runtime, "highlights", {
    configurable: true,
    get: () => highlights,
    set: (value: unknown) => {
      highlights = Array.isArray(value) ? (value as Highlight[]) : [];
    },
  });
  if (Array.isArray(runtime.pendingReaderToc)) {
    const pending = runtime.pendingReaderToc;
    runtime.pendingReaderToc = null;
    scheduleTocBuild(pending);
  }
  if (runtime.pendingReaderNotesSnapshot) {
    const pending = runtime.pendingReaderNotesSnapshot;
    runtime.pendingReaderNotesSnapshot = null;
    initializeReaderNotes(pending as ReaderNotesSnapshot);
  }
  return controller;
}

/** Classic installer replacing `ui/reader-notes-ui.js` at its existing script position. */
export function installReaderNotesUi(
  target: unknown,
  transport?: TauriTransport,
  host?: ReaderNotesHost,
): ReaderNotesUiController | null {
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
  return initializeReaderNotesUi(runtime, resolvedTransport, host ?? classicReaderNotesHost(runtime));
}
