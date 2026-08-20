import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import {
  commonSearches,
  recordSearchQuery,
  removeSearchQuery,
  type CommonSearchEntry,
} from "../main-business/search-history-rules.js";
import {
  escapeHtml,
  highlightSnippet,
  sortSearchResults,
} from "../main-business/search-result-rules.js";

type SearchMode = "kw" | "sem";

interface SearchHit {
  readonly chapter: number;
  readonly snippet: string;
  readonly count?: number;
  readonly score?: number;
}

interface SearchBookResult {
  readonly book_id: string;
  readonly title?: string;
  readonly author?: string;
  readonly count?: number;
  readonly score?: number;
  readonly hits?: readonly SearchHit[];
}

interface KeywordSearchResponse {
  readonly results?: readonly SearchBookResult[];
  readonly pendingBooks?: number;
}

interface SemanticStatus {
  readonly building?: boolean;
  readonly current?: string;
  readonly done?: number;
  readonly error?: string;
  readonly model_ready?: boolean;
  readonly shard_done?: number;
  readonly shard_total?: number;
  readonly total?: number;
}

type SearchWindowCommands = {
  warm_semantic_model: { readonly result: boolean };
  shelf_search_book_hits: {
    readonly args: {
      readonly request: {
        readonly bookId: string;
        readonly term: string;
        readonly offset: number;
        readonly limit: number;
      };
    };
    readonly result: readonly SearchHit[];
  };
  open_book_at: {
    readonly args: {
      readonly request: {
        readonly id: string;
        readonly chapter: number;
        readonly term: string;
      };
    };
    readonly result: void;
  };
  semantic_search: {
    readonly args: { readonly query: string; readonly ids: readonly string[] | null };
    readonly result: readonly SearchBookResult[];
  };
  shelf_search: {
    readonly args: { readonly term: string; readonly ids: readonly string[] | null };
    readonly result: KeywordSearchResponse | readonly SearchBookResult[];
  };
  semantic_status: { readonly result: SemanticStatus };
  semantic_index_done: {
    readonly args: { readonly ids: readonly string[] | null };
    readonly result: boolean;
  };
  build_semantic_index: {
    readonly args: { readonly ids: readonly string[] | null };
    readonly result: void;
  };
};

type VerifiedSearchWindowCommands = SearchWindowCommands extends TauriCommandMap
  ? SearchWindowCommands
  : never;

interface SearchWindowEvents extends Record<string, unknown> {
  readonly "shelf-search-query": {
    readonly term?: string;
    readonly ids?: readonly string[];
  };
}

interface SearchStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface SearchDialogParent {
  readonly AppDialog?: {
    alert(
      message: string,
      options: {
        readonly title: string;
        readonly confirmLabel: string;
        readonly tone: "warning";
      },
    ): Promise<unknown>;
  };
}

interface SearchWindowRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: SearchStorage;
  readonly location: Pick<Location, "search">;
  readonly parent: SearchDialogParent;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  alert(message?: unknown): void;
  confirm(message?: string): boolean;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  setTimeout(handler: TimerHandler, timeout?: number): number;
  clearTimeout(handle?: number): void;
  setInterval(handler: TimerHandler, timeout?: number): number;
  clearInterval(handle?: number): void;
}

export interface SearchWindowController {
  readonly pollSemanticStatus: () => void;
  readonly runSearch: (term: unknown, options?: { readonly retry?: boolean }) => Promise<void>;
  readonly setMode: (mode: SearchMode) => Promise<void>;
}

const RESULT_GROUPS_PER_FRAME = 8;
const INITIAL_EXPANDED_BOOKS = 1;
const KEYWORD_RETRY_LIMIT = 180;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): SearchWindowRuntime | null {
  const runtime = record(value);
  if (
    !runtime ||
    !record(runtime.document) ||
    !record(runtime.localStorage) ||
    !record(runtime.location) ||
    !record(runtime.parent) ||
    typeof runtime.alert !== "function" ||
    typeof runtime.confirm !== "function" ||
    typeof runtime.addEventListener !== "function" ||
    typeof runtime.setTimeout !== "function" ||
    typeof runtime.clearTimeout !== "function" ||
    typeof runtime.setInterval !== "function" ||
    typeof runtime.clearInterval !== "function" ||
    typeof runtime.requestAnimationFrame !== "function"
  ) {
    return null;
  }
  return runtime as unknown as SearchWindowRuntime;
}

function requiredElement<TElement extends HTMLElement>(document: Document, id: string): TElement {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Shelf search window requires #${id}.`);
  return value as TElement;
}

function errorText(error: unknown): string {
  return String(error);
}

function parseHistory(storage: SearchStorage): string[] {
  try {
    const value = JSON.parse(storage.getItem("shelfSearchHistory") || "[]") as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseCommonSearches(storage: SearchStorage): Record<string, CommonSearchEntry | unknown> {
  try {
    const value = JSON.parse(storage.getItem("shelfSearchCommon") || "{}") as unknown;
    return record(value) ?? {};
  } catch {
    return {};
  }
}

function positiveNumber(value: unknown): number {
  return Math.max(0, Number(value) || 0);
}

export function initializeSearchWindow(
  runtime: SearchWindowRuntime,
  transport: TauriTransport,
): SearchWindowController {
  const document = runtime.document;
  const api = createTauriApi<VerifiedSearchWindowCommands>(transport);
  const events = api.events<SearchWindowEvents>();
  const qEl = requiredElement<HTMLInputElement>(document, "q");
  const goEl = requiredElement<HTMLButtonElement>(document, "go");
  const sortEl = requiredElement<HTMLSelectElement>(document, "sort");
  const summaryEl = requiredElement<HTMLElement>(document, "summary");
  const resultsEl = requiredElement<HTMLElement>(document, "results");
  const qhistEl = requiredElement<HTMLElement>(document, "qhistory");
  const searchAlert = requiredElement<HTMLDialogElement>(document, "search-alert");
  const searchAlertTitle = requiredElement<HTMLElement>(document, "search-alert-title");
  const searchAlertMessage = requiredElement<HTMLElement>(document, "search-alert-message");
  const searchAlertOk = requiredElement<HTMLButtonElement>(document, "search-alert-ok");
  const modeKw = requiredElement<HTMLButtonElement>(document, "mode-kw");
  const modeSem = requiredElement<HTMLButtonElement>(document, "mode-sem");
  const buildBtn = requiredElement<HTMLButtonElement>(document, "build-sem");
  const semProgEl = requiredElement<HTMLElement>(document, "sem-progress");

  runtime.addEventListener("contextmenu", (event) => event.preventDefault());
  runtime.addEventListener(
    "keydown",
    (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (
        ((keyboardEvent.ctrlKey || keyboardEvent.metaKey) &&
          (keyboardEvent.key === "f" || keyboardEvent.key === "F")) ||
        keyboardEvent.key === "F3"
      ) {
        keyboardEvent.preventDefault();
      }
    },
    true,
  );

  const showSearchAlert = (message: string, title = "提示"): Promise<unknown> => {
    if (runtime.parent !== runtime && runtime.parent.AppDialog?.alert) {
      return runtime.parent.AppDialog.alert(message, {
        title,
        confirmLabel: "知道了",
        tone: "warning",
      });
    }
    searchAlertTitle.textContent = title;
    searchAlertMessage.textContent = message;
    if (typeof searchAlert.showModal === "function") searchAlert.showModal();
    else runtime.alert(message);
    return Promise.resolve();
  };
  searchAlertOk.addEventListener("click", () => searchAlert.close());

  // 不等待预热，保持关键词输入的首帧响应。
  runtime.setTimeout(() => {
    void api.invoke("warm_semantic_model").catch(() => undefined);
  }, 120);

  let qhist = parseHistory(runtime.localStorage);
  let qcommon = parseCommonSearches(runtime.localStorage);
  let curTerm = "";
  let curIds: string[] = [];
  let curResults: readonly SearchBookResult[] = [];
  let curSimilar: readonly SearchBookResult[] = [];
  let pendingBooks = 0;
  let searchSeq = 0;
  let renderGeneration = 0;
  let keywordRetryTimer = 0;
  let keywordRetryCount = 0;
  let mode: SearchMode = "kw";
  let semPoll: number | null = null;

  const saveQHist = (): void => {
    runtime.localStorage.setItem("shelfSearchHistory", JSON.stringify(qhist.slice(0, 12)));
  };
  const saveQCommon = (): void => {
    runtime.localStorage.setItem("shelfSearchCommon", JSON.stringify(qcommon));
  };
  const hideQHist = (): void => qhistEl.classList.remove("show");

  const stopKeywordRetry = (): void => {
    runtime.clearTimeout(keywordRetryTimer);
    keywordRetryTimer = 0;
    keywordRetryCount = 0;
  };

  const sortResults = (list: readonly SearchBookResult[]): SearchBookResult[] =>
    sortSearchResults(list, sortEl.value);

  const openHit = (bookId: string, chapter: number): void => {
    try {
      runtime.localStorage.removeItem("crossReturnState");
      runtime.localStorage.removeItem("pendingCrossSearch");
    } catch {
      // Storage cleanup is best effort, as in the classic window.
    }
    void api
      .invoke("open_book_at", {
        request: { id: bookId, chapter, term: curTerm },
      })
      .catch(() => undefined);
  };

  const buildHits = (book: SearchBookResult, hitsWrap: HTMLElement): void => {
    const fragment = document.createDocumentFragment();
    const visibleHits = Array.isArray(book.hits) ? book.hits : [];
    const createHit = (searchHit: SearchHit): HTMLElement => {
      const hit = document.createElement("div");
      hit.className = "hit";
      const meta: string[] = [];
      if (typeof searchHit.count === "number" && searchHit.count > 1) {
        meta.push(`${searchHit.count} 处`);
      }
      if (typeof searchHit.score === "number" && searchHit.score > 0 && mode === "sem") {
        meta.push(`相似 ${Math.round(searchHit.score * 100)}%`);
      }
      const scoreTag = meta.length
        ? `<span class="hit-meta">${meta.join(" · ")}</span>`
        : "";
      const body =
        mode === "sem"
          ? escapeHtml(searchHit.snippet)
          : highlightSnippet(searchHit.snippet, curTerm);
      hit.innerHTML = `${scoreTag}<span class="ch">第${searchHit.chapter + 1}章</span>${body}`;
      hit.addEventListener("click", () => openHit(book.book_id, searchHit.chapter));
      return hit;
    };

    visibleHits.forEach((hit) => fragment.appendChild(createHit(hit)));
    if (typeof book.count === "number" && book.count > visibleHits.length) {
      const more = document.createElement("div");
      more.className = "more";
      let loaded = visibleHits.length;
      let loading = false;
      const query = curTerm;
      const generation = renderGeneration;
      const updateMore = (): void => {
        const remaining = Math.max(0, (book.count ?? 0) - loaded);
        if (!remaining) {
          more.remove();
          return;
        }
        more.textContent = `… 另有 ${remaining} 处未显示，点击再显示 ${Math.min(10, remaining)} 处`;
      };
      more.addEventListener("click", async () => {
        if (loading) return;
        loading = true;
        more.textContent = "正在加载…";
        try {
          const extra = await api.invoke("shelf_search_book_hits", {
            request: { bookId: book.book_id, term: query, offset: loaded, limit: 10 },
          });
          if (generation !== renderGeneration || query !== curTerm || mode !== "kw") return;
          const page = Array.isArray(extra) ? extra : [];
          const pageFragment = document.createDocumentFragment();
          page.forEach((hit) => pageFragment.appendChild(createHit(hit)));
          hitsWrap.insertBefore(pageFragment, more);
          loaded += page.length;
          if (!page.length) loaded = book.count ?? loaded;
          updateMore();
        } catch {
          more.textContent = "加载失败，点击重试";
        } finally {
          loading = false;
        }
      });
      updateMore();
      fragment.appendChild(more);
    }
    hitsWrap.appendChild(fragment);
  };

  const createBookGroup = (book: SearchBookResult, index: number): HTMLElement => {
    const group = document.createElement("div");
    const startsExpanded = index < INITIAL_EXPANDED_BOOKS;
    group.className = `book-group${startsExpanded ? "" : " collapsed"}`;
    const head = document.createElement("div");
    head.className = "book-head";
    const score = Math.round((book.score ?? 0) * 100);
    head.innerHTML =
      '<span class="caret">▾</span>' +
      `<span class="book-title">${escapeHtml(book.title || "未命名")}</span>` +
      (book.author
        ? `<span class="book-author">${escapeHtml(book.author)}</span>`
        : "") +
      `<span class="book-count">${typeof book.count === "number" ? `${book.count} 处` : `相似 ${score}%`}</span>`;
    const hitsWrap = document.createElement("div");
    hitsWrap.className = "hits";
    const ensureHits = (): void => {
      if (hitsWrap.dataset.built) return;
      buildHits(book, hitsWrap);
      hitsWrap.dataset.built = "1";
    };
    head.addEventListener("click", () => {
      if (group.classList.contains("collapsed")) ensureHits();
      group.classList.toggle("collapsed");
    });
    if (startsExpanded) ensureHits();
    group.append(head, hitsWrap);
    return group;
  };

  const render = (): void => {
    const generation = ++renderGeneration;
    resultsEl.innerHTML = "";
    if (!curResults.length && !curSimilar.length) {
      resultsEl.innerHTML = `<div class="empty">未找到「${escapeHtml(curTerm)}」</div>`;
      return;
    }
    if (mode === "kw" && curSimilar.length) {
      const similar = document.createElement("div");
      similar.className = "book-group similar-group collapsed";
      const head = document.createElement("div");
      head.className = "book-head";
      head.innerHTML = `<span class="caret">▾</span><span class="book-title">相似段落推荐</span><span class="book-count">${curSimilar.length} 本</span>`;
      const hitsWrap = document.createElement("div");
      hitsWrap.className = "hits";
      head.addEventListener("click", () => {
        const willOpen = similar.classList.contains("collapsed");
        similar.classList.toggle("collapsed");
        if (willOpen && !hitsWrap.dataset.built) {
          curSimilar.slice(0, 3).forEach((book) => {
            buildHits({ ...book, hits: (book.hits ?? []).slice(0, 2) }, hitsWrap);
          });
          hitsWrap.dataset.built = "1";
        }
      });
      similar.append(head, hitsWrap);
      resultsEl.appendChild(similar);
    }
    if (!curResults.length) return;
    const list = sortResults(curResults);
    let nextIndex = 0;
    const appendNextFrame = (): void => {
      if (generation !== renderGeneration) return;
      const fragment = document.createDocumentFragment();
      const end = Math.min(nextIndex + RESULT_GROUPS_PER_FRAME, list.length);
      while (nextIndex < end) {
        const book = list[nextIndex];
        if (book) fragment.appendChild(createBookGroup(book, nextIndex));
        nextIndex += 1;
      }
      resultsEl.appendChild(fragment);
      if (nextIndex < list.length) runtime.requestAnimationFrame(appendNextFrame);
    };
    appendNextFrame();
  };

  const scheduleKeywordRetry = (term: string): void => {
    if (
      mode !== "kw" ||
      !pendingBooks ||
      keywordRetryTimer ||
      keywordRetryCount >= KEYWORD_RETRY_LIMIT
    ) {
      return;
    }
    keywordRetryCount += 1;
    keywordRetryTimer = runtime.setTimeout(() => {
      keywordRetryTimer = 0;
      if (mode === "kw" && qEl.value.trim() === term && pendingBooks > 0) {
        void runSearch(term, { retry: true });
      }
    }, 1000);
  };

  const renderQHist = (): void => {
    qhistEl.innerHTML = "";
    const common = commonSearches(qcommon, 6);
    if (common.length) {
      const title = document.createElement("div");
      title.className = "qh-empty";
      title.textContent = "常搜词";
      qhistEl.appendChild(title);
      common.forEach(({ query, count }) => {
        const item = document.createElement("div");
        item.className = "qh-item";
        item.innerHTML = `<span class="qh-text"></span><span class="qh-del">×${count}</span>`;
        const text = item.querySelector<HTMLElement>(".qh-text");
        if (text) text.textContent = query;
        item.addEventListener("click", () => {
          qEl.value = query;
          hideQHist();
          void runSearch(query);
        });
        qhistEl.appendChild(item);
      });
    }
    if (!qhist.length) {
      const empty = document.createElement("div");
      empty.className = "qh-empty";
      empty.textContent = "暂无搜索记录";
      qhistEl.appendChild(empty);
      return;
    }
    const historyTitle = document.createElement("div");
    historyTitle.className = "qh-empty";
    historyTitle.textContent = "搜索历史";
    qhistEl.appendChild(historyTitle);
    qhist.forEach((query) => {
      const item = document.createElement("div");
      item.className = "qh-item";
      const text = document.createElement("span");
      text.className = "qh-text";
      text.textContent = query;
      const remove = document.createElement("span");
      remove.className = "qh-del";
      remove.textContent = "✕";
      item.append(text, remove);
      item.addEventListener("click", (event) => {
        if (event.target === remove) {
          qhist = removeSearchQuery(qhist, query);
          saveQHist();
          renderQHist();
          return;
        }
        qEl.value = query;
        hideQHist();
        void runSearch(query);
      });
      qhistEl.appendChild(item);
    });
  };
  const showQHist = (): void => {
    renderQHist();
    qhistEl.classList.add("show");
  };
  const addQHist = (query: string): void => {
    const next = recordSearchQuery(qhist, qcommon, query, Date.now(), 12);
    qhist = next.history;
    qcommon = next.common;
    saveQHist();
    saveQCommon();
  };

  const runSearch: SearchWindowController["runSearch"] = async (
    term: unknown,
    options = {},
  ): Promise<void> => {
    const retry = options.retry === true;
    if (!retry) stopKeywordRetry();
    const sequence = ++searchSeq;
    if (!retry) renderGeneration += 1;
    curTerm = String(term || "").trim();
    qEl.value = curTerm;
    if (!curTerm) {
      curResults = [];
      curSimilar = [];
      pendingBooks = 0;
      summaryEl.textContent = "";
      resultsEl.innerHTML = '<div class="empty">输入文字后回车检索</div>';
      return;
    }
    if (!retry) {
      addQHist(curTerm);
      hideQHist();
      summaryEl.textContent = "检索中…";
      resultsEl.innerHTML = '<div class="loading">正在检索书架内容…</div>';
    }
    const ids = curIds.length ? curIds : null;
    try {
      if (mode === "sem") {
        curResults = await api.invoke("semantic_search", { query: curTerm, ids });
        curSimilar = [];
        pendingBooks = 0;
      } else {
        const response = await api.invoke("shelf_search", { term: curTerm, ids });
        if (Array.isArray(response)) {
          curResults = response as readonly SearchBookResult[];
          pendingBooks = 0;
        } else {
          const keywordResponse = response as KeywordSearchResponse;
          curResults = keywordResponse.results ?? [];
          pendingBooks = positiveNumber(keywordResponse.pendingBooks);
        }
        curSimilar = [];
      }
      if (sequence !== searchSeq) return;
    } catch (error) {
      if (sequence !== searchSeq) return;
      curResults = [];
      curSimilar = [];
      summaryEl.textContent = `检索出错：${errorText(error)}`;
      resultsEl.innerHTML = "";
      return;
    }
    const books = curResults.length;
    if (mode === "sem") {
      summaryEl.textContent = books
        ? `语义相近的结果（共 ${books} 本书）${curIds.length ? `（限定 ${curIds.length} 本）` : ""}`
        : "没有匹配（这些书是否已建立语义索引？）";
    } else {
      const hits = curResults.reduce((sum, book) => sum + (book.count ?? 0), 0);
      const pendingHint = pendingBooks
        ? `；另有 ${pendingBooks} 本正在后台建立全文索引，完成后再次搜索即可纳入`
        : "";
      summaryEl.textContent = books
        ? `在 ${books} 本书中找到 ${hits} 处${curIds.length ? `（限定 ${curIds.length} 本）` : ""}${pendingHint}`
        : pendingBooks
          ? `正在准备 ${pendingBooks} 本书的全文索引，页面将自动显示结果…`
          : "未找到结果";
    }
    render();
    if (mode === "kw" && pendingBooks > 0) scheduleKeywordRetry(curTerm);
    else if (mode === "kw") stopKeywordRetry();
  };

  const semanticReadiness = async (): Promise<string> => {
    try {
      const status = await api.invoke("semantic_status");
      if (!status.model_ready) {
        return "语义模型尚未下载或加载。\n请先在“语义索引设置”中下载模型。";
      }
      const ready = await api.invoke("semantic_index_done", {
        ids: curIds.length ? curIds : null,
      });
      if (!ready) {
        const scope = curIds.length ? "当前选定的图书" : "书架图书";
        return `${scope}还没有完成语义索引。\n请点击“建立语义索引”，完成后再使用语义检索。`;
      }
      return "";
    } catch {
      return "暂时无法确认语义检索状态。\n请稍后重试，或在语义索引设置中检查模型与索引。";
    }
  };

  const setMode = async (nextMode: SearchMode): Promise<void> => {
    if (mode === nextMode) return;
    if (nextMode === "sem") {
      const warning = await semanticReadiness();
      if (warning) {
        await showSearchAlert(warning, "语义检索未就绪");
        return;
      }
    }
    stopKeywordRetry();
    mode = nextMode;
    document.body.classList.toggle("semantic-mode", nextMode === "sem");
    modeKw.classList.toggle("active", nextMode === "kw");
    modeSem.classList.toggle("active", nextMode === "sem");
    sortEl.style.display = nextMode === "sem" ? "none" : "";
    qEl.placeholder =
      nextMode === "sem"
        ? "描述你想找的“意思”，回车检索…"
        : "输入要在书架中检索的文字…";
    if (nextMode === "sem") {
      runtime.setTimeout(() => {
        void api.invoke("warm_semantic_model").catch(() => undefined);
      }, 0);
    }
    const inputTerm = qEl.value.trim();
    if (inputTerm) await runSearch(inputTerm);
  };

  const pollSemanticStatus = (): void => {
    void api
      .invoke("semantic_status")
      .then((progress) => {
        if (progress.error) {
          semProgEl.textContent = `无法建立语义索引：${progress.error}`;
          buildBtn.disabled = false;
          if (semPoll !== null) runtime.clearInterval(semPoll);
          semPoll = null;
          return;
        }
        if (progress.building) {
          semProgEl.textContent = progress.shard_total
            ? `建立语义索引中… ${progress.done ?? 0}/${progress.total ?? 0}；加速分片 ${progress.shard_done ?? 0}/${progress.shard_total}（${progress.current || ""}）`
            : `建立语义索引中… ${progress.done ?? 0}/${progress.total ?? 0}（${progress.current || ""}）`;
          return;
        }
        semProgEl.textContent =
          progress.current && progress.current !== "完成"
            ? progress.current
            : progress.total
              ? `语义索引已就绪（${progress.total} 本）`
              : "";
        buildBtn.disabled = false;
        if (semPoll !== null) runtime.clearInterval(semPoll);
        semPoll = null;
      })
      .catch(() => undefined);
  };

  modeKw.addEventListener("click", () => {
    void setMode("kw");
  });
  modeSem.addEventListener("click", () => {
    void setMode("sem");
  });
  buildBtn.addEventListener("click", async () => {
    const ids = curIds.length ? curIds : null;
    const scope = curIds.length ? `选定的 ${curIds.length} 本` : "全部图书";
    try {
      const done = await api.invoke("semantic_index_done", { ids });
      if (done) {
        runtime.alert(`语义索引已建立完成（${scope}），无需重复建立。`);
        semProgEl.textContent = "语义索引已就绪（已完成）";
        return;
      }
    } catch {
      // The confirmation path below remains available if readiness probing fails.
    }
    if (
      !runtime.confirm(
        `将为${scope}建立语义索引。\n首次会下载约120MB模型；大书库可能耗时较长（后台进行）。\n继续？`,
      )
    ) {
      return;
    }
    buildBtn.disabled = true;
    semProgEl.textContent = "正在启动…";
    void api.invoke("build_semantic_index", { ids }).catch((error: unknown) => {
      semProgEl.textContent = `启动失败：${errorText(error)}`;
      buildBtn.disabled = false;
    });
    if (semPoll !== null) runtime.clearInterval(semPoll);
    semPoll = runtime.setInterval(pollSemanticStatus, 1000);
  });

  goEl.addEventListener("click", () => {
    void runSearch(qEl.value);
  });
  qEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void runSearch(qEl.value);
  });
  qEl.addEventListener("focus", showQHist);
  qEl.addEventListener("input", () => {
    searchSeq += 1;
    renderGeneration += 1;
    stopKeywordRetry();
    if (qEl.value.trim()) hideQHist();
    else showQHist();
  });
  qEl.addEventListener("blur", () => runtime.setTimeout(hideQHist, 150));
  qhistEl.addEventListener("mousedown", (event) => event.preventDefault());
  sortEl.addEventListener("change", render);

  void events.listen("shelf-search-query", (event) => {
    const payload = event.payload ?? {};
    curIds = Array.isArray(payload.ids)
      ? payload.ids.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    void runSearch(payload.term || "");
  });

  const parameters = new URLSearchParams(runtime.location.search);
  curTerm = (parameters.get("q") || "").trim();
  const initialIds = (parameters.get("ids") || "").trim();
  curIds = initialIds ? initialIds.split(",").filter(Boolean) : [];
  void runSearch(curTerm);

  return Object.freeze({ pollSemanticStatus, runSearch, setMode });
}

export function installSearchWindow(
  target: Record<string, unknown>,
  transport: TauriTransport = transportFromTauriGlobal(target),
): SearchWindowController | null {
  const runtime = runtimeFrom(target);
  return runtime ? initializeSearchWindow(runtime, transport) : null;
}
