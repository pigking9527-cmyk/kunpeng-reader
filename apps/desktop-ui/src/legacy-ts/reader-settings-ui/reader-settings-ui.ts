import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
  type TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.js";

type ReaderSettingValue =
  string | number | boolean | string[] | ReaderClickZone[];
interface ReaderSettingsState extends Record<string, ReaderSettingValue> {
  theme: string;
  fontFamily: string;
  styleMode: string;
  textConversion: string;
  fontSize: number;
  noteFontSize: number;
  lineHeight: number;
  paraSpacing: number;
  letterSpacing: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  dualPageGap: number;
  pageMode: string;
  flowMode: string;
  pageTurnEffect: string;
  pageTurnSpeed: number;
  ttsSource: string;
  ttsRate: number;
  backgroundPreset: string;
  customBackgroundColor: string;
  customBackgroundImage: string;
  customPaletteId: string;
  textColor: string;
  linkColor: string;
  selectionColor: string;
  footnoteBackground: string;
  footnoteBorder: string;
  imagePagination: string;
  showTextConversion: boolean;
  showTocButton: boolean;
  showChapterButtons: boolean;
  showVocabularyButton: boolean;
  showTtsButton: boolean;
  showAnnotationButton: boolean;
  toolbarOrder: string[];
  clickZones: ReaderClickZone[];
  showPageInfo: boolean;
  showReaderJumpBack: boolean;
  readerJumpBackDismissMode: string;
  readerJumpBackDismissSeconds: number;
  readerJumpBackDismissPages: number;
  readerJumpBackIconSizePx: number;
  readerJumpBackPositionX: number;
  readerJumpBackPositionY: number;
  epubLayoutEngine: "legacy" | "modern";
}
type ReaderSettingsPatch = Partial<ReaderSettingsState>;
type AppearanceScope = "book" | "default";
type ReaderClickAction = "prev" | "center" | "next" | "none";

interface ReaderClickZone {
  readonly id: string;
  readonly action: ReaderClickAction;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface ReaderLayoutSettings extends Record<string, unknown> {
  readonly version: 1;
  readonly fontFamily: string;
  readonly styleMode: "book" | "local";
  readonly textConversion: "s2t" | "t2s";
  readonly fontSize: number;
  readonly noteFontSize: number;
  readonly lineHeight: number;
  readonly paraSpacing: number;
  readonly letterSpacing: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  readonly marginRight: number;
  readonly dualPageGap: number;
  readonly pageMode: "dual" | "single";
  readonly flowMode: "paged" | "scroll";
  readonly pageTurnEffect: "horizontal" | "off";
  readonly pageTurnSpeed: number;
  readonly imagePagination: "continuous" | "next-page";
}

interface AppSettingsRequest extends Record<string, unknown> {
  readonly showReaderJumpBack: boolean;
  readonly readerJumpBackDismissMode: "pages" | "time";
  readonly readerJumpBackDismissSeconds: number;
  readonly readerJumpBackDismissPages: number;
  readonly readerJumpBackIconSizePx: number;
  readonly readerJumpBackPositionX: number;
  readonly readerJumpBackPositionY: number;
  readonly epubLayoutEngine: "legacy" | "modern";
  readonly readerLayoutSettings: ReaderLayoutSettings | null;
}

interface AppSettingsSnapshot extends Partial<AppSettingsRequest> {
  readonly exists: boolean;
  readonly hasReaderLayoutSettings?: boolean;
}

interface ReaderFontStatus {
  readonly id: string;
  readonly label: string;
  readonly family: string;
  readonly installed: boolean;
  readonly bytes: number;
  readonly download_bytes: number;
}

type ReaderSettingsCommands = {
  readonly set_reader_paged_wheel_momentum_filter: {
    readonly args: { readonly enabled: boolean };
    readonly result: null;
  };
  readonly app_settings_sync_get: { readonly result: AppSettingsSnapshot };
  readonly app_settings_sync_save: {
    readonly args: { readonly request: AppSettingsRequest };
    readonly result: AppSettingsSnapshot;
  };
  readonly reader_font_status: { readonly result: readonly ReaderFontStatus[] };
  readonly download_reader_font: {
    readonly args: { readonly fontId: string };
    readonly result: ReaderFontStatus;
  };
};

type VerifiedReaderSettingsCommands =
  ReaderSettingsCommands extends TauriCommandMap
    ? ReaderSettingsCommands
    : never;

interface ReaderSettingsPort {
  setPagedWheelMomentumFilter(enabled: boolean): Promise<null>;
  getAppSettings(): Promise<AppSettingsSnapshot>;
  saveAppSettings(request: AppSettingsRequest): Promise<AppSettingsSnapshot>;
  fontStatus(): Promise<readonly ReaderFontStatus[]>;
  downloadFont(fontId: string): Promise<ReaderFontStatus>;
  listenAppSettingsSynced(handler: () => void): Promise<TauriUnlisten>;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ReaderSettingsApi {
  get(): ReaderSettingsState;
  update(patch?: ReaderSettingsPatch, options?: ChangeOptions): void;
  applyDeferredSettings(): void;
  getAppearance(scope?: AppearanceScope): ReaderSettingsState;
  updateAppearance(patch?: ReaderSettingsPatch, scope?: AppearanceScope): void;
  setBookContext(bookId: unknown): void;
  hasBookAppearance(): boolean;
  clearBookAppearance(): void;
  clickActionAt(
    clientX: unknown,
    clientY: unknown,
    width: unknown,
    height: unknown,
  ): ReaderClickAction;
  applyToolbarVisibility(): void;
}

interface ReaderI18nApi {
  t?(
    key: string,
    fallback?: string,
    values?: Readonly<Record<string, unknown>>,
  ): string;
  resolvedLanguage?(): string;
}

interface ReaderAnimationSettingsApi {
  readonly STORAGE_KEY?: string;
  applyReader?(root: Document): void;
  setPageTurnFromReader?(enabled: boolean): void;
}

interface ReaderSettingsRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: StorageLike;
  readonly navigator: Pick<Navigator, "userAgent">;
  readonly ReaderI18n?: ReaderI18nApi;
  readonly ReaderAnimationSettings?: ReaderAnimationSettingsApi;
  readonly ReaderBugTrace?: {
    record?(type: unknown, detail?: Readonly<Record<string, unknown>>): void;
  };
  isPdf?: boolean;
  frame?: HTMLIFrameElement;
  settings?: ReaderSettingsState;
  ReaderSettings?: ReaderSettingsApi;
  applyShellTheme?: (theme: unknown) => void;
  initSettingsUI?: () => void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  dispatchEvent(event: Event): boolean;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle?: number): void;
}

interface ReaderControlElement extends HTMLElement {
  value: string;
  min: string;
  max: string;
  checked: boolean;
  disabled: boolean;
  selectedIndex: number;
  readonly options: HTMLOptionsCollection;
}

interface ChangeOptions {
  readonly deferModeChange?: boolean;
  readonly deferPageApply?: boolean;
}

export interface ReaderSettingsInstallOptions {
  readonly transport?: TauriTransport;
  readonly storage?: StorageLike;
}

export interface ReaderSettingsGlobals {
  readonly ReaderSettings: ReaderSettingsApi;
  readonly applyShellTheme: (theme: unknown) => void;
  readonly initSettingsUI: () => void;
  readonly settings: ReaderSettingsState;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ReaderSettingsRuntime | null {
  const runtime = record(value);
  return runtime && record(runtime.document) && record(runtime.localStorage)
    ? (runtime as unknown as ReaderSettingsRuntime)
    : null;
}

function createReaderSettingsPort(
  transport: TauriTransport,
): ReaderSettingsPort {
  const api = createTauriApi<VerifiedReaderSettingsCommands>(transport);
  return Object.freeze({
    setPagedWheelMomentumFilter: (enabled: boolean) =>
      api.invoke("set_reader_paged_wheel_momentum_filter", { enabled }),
    getAppSettings: () => api.invoke("app_settings_sync_get"),
    saveAppSettings: (request: AppSettingsRequest) =>
      api.invoke("app_settings_sync_save", { request }),
    fontStatus: () => api.invoke("reader_font_status"),
    downloadFont: (fontId: string) =>
      api.invoke("download_reader_font", { fontId }),
    listenAppSettingsSynced: (handler: () => void) => {
      if (!transport.listen)
        return Promise.reject(new Error("Tauri event.listen is unavailable."));
      return transport.listen("app-settings-synced", handler);
    },
  });
}

export function installReaderSettingsUi(
  target: unknown,
  options: ReaderSettingsInstallOptions = {},
): ReaderSettingsGlobals | null {
  const candidate = runtimeFrom(target);
  if (!candidate) return null;
  const global: ReaderSettingsRuntime = candidate;
  const document = global.document;
  const storage = options.storage ?? global.localStorage;
  const elementById = (id: string): ReaderControlElement | null =>
    document.getElementById(id) as ReaderControlElement | null;
  let transport = options.transport;
  if (!transport) {
    try {
      transport = transportFromTauriGlobal(global);
    } catch {
      transport = undefined;
    }
  }
  const settingsPort = transport ? createReaderSettingsPort(transport) : null;
  // 阅读设置状态与设置面板绑定
  // 先于 reader.js 加载：提供 settings/applyShellTheme/initSettingsUI 给阅读页启动逻辑使用。

  const readerSettingsT = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ) => global.ReaderI18n?.t?.(key, fallback, values) || fallback;

  function normalizeReaderJumpBackIconSizePx(value: unknown, fallback = 32) {
    const number = Number(value);
    return Math.max(
      30,
      Math.min(160, Math.round(Number.isFinite(number) ? number : fallback)),
    );
  }

  // 阅读页设置会经 postMessage 传给章节 iframe，再动态拼入 CSS。将原始 10 MB
  // 图片直接作为 data URL 传递会让 WebView2 的消息和样式文本膨胀到十余 MB，甚至
  // 使阅读器无法打开。导入端会先压缩；这里仍保留迁移保护，用于清理旧版本留下的值。
  const MAX_INLINE_BACKGROUND_IMAGE_CHARS = 160000;
  const BACKGROUND_IMAGE_DATA_URL =
    /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;

  function safeBackgroundImage(value: unknown) {
    const image = String(value || "");
    return image.length <= MAX_INLINE_BACKGROUND_IMAGE_CHARS &&
      BACKGROUND_IMAGE_DATA_URL.test(image)
      ? image
      : "";
  }

  function sanitizeBackgroundImage(
    settingsValue: Record<string, unknown> | null | undefined,
  ) {
    if (!settingsValue || typeof settingsValue !== "object") return false;
    const safe = safeBackgroundImage(settingsValue.customBackgroundImage);
    if (safe === String(settingsValue.customBackgroundImage || ""))
      return false;
    settingsValue.customBackgroundImage = safe;
    return true;
  }

  function applyReaderAnimationSettings() {
    global.ReaderAnimationSettings?.applyReader?.(document);
  }
  global.addEventListener(
    "reader-animation-settings-changed",
    applyReaderAnimationSettings,
  );
  global.addEventListener("storage", (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key === global.ReaderAnimationSettings?.STORAGE_KEY)
      applyReaderAnimationSettings();
  });
  applyReaderAnimationSettings();

  const READER_TOOLBAR_ITEM_IDS = Object.freeze([
    "toc",
    "chapters",
    "tts",
    "annotations",
    "vocabulary",
    "settings",
  ]);
  const READER_CLICK_ZONE_ACTIONS = Object.freeze([
    "prev",
    "center",
    "next",
    "none",
  ]);
  const READER_LAYOUT_FONT_FAMILIES = Object.freeze([
    "",
    "'Microsoft YaHei',sans-serif",
    "'SimSun',serif",
    "'SimHei',sans-serif",
    "'KaiTi',serif",
    "'Kunpeng LXGW WenKai Lite','Microsoft YaHei',sans-serif",
    "'Kunpeng Source Han Serif SC','SimSun',serif",
    "'Kunpeng Zhuque Fangsong','FangSong','SimSun',serif",
    "serif",
    "sans-serif",
  ]);
  const MAX_READER_CLICK_ZONES = 12;
  const DEFAULT_READER_CLICK_ZONES = Object.freeze([
    Object.freeze({
      id: "zone-1",
      action: "prev",
      x: 0,
      y: 0,
      width: 400,
      height: 1000,
    }),
    Object.freeze({
      id: "zone-2",
      action: "center",
      x: 400,
      y: 0,
      width: 200,
      height: 1000,
    }),
    Object.freeze({
      id: "zone-3",
      action: "next",
      x: 600,
      y: 0,
      width: 400,
      height: 1000,
    }),
  ]);

  function normalizedReaderToolbarOrder(value: unknown): string[] {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const order: string[] = [];
    source.forEach((id) => {
      if (READER_TOOLBAR_ITEM_IDS.includes(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    });
    READER_TOOLBAR_ITEM_IDS.forEach((id) => {
      if (!seen.has(id)) order.push(id);
    });
    return order;
  }

  function readerZonesOverlap(a: ReaderClickZone, b: ReaderClickZone) {
    return (
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y
    );
  }

  function trimReaderZoneAgainst(
    zone: ReaderClickZone,
    blocker: ReaderClickZone,
  ): ReaderClickZone | null {
    if (!readerZonesOverlap(zone, blocker)) return zone;
    const overlapLeft = Math.max(zone.x, blocker.x);
    const overlapTop = Math.max(zone.y, blocker.y);
    const overlapRight = Math.min(
      zone.x + zone.width,
      blocker.x + blocker.width,
    );
    const overlapBottom = Math.min(
      zone.y + zone.height,
      blocker.y + blocker.height,
    );
    const candidates = [
      Object.assign({}, zone, { width: overlapLeft - zone.x }),
      Object.assign({}, zone, {
        x: overlapRight,
        width: zone.x + zone.width - overlapRight,
      }),
      Object.assign({}, zone, { height: overlapTop - zone.y }),
      Object.assign({}, zone, {
        y: overlapBottom,
        height: zone.y + zone.height - overlapBottom,
      }),
    ].filter((candidate) => candidate.width >= 20 && candidate.height >= 20);
    candidates.sort((a, b) => b.width * b.height - a.width * a.height);
    return candidates[0] || null;
  }

  function removeReaderZoneOverlaps(
    source: ReaderClickZone[],
  ): ReaderClickZone[] {
    const accepted: ReaderClickZone[] = [];
    source.forEach((zone) => {
      let candidate: ReaderClickZone | null = zone;
      accepted.forEach((blocker) => {
        if (candidate) candidate = trimReaderZoneAgainst(candidate, blocker);
      });
      if (candidate) accepted.push(candidate);
    });
    return accepted;
  }

  function normalizedReaderClickZones(value: unknown): ReaderClickZone[] {
    const supplied = Array.isArray(value)
      ? value.filter((item) => item && typeof item === "object")
      : [];
    const source = (
      supplied.length ? supplied : DEFAULT_READER_CLICK_ZONES
    ).slice(0, MAX_READER_CLICK_ZONES);
    const usedIds = new Set();
    const normalized = source.map((raw, index) => {
      const fallback = DEFAULT_READER_CLICK_ZONES[index] || {
        id: `zone-${index + 1}`,
        action: "none",
        x: 350,
        y: 350,
        width: 300,
        height: 300,
      };
      const x = Math.max(0, Math.min(980, Math.round(Number(raw.x) || 0)));
      const y = Math.max(0, Math.min(980, Math.round(Number(raw.y) || 0)));
      const width = Math.max(
        20,
        Math.min(1000 - x, Math.round(Number(raw.width) || fallback.width)),
      );
      const height = Math.max(
        20,
        Math.min(1000 - y, Math.round(Number(raw.height) || fallback.height)),
      );
      let id =
        typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/i.test(raw.id)
          ? raw.id
          : fallback.id;
      const baseId = id;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${baseId}-${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      return {
        id,
        action: READER_CLICK_ZONE_ACTIONS.includes(raw.action)
          ? raw.action
          : fallback.action,
        x,
        y,
        width,
        height,
      };
    });
    return removeReaderZoneOverlaps(normalized);
  }

  function readerClickActionAt(
    clientX: unknown,
    clientY: unknown,
    width: unknown,
    height: unknown,
  ): ReaderClickAction {
    const viewportWidth = Math.max(1, Number(width) || 1);
    const viewportHeight = Math.max(1, Number(height) || 1);
    const x = Math.max(
      0,
      Math.min(1000, (Number(clientX) / viewportWidth) * 1000),
    );
    const y = Math.max(
      0,
      Math.min(1000, (Number(clientY) / viewportHeight) * 1000),
    );
    const match = normalizedReaderClickZones(settings.clickZones).find(
      (zone) =>
        x >= zone.x &&
        x <= zone.x + zone.width &&
        y >= zone.y &&
        y <= zone.y + zone.height,
    );
    return match?.action || "none";
  }

  function applyReaderToolbarOrder(value: unknown) {
    const toolbar = document.querySelector(".toolbar");
    const anchor = toolbar?.querySelector(".search-wrap");
    if (!toolbar || !anchor) return;
    const elements: Record<string, Array<HTMLElement | null>> = {
      toc: [elementById("toc-btn")],
      chapters: [elementById("prev-btn"), elementById("next-btn")],
      tts: [elementById("tts-btn")],
      annotations: [elementById("hl-btn")],
      vocabulary: [elementById("vocab-btn")],
      settings: [elementById("reader-settings-toolbar-item")],
    };
    normalizedReaderToolbarOrder(value).forEach((id) => {
      (elements[id] ?? [])
        .filter((element): element is HTMLElement => !!element)
        .forEach((element) => toolbar.insertBefore(element, anchor));
    });
  }

  const DEFAULTS = {
    theme: "light",
    fontFamily: "",
    styleMode: "local",
    textConversion: "t2s",
    fontSize: 18,
    noteFontSize: 14,
    lineHeight: 1.7,
    paraSpacing: 0.6,
    letterSpacing: 0,
    marginTop: 18,
    marginBottom: 24,
    marginLeft: 28,
    marginRight: 28,
    dualPageGap: 40,
    pageMode: "single",
    flowMode: "paged",
    pageTurnEffect: "horizontal",
    pageTurnSpeed: 1,
    ttsSource: "edge",
    ttsRate: 1,
    backgroundPreset: "light",
    customBackgroundColor: "#fffdf8",
    customBackgroundImage: "",
    customPaletteId: "",
    textColor: "",
    linkColor: "",
    selectionColor: "",
    footnoteBackground: "",
    footnoteBorder: "",
    imagePagination: "next-page",
    showTextConversion: true,
    showTocButton: true,
    showChapterButtons: true,
    showVocabularyButton: true,
    showTtsButton: true,
    showAnnotationButton: true,
    toolbarOrder: READER_TOOLBAR_ITEM_IDS.slice(),
    clickZones: DEFAULT_READER_CLICK_ZONES.map((zone) =>
      Object.assign({}, zone),
    ),
    showPageInfo: true,
    showReaderJumpBack: true,
    readerJumpBackDismissMode: "pages",
    readerJumpBackDismissSeconds: 30,
    readerJumpBackDismissPages: 3,
    readerJumpBackIconSizePx: 32,
    // 坐标以阅读区域宽高的千分比表示，因而在不同屏幕尺寸下仍保持相对位置。
    readerJumpBackPositionX: 950,
    readerJumpBackPositionY: 500,
    // 缺失或不认识的旧设置始终回退到已验证的旧版布局。
    epubLayoutEngine: "legacy",
  };

  // Windows WebView2 的原生 switch transition 正常；仅 macOS WKWebView 需要补偿动画。
  const READER_SHELL_IS_MAC_WEBKIT =
    /Macintosh|Mac OS X/.test(global.navigator.userAgent || "") &&
    /AppleWebKit/.test(global.navigator.userAgent || "") &&
    !/(?:Chrome|Chromium|Edg)\//.test(global.navigator.userAgent || "");

  // 外壳（工具栏/目录/设置）必须先于正文 iframe 应用主题。内置羊皮纸
  // 调色板沿用浅色正文主题，但由 backgroundPreset 保留自身的外壳语义。
  function applyShellTheme(theme: unknown) {
    const body = document.body;
    const parchment =
      theme === "sepia" ||
      (theme !== "dark" && settings.backgroundPreset === "paper");
    body.classList.add("reader-theme-instant");
    body.classList.toggle("theme-dark", theme === "dark");
    body.classList.toggle("theme-sepia", parchment);
    global.requestAnimationFrame(() =>
      global.requestAnimationFrame(() => {
        body.classList.remove("reader-theme-instant");
      }),
    );
  }

  function loadSettings() {
    try {
      const stored = JSON.parse(storage.getItem("readerSettings") || "{}");
      const { readerJumpBackSizeLevel: _removedJumpBackSizeLevel, ...current } =
        stored;
      const merged = Object.assign({}, DEFAULTS, current);
      merged.readerJumpBackIconSizePx = normalizeReaderJumpBackIconSizePx(
        merged.readerJumpBackIconSizePx,
      );
      // Older settings stored the three original backgrounds in theme only.
      if (
        !stored.backgroundPreset &&
        ["light", "dark", "sepia"].includes(stored.theme)
      )
        merged.backgroundPreset = stored.theme;
      if (
        _removedJumpBackSizeLevel !== undefined ||
        sanitizeBackgroundImage(merged)
      ) {
        storage.setItem("readerSettings", JSON.stringify(merged));
      }
      return merged;
    } catch {
      return Object.assign({}, DEFAULTS);
    }
  }
  let settings = loadSettings();
  const READER_APPEARANCE_KEYS = new Set([
    "backgroundPreset",
    "customBackgroundColor",
    "customBackgroundImage",
    "customPaletteId",
    "textColor",
    "linkColor",
    "selectionColor",
    "footnoteBackground",
    "footnoteBorder",
    "theme",
  ]);
  const READER_BOOK_APPEARANCE_KEY = "readerBookAppearanceV1";
  const defaultAppearanceSettings = Object.assign({}, settings);
  let activeReaderBookId = "";
  const bookAppearanceSettings = (() => {
    try {
      const stored = JSON.parse(
        storage.getItem(READER_BOOK_APPEARANCE_KEY) || "{}",
      );
      if (!stored || typeof stored !== "object") return {};
      let changed = false;
      Object.values(stored).forEach((appearance) => {
        changed = sanitizeBackgroundImage(record(appearance)) || changed;
      });
      if (changed)
        storage.setItem(READER_BOOK_APPEARANCE_KEY, JSON.stringify(stored));
      return stored;
    } catch {
      return {};
    }
  })();
  global.addEventListener("storage", (event: Event) => {
    const storageEvent = event as StorageEvent;
    if (storageEvent.key !== "readerSettings") return;
    settings = loadSettings();
    normalizeModeSettings();
    const turnFx = elementById("set-turnfx");
    if (turnFx) turnFx.value = settings.pageTurnEffect;
    pushSettings();
  });

  function normalizeModeSettings() {
    let changed = false;
    const toolbarOrder = normalizedReaderToolbarOrder(settings.toolbarOrder);
    if (
      !Array.isArray(settings.toolbarOrder) ||
      toolbarOrder.some((id, index) => settings.toolbarOrder[index] !== id) ||
      settings.toolbarOrder.length !== toolbarOrder.length
    ) {
      settings.toolbarOrder = toolbarOrder;
      changed = true;
    }
    const clickZones = normalizedReaderClickZones(settings.clickZones);
    if (
      !Array.isArray(settings.clickZones) ||
      JSON.stringify(clickZones) !== JSON.stringify(settings.clickZones)
    ) {
      settings.clickZones = clickZones;
      changed = true;
    }
    if (!["local", "book"].includes(settings.styleMode)) {
      settings.styleMode = DEFAULTS.styleMode;
      changed = true;
    }
    if (["google-paper", "curl"].includes(settings.pageTurnEffect)) {
      // 旧的两种动画统一迁移到新的水平整页翻动。
      settings.pageTurnEffect = "horizontal";
      changed = true;
    } else if (!["off", "horizontal"].includes(settings.pageTurnEffect)) {
      settings.pageTurnEffect = DEFAULTS.pageTurnEffect;
      changed = true;
    }
    // v1.11.2 的“原文”选项迁移为简体，新的开关始终在简/繁之间切换。
    if (settings.textConversion === "original") {
      settings.textConversion = "t2s";
      changed = true;
    } else if (!["t2s", "s2t"].includes(settings.textConversion)) {
      settings.textConversion = DEFAULTS.textConversion;
      changed = true;
    }
    const speed = parseFloat(settings.pageTurnSpeed);
    if (!Number.isFinite(speed)) {
      settings.pageTurnSpeed = DEFAULTS.pageTurnSpeed;
      changed = true;
    } else {
      const next = Math.max(0.5, Math.min(2, speed));
      if (next !== settings.pageTurnSpeed) {
        settings.pageTurnSpeed = next;
        changed = true;
      }
    }
    const dualPageGap = Number(settings.dualPageGap);
    if (!Number.isFinite(dualPageGap)) {
      settings.dualPageGap = DEFAULTS.dualPageGap;
      changed = true;
    } else {
      const nextGap = Math.max(0, Math.min(120, Math.round(dualPageGap)));
      if (nextGap !== settings.dualPageGap) {
        settings.dualPageGap = nextGap;
        changed = true;
      }
    }
    if (settings.flowMode === "scroll" && settings.pageMode !== "single") {
      settings.pageMode = "single";
      changed = true;
    }
    if (settings.epubLayoutEngine !== "modern" && settings.epubLayoutEngine !== "legacy") {
      settings.epubLayoutEngine = DEFAULTS.epubLayoutEngine;
      changed = true;
    }
    return changed;
  }

  function saveSettings() {
    normalizeModeSettings();
    sanitizeBackgroundImage(defaultAppearanceSettings);
    storage.setItem(
      "readerSettings",
      JSON.stringify(defaultAppearanceSettings),
    );
  }
  // 把设置发给合并页（实时注入样式）
  function pushSettings(options?: ChangeOptions) {
    // UI language is window state, not a persisted reading preference.  Pass it
    // through with every layout update so the injected chapter iframe never
    // keeps stale Chinese controls after the user changes language.
    const pageSettings = Object.assign({}, settings, {
      uiLanguage: global.ReaderI18n?.resolvedLanguage?.() || "zh-CN",
    });
    const frameReady = Boolean(global.frame?.contentWindow);
    global.ReaderBugTrace?.record?.("reader_settings_dispatch", {
      source: "reader_settings",
      outcome: frameReady ? "sent" : "frame_missing",
      ready: frameReady,
      flow_mode: pageSettings.flowMode,
      page_mode: pageSettings.pageMode,
    });
    if (global.frame?.contentWindow)
      global.frame.contentWindow.postMessage(
        {
          settings: pageSettings,
          deferModeChange: !!options?.deferModeChange,
        },
        "*",
      );
    // WebKit 不会把 macOS 的 momentumPhase 交给网页 WheelEvent。整屏模式由
    // 原生层过滤惯性尾流，正文仅处理手指仍接触触控板时的直接输入；滚动模式
    // 则完全保留系统的自然惯性滚动。
    if (settingsPort) {
      settingsPort
        .setPagedWheelMomentumFilter(
          !global.isPdf && pageSettings.flowMode !== "scroll",
        )
        .catch(() => {});
    }
  }
  global.addEventListener("pagehide", () => {
    if (settingsPort) {
      settingsPort.setPagedWheelMomentumFilter(false).catch(() => {});
    }
  });
  global.addEventListener("reader-language-changed", () => pushSettings());
  function onChange(options?: ChangeOptions) {
    Object.keys(settings).forEach((key) => {
      if (!READER_APPEARANCE_KEYS.has(key))
        defaultAppearanceSettings[key] = settings[key];
    });
    saveSettings();
    // 版式滑杆的实时预览由独立的阅读页承担。拖动过程中不要反复重排
    // 用户正在看的 iframe；松手后再一次性应用到真实阅读页。
    if (!options?.deferPageApply) pushSettings(options);
    global.dispatchEvent(
      new CustomEvent("reader-settings-changed", {
        detail: Object.assign({}, settings),
      }),
    );
  }

  function setReaderSettings(
    patch: ReaderSettingsPatch = {},
    options?: ChangeOptions,
  ) {
    Object.assign(settings, patch || {});
    Object.assign(defaultAppearanceSettings, patch || {});
    sanitizeBackgroundImage(settings);
    sanitizeBackgroundImage(defaultAppearanceSettings);
    sanitizeBackgroundImage(settings);
    sanitizeBackgroundImage(defaultAppearanceSettings);
    if (
      patch &&
      Object.prototype.hasOwnProperty.call(patch, "backgroundPreset")
    ) {
      settings.theme = patch.theme || settings.backgroundPreset;
      defaultAppearanceSettings.theme = settings.theme;
    }
    normalizeModeSettings();
    applyShellTheme(settings.theme);
    onChange(options);
  }

  function applyAppearanceSettings(next: ReaderSettingsPatch = {}) {
    Object.assign(settings, next || {});
    sanitizeBackgroundImage(settings);
    sanitizeBackgroundImage(settings);
    normalizeModeSettings();
    applyShellTheme(settings.theme);
    pushSettings();
    global.dispatchEvent(
      new CustomEvent("reader-settings-changed", {
        detail: Object.assign({}, settings),
      }),
    );
  }

  function appearanceForScope(scope?: AppearanceScope) {
    if (scope === "book" && activeReaderBookId) {
      // 早期阅读偏好把工具栏开关也误写进了单本外观。单本覆盖只允许
      // 外观字段，避免旧值继续压过总体工具栏设置。
      const bookAppearance = bookAppearanceSettings[activeReaderBookId] || {};
      const appearanceOverrides = Object.fromEntries(
        Object.entries(bookAppearance).filter(([key]) =>
          READER_APPEARANCE_KEYS.has(key),
        ),
      );
      return Object.assign({}, defaultAppearanceSettings, appearanceOverrides);
    }
    return Object.assign({}, defaultAppearanceSettings);
  }

  function updateAppearance(
    patch: ReaderSettingsPatch = {},
    scope?: AppearanceScope,
  ) {
    const targetScope =
      scope === "book" && activeReaderBookId ? "book" : "default";
    if (targetScope === "book") {
      const current = bookAppearanceSettings[activeReaderBookId] || {};
      const appearancePatch = Object.fromEntries(
        Object.entries(patch || {}).filter(([key]) =>
          READER_APPEARANCE_KEYS.has(key),
        ),
      );
      bookAppearanceSettings[activeReaderBookId] = Object.assign(
        {},
        current,
        appearancePatch,
      );
      sanitizeBackgroundImage(bookAppearanceSettings[activeReaderBookId]);
      sanitizeBackgroundImage(bookAppearanceSettings[activeReaderBookId]);
      storage.setItem(
        READER_BOOK_APPEARANCE_KEY,
        JSON.stringify(bookAppearanceSettings),
      );
      applyAppearanceSettings(appearanceForScope("book"));
      return;
    }
    Object.assign(defaultAppearanceSettings, patch || {});
    sanitizeBackgroundImage(defaultAppearanceSettings);
    if (
      patch &&
      Object.prototype.hasOwnProperty.call(patch, "backgroundPreset") &&
      !Object.prototype.hasOwnProperty.call(patch, "theme")
    )
      defaultAppearanceSettings.theme =
        defaultAppearanceSettings.backgroundPreset;
    saveSettings();
    applyAppearanceSettings(
      activeReaderBookId
        ? appearanceForScope("book")
        : appearanceForScope("default"),
    );
  }

  const ReaderSettings: ReaderSettingsApi = Object.freeze({
    get() {
      return Object.assign({}, settings);
    },
    update: setReaderSettings,
    applyDeferredSettings() {
      pushSettings();
    },
    getAppearance(scope?: AppearanceScope) {
      return appearanceForScope(scope);
    },
    updateAppearance,
    setBookContext(bookId: unknown) {
      activeReaderBookId = String(bookId || "");
      if (activeReaderBookId && bookAppearanceSettings[activeReaderBookId])
        applyAppearanceSettings(appearanceForScope("book"));
    },
    hasBookAppearance() {
      return !!(
        activeReaderBookId && bookAppearanceSettings[activeReaderBookId]
      );
    },
    clearBookAppearance() {
      if (!activeReaderBookId || !bookAppearanceSettings[activeReaderBookId])
        return;
      delete bookAppearanceSettings[activeReaderBookId];
      storage.setItem(
        READER_BOOK_APPEARANCE_KEY,
        JSON.stringify(bookAppearanceSettings),
      );
      applyAppearanceSettings(appearanceForScope("default"));
    },
    clickActionAt(
      clientX: unknown,
      clientY: unknown,
      width: unknown,
      height: unknown,
    ) {
      return readerClickActionAt(clientX, clientY, width, height);
    },
    applyToolbarVisibility() {
      applyReaderToolbarOrder(settings.toolbarOrder);
      document
        .querySelector(".text-conversion-toggle")
        ?.toggleAttribute("hidden", settings.showTextConversion === false);
      const hideChapterButtons = settings.showChapterButtons === false;
      elementById("prev-btn")?.toggleAttribute("hidden", hideChapterButtons);
      elementById("next-btn")?.toggleAttribute("hidden", hideChapterButtons);
      elementById("vocab-btn")?.toggleAttribute(
        "hidden",
        settings.showVocabularyButton === false,
      );
    },
  });

  // Native calls are owned by the typed reader settings port.
  let appSettingsSyncReady = false;
  let appSettingsSyncTimer = 0;
  let lastAppSettingsSyncPayload = "";

  function normalizedJumpBackPosition(value: unknown, fallback: number) {
    const number = Number(value);
    return Math.max(
      0,
      Math.min(1000, Math.round(Number.isFinite(number) ? number : fallback)),
    );
  }

  function normalizedReaderLayoutNumber(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
    step = 1,
  ) {
    const number = Number(value);
    const bounded = Math.max(
      minimum,
      Math.min(maximum, Number.isFinite(number) ? number : fallback),
    );
    return Math.round(Math.round(bounded / step) * step * 10) / 10;
  }

  function normalizedReaderLayoutSettings(
    value: unknown,
  ): ReaderLayoutSettings | null {
    const layout = record(value);
    if (!layout) return null;
    const requestedFont =
      typeof layout.fontFamily === "string" ? layout.fontFamily : "";
    const fontFamily = READER_LAYOUT_FONT_FAMILIES.includes(requestedFont)
      ? requestedFont
      : "";
    const flowMode = layout.flowMode === "scroll" ? "scroll" : "paged";
    return {
      version: 1,
      fontFamily,
      styleMode: layout.styleMode === "book" ? "book" : "local",
      textConversion: layout.textConversion === "s2t" ? "s2t" : "t2s",
      fontSize: normalizedReaderLayoutNumber(
        layout.fontSize,
        DEFAULTS.fontSize,
        12,
        40,
      ),
      noteFontSize: normalizedReaderLayoutNumber(
        layout.noteFontSize,
        DEFAULTS.noteFontSize,
        10,
        22,
      ),
      lineHeight: normalizedReaderLayoutNumber(
        layout.lineHeight,
        DEFAULTS.lineHeight,
        1,
        2.6,
        0.1,
      ),
      paraSpacing: normalizedReaderLayoutNumber(
        layout.paraSpacing,
        DEFAULTS.paraSpacing,
        0,
        2,
        0.1,
      ),
      letterSpacing: normalizedReaderLayoutNumber(
        layout.letterSpacing,
        DEFAULTS.letterSpacing,
        0,
        5,
        0.5,
      ),
      marginTop: normalizedReaderLayoutNumber(
        layout.marginTop,
        DEFAULTS.marginTop,
        0,
        160,
      ),
      marginBottom: normalizedReaderLayoutNumber(
        layout.marginBottom,
        DEFAULTS.marginBottom,
        0,
        160,
      ),
      marginLeft: normalizedReaderLayoutNumber(
        layout.marginLeft,
        DEFAULTS.marginLeft,
        0,
        240,
      ),
      marginRight: normalizedReaderLayoutNumber(
        layout.marginRight,
        DEFAULTS.marginRight,
        0,
        240,
      ),
      dualPageGap: normalizedReaderLayoutNumber(
        layout.dualPageGap,
        DEFAULTS.dualPageGap,
        0,
        120,
      ),
      pageMode:
        flowMode === "scroll"
          ? "single"
          : layout.pageMode === "dual"
            ? "dual"
            : "single",
      flowMode,
      pageTurnEffect: layout.pageTurnEffect === "off" ? "off" : "horizontal",
      pageTurnSpeed: normalizedReaderLayoutNumber(
        layout.pageTurnSpeed,
        DEFAULTS.pageTurnSpeed,
        0.5,
        2,
        0.1,
      ),
      imagePagination:
        layout.imagePagination === "continuous" ? "continuous" : "next-page",
    };
  }

  function normalizedAppSettingsSyncPayload(): AppSettingsRequest {
    return {
      showReaderJumpBack: settings.showReaderJumpBack !== false,
      readerJumpBackDismissMode:
        settings.readerJumpBackDismissMode === "time" ? "time" : "pages",
      readerJumpBackDismissSeconds: Math.max(
        1,
        Math.min(600, Number(settings.readerJumpBackDismissSeconds) || 30),
      ),
      readerJumpBackDismissPages: Math.max(
        1,
        Math.min(100, Number(settings.readerJumpBackDismissPages) || 3),
      ),
      readerJumpBackIconSizePx: normalizeReaderJumpBackIconSizePx(
        settings.readerJumpBackIconSizePx,
      ),
      readerJumpBackPositionX: normalizedJumpBackPosition(
        settings.readerJumpBackPositionX,
        950,
      ),
      readerJumpBackPositionY: normalizedJumpBackPosition(
        settings.readerJumpBackPositionY,
        500,
      ),
      epubLayoutEngine:
        settings.epubLayoutEngine === "modern" ? "modern" : "legacy",
      readerLayoutSettings: normalizedReaderLayoutSettings(settings),
    };
  }

  function queueAppSettingsSyncSave() {
    if (!appSettingsSyncReady || !settingsPort) return;
    const request = normalizedAppSettingsSyncPayload();
    const serialized = JSON.stringify(request);
    if (serialized === lastAppSettingsSyncPayload) return;
    if (appSettingsSyncTimer) clearTimeout(appSettingsSyncTimer);
    appSettingsSyncTimer = global.setTimeout(async () => {
      appSettingsSyncTimer = 0;
      try {
        await settingsPort.saveAppSettings(request);
        lastAppSettingsSyncPayload = serialized;
      } catch {
        // 离线或数据库暂不可用时保留本机设置；下次修改或打开阅读页会重试。
      }
    }, 180);
  }

  async function hydrateAppSettingsSync() {
    if (!settingsPort) {
      appSettingsSyncReady = true;
      return;
    }
    try {
      const remote = await settingsPort.getAppSettings();
      if (remote?.exists) {
        appSettingsSyncReady = false;
        const remoteLayout = remote?.hasReaderLayoutSettings
          ? normalizedReaderLayoutSettings(remote.readerLayoutSettings)
          : null;
        setReaderSettings({
          showReaderJumpBack: remote.showReaderJumpBack !== false,
          readerJumpBackDismissMode:
            remote.readerJumpBackDismissMode === "time" ? "time" : "pages",
          readerJumpBackDismissSeconds: Math.max(
            1,
            Math.min(600, Number(remote.readerJumpBackDismissSeconds) || 30),
          ),
          readerJumpBackDismissPages: Math.max(
            1,
            Math.min(100, Number(remote.readerJumpBackDismissPages) || 3),
          ),
          readerJumpBackIconSizePx: normalizeReaderJumpBackIconSizePx(
            remote.readerJumpBackIconSizePx,
          ),
          readerJumpBackPositionX: normalizedJumpBackPosition(
            remote.readerJumpBackPositionX,
            950,
          ),
          readerJumpBackPositionY: normalizedJumpBackPosition(
            remote.readerJumpBackPositionY,
            500,
          ),
          epubLayoutEngine:
            remote.epubLayoutEngine === "modern" ? "modern" : "legacy",
          ...(remoteLayout || {}),
        });
        lastAppSettingsSyncPayload = remoteLayout
          ? JSON.stringify(normalizedAppSettingsSyncPayload())
          : "";
        appSettingsSyncReady = true;
        if (!remoteLayout) queueAppSettingsSyncSave();
        return;
      }
      appSettingsSyncReady = true;
      lastAppSettingsSyncPayload = "";
      queueAppSettingsSyncSave();
    } catch {
      appSettingsSyncReady = true;
    }
  }

  global.addEventListener("reader-settings-changed", queueAppSettingsSyncSave);
  settingsPort
    ?.listenAppSettingsSynced(() => {
      void hydrateAppSettingsSync();
    })
    .catch(() => undefined);
  hydrateAppSettingsSync();

  function applyReaderSettingsVisibility() {
    ReaderSettings.applyToolbarVisibility();
  }

  function bindRange(
    id: string,
    vid: string,
    key: keyof ReaderSettingsState,
    fmt: (value: number) => string,
  ) {
    const el = elementById(id);
    const vEl = elementById(vid);
    if (!el || !vEl) return;
    el.value = String(settings[key]);
    vEl.textContent = fmt(Number(settings[key]));
    el.addEventListener("input", () => {
      settings[key] = parseFloat(el.value);
      vEl.textContent = fmt(Number(settings[key]));
      if (key === "ttsRate") {
        const counterpartId =
          id === "set-ttsrate" ? "quick-set-ttsrate" : "set-ttsrate";
        const counterpartValueId =
          id === "set-ttsrate" ? "quick-v-ttsrate" : "v-ttsrate";
        const counterpart = elementById(counterpartId);
        const counterpartValue = elementById(counterpartValueId);
        if (counterpart) counterpart.value = el.value;
        if (counterpartValue)
          counterpartValue.textContent = fmt(Number(settings[key]));
      }
      onChange();
    });
  }
  function ensureNoteSizeControl() {
    if (elementById("set-note-size")) return;
    const size = elementById("set-size");
    const sizeRow = size && size.closest ? size.closest(".row") : null;
    if (!sizeRow || !sizeRow.parentNode) return;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML =
      '<label data-reader-i18n="noteFontSize">' +
      readerSettingsT("noteFontSize", "注释字号") +
      '</label><input type="range" id="set-note-size" min="10" max="22" step="1" /><span class="val" id="v-note-size"></span>';
    sizeRow.parentNode.insertBefore(row, sizeRow.nextSibling);
  }
  function bindNum(id: string, key: keyof ReaderSettingsState) {
    const el = elementById(id);
    if (!el) return;
    const lo = el.min !== "" ? parseInt(el.min, 10) : 0;
    const hi = el.max !== "" ? parseInt(el.max, 10) : 9999;
    const clamp = (v: number) => Math.max(lo, Math.min(hi, isNaN(v) ? 0 : v));
    el.value = String(clamp(parseInt(String(settings[key]), 10)));
    el.addEventListener("input", () => {
      settings[key] = clamp(parseInt(el.value, 10)); // 用于排版的值始终夹紧（负边距会让页面变形）
      if (String(el.value) !== String(settings[key]))
        el.value = String(settings[key]);
      onChange();
    });
    el.addEventListener("change", () => {
      el.value = String(clamp(parseInt(el.value, 10))); // 失焦时把输入框也纠正回合法范围
    });
  }

  function initSettingsUI() {
    if (normalizeModeSettings()) saveSettings();
    ensureNoteSizeControl();
    // 主题按钮
    function refreshThemeBtns() {
      document
        .querySelectorAll<HTMLElement>(".theme-btn")
        .forEach((b) =>
          b.classList.toggle("active", b.dataset.theme === settings.theme),
        );
    }
    document.querySelectorAll<HTMLElement>(".theme-btn").forEach((b) => {
      b.addEventListener("click", () => {
        settings.theme = b.dataset.theme;
        settings.backgroundPreset = settings.theme;
        refreshThemeBtns();
        applyShellTheme(settings.theme);
        onChange();
      });
    });
    refreshThemeBtns();

    const fontElement = elementById("set-font");
    if (!fontElement) return;
    const font: ReaderControlElement = fontElement;
    const fontDownloadRow = elementById("reader-font-download-row");
    const fontDownloadStatus = elementById("reader-font-download-status");
    const fontDownloadAction = elementById("reader-font-download-action");
    const readerFontState = new Map<string, ReaderFontStatus>();
    let fontDownloadBusy = false;
    const selectedOptionalFont = () => {
      const option = font.options[font.selectedIndex];
      return option?.dataset?.readerFontId ? option : null;
    };
    const fontSizeText = (bytes: unknown) => {
      const mb = Number(bytes || 0) / (1024 * 1024);
      return (mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)) + " MB";
    };
    function refreshOptionalFontUI() {
      font
        .querySelectorAll<HTMLOptionElement>("option[data-reader-font-id]")
        .forEach((option) => {
          const state = readerFontState.get(option.dataset.readerFontId ?? "");
          const label = option.dataset.readerFontLabel || option.textContent;
          option.textContent = state?.installed
            ? label + " (" + readerSettingsT("installed", "已安装") + ")"
            : label +
              " (" +
              readerSettingsT("downloadRequired", "需下载") +
              (state?.download_bytes
                ? " " + fontSizeText(state.download_bytes)
                : "") +
              ")";
        });
      const option = selectedOptionalFont();
      if (!option) {
        if (fontDownloadRow) fontDownloadRow.hidden = true;
        return;
      }
      const state = readerFontState.get(option.dataset.readerFontId ?? "");
      if (fontDownloadRow) fontDownloadRow.hidden = false;
      if (fontDownloadStatus) {
        fontDownloadStatus.textContent = fontDownloadBusy
          ? readerSettingsT("fontDownloading", "正在下载并校验字体…")
          : state?.installed
            ? readerSettingsT(
                "fontInstalledOffline",
                "已安装到本机，断网也可使用。",
              )
            : readerSettingsT(
                "fontDownloadRequired",
                "首次使用需下载 {size}，下载后自动应用。",
                { size: fontSizeText(state?.download_bytes) },
              );
      }
      if (fontDownloadAction) {
        fontDownloadAction.hidden = !!state?.installed;
        fontDownloadAction.disabled = fontDownloadBusy;
        fontDownloadAction.textContent = fontDownloadBusy
          ? readerSettingsT("downloading", "下载中…")
          : readerSettingsT("download", "下载");
      }
    }
    global.addEventListener("reader-language-changed", refreshOptionalFontUI);
    async function loadReaderFontStatus() {
      if (!settingsPort) {
        refreshOptionalFontUI();
        return;
      }
      try {
        const states = await settingsPort.fontStatus();
        states.forEach((state) => readerFontState.set(state.id, state));
      } catch {}
      refreshOptionalFontUI();
    }
    async function installSelectedFont() {
      if (!settingsPort) return;
      const option = selectedOptionalFont();
      if (!option || fontDownloadBusy) return;
      const id = option.dataset.readerFontId;
      if (!id) return;
      if (readerFontState.get(id)?.installed) {
        settings.fontFamily = font.value;
        onChange();
        return;
      }
      fontDownloadBusy = true;
      refreshOptionalFontUI();
      try {
        const state = await settingsPort.downloadFont(id);
        readerFontState.set(id, state);
        settings.fontFamily = font.value;
        onChange();
      } catch (error) {
        if (fontDownloadStatus)
          fontDownloadStatus.textContent = readerSettingsT(
            "fontDownloadFailed",
            "字体下载失败：{error}",
            { error: String(error) },
          );
      } finally {
        fontDownloadBusy = false;
        refreshOptionalFontUI();
      }
    }
    font.value = settings.fontFamily;
    font.addEventListener("change", () => {
      refreshOptionalFontUI();
      const option = selectedOptionalFont();
      if (
        option &&
        !readerFontState.get(option.dataset.readerFontId ?? "")?.installed
      ) {
        installSelectedFont();
        return;
      }
      settings.fontFamily = font.value;
      onChange();
    });
    fontDownloadAction?.addEventListener("click", installSelectedFont);
    loadReaderFontStatus();
    const styleMode = elementById("set-style-mode");
    if (styleMode) {
      styleMode.value = settings.styleMode;
      styleMode.addEventListener("change", () => {
        settings.styleMode = styleMode.value === "book" ? "book" : "local";
        onChange();
      });
    }
    const textConversionToggle = elementById("set-text-conversion-simple");
    const textConversionLabel = elementById("text-conversion-state-label");
    if (textConversionToggle) {
      const renderTextConversionState = () => {
        const traditional = settings.textConversion === "s2t";
        textConversionToggle.checked = traditional;
        if (textConversionLabel)
          textConversionLabel.textContent = traditional ? "繁" : "简";
      };
      renderTextConversionState();
      textConversionToggle.addEventListener("change", () => {
        settings.textConversion = textConversionToggle.checked ? "s2t" : "t2s";
        renderTextConversionState();
        onChange();
      });
    }
    bindRange("set-size", "v-size", "fontSize", (v) => v + "px");
    bindRange("set-note-size", "v-note-size", "noteFontSize", (v) => v + "px");
    bindRange("set-line", "v-line", "lineHeight", (v) => v.toFixed(1));
    bindRange("set-para", "v-para", "paraSpacing", (v) => v.toFixed(1) + "em");
    bindRange("set-letter", "v-letter", "letterSpacing", (v) => v + "px");
    bindRange(
      "set-turnspeed",
      "v-turnspeed",
      "pageTurnSpeed",
      (v) => v.toFixed(1) + "x",
    );
    bindNum("set-mt", "marginTop");
    bindNum("set-mb", "marginBottom");
    bindNum("set-ml", "marginLeft");
    bindNum("set-mr", "marginRight");
    const turnFx = elementById("set-turnfx");
    if (turnFx) {
      turnFx.value = settings.pageTurnEffect || DEFAULTS.pageTurnEffect;
      turnFx.addEventListener("change", () => {
        settings.pageTurnEffect = turnFx.value;
        global.ReaderAnimationSettings?.setPageTurnFromReader?.(
          turnFx.value !== "off",
        );
        onChange();
      });
    }
    const dualModeToggle = elementById("set-dual-mode");
    const scrollModeToggle = elementById("set-scroll-mode");
    const dualModeLabel = elementById("set-dual-mode-label");
    const scrollModeLabel = elementById("set-scroll-mode-label");
    function animateToggleOff(input: ReaderControlElement | null) {
      const shell = input?.closest?.(".settings-switch") as HTMLElement | null;
      if (!shell) return;
      shell.classList.remove("auto-off");
      void shell.offsetWidth; // 允许连续切换时重新触发动画
      shell.classList.add("auto-off");
    }
    function refreshReadingModeToggles() {
      normalizeModeSettings();
      if (dualModeToggle) {
        dualModeToggle.checked =
          settings.flowMode !== "scroll" && settings.pageMode === "dual";
        // auto-off 用 fill-mode 保持关闭终态；重新开启双页时才解除它。
        if (dualModeToggle.checked)
          dualModeToggle
            .closest(".settings-switch")
            ?.classList.remove("auto-off");
        dualModeToggle.title = readerSettingsT("enableTwoPages", "开启双页");
      }
      if (scrollModeToggle) {
        scrollModeToggle.checked = settings.flowMode === "scroll";
        scrollModeToggle.title = readerSettingsT(
          "enableScrollMode",
          "开启滚动模式",
        );
      }
      // 开关左侧始终描述正在生效的阅读模式，避免“开关关闭但文字仍写双页”
      // 这类把操作目标误当成当前状态的歧义。
      if (dualModeLabel)
        dualModeLabel.textContent = dualModeToggle?.checked
          ? readerSettingsT("twoPages", "双页")
          : readerSettingsT("singlePage", "单页");
      if (scrollModeLabel)
        scrollModeLabel.textContent = scrollModeToggle?.checked
          ? readerSettingsT("scrollMode", "滚动")
          : readerSettingsT("pagedMode", "整屏");
    }
    if (dualModeToggle) {
      dualModeToggle.addEventListener("change", () => {
        // 单页/双页属于分页模式；无论朝哪个方向切换都立即退出滚动模式。
        // 这样从“滚动”点回“单页”时不会只改一个不可见的 pageMode。
        settings.flowMode = "paged";
        settings.pageMode = dualModeToggle.checked ? "dual" : "single";
        refreshReadingModeToggles();
        onChange();
      });
    }
    if (scrollModeToggle) {
      scrollModeToggle.addEventListener("change", () => {
        const dualWasOn = !!dualModeToggle?.checked;
        if (scrollModeToggle.checked) {
          settings.flowMode = "scroll";
          settings.pageMode = "single";
        } else {
          settings.flowMode = "paged";
        }
        // 先占用圆点的 transform，再取消 checked。否则原生 transition 会先滑一次，
        // 随后的 keyframes 又从开启位置滑一次，看起来就像动画播放了两遍。
        if (
          READER_SHELL_IS_MAC_WEBKIT &&
          scrollModeToggle.checked &&
          dualWasOn
        ) {
          animateToggleOff(dualModeToggle);
        }
        refreshReadingModeToggles();
        onChange({ deferModeChange: true });
      });
    }
    refreshReadingModeToggles();
    global.addEventListener(
      "reader-language-changed",
      refreshReadingModeToggles,
    );
    // 朗读设置
    const bindSel = (id: string, key: keyof ReaderSettingsState) => {
      const el = elementById(id);
      if (!el) return;
      el.value = String(settings[key]);
      el.addEventListener("change", () => {
        settings[key] = el.value;
        if (key === "ttsSource") {
          ["set-ttssrc", "quick-set-ttssrc"].forEach((sourceId) => {
            const source = elementById(sourceId);
            if (source) source.value = el.value;
          });
        }
        onChange();
      });
    };
    bindSel("set-ttssrc", "ttsSource");
    bindSel("quick-set-ttssrc", "ttsSource");
    const formatTtsRate = (value: number) => {
      const twentieths = Math.round(value * 20);
      const rounded = twentieths / 20;
      return rounded.toFixed(2) + "×";
    };
    bindRange("set-ttsrate", "v-ttsrate", "ttsRate", formatTtsRate);
    bindRange("quick-set-ttsrate", "quick-v-ttsrate", "ttsRate", formatTtsRate);
    elementById("quick-tts-btn")?.addEventListener("click", () => {
      elementById("tts-btn")?.click();
    });

    // 经典模式只镜像完整阅读偏好中的低频排版项，避免两套设置状态分叉。
    const quickSettingsPanel = elementById("settings");
    const quickSettingsModeKey = "readerQuickSettingsUiMode";
    const quickMirrorSync: Array<() => void> = [];
    function connectQuickMirror(
      proxyId: string,
      sourceId: string,
      proxyOutputId?: string,
      sourceOutputId?: string,
    ) {
      const proxy = elementById(proxyId);
      const source = elementById(sourceId);
      const proxyOutput = proxyOutputId ? elementById(proxyOutputId) : null;
      const sourceOutput = sourceOutputId ? elementById(sourceOutputId) : null;
      if (!proxy || !source) return;
      const sync = () => {
        proxy.value = source.value;
        if (proxyOutput && sourceOutput)
          proxyOutput.textContent = sourceOutput.textContent;
      };
      const forward = (event: Event) => {
        source.value = proxy.value;
        source.dispatchEvent(new Event(event.type, { bubbles: true }));
        sync();
      };
      proxy.addEventListener("input", forward);
      proxy.addEventListener("change", forward);
      source.addEventListener("input", sync);
      source.addEventListener("change", sync);
      quickMirrorSync.push(sync);
      sync();
    }
    connectQuickMirror("quick-set-style-mode", "set-style-mode");
    connectQuickMirror(
      "quick-set-note-size",
      "set-note-size",
      "quick-v-note-size",
      "v-note-size",
    );
    connectQuickMirror("quick-set-para", "set-para", "quick-v-para", "v-para");
    connectQuickMirror(
      "quick-set-letter",
      "set-letter",
      "quick-v-letter",
      "v-letter",
    );
    connectQuickMirror("quick-set-turnfx", "set-turnfx");
    connectQuickMirror(
      "quick-set-turnspeed",
      "set-turnspeed",
      "quick-v-turnspeed",
      "v-turnspeed",
    );
    connectQuickMirror("quick-set-mt", "set-mt");
    connectQuickMirror("quick-set-mb", "set-mb");
    connectQuickMirror("quick-set-ml", "set-ml");
    connectQuickMirror("quick-set-mr", "set-mr");
    const syncQuickMirrors = () => quickMirrorSync.forEach((sync) => sync());
    function setQuickSettingsMode(value: unknown, persist = true) {
      const mode = value === "classic" ? "classic" : "compact";
      if (quickSettingsPanel) quickSettingsPanel.dataset.quickUiMode = mode;
      document
        .querySelectorAll<HTMLElement>("[data-quick-ui-mode-option]")
        .forEach((button) => {
          const active = button.dataset.quickUiModeOption === mode;
          button.classList.toggle("active", active);
          button.setAttribute("aria-pressed", active ? "true" : "false");
        });
      syncQuickMirrors();
      if (persist) {
        try {
          storage.setItem(quickSettingsModeKey, mode);
        } catch {}
      }
    }
    document.addEventListener("click", (event) => {
      const button =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-quick-ui-mode-option]")
          : null;
      if (button) setQuickSettingsMode(button.dataset.quickUiModeOption);
    });
    let initialQuickSettingsMode = "compact";
    try {
      initialQuickSettingsMode =
        storage.getItem(quickSettingsModeKey) || "compact";
    } catch {}
    setQuickSettingsMode(initialQuickSettingsMode, false);
    global.addEventListener("reader-settings-changed", syncQuickMirrors);

    applyReaderSettingsVisibility();
  }

  global.settings = settings;
  global.ReaderSettings = ReaderSettings;
  global.applyShellTheme = applyShellTheme;
  global.initSettingsUI = initSettingsUI;
  return Object.freeze({
    ReaderSettings,
    applyShellTheme,
    initSettingsUI,
    settings,
  });
}
