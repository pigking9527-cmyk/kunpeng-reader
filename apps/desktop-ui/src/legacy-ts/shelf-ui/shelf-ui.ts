import { createTauriApi } from "../../../../../packages/tauri-api/src/index.js";
import type {
  TauriCommandMap,
  TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import type {
  ShelfBook,
  ShelfSortKey,
  ShelfUiRulesApi,
} from "../main/shelf-ui-rules.js";

type OrganizationField = "tags" | "collections";
type ReadingStatus = "unread" | "reading" | "done";
type ShelfLayout = "grid" | "list";
type DialogSelection = string | readonly string[] | null;
type LegacyInvoke = <TResult>(command: string, args?: Record<string, unknown>) => Promise<TResult>;

interface ShelfDialogPort {
  open(options: Readonly<{ multiple: boolean; filters: readonly Readonly<{ name: string; extensions: readonly string[] }>[] }>): Promise<DialogSelection>;
}
interface ShelfBookRecord extends Omit<ShelfBook, "id" | "title" | "tags" | "collections"> {
  readonly id: string | number;
  readonly title: string;
  readonly progress: number;
  readonly rating: number;
  readonly format?: string;
  readonly tags?: string[];
  readonly collections?: string[];
}
interface BooklistRecord {
  name: string;
  description?: string;
  cover_book_id?: string | number;
  book_ids?: string[];
  reviews?: Record<string, string>;
}
interface OrganizationEntry { name: string; key: string; count: number }
interface OrganizationFilterDraft { field: OrganizationField; keys: Set<string> }
interface BatchOrganizationDraft { field: OrganizationField; names: Map<string, string> }
interface BooklistDragState { row: HTMLElement; placeholder: HTMLElement; offsetY: number }
interface StarElement extends HTMLElement { _val?: number; setVal(value: number): void }
interface ShelfCoverLoadingRules {
  coverLoadPriority(index: number, count: number): Readonly<{ decoding: "async" | "sync" | "auto"; fetchPriority: "high" | "low" | "auto"; loading: "eager" | "lazy" }>;
  estimateFirstScreenCoverCount(options: Readonly<{ gridColumns: number; height: number; layout: ShelfLayout; width: number }>): number;
  firstScreenCoverCount(...args: readonly unknown[]): number;
}
interface ShelfRuntime extends Window {
  ReaderShelfRules?: ShelfUiRulesApi;
  ReaderShelfCoverLoadingRules?: ShelfCoverLoadingRules;
  ReaderShelfUI?: ShelfUiGlobal;
  ReaderAppI18n?: { t?(key: string): string | undefined };
  ReaderProblemTraceUI?: { recordShelfBookOpen?(status: string, input: string): void };
  ReaderAnimationSettings?: { enabled?(name: string): boolean };
  ReaderShellPreloadSettings?: { enabled(): boolean };
}
interface ShelfCommands extends TauriCommandMap {
  add_books_organization: { readonly args: { readonly ids: (string | number)[]; readonly field: "tag" | "collection"; readonly names: string[] }; readonly result: ShelfBookRecord[] };
  book_file_sizes: { readonly result: Record<string, number> };
  list_booklists: { readonly result: BooklistRecord[] };
  list_books: { readonly result: ShelfBookRecord[] };
  open_book: { readonly args: { readonly id: string | number }; readonly result: void };
  prewarm_book: { readonly args: { readonly id: string | number }; readonly result: void };
  relocate_book: { readonly args: { readonly id: string | number; readonly path: string }; readonly result: ShelfBookRecord[] };
  remove_books: { readonly args: { readonly ids: (string | number)[] }; readonly result: ShelfBookRecord[] };
  set_cover: { readonly args: { readonly id: string | number; readonly path: string }; readonly result: ShelfBookRecord[] };
  update_booklist: { readonly args: { readonly name: string; readonly description: string; readonly coverBookId: string; readonly bookIds: string[]; readonly reviews: Record<string, string> }; readonly result: BooklistRecord[] };
}
export interface ShelfUiOptions {
  readonly root?: Document;
  readonly invoke?: LegacyInvoke;
  readonly transport?: TauriTransport;
  readonly dialog?: ShelfDialogPort;
  readonly storage?: Storage;
  readonly menuElement?: HTMLElement | null;
  readonly filterPanel?: HTMLElement | null;
  readonly filterPanelElement?: HTMLElement | null;
  readonly closeAccountPanel?: () => void;
  readonly closeSearch?: (restoreFocus: boolean) => void;
  readonly clearCrossReturnMemory?: () => void;
  readonly startPerformance?: (name: string, details?: string) => ((details?: string) => void) | void;
  readonly confirmAction?: (message: string) => boolean;
  readonly alertAction?: (message: string, options?: Record<string, unknown>) => void;
  readonly requestAnimationFrame?: (callback: FrameRequestCallback) => number;
}
export interface ShelfUiController {
  applyView(options?: Readonly<{ preserveScroll?: boolean }>): void;
  changeCoverById(id: string | number): Promise<void>;
  clearSelection(): void;
  count(): number;
  coverColor(title: unknown): string;
  getBook(id: string | number): ShelfBookRecord | null;
  getBooks(): ShelfBookRecord[];
  getSearchQuery(): string;
  getSelectedIds(): Array<string | number>;
  getVisibleBooks(): ShelfBookRecord[];
  focusShelf(): void;
  makeStars(container: StarElement, onPick: (value: number) => void): void;
  openBooklist(name: unknown): Promise<void>;
  render(list: ShelfBookRecord[]): void;
  selectAll(): void;
  setSearchQuery(value: unknown): void;
  updateBook(id: string | number, patch: Partial<ShelfBookRecord>): void;
}
export interface ShelfUiGlobal {
  clearSelection(): void;
  getSearchQuery(): string;
  getSelectedIds(): Array<string | number>;
  init(options?: ShelfUiOptions): ShelfUiController;
  focusShelf(): void;
  openBooklist(name: unknown): Promise<void>;
  refresh(): void;
  render(list: ShelfBookRecord[]): void;
  setSearchQuery(value: unknown): void;
}
function runtimeFrom(value: unknown): ShelfRuntime | null {
  return typeof value === "object" && value !== null && typeof (value as Partial<Window>).addEventListener === "function"
    ? value as ShelfRuntime : null;
}

// 书架渲染、选择、批量操作、排序、过滤与自定义滚动条。
// 所有外部能力由 app.js 通过 ReaderShelfUI.init 显式注入。
export function installShelfUi(target: unknown): ShelfUiGlobal | null {
const candidate = runtimeFrom(target);
if (!candidate) return null;
const global = candidate;
let activeController: ShelfUiController | null = null;

function init(options: ShelfUiOptions = {}): ShelfUiController {
  if (activeController) return activeController;
  const document = options.root;
  const invoke: LegacyInvoke | undefined = options.invoke ?? options.transport?.invoke;
  const dialog = options.dialog;
  const localStorage = options.storage || global.localStorage;
  const menuOption = options.menuElement;
  const filterPanelOption = options.filterPanel;
  const closeAccountPanel = options.closeAccountPanel;
  const closeSearch = options.closeSearch;
  const clearCrossReturnMemory = options.clearCrossReturnMemory;
  const startPerformance = options.startPerformance;
  const confirmAction = options.confirmAction || ((message) => global.confirm(message));
  const alertAction = options.alertAction || ((message) => global.alert(message));
  const requestFrame = options.requestAnimationFrame || ((callback) => global.requestAnimationFrame(callback));
  if (!document || typeof document.getElementById !== "function") throw new Error("ReaderShelfUI.init 缺少 root");
  if (typeof invoke !== "function" || !dialog) throw new Error("ReaderShelfUI.init 缺少后端或对话框接口");
  if (!menuOption || !filterPanelOption) throw new Error("ReaderShelfUI.init 缺少浮层元素");
  if (typeof closeAccountPanel !== "function" || typeof closeSearch !== "function") throw new Error("ReaderShelfUI.init 缺少浮层关闭接口");
  if (typeof clearCrossReturnMemory !== "function" || typeof startPerformance !== "function") throw new Error("ReaderShelfUI.init 缺少书架生命周期接口");
  const rules = global.ReaderShelfRules;
  if (!rules) throw new Error("ReaderShelfUI.init 缺少纯规则模块");
  const shelfRules: ShelfUiRulesApi = rules;
  const rootDoc: Document = document;
  const tauriApi = createTauriApi<ShelfCommands>({ invoke });
  const dialogPort: ShelfDialogPort = dialog;
  const menuElement: HTMLElement = menuOption;
  const filterPanelElement: HTMLElement = filterPanelOption;
  const closeAccount: () => void = closeAccountPanel;
  const closeShelfSearch: (restoreFocus: boolean) => void = closeSearch;
  const clearCrossReturn: () => void = clearCrossReturnMemory;
  const startShelfPerformance = startPerformance;

  const required = <TElement extends HTMLElement = HTMLElement>(id: string): TElement => {
    const element = rootDoc.getElementById(id);
    if (!element) throw new Error(`ReaderShelfUI.init 缺少 #${id}`);
    return element as TElement;
  };

const shelfEl = required("shelf");
const emptyEl = required("empty");
const contentEl = rootDoc.querySelector<HTMLElement>(".content");
const shelfScrollbar = required("shelf-scrollbar");
const shelfScrollbarThumb = required("shelf-scrollbar-thumb");
const filterButton = required("filter-btn");
const filterResultSummary = rootDoc.getElementById("filter-result-summary");
const readingFilterAllButton = rootDoc.getElementById("reading-filter-all");
const tagFilterList = rootDoc.getElementById("tag-filter-list");
const collectionFilterList = rootDoc.getElementById("collection-filter-list");
const organizationMatchModeButton = rootDoc.getElementById("organization-match-mode");
const organizationFilterModal = rootDoc.getElementById("organization-filter-modal");
const organizationFilterTitle = rootDoc.getElementById("organization-filter-title");
const organizationFilterNote = rootDoc.getElementById("organization-filter-note");
const organizationFilterOptions = rootDoc.getElementById("organization-filter-options");
const organizationFilterClose = rootDoc.getElementById("organization-filter-close");
const organizationFilterCancel = rootDoc.getElementById("organization-filter-cancel");
const organizationFilterClear = rootDoc.getElementById("organization-filter-clear");
const organizationFilterApply = rootDoc.getElementById("organization-filter-apply");
const batchTagButton = rootDoc.getElementById("batch-tag-btn");
const batchCollectionButton = rootDoc.getElementById("batch-collection-btn");
const batchOrganizationModal = rootDoc.getElementById("batch-organization-modal");
const batchOrganizationTitle = rootDoc.getElementById("batch-organization-title");
const batchOrganizationNote = rootDoc.getElementById("batch-organization-note");
const batchOrganizationOptions = rootDoc.getElementById("batch-organization-options");
const batchOrganizationNew = rootDoc.getElementById("batch-organization-new") as HTMLInputElement | null;
const batchOrganizationAdd = rootDoc.getElementById("batch-organization-add");
const batchOrganizationClose = rootDoc.getElementById("batch-organization-close");
const batchOrganizationCancel = rootDoc.getElementById("batch-organization-cancel");
const batchOrganizationApply = rootDoc.getElementById("batch-organization-apply");
const booklistModal = rootDoc.getElementById("booklist-modal");
const booklistTitle = rootDoc.getElementById("booklist-title");
const booklistClose = rootDoc.getElementById("booklist-close");
const booklistCover = rootDoc.getElementById("booklist-cover");
const booklistDescription = required<HTMLTextAreaElement>("booklist-description");
const booklistBooks = required("booklist-books");
let activeBooklist: BooklistRecord | null = null;
let books: ShelfBookRecord[] = [];
// 旧版本会持久化不同排序，单纯修改 fallback 无法改变已有用户。按规则版本
// 统一迁移一次到最近阅读；迁移完成后，用户重新选择的书名、
// 作者、导入时间等模式仍严格保留。
const sortPreference = shelfRules.resolveShelfSortPreference(
  localStorage.getItem("shelfSort"),
  localStorage.getItem("shelfSortMigrationRevision"),
);
let sortKey: ShelfSortKey = sortPreference.sortKey;
if (sortPreference.shouldPersist) {
  localStorage.setItem("shelfSort", sortPreference.sortKey);
  localStorage.setItem("shelfSortMigrationRevision", sortPreference.revision);
}
const bookFileSizes = new Map<string, number>();
let bookFileSizesPromise: Promise<void> | null = null;
let layout: ShelfLayout = localStorage.getItem("shelfLayout") === "list" ? "list" : "grid";
const GRID_COL_MIN = 1;
const GRID_COL_MAX = 12;
let shelfGridColumns = shelfRules.parseGridColumns(localStorage.getItem("shelfGridColumns") || "0");
let shelfGridColumnsValue = shelfRules.parseGridColumns(localStorage.getItem("shelfGridColumnsValue") || "3") || 3;
let readingFilter: Record<ReadingStatus, boolean> = { unread: true, reading: true, done: true };
try {
  readingFilter = Object.assign(readingFilter, JSON.parse(localStorage.getItem("readingFilter") || "{}"));
} catch {}
let minRating = +(localStorage.getItem("minRating") || 0);
let searchQuery = "";
let selected = new Set<string | number>();
const shelfText = (key: string, fallback: string) => global.ReaderAppI18n?.t?.(key) || fallback;
const organizationName = shelfRules.organizationName;
const organizationKey = shelfRules.organizationKey;
function loadOrganizationFilter(key: string): Set<string> {
  try {
    const values = JSON.parse(localStorage.getItem(key) || "[]");
    return new Set<string>(Array.isArray(values) ? values.map(organizationKey).filter(Boolean) : []);
  } catch { return new Set(); }
}
function saveOrganizationFilter(key: string, values: ReadonlySet<string>) {
  localStorage.setItem(key, JSON.stringify(Array.from(values)));
}
let tagFilter = loadOrganizationFilter("shelfTagFilter");
let collectionFilter = loadOrganizationFilter("shelfCollectionFilter");
let organizationMatchMode: "all" | "any" = localStorage.getItem("shelfOrganizationMatchMode") === "all" ? "all" : "any";
let organizationFilterDraft: OrganizationFilterDraft | null = null;
let organizationFilterReturnToPanel = false;
let shelfLoaded = false;
let showCoverProgress = localStorage.getItem("showCoverProgress") !== "0";
let showCoverRating = localStorage.getItem("showCoverRating") !== "0";
let showCoverTitle = localStorage.getItem("showCoverTitle") === "1";
// 旧版本可能把书架留在“双击打开”状态，导致升级后第一次单击只选中、
// 第二次才打开。按交互版本只迁移一次；之后用户仍可显式切回双击。
const SHELF_OPEN_INTERACTION_REVISION = "single-click-default-v1";
if (localStorage.getItem("shelfOpenInteractionRevision") !== SHELF_OPEN_INTERACTION_REVISION) {
  localStorage.setItem("shelfSingleClickOpen", "1");
  localStorage.setItem("shelfOpenInteractionRevision", SHELF_OPEN_INTERACTION_REVISION);
}
let singleClickOpensBook = localStorage.getItem("shelfSingleClickOpen") !== "0";
// 所有封面都立即拥有 URL；原生 lazy 只调整浏览器的请求调度，不能制造空白书卡。
const DEFAULT_FIRST_SCREEN_COVER_COUNT = 24;
const MAX_FIRST_SCREEN_COVER_COUNT = 160;
let firstScreenCoverCount = DEFAULT_FIRST_SCREEN_COVER_COUNT;
const coverRulesCandidate = global.ReaderShelfCoverLoadingRules;
const coverLoadingRules = coverRulesCandidate && [
  coverRulesCandidate.coverLoadPriority,
  coverRulesCandidate.estimateFirstScreenCoverCount,
  coverRulesCandidate.firstScreenCoverCount,
].every((value) => typeof value === "function")
  ? coverRulesCandidate
  : null;

// 书架是应用控件，不是网页正文。禁止浏览器把拖过的封面图片、书名和进度
// 当成可拖对象或文本选区；多选只通过阅读器自己的选中态完成。
shelfEl.addEventListener("dragstart", (event) => event.preventDefault());
shelfEl.addEventListener("selectstart", (event) => event.preventDefault());

function setSingleClickOpenPreference(value: boolean) {
  singleClickOpensBook = value !== false;
  localStorage.setItem("shelfSingleClickOpen", singleClickOpensBook ? "1" : "0");
}


function estimateFirstScreenCoverCount() {
  const width = Number(contentEl?.clientWidth || 0);
  const height = Number(contentEl?.clientHeight || 0);
  if (coverLoadingRules) {
    return coverLoadingRules.estimateFirstScreenCoverCount({
      gridColumns: shelfGridColumns,
      height,
      layout,
      width,
    });
  }
  if (width <= 0 || height <= 0) return 0;
  if (layout === "list") return Math.max(1, Math.ceil(height / 108));
  const columns = shelfGridColumns > 0
    ? shelfGridColumns
    : Math.max(1, Math.floor((Math.max(0, width - 40) + 18) / 158));
  // 网格封面 190px，高度间距 18px；标题隐藏时仍保留卡片的最小行高。
  const rows = Math.max(1, Math.ceil(Math.max(0, height - 40) / 208));
  return Math.min(MAX_FIRST_SCREEN_COVER_COUNT, columns * rows);
}


// 通用半星组件：左半=半星、右半=整星。
function makeStars(container: StarElement, onPick: (value: number) => void) {
  for (let i = 0; i < 5; i++) {
    const star = rootDoc.createElement("span");
    star.className = "star";
    const background = rootDoc.createElement("span");
    background.className = "s-bg";
    background.textContent = "★";
    const foreground = rootDoc.createElement("span");
    foreground.className = "s-fg";
    foreground.textContent = "★";
    star.append(background, foreground);
    container.appendChild(star);
  }
  const stars = [...container.querySelectorAll(".star")];
  function paint(value: number) {
    stars.forEach((star, index) => {
      const fill = Math.max(0, Math.min(1, value - index));
      const foreground = star.querySelector<HTMLElement>(".s-fg");
      if (foreground) foreground.style.width = fill * 100 + "%";
    });
  }
  function valueAt(event: MouseEvent) {
    for (let i = 0; i < stars.length; i++) {
      const star = stars[i];
      if (!star) continue;
      const rect = star.getBoundingClientRect();
      if (event.clientX <= rect.right) return i + (event.clientX < rect.left + rect.width / 2 ? 0.5 : 1);
    }
    return 5;
  }
  container.addEventListener("mousemove", (event) => paint(valueAt(event)));
  container.addEventListener("mouseleave", () => paint(container._val || 0));
  container.addEventListener("click", (event) => {
    let value = valueAt(event);
    if (value === container._val) value = 0;
    container._val = value;
    paint(value);
    onPick(value);
  });
  container.setVal = (value) => {
    container._val = value || 0;
    paint(container._val);
  };
  paint(0);
}

filterButton.addEventListener("click", (event) => {
  event.stopPropagation();
  menuElement.classList.remove("show");
  closeAccount();
  closeShelfSearch(true);
  filterPanelElement.classList.toggle("show");
});
filterPanelElement.addEventListener("click", (event) => event.stopPropagation());
rootDoc.querySelectorAll<HTMLInputElement>('input[name="sort"]').forEach((radio) => {
  radio.checked = radio.value === sortKey;
  radio.addEventListener("change", () => {
    if (!radio.checked) return;
    sortKey = radio.value as ShelfSortKey;
    localStorage.setItem("shelfSort", sortKey);
    if (sortKey === "size") void ensureBookFileSizes();
    applyView();
  });
});

async function ensureBookFileSizes() {
  if (bookFileSizesPromise) return bookFileSizesPromise;
  bookFileSizesPromise = tauriApi.invoke("book_file_sizes")
    .then((sizes) => {
      Object.entries(sizes || {}).forEach(([id, bytes]) => {
        bookFileSizes.set(String(id), Number(bytes) || 0);
      });
      if (sortKey === "size") applyView();
    })
    .catch(() => {})
    .finally(() => { bookFileSizesPromise = null; });
  return bookFileSizesPromise;
}
if (sortKey === "size") void ensureBookFileSizes();
rootDoc.querySelectorAll<HTMLInputElement>(".rfilter").forEach((checkbox) => {
  const status = checkbox.value as ReadingStatus;
  checkbox.checked = !!readingFilter[status];
  checkbox.addEventListener("change", () => {
    readingFilter[status] = checkbox.checked;
    localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
    applyView();
  });
});
const filterStarsEl = required<StarElement>("filter-stars");
makeStars(filterStarsEl, (value) => {
  minRating = value > 0 && books.length && !books.some((book) => (book.rating || 0) >= value) ? 0 : value;
  if (minRating > 0) localStorage.setItem("minRating", String(minRating));
  else localStorage.removeItem("minRating");
  filterStarsEl.setVal(minRating);
  applyView();
});
filterStarsEl.setVal(minRating);

readingFilterAllButton?.addEventListener("click", () => {
  readingFilter = { unread: true, reading: true, done: true };
  localStorage.setItem("readingFilter", JSON.stringify(readingFilter));
  rootDoc.querySelectorAll<HTMLInputElement>(".rfilter").forEach((checkbox) => { checkbox.checked = true; });
  minRating = 0;
  localStorage.removeItem("minRating");
  filterStarsEl.setVal(0);
  tagFilter.clear();
  collectionFilter.clear();
  saveOrganizationFilter("shelfTagFilter", tagFilter);
  saveOrganizationFilter("shelfCollectionFilter", collectionFilter);
  renderOrganizationFilters();
  applyView();
});

const setCoverProgress = required<HTMLInputElement>("set-cover-prog");
const setCoverRating = required<HTMLInputElement>("set-cover-rating");
const setCoverTitle = required<HTMLInputElement>("set-cover-title");
const setSingleClickOpen = rootDoc.getElementById("set-single-click-open") as HTMLInputElement | null;
const openBookLabel = rootDoc.getElementById("set-open-book-label");
function reflectOpenBookPreference() {
  if (!setSingleClickOpen || !openBookLabel) return;
  setSingleClickOpen.checked = singleClickOpensBook;
  openBookLabel.textContent = singleClickOpensBook ? "单击打开图书" : "双击打开图书";
}
setCoverProgress.checked = showCoverProgress;
setCoverProgress.addEventListener("change", () => {
  showCoverProgress = setCoverProgress.checked;
  localStorage.setItem("showCoverProgress", showCoverProgress ? "1" : "0");
  applyView();
});
setCoverRating.checked = showCoverRating;
setCoverRating.addEventListener("change", () => {
  showCoverRating = setCoverRating.checked;
  localStorage.setItem("showCoverRating", showCoverRating ? "1" : "0");
  applyView();
});
setCoverTitle.checked = showCoverTitle;
setCoverTitle.addEventListener("change", () => {
  showCoverTitle = setCoverTitle.checked;
  localStorage.setItem("showCoverTitle", showCoverTitle ? "1" : "0");
  applyView();
});
reflectOpenBookPreference();
setSingleClickOpen?.addEventListener("change", () => {
  setSingleClickOpenPreference(setSingleClickOpen.checked);
  reflectOpenBookPreference();
});

function updateLayoutButtons() {
  rootDoc.querySelectorAll<HTMLElement>(".layout-btn").forEach((button) => button.classList.toggle("active", button.dataset.layout === layout));
}
function updateGridColumnsControls() {
  const defaultButton = rootDoc.getElementById("grid-cols-default");
  const valueElement = rootDoc.getElementById("grid-cols-value");
  if (defaultButton) defaultButton.classList.toggle("active", !shelfGridColumns);
  if (valueElement) valueElement.textContent = String(shelfGridColumns || shelfGridColumnsValue);
}
function saveGridColumns() {
  localStorage.setItem("shelfGridColumns", shelfGridColumns ? String(shelfGridColumns) : "0");
  localStorage.setItem("shelfGridColumnsValue", String(shelfGridColumnsValue));
}
function applyShelfGridColumns() {
  const fixed = layout === "grid" && shelfGridColumns > 0;
  shelfEl.classList.toggle("fixed-cols", fixed);
  if (fixed) shelfEl.style.setProperty("--shelf-grid-cols", String(shelfGridColumns));
  else shelfEl.style.removeProperty("--shelf-grid-cols");
}
rootDoc.querySelectorAll<HTMLElement>(".layout-btn").forEach((button) => {
  button.addEventListener("click", () => {
    layout = button.dataset.layout === "list" ? "list" : "grid";
    localStorage.setItem("shelfLayout", layout);
    updateLayoutButtons();
    applyView();
  });
});
updateLayoutButtons();
updateGridColumnsControls();
rootDoc.getElementById("grid-cols-default")?.addEventListener("click", () => {
  shelfGridColumns = 0;
  saveGridColumns();
  updateGridColumnsControls();
  applyView();
});
rootDoc.getElementById("grid-cols-dec")?.addEventListener("click", () => {
  shelfGridColumnsValue = Math.max(GRID_COL_MIN, (shelfGridColumns || shelfGridColumnsValue) - 1);
  shelfGridColumns = shelfGridColumnsValue;
  layout = "grid";
  localStorage.setItem("shelfLayout", layout);
  saveGridColumns();
  updateLayoutButtons();
  updateGridColumnsControls();
  applyView();
});
rootDoc.getElementById("grid-cols-inc")?.addEventListener("click", () => {
  shelfGridColumnsValue = Math.min(GRID_COL_MAX, (shelfGridColumns || shelfGridColumnsValue) + 1);
  shelfGridColumns = shelfGridColumnsValue;
  layout = "grid";
  localStorage.setItem("shelfLayout", layout);
  saveGridColumns();
  updateLayoutButtons();
  updateGridColumnsControls();
  applyView();
});

// 只读的评分小星（支持半星），叠在封面底部
function staticStars(v: number) {
  const wrap = rootDoc.createElement("div");
  wrap.className = "cover-stars";
  for (let i = 0; i < 5; i++) {
    const st = rootDoc.createElement("span");
    st.className = "star";
    const bg = rootDoc.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = rootDoc.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    fg.style.width = Math.max(0, Math.min(1, v - i)) * 100 + "%";
    st.append(bg, fg);
    wrap.appendChild(st);
  }
  return wrap;
}

function closeShelfCardFloaters() {
  // 书卡会阻止事件冒泡，因此不能依赖 document 的兜底点击处理器。
  menuElement.classList.remove("show");
  filterPanelElement.classList.remove("show");
  closeAccount();
  closeShelfSearch(false);
}

function bookCard(b: ShelfBookRecord, index = 0) {
  const card = rootDoc.createElement("div");
  card.className = "book";

  const cover = rootDoc.createElement("div");
  cover.className = "cover";

  if (b.cover) {
    // 所有封面先拥有 URL；首屏优先同步解码，余下由浏览器原生 lazy 调度。
    cover.classList.add("has-img");
    const img = rootDoc.createElement("img");
    img.alt = b.title;
    img.draggable = false;
    const coverPriority = coverLoadingRules
      ? coverLoadingRules.coverLoadPriority(index, firstScreenCoverCount)
      : (index < firstScreenCoverCount
        ? { decoding: "sync", fetchPriority: "high", loading: "eager" }
        : { decoding: "async", fetchPriority: "auto", loading: "lazy" });
    img.loading = coverPriority.loading as "eager" | "lazy";
    img.decoding = coverPriority.decoding as "async" | "sync" | "auto";
    img.fetchPriority = coverPriority.fetchPriority;
    img.src = b.cover;
    cover.appendChild(img);
  } else {
    // 生成的占位封面：书名 + 配色
    cover.style.background = shelfRules.colorFor(b.title);
    const spine = rootDoc.createElement("div");
    spine.className = "spine";
    const gen = rootDoc.createElement("div");
    gen.className = "gen";
    gen.textContent = b.title;
    cover.appendChild(spine);
    cover.appendChild(gen);
  }
  if (b.progress > 0 && showCoverProgress) {
    const badge = rootDoc.createElement("div");
    badge.className = "badge";
    badge.textContent = b.progress.toFixed(0) + "%"; // 封面右下角阅读进度
    cover.appendChild(badge);
  }
  if (b.missing) {
    card.classList.add("missing");
    const warn = rootDoc.createElement("div");
    warn.className = "missing-badge";
    warn.textContent = "⚠ 文件丢失";
    cover.appendChild(warn);
  }
  if (showCoverRating && b.rating > 0) cover.appendChild(staticStars(b.rating)); // 封面底部评分小星

  const title = rootDoc.createElement("div");
  title.className = "title";
  title.textContent = b.title;

  const prog = rootDoc.createElement("div");
  prog.className = "prog";
  prog.textContent = b.progress > 0 ? b.progress.toFixed(1) + "%" : "未读";

  card.dataset.id = String(b.id);
  card.dataset.problemTarget = "book-card";
  card.dataset.renderKey = shelfRules.bookRenderKey(b, { showCoverProgress, showCoverRating });
  if (selected.has(b.id)) card.classList.add("selected");

  card.appendChild(cover);
  card.appendChild(title);
  card.appendChild(prog);

  // 单击打开必须立即响应；需要多选时用 Command/Ctrl+单击。
  let selectionTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionBeforeClick = false;
  let selectionApplied = false;
  const restoreDeferredSelection = () => {
    if (selectionApplied && selected.has(b.id) !== selectionBeforeClick) {
      toggleSelect(b.id, card);
    }
    selectionApplied = false;
  };
  let openingBook = false;
  let prewarmStarted = false;
  let suppressPrimaryMouseClick = false;
  const prewarmBook = () => {
    if (prewarmStarted || b.missing || global.ReaderShellPreloadSettings?.enabled() === false) return;
    prewarmStarted = true;
    tauriApi.invoke("prewarm_book", { id: b.id }).catch(() => {});
  };
  card.addEventListener("pointerenter", prewarmBook, { once: true });
  card.addEventListener("pointerdown", prewarmBook, { once: true });
  card.addEventListener("focus", prewarmBook, { once: true });
  const openBook = (input: string) => {
    if (b.missing) {
      global.ReaderProblemTraceUI?.recordShelfBookOpen?.("missing", input);
      relocateBook(b);
      return;
    }
    // 关闭阅读窗口到 Tauri 注销同名 WebView 之间有极短过渡期。以前这里
    // 直接把“仍在关闭”显示为失败，用户只好手动再点一次；首次点击应当
    // 自己排队重试，其他错误仍立即、明确地交给用户处理。
    if (openingBook) return;
    openingBook = true;
    clearCrossReturn();
    global.ReaderProblemTraceUI?.recordShelfBookOpen?.("requested", input);
    const attemptOpen = (retry: number): Promise<void> => tauriApi.invoke("open_book", { id: b.id }).then(() => {
      global.ReaderProblemTraceUI?.recordShelfBookOpen?.("ok", input);
      openingBook = false;
    }).catch((err) => {
      const message = String(err);
      if (message.includes("阅读窗口仍在关闭") && retry < 3) {
        global.ReaderProblemTraceUI?.recordShelfBookOpen?.("retry", input);
        setTimeout(() => attemptOpen(retry + 1), 180);
        return;
      }
      openingBook = false;
      global.ReaderProblemTraceUI?.recordShelfBookOpen?.("failed", input);
      if (message.includes("丢失") || message.includes("定位")) relocateBook(b);
      else alertAction("打开失败：" + message);
    });
    void attemptOpen(0);
  };
  card.addEventListener("pointerdown", (e) => {
    // WebView2 在主窗口刚重新激活时可能只交付 pointerdown，不再生成
    // click。鼠标主键因此在 pointerdown 就打开；触摸、笔和键盘继续走
    // click，避免触摸滚动刚按下便误开图书。
    if (!shelfRules.shouldOpenBookOnPrimaryPointerDown({
      singleClickOpensBook,
      pointerType: e.pointerType,
      button: e.button,
      isPrimary: e.isPrimary,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      hasSelection: selected.size > 0,
    })) {
      if (e.pointerType !== "mouse") suppressPrimaryMouseClick = false;
      return;
    }
    e.stopPropagation();
    closeShelfCardFloaters();
    suppressPrimaryMouseClick = true;
    openBook("pointerdown");
  });
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    closeShelfCardFloaters();
    if (!singleClickOpensBook) {
      // 双击打开模式：先等一个很短的判定窗口。快速双击会在 dblclick
      // 中取消这个延迟选择，因而不会出现“第一下先选中”的闪动。
      if (e.detail !== 1) return;
      selectionBeforeClick = selected.has(b.id);
      selectionApplied = false;
      selectionTimer = setTimeout(() => {
        selectionTimer = null;
        toggleSelect(b.id, card);
        selectionApplied = true;
      }, 180);
      return;
    }
    if (e.metaKey || e.ctrlKey || selected.size > 0) {
      if (e.detail === 1) toggleSelect(b.id, card);
      return;
    }
    // 主鼠标这一物理序列已在 pointerdown 打开。吞掉随后派生的 click，
    // 包括浏览器计为 detail=2 的快速第二击；触摸和键盘的 click 未设置
    // 此标记，仍可正常打开。
    if (suppressPrimaryMouseClick && e.detail > 0) {
      suppressPrimaryMouseClick = false;
      return;
    }
    suppressPrimaryMouseClick = false;
    if (e.detail > 1) return;
    openBook("single");
  });
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    closeShelfCardFloaters();
    if (!singleClickOpensBook) {
      if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
      // 若用户的双击间隔较长，延迟选择可能已执行；还原到双击前状态，
      // 确保最终结果仍是“直接打开、不改变选中”。
      restoreDeferredSelection();
      openBook("double");
      return;
    }
    // 单击打开模式已在第一次 click 立即打开，dblclick 不再改变选择。
  });
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeShelfCardFloaters();
  });

  return card;
}

// 更换封面：挑一张图片 → 后端缩略并替换
async function changeCover(b: ShelfBookRecord) {
  const sel = await dialogPort.open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  try {
    if (!path) return;
    render(await tauriApi.invoke("set_cover", { id: b.id, path }));
  } catch (e) {
    alertAction("更换封面失败：" + e);
  }
}

// 文件丢失 → 让用户重新定位到文件新位置（指纹一致则各项数据都保留）
async function relocateBook(b: ShelfBookRecord) {
  if (!confirmAction("《" + b.title + "》的源文件找不到了。\n是否重新定位到它现在的位置？")) return;
  const ext = (b.format || "").toLowerCase();
  const sel = await dialogPort.open({
    multiple: false,
    filters: [{ name: "电子书", extensions: ext ? [ext] : ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  if (!path) return;
  render(await tauriApi.invoke("relocate_book", { id: b.id, path }));
}

function hasActiveShelfFilters() {
  return shelfRules.hasActiveShelfFilters({ collectionFilter, minRating, organizationMatchMode, readingFilter, searchQuery, tagFilter });
}
function updateShelfFilterStatus(visibleCount: number) {
  const active = hasActiveShelfFilters();
  filterButton.classList.toggle("filters-active", active);
  filterButton.title = active ? shelfText("activeFilters", "Filters active") : shelfText("sortAndLayout", "Sort & layout");
  if (readingFilterAllButton) readingFilterAllButton.hidden = !active;
  if (filterResultSummary) {
    filterResultSummary.textContent = visibleCount + "/" + books.length;
  }
}

function renderOrganizationMatchMode() {
  if (!organizationMatchModeButton) return;
  const matchAll = organizationMatchMode === "all";
  organizationMatchModeButton.textContent = matchAll ? shelfText("matchAll", "Match all") : shelfText("matchAny", "Match any");
  organizationMatchModeButton.title = matchAll
    ? shelfText("matchAllHint", "Tags and collections must all match; click to match any")
    : shelfText("matchAnyHint", "Any tag or collection may match; click to match all");
  organizationMatchModeButton.setAttribute("aria-pressed", matchAll ? "true" : "false");
}
organizationMatchModeButton?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  organizationMatchMode = organizationMatchMode === "all" ? "any" : "all";
  localStorage.setItem("shelfOrganizationMatchMode", organizationMatchMode);
  renderOrganizationMatchMode();
  applyView();
});
renderOrganizationMatchMode();

// 当前真正显示在书架上的书。搜索永远搜索整座书架，避免被评分/阅读过滤误挡住。
function matchesOrganizationFilters(book: ShelfBook) {
  return shelfRules.matchesOrganizationSelection(book, tagFilter, collectionFilter, organizationMatchMode);
}
function currentList() {
  const list = shelfRules.currentList(books, {
    collectionFilter,
    minRating,
    organizationMatchMode,
    readingFilter,
    searchQuery,
    tagFilter,
  }) as ShelfBookRecord[];
  // currentList 已经应用同一规则；保留命名入口以冻结旧页面的调试契约。
  return list.every(matchesOrganizationFilters) ? list : list.filter(matchesOrganizationFilters);
}

function organizationEntries(field: OrganizationField): OrganizationEntry[] {
  const entries = new Map<string, OrganizationEntry>();
  books.forEach((book) => (book[field] || []).forEach((rawName: string) => {
    const name = organizationName(rawName);
    const key = organizationKey(name);
    if (!key) return;
    const entry = entries.get(key) || { name, key, count: 0 };
    entry.count += 1;
    entries.set(key, entry);
  }));
  return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}
function pruneOrganizationFilter(field: OrganizationField, values: Set<string>, storageKey: string) {
  const known = new Set(organizationEntries(field).map((entry) => entry.key));
  let changed = false;
  Array.from(values).forEach((key) => {
    if (!known.has(key)) { values.delete(key); changed = true; }
  });
  if (changed) saveOrganizationFilter(storageKey, values);
}
function renderOrganizationFilterList(element: HTMLElement | null, field: OrganizationField, selectedKeys: Set<string>, emptyText: string) {
  if (!element) return;
  element.replaceChildren();
  const entries = organizationEntries(field);
  if (!entries.length) {
    const empty = rootDoc.createElement("div");
    empty.className = "fp-choice-empty";
    empty.textContent = emptyText;
    element.appendChild(empty);
    return;
  }
  const button = rootDoc.createElement("button");
  button.type = "button";
  button.className = "fp-choice-open";
  const label = rootDoc.createElement("span");
  label.textContent = field === "tags" ? "选择标签" : "选择收藏夹";
  const summary = rootDoc.createElement("small");
  summary.textContent = selectedKeys.size ? "已选 " + selectedKeys.size + " 项" : "全部";
  button.append(label, summary);
  button.addEventListener("click", (event) => openOrganizationFilter(field, event.currentTarget as HTMLElement));
  element.appendChild(button);
  if (selectedKeys.size) {
    const clear = rootDoc.createElement("button");
    clear.type = "button";
    clear.className = "fp-choice-clear";
    clear.textContent = "×";
    clear.title = field === "tags" ? "清除标签选择" : "清除收藏夹选择";
    clear.setAttribute("aria-label", clear.title);
    clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedKeys.clear();
      saveOrganizationFilter(field === "tags" ? "shelfTagFilter" : "shelfCollectionFilter", selectedKeys);
      renderOrganizationFilters();
      applyView();
    });
    element.appendChild(clear);
  }
}
function renderOrganizationFilters() {
  pruneOrganizationFilter("tags", tagFilter, "shelfTagFilter");
  pruneOrganizationFilter("collections", collectionFilter, "shelfCollectionFilter");
  renderOrganizationFilterList(tagFilterList, "tags", tagFilter, "暂无标签");
  renderOrganizationFilterList(collectionFilterList, "collections", collectionFilter, "暂无收藏夹");
}

function organizationFilterConfig(field: OrganizationField) {
  return field === "tags"
    ? { field, title: "标签", selected: tagFilter, storageKey: "shelfTagFilter", empty: "暂无标签" }
    : { field, title: "收藏夹", selected: collectionFilter, storageKey: "shelfCollectionFilter", empty: "暂无收藏夹" };
}
function renderOrganizationFilterOptions() {
  if (!organizationFilterOptions || !organizationFilterDraft) return;
  const draft = organizationFilterDraft;
  const config = organizationFilterConfig(draft.field);
  organizationFilterOptions.replaceChildren();
  const entries = organizationEntries(config.field);
  if (!entries.length) {
    const empty = rootDoc.createElement("div");
    empty.className = "organization-filter-empty";
    empty.textContent = config.empty;
    organizationFilterOptions.appendChild(empty);
    return;
  }
  entries.forEach((entry) => {
    const row = rootDoc.createElement("div");
    row.className = "organization-filter-option-row";
    const label = rootDoc.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = rootDoc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = draft.keys.has(entry.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) draft.keys.add(entry.key);
      else draft.keys.delete(entry.key);
    });
    const name = rootDoc.createElement("span");
    name.textContent = entry.name;
    label.append(checkbox, name);
    row.appendChild(label);
    if (config.field === "collections") {
      const open = rootDoc.createElement("button");
      open.type = "button";
      open.className = "booklist-open-link";
      open.textContent = "打开书单";
      open.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeOrganizationFilter();
        openBooklist(entry.name);
      });
      row.appendChild(open);
    }
    organizationFilterOptions.appendChild(row);
  });
}
function closeOrganizationFilter() {
  const returnToPanel = organizationFilterReturnToPanel;
  organizationFilterDraft = null;
  organizationFilterReturnToPanel = false;
  organizationFilterModal?.classList?.remove("show");
  // 确认/取消按钮的点击还会继续冒泡到 document；下一帧恢复可避免刚打开又被全局点击处理器关闭。
  if (returnToPanel) {
    requestFrame(() => {
      if (!organizationFilterModal?.classList?.contains("show")) {
        filterPanelElement.classList.add("show");
      }
    });
  }
}
function positionOrganizationFilter(anchor: HTMLElement | null) {
  if (!anchor?.getBoundingClientRect || !organizationFilterModal) return;
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = global.innerWidth || 1280;
  const viewportHeight = global.innerHeight || 800;
  const width = Math.min(430, viewportWidth - 32);
  const height = 320;
  const left = Math.max(8, Math.min(rect.left, viewportWidth - width - 8));
  const top = Math.max(8, Math.min(rect.top, viewportHeight - height - 8));
  organizationFilterModal.style.setProperty("--organization-filter-left", left + "px");
  organizationFilterModal.style.setProperty("--organization-filter-top", top + "px");
}
function openOrganizationFilter(field: OrganizationField, anchor: HTMLElement | null) {
  if (!organizationFilterModal || !organizationFilterOptions) return;
  const config = organizationFilterConfig(field);
  organizationFilterDraft = { field, keys: new Set(config.selected) };
  organizationFilterReturnToPanel = filterPanelElement.classList.contains("show");
  if (organizationFilterTitle) organizationFilterTitle.textContent = shelfText("selectItems", "Select {title}").replace("{title}", config.title);
  if (organizationFilterNote) organizationFilterNote.textContent = shelfText("multiSelectNoFilter", "You may select multiple items; select none to disable filtering.");
  renderOrganizationFilterOptions();
  // 必须在隐藏漏斗面板前取坐标；隐藏后的按钮 rect 会退化为 (0,0)，导致弹窗跑到左上角。
  positionOrganizationFilter(anchor);
  filterPanelElement.classList.remove("show");
  organizationFilterModal.classList.add("show");
}
organizationFilterClose?.addEventListener("click", closeOrganizationFilter);
organizationFilterCancel?.addEventListener("click", closeOrganizationFilter);
organizationFilterClear?.addEventListener("click", () => {
  if (!organizationFilterDraft) return;
  organizationFilterDraft.keys.clear();
  renderOrganizationFilterOptions();
});
organizationFilterApply?.addEventListener("click", () => {
  if (!organizationFilterDraft) return;
  const config = organizationFilterConfig(organizationFilterDraft.field);
  if (config.field === "tags") tagFilter = new Set(organizationFilterDraft.keys);
  else collectionFilter = new Set(organizationFilterDraft.keys);
  saveOrganizationFilter(config.storageKey, config.field === "tags" ? tagFilter : collectionFilter);
  closeOrganizationFilter();
  renderOrganizationFilters();
  applyView();
});
organizationFilterModal?.addEventListener("click", (event) => {
  if (event.target === organizationFilterModal) closeOrganizationFilter();
});

// 多选图书时只做“加入”，绝不覆盖或移除各书已有的标签/书单，避免一次误操作清空整理结果。
let batchOrganizationDraft: BatchOrganizationDraft | null = null;
function closeBatchOrganization() {
  batchOrganizationDraft = null;
  batchOrganizationModal?.classList?.remove("show");
}
function batchOrganizationConfig(field: OrganizationField) {
  return field === "tags"
    ? { field, title: "标签", action: "添加标签", placeholder: "新建标签" }
    : { field, title: "收藏书单", action: "加入收藏书单", placeholder: "新建收藏书单" };
}
function renderBatchOrganizationOptions() {
  if (!batchOrganizationOptions || !batchOrganizationDraft) return;
  const draft = batchOrganizationDraft;
  const config = batchOrganizationConfig(draft.field);
  batchOrganizationOptions.replaceChildren();
  const entries = organizationEntries(config.field);
  if (!entries.length) {
    const empty = rootDoc.createElement("div");
    empty.className = "organization-filter-empty";
    empty.textContent = "还没有" + config.title + "，可在下方新建。";
    batchOrganizationOptions.appendChild(empty);
  }
  entries.forEach((entry) => {
    const label = rootDoc.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = rootDoc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = draft.names.has(entry.key);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) draft.names.set(entry.key, entry.name);
      else draft.names.delete(entry.key);
    });
    const name = rootDoc.createElement("span");
    name.textContent = entry.name;
    label.append(checkbox, name);
    batchOrganizationOptions.appendChild(label);
  });
  // 新建但尚未用于其它图书的名称也要在当前草稿中可见。
  Array.from(draft.names.entries()).forEach(([key, name]) => {
    if (entries.some((entry) => entry.key === key)) return;
    const label = rootDoc.createElement("label");
    label.className = "organization-filter-option";
    const checkbox = rootDoc.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = true;
    checkbox.addEventListener("change", () => {
      if (!checkbox.checked) draft.names.delete(key);
    });
    const text = rootDoc.createElement("span");
    text.textContent = name;
    label.append(checkbox, text);
    batchOrganizationOptions.appendChild(label);
  });
}
function openBatchOrganization(field: OrganizationField) {
  if (!selected.size || !batchOrganizationModal || !batchOrganizationTitle || !batchOrganizationNote || !batchOrganizationNew) return;
  const config = batchOrganizationConfig(field);
  batchOrganizationDraft = { field, names: new Map() };
  batchOrganizationTitle.textContent = "为已选 " + selected.size + " 本图书" + config.action;
  batchOrganizationNote.textContent = "可多选；确认后会加入全部已选图书，不会移除它们原有的标签或书单。";
  batchOrganizationNew.value = "";
  batchOrganizationNew.placeholder = config.placeholder;
  renderBatchOrganizationOptions();
  batchOrganizationModal.classList.add("show");
}
function addBatchOrganizationName() {
  if (!batchOrganizationDraft || !batchOrganizationNew) return;
  const name = organizationName(batchOrganizationNew?.value);
  if (!name) return;
  batchOrganizationDraft.names.set(organizationKey(name), name);
  batchOrganizationNew.value = "";
  renderBatchOrganizationOptions();
}
function organizationAlreadyAssigned(book: ShelfBookRecord | null, field: OrganizationField, names: readonly string[]) {
  if (!book || !Array.isArray(names) || !names.length) return false;
  const wanted = new Set(names.map(organizationKey).filter(Boolean));
  return (book[field] || []).some((value) => wanted.has(organizationKey(value)));
}
function alreadyAssignedMessages(ids: readonly (string | number)[], field: OrganizationField, names: readonly string[]) {
  const kind = field === "tags" ? "标签" : "收藏";
  return ids
    .map((id) => getBook(id))
    .filter((book): book is ShelfBookRecord => organizationAlreadyAssigned(book, field, names))
    .map((book) => "《" + (book.title || "未命名图书") + "》已加入" + kind);
}
async function applyBatchOrganization() {
  if (!batchOrganizationDraft || !selected.size) return;
  const names = Array.from(batchOrganizationDraft.names.values());
  if (!names.length) {
    alertAction("请至少选择或新建一个" + batchOrganizationConfig(batchOrganizationDraft.field).title + "。");
    return;
  }
  const ids = Array.from(selected);
  const organizationField = batchOrganizationDraft.field;
  const field = organizationField === "tags" ? "tag" : "collection";
  // 写入前保存重复成员关系。后端依然会做去重，前端仅负责把用户关心的状态说明出来。
  const existingMessages = alreadyAssignedMessages(ids, organizationField, names);
  try {
    const list = await tauriApi.invoke("add_books_organization", { ids, field, names });
    closeBatchOrganization();
    render(list);
    if (existingMessages.length) alertAction(existingMessages.join("\n"));
  } catch (error) {
    alertAction("批量加入失败：" + error);
  }
}
batchTagButton?.addEventListener("click", () => openBatchOrganization("tags"));
batchCollectionButton?.addEventListener("click", () => openBatchOrganization("collections"));
batchOrganizationClose?.addEventListener("click", closeBatchOrganization);
batchOrganizationCancel?.addEventListener("click", closeBatchOrganization);
batchOrganizationAdd?.addEventListener("click", addBatchOrganizationName);
batchOrganizationNew?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addBatchOrganizationName(); }
});
batchOrganizationApply?.addEventListener("click", applyBatchOrganization);
batchOrganizationModal?.addEventListener("click", (event) => {
  if (event.target === batchOrganizationModal) closeBatchOrganization();
});

function booklistBook(id: string | number | undefined) {
  return books.find((book) => String(book.id) === String(id));
}
function setBooklistCover(list: BooklistRecord) {
  if (!booklistCover) return;
  booklistCover.replaceChildren();
  const coverBook = booklistBook(list.cover_book_id) || booklistBook(list.book_ids?.[0]);
  if (coverBook?.cover) {
    const image = rootDoc.createElement("img");
    image.src = coverBook.cover;
    image.alt = list.name;
    booklistCover.appendChild(image);
  } else {
    booklistCover.textContent = list.name || "书单";
  }
}
async function saveActiveBooklist() {
  if (!activeBooklist) return;
  const currentName = activeBooklist.name;
  const lists = await tauriApi.invoke("update_booklist", {
    name: activeBooklist.name,
    description: booklistDescription?.value || "",
    coverBookId: String(activeBooklist.cover_book_id || ""),
    bookIds: activeBooklist.book_ids || [],
    reviews: activeBooklist.reviews || {},
  });
  activeBooklist = (lists || []).find((list) => organizationKey(list.name) === organizationKey(currentName)) || activeBooklist;
}
let booklistDragState: BooklistDragState | null = null;
function animateBooklistInsert(beforeNode: HTMLElement | null) {
  const state = booklistDragState;
  if (!state) return;
  const placeholder = state.placeholder;
  if ((beforeNode && beforeNode === placeholder) || placeholder.nextSibling === beforeNode) return;
  if (!beforeNode && placeholder === booklistBooks.lastElementChild) return;
  if (!global.ReaderAnimationSettings?.enabled?.("booklistSort")) {
    booklistBooks.insertBefore(placeholder, beforeNode || null);
    return;
  }
  const before = new Map<HTMLElement, number>();
  Array.from(booklistBooks.children).forEach((row) => {
    if (!(row instanceof HTMLElement)) return;
    if (row !== state.row) before.set(row, row.getBoundingClientRect().top);
  });
  booklistBooks.insertBefore(placeholder, beforeNode || null);
  Array.from(booklistBooks.children).forEach((row) => {
    if (!(row instanceof HTMLElement)) return;
    if (row === state.row) return;
    const first = before.get(row);
    if (first === undefined) return;
    const delta = first - row.getBoundingClientRect().top;
    if (!delta) return;
    row.style.transition = "none";
    row.style.transform = "translateY(" + delta + "px)";
    row.getBoundingClientRect();
    requestFrame(() => {
      row.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1), background .16s ease, border-color .16s ease, box-shadow .16s ease";
      row.style.transform = "";
    });
  });
}
function moveBooklistDrag(clientY: number) {
  const state = booklistDragState;
  if (!state) return;
  const bounds = booklistBooks.getBoundingClientRect();
  const maxTop = Math.max(bounds.top, bounds.bottom - state.row.offsetHeight);
  const top = Math.max(bounds.top, Math.min(maxTop, clientY - state.offsetY));
  const probeY = Math.max(bounds.top, Math.min(bounds.bottom, clientY));
  state.row.style.top = top + "px";
  const rows = Array.from(booklistBooks.querySelectorAll<HTMLElement>(".booklist-row")).filter((row) => row !== state.row);
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (probeY < box.top + box.height / 2) {
      animateBooklistInsert(row);
      return;
    }
  }
  animateBooklistInsert(null);
}
function attachBooklistDrag(row: HTMLElement, grip: HTMLButtonElement) {
  grip.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const box = row.getBoundingClientRect();
    const placeholder = rootDoc.createElement("div");
    placeholder.className = "booklist-placeholder";
    booklistBooks.insertBefore(placeholder, row.nextSibling);
    row.classList.add("dragging");
    row.style.position = "fixed";
    row.style.left = box.left + "px";
    row.style.top = box.top + "px";
    row.style.width = box.width + "px";
    row.style.height = box.height + "px";
    booklistDragState = { row, placeholder, offsetY: event.clientY - box.top };
    try { grip.setPointerCapture(event.pointerId); } catch {}
  });
  grip.addEventListener("pointermove", (event) => {
    if (!booklistDragState) return;
    event.preventDefault();
    event.stopPropagation();
    moveBooklistDrag(event.clientY);
  });
  const finish = async (event: PointerEvent) => {
    const state = booklistDragState;
    if (!state || state.row !== row) return;
    event?.preventDefault();
    event?.stopPropagation();
    try { grip.releasePointerCapture(event.pointerId); } catch {}
    booklistDragState = null;
    booklistBooks.insertBefore(state.row, state.placeholder);
    state.placeholder.remove();
    state.row.classList.remove("dragging");
    state.row.style.position = "";
    state.row.style.left = "";
    state.row.style.top = "";
    state.row.style.width = "";
    state.row.style.height = "";
    const current = activeBooklist;
    if (!current) return;
    current.book_ids = Array.from(booklistBooks.querySelectorAll<HTMLElement>(".booklist-row")).map((item) => item.dataset.bookId || "");
    try {
      await saveActiveBooklist();
      renderBooklist(current);
    } catch (error) {
      alertAction("保存书单顺序失败：" + error);
      void openBooklist(current.name);
    }
  };
  grip.addEventListener("pointerup", finish);
  grip.addEventListener("pointercancel", finish);
}
function renderBooklist(list: BooklistRecord) {
  if (!booklistTitle) return;
  activeBooklist = list;
  activeBooklist.reviews = activeBooklist.reviews && typeof activeBooklist.reviews === "object" ? activeBooklist.reviews : {};
  booklistTitle.textContent = "书单 · " + list.name;
  booklistDescription.value = list.description || "";
  setBooklistCover(list);
  booklistBooks.replaceChildren();
  const ids = Array.isArray(list.book_ids) ? list.book_ids : [];
  if (!ids.length) {
    const empty = rootDoc.createElement("div");
    empty.className = "similar-empty";
    empty.textContent = "这份书单暂时没有图书。";
    booklistBooks.appendChild(empty);
    return;
  }
  ids.forEach((id, index) => {
    const book = booklistBook(id);
    if (!book) return;
    const row = rootDoc.createElement("div");
    row.className = "booklist-row";
    row.dataset.bookId = String(book.id);
    const rank = rootDoc.createElement("div");
    rank.className = "booklist-rank";
    rank.textContent = String(index + 1);
    const thumb = rootDoc.createElement("div");
    thumb.className = "booklist-thumb";
    if (book.cover) {
      const image = rootDoc.createElement("img");
      image.src = book.cover;
      image.alt = book.title || "";
      thumb.appendChild(image);
    } else {
      thumb.textContent = book.title || "未命名";
    }
    const info = rootDoc.createElement("div");
    const title = rootDoc.createElement("div");
    title.className = "booklist-book-title";
    title.textContent = book.title || "未命名";
    const meta = rootDoc.createElement("div");
    meta.className = "booklist-book-meta";
    meta.textContent = book.author || "未知作者";
    const review = rootDoc.createElement("textarea");
    review.className = "booklist-book-review";
    review.maxLength = 1000;
    review.placeholder = "写下这本书为什么适合这份书单…";
    review.value = list.reviews?.[String(book.id)] || "";
    review.addEventListener("pointerdown", (event) => event.stopPropagation());
    review.addEventListener("blur", () => {
      if (!activeBooklist) return;
      activeBooklist.reviews = activeBooklist.reviews || {};
      const value = review.value.trim();
      if (value) activeBooklist.reviews[String(book.id)] = value;
      else delete activeBooklist.reviews[String(book.id)];
      saveActiveBooklist().catch((error) => alertAction("保存书单评语失败：" + error));
    });
    info.append(title, meta, review);
    info.addEventListener("dblclick", () => tauriApi.invoke("open_book", { id: String(book.id) }).catch((error) => alertAction("打开失败：" + error)));
    const actions = rootDoc.createElement("div");
    actions.className = "booklist-row-actions";
    const current = activeBooklist;
    if (!current) return;
    const cover = menuButton(String(current.cover_book_id) === String(book.id) ? "当前封面" : "设为封面");
    cover.disabled = String(current.cover_book_id) === String(book.id);
    cover.addEventListener("click", async () => {
      current.cover_book_id = String(book.id);
      await saveActiveBooklist();
      renderBooklist(current);
    });
    const grip = menuButton("", "booklist-grip");
    grip.title = "拖动排序";
    grip.setAttribute("aria-label", "拖动排序");
    attachBooklistDrag(row, grip);
    actions.append(cover, grip);
    row.append(rank, thumb, info, actions);
    booklistBooks.appendChild(row);
  });
}
async function openBooklist(name: unknown): Promise<void> {
  if (!booklistModal || !booklistTitle) return;
  booklistModal.classList.add("show");
  booklistTitle.textContent = "书单 · " + name;
  booklistBooks.innerHTML = '<div class="similar-empty">正在读取书单…</div>';
  try {
    const lists = await tauriApi.invoke("list_booklists");
    const list = (lists || []).find((item) => organizationKey(item.name) === organizationKey(name));
    if (!list) throw new Error("找不到这个书单");
    renderBooklist(list);
  } catch (error) {
    booklistBooks.innerHTML = "";
    const empty = rootDoc.createElement("div");
    empty.className = "similar-empty";
    empty.textContent = "读取失败：" + error;
    booklistBooks.appendChild(empty);
  }
}
booklistDescription?.addEventListener("blur", () => {
  if (!activeBooklist) return;
  activeBooklist.description = booklistDescription.value;
  saveActiveBooklist().catch((error) => alertAction("保存书单简介失败：" + error));
});
booklistClose?.addEventListener("click", () => booklistModal?.classList.remove("show"));
booklistModal?.addEventListener("click", (event) => {
  if (event.target === booklistModal) booklistModal.classList.remove("show");
});
function menuButton(text: string, className = "org-action") {
  const button = rootDoc.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  return button;
}
const selectionGroup = required("del-group");
const selectionDeleteButton = required("del-btn");
const bookInfoButton = required("book-info-btn");
function updateSelectionUi() {
  if (selected.size > 0) {
    selectionGroup.classList.add("show");
    bookInfoButton.style.display = selected.size === 1 ? "" : "none";
    selectionDeleteButton.textContent = "🗑 删除选中 (" + selected.size + ")";
  } else {
    selectionGroup.classList.remove("show");
  }
}
function toggleSelect(id: string | number, card: HTMLElement) {
  if (selected.has(id)) {
    selected.delete(id);
    card.classList.remove("selected");
  } else {
    selected.add(id);
    card.classList.add("selected");
  }
  updateSelectionUi();
}
function clearSelection() {
  selected = new Set();
  applyView();
  updateSelectionUi();
}
function selectAll() {
  // 菜单入口承诺的是“全选”，应覆盖完整书库；搜索和筛选只影响展示，
  // 不能让批量删除悄悄漏掉当前未显示的图书。
  closeShelfSearch(true);
  selected = new Set(books.map((book) => book.id));
  applyView();
  updateSelectionUi();
}
selectionDeleteButton.addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirmAction("确定删除选中的 " + selected.size + " 本书？（不会删除磁盘上的文件）")) return;
  const ids = Array.from(selected);
  const list = await tauriApi.invoke("remove_books", { ids });
  selected = new Set();
  updateSelectionUi();
  render(list);
});
required("del-cancel").addEventListener("click", clearSelection);
required("mi-selectall").addEventListener("click", () => {
  menuElement.classList.remove("show");
  selectAll();
});
required("mi-random").addEventListener("click", () => {
  menuElement.classList.remove("show");
  if (!books.length) {
    alertAction("书架还是空的", { variant: "text", duration: 1500 });
    return;
  }
  const book = books[Math.floor(Math.random() * books.length)];
  if (!book) return;
  clearCrossReturn();
  void tauriApi.invoke("open_book", { id: book.id });
});

let shelfScrollUpdateRaf = 0;
let shelfRendering = false;
function updateShelfScrollbar() {
  shelfScrollUpdateRaf = 0;
  if (shelfRendering) return;
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  const viewport = contentEl.clientHeight;
  const total = contentEl.scrollHeight;
  const trackHeight = shelfScrollbar.clientHeight;
  const geometry = shelfRules.scrollbarGeometry
    ? shelfRules.scrollbarGeometry({ scrollTop: contentEl.scrollTop, total, trackHeight, viewport })
    : (() => {
      const maxScroll = Math.max(0, total - viewport);
      if (viewport <= 0 || maxScroll <= 1) return { visible: false };
      const thumbHeight = Math.max(28, Math.round((viewport / total) * trackHeight));
      const maxTop = Math.max(0, trackHeight - thumbHeight);
      return {
        maxScroll,
        maxTop,
        thumbHeight,
        top: maxScroll ? Math.round((contentEl.scrollTop / maxScroll) * maxTop) : 0,
        visible: true,
      };
    })();
  if (!geometry.visible) {
    shelfScrollbar.classList.remove("show");
    return;
  }
  shelfScrollbar.classList.add("show");
  shelfScrollbarThumb.style.height = geometry.thumbHeight + "px";
  shelfScrollbarThumb.style.transform = "translateY(" + geometry.top + "px)";
}
function scheduleShelfScrollbarUpdate() {
  if (shelfScrollUpdateRaf) return;
  shelfScrollUpdateRaf = requestFrame(updateShelfScrollbar);
}
function initShelfScrollbar() {
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  contentEl.addEventListener("scroll", scheduleShelfScrollbarUpdate, { passive: true });
  global.addEventListener("resize", scheduleShelfScrollbarUpdate);

  shelfScrollbar.addEventListener("pointerdown", (e) => {
    if (!shelfScrollbar.classList.contains("show")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = shelfScrollbar.getBoundingClientRect();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    if (e.target !== shelfScrollbarThumb) {
      contentEl.scrollTop = shelfRules.scrollbarTrackScrollTop
        ? shelfRules.scrollbarTrackScrollTop({
          clientY: e.clientY,
          rectTop: rect.top,
          thumbHeight,
          total: contentEl.scrollHeight,
          trackHeight,
          viewport: contentEl.clientHeight,
        })
        : (() => {
          const maxTop = Math.max(1, trackHeight - thumbHeight);
          const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
          const targetTop = Math.min(maxTop, Math.max(0, e.clientY - rect.top - thumbHeight / 2));
          return (targetTop / maxTop) * maxScroll;
        })();
    }
    dragging = true;
    dragStartY = e.clientY;
    dragStartScrollTop = contentEl.scrollTop;
    shelfScrollbar.classList.add("dragging");
    shelfScrollbar.setPointerCapture(e.pointerId);
  });
  shelfScrollbar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    contentEl.scrollTop = shelfRules.scrollbarDragScrollTop
      ? shelfRules.scrollbarDragScrollTop({
        clientY: e.clientY,
        dragStartScrollTop,
        dragStartY,
        thumbHeight,
        total: contentEl.scrollHeight,
        trackHeight,
        viewport: contentEl.clientHeight,
      })
      : (() => {
        const maxTop = Math.max(1, trackHeight - thumbHeight);
        const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
        return dragStartScrollTop + ((e.clientY - dragStartY) / maxTop) * maxScroll;
      })();
  });
  const stopDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    shelfScrollbar.classList.remove("dragging");
    try { shelfScrollbar.releasePointerCapture(e.pointerId); } catch {}
    scheduleShelfScrollbarUpdate();
  };
  shelfScrollbar.addEventListener("pointerup", stopDrag);
  shelfScrollbar.addEventListener("pointercancel", stopDrag);
  scheduleShelfScrollbarUpdate();
}
initShelfScrollbar();

let viewRenderToken = 0;
function applyView(options: Readonly<{ preserveScroll?: boolean }> = {}) {
  const token = ++viewRenderToken;
  const preserveScroll = options.preserveScroll !== false && shelfLoaded;
  const savedScrollTop = preserveScroll && contentEl ? contentEl.scrollTop : 0;
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.classList.toggle("show-titles", showCoverTitle); // 网格视图是否显示书名
  applyShelfGridColumns();
  firstScreenCoverCount = coverLoadingRules
    ? coverLoadingRules.firstScreenCoverCount({
      gridColumns: shelfGridColumns,
      height: Number(contentEl?.clientHeight || 0),
      layout,
      width: Number(contentEl?.clientWidth || 0),
    })
    : Math.max(DEFAULT_FIRST_SCREEN_COVER_COUNT, estimateFirstScreenCoverCount());
  shelfRendering = true;
  const list = currentList();
  updateShelfFilterStatus(list.length);
  if (!shelfLoaded) {
    emptyEl.style.display = "none";
  } else if (list.length) {
    emptyEl.style.display = "none";
  } else {
    emptyEl.textContent = searchQuery
      ? "没有匹配的书籍"
      : hasActiveShelfFilters()
        ? "没有符合当前筛选条件的书籍。"
        : "书架还是空的。点右上角「⋮」→「导入书籍」添加（可一次选多本）。";
    emptyEl.style.display = "block";
  }
  const sorted = shelfRules.sortBooks(list, { bookFileSizes, sortKey }) as ShelfBookRecord[];
  const finishCoverRender = startShelfPerformance("cover-render", "critical books=" + sorted.length + " layout=" + layout) || (() => {});
  let chunks = 0;
  function restoreShelfScroll() {
    if (!preserveScroll || !contentEl) return;
    const maxScroll = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
    contentEl.scrollTop = Math.min(savedScrollTop, maxScroll);
  }
  function finishRender() {
    restoreShelfScroll();
    shelfRendering = false;
    finishCoverRender("chunks=" + chunks);
    scheduleShelfScrollbarUpdate();
  }
  if (!sorted.length) {
    shelfEl.replaceChildren();
    finishRender();
    return;
  }

  const existingCards = new Map<string, HTMLElement>();
  Array.from(shelfEl.children).forEach((node) => {
    if (node instanceof HTMLElement && node.classList.contains("book") && node.dataset.id) existingCards.set(node.dataset.id, node);
  });
  let changedCards = 0;
  for (const b of sorted) {
    const card = existingCards.get(String(b.id));
    if (!card || card.dataset.renderKey !== shelfRules.bookRenderKey(b, { showCoverProgress, showCoverRating })) changedCards += 1;
  }
  const shouldReuse = existingCards.size > 0 && changedCards <= Math.max(24, sorted.length * 0.35);
  if (shouldReuse) {
    const frag = rootDoc.createDocumentFragment();
    sorted.forEach((b, index) => {
      const key = shelfRules.bookRenderKey(b, { showCoverProgress, showCoverRating });
      let card = existingCards.get(String(b.id));
      if (!card || card.dataset.renderKey !== key) {
        card = bookCard(b, index);
      } else {
        card.classList.toggle("selected", selected.has(b.id));
      }
      frag.appendChild(card);
    });
    shelfEl.replaceChildren(frag);
    chunks = 1;
    finishRender();
    return;
  }

  let i = 0;
  function makeChunk() {
    const frag = rootDoc.createDocumentFragment();
    const end = Math.min(i + 28, sorted.length);
    for (; i < end; i++) {
      const book = sorted[i] as ShelfBookRecord | undefined;
      if (book) frag.appendChild(bookCard(book, i));
    }
    chunks += 1;
    return frag;
  }
  shelfEl.replaceChildren(makeChunk());
  restoreShelfScroll();
  function appendChunk() {
    if (token !== viewRenderToken) {
      shelfRendering = false;
      return;
    }
    shelfEl.appendChild(makeChunk());
    restoreShelfScroll();
    if (i < sorted.length) setTimeout(appendChunk, 0);
    else finishRender();
  }
  if (i < sorted.length) setTimeout(appendChunk, 0);
  else finishRender();
}
let lastJSON = ""; // 上次渲染的数据快照，数据没变就不重渲染（避免封面重载闪烁）
function render(list: ShelfBookRecord[]) {
  shelfLoaded = true;
  books = list;
  renderOrganizationFilters();
  if (books.length && minRating > 0 && !books.some((b) => (b.rating || 0) >= minRating)) {
    minRating = 0;
    localStorage.removeItem("minRating");
    filterStarsEl?.setVal?.(0);
  }
  const j = JSON.stringify(list);
  if (j === lastJSON) return;
  lastJSON = j;
  applyView();
}

function getBook(id: string | number) {
  return books.find((book) => String(book.id) === String(id)) || null;
}
function updateBook(id: string | number, patch: Partial<ShelfBookRecord>) {
  const index = books.findIndex((book) => String(book.id) === String(id));
  if (index >= 0) books[index] = Object.assign({}, books[index], patch);
  lastJSON = JSON.stringify(books);
  applyView();
  updateSelectionUi();
}
function setSearchQuery(value: unknown) {
  const next = String(value || "").trim().toLowerCase();
  if (next === searchQuery) return;
  searchQuery = next;
  applyView();
}
function focusShelf() {
  if (!contentEl || typeof contentEl.focus !== "function") return;
  contentEl.focus({ preventScroll: true });
}
async function changeCoverById(id: string | number) {
  const book = getBook(id);
  if (book) await changeCover(book);
}

let lastFocusRefreshAt = 0;
global.addEventListener("focus", () => {
  if (!shelfLoaded) return;
  const now = Date.now();
  if (now - lastFocusRefreshAt < 1500) return;
  lastFocusRefreshAt = now;
  tauriApi.invoke("list_books").then(render).catch(() => {});
});
global.addEventListener("app-language-changed", () => {
  updateShelfFilterStatus(currentList().length);
  renderOrganizationMatchMode();
});

  const nextController: ShelfUiController = Object.freeze({
    applyView,
    changeCoverById,
    clearSelection,
    count: () => books.length,
    coverColor: shelfRules.colorFor,
    getBook,
    getBooks: () => books.slice(),
    getSearchQuery: () => searchQuery,
    getSelectedIds: () => Array.from(selected),
    getVisibleBooks: () => currentList().slice(),
    focusShelf,
    makeStars,
    openBooklist,
    render,
    selectAll,
    setSearchQuery,
    updateBook,
  });
  activeController = nextController;
  return nextController;
}

function controller(): ShelfUiController {
  if (!activeController) throw new Error("ReaderShelfUI 尚未初始化");
  return activeController;
}

const shelfUi: ShelfUiGlobal = Object.freeze({
  clearSelection: () => controller().clearSelection(),
  getSearchQuery: () => controller().getSearchQuery(),
  getSelectedIds: () => controller().getSelectedIds(),
  init,
  focusShelf: () => controller().focusShelf(),
  openBooklist: (name: unknown) => controller().openBooklist(name),
  refresh: () => controller().applyView(),
  render: (list: ShelfBookRecord[]) => controller().render(list),
  setSearchQuery: (value: unknown) => controller().setSearchQuery(value),
});
global.ReaderShelfUI = shelfUi;
return shelfUi;
}
