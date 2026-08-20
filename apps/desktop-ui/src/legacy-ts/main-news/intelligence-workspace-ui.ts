import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type UnknownRecord = Record<string, unknown>;
type IntelligenceLayout = "briefing" | "monitor" | "research" | "interstellar";

interface IntelligenceNewsItem extends UnknownRecord {
  readonly title?: unknown;
  readonly source?: unknown;
  readonly category?: unknown;
  readonly url?: unknown;
  readonly summary?: unknown;
}

interface InterstellarSignalCandidate {
  readonly item: IntelligenceNewsItem;
  readonly score: number;
  readonly domains: readonly string[];
}

const INTERSTELLAR_DOMAIN_RULES: ReadonlyArray<{
  readonly label: string;
  readonly terms: ReadonlyArray<readonly [string, number]>;
}> = [
  {
    label: "任务与深空",
    terms: [
      ["恒星际", 12], ["星际", 10], ["比邻星", 12], ["interstellar", 12], ["proxima", 12],
      ["深空", 6], ["deep space", 7], ["航天", 4], ["spacecraft", 5], ["太空", 3], ["space probe", 6],
    ],
  },
  {
    label: "推进",
    terms: [
      ["光帆", 10], ["lightsail", 10], ["solar sail", 7], ["推进", 2], ["propulsion", 8],
      ["核聚变", 7], ["fusion", 7], ["反物质", 10], ["antimatter", 10], ["离子发动机", 6],
    ],
  },
  {
    label: "能源与散热",
    terms: [
      ["聚变", 7], ["fusion", 7], ["反应堆", 5], ["reactor", 5], ["核能", 4],
      ["能源", 2], ["energy", 2], ["散热", 5], ["thermal", 3],
    ],
  },
  {
    label: "材料与防护",
    terms: [
      ["辐射", 5], ["radiation", 5], ["屏蔽", 5], ["shielding", 6], ["超材料", 4],
      ["材料", 2], ["materials", 2], ["尘埃", 4], ["dust impact", 5],
    ],
  },
  {
    label: "自主系统",
    terms: [
      ["自主导航", 6], ["autonomous navigation", 7], ["自主系统", 5], ["autonomous", 4],
      ["人工智能", 2], [" ai ", 2], ["机器人", 3], ["robot", 3], ["深空通信", 6],
    ],
  },
  {
    label: "太空工业",
    terms: [
      ["在轨制造", 7], ["space manufacturing", 7], ["太空采矿", 7], ["space mining", 7],
      ["发射成本", 5], ["launch cost", 5], ["nasa", 3], ["esa", 3], ["spacex", 3],
    ],
  },
];

const INTERSTELLAR_GATE_TERMS = Object.freeze([
  "恒星际", "星际", "比邻星", "interstellar", "proxima", "深空", "deep space",
  "航天", "太空", "spacecraft", "space probe", "orbital", "轨道", "nasa", "esa", "spacex",
  "光帆", "lightsail", "solar sail", "propulsion", "核聚变", "fusion", "反物质", "antimatter",
  "离子发动机", "ion engine", "在轨制造", "space manufacturing", "太空采矿", "space mining",
]);

function searchableItemText(item: IntelligenceNewsItem): string {
  return ` ${[item.title, item.source, item.category, item.summary].map(text).join(" ").toLocaleLowerCase()} `;
}

export function classifyInterstellarSignals(
  items: readonly IntelligenceNewsItem[],
): InterstellarSignalCandidate[] {
  return items
    .map((item) => {
      const searchable = searchableItemText(item);
      const passesInterstellarGate = INTERSTELLAR_GATE_TERMS.some((term) => searchable.includes(term));
      const matches = INTERSTELLAR_DOMAIN_RULES.map((domain) => {
        const score = domain.terms.reduce(
          (total, [term, weight]) => total + (searchable.includes(term) ? weight : 0),
          0,
        );
        return { label: domain.label, score: Math.min(score, 12) };
      }).filter((match) => match.score > 0);
      return {
        item,
        score: passesInterstellarGate
          ? matches.reduce((total, match) => total + match.score, 0)
          : 0,
        domains: matches.map((match) => match.label),
      };
    })
    .filter((candidate) => candidate.score >= 6)
    .sort((left, right) => right.score - left.score || itemTitle(left.item).localeCompare(itemTitle(right.item), "zh-CN"))
    .slice(0, 8);
}

interface IntelligenceWorkspaceController {
  readonly open: () => Promise<void>;
  readonly close: (options?: { readonly focus?: boolean }) => void;
  readonly refresh: () => Promise<void>;
  readonly layout: () => IntelligenceLayout;
}

export interface IntelligenceWorkspaceGlobal {
  readonly init: () => IntelligenceWorkspaceController | null;
  instance?: IntelligenceWorkspaceController | null;
}

interface IntelligenceWorkspaceRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly ReaderNewsUI?: {
    readonly instance?: {
      readonly close?: (options?: { readonly focus?: boolean }) => void;
      readonly open?: () => Promise<void> | void;
      readonly openItem?: (item: IntelligenceNewsItem) => Promise<void> | void;
      readonly openSources?: () => Promise<void> | void;
      readonly sourceRequest?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    };
  };
  readonly ReaderLibraryAiEntry?: { readonly close?: () => void };
  ReaderIntelligenceWorkspace?: IntelligenceWorkspaceGlobal;
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : null;
}

function runtimeFrom(value: unknown): IntelligenceWorkspaceRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || typeof runtime.addEventListener !== "function") {
    return null;
  }
  return runtime as unknown as IntelligenceWorkspaceRuntime;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function newsItems(result: unknown): IntelligenceNewsItem[] {
  const resultRecord = record(result);
  const items = Array.isArray(result)
    ? result
    : (Array.isArray(resultRecord?.items) ? resultRecord.items : []);
  return items.map(record).filter((item): item is IntelligenceNewsItem => item !== null);
}

function requiredElement<TElement extends HTMLElement>(root: Document, id: string): TElement | null {
  return root.getElementById(id) as TElement | null;
}

function hiddenElement(value: Element | null): HTMLElement | null {
  const candidate = record(value);
  return candidate && "hidden" in candidate ? value as HTMLElement : null;
}

function itemTitle(item: IntelligenceNewsItem): string {
  return text(item.title) || "未命名资讯";
}

function itemContext(item: IntelligenceNewsItem): string {
  const summary = text(item.summary);
  if (summary) return summary;
  const source = text(item.source) || "未知来源";
  const category = text(item.category) || "综合";
  const url = text(item.url);
  return url ? `${source} · ${category}\n${url}` : `${source} · ${category}`;
}

/**
 * A small controller for a single test section in the existing main window.
 * It intentionally consumes the existing newsnow_list command only: Horizon,
 * RAG and WorldMonitor do not participate in this prototype.
 */
export function installIntelligenceWorkspaceUi(
  target: unknown,
  injectedTransport?: TauriTransport,
): IntelligenceWorkspaceGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;

  let transport = injectedTransport;
  if (!transport) {
    try {
      transport = transportFromTauriGlobal(target);
    } catch {
      transport = undefined;
    }
  }

  const init = (): IntelligenceWorkspaceController | null => {
    const root = runtime.document;
    const toolbarButton = requiredElement<HTMLButtonElement>(root, "intelligence-lab-toolbar-btn");
    const page = requiredElement<HTMLElement>(root, "intelligence-workspace-page");
    const back = requiredElement<HTMLButtonElement>(root, "intelligence-workspace-back");
    const briefing = requiredElement<HTMLButtonElement>(root, "intelligence-layout-briefing");
    const monitor = requiredElement<HTMLButtonElement>(root, "intelligence-layout-monitor");
    const research = requiredElement<HTMLButtonElement>(root, "intelligence-layout-research");
    const interstellar = requiredElement<HTMLButtonElement>(root, "intelligence-layout-interstellar");
    const refreshButton = requiredElement<HTMLButtonElement>(root, "intelligence-refresh");
    const sourcesButton = requiredElement<HTMLButtonElement>(root, "intelligence-open-sources");
    const status = requiredElement<HTMLElement>(root, "intelligence-workspace-status");
    const digestList = requiredElement<HTMLElement>(root, "intelligence-digest-list");
    const signalList = requiredElement<HTMLElement>(root, "intelligence-signal-list");
    const contextTitle = requiredElement<HTMLElement>(root, "intelligence-context-title");
    const contextBody = requiredElement<HTMLElement>(root, "intelligence-context-body");
    const openNews = requiredElement<HTMLButtonElement>(root, "intelligence-open-news");
    const standardView = requiredElement<HTMLElement>(root, "intelligence-standard-view");
    const interstellarView = requiredElement<HTMLElement>(root, "interstellar-progress-view");
    const interstellarSignalCount = requiredElement<HTMLElement>(root, "interstellar-signal-count");
    const interstellarSignalList = requiredElement<HTMLElement>(root, "interstellar-signal-list");
    const interstellarContextTitle = requiredElement<HTMLElement>(root, "interstellar-context-title");
    const interstellarContextBody = requiredElement<HTMLElement>(root, "interstellar-context-body");
    const interstellarOpenNews = requiredElement<HTMLButtonElement>(root, "interstellar-open-news");
    const contentShell = typeof root.querySelector === "function"
      ? hiddenElement(root.querySelector(".content-shell"))
      : null;
    if (!toolbarButton || !page || !back || !briefing || !monitor || !research || !interstellar
      || !refreshButton || !sourcesButton || !status || !digestList || !signalList || !contextTitle
      || !contextBody || !openNews || !standardView || !interstellarView || !interstellarSignalCount
      || !interstellarSignalList || !interstellarContextTitle || !interstellarContextBody || !interstellarOpenNews) {
      return null;
    }

    let currentLayout: IntelligenceLayout = "briefing";
    let loading = false;
    let selectedItem: IntelligenceNewsItem | null = null;
    let selectedInterstellarItem: IntelligenceNewsItem | null = null;
    let standardStatus = "";
    let interstellarStatus = "首版人工基线已建立；候选资讯尚未自动计分。";

    const setStatus = (value: string): void => {
      status.textContent = value;
    };

    const setStandardStatus = (value: string): void => {
      standardStatus = value;
      if (currentLayout !== "interstellar") setStatus(value);
    };

    const setInterstellarStatus = (value: string): void => {
      interstellarStatus = value;
      if (currentLayout === "interstellar") setStatus(value);
    };

    const setLayout = (layout: IntelligenceLayout): void => {
      currentLayout = layout;
      page.dataset.layout = layout;
      const buttons: ReadonlyArray<readonly [IntelligenceLayout, HTMLButtonElement]> = [
        ["briefing", briefing],
        ["monitor", monitor],
        ["research", research],
        ["interstellar", interstellar],
      ];
      buttons.forEach(([candidate, button]) => {
        button.setAttribute("aria-pressed", String(candidate === layout));
      });
      const showingInterstellar = layout === "interstellar";
      standardView.hidden = showingInterstellar;
      interstellarView.hidden = !showingInterstellar;
      setStatus(showingInterstellar ? interstellarStatus : standardStatus);
    };

    const selectItem = (item: IntelligenceNewsItem): void => {
      selectedItem = item;
      contextTitle.textContent = itemTitle(item);
      contextBody.textContent = itemContext(item);
    };

    const makeItemButton = (
      item: IntelligenceNewsItem,
      kind: "digest" | "signal",
      index: number,
    ): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = kind === "digest" ? "intelligence-digest-item" : "intelligence-signal";
      const source = text(item.source) || "未知来源";
      const category = text(item.category) || "综合";
      if (kind === "digest") {
        const order = root.createElement("span");
        order.className = "intelligence-digest-index";
        order.textContent = String(index + 1).padStart(2, "0");
        const copy = root.createElement("span");
        copy.className = "intelligence-digest-copy";
        const title = root.createElement("strong");
        title.textContent = itemTitle(item);
        const meta = root.createElement("span");
        meta.textContent = source;
        copy.append(title, meta);
        const type = root.createElement("span");
        type.className = "intelligence-digest-kind";
        type.textContent = category;
        button.append(order, copy, type);
      } else {
        button.textContent = `${source} · ${category} · ${itemTitle(item)}`;
      }
      button.addEventListener("click", () => {
        selectItem(item);
        digestList.querySelectorAll(".intelligence-digest-item[aria-current='true']")
          .forEach((candidate) => candidate.removeAttribute("aria-current"));
        if (kind === "digest") button.setAttribute("aria-current", "true");
      });
      return button;
    };

    const selectInterstellarCandidate = (
      candidate: InterstellarSignalCandidate,
      button?: HTMLButtonElement,
    ): void => {
      selectedInterstellarItem = candidate.item;
      interstellarContextTitle.textContent = itemTitle(candidate.item);
      const domains = candidate.domains.join("、");
      interstellarContextBody.textContent = `${itemContext(candidate.item)}\n候选领域：${domains}。相关性仅用于进入审核队列，尚未改变进度。`;
      interstellarOpenNews.disabled = false;
      interstellarSignalList.querySelectorAll(".interstellar-candidate[aria-current='true']")
        .forEach((current) => current.removeAttribute("aria-current"));
      button?.setAttribute("aria-current", "true");
    };

    const makeInterstellarCandidateButton = (
      candidate: InterstellarSignalCandidate,
    ): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "interstellar-candidate";

      const domain = root.createElement("span");
      domain.className = "interstellar-candidate-domain";
      domain.textContent = candidate.domains[0] ?? "综合";

      const copy = root.createElement("span");
      copy.className = "interstellar-candidate-copy";
      const title = root.createElement("strong");
      title.textContent = itemTitle(candidate.item);
      const meta = root.createElement("span");
      meta.textContent = `${text(candidate.item.source) || "未知来源"} · ${candidate.domains.join(" / ")}`;
      copy.append(title, meta);

      const score = root.createElement("span");
      score.className = "interstellar-candidate-score";
      score.textContent = `相关性 ${candidate.score}`;
      button.append(domain, copy, score);
      button.addEventListener("click", () => selectInterstellarCandidate(candidate, button));
      return button;
    };

    const renderInterstellarSignals = (items: IntelligenceNewsItem[]): void => {
      const candidates = classifyInterstellarSignals(items);
      interstellarSignalCount.textContent = `${candidates.length} 条候选信号`;
      setInterstellarStatus(`已从 ${items.length} 条资讯筛出 ${candidates.length} 条候选信号；尚未自动计分。`);
      if (candidates.length === 0) {
        const empty = root.createElement("div");
        empty.className = "interstellar-candidate-empty";
        empty.textContent = "当前已选来源中没有达到相关性门槛的资讯。可在“信息来源”中增加航天、能源、材料与科研来源。";
        interstellarSignalList.replaceChildren(empty);
        selectedInterstellarItem = null;
        interstellarContextTitle.textContent = "尚未发现候选信号";
        interstellarContextBody.textContent = "当前进度仍保留人工基线；没有候选新闻不会降低进度。";
        interstellarOpenNews.disabled = true;
        return;
      }
      const buttons = candidates.map(makeInterstellarCandidateButton);
      interstellarSignalList.replaceChildren(...buttons);
      selectInterstellarCandidate(candidates[0]!, buttons[0]);
    };

    const render = (items: IntelligenceNewsItem[]): void => {
      renderInterstellarSignals(items);
      if (items.length === 0) {
        digestList.replaceChildren();
        signalList.replaceChildren();
        contextTitle.textContent = "暂无资讯";
        contextBody.textContent = "请稍后刷新，或前往旧资讯页检查来源设置。";
        setStandardStatus("暂无可展示的资讯。");
        return;
      }
      const digestButtons = items.map((item, index) => makeItemButton(item, "digest", index));
      digestButtons[0]?.setAttribute("aria-current", "true");
      digestList.replaceChildren(...digestButtons);
      signalList.replaceChildren(...items.map((item, index) => makeItemButton(item, "signal", index)));
      selectItem(items[0]!);
      setStandardStatus(`已加载 ${items.length} 条资讯。`);
    };

    const load = async (): Promise<void> => {
      if (loading) return;
      if (!transport) {
        setStandardStatus("资讯服务暂不可用，请稍后重试。");
        setInterstellarStatus("候选信号服务暂不可用；首版人工基线仍可查看。");
        return;
      }
      loading = true;
      refreshButton.disabled = true;
      setStatus("正在加载资讯…");
      try {
        // The intelligence workspace is another view of the reader's news feed,
        // so it must use the same persisted selection rather than silently
        // falling back to the six default sources.
        const request = await runtime.ReaderNewsUI?.instance?.sourceRequest?.() ?? {};
        const result = await transport.invoke<unknown>("newsnow_list", { request });
        render(newsItems(result));
      } catch {
        setStandardStatus("资讯加载失败，请检查网络后重试。");
        setInterstellarStatus("候选信号加载失败；首版人工基线仍可查看。");
      } finally {
        loading = false;
        refreshButton.disabled = false;
      }
    };

    const open = async (): Promise<void> => {
      const newsPage = hiddenElement(root.getElementById("newsnow-page"));
      const newsReader = hiddenElement(root.getElementById("newsnow-reader"));
      if ((newsPage && !newsPage.hidden) || (newsReader && !newsReader.hidden)) {
        runtime.ReaderNewsUI?.instance?.close?.({ focus: false });
      }
      if (!hiddenElement(root.getElementById("library-ai-page"))?.hidden) {
        runtime.ReaderLibraryAiEntry?.close?.();
      }
      if (contentShell) contentShell.hidden = true;
      page.hidden = false;
      root.body.classList.add("intelligence-workspace-active");
      toolbarButton.setAttribute("aria-pressed", "true");
      await load();
    };

    const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
      page.hidden = true;
      if (contentShell) contentShell.hidden = false;
      root.body.classList.remove("intelligence-workspace-active");
      toolbarButton.setAttribute("aria-pressed", "false");
      if (focus) toolbarButton.focus({ preventScroll: true });
    };

    toolbarButton.addEventListener("click", () => { void open(); });
    back.addEventListener("click", () => close());
    briefing.addEventListener("click", () => setLayout("briefing"));
    monitor.addEventListener("click", () => setLayout("monitor"));
    research.addEventListener("click", () => setLayout("research"));
    interstellar.addEventListener("click", () => setLayout("interstellar"));
    refreshButton.addEventListener("click", () => { void load(); });
    sourcesButton.addEventListener("click", () => {
      close({ focus: false });
      try {
        const opening = runtime.ReaderNewsUI?.instance?.openSources?.();
        void Promise.resolve(opening).catch(() => {
          setStatus("资讯来源页暂时无法打开。");
        });
      } catch {
        setStatus("资讯来源页暂时无法打开。");
      }
    });
    openNews.addEventListener("click", () => {
      close({ focus: false });
      try {
        const news = runtime.ReaderNewsUI?.instance;
        const opening = selectedItem && news?.openItem
          ? news.openItem(selectedItem)
          : news?.open?.();
        void Promise.resolve(opening).catch(() => undefined);
      } catch {
        setStatus("旧资讯页暂时无法打开。");
      }
    });
    interstellarOpenNews.addEventListener("click", () => {
      if (!selectedInterstellarItem) return;
      close({ focus: false });
      try {
        const news = runtime.ReaderNewsUI?.instance;
        const opening = news?.openItem
          ? news.openItem(selectedInterstellarItem)
          : news?.open?.();
        void Promise.resolve(opening).catch(() => undefined);
      } catch {
        setInterstellarStatus("候选资讯详情暂时无法打开。");
      }
    });
    runtime.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !page.hidden) close();
    });
    setLayout(currentLayout);
    return Object.freeze({ open, close, refresh: load, layout: () => currentLayout });
  };

  const global: IntelligenceWorkspaceGlobal = { init };
  runtime.ReaderIntelligenceWorkspace = global;
  global.instance = init();
  return global;
}
