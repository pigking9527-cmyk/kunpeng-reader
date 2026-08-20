import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface SimilarBook extends Record<string, unknown> {
  readonly id?: unknown;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly cover?: string;
  readonly score?: number;
}

interface TimelineBucket extends Record<string, unknown> {
  readonly day?: unknown;
  readonly seconds?: unknown;
  readonly words?: unknown;
}

interface TimelineEvent extends Record<string, unknown> {
  readonly at?: unknown;
  readonly chapter?: unknown;
  readonly progress?: unknown;
}

interface BookReadingTimeline extends Record<string, unknown> {
  readonly title?: string;
  readonly buckets?: readonly TimelineBucket[];
  readonly events?: readonly TimelineEvent[];
}

type BookInfoCommands = {
  similar_books: {
    readonly args: { readonly id: string };
    readonly result: SimilarBook[];
  };
  book_reading_timeline: {
    readonly args: { readonly id: string };
    readonly result: BookReadingTimeline;
  };
};

type VerifiedBookInfoCommands = BookInfoCommands extends TauriCommandMap
  ? BookInfoCommands
  : never;

interface BookInfoPanelLike {
  fmtWords?(value: unknown): string;
}

interface BookInfoRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly ReaderBookInfoPanel?: BookInfoPanelLike;
  ReaderBookInfoRelated?: BookInfoRelatedGlobal;
}

export interface BookInfoRelatedOptions {
  readonly root?: Document;
  readonly invoke?: TauriTransport["invoke"];
  readonly transport?: TauriTransport;
  readonly coverColor?: (title: string) => string;
  readonly onOpenBook?: (book: SimilarBook) => void;
}

export interface BookInfoRelatedController {
  configure(next?: BookInfoRelatedOptions): BookInfoRelatedController;
  openSimilar(id: unknown, book?: Readonly<{ title?: string }>): Promise<void>;
  openTimeline(id: unknown): Promise<void>;
  closeAll(): void;
}

export interface BookInfoRelatedGlobal {
  mount(options?: BookInfoRelatedOptions): BookInfoRelatedController;
  formatDuration(seconds: unknown): string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): BookInfoRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as BookInfoRuntime;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function formatBookInfoDuration(seconds: unknown): string {
  const total = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ""}`;
  if (minutes) return `${minutes} 分钟`;
  return `${Math.floor(total)} 秒`;
}

function formatDateTime(seconds: unknown): string {
  return seconds
    ? new Date(Number(seconds) * 1000).toLocaleString("zh-CN", {
        hour12: false,
      })
    : "尚无记录";
}

function dayText(day: unknown): string {
  const raw = String(day || "");
  return raw.length === 8
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`
    : "未知日期";
}

function shortDay(day: unknown): string {
  const raw = String(day || "");
  return raw.length === 8 ? `${raw.slice(4, 6)}/${raw.slice(6)}` : "—";
}

function defaultCoverColor(title: unknown): string {
  let value = 0;
  for (const character of String(title || "")) {
    value = (value * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${value % 360} 42% 42%)`;
}

function surfaceMarkup(): string {
  return `
      <div id="similar-books-modal" class="modal book-info-related-modal" data-book-related="similar" data-overlay-role="information" role="dialog" aria-modal="true" aria-labelledby="book-related-similar-title">
        <section class="modal-card similar-books-card">
          <div class="modal-head book-related-head"><span class="modal-title-stack"><strong id="book-related-similar-title">相似图书</strong><small data-book-related-source></small></span><button class="btn-plain" type="button" data-book-related-close aria-label="关闭">✕</button></div>
          <div class="similar-list" data-book-related-similar-list></div>
        </section>
      </div>
      <div id="reading-timeline-modal" class="modal book-info-related-modal" data-book-related="timeline" data-overlay-role="information" role="dialog" aria-modal="true" aria-labelledby="book-related-timeline-title">
        <section class="modal-card timeline-card">
          <div class="modal-head book-related-head"><span class="modal-title-stack"><strong id="book-related-timeline-title">阅读时间线</strong><small data-book-related-timeline-subtitle>从阅读时长到进度变化</small></span><button class="btn-plain" type="button" data-book-related-close aria-label="关闭">✕</button></div>
          <div class="timeline-body" data-book-related-timeline-body></div>
        </section>
      </div>`;
}

function timelineChart(
  rawBuckets: readonly TimelineBucket[],
  formatWords: (value: unknown) => string,
): string {
  const days = new Map<
    string,
    { day: unknown; seconds: number; words: number }
  >();
  rawBuckets.forEach((bucket) => {
    const key = String(bucket.day || "");
    const item = days.get(key) || { day: bucket.day, seconds: 0, words: 0 };
    item.seconds += Number(bucket.seconds || 0);
    item.words += Number(bucket.words || 0);
    days.set(key, item);
  });
  const items = [...days.values()]
    .sort((left, right) => Number(left.day) - Number(right.day))
    .slice(-28);
  if (!items.length) {
    return '<div class="book-related-empty">还没有可绘制的每日阅读记录</div>';
  }
  const max = Math.max(...items.map((item) => item.seconds), 1);
  const width = Math.max(620, items.length * 48);
  const step = width / items.length;
  const bars = items
    .map((item, index) => {
      const height = Math.max(4, Math.round((item.seconds / max) * 116));
      const x = Math.round(index * step + step / 2);
      const title = `${dayText(item.day)} · ${formatBookInfoDuration(item.seconds)} · ${formatWords(item.words)}`;
      return `<g class="timeline-bar"><title>${escapeHtml(title)}</title><rect x="${x - 8}" y="${132 - height}" width="16" height="${height}" rx="8"/><text x="${x}" y="154" text-anchor="middle">${shortDay(item.day)}</text></g>`;
    })
    .join("");
  return `<div class="timeline-chart"><svg viewBox="0 0 ${width} 166" role="img" aria-label="最近每日阅读时长"><defs><linearGradient id="timeline-bar-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f8cff"/><stop offset="1" stop-color="#43b6a1"/></linearGradient></defs><line x1="0" y1="132" x2="${width}" y2="132"/><line x1="0" y1="74" x2="${width}" y2="74"/>${bars}</svg></div><div class="timeline-chart-caption"><span>最近 ${items.length} 个有记录的日期</span><span>悬停柱形查看时长与字数</span></div>`;
}

function timelineMarkup(
  data: BookReadingTimeline,
  formatWords: (value: unknown) => string,
): string {
  const buckets = Array.isArray(data.buckets) ? data.buckets : [];
  const events = Array.isArray(data.events) ? data.events.slice().reverse() : [];
  const days = new Set(buckets.map((bucket) => String(bucket.day || ""))).size;
  const totalSeconds = buckets.reduce(
    (sum, bucket) => sum + Number(bucket.seconds || 0),
    0,
  );
  const totalWords = buckets.reduce(
    (sum, bucket) => sum + Number(bucket.words || 0),
    0,
  );
  const latest = events[0];
  const summary = `<section class="timeline-summary"><div><span>累计阅读</span><strong>${escapeHtml(formatBookInfoDuration(totalSeconds))}</strong></div><div><span>活跃天数</span><strong>${days} 天</strong></div><div><span>阅读字数</span><strong>${escapeHtml(formatWords(totalWords))}</strong></div><div><span>最近进度</span><strong>${latest ? `${Number(latest.progress || 0).toFixed(1)}%` : "—"}</strong></div></section>`;
  const chart = `<section class="timeline-panel"><div class="timeline-panel-head"><div><span class="timeline-eyebrow">READING RHYTHM</span><h3>阅读节奏</h3></div><span>按天汇总阅读时长</span></div>${timelineChart(buckets, formatWords)}</section>`;
  const eventList = events.length
    ? events
        .map(
          (event, index) => `
      <article class="timeline-event-card">
        <span class="timeline-event-dot" aria-hidden="true"></span>
        <div class="timeline-event-date"><strong>${escapeHtml(formatDateTime(event.at))}</strong><span>${index === 0 ? "最近一次" : "进度记录"}</span></div>
        <div class="timeline-event-place"><span>第 ${Number(event.chapter || 0) + 1} 章</span><strong>${Number(event.progress || 0).toFixed(1)}%</strong></div>
      </article>`,
        )
        .join("")
    : '<div class="book-related-empty">从现在起，读到新的章节或进度时会记录在这里。</div>';
  return `${summary}${chart}<section class="timeline-panel timeline-history"><div class="timeline-panel-head"><div><span class="timeline-eyebrow">PROGRESS HISTORY</span><h3>进度足迹</h3></div><span>${events.length} 条记录</span></div><div class="timeline-event-list">${eventList}</div></section>`;
}

export function createBookInfoRelatedGlobal(
  runtime: BookInfoRuntime,
): BookInfoRelatedGlobal {
  const instances = new WeakMap<Document, BookInfoRelatedController>();
  const formatWords = (value: unknown): string =>
    runtime.ReaderBookInfoPanel?.fmtWords?.(value) || `${Number(value || 0)} 字`;

  const mount = (options: BookInfoRelatedOptions = {}): BookInfoRelatedController => {
    const root = options.root || runtime.document;
    const transport =
      options.transport ??
      (options.invoke ? ({ invoke: options.invoke } satisfies TauriTransport) : undefined);
    if (!root?.body || !transport) {
      throw new Error("相关图书信息层需要 root 和 invoke。");
    }
    const previous = instances.get(root);
    if (previous) return previous.configure(options);
    const api = createTauriApi<VerifiedBookInfoCommands>(transport);
    const holder = root.createElement("div");
    holder.className = "book-info-related-surfaces";
    holder.innerHTML = surfaceMarkup();
    while (holder.firstChild) root.body.appendChild(holder.firstChild);
    const similarModal = root.querySelector<HTMLElement>(
      '[data-book-related="similar"]',
    ) as HTMLElement;
    const timelineModal = root.querySelector<HTMLElement>(
      '[data-book-related="timeline"]',
    ) as HTMLElement;
    const source = similarModal.querySelector<HTMLElement>(
      "[data-book-related-source]",
    ) as HTMLElement;
    const similarList = similarModal.querySelector<HTMLElement>(
      "[data-book-related-similar-list]",
    ) as HTMLElement;
    const timelineSubtitle = timelineModal.querySelector<HTMLElement>(
      "[data-book-related-timeline-subtitle]",
    ) as HTMLElement;
    const timelineBody = timelineModal.querySelector<HTMLElement>(
      "[data-book-related-timeline-body]",
    ) as HTMLElement;
    let handlers = { ...options };

    const close = (modal: HTMLElement): void => modal.classList.remove("show");
    [similarModal, timelineModal].forEach((modal) => {
      modal
        .querySelector<HTMLElement>("[data-book-related-close]")
        ?.addEventListener("click", () => close(modal));
      modal.addEventListener("click", (event) => {
        if (event.target === modal) close(modal);
      });
    });

    const renderSimilarBooks = (list: SimilarBook[]): void => {
      similarList.replaceChildren();
      if (!Array.isArray(list) || !list.length) {
        similarList.innerHTML =
          '<div class="book-related-empty">没有找到相似图书。可以先建立语义索引，或让更多图书参与索引。</div>';
        return;
      }
      list.forEach((book) => {
        const item = root.createElement("button");
        item.type = "button";
        item.className = "similar-item";
        const cover = root.createElement("div");
        cover.className = "similar-cover";
        if (book.cover) {
          cover.classList.add("has-img");
          const image = root.createElement("img");
          image.src = book.cover;
          image.alt = book.title || "";
          cover.appendChild(image);
        } else {
          cover.style.background =
            handlers.coverColor?.(book.title || "") || defaultCoverColor(book.title);
          const spine = root.createElement("span");
          spine.className = "spine";
          const fallback = root.createElement("span");
          fallback.className = "gen";
          fallback.textContent = book.title || "未命名";
          cover.append(spine, fallback);
        }
        const body = root.createElement("div");
        body.className = "similar-body";
        const title = root.createElement("strong");
        title.className = "similar-title";
        title.textContent = book.title || "未命名";
        const score = Math.round(
          Math.max(0, Math.min(1, Number(book.score || 0))) * 100,
        );
        const meta = root.createElement("span");
        meta.className = "similar-meta";
        meta.textContent = `${book.author ? `${book.author} · ` : ""}相关性 ${score}%`;
        const bar = root.createElement("span");
        bar.className = "similar-score";
        const fill = root.createElement("span");
        fill.style.width = `${score}%`;
        bar.appendChild(fill);
        body.append(title, meta);
        if (book.description) {
          const description = root.createElement("span");
          description.className = "similar-description";
          description.textContent = book.description;
          body.appendChild(description);
        }
        body.appendChild(bar);
        item.append(cover, body);
        item.addEventListener("click", () => {
          close(similarModal);
          handlers.onOpenBook?.(book);
        });
        similarList.appendChild(item);
      });
    };

    const controller: BookInfoRelatedController = {
      configure(next = {}) {
        handlers = { ...handlers, ...next };
        return controller;
      },
      async openSimilar(id, book = {}) {
        if (!id) return;
        source.textContent = book.title
          ? `基于《${book.title}》的正文语义相似度`
          : "基于正文语义相似度";
        similarList.innerHTML =
          '<div class="book-related-empty is-loading">正在计算相似图书…</div>';
        similarModal.classList.add("show");
        try {
          renderSimilarBooks(await api.invoke("similar_books", { id: String(id) }));
        } catch (error: unknown) {
          similarList.innerHTML = `<div class="book-related-empty">读取失败：${escapeHtml(error)}</div>`;
        }
      },
      async openTimeline(id) {
        if (!id) return;
        timelineSubtitle.textContent = "正在整理阅读记录…";
        timelineBody.innerHTML =
          '<div class="book-related-empty is-loading">正在整理阅读记录…</div>';
        timelineModal.classList.add("show");
        try {
          const data = await api.invoke("book_reading_timeline", {
            id: String(id),
          });
          timelineSubtitle.textContent = data?.title
            ? `《${data.title}》的阅读轨迹`
            : "从阅读时长到进度变化";
          timelineBody.innerHTML = timelineMarkup(data || {}, formatWords);
        } catch (error: unknown) {
          timelineSubtitle.textContent = "阅读记录暂不可用";
          timelineBody.innerHTML = `<div class="book-related-empty">读取失败：${escapeHtml(error)}</div>`;
        }
      },
      closeAll() {
        close(similarModal);
        close(timelineModal);
      },
    };
    instances.set(root, controller);
    return controller;
  };

  return Object.freeze({ mount, formatDuration: formatBookInfoDuration });
}

/** Classic installer replacing `ui/book-info-related.js`. */
export function installBookInfoRelated(target: unknown): BookInfoRelatedGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createBookInfoRelatedGlobal(runtime);
  runtime.ReaderBookInfoRelated = api;
  return api;
}
