export interface BookInfoMeta extends Record<string, unknown> {
  readonly title?: unknown;
  readonly author?: unknown;
  readonly format?: unknown;
  readonly word_count?: unknown;
  readonly wordCount?: unknown;
  readonly size?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
  readonly collections?: unknown;
  readonly model_tags?: unknown;
  readonly modelTags?: unknown;
  readonly rating?: unknown;
  readonly cover?: unknown;
}

export interface BookInfoMountOptions {
  readonly root?: Document;
  readonly host?: HTMLElement | null;
  readonly prefix?: string;
  readonly coverChangeId?: string;
  readonly tagsManageId?: string;
  readonly collectionsManageId?: string;
  readonly similarId?: string;
  readonly timelineId?: string;
  readonly onRating?: (rating: number) => void;
  readonly onTitle?: (title: string) => void;
  readonly onDescription?: (description: string) => void;
  readonly onAction?: (action: string) => void;
  readonly [key: string]: unknown;
}

interface BookInfoElements extends Record<string, HTMLElement> {
  readonly cover: HTMLElement;
  readonly title: HTMLInputElement;
  readonly author: HTMLElement;
  readonly format: HTMLElement;
  readonly words: HTMLElement;
  readonly size: HTMLElement;
  readonly stars: HTMLElement & { _value?: number };
  readonly tagSummary: HTMLElement;
  readonly collectionSummary: HTMLElement;
  readonly modelTags: HTMLElement;
  readonly description: HTMLElement;
}

export interface BookInfoController {
  readonly elements: BookInfoElements;
  configure(next?: BookInfoMountOptions): BookInfoController;
  setRating(value: unknown): void;
  setLoading(): void;
  setError(error: unknown): void;
  render(meta?: BookInfoMeta): BookInfoController;
  renderCover(meta?: BookInfoMeta): void;
}

export interface BookInfoPanelApi {
  mount(options?: BookInfoMountOptions): BookInfoController;
  fmtWords(value: unknown): string;
  fmtSize(value: unknown): string;
}

interface BookInfoRuntime extends Record<string, unknown> {
  readonly document: Document;
  ReaderBookInfoPanel?: BookInfoPanelApi;
}

interface BookInfoIds extends Record<string, string> {
  readonly cover: string;
  readonly title: string;
  readonly author: string;
  readonly format: string;
  readonly words: string;
  readonly size: string;
  readonly stars: string;
  readonly tagSummary: string;
  readonly collectionSummary: string;
  readonly modelTags: string;
  readonly description: string;
  readonly coverChange: string;
  readonly tagsManage: string;
  readonly collectionsManage: string;
  readonly similar: string;
  readonly timeline: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): BookInfoRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document)) return null;
  return runtime as unknown as BookInfoRuntime;
}

function fallbackText(value: unknown, empty = "未添加"): { readonly text: string; readonly title: string } {
  const items = Array.isArray(value) ? value.filter(Boolean).map(String) : [];
  return { text: items.length ? items.join("、") : empty, title: items.join("、") };
}

export function fmtWords(value: unknown): string {
  const words = Number(value || 0);
  return words >= 10_000 ? `${(words / 10_000).toFixed(2)} 万字` : `${words} 字`;
}

export function fmtSize(value: unknown): string {
  const bytes = Number(value || 0);
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1_024) return `${Math.round(bytes / 1_024)}K`;
  return `${bytes}B`;
}

function coverColor(title: unknown): string {
  let value = 0;
  for (const character of String(title || "")) {
    value = (value * 31 + character.charCodeAt(0)) >>> 0;
  }
  return `hsl(${value % 360} 42% 42%)`;
}

function idsFor(prefix: string, options: BookInfoMountOptions): BookInfoIds {
  return {
    cover: `${prefix}-cover`,
    title: `${prefix}-title`,
    author: `${prefix}-author`,
    format: `${prefix}-format`,
    words: `${prefix}-words`,
    size: `${prefix}-size`,
    stars: `${prefix}-stars`,
    tagSummary: `${prefix}-tag-summary`,
    collectionSummary: `${prefix}-collection-summary`,
    modelTags: `${prefix}-model-tags`,
    description: `${prefix}-desc`,
    coverChange: options.coverChangeId || `${prefix}-cover-change`,
    tagsManage: options.tagsManageId || `${prefix}-tags-manage`,
    collectionsManage: options.collectionsManageId || `${prefix}-collections-manage`,
    similar: options.similarId || `${prefix}-similar-books-btn`,
    timeline: options.timelineId || `${prefix}-reading-timeline-btn`,
  };
}

function markup(ids: BookInfoIds): string {
  return `
      <section class="modal-card book-info-card">
        <section class="book-info-hero">
          <div class="book-info-cover-stack">
            <div id="${ids.cover}" class="book-info-cover" aria-label="图书封面"></div>
            <button id="${ids.coverChange}" class="book-info-cover-change" type="button" title="选择图片更换封面" data-book-info-action="cover">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h4l1.5-2h5l1.5 2h4v11H4z" /><circle cx="12" cy="13" r="3.2" /></svg><span>更换封面</span>
            </button>
          </div>
          <div class="book-info-identity">
            <section class="book-info-primary">
              <label class="book-info-title-field"><span>书名</span><input id="${ids.title}" class="info-input" type="text" autocomplete="off" /></label>
              <div class="book-info-author-field"><span>作者</span><p id="${ids.author}" class="book-info-author"></p></div>
            </section>
            <section class="book-info-facts" aria-label="图书属性">
              <div><span>格式</span><strong id="${ids.format}"></strong></div>
              <div><span>字数</span><strong id="${ids.words}"></strong></div>
              <div><span>大小</span><strong id="${ids.size}"></strong></div>
              <div><span>我的评分</span><span id="${ids.stars}" class="info-stars" title="点击打分，再点同一颗清除"></span></div>
            </section>
          </div>
        </section>
        <section class="book-info-section book-info-organization-section" aria-label="标签与收藏书单">
          <div class="book-info-organization-grid">
            <div class="book-info-organization-entry"><span class="info-k">标签</span><span id="${ids.tagSummary}" class="info-v book-info-organization-summary">未添加</span><button id="${ids.tagsManage}" class="book-info-organization-link" type="button" data-book-info-action="tags">管理</button></div>
            <div class="book-info-organization-entry"><span class="info-k">收藏书单</span><span id="${ids.collectionSummary}" class="info-v book-info-organization-summary">未添加</span><button id="${ids.collectionsManage}" class="book-info-organization-link" type="button" data-book-info-action="collections">管理</button></div>
          </div>
        </section>
        <section class="book-info-section">
          <div class="book-info-section-head"><h3>AI 分类</h3><span>自动识别</span></div>
          <div id="${ids.modelTags}" class="info-v info-chips book-info-model-tags"></div>
        </section>
        <section class="book-info-section book-info-tools">
          <div class="book-info-section-head"><h3>操作</h3></div>
          <div class="info-action-buttons"><button id="${ids.similar}" class="btn-plain" type="button" data-book-info-action="similar">相似图书</button><button id="${ids.timeline}" class="btn-plain" type="button" data-book-info-action="timeline">阅读时间线</button></div>
        </section>
        <section class="book-info-section book-info-description">
          <div class="book-info-section-head"><h3>简介</h3><span>失焦后自动保存</span></div>
          <div id="${ids.description}" class="info-desc" contenteditable="true"></div>
        </section>
      </section>`;
}

export function createBookInfoPanel(runtime: BookInfoRuntime): BookInfoPanelApi {
  const instances = new WeakMap<HTMLElement, BookInfoController>();

  const mount = (options: BookInfoMountOptions = {}): BookInfoController => {
    const root = options.root || runtime.document;
    const host = options.host;
    if (!root || !host) throw new Error("图书信息面板需要 root 和 host。");
    const previous = instances.get(host);
    if (previous) return previous;
    const ids = idsFor(options.prefix || "book-info", options);
    host.innerHTML = markup(ids);
    const elements = Object.fromEntries(
      Object.entries(ids).map(([key, id]) => [key, root.getElementById(id)]),
    ) as unknown as BookInfoElements;
    let handlers: BookInfoMountOptions = { ...options };

    const stars = Array.from({ length: 5 }, () => {
      const star = root.createElement("span");
      star.className = "star";
      const background = root.createElement("span");
      background.className = "s-bg";
      background.textContent = "★";
      const foreground = root.createElement("span");
      foreground.className = "s-fg";
      foreground.textContent = "★";
      star.append(background, foreground);
      elements.stars.appendChild(star);
      return star;
    });
    const paintStars = (value: number): void => {
      stars.forEach((star, index) => {
        const foreground = star.querySelector<HTMLElement>(".s-fg");
        if (foreground) {
          foreground.style.width = `${Math.max(0, Math.min(1, value - index)) * 100}%`;
        }
      });
    };
    const ratingAt = (event: MouseEvent): number => {
      for (let index = 0; index < stars.length; index += 1) {
        const star = stars[index];
        if (!star) continue;
        const bounds = star.getBoundingClientRect();
        if (event.clientX <= bounds.right) {
          return index + (event.clientX < bounds.left + bounds.width / 2 ? 0.5 : 1);
        }
      }
      return 5;
    };
    elements.stars.addEventListener("mousemove", (event) => paintStars(ratingAt(event)));
    elements.stars.addEventListener("mouseleave", () => paintStars(elements.stars._value || 0));
    elements.stars.addEventListener("click", (event) => {
      let rating = ratingAt(event);
      if (rating === elements.stars._value) rating = 0;
      controller.setRating(rating);
      handlers.onRating?.(rating);
    });
    elements.title.addEventListener("blur", () =>
      handlers.onTitle?.(elements.title.value.trim()),
    );
    elements.description.addEventListener("blur", () =>
      handlers.onDescription?.((elements.description.textContent ?? "").trim()),
    );
    host.addEventListener("click", (event) => {
      const target = event.target as { closest?: unknown } | null;
      const closest =
        typeof target?.closest === "function"
          ? target.closest("[data-book-info-action]")
          : null;
      const action = (closest as HTMLElement | null)?.dataset.bookInfoAction;
      if (action) handlers.onAction?.(action);
    });

    const renderCover = (meta: BookInfoMeta = {}): void => {
      const title = String(meta.title || elements.title.value || "未命名");
      const renderFallback = (): void => {
        const fallback = root.createElement("span");
        fallback.className = "book-info-cover-fallback";
        fallback.style.background = coverColor(title);
        fallback.textContent = title.slice(0, 18);
        elements.cover.replaceChildren(fallback);
      };
      if (!meta.cover) {
        renderFallback();
        return;
      }
      const image = root.createElement("img");
      image.src = String(meta.cover);
      image.alt = title;
      image.draggable = false;
      image.decoding = "async";
      image.addEventListener("error", renderFallback, { once: true });
      elements.cover.replaceChildren(image);
    };
    const renderModelTags = (values: unknown): void => {
      elements.modelTags.replaceChildren();
      const tags = Array.isArray(values) ? values.filter(Boolean) : [];
      if (!tags.length) {
        const empty = root.createElement("span");
        empty.className = "info-chip empty";
        empty.textContent = "未添加";
        elements.modelTags.appendChild(empty);
        return;
      }
      tags.forEach((value) => {
        const chip = root.createElement("span");
        chip.className = "info-chip model-tag";
        const origin = root.createElement("span");
        origin.className = "info-chip-origin";
        origin.textContent = "AI";
        chip.append(origin, root.createTextNode(String(value)));
        chip.title = "大模型分类标签";
        elements.modelTags.appendChild(chip);
      });
    };
    const controller: BookInfoController = {
      elements,
      configure(next: BookInfoMountOptions = {}) {
        handlers = { ...handlers, ...next };
        return controller;
      },
      setRating(value: unknown) {
        elements.stars._value = Number(value) || 0;
        paintStars(elements.stars._value);
      },
      setLoading() {
        elements.words.textContent = "统计中…";
      },
      setError(error: unknown) {
        elements.words.textContent = `读取失败：${String(error)}`;
      },
      render(meta: BookInfoMeta = {}) {
        elements.title.value = String(meta.title || "");
        elements.author.textContent = String(meta.author || "未知");
        elements.format.textContent = String(meta.format || "").toUpperCase();
        elements.words.textContent = fmtWords(meta.word_count ?? meta.wordCount);
        elements.size.textContent = fmtSize(meta.size);
        elements.description.textContent = String(meta.description || "");
        const tags = fallbackText(meta.tags);
        const collections = fallbackText(meta.collections);
        elements.tagSummary.textContent = tags.text;
        elements.tagSummary.title = tags.title;
        elements.collectionSummary.textContent = collections.text;
        elements.collectionSummary.title = collections.title;
        renderModelTags(meta.model_tags || meta.modelTags);
        controller.setRating(meta.rating || 0);
        renderCover(meta);
        return controller;
      },
      renderCover,
    };
    instances.set(host, controller);
    return controller;
  };

  return Object.freeze({ mount, fmtWords, fmtSize });
}

/** Classic installer replacing `ui/book-info-panel.js`. */
export function installBookInfoPanel(target: unknown): BookInfoPanelApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createBookInfoPanel(runtime);
  runtime.ReaderBookInfoPanel = api;
  return api;
}
