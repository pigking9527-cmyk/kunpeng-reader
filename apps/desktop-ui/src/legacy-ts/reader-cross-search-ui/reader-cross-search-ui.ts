import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";

declare const curChapter: number;

type CrossSearchMode = "keyword" | "semantic";

interface CrossSearchShell {
  readonly OVERLAY: { readonly CROSS_SEARCH: string };
  setOverlay(name: string, open: boolean): void;
}

interface CrossSearchContext {
  currentChapter?(): unknown;
}

interface CrossSearchRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly localStorage?: Storage;
  readonly ReaderI18n?: {
    t?(key: string, values?: Readonly<Record<string, unknown>>): string;
  };
  readonly ReaderShell?: CrossSearchShell;
  readonly ReaderCrossSearchContext?: CrossSearchContext;
  readonly currentBookId?: unknown;
  readonly curChapter?: unknown;
  readonly readerDebugSettingOn?: (key: string) => boolean;
  readonly pauseReadTracking?: (reason: string) => unknown;
  updateCrossReturnButton?: () => void;
  consumePendingCrossSearch?: () => void;
  openCrossSearch?: (term: unknown) => void;
  openSemanticSearch?: (term: unknown) => void;
  addEventListener: Window["addEventListener"];
  setTimeout: typeof globalThis.setTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

interface CrossHit {
  readonly chapter?: unknown;
  readonly snippet?: unknown;
  readonly score?: unknown;
}

interface CrossBook {
  readonly book_id?: unknown;
  readonly title?: unknown;
  readonly author?: unknown;
  readonly count?: unknown;
  readonly hits?: unknown;
}

interface CrossSearchResponse {
  readonly results?: unknown;
  readonly pendingBooks?: unknown;
}

interface CrossReturnState {
  readonly originBookId?: unknown;
  readonly originChapter?: unknown;
  readonly targetBookId?: unknown;
  readonly targetChapter?: unknown;
  readonly term?: unknown;
  readonly lastTerm?: unknown;
  readonly mode?: unknown;
  readonly lastMode?: unknown;
  readonly chain?: unknown;
  readonly ts?: unknown;
}

interface PendingCrossSearch {
  readonly term?: unknown;
  readonly mode?: unknown;
  readonly originBookId?: unknown;
}

export interface ReaderCrossSearchUiApi {
  readonly crossModal: HTMLElement;
  readonly crossTitle: HTMLElement;
  readonly crossInput: HTMLInputElement;
  readonly crossStatus: HTMLElement;
  readonly crossResults: HTMLElement;
  readonly crossRun: HTMLElement;
  readonly crossReturn: HTMLElement | null;
  readonly updateCrossReturnButton: () => void;
  readonly consumePendingCrossSearch: () => void;
  readonly openCrossSearch: (term: unknown) => void;
  readonly openSemanticSearch: (term: unknown) => void;
  readonly runCrossSearch: (term: unknown) => Promise<void>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asBook(value: unknown): CrossBook {
  return asRecord(value);
}

function asHit(value: unknown): CrossHit {
  return asRecord(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function installReaderCrossSearchUi(
  global: CrossSearchRuntime,
  transport?: TauriTransport | null,
): ReaderCrossSearchUiApi | null {
  const documentCandidate = global.document;
  const shellCandidate = global.ReaderShell;
  const storageCandidate = global.localStorage;
  const modalCandidate = documentCandidate?.getElementById("cross-modal");
  const titleCandidate = documentCandidate?.getElementById("cross-title");
  const inputCandidate = documentCandidate?.getElementById("cross-input");
  const statusCandidate = documentCandidate?.getElementById("cross-status");
  const resultsCandidate = documentCandidate?.getElementById("cross-results");
  const closeCandidate = documentCandidate?.getElementById("cross-close");
  const runCandidate = documentCandidate?.getElementById("cross-run");
  const returnCandidate = documentCandidate?.getElementById("cross-return");
  if (
    !documentCandidate || !shellCandidate || !storageCandidate || !modalCandidate ||
    !titleCandidate || !inputCandidate || !("value" in inputCandidate) || !statusCandidate ||
    !resultsCandidate || !closeCandidate || !runCandidate
  ) return null;

  const document: Document = documentCandidate;
  const shell: CrossSearchShell = shellCandidate;
  const storage: Storage = storageCandidate;
  const crossModal: HTMLElement = modalCandidate;
  const crossTitle: HTMLElement = titleCandidate;
  const crossInput = inputCandidate as HTMLInputElement;
  const crossStatus: HTMLElement = statusCandidate;
  const crossResults: HTMLElement = resultsCandidate;
  const crossClose: HTMLElement = closeCandidate;
  const crossRun: HTMLElement = runCandidate;
  const crossReturn: HTMLElement | null = returnCandidate ?? null;
  let resolvedTransport = transport ?? null;
  if (transport === undefined) {
    try { resolvedTransport = transportFromTauriGlobal(global); } catch { resolvedTransport = null; }
  }

  const readerCrossText = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ): string => {
    const value = global.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  };
  let crossSeq = 0;
  let crossTerm = "";
  let crossMode: CrossSearchMode = "keyword";
  let crossLastResults: unknown[] = [];
  let crossExpanded = new Map<string, number>();
  let crossCollapsed = new Set<string>();
  let crossReturnPoll: ReturnType<typeof globalThis.setInterval> | 0 = 0;

  function crossEscapeHtml(value: unknown): string {
    const replacements: Readonly<Record<string, string>> = {
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
    };
    return String(value || "").replace(/[&<>]/g, (character) => replacements[character] ?? character);
  }
  function crossHighlight(snippetValue: unknown, termValue: unknown): string {
    const snippet = String(snippetValue || "");
    if (crossMode === "semantic") return crossEscapeHtml(snippet);
    const term = String(termValue || "").trim();
    if (!term) return crossEscapeHtml(snippet);
    const low = snippet.toLowerCase();
    const loweredTerm = term.toLowerCase();
    let html = "";
    let last = 0;
    let index = low.indexOf(loweredTerm);
    while (index >= 0) {
      html += `${crossEscapeHtml(snippet.slice(last, index))}<mark>${crossEscapeHtml(snippet.slice(index, index + term.length))}</mark>`;
      last = index + term.length;
      index = low.indexOf(loweredTerm, last);
    }
    return html + crossEscapeHtml(snippet.slice(last));
  }
  function closeCrossSearch(): void {
    shell.setOverlay(shell.OVERLAY.CROSS_SEARCH, false);
  }
  function crossCurrentBookId(): string {
    return String(global.currentBookId || "");
  }
  function crossCurrentChapter(): number {
    if (typeof curChapter === "number") return curChapter;
    const contextValue = global.ReaderCrossSearchContext?.currentChapter?.();
    if (typeof contextValue === "number") return contextValue;
    return typeof global.curChapter === "number" ? global.curChapter : 0;
  }
  function crossResultLimit(book: CrossBook): number {
    const bookId = String(book.book_id || "");
    return Math.max(8, crossExpanded.get(bookId) || 8);
  }
  function crossHitCount(book: CrossBook): number {
    return Number(book.count || asArray(book.hits).length || 0);
  }
  function updateCrossModeUi(): void {
    crossTitle.textContent = crossMode === "semantic"
      ? readerCrossText("crossSemanticTitle", "相似语义")
      : readerCrossText("crossKeywordTitle", "跨书搜索");
    crossRun.textContent = crossMode === "semantic"
      ? readerCrossText("find", "查找")
      : readerCrossText("search", "搜索");
    crossInput.placeholder = crossMode === "semantic"
      ? readerCrossText("crossSemanticPlaceholder", "输入字、词、句、段，查找全书架相似文本")
      : "";
  }
  function readCrossReturnState(): CrossReturnState | null {
    try {
      const state = asRecord(JSON.parse(storage.getItem("crossReturnState") || "null"));
      if (!state.originBookId || Date.now() - Number(state.ts || 0) > 24 * 60 * 60 * 1_000) return null;
      return state;
    } catch {
      return null;
    }
  }
  function crossStoreReturnTarget(bookId: string, chapter: unknown): void {
    const currentBookId = crossCurrentBookId();
    if (!currentBookId || !bookId || bookId === currentBookId) return;
    const existing = readCrossReturnState();
    const keepFirstOrigin = Boolean(
      existing && String(existing.originBookId || "") && String(existing.originBookId) !== currentBookId,
    );
    const originBookId = keepFirstOrigin ? String(existing?.originBookId) : currentBookId;
    const state = {
      originBookId,
      originChapter: keepFirstOrigin ? Number(existing?.originChapter || 0) : crossCurrentChapter(),
      targetBookId: bookId,
      targetChapter: chapter || 0,
      term: keepFirstOrigin ? String(existing?.term || crossTerm) : crossTerm,
      lastTerm: crossTerm,
      mode: keepFirstOrigin ? String(existing?.mode || crossMode) : crossMode,
      lastMode: crossMode,
      chain: keepFirstOrigin ? String(existing?.chain || "") : String(Date.now()),
      ts: Date.now(),
    };
    storage.setItem("crossReturnState", JSON.stringify(state));
    updateCrossReturnButton();
  }
  function updateCrossReturnButton(): void {
    if (!crossReturn) return;
    const state = readCrossReturnState();
    const current = crossCurrentBookId();
    const show = Boolean(state && current && String(state.originBookId) !== current);
    crossReturn.classList.toggle("show", show);
  }
  function scheduleCrossReturnRefresh(): void {
    if (!crossReturn || crossReturnPoll) return;
    let ticks = 0;
    crossReturnPoll = global.setInterval(() => {
      ticks += 1;
      updateCrossReturnButton();
      if (crossCurrentBookId() || ticks >= 12) {
        global.clearInterval(crossReturnPoll);
        crossReturnPoll = 0;
      }
    }, 250);
  }
  function consumePendingCrossSearch(): void {
    let pending: PendingCrossSearch | null = null;
    try {
      const parsed = JSON.parse(storage.getItem("pendingCrossSearch") || "null");
      pending = typeof parsed === "object" && parsed !== null ? parsed as PendingCrossSearch : null;
    } catch {
      pending = null;
    }
    if (!pending?.term) return;
    const current = crossCurrentBookId();
    if (pending.originBookId && (!current || String(pending.originBookId) !== current)) {
      global.setTimeout(consumePendingCrossSearch, 250);
      return;
    }
    storage.removeItem("pendingCrossSearch");
    if (pending.mode === "semantic") openSemanticSearch(pending.term);
    else openCrossSearch(pending.term);
  }

  function renderCrossSearch(resultsValue: unknown): void {
    crossLastResults = asArray(resultsValue);
    crossResults.innerHTML = "";
    const list = crossLastResults;
    if (!list.length) {
      const hint = crossMode === "semantic"
        ? readerCrossText("crossSemanticEmpty", "语义索引里没有找到与「{term}」相似的文本。若很多书未建语义索引，请先建立索引。", { term: crossTerm })
        : readerCrossText("crossKeywordEmpty", "全书架没有找到「{term}」", { term: crossTerm });
      crossResults.innerHTML = `<div class="cross-empty">${hint}</div>`;
      crossStatus.textContent = readerCrossText("crossNotFound", "未找到");
      return;
    }
    const total = list.reduce<number>((sum, value) => sum + crossHitCount(asBook(value)), 0);
    crossStatus.textContent = readerCrossText("crossSummary", "{books} 本 · {hits} 处", {
      books: list.length, hits: total,
    });
    const fragment = document.createDocumentFragment();
    list.slice(0, 30).forEach((bookValue) => {
      const book = asBook(bookValue);
      const bookId = String(book.book_id || "");
      const hits = asArray(book.hits);
      const limit = Math.min(crossResultLimit(book), hits.length);
      const collapsed = crossCollapsed.has(bookId);
      const group = document.createElement("div");
      group.className = `cross-book${collapsed ? " collapsed" : ""}`;
      const head = document.createElement("div");
      head.className = "cross-head";
      head.innerHTML =
        `<span class="cross-toggle">${collapsed ? "▸" : "▾"}</span>` +
        `<span class="cross-title">${crossEscapeHtml(book.title || readerCrossText("crossUntitled", "未命名"))}</span>` +
        (book.author ? `<span class="cross-author">${crossEscapeHtml(book.author)}</span>` : "") +
        `<span class="cross-count">${readerCrossText("crossHitCount", "{count} 处", { count: crossHitCount(book) })}</span>`;
      head.addEventListener("click", () => {
        if (crossCollapsed.has(bookId)) crossCollapsed.delete(bookId);
        else crossCollapsed.add(bookId);
        renderCrossSearch(crossLastResults);
      });
      group.appendChild(head);
      hits.slice(0, limit).forEach((hitValue) => {
        const hit = asHit(hitValue);
        const item = document.createElement("div");
        item.className = "cross-hit";
        const score = Number(hit.score || 0);
        const scoreHtml = crossMode === "semantic" && score
          ? `<span class="cross-score">${readerCrossText("crossSimilarity", "相似 {score}", { score: Math.max(0, Math.min(1, score)).toFixed(2) })}</span>`
          : "";
        item.innerHTML = `<div class="cross-hit-line"><span class="cross-ch">${readerCrossText("crossChapter", "第{chapter}章", { chapter: Number(hit.chapter || 0) + 1 })}</span>${scoreHtml}${crossHighlight(hit.snippet || "", crossTerm)}</div>`;
        item.addEventListener("click", () => {
          crossStoreReturnTarget(bookId, hit.chapter || 0);
          void resolvedTransport?.invoke("open_book_at", {
            request: {
              id: String(book.book_id || ""),
              chapter: hit.chapter || 0,
              term: crossMode === "semantic" ? "" : crossTerm,
            },
          }).catch(() => undefined);
        });
        group.appendChild(item);
      });
      if (crossHitCount(book) > limit) {
        const more = document.createElement("button");
        more.className = "cross-more";
        const rest = crossHitCount(book) - limit;
        const canExpand = limit < hits.length;
        more.innerHTML =
          `<span class="cross-more-ico">${canExpand ? "+25" : "…"}</span>` +
          readerCrossText("crossMore", "另有 {count} 处{state}", {
            count: rest,
            state: canExpand
              ? readerCrossText("crossNotShown", "未显示")
              : readerCrossText("crossNotLoaded", "未载入"),
          });
        more.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!canExpand) return;
          crossExpanded.set(bookId, Math.min(limit + 25, hits.length));
          renderCrossSearch(crossLastResults);
        });
        group.appendChild(more);
      }
      fragment.appendChild(group);
    });
    crossResults.appendChild(fragment);
  }

  async function runCrossSearch(termValue: unknown): Promise<void> {
    const sequence = ++crossSeq;
    crossTerm = String(termValue || "").replace(/\s+/g, " ").trim();
    crossInput.value = crossTerm;
    updateCrossModeUi();
    if (!crossTerm) {
      crossStatus.textContent = "";
      crossResults.innerHTML = `<div class="cross-empty">${readerCrossText("crossEnterText", "输入文字后搜索")}</div>`;
      return;
    }
    crossStatus.textContent = readerCrossText("crossSearching", "检索中…");
    crossResults.innerHTML = `<div class="cross-empty">${readerCrossText("crossSearching", "检索中…")}</div>`;
    if (!resolvedTransport) return;
    try {
      const response: unknown = crossMode === "semantic"
        ? await resolvedTransport.invoke("semantic_search", { query: crossTerm, ids: null })
        : await resolvedTransport.invoke("shelf_search", { term: crossTerm, ids: null });
      if (sequence !== crossSeq) return;
      const responseRecord = asRecord(response) as CrossSearchResponse;
      const results = Array.isArray(response) ? response : asArray(responseRecord.results);
      renderCrossSearch(results);
      const pendingBooks = Array.isArray(response)
        ? 0
        : Math.max(0, Number(responseRecord.pendingBooks || 0));
      if (crossMode === "keyword" && pendingBooks) {
        crossStatus.textContent += readerCrossText("crossIndexing", "；{count} 本正在后台建立全文索引", {
          count: pendingBooks,
        });
      }
    } catch (error) {
      if (sequence !== crossSeq) return;
      crossStatus.textContent = readerCrossText("crossFailed", "检索失败");
      crossResults.innerHTML = `<div class="cross-empty">${readerCrossText("crossFailed", "检索失败")}：${crossEscapeHtml(String(error || ""))}</div>`;
    }
  }
  function openCrossSearch(termValue: unknown): void {
    const term = String(termValue || "").trim();
    if (!term) return;
    if (global.readerDebugSettingOn && !global.readerDebugSettingOn("reader_cross_search")) return;
    crossMode = "keyword";
    crossExpanded = new Map<string, number>();
    crossCollapsed = new Set<string>();
    global.pauseReadTracking?.("cross-search");
    shell.setOverlay(shell.OVERLAY.CROSS_SEARCH, true);
    crossInput.focus();
    crossInput.select();
    updateCrossModeUi();
    void runCrossSearch(term);
  }
  function openSemanticSearch(termValue: unknown): void {
    const term = String(termValue || "").trim();
    if (!term) return;
    if (global.readerDebugSettingOn && !global.readerDebugSettingOn("reader_cross_search")) return;
    crossMode = "semantic";
    crossExpanded = new Map<string, number>();
    crossCollapsed = new Set<string>();
    global.pauseReadTracking?.("semantic-search");
    shell.setOverlay(shell.OVERLAY.CROSS_SEARCH, true);
    void resolvedTransport?.invoke("warm_semantic_model").catch(() => undefined);
    crossInput.focus();
    crossInput.select();
    updateCrossModeUi();
    void runCrossSearch(term);
  }

  crossClose.addEventListener("click", closeCrossSearch);
  crossModal.addEventListener("click", (event) => {
    if (event.target === crossModal) closeCrossSearch();
  });
  crossRun.addEventListener("click", () => { void runCrossSearch(crossInput.value); });
  crossInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeCrossSearch();
    else if (event.key === "Enter") void runCrossSearch(crossInput.value);
  });
  if (crossReturn) {
    crossReturn.addEventListener("click", () => {
      const state = readCrossReturnState();
      if (!state) return;
      storage.setItem("pendingCrossSearch", JSON.stringify({
        term: state.term || state.lastTerm || "",
        mode: state.mode || state.lastMode || "keyword",
        originBookId: state.originBookId,
        ts: Date.now(),
      }));
      closeCrossSearch();
      void resolvedTransport?.invoke("open_book_at", {
        request: {
          id: String(state.originBookId),
          chapter: Number(state.originChapter || 0),
          term: "",
        },
      }).catch(() => undefined);
    });
    global.setTimeout(updateCrossReturnButton, 400);
    global.setTimeout(consumePendingCrossSearch, 900);
    scheduleCrossReturnRefresh();
  }
  global.addEventListener("reader-language-changed", () => {
    updateCrossModeUi();
    if (crossLastResults.length) renderCrossSearch(crossLastResults);
  });

  const publicApi = Object.freeze({
    crossModal,
    crossTitle,
    crossInput,
    crossStatus,
    crossResults,
    crossRun,
    crossReturn,
    updateCrossReturnButton,
    consumePendingCrossSearch,
    openCrossSearch,
    openSemanticSearch,
    runCrossSearch,
  });
  global.updateCrossReturnButton = updateCrossReturnButton;
  global.consumePendingCrossSearch = consumePendingCrossSearch;
  global.openCrossSearch = openCrossSearch;
  global.openSemanticSearch = openSemanticSearch;
  return publicApi;
}
