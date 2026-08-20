import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";

interface SearchHit {
  readonly chapter: number;
  readonly snippet: string;
}

interface ReaderSearchShell {
  readonly OVERLAY: { readonly SEARCH: string };
  isOverlay(name: string): boolean;
  setOverlay(name: string, open: boolean): void;
  registerOverlay(name: string, lifecycle: { onOpen(): void; onClose(): void }): void;
}

interface ReaderSearchRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly localStorage?: Storage;
  readonly location?: Location;
  readonly ReaderI18n?: {
    t?(key: string, values?: Readonly<Record<string, unknown>>): string;
  };
  readonly ReaderShell?: ReaderSearchShell;
  readonly frame?: HTMLIFrameElement;
  readonly isPdf?: boolean;
  isReaderSearchEditing?: () => boolean;
  sendToPage?: (message: unknown) => void;
  toggleSearch?: (show: unknown) => void;
  renderResults?: (term: unknown, hits: unknown) => void;
  runSearch?: (query: unknown) => void;
  addEventListener: Window["addEventListener"];
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
}

export interface ReaderSearchUiApi {
  readonly rsearch: HTMLElement;
  readonly rsearchInput: HTMLInputElement;
  readonly rsearchCount: HTMLElement;
  readonly rsearchResults: HTMLElement;
  readonly sendToPage: (message: unknown) => void;
  readonly renderResults: (term: unknown, hits: unknown) => void;
  readonly runSearch: (query: unknown) => void;
  readonly toggleSearch: (show: unknown) => void;
  readonly isReaderSearchEditing: () => boolean;
}

function isSearchHit(value: unknown): value is SearchHit {
  if (typeof value !== "object" || value === null) return false;
  const hit = value as Record<string, unknown>;
  return Number.isFinite(Number(hit.chapter)) && typeof hit.snippet === "string";
}

export function installReaderSearchUi(
  global: ReaderSearchRuntime,
  transport?: TauriTransport | null,
): ReaderSearchUiApi | null {
  const documentCandidate = global.document;
  const shellCandidate = global.ReaderShell;
  const frameCandidate = global.frame;
  const rsearchCandidate = documentCandidate?.getElementById("rsearch");
  const inputCandidate = documentCandidate?.getElementById("rsearch-input");
  const countCandidate = documentCandidate?.getElementById("rsearch-count");
  const resultsCandidate = documentCandidate?.getElementById("rsearch-results");
  const buttonCandidate = documentCandidate?.getElementById("rsearch-btn");
  const closeCandidate = documentCandidate?.getElementById("rsearch-close");
  const toolbarCandidate = documentCandidate?.querySelector<HTMLElement>(".toolbar");
  if (
    !documentCandidate || !shellCandidate || !frameCandidate || !rsearchCandidate ||
    !inputCandidate || !("value" in inputCandidate) || !countCandidate || !resultsCandidate ||
    !buttonCandidate || !closeCandidate || !toolbarCandidate
  ) return null;
  const document: Document = documentCandidate;
  const shell: ReaderSearchShell = shellCandidate;
  const frame: HTMLIFrameElement = frameCandidate;
  const rsearch: HTMLElement = rsearchCandidate;
  const rsearchInput: HTMLInputElement = inputCandidate as HTMLInputElement;
  const rsearchCount: HTMLElement = countCandidate;
  const rsearchResults: HTMLElement = resultsCandidate;
  const localStorage = global.localStorage;
  let resolvedTransport = transport ?? null;
  if (transport === undefined) {
    try { resolvedTransport = transportFromTauriGlobal(global); } catch { resolvedTransport = null; }
  }

  const readerSearchText = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ): string => {
    const value = global.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  };
  let searchTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let rsearchEditingUntil = 0;
  let rsearchComposing = false;
  let rsearchTerm = "";

  function keepRsearchEditing(): void {
    rsearchEditingUntil = Date.now() + 1_200;
  }
  function isReaderSearchEditing(): boolean {
    return shell.isOverlay(shell.OVERLAY.SEARCH) && (
      rsearchComposing || rsearch.contains(document.activeElement) || Date.now() < rsearchEditingUntil
    );
  }
  function sendToPage(message: unknown): void {
    if (!frame.contentWindow) return;
    let targetOrigin = "*";
    try {
      const origin = new URL(frame.src, global.location?.href).origin;
      if (origin && origin !== "null") targetOrigin = origin;
    } catch { /* wildcard fallback preserves opaque reader origins */ }
    frame.contentWindow.postMessage(message, targetOrigin);
  }
  function escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function toggleSearch(show: unknown): void {
    shell.setOverlay(shell.OVERLAY.SEARCH, Boolean(show));
  }

  let history: string[] = [];
  try {
    const saved = JSON.parse(localStorage?.getItem("rsearchHistory") || "[]");
    history = Array.isArray(saved) ? saved.filter((value): value is string => typeof value === "string") : [];
  } catch { history = []; }
  function saveHistory(): void {
    localStorage?.setItem("rsearchHistory", JSON.stringify(history.slice(0, 12)));
  }
  function addHistory(queryValue: unknown): void {
    const query = String(queryValue || "").trim();
    if (!query) return;
    history = history.filter((item) => item !== query);
    history.unshift(query);
    history = history.slice(0, 12);
    saveHistory();
  }

  function renderResults(termValue: unknown, hitsValue: unknown): void {
    const term = String(termValue || "");
    const hits = (Array.isArray(hitsValue) ? hitsValue : []).filter(isSearchHit);
    rsearchResults.innerHTML = "";
    rsearchCount.textContent = hits.length
      ? readerSearchText("searchHits", "约 {count} 处", { count: hits.length })
      : readerSearchText("searchNotFound", "未找到");
    const low = term.toLowerCase();
    hits.forEach((hit) => {
      const item = document.createElement("div");
      item.className = "rs-item";
      const chapter = document.createElement("span");
      chapter.className = "rs-ch";
      chapter.textContent = readerSearchText("searchLocation", "第{number}{unit}", {
        number: hit.chapter + 1,
        unit: global.isPdf
          ? readerSearchText("page", "页")
          : readerSearchText("chapter", "章"),
      });
      let html = "";
      const snippet = hit.snippet;
      const loweredSnippet = snippet.toLowerCase();
      let last = 0;
      let index = loweredSnippet.indexOf(low);
      while (index >= 0 && term.length > 0) {
        html += `${escapeHtml(snippet.slice(last, index))}<mark>${escapeHtml(snippet.slice(index, index + term.length))}</mark>`;
        last = index + term.length;
        index = loweredSnippet.indexOf(low, last);
      }
      html += escapeHtml(snippet.slice(last));
      const text = document.createElement("span");
      text.innerHTML = html;
      item.append(chapter, text);
      item.addEventListener("click", () => {
        addHistory(term);
        sendToPage(global.isPdf
          ? { gotoChapter: hit.chapter }
          : { gotoChapter: hit.chapter, search: term });
        toggleSearch(false);
      });
      rsearchResults.appendChild(item);
    });
  }

  function renderHistory(): void {
    rsearchResults.innerHTML = "";
    rsearchCount.textContent = "";
    if (!history.length) {
      const empty = document.createElement("div");
      empty.className = "rs-empty";
      empty.textContent = readerSearchText("searchHistoryEmpty", "暂无搜索记录");
      rsearchResults.appendChild(empty);
      return;
    }
    history.forEach((query) => {
      const item = document.createElement("div");
      item.className = "rs-item";
      item.style.display = "flex";
      item.style.justifyContent = "space-between";
      const text = document.createElement("span");
      text.textContent = query;
      const remove = document.createElement("span");
      remove.className = "rs-ch";
      remove.style.cursor = "pointer";
      remove.textContent = "✕";
      item.append(text, remove);
      item.addEventListener("click", (event) => {
        if (event.target === remove) {
          history = history.filter((itemValue) => itemValue !== query);
          saveHistory();
          renderHistory();
          return;
        }
        rsearchInput.value = query;
        runSearch(query);
      });
      rsearchResults.appendChild(item);
    });
  }

  function runSearch(queryValue: unknown): void {
    const query = String(queryValue || "").trim();
    rsearchTerm = query;
    if (!query) { renderHistory(); return; }
    rsearchCount.textContent = readerSearchText("searching", "搜索中…");
    if (global.isPdf) { sendToPage({ search: query }); return; }
    if (!resolvedTransport) return;
    void resolvedTransport.invoke<unknown>("search_book", { term: query }).then((hits) => {
      if (rsearchInput.value.trim() === query) renderResults(query, hits);
    }).catch(() => undefined);
  }

  shell.registerOverlay(shell.OVERLAY.SEARCH, {
    onOpen() {
      rsearchInput.value = "";
      renderHistory();
      keepRsearchEditing();
      rsearchInput.focus();
    },
    onClose() {
      rsearchComposing = false;
      rsearchEditingUntil = 0;
      sendToPage({ clearMarks: 1 });
      rsearchInput.value = "";
      rsearchCount.textContent = "";
      rsearchResults.innerHTML = "";
    },
  });
  buttonCandidate.addEventListener("click", () => toggleSearch(!shell.isOverlay(shell.OVERLAY.SEARCH)));
  closeCandidate.addEventListener("click", () => toggleSearch(false));
  toolbarCandidate.addEventListener("click", (event) => {
    if (!shell.isOverlay(shell.OVERLAY.SEARCH)) return;
    if ((event.target as Element | null)?.closest(".search-wrap")) return;
    toggleSearch(false);
  });
  rsearchInput.addEventListener("input", () => {
    keepRsearchEditing();
    if (searchTimer) global.clearTimeout(searchTimer);
    const query = rsearchInput.value.trim();
    searchTimer = global.setTimeout(() => runSearch(query), 350);
  });
  rsearchInput.addEventListener("focus", keepRsearchEditing);
  rsearchInput.addEventListener("compositionstart", () => { rsearchComposing = true; keepRsearchEditing(); });
  rsearchInput.addEventListener("compositionupdate", keepRsearchEditing);
  rsearchInput.addEventListener("compositionend", () => { rsearchComposing = false; keepRsearchEditing(); });
  rsearchInput.addEventListener("keydown", (event) => {
    keepRsearchEditing();
    if (event.key === "Escape") toggleSearch(false);
    else if (event.key === "Enter") addHistory(rsearchInput.value);
  });
  global.addEventListener("reader-language-changed", () => {
    if (shell.isOverlay(shell.OVERLAY.SEARCH)) runSearch(rsearchTerm || rsearchInput.value);
  });

  const publicApi = Object.freeze({
    rsearch,
    rsearchInput,
    rsearchCount,
    rsearchResults,
    sendToPage,
    renderResults,
    runSearch,
    toggleSearch,
    isReaderSearchEditing,
  });
  global.isReaderSearchEditing = isReaderSearchEditing;
  global.sendToPage = sendToPage;
  global.toggleSearch = toggleSearch;
  global.renderResults = renderResults;
  global.runSearch = runSearch;
  global.rsearch = rsearch;
  global.rsearchInput = rsearchInput;
  global.rsearchCount = rsearchCount;
  global.rsearchResults = rsearchResults;
  return publicApi;
}
