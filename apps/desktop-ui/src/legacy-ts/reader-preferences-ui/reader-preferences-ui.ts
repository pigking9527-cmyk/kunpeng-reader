import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type PreferenceRecord = Record<string, unknown>;

interface ReaderAppearance extends PreferenceRecord {
  backgroundPreset?: string;
  customPaletteId?: string;
  customBackgroundColor?: string;
  customBackgroundImage?: string;
  customBackgroundAssetId?: string;
  customBackgroundAssetSha256?: string;
  customBackgroundAssetMime?: string;
  customBackgroundAssetBytes?: number;
  textColor?: string;
  linkColor?: string;
  selectionColor?: string;
  footnoteBackground?: string;
  footnoteBorder?: string;
  theme?: string;
  toolbarOrder?: unknown;
  showTocButton?: boolean;
  showTtsButton?: boolean;
  showAnnotationButton?: boolean;
  showPageInfo?: boolean;
  readerJumpBackIconSizePx?: unknown;
  readerJumpBackPositionX?: unknown;
  readerJumpBackPositionY?: unknown;
  readerJumpBackDismissMode?: string;
  readerJumpBackDismissPages?: unknown;
  readerJumpBackDismissSeconds?: unknown;
  imagePagination?: string;
  dualPageGap?: unknown;
  epubLayoutEngine?: string;
}

interface ReaderSettingsApi {
  get(): ReaderAppearance;
  getAppearance?(scope: string): ReaderAppearance;
  update(patch: PreferenceRecord, options?: { readonly deferPageApply?: boolean }): void;
  updateAppearance?(patch: PreferenceRecord, scope: string): void;
  applyToolbarVisibility(): void;
  applyDeferredSettings?(): void;
  clearBookAppearance?(): void;
  hasBookAppearance?(): boolean;
}

interface ReaderPalette extends PreferenceRecord {
  id: string;
  name: string;
  nameKey?: string;
  background: string;
  backgroundImage?: string;
  backgroundAssetId?: string;
  backgroundAssetSha256?: string;
  backgroundAssetMime?: string;
  backgroundAssetBytes?: number;
  text: string;
  link: string;
  selection: string;
  footnote: string;
  border: string;
  theme: string;
}

interface ReaderPreferenceColorRulesApi {
  normalizedHex(value: unknown, fallback?: string): string;
  hexToHsl(value: unknown): { readonly h: number; readonly s: number; readonly l: number };
  hslToHex(hue: unknown, saturation: unknown, lightness: unknown): string;
  contrastRatio(foreground: unknown, background: unknown): number;
}

interface ReaderPreferencesRuntime extends Window {
  readonly ReaderSettings: ReaderSettingsApi;
  readonly ReaderPreferenceColorRules?: ReaderPreferenceColorRulesApi;
  readonly ReaderI18n?: { readonly t?: (key: string, values?: Readonly<Record<string, unknown>>) => string };
  readonly ReaderLayoutPreview?: { readonly source?: (dualPageGap: unknown) => string | undefined };
  readonly ReaderShell?: {
    readonly OVERLAY: { readonly PREFERENCES: unknown; readonly SETTINGS: unknown };
    readonly isOverlay?: (overlay: unknown) => boolean;
    readonly isOverlayOpen?: (overlay: unknown) => boolean;
    readonly setOverlay?: (overlay: unknown, open: boolean) => void;
    readonly closeOverlay: () => void;
  };
  readonly currentBookId?: unknown;
  ReaderPreferences?: ReaderPreferencesApi;
}

interface ReaderPreferencesApi {
  readonly open: () => void;
}

interface PaletteSyncSnapshot {
  readonly palettes?: readonly unknown[];
  readonly order?: readonly unknown[];
}

type ReaderPreferenceCommands = {
  readonly reader_palette_sync_save: {
    readonly args: { readonly request: { readonly palettes: readonly ReaderPalette[]; readonly order: unknown } };
    readonly result: unknown;
  };
  readonly reader_palette_sync_get: { readonly result: PaletteSyncSnapshot };
  readonly cache_reader_background_image: {
    readonly args: { readonly dataUrl: string };
    readonly result: { readonly assetId?: unknown; readonly sha256?: unknown; readonly mime?: unknown; readonly byteSize?: unknown; readonly url?: unknown; readonly compressed?: unknown };
  };
  readonly reader_background_local_url: {
    readonly args: { readonly assetId: string; readonly mime: string };
    readonly result: string;
  };
};
type VerifiedReaderPreferenceCommands = ReaderPreferenceCommands extends TauriCommandMap ? ReaderPreferenceCommands : never;

interface PointerPaletteDrag {
  readonly tile: HTMLElement;
  readonly placeholder: HTMLElement;
  readonly capture: HTMLElement;
  readonly pointerId: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly choose: () => void;
  moved: boolean;
}

interface ToolbarPointerDrag {
  readonly item: HTMLElement;
  readonly placeholder: HTMLElement;
  readonly capture: HTMLElement;
  readonly pointerId: number;
  readonly offsetY: number;
  readonly startY: number;
  moved: boolean;
}

interface ScrollPointerDrag {
  readonly pointerId: number;
  readonly startY: number;
  readonly startScrollTop: number;
}

type PreferenceElement = HTMLElement & HTMLInputElement & HTMLButtonElement & HTMLLabelElement;
type PalettePhase = "adjusting" | "reset" | "finished";
interface LayoutPreviewDetail extends PreferenceRecord {
  readonly type?: string;
  readonly phase?: PalettePhase;
  readonly dualPageGap?: unknown;
}

function record(value: unknown): PreferenceRecord | null {
  return typeof value === "object" && value !== null ? value as PreferenceRecord : null;
}

function runtimeFrom(value: unknown): ReaderPreferencesRuntime | null {
  const candidate = record(value);
  return candidate && candidate.document instanceof Document
    ? candidate as unknown as ReaderPreferencesRuntime
    : null;
}

function colorRulesFrom(value: unknown): ReaderPreferenceColorRulesApi | null {
  const candidate = record(value);
  return candidate &&
    typeof candidate.normalizedHex === "function" &&
    typeof candidate.hexToHsl === "function" &&
    typeof candidate.hslToHex === "function" &&
    typeof candidate.contrastRatio === "function"
    ? candidate as unknown as ReaderPreferenceColorRulesApi
    : null;
}

export function installReaderPreferencesUi(
  target: unknown,
  injectedTransport?: TauriTransport,
): ReaderPreferencesApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const global: ReaderPreferencesRuntime = runtime;
  const document = global.document as Document & {
    getElementById(elementId: string): PreferenceElement | null;
  };
  const localStorage = global.localStorage;
  const settingsApi: ReaderSettingsApi | undefined = global.ReaderSettings;
  const modal = document.getElementById("reader-preferences-modal") as HTMLElement | null;
  const openButton = document.getElementById("reader-preferences-btn") as HTMLButtonElement | null;
  if (!modal || !openButton || !settingsApi) return null;
  const modalElement: HTMLElement = modal;
  const ReaderSettings = settingsApi;
  let transport = injectedTransport;
  if (!transport) {
    try { transport = transportFromTauriGlobal(target); } catch { transport = undefined; }
  }
  const api = transport ? createTauriApi<VerifiedReaderPreferenceCommands>(transport) : null;

  const PALETTE_STORAGE_KEY = "readerCustomPalettesV1";
  const PALETTE_ORDER_KEY = "readerPaletteOrderV1";
  const MAX_CUSTOM_PALETTES = 15;
  const MAX_BACKGROUND_IMAGE_SOURCE_BYTES = 25 * 1024 * 1024;
  const MAX_INLINE_BACKGROUND_IMAGE_CHARS = 160000; // legacy migration only
  const TOOLBAR_ITEM_IDS = Object.freeze(["toc", "chapters", "tts", "annotations", "vocabulary", "settings"]);
  const colorRules = colorRulesFrom(global.ReaderPreferenceColorRules);
  // 语言文件比偏好页晚更新或被旧缓存复用时，ReaderI18n 会回显键名。
  // 偏好页不能把内部键名当作可见文案，因此此处稳定退回到内置文案。
  const readerPreferenceT = (key: string, fallback: string, values?: Readonly<Record<string, unknown>>): string => {
    const translated = global.ReaderI18n?.t?.(key, values);
    return translated && translated !== key ? translated : fallback;
  };
  const preferencesContent = modalElement.querySelector<HTMLElement>(".reader-preferences-content");
  const preferencesCard = modalElement.querySelector<HTMLElement>(".reader-preferences-card");
  const preferencesNavToggle = modalElement.querySelector<HTMLButtonElement>("#reader-preferences-nav-toggle");
  const PREFERENCE_NAV_COLLAPSED_KEY = "readerPreferencesNavCollapsed";
  let preferenceNavCollapsed = false;
  try { preferenceNavCollapsed = localStorage.getItem(PREFERENCE_NAV_COLLAPSED_KEY) === "1"; } catch {}

  const preferencesScrollbar = modalElement.querySelector<HTMLElement>("#reader-preferences-scrollbar");
  const preferencesScrollThumb = modalElement.querySelector<HTMLElement>("#reader-preferences-scroll-thumb");
  let paletteSyncTimer = 0;
  let paletteSyncReady = false;
  const builtinPalettes: ReaderPalette[] = [
    { id: "light", name: "浅色", nameKey: "paletteLight", background: "#ffffff", text: "#222222", link: "#2f6fad", selection: "#dceafa", footnote: "#f3f6fa", border: "#b7c7da", theme: "light" },
    { id: "dark", name: "深色", nameKey: "paletteDark", background: "#1c1c1e", text: "#d2d2d2", link: "#9abfe8", selection: "#3a4f6b", footnote: "#252f3a", border: "#647a94", theme: "dark" },
    { id: "paper", name: "羊皮纸", nameKey: "palettePaper", background: "#f8f1df", text: "#443a2d", link: "#875b37", selection: "#e7dab8", footnote: "#f3ebdd", border: "#b79d76", theme: "light" },
  ];
  const colorMap = { customBackgroundColor: "background", textColor: "text", linkColor: "link", selectionColor: "selection", footnoteBackground: "footnote", footnoteBorder: "border" };
  let scope = "default";
  let pointerDrag: PointerPaletteDrag | null = null;
  let suppressPaletteClickUntil = 0;
  let autoPreviewThemeId = "";
  let preferencesOutsidePointerDown = false;
  let activeColorControl: HTMLElement | null = null;
  let colorSpectrumPointer: number | null = null;
  let preferencesScrollDrag: ScrollPointerDrag | null = null;
  let jumpBackPreviewDrag: number | null = null;
  let toolbarPointerDrag: ToolbarPointerDrag | null = null;

  function applyPreferenceNavState() {
    preferencesCard?.classList.toggle("nav-collapsed", preferenceNavCollapsed);
    if (!preferencesNavToggle) return;
    const expanded = !preferenceNavCollapsed;
    const label = readerPreferenceT(expanded ? "collapsePreferenceNavigation" : "expandPreferenceNavigation", expanded ? "收起分类" : "展开分类");
    preferencesNavToggle.setAttribute("aria-expanded", String(expanded));
    preferencesNavToggle.setAttribute("aria-label", label);
    preferencesNavToggle.title = label;
    preferencesNavToggle.classList.toggle("is-expanded", expanded);
    requestAnimationFrame(updatePreferencesScrollbar);
  }

  function jumpBackIconPixels(iconSizePx: unknown): number {
    const size = Number(iconSizePx);
    return Math.max(30, Math.min(160, Math.round(Number.isFinite(size) ? size : 32)));
  }

  function dualPageGapPixels(value: unknown): number {
    const gap = Number(value);
    return Math.max(0, Math.min(120, Math.round(Number.isFinite(gap) ? gap : 40)));
  }

  function normalizedHex(value: unknown, fallback = "#222222"): string {
    if (colorRules) return colorRules.normalizedHex(value, fallback);
    const raw = String(value || "").trim();
    const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw);
    if (!match) return fallback;
    const color = match[1]?.toLowerCase() ?? "";
    return `#${color.length === 3 ? color.split("").map((part) => part + part).join("") : color}`;
  }

  function hexToHsl(value: unknown): { h: number; s: number; l: number } {
    if (colorRules) return colorRules.hexToHsl(value);
    const hex = normalizedHex(value).slice(1);
    const red = parseInt(hex.slice(0, 2), 16) / 255;
    const green = parseInt(hex.slice(2, 4), 16) / 255;
    const blue = parseInt(hex.slice(4, 6), 16) / 255;
    const max = Math.max(red, green, blue), min = Math.min(red, green, blue);
    const lightness = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: Math.round(lightness * 100) };
    const delta = max - min;
    const saturation = delta / (1 - Math.abs(2 * lightness - 1));
    let hue = max === red ? ((green - blue) / delta) % 6 : max === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
    hue = Math.round((hue * 60 + 360) % 360);
    return { h: hue, s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
  }

  function hslToHex(hue: unknown, saturation: unknown, lightness: unknown): string {
    if (colorRules) return colorRules.hslToHex(hue, saturation, lightness);
    const h = ((Number(hue) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(100, Number(saturation) || 0)) / 100;
    const l = Math.max(0, Math.min(100, Number(lightness) || 0)) / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const x = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - chroma / 2;
    const [red, green, blue] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
    const channel = (value: number): string => Math.round((value + m) * 255).toString(16).padStart(2, "0");
    return `#${channel(red)}${channel(green)}${channel(blue)}`;
  }

  function contrastRatio(foreground: unknown, background: unknown): number {
    if (colorRules) return colorRules.contrastRatio(foreground, background);
    const luminance = (value: unknown): number => {
      const hex = normalizedHex(value).slice(1);
      const channel = (offset: number): number => {
        const encoded = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return encoded <= 0.04045
          ? encoded / 12.92
          : ((encoded + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    };
    const foregroundLuminance = luminance(foreground);
    const backgroundLuminance = luminance(background);
    const lighter = Math.max(foregroundLuminance, backgroundLuminance);
    const darker = Math.min(foregroundLuminance, backgroundLuminance);
    return (lighter + 0.05) / (darker + 0.05);
  }

  const DEFAULT_DUAL_PAGE_GAP = 40;
  const READER_LAYOUT_PREVIEW_REVEAL_DELAY = 160;
  const READER_LAYOUT_PREVIEW_RESET_DURATION = 1000;
  let readerLayoutPreviewTimer = 0;
  let readerLayoutPreviewRevealTimer = 0;
  let readerLayoutPreview: HTMLDivElement | null = null;
  let readerLayoutPreviewFrame: HTMLIFrameElement | null = null;

  function ensureReaderLayoutPreview() {
    if (readerLayoutPreview) return readerLayoutPreview;
    const preview = document.createElement("div");
    preview.className = "reader-preferences-layout-preview";
    preview.hidden = true;
    preview.setAttribute("aria-hidden", "true");
    preview.dataset.overlaySurface = "reader-layout-preview";
    preview.dataset.overlayRole = "feedback";
    const previewFrame = document.createElement("iframe");
    previewFrame.className = "reader-preferences-layout-preview-frame";
    previewFrame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    previewFrame.setAttribute("referrerpolicy", "no-referrer");
    previewFrame.tabIndex = -1;
    preview.append(previewFrame);
    document.body.append(preview);
    readerLayoutPreview = preview;
    readerLayoutPreviewFrame = previewFrame;
    return preview;
  }

  function previewReaderSettings(dualPageGap: unknown): ReaderAppearance {
    return Object.assign({}, ReaderSettings.get(), {
      flowMode: "paged",
      pageMode: "dual",
      dualPageGap: dualPageGapPixels(dualPageGap),
    });
  }

  function updateReaderLayoutPreviewFrame(dualPageGap: unknown): void {
    if (!readerLayoutPreviewFrame?.contentWindow) return;
    readerLayoutPreviewFrame.contentWindow.postMessage({ settings: previewReaderSettings(dualPageGap) }, "*");
  }

  function readerLayoutPreviewSourceKey(source: string): string {
    try {
      const url = new URL(source, global.location?.href);
      url.searchParams.delete("s");
      return url.href;
    } catch {
      return String(source || "");
    }
  }

  function loadReaderLayoutPreviewFrame(dualPageGap: unknown, source = global.ReaderLayoutPreview?.source?.(dualPageGap)): boolean {
    if (!source || !readerLayoutPreviewFrame) return false;
    global.clearTimeout(readerLayoutPreviewRevealTimer);
    readerLayoutPreviewRevealTimer = 0;
    const preview = readerLayoutPreview ?? ensureReaderLayoutPreview();
    preview.classList.remove("is-ready");
    preview.dataset.source = source;
    preview.dataset.sourceKey = readerLayoutPreviewSourceKey(source);
    readerLayoutPreviewFrame.src = source;
    return true;
  }

  function preloadReaderLayoutPreview(dualPageGap: unknown): boolean {
    const preview = ensureReaderLayoutPreview();
    const source = global.ReaderLayoutPreview?.source?.(dualPageGap);
    if (!source) return false;
    if (preview.dataset.source && preview.dataset.sourceKey === readerLayoutPreviewSourceKey(source)) return true;
    preview.hidden = true;
    return loadReaderLayoutPreviewFrame(dualPageGap, source);
  }
  void preloadReaderLayoutPreview;

  function clearReaderLayoutPreview() {
    global.clearTimeout(readerLayoutPreviewTimer);
    readerLayoutPreviewTimer = 0;
    if (!readerLayoutPreview) return;
    readerLayoutPreview.hidden = true;
    delete readerLayoutPreview.dataset.overlayActive;
    delete readerLayoutPreview.dataset.dismissWhenReady;
    const preview = readerLayoutPreview;
    ["left", "top", "width", "height"].forEach((part) => preview.style.removeProperty(`--reader-preference-preview-cutout-${part}`));
  }

  function scheduleReaderLayoutPreviewClear(delay: number): void {
    global.clearTimeout(readerLayoutPreviewTimer);
    readerLayoutPreviewTimer = global.setTimeout(clearReaderLayoutPreview, delay);
  }

  function revealReaderLayoutPreviewAfterPaint() {
    global.clearTimeout(readerLayoutPreviewRevealTimer);
    const preview = readerLayoutPreview;
    const source = preview?.dataset.source;
    if (!preview || !source) return;
    // reader:// signals ready before its first composited frame. Keep the
    // genuine reader hidden briefly so its initial blank canvas never flashes.
    readerLayoutPreviewRevealTimer = global.setTimeout(() => {
      if (!readerLayoutPreview || readerLayoutPreview.dataset.source !== source) return;
      readerLayoutPreview.classList.add("is-ready");
      const gap = dualPageGapPixels((document.getElementById("pref-dual-page-gap") as HTMLInputElement | null)?.value);
      updateReaderLayoutPreviewFrame(gap);
      if (readerLayoutPreview.dataset.dismissWhenReady === "true") {
        delete readerLayoutPreview.dataset.dismissWhenReady;
        scheduleReaderLayoutPreviewClear(READER_LAYOUT_PREVIEW_RESET_DURATION);
      }
    }, READER_LAYOUT_PREVIEW_REVEAL_DELAY);
  }

  function renderReaderLayoutPreview({ phase, dualPageGap }: { readonly phase: PalettePhase; readonly dualPageGap: unknown }): void {
    if (phase === "finished") {
      clearReaderLayoutPreview();
      return;
    }
    global.clearTimeout(readerLayoutPreviewTimer);
    readerLayoutPreviewTimer = 0;
    const preview = ensureReaderLayoutPreview();
    delete preview.dataset.dismissWhenReady;
    const sliderRect = document.getElementById("pref-dual-page-gap")?.getBoundingClientRect?.();
    if (sliderRect) {
      const insetX = 6;
      const insetY = 5;
      const viewportWidth = global.innerWidth || document.documentElement.clientWidth;
      const viewportHeight = global.innerHeight || document.documentElement.clientHeight;
      preview.style.setProperty("--reader-preference-preview-cutout-left", `${Math.max(0, sliderRect.left - insetX)}px`);
      preview.style.setProperty("--reader-preference-preview-cutout-top", `${Math.max(0, sliderRect.top - insetY)}px`);
      preview.style.setProperty("--reader-preference-preview-cutout-width", `${Math.min(viewportWidth, sliderRect.width + insetX * 2)}px`);
      preview.style.setProperty("--reader-preference-preview-cutout-height", `${Math.min(viewportHeight, sliderRect.height + insetY * 2)}px`);
    }
    if (!preview.dataset.source && !loadReaderLayoutPreviewFrame(dualPageGap)) return;
    updateReaderLayoutPreviewFrame(dualPageGap);
    preview.hidden = false;
    preview.dataset.overlayActive = "true";
    if (phase === "reset") {
      if (preview.classList.contains("is-ready")) scheduleReaderLayoutPreviewClear(READER_LAYOUT_PREVIEW_RESET_DURATION);
      else preview.dataset.dismissWhenReady = "true";
    }
  }

  function previewReaderLayout(detail: LayoutPreviewDetail): void {
    if (detail?.type !== "dual-page-gap") return;
    renderReaderLayoutPreview({
      phase: detail.phase || "finished",
      dualPageGap: detail.dualPageGap,
    });
  }

  function applyDeferredReaderSettingsAfterPreviewPaint() {
    // Let the preview visibility change reach the compositor before the real
    // reader starts its comparatively expensive pagination pass.
    global.requestAnimationFrame(() => {
      global.requestAnimationFrame(() => ReaderSettings.applyDeferredSettings?.());
    });
  }

  global.addEventListener("message", (event) => {
    if (!readerLayoutPreviewFrame || event.source !== readerLayoutPreviewFrame.contentWindow || !event.data?.ready) return;
    revealReaderLayoutPreviewAfterPaint();
  });

  function jumpBackIconHeight(iconSizePx: unknown): number {
    return Math.max(12, Math.round(jumpBackIconPixels(iconSizePx) * 0.4));
  }

  function jumpBackPosition(value: unknown, fallback: number): number {
    const number = Number(value);
    return Math.max(0, Math.min(1000, Math.round(Number.isFinite(number) ? number : fallback)));
  }

  // Position is defined by the visible icon, not by the larger transparent
  // hit target. This lets the arrow itself reach all four preview edges.
  function jumpBackPreviewTrackPoint(length: number, iconSize: number, hitSize: number, position: unknown): number {
    const visualTrack = Math.max(0, length - iconSize);
    const hitTargetInset = Math.max(0, hitSize - iconSize) / 2;
    return visualTrack * jumpBackPosition(position, 0) / 1000 - hitTargetInset;
  }

  function jumpBackPreviewPositionFromPoint(point: number, length: number, iconSize: number): number {
    const track = Math.max(0, length - iconSize);
    return track ? Math.round(point / track * 1000) : 500;
  }

  function renderJumpBackPreview(settings: ReaderAppearance): void {
    const preview = document.getElementById("pref-reader-jump-back-preview");
    const icon = document.getElementById("pref-reader-jump-back-preview-icon");
    if (!preview || !icon) return;
    const size = jumpBackIconPixels(settings.readerJumpBackIconSizePx);
    const height = jumpBackIconHeight(size);
    const hitSize = Math.max(44, size + 12);
    const x = jumpBackPosition(settings.readerJumpBackPositionX, 950);
    const y = jumpBackPosition(settings.readerJumpBackPositionY, 500);
    icon.style.setProperty("--preview-jump-back-icon-size", `${size}px`);
    icon.style.setProperty("--preview-jump-back-icon-height", `${height}px`);
    icon.style.setProperty("--preview-jump-back-hit-size", `${hitSize}px`);
    const bounds = preview.getBoundingClientRect();
    const left = jumpBackPreviewTrackPoint(bounds.width, size, hitSize, x);
    const top = jumpBackPreviewTrackPoint(bounds.height, height, hitSize, y);
    icon.style.left = `${left}px`;
    icon.style.top = `${top}px`;
  }

  function updateJumpBackPreviewPosition(event: PointerEvent): void {
    const preview = document.getElementById("pref-reader-jump-back-preview");
    const icon = document.getElementById("pref-reader-jump-back-preview-icon");
    if (!preview || !icon) return;
    const bounds = preview.getBoundingClientRect();
    const iconSize = jumpBackIconPixels(ReaderSettings.get().readerJumpBackIconSizePx);
    const iconHeight = jumpBackIconHeight(iconSize);
    const left = Math.max(0, Math.min(Math.max(0, bounds.width - iconSize), event.clientX - bounds.left - iconSize / 2));
    const top = Math.max(0, Math.min(Math.max(0, bounds.height - iconHeight), event.clientY - bounds.top - iconHeight / 2));
    ReaderSettings.update({
      readerJumpBackPositionX: jumpBackPreviewPositionFromPoint(left, bounds.width, iconSize),
      readerJumpBackPositionY: jumpBackPreviewPositionFromPoint(top, bounds.height, iconHeight),
    });
  }

  function localAssetUrl(palette: Partial<ReaderPalette> | null | undefined): string {
    const id = String(palette?.backgroundAssetId || "").toLowerCase();
    const mime = String(palette?.backgroundAssetMime || "");
    const ext: string | undefined = ({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" } as Readonly<Record<string, string>>)[mime];
    return /^[0-9a-f]{64}$/.test(id) && ext ? `http://reader.localhost/background/${id}.${ext}` : "";
  }

  function safePaletteImage(value: unknown): string {
    const image = String(value || "");
    if (/^(?:reader:\/\/localhost|http:\/\/reader\.localhost)\/background\/[0-9a-f]{64}\.(?:png|jpg|webp|gif)$/i.test(image)) return image;
    // Old palette payloads are only used as a bounded migration fallback.
    return image.length <= MAX_INLINE_BACKGROUND_IMAGE_CHARS && /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(image) ? image : "";
  }

  function sanitizePalette(palette: unknown): ReaderPalette {
    const source = record(palette) ?? {};
    const id = typeof source.id === "string" ? source.id : "";
    const name = typeof source.name === "string" ? source.name : "";
    const image = localAssetUrl(source as Partial<ReaderPalette>) || safePaletteImage(source.backgroundImage);
    // Themes created before the complete reading-color preview only retained
    // their background reliably. Fill every visual channel on load so an old
    // saved theme is upgraded before it is rendered or synced again.
    const defaults: ReaderPalette = {
      id,
      name,
      background: "#fffdf8",
      text: "#222222",
      link: "#2f6fad",
      selection: "#dceafa",
      footnote: "#f3f6fa",
      border: "#b7c7da",
      theme: "light",
    };
    const completed: ReaderPalette = Object.assign({}, defaults, source, { id, name, backgroundImage: image });
    (["background", "text", "link", "selection", "footnote", "border", "theme"] as const).forEach((key) => {
      if (typeof completed[key] !== "string" || !completed[key].trim()) completed[key] = defaults[key];
    });
    return completed;
  }

  function loadCustomPalettes(): ReaderPalette[] {
    try {
      const stored = JSON.parse(localStorage.getItem(PALETTE_STORAGE_KEY) || "[]");
      return Array.isArray(stored) ? stored.filter((item) => item && typeof item.id === "string" && typeof item.name === "string").slice(0, MAX_CUSTOM_PALETTES).map(sanitizePalette) : [];
    } catch { return []; }
  }

  function saveCustomPalettes(palettes: readonly ReaderPalette[]): void {
    const limited = palettes.slice(0, MAX_CUSTOM_PALETTES).map(sanitizePalette);
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(limited));
    queuePaletteSync(limited);
  }

  function queuePaletteSync(palettes = loadCustomPalettes()): void {
    if (!paletteSyncReady || !api) return;
    // The local reader URL is a display/cache detail, never sync payload data.
    // Only the content-addressed asset reference crosses the sync boundary.
    const syncPalettes = palettes.map((palette) => {
      const localUrl = localAssetUrl(palette);
      return localUrl || /^(?:reader:\/\/localhost|http:\/\/reader\.localhost)\/background\//i.test(String(palette?.backgroundImage || ""))
        ? Object.assign({}, palette, { backgroundImage: "" })
        : palette;
    });
    global.clearTimeout(paletteSyncTimer);
    paletteSyncTimer = global.setTimeout(() => {
      void api.invoke("reader_palette_sync_save", { request: { palettes: syncPalettes, order: JSON.parse(localStorage.getItem(PALETTE_ORDER_KEY) || "[]") as unknown } }).catch(() => {});
    }, 180);
  }

  function isBuiltinPalette(palette: ReaderPalette): boolean { return builtinPalettes.some((item) => item.id === palette.id); }

  function paletteLabel(palette: ReaderPalette | null | undefined): string {
    return palette?.nameKey ? readerPreferenceT(palette.nameKey, palette.name) : String(palette?.name || "");
  }

  function paletteDeleteTone(palette: ReaderPalette): string {
    const color = String(palette.background || "#ffffff").replace("#", "");
    const value = color.length === 3 ? color.split("").map((part) => part + part).join("") : color;
    if (!/^[0-9a-f]{6}$/i.test(value)) return "on-light";
    const red = parseInt(value.slice(0, 2), 16), green = parseInt(value.slice(2, 4), 16), blue = parseInt(value.slice(4, 6), 16);
    return red * 0.299 + green * 0.587 + blue * 0.114 > 154 ? "on-light" : "on-dark";
  }



  function applyPalettePreview(element: HTMLElement, palette: ReaderPalette): void {
    const image = String(palette.backgroundImage || "");
    const safeImage = safePaletteImage(image);
    element.classList.toggle("has-background-image", Boolean(safeImage));
    element.style.backgroundImage = safeImage ? `url("${safeImage}")` : "";
  }

  function appendPaletteReadingPreview(tile: HTMLElement): void {
    const preview = document.createElement("span");
    preview.className = "reader-palette-reading-preview";
    preview.setAttribute("aria-hidden", "true");

    const copy = document.createElement("span");
    copy.className = "reader-palette-preview-copy";
    copy.append("春风又绿江南岸，");
    const selection = document.createElement("mark");
    selection.className = "reader-palette-preview-selection";
    selection.textContent = "明月";
    copy.append(selection);
    const link = document.createElement("span");
    link.className = "reader-palette-preview-link";
    link.textContent = "何时";
    copy.append(link, "照我还。");

    const footnote = document.createElement("span");
    footnote.className = "reader-palette-preview-footnote";
    footnote.textContent = "注";
    preview.append(copy, footnote);
    tile.append(preview);
  }

  function updateCustomPalette(id: string, patch: Partial<ReaderPalette>): void {
    const palettes = loadCustomPalettes().map((palette) => palette.id === id ? Object.assign({}, palette, patch) : palette);
    saveCustomPalettes(palettes);
  }

  function removeCustomPalette(id: string): void {
    const active = paletteForSettings(read());
    saveCustomPalettes(loadCustomPalettes().filter((palette) => palette.id !== id));
    if (active?.id === id) updateAppearance(palettePatch(paletteList()[0] ?? builtinPalettes[0]!));
    else render();
  }

  function beginPaletteNameEdit(label: HTMLElement, palette: ReaderPalette): void {
    const input = document.createElement("input");
    input.className = "reader-palette-name-input";
    input.value = paletteLabel(palette);
    input.maxLength = 24;
    input.setAttribute("aria-label", readerPreferenceT("paletteName", "主题名称"));
    label.replaceWith(input);
    input.focus(); input.select();
    let finished = false;
    const finish = (save: boolean): void => {
      if (finished) return;
      finished = true;
      const name = input.value.trim().slice(0, 24);
      if (save && name) updateCustomPalette(palette.id, { name });
      render();
    };
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); finish(true); }
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
  }
  function paletteList(): ReaderPalette[] {
    const palettes = [...builtinPalettes, ...loadCustomPalettes()];
    let order: unknown[] = [];
    try { order = JSON.parse(localStorage.getItem(PALETTE_ORDER_KEY) || "[]"); } catch {}
    const known = new Map(palettes.map((palette) => [palette.id, palette]));
    const ordered: ReaderPalette[] = (Array.isArray(order) ? order : [])
      .map((id) => known.get(String(id)))
      .filter((palette): palette is ReaderPalette => Boolean(palette));
    palettes.forEach((palette) => { if (!ordered.some((item) => item.id === palette.id)) ordered.push(palette); });
    return ordered;
  }

  function read(): ReaderAppearance { return ReaderSettings.getAppearance?.(scope) || ReaderSettings.get(); }

  function paletteForSettings(settings: ReaderAppearance): ReaderPalette | null {
    const selected = String(settings.customPaletteId || "");
    if (selected) return paletteList().find((palette) => palette.id === selected) || null;
    return paletteList().find((palette) => palette.id === settings.backgroundPreset) || null;
  }

  function applyToolbar(settings: ReaderAppearance): void {
    const visible = (id: string, value: boolean | undefined): void => { document.getElementById(id)?.toggleAttribute("hidden", value === false); };
    ReaderSettings.applyToolbarVisibility();
    visible("toc-btn", settings.showTocButton);
    visible("tts-btn", settings.showTtsButton);
    visible("hl-btn", settings.showAnnotationButton);
    document.getElementById("reader-progress-group")?.toggleAttribute("hidden", settings.showPageInfo === false);
  }

  function normalizedToolbarOrder(value: unknown): string[] {
    const source = Array.isArray(value) ? value : [];
    const known = new Set<string>(TOOLBAR_ITEM_IDS);
    const seen = new Set<string>();
    const order: string[] = [];
    source.forEach((value) => {
      const id = String(value);
      if (known.has(id) && !seen.has(id)) { seen.add(id); order.push(id); }
    });
    TOOLBAR_ITEM_IDS.forEach((id) => { if (!seen.has(id)) order.push(id); });
    return order;
  }

  function toolbarOrderFromList(list: HTMLElement): string[] {
    return [...list.querySelectorAll<HTMLElement>(":scope > [data-toolbar-item]")].map((item) => item.dataset.toolbarItem || "");
  }

  function renderToolbarOrder(settings: ReaderAppearance): void {
    const list = document.getElementById("reader-toolbar-order-list");
    if (!list || toolbarPointerDrag) return;
    const items = new Map([...list.querySelectorAll<HTMLElement>("[data-toolbar-item]")].map((item) => [item.dataset.toolbarItem, item]));
    const order = normalizedToolbarOrder(settings.toolbarOrder);
    order.forEach((id, index) => {
      const item = items.get(id);
      if (!item) return;
      item.setAttribute("aria-posinset", String(index + 1));
      item.setAttribute("aria-setsize", String(order.length));
      const handle = item.querySelector(".reader-toolbar-drag-handle");
      const name = item.querySelector("strong")?.textContent?.trim() || id;
      if (handle) handle.setAttribute("aria-label", `${name}，按住并上下拖动调整顺序`);
      list.append(item);
    });
    const required = list.querySelector<HTMLInputElement>("[data-toolbar-required]");
    if (required) { required.checked = true; required.disabled = true; }
  }

  function animateToolbarPlaceholder(state: ToolbarPointerDrag, beforeNode: Element | null): void {
    const list = state.placeholder.parentElement;
    if (!list || beforeNode === state.placeholder) return;
    if (beforeNode === state.item) beforeNode = state.item.nextElementSibling;
    const before = new Map<Element, DOMRect>();
    [...list.children].forEach((item) => {
      if (item !== state.item && item !== state.placeholder) before.set(item, item.getBoundingClientRect());
    });
    list.insertBefore(state.placeholder, beforeNode || null);
    [...list.children].forEach((item) => {
      if (item === state.item || item === state.placeholder) return;
      const first = before.get(item);
      if (!first) return;
      const last = item.getBoundingClientRect();
      const dy = first.top - last.top;
      if (!dy) return;
      const htmlItem = item as HTMLElement;
      htmlItem.style.transition = "none";
      htmlItem.style.transform = `translateY(${dy}px)`;
      item.getBoundingClientRect();
      requestAnimationFrame(() => {
        htmlItem.style.transition = "transform .2s cubic-bezier(.2,.8,.2,1), border-color .16s ease, box-shadow .16s ease, background .16s ease";
        htmlItem.style.transform = "";
      });
    });
  }

  function moveToolbarDrag(event: PointerEvent): void {
    const state = toolbarPointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const list = state.placeholder.parentElement;
    const bounds = list?.getBoundingClientRect();
    const maxTop = bounds ? Math.max(bounds.top, bounds.bottom - state.item.offsetHeight) : event.clientY;
    const top = bounds ? Math.max(bounds.top, Math.min(maxTop, event.clientY - state.offsetY)) : event.clientY - state.offsetY;
    const probeY = bounds ? Math.max(bounds.top, Math.min(bounds.bottom, event.clientY)) : event.clientY;
    state.item.style.top = `${top}px`;
    if (Math.abs(probeY - state.startY) > 4) state.moved = true;
    const target = document.elementFromPoint(event.clientX, probeY)?.closest<HTMLElement>("[data-toolbar-item]");
    if (target && target !== state.item && target.parentElement === list) {
      const box = target.getBoundingClientRect();
      animateToolbarPlaceholder(state, probeY < box.top + box.height / 2 ? target : target.nextElementSibling);
    } else {
      if (bounds && probeY > bounds.bottom - 4) animateToolbarPlaceholder(state, null);
    }
    const viewport = preferencesContent?.getBoundingClientRect();
    if (viewport && preferencesContent && event.clientY < viewport.top + 28) preferencesContent.scrollTop -= 12;
    else if (viewport && preferencesContent && event.clientY > viewport.bottom - 28) preferencesContent.scrollTop += 12;
  }

  function finishToolbarDrag(event: PointerEvent): void {
    const state = toolbarPointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    toolbarPointerDrag = null;
    try { state.capture.releasePointerCapture(event.pointerId); } catch {}
    state.placeholder.parentElement?.insertBefore(state.item, state.placeholder);
    state.placeholder.remove();
    state.item.classList.remove("dragging");
    state.item.removeAttribute("aria-grabbed");
    state.item.style.position = "";
    state.item.style.left = "";
    state.item.style.top = "";
    state.item.style.width = "";
    state.item.style.height = "";
    const list = document.getElementById("reader-toolbar-order-list");
    if (list) ReaderSettings.update({ toolbarOrder: toolbarOrderFromList(list) });
  }

  function beginToolbarDrag(event: PointerEvent, item: HTMLElement, handle: HTMLElement): void {
    if (event.button !== 0 || toolbarPointerDrag) return;
    event.preventDefault();
    const box = item.getBoundingClientRect();
    const placeholder = document.createElement("div");
    placeholder.className = "reader-toolbar-order-placeholder";
    placeholder.style.height = `${box.height}px`;
    item.parentElement?.insertBefore(placeholder, item.nextSibling);
    item.classList.add("dragging");
    item.setAttribute("aria-grabbed", "true");
    item.style.position = "fixed";
    item.style.left = `${box.left}px`;
    item.style.top = `${box.top}px`;
    item.style.width = `${box.width}px`;
    item.style.height = `${box.height}px`;
    toolbarPointerDrag = { item, placeholder, capture: handle, pointerId: event.pointerId, offsetY: event.clientY - box.top, startY: event.clientY, moved: false };
    try { handle.setPointerCapture(event.pointerId); } catch {}
  }

  function moveToolbarItemByKeyboard(item: HTMLElement, direction: number): void {
    const list = item.parentElement;
    const sibling = direction < 0 ? item.previousElementSibling : item.nextElementSibling;
    if (!list || !sibling) return;
    if (direction < 0) list.insertBefore(item, sibling);
    else list.insertBefore(sibling, item);
    ReaderSettings.update({ toolbarOrder: toolbarOrderFromList(list) });
    item.querySelector<HTMLElement>(".reader-toolbar-drag-handle")?.focus();
  }

  function palettePatch(palette: ReaderPalette): PreferenceRecord {
    if (builtinPalettes.some((item) => item.id === palette.id)) {
      return { backgroundPreset: palette.id, customPaletteId: "", customBackgroundImage: "", customBackgroundAssetId: "", customBackgroundAssetSha256: "", customBackgroundAssetMime: "", customBackgroundAssetBytes: 0, theme: palette.theme, textColor: "", linkColor: "", selectionColor: "", footnoteBackground: "", footnoteBorder: "" };
    }
    return { backgroundPreset: "custom", customPaletteId: palette.id, customBackgroundColor: palette.background, customBackgroundImage: safePaletteImage(palette.backgroundImage), customBackgroundAssetId: palette.backgroundAssetId || "", customBackgroundAssetSha256: palette.backgroundAssetSha256 || "", customBackgroundAssetMime: palette.backgroundAssetMime || "", customBackgroundAssetBytes: palette.backgroundAssetBytes || 0, textColor: palette.text, linkColor: palette.link, selectionColor: palette.selection, footnoteBackground: palette.footnote, footnoteBorder: palette.border, theme: palette.theme || "light" };
  }

  function updateAppearance(patch: PreferenceRecord, targetScope = scope): void {
    if (typeof ReaderSettings.updateAppearance === "function") ReaderSettings.updateAppearance(patch, targetScope);
    else ReaderSettings.update(patch);
    render();
  }

  // 快捷配色没有“总体 / 独立”的范围选择。若当前书已经保存了独立外观，
  // 继续写入总体设置不会影响它，用户会看到按钮已点却没有变化。此时把快捷
  // 操作写到当前书；没有独立外观时仍保持原来的总体设置行为。
  function quickPaletteScope() {
    return global.currentBookId && ReaderSettings.hasBookAppearance?.() ? "book" : "default";
  }

  function applyQuickPalette(palette: ReaderPalette): void {
    updateAppearance(palettePatch(palette), quickPaletteScope());
  }


  // Import stays outside the reader document.  It may use FileReader once to
  // hand bytes to the native cache, but no Base64 is persisted or rendered.


  function animatePaletteInsert(state: PointerPaletteDrag, beforeNode: Element | null): void {
    const grid = state.tile.parentElement;
    if (!grid) return;
    if (!beforeNode && state.placeholder === grid.lastElementChild) return;
    if (beforeNode === state.placeholder) return;
    const before = new Map<Element, DOMRect>();
    [...grid.children].forEach((tile) => { if (tile !== state.tile && tile !== state.placeholder) before.set(tile, tile.getBoundingClientRect()); });
    grid.insertBefore(state.placeholder, beforeNode || null);
    [...grid.children].forEach((tile) => {
      if (tile === state.tile || tile === state.placeholder) return;
      const first = before.get(tile);
      if (!first) return;
      const last = tile.getBoundingClientRect();
      const dx = first.left - last.left;
      const dy = first.top - last.top;
      if (!dx && !dy) return;
      const htmlTile = tile as HTMLElement;
      htmlTile.style.transition = "none";
      htmlTile.style.transform = `translate(${dx}px, ${dy}px)`;
      tile.getBoundingClientRect();
      requestAnimationFrame(() => {
        htmlTile.style.transition = "transform .18s cubic-bezier(.2,.8,.2,1), background .16s ease, border-color .16s ease, box-shadow .16s ease";
        htmlTile.style.transform = "";
      });
    });
  }

  function movePaletteDrag(clientX: number, clientY: number): void {
    const state = pointerDrag;
    if (!state) return;
    const grid = state.placeholder.parentElement;
    const bounds = grid?.getBoundingClientRect();
    const maxLeft = bounds ? Math.max(bounds.left, bounds.right - state.tile.offsetWidth) : clientX;
    const maxTop = bounds ? Math.max(bounds.top, bounds.bottom - state.tile.offsetHeight) : clientY;
    const left = bounds ? Math.max(bounds.left, Math.min(maxLeft, clientX - state.offsetX)) : clientX - state.offsetX;
    const top = bounds ? Math.max(bounds.top, Math.min(maxTop, clientY - state.offsetY)) : clientY - state.offsetY;
    const probeX = bounds ? Math.max(bounds.left, Math.min(bounds.right, clientX)) : clientX;
    const probeY = bounds ? Math.max(bounds.top, Math.min(bounds.bottom, clientY)) : clientY;
    state.tile.style.left = `${left}px`;
    state.tile.style.top = `${top}px`;
    const target = document.elementFromPoint(probeX, probeY)?.closest<HTMLElement>("[data-palette-id]");
    if (target && target !== state.tile) {
      const box = target.getBoundingClientRect();
      const before = probeY < box.top + box.height / 2 || (probeY <= box.bottom && probeX < box.left + box.width / 2) ? target : target.nextElementSibling;
      animatePaletteInsert(state, before === state.tile ? state.tile.nextElementSibling : before);
      state.moved = true;
      return;
    }
    if (bounds && probeY > bounds.bottom - 4) {
      animatePaletteInsert(state, null);
      state.moved = true;
    }
  }

  function finishPointerDrag(event: PointerEvent): void {
    const state = pointerDrag;
    if (!state || state.pointerId !== event.pointerId) return;
    event.preventDefault();
    const choosePalette = !state.moved ? state.choose : null;
    suppressPaletteClickUntil = performance.now() + 250;
    pointerDrag = null;
    try { state.capture.releasePointerCapture(event.pointerId); } catch {}
    state.tile.classList.remove("dragging");
    state.placeholder.parentElement?.insertBefore(state.tile, state.placeholder);
    state.placeholder.remove();
    state.tile.style.position = "";
    state.tile.style.left = "";
    state.tile.style.top = "";
    state.tile.style.width = "";
    state.tile.style.height = "";
    const tileParent = state.tile.parentElement;
    localStorage.setItem(PALETTE_ORDER_KEY, JSON.stringify(tileParent ? [...tileParent.querySelectorAll<HTMLElement>("[data-palette-id]")].map((tile) => tile.dataset.paletteId) : []));
    queuePaletteSync();
    if (choosePalette) choosePalette();
    else renderQuickPalettes();
  }

  function addCurrentPalette() {
    const current = read();
    const active = paletteForSettings(current);
    const palettes = loadCustomPalettes();
    if (palettes.length >= MAX_CUSTOM_PALETTES) {
      global.alert?.(readerPreferenceT("paletteLimit", "自定义配色最多可保存 30 个。"));
      return;
    }
    const id = `custom-${Date.now().toString(36)}`;
    const nameInput = document.getElementById("pref-palette-name") as HTMLInputElement | null;
    const requestedName = String(nameInput?.value || "").trim().slice(0, 24);
    const palette = {
      id, name: requestedName || readerPreferenceT("customPaletteName", `我的配色 ${palettes.length + 1}`, { number: palettes.length + 1 }), background: current.customBackgroundColor || active?.background || "#fffdf8", backgroundImage: "", backgroundAssetId: current.customBackgroundAssetId || active?.backgroundAssetId || "", backgroundAssetSha256: current.customBackgroundAssetSha256 || active?.backgroundAssetSha256 || "", backgroundAssetMime: current.customBackgroundAssetMime || active?.backgroundAssetMime || "", backgroundAssetBytes: current.customBackgroundAssetBytes || active?.backgroundAssetBytes || 0,
      text: current.textColor || active?.text || "#222222", link: current.linkColor || active?.link || "#2f6fad", selection: current.selectionColor || active?.selection || "#dceafa", footnote: current.footnoteBackground || active?.footnote || "#f3f6fa", border: current.footnoteBorder || active?.border || "#b7c7da", theme: current.theme || "light",
    };
    palettes.push(palette);
    saveCustomPalettes(palettes);
    autoPreviewThemeId = palette.id;
    if (nameInput) nameInput.value = "";
    updateAppearance(palettePatch(palette));
  }

  function themeFromCurrentSettings(id: string, name: string, patch: PreferenceRecord = {}): ReaderPalette {
    const settings = read();
    const active = paletteForSettings(settings);
    const hasPatch = (key: string): boolean => Object.prototype.hasOwnProperty.call(patch, key);
    const value = (settingKey: string, paletteKey: keyof ReaderPalette, fallback: string | number): string | number => hasPatch(settingKey) ? patch[settingKey] as string | number : settings[settingKey] as string | number || active?.[paletteKey] as string | number || fallback;
    return {
      id,
      name,
      background: String(value("customBackgroundColor", "background", "#fffdf8")),
      backgroundImage: String(value("customBackgroundImage", "backgroundImage", "")),
      backgroundAssetId: String(value("customBackgroundAssetId", "backgroundAssetId", "")),
      backgroundAssetSha256: String(value("customBackgroundAssetSha256", "backgroundAssetSha256", "")),
      backgroundAssetMime: String(value("customBackgroundAssetMime", "backgroundAssetMime", "")),
      backgroundAssetBytes: Number(value("customBackgroundAssetBytes", "backgroundAssetBytes", 0)),
      text: String(value("textColor", "text", "#222222")),
      link: String(value("linkColor", "link", "#2f6fad")),
      selection: String(value("selectionColor", "selection", "#dceafa")),
      footnote: String(value("footnoteBackground", "footnote", "#f3f6fa")),
      border: String(value("footnoteBorder", "border", "#b7c7da")),
      theme: String(patch.theme || settings.theme || active?.theme || "light"),
    };
  }

  function updateAutomaticPreviewTheme(patch: PreferenceRecord): void {
    const palettes = loadCustomPalettes();
    const active = paletteForSettings(read());
    let index = palettes.findIndex((palette) => palette.id === autoPreviewThemeId && active?.id === autoPreviewThemeId);
    if (index < 0) {
      if (palettes.length >= MAX_CUSTOM_PALETTES) {
        global.alert?.(readerPreferenceT("paletteLimit", "自定义主题最多可保存 30 个。"));
        updateAppearance(Object.assign({ backgroundPreset: "custom", customPaletteId: "", theme: read().theme }, patch));
        return;
      }
      const id = `custom-${Date.now().toString(36)}`;
      const requestedName = String((document.getElementById("pref-palette-name") as HTMLInputElement | null)?.value || "").trim().slice(0, 24);
      const name = requestedName || readerPreferenceT("customPaletteName", `我的主题 ${palettes.length + 1}`, { number: palettes.length + 1 });
      palettes.push(themeFromCurrentSettings(id, name, patch));
      index = palettes.length - 1;
      autoPreviewThemeId = id;
    } else {
      const currentPalette = palettes[index];
      if (currentPalette) palettes[index] = Object.assign({}, themeFromCurrentSettings(autoPreviewThemeId, currentPalette.name, patch), { name: currentPalette.name });
    }
    const theme = palettes[index];
    if (!theme) return;
    saveCustomPalettes(palettes);
    updateAppearance(palettePatch(theme));
  }

  function settingColor(settingKey: string, settings = read()): string {
    const palette: ReaderPalette = paletteForSettings(settings) ?? builtinPalettes[0]!;
    const paletteKey = colorMap[settingKey as keyof typeof colorMap] as keyof ReaderPalette | undefined;
    const settingValue = settingKey === "customBackgroundColor" && settings.backgroundPreset !== "custom"
      ? undefined
      : settings[settingKey];
    return normalizedHex(settingValue || (paletteKey ? palette[paletteKey] : undefined));
  }

  function colorControlValue(control: HTMLElement | null | undefined, settings = read()): string {
    const settingKey = control?.dataset.prefColor ?? "";
    return normalizedHex(control?.dataset.colorValue || settingColor(settingKey, settings));
  }

  function paintColorControl(control: HTMLElement | null | undefined, value: unknown): void {
    if (!control) return;
    const color = normalizedHex(value);
    control.dataset.colorValue = color;
    control.style.setProperty("--reader-color", color);
    control.setAttribute("aria-valuetext", color.toUpperCase());
  }

  function effectiveColor(settingKey: keyof typeof colorMap): string {
    const control = modalElement.querySelector<HTMLElement>(`[data-pref-color="${settingKey}"]`);
    return colorControlValue(control);
  }

  function activeColorContrastPair(selectedColor: string): { foreground: string; background: string } {
    const settingKey = activeColorControl?.dataset.prefColor;
    const background = effectiveColor("customBackgroundColor");
    const text = effectiveColor("textColor");
    if (settingKey === "customBackgroundColor") return { foreground: text, background: selectedColor };
    if (settingKey === "textColor" || settingKey === "linkColor") return { foreground: selectedColor, background };
    if (settingKey === "selectionColor" || settingKey === "footnoteBackground") return { foreground: text, background: selectedColor };
    if (settingKey === "footnoteBorder") return { foreground: selectedColor, background: effectiveColor("footnoteBackground") };
    return { foreground: selectedColor, background };
  }

  function renderColorContrast(selectedColor: string): void {
    if (!activeColorControl) return;
    const contrast = document.getElementById("reader-color-contrast");
    const value = document.getElementById("reader-color-contrast-value");
    const level = document.getElementById("reader-color-contrast-level");
    const preview = document.getElementById("reader-color-contrast-preview");
    if (!contrast || !value || !level) return;
    const pair = activeColorContrastPair(selectedColor);
    const ratio = contrastRatio(pair.foreground, pair.background);
    const ratioText = `${ratio.toFixed(1)}:1`;
    const tone = ratio >= 7 ? "clear" : ratio >= 4.5 ? "readable" : "low";
    const levelText = tone === "clear"
      ? readerPreferenceT("colorContrastClear", "清晰")
      : tone === "readable"
        ? readerPreferenceT("colorContrastReadable", "可读")
        : readerPreferenceT("colorContrastLow", "偏低");
    contrast.dataset.level = tone;
    value.textContent = ratioText;
    level.textContent = levelText;
    contrast.setAttribute("aria-label", `${readerPreferenceT("colorContrast", "对比度")} ${ratioText} · ${levelText}`);
    if (preview) {
      preview.style.color = pair.foreground;
      preview.style.background = pair.background;
    }
  }

  function renderColorEditor(color: string): void {
    const hexInput = document.getElementById("reader-color-hex") as HTMLInputElement | null;
    const hue = document.getElementById("reader-color-hue") as HTMLInputElement | null;
    const saturation = document.getElementById("reader-color-saturation") as HTMLInputElement | null;
    const lightness = document.getElementById("reader-color-lightness") as HTMLInputElement | null;
    const spectrum = document.getElementById("reader-color-spectrum");
    const hsl = hexToHsl(color);
    if (hexInput) hexInput.value = color.toUpperCase();
    if (hue) {
      hue.value = String(hsl.h);
      hue.style.background = "linear-gradient(to right,#f33,#ff0,#0f0,#0ff,#36f,#f0f,#f33)";
    }
    if (saturation) {
      saturation.value = String(hsl.s);
      saturation.style.background = `linear-gradient(to right,hsl(${hsl.h} 0% ${hsl.l}%),hsl(${hsl.h} 100% ${hsl.l}%))`;
    }
    if (lightness) {
      lightness.value = String(hsl.l);
      lightness.style.background = `linear-gradient(to right,#000,hsl(${hsl.h} ${hsl.s}% 50%),#fff)`;
    }
    if (spectrum) {
      spectrum.style.background = "linear-gradient(to bottom,#fff 0%,rgba(255,255,255,0) 50%,#000 100%),linear-gradient(to right,#f00 0%,#ff0 16.67%,#0f0 33.33%,#0ff 50%,#00f 66.67%,#f0f 83.33%,#f00 100%)";
      spectrum.style.setProperty("--reader-spectrum-x", `${hsl.h / 3.6}%`);
      spectrum.style.setProperty("--reader-spectrum-y", `${100 - hsl.l}%`);
      spectrum.style.setProperty("--reader-spectrum-color", color);
      spectrum.setAttribute(
        "aria-label",
        `${readerPreferenceT("fullColorSpectrum", "完整色谱")} · ${readerPreferenceT("colorHue", "色相")} ${hsl.h}° · ${readerPreferenceT("colorLightness", "明度")} ${hsl.l}%`,
      );
    }
    renderColorContrast(color);
  }

  function closeColorPopover() {
    activeColorControl?.setAttribute("aria-expanded", "false");
    activeColorControl = null;
    colorSpectrumPointer = null;
    const popover = document.getElementById("reader-color-popover");
    if (popover) popover.hidden = true;
  }

  function setActiveColor(value: unknown): void {
    if (!activeColorControl) return;
    const color = normalizedHex(value, colorControlValue(activeColorControl));
    paintColorControl(activeColorControl, color);
    const settingKey = activeColorControl.dataset.prefColor;
    if (settingKey) updateAutomaticPreviewTheme({ [settingKey]: color });
    renderColorEditor(color);
  }

  function openColorPopover(control: HTMLElement): void {
    const popover = document.getElementById("reader-color-popover");
    if (!popover) return;
    if (activeColorControl && activeColorControl !== control) {
      activeColorControl.setAttribute("aria-expanded", "false");
    }
    activeColorControl = control;
    control.setAttribute("aria-expanded", "true");
    const value = colorControlValue(control);
    paintColorControl(control, value);
    popover.hidden = false;
    renderColorEditor(value);
    const rect = control.getBoundingClientRect();
    const maxLeft = Math.max(12, window.innerWidth - popover.offsetWidth - 12);
    const maxTop = Math.max(12, window.innerHeight - popover.offsetHeight - 12);
    popover.style.left = `${Math.max(12, Math.min(maxLeft, rect.right - popover.offsetWidth))}px`;
    popover.style.top = `${Math.max(12, Math.min(maxTop, rect.bottom + 8))}px`;
  }

  function setColorFromSpectrumPoint(clientX: number, clientY: number): void {
    const spectrum = document.getElementById("reader-color-spectrum");
    if (!spectrum) return;
    const rect = spectrum.getBoundingClientRect();
    const hue = Math.max(0, Math.min(359, Math.round((clientX - rect.left) / Math.max(1, rect.width) * 359)));
    const lightness = Math.max(0, Math.min(100, Math.round((rect.bottom - clientY) / Math.max(1, rect.height) * 100)));
    setActiveColor(hslToHex(hue, 100, lightness));
  }


  function renderQuickPalettes() {
    const host = document.getElementById("reader-quick-palette");
    if (!host) return;
    const active = paletteForSettings(global.ReaderSettings.get());
    host.replaceChildren();
    paletteList().slice(0, 3).forEach((palette) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "reader-quick-palette-btn" + (active?.id === palette.id ? " active" : "");
      button.style.setProperty("--quick-bg", palette.background);
      button.style.setProperty("--quick-fg", palette.text);
      applyPalettePreview(button, palette);
      button.textContent = paletteLabel(palette).slice(0, 2);
      button.title = paletteLabel(palette);
      button.addEventListener("click", (event) => { event.stopPropagation(); applyQuickPalette(palette); global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.SETTINGS, true); });
      host.append(button);
    });
  }

  function renderPaletteGrid(): void {
    const grid = modalElement.querySelector<HTMLElement>("#pref-palette-grid");
    if (!grid) return;
    const settings = read();
    const active = paletteForSettings(settings);
    grid.replaceChildren();
    const palettes = paletteList();
    grid.closest(".reader-palette-scroll")?.classList.toggle("has-many-palettes", palettes.length > 9);
    palettes.forEach((palette) => {
      const tile = document.createElement("div");
      tile.setAttribute("role", "button");
      tile.tabIndex = 0;
      tile.className = "reader-palette-tile" + (active?.id === palette.id ? " active" : "");
      tile.dataset.paletteId = palette.id;
      tile.style.setProperty("--pref-bg", palette.background);
      tile.style.setProperty("--pref-fg", palette.text);
      tile.style.setProperty("--pref-link", palette.link);
      tile.style.setProperty("--pref-selection", palette.selection);
      tile.style.setProperty("--pref-footnote", palette.footnote);
      tile.style.setProperty("--pref-border", palette.border);
      applyPalettePreview(tile, palette);
      tile.setAttribute("aria-label", readerPreferenceT("paletteDragHint", `${paletteLabel(palette)}，按住拖动以排序`, { name: paletteLabel(palette) }));
      const name = document.createElement("span");
      name.className = "reader-palette-name" + (isBuiltinPalette(palette) ? "" : " editable");
      name.textContent = paletteLabel(palette);
      appendPaletteReadingPreview(tile);
      tile.append(name);
      if (!isBuiltinPalette(palette)) {
        name.title = readerPreferenceT("editPaletteName", "编辑主题名称");
        name.addEventListener("click", (event) => { event.stopPropagation(); beginPaletteNameEdit(name, palette); });
        const remove = document.createElement("span");
        remove.className = "reader-palette-delete " + paletteDeleteTone(palette);
        remove.setAttribute("role", "button");
        remove.tabIndex = 0;
        remove.setAttribute("aria-label", readerPreferenceT("deletePaletteNamed", `删除${paletteLabel(palette)}`, { name: paletteLabel(palette) }));
        remove.title = readerPreferenceT("deletePalette", "删除配色");
        remove.textContent = "🗑";
        const removePalette = (event: Event): void => { event.preventDefault(); event.stopPropagation(); removeCustomPalette(palette.id); };
        remove.addEventListener("pointerdown", (event) => event.stopPropagation());
        remove.addEventListener("click", removePalette);
        remove.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") removePalette(event); });
        tile.append(remove);
      }
      tile.addEventListener("click", (event) => { if (performance.now() < suppressPaletteClickUntil) { event.preventDefault(); return; } updateAppearance(palettePatch(palette)); });
      tile.addEventListener("pointerdown", (event) => {
        if ((event.target as Element | null)?.closest(".reader-palette-name,.reader-palette-delete")) return;
        if (event.button !== 0 || pointerDrag) return;
        event.preventDefault();
        const box = tile.getBoundingClientRect();
        const placeholder = document.createElement("div");
        placeholder.className = "reader-palette-placeholder";
        tile.parentElement?.insertBefore(placeholder, tile.nextSibling);
        tile.classList.add("dragging");
        tile.style.position = "fixed";
        tile.style.left = `${box.left}px`;
        tile.style.top = `${box.top}px`;
        tile.style.width = `${box.width}px`;
        tile.style.height = `${box.height}px`;
        pointerDrag = { tile, placeholder, capture: tile, pointerId: event.pointerId, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top, moved: false, choose: () => updateAppearance(palettePatch(palette)) };
        try { tile.setPointerCapture(event.pointerId); } catch {}
      });
      tile.addEventListener("pointermove", (event) => { if (pointerDrag?.pointerId === event.pointerId) { event.preventDefault(); movePaletteDrag(event.clientX, event.clientY); } });
      tile.addEventListener("keydown", (event) => { if ((event.key === "Enter" || event.key === " ") && event.target === tile) { event.preventDefault(); updateAppearance(palettePatch(palette)); } });
      tile.addEventListener("pointerup", finishPointerDrag);
      tile.addEventListener("pointercancel", finishPointerDrag);
      grid.append(tile);
    });
  }

  function updatePreferencesScrollbar() {
    if (!preferencesContent || !preferencesScrollbar || !preferencesScrollThumb) return;
    const viewport = preferencesContent.clientHeight;
    const total = preferencesContent.scrollHeight;
    const maxScroll = Math.max(0, total - viewport);
    preferencesScrollbar.hidden = maxScroll <= 1 || viewport <= 0;
    if (preferencesScrollbar.hidden) return;
    const thumbHeight = Math.max(36, Math.min(viewport, Math.round(viewport * viewport / total)));
    const travel = Math.max(0, viewport - thumbHeight);
    const thumbTop = maxScroll ? Math.round(preferencesContent.scrollTop / maxScroll * travel) : 0;
    preferencesScrollbar.style.top = `${preferencesContent.offsetTop}px`;
    preferencesScrollbar.style.height = `${viewport}px`;
    preferencesScrollThumb.style.height = `${thumbHeight}px`;
    preferencesScrollThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function finishPreferencesScrollDrag(event: PointerEvent): void {
    if (!preferencesScrollDrag || preferencesScrollDrag.pointerId !== event.pointerId) return;
    try { preferencesScrollThumb?.releasePointerCapture(event.pointerId); } catch {}
    preferencesScrollDrag = null;
  }

  function render(): void {
    const settings = read();
    const jumpBackSettings = global.ReaderSettings.get();
    modalElement.querySelectorAll<PreferenceElement>("[data-pref-scope]").forEach((button) => {
      const selected = button.dataset.prefScope === scope;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const bookScope = modalElement.querySelector<HTMLButtonElement>('[data-pref-scope="book"]');
    if (bookScope) bookScope.disabled = !global.currentBookId;
    modalElement.querySelectorAll<HTMLElement>("[data-pref-color]").forEach((control) => {
      const settingKey = control.dataset.prefColor ?? "";
      paintColorControl(control, settingColor(settingKey, settings));
    });
    if (activeColorControl) renderColorEditor(colorControlValue(activeColorControl, settings));
    const imageName = modalElement.querySelector("#pref-background-image-name");
    if (imageName) imageName.textContent = settings.customBackgroundImage ? readerPreferenceT("backgroundImported", "已导入图片背景") : "";
    const clearBook = modalElement.querySelector<HTMLElement>("#pref-clear-book-appearance");
    if (clearBook) clearBook.hidden = scope !== "book" || !ReaderSettings.hasBookAppearance?.();
    const imagePagination = settings.imagePagination === "continuous" ? "continuous" : "next-page";
    modalElement.querySelectorAll<HTMLElement>("[data-image-pagination]").forEach((button) => {
      const selected = button.dataset.imagePagination === imagePagination;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-checked", String(selected));
    });
    const layoutEngine = settings.epubLayoutEngine === "modern" ? "modern" : "legacy";
    modalElement.querySelectorAll<HTMLButtonElement>("[data-pref-epub-layout-engine]").forEach((button) => {
      const selected = button.dataset.prefEpubLayoutEngine === layoutEngine;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    const dualPageGap = dualPageGapPixels(jumpBackSettings.dualPageGap);
    const dualPageGapInput = document.getElementById("pref-dual-page-gap") as HTMLInputElement | null;
    if (dualPageGapInput) dualPageGapInput.value = String(dualPageGap);
    const dualPageGapValue = document.getElementById("pref-dual-page-gap-value");
    if (dualPageGapValue) dualPageGapValue.textContent = `${dualPageGap} px`;
    modalElement.querySelectorAll<HTMLInputElement>("[data-pref-bool]").forEach((input) => { input.checked = settings[input.dataset.prefBool ?? ""] !== false; });
    renderToolbarOrder(ReaderSettings.get());
    const jumpBackMode = jumpBackSettings.readerJumpBackDismissMode === "time" ? "time" : "pages";
    const jumpBackModeSelect = document.getElementById("pref-reader-jump-back-dismiss-mode") as HTMLSelectElement | null;
    if (jumpBackModeSelect) jumpBackModeSelect.value = jumpBackMode;
    const jumpBackPages = document.getElementById("pref-reader-jump-back-pages") as HTMLInputElement | null;
    if (jumpBackPages) jumpBackPages.value = String(Math.max(1, Math.min(100, Number(jumpBackSettings.readerJumpBackDismissPages) || 3)));
    const jumpBackSeconds = document.getElementById("pref-reader-jump-back-seconds") as HTMLInputElement | null;
    if (jumpBackSeconds) jumpBackSeconds.value = String(Math.max(1, Math.min(600, Number(jumpBackSettings.readerJumpBackDismissSeconds) || 30)));
    const jumpBackSize = jumpBackIconPixels(jumpBackSettings.readerJumpBackIconSizePx);
    const jumpBackSizeInput = document.getElementById("pref-reader-jump-back-size") as HTMLInputElement | null;
    if (jumpBackSizeInput) jumpBackSizeInput.value = String(jumpBackSize);
    const jumpBackSizeValue = document.getElementById("pref-reader-jump-back-size-value");
    if (jumpBackSizeValue) jumpBackSizeValue.textContent = `${jumpBackSize} px`;
    jumpBackPages?.toggleAttribute("hidden", jumpBackMode !== "pages");
    jumpBackSeconds?.toggleAttribute("hidden", jumpBackMode !== "time");
    const jumpBackUnit = document.getElementById("pref-reader-jump-back-dismiss-unit") as HTMLLabelElement | null;
    if (jumpBackUnit) {
      jumpBackUnit.htmlFor = jumpBackMode === "time" ? "pref-reader-jump-back-seconds" : "pref-reader-jump-back-pages";
      jumpBackUnit.textContent = readerPreferenceT(jumpBackMode === "time" ? "secondsUnit" : "pageUnit", jumpBackMode === "time" ? "秒" : "页");
    }
    requestAnimationFrame(() => renderJumpBackPreview(jumpBackSettings));
    applyToolbar(ReaderSettings.get());
    renderPaletteGrid();
    renderQuickPalettes();
    requestAnimationFrame(updatePreferencesScrollbar);
  }

  function setSection(name: string | undefined): void {
    modalElement.querySelectorAll<HTMLElement>("[data-pref-section]").forEach((button) => button.classList.toggle("active", button.dataset.prefSection === name));
    modalElement.querySelectorAll<HTMLElement>("[data-pref-panel]").forEach((panel) => { panel.hidden = panel.dataset.prefPanel !== name; });
    // Panels have very different heights. Leaving the previous panel's scroll
    // offset in place can put the short Advanced panel entirely above view,
    // which makes the jump-back settings look as if they disappeared.
    if (preferencesContent) preferencesContent.scrollTop = 0;
    requestAnimationFrame(updatePreferencesScrollbar);
  }

  openButton.addEventListener("click", (event) => {
    event.stopPropagation();
    global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, true);
    render();
  });
  preferencesNavToggle?.addEventListener("click", () => {
    preferenceNavCollapsed = !preferenceNavCollapsed;
    try { localStorage.setItem(PREFERENCE_NAV_COLLAPSED_KEY, preferenceNavCollapsed ? "1" : "0"); } catch {}
    applyPreferenceNavState();
  });
  const preferencesOverlay = global.ReaderShell?.OVERLAY?.PREFERENCES || "preferences";
  modalElement.addEventListener("pointerdown", (event) => {
    preferencesOutsidePointerDown = event.target === modal;
  });
  modalElement.addEventListener("click", (event) => {
    if (event.target !== modal || !preferencesOutsidePointerDown) return;
    preferencesOutsidePointerDown = false;
    closeColorPopover();
    global.ReaderShell?.setOverlay?.(preferencesOverlay, false);
  });
  global.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !global.ReaderShell?.isOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES)) return;
    if (activeColorControl) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeColorPopover();
      return;
    }
    global.ReaderShell.closeOverlay();
  });
  global.addEventListener("reader-shell-statechange", ((event: CustomEvent<{ readonly previous?: { readonly overlay?: unknown }; readonly next?: { readonly overlay?: unknown } }>) => {
    const preferences = global.ReaderShell?.OVERLAY?.PREFERENCES;
    if (event.detail?.previous?.overlay !== preferences || event.detail?.next?.overlay === preferences) return;
    clearReaderLayoutPreview();
  }) as EventListener);
  preferencesContent?.addEventListener("scroll", updatePreferencesScrollbar, { passive: true });

  preferencesScrollThumb?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !preferencesContent) return;
    event.preventDefault();
    preferencesScrollDrag = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: preferencesContent.scrollTop };
    try { preferencesScrollThumb.setPointerCapture(event.pointerId); } catch {}
  });
  preferencesScrollThumb?.addEventListener("pointermove", (event) => {
    if (!preferencesScrollDrag || preferencesScrollDrag.pointerId !== event.pointerId || !preferencesContent) return;
    event.preventDefault();
    const viewport = preferencesContent.clientHeight;
    const maxScroll = Math.max(0, preferencesContent.scrollHeight - viewport);
    const thumbHeight = preferencesScrollThumb.offsetHeight;
    const travel = Math.max(1, viewport - thumbHeight);
    preferencesContent.scrollTop = preferencesScrollDrag.startScrollTop + (event.clientY - preferencesScrollDrag.startY) * maxScroll / travel;
  });
  preferencesScrollThumb?.addEventListener("pointerup", finishPreferencesScrollDrag);
  preferencesScrollThumb?.addEventListener("pointercancel", finishPreferencesScrollDrag);
  global.addEventListener("resize", updatePreferencesScrollbar);
  global.addEventListener("reader-language-changed", () => {
    applyPreferenceNavState();
    if (activeColorControl) renderColorEditor(colorControlValue(activeColorControl));
  });
  if (typeof ResizeObserver === "function" && preferencesContent) new ResizeObserver(updatePreferencesScrollbar).observe(preferencesContent);
  modalElement.querySelectorAll<HTMLElement>("[data-pref-section]").forEach((button) => button.addEventListener("click", () => setSection(button.dataset.prefSection)));
  modalElement.querySelectorAll<HTMLButtonElement>("[data-pref-scope]").forEach((button) => button.addEventListener("click", () => { if (!button.disabled) { scope = button.dataset.prefScope ?? "default"; render(); } }));
  const colorPopover = document.getElementById("reader-color-popover");
  modalElement.querySelectorAll<HTMLElement>("[data-pref-color]").forEach((control) => control.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeColorControl === control && colorPopover && !colorPopover.hidden) closeColorPopover();
    else openColorPopover(control);
  }));
  const colorHue = document.getElementById("reader-color-hue") as HTMLInputElement | null;
  const colorSaturation = document.getElementById("reader-color-saturation") as HTMLInputElement | null;
  const colorLightness = document.getElementById("reader-color-lightness") as HTMLInputElement | null;
  [colorHue, colorSaturation, colorLightness].forEach((input) => input?.addEventListener("input", () => setActiveColor(hslToHex(colorHue?.value, colorSaturation?.value, colorLightness?.value))));
  const colorSpectrum = document.getElementById("reader-color-spectrum");
  colorSpectrum?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    colorSpectrumPointer = event.pointerId;
    try { colorSpectrum.setPointerCapture(event.pointerId); } catch {}
    setColorFromSpectrumPoint(event.clientX, event.clientY);
  });
  colorSpectrum?.addEventListener("pointermove", (event) => {
    if (colorSpectrumPointer !== event.pointerId) return;
    event.preventDefault();
    setColorFromSpectrumPoint(event.clientX, event.clientY);
  });
  const finishColorSpectrumPointer = (event: PointerEvent): void => {
    if (colorSpectrumPointer !== event.pointerId) return;
    colorSpectrumPointer = null;
    try { colorSpectrum?.releasePointerCapture(event.pointerId); } catch {}
  };
  colorSpectrum?.addEventListener("pointerup", finishColorSpectrumPointer);
  colorSpectrum?.addEventListener("pointercancel", finishColorSpectrumPointer);
  colorSpectrum?.addEventListener("keydown", (event) => {
    if (!activeColorControl || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const current = hexToHsl(colorControlValue(activeColorControl));
    const step = event.shiftKey ? 10 : 1;
    const hue = event.key === "ArrowLeft"
      ? (current.h - step + 360) % 360
      : event.key === "ArrowRight"
        ? (current.h + step) % 360
        : current.h;
    const lightness = event.key === "ArrowUp"
      ? Math.min(100, current.l + step)
      : event.key === "ArrowDown"
        ? Math.max(0, current.l - step)
        : current.l;
    setActiveColor(hslToHex(hue, 100, lightness));
  });
  document.getElementById("reader-color-hex")?.addEventListener("change", (event) => setActiveColor((event.currentTarget as HTMLInputElement).value));
  document.addEventListener("pointerdown", (event) => {
    const targetNode = event.target as Node | null;
    if (!activeColorControl || colorPopover?.contains(targetNode) || activeColorControl.contains(targetNode)) return;
    closeColorPopover();
  }, true);
  document.getElementById("pref-background-image")?.addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const status = document.getElementById("pref-background-image-name");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > MAX_BACKGROUND_IMAGE_SOURCE_BYTES) { if (status) status.textContent = readerPreferenceT("backgroundImageSourceInvalid", "请选择 PNG、JPG、WebP 或 GIF 图片；原文件最大 25 MiB，超过 5 MiB 会自动压缩。"); input.value = ""; return; }
    const reader = new FileReader();
reader.onload = async () => {
      const source = String(reader.result || "");
      try {
        const asset = api ? await api.invoke("cache_reader_background_image", { dataUrl: source }) : null;
        if (!asset?.url || !asset?.assetId) throw new Error("cache unavailable");
        updateAutomaticPreviewTheme({ customBackgroundImage: asset.url, customBackgroundAssetId: asset.assetId, customBackgroundAssetSha256: asset.sha256, customBackgroundAssetMime: asset.mime, customBackgroundAssetBytes: asset.byteSize });
        if (status) {
          const storedBytes = typeof asset.byteSize === "number" ? asset.byteSize : 0;
          status.textContent = asset.compressed === true
            ? readerPreferenceT("backgroundImageCompressed", `${file.name} 已压缩至 ${(storedBytes / (1024 * 1024)).toFixed(1)} MiB（上限 5 MiB）。`)
            : file.name;
        }
      } catch { if (status) status.textContent = readerPreferenceT("backgroundImageImportFailed", "背景图片导入失败"); }
      input.value = "";
    };
    reader.readAsDataURL(file);
  });
  document.getElementById("pref-clear-background-image")?.addEventListener("click", () => updateAutomaticPreviewTheme({ customBackgroundImage: "", customBackgroundAssetId: "", customBackgroundAssetSha256: "", customBackgroundAssetMime: "", customBackgroundAssetBytes: 0 }));
  document.getElementById("pref-add-palette")?.addEventListener("click", addCurrentPalette);
  modalElement.querySelectorAll<HTMLElement>("[data-image-pagination]").forEach((button) => button.addEventListener("click", () => {
    const imagePagination = button.dataset.imagePagination === "continuous" ? "continuous" : "next-page";
    ReaderSettings.update({ imagePagination });
  }));
  modalElement.querySelectorAll<HTMLButtonElement>("[data-pref-epub-layout-engine]").forEach((button) => button.addEventListener("click", () => {
    const engine = button.dataset.prefEpubLayoutEngine === "modern" ? "modern" : "legacy";
    ReaderSettings.update({ epubLayoutEngine: engine });
  }));
  document.getElementById("pref-dual-page-gap")?.addEventListener("input", (event) => {
    const value = dualPageGapPixels((event.currentTarget as HTMLInputElement).value);
    const output = document.getElementById("pref-dual-page-gap-value");
    if (output) output.textContent = `${value} px`;
    previewReaderLayout({ type: "dual-page-gap", dualPageGap: value, phase: "adjusting" });
    ReaderSettings.update({ dualPageGap: value }, { deferPageApply: true });
  });
  document.getElementById("pref-dual-page-gap")?.addEventListener("change", (event) => {
    const value = dualPageGapPixels((event.currentTarget as HTMLInputElement).value);
    previewReaderLayout({ type: "dual-page-gap", dualPageGap: value, phase: "finished" });
    applyDeferredReaderSettingsAfterPreviewPaint();
  });
  document.getElementById("pref-dual-page-gap-reset")?.addEventListener("click", () => {
    const value = DEFAULT_DUAL_PAGE_GAP;
    const input = document.getElementById("pref-dual-page-gap") as HTMLInputElement | null;
    const output = document.getElementById("pref-dual-page-gap-value");
    if (input) input.value = String(value);
    if (output) output.textContent = `${value} px`;
    previewReaderLayout({ type: "dual-page-gap", dualPageGap: value, phase: "reset" });
    ReaderSettings.update({ dualPageGap: value }, { deferPageApply: true });
    applyDeferredReaderSettingsAfterPreviewPaint();
  });
  function setReaderJumpBackConfigExpanded(expanded: boolean): void {
    const config = document.getElementById("pref-reader-jump-back-config");
    const button = document.getElementById("pref-reader-jump-back-settings");
    if (!config || !button) return;
    config.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    // The preview measures its containing panel. When that panel was hidden its
    // rectangle was 0 × 0, so the edge clamp made every saved position look
    // like the top-left corner. Re-measure only after the disclosure is visible.
    requestAnimationFrame(() => {
      if (expanded) renderJumpBackPreview(ReaderSettings.get());
      updatePreferencesScrollbar();
    });
  }
  const readerJumpBackSettingsButton = document.getElementById("pref-reader-jump-back-settings");
  readerJumpBackSettingsButton?.addEventListener("click", () => {
    const config = document.getElementById("pref-reader-jump-back-config");
    setReaderJumpBackConfigExpanded(!!config?.hidden);
  });
  global.addEventListener("click", (event) => {
    const config = document.getElementById("pref-reader-jump-back-config");
    if (!config || config.hidden) return;
    const targetNode = event.target as Node | null;
    if (config.contains(targetNode) || readerJumpBackSettingsButton?.contains(targetNode)) return;
    setReaderJumpBackConfigExpanded(false);
  });
  document.getElementById("pref-reader-jump-back-dismiss-mode")?.addEventListener("change", (event) => {
    ReaderSettings.update({ readerJumpBackDismissMode: (event.currentTarget as HTMLSelectElement).value === "time" ? "time" : "pages" });
  });
  document.getElementById("pref-reader-jump-back-pages")?.addEventListener("change", (event) => {
    const value = Math.max(1, Math.min(100, Number((event.currentTarget as HTMLInputElement).value) || 3));
    ReaderSettings.update({ readerJumpBackDismissPages: value });
  });
  document.getElementById("pref-reader-jump-back-seconds")?.addEventListener("change", (event) => {
    const value = Math.max(1, Math.min(600, Number((event.currentTarget as HTMLInputElement).value) || 30));
    ReaderSettings.update({ readerJumpBackDismissSeconds: value });
  });
  document.getElementById("pref-reader-jump-back-size")?.addEventListener("input", (event) => {
    const value = jumpBackIconPixels((event.currentTarget as HTMLInputElement).value);
    const output = document.getElementById("pref-reader-jump-back-size-value");
    if (output) output.textContent = `${jumpBackIconPixels(value)} px`;
    ReaderSettings.update({ readerJumpBackIconSizePx: value });
  });
  const jumpBackPreviewIcon = document.getElementById("pref-reader-jump-back-preview-icon");
  jumpBackPreviewIcon?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    jumpBackPreviewDrag = event.pointerId;
    try { jumpBackPreviewIcon.setPointerCapture(event.pointerId); } catch {}
    updateJumpBackPreviewPosition(event);
  });
  function moveJumpBackPreviewDrag(event: PointerEvent): void {
    if (jumpBackPreviewDrag !== event.pointerId) return;
    event.preventDefault();
    updateJumpBackPreviewPosition(event);
  }
  const finishJumpBackPreviewDrag = (event: PointerEvent): void => {
    if (jumpBackPreviewDrag !== event.pointerId) return;
    try { jumpBackPreviewIcon?.releasePointerCapture(event.pointerId); } catch {}
    jumpBackPreviewDrag = null;
  };
  // WebView pointer capture can be lost when a drag leaves the button. Keep
  // tracking at the window just like gesture-hint placement, otherwise the
  // last half-icon near every edge can never be reached.
  global.addEventListener("pointermove", moveJumpBackPreviewDrag, true);
  global.addEventListener("pointerup", finishJumpBackPreviewDrag, true);
  global.addEventListener("pointercancel", finishJumpBackPreviewDrag, true);
  jumpBackPreviewIcon?.addEventListener("keydown", (event) => {
    const settings = ReaderSettings.get();
    const step = event.shiftKey ? 50 : 10;
    const patch: ReaderAppearance = {};
    if (event.key === "ArrowLeft") patch.readerJumpBackPositionX = Math.max(0, jumpBackPosition(settings.readerJumpBackPositionX, 950) - step);
    else if (event.key === "ArrowRight") patch.readerJumpBackPositionX = Math.min(1000, jumpBackPosition(settings.readerJumpBackPositionX, 950) + step);
    else if (event.key === "ArrowUp") patch.readerJumpBackPositionY = Math.max(0, jumpBackPosition(settings.readerJumpBackPositionY, 500) - step);
    else if (event.key === "ArrowDown") patch.readerJumpBackPositionY = Math.min(1000, jumpBackPosition(settings.readerJumpBackPositionY, 500) + step);
    else return;
    event.preventDefault();
    ReaderSettings.update(patch);
  });
  modalElement.querySelectorAll<HTMLInputElement>("[data-pref-bool]").forEach((input) => input.addEventListener("change", () => { const key = input.dataset.prefBool; if (key) ReaderSettings.update({ [key]: input.checked }); }));
  document.querySelectorAll<HTMLElement>("#reader-toolbar-order-list [data-toolbar-item]").forEach((item) => {
    const handle = item.querySelector<HTMLElement>(".reader-toolbar-drag-handle");
    handle?.addEventListener("pointerdown", (event) => beginToolbarDrag(event, item, handle));
    handle?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      moveToolbarItemByKeyboard(item, event.key === "ArrowUp" ? -1 : 1);
    });
  });
  global.addEventListener("pointermove", moveToolbarDrag, true);
  global.addEventListener("pointerup", finishToolbarDrag, true);
  global.addEventListener("pointercancel", finishToolbarDrag, true);
  document.getElementById("pref-reset-colors")?.addEventListener("click", () => updateAppearance({
    // 正文颜色保留；其余颜色和自定义背景恢复软件默认值。
    backgroundPreset: "light", customPaletteId: "", customBackgroundColor: "#fffdf8", customBackgroundImage: "",
    customBackgroundAssetId: "", customBackgroundAssetSha256: "", customBackgroundAssetMime: "", customBackgroundAssetBytes: 0,
    linkColor: "", selectionColor: "", footnoteBackground: "", footnoteBorder: "", theme: "light",
  }));
  document.getElementById("pref-clear-book-appearance")?.addEventListener("click", () => { ReaderSettings.clearBookAppearance?.(); render(); });
  global.addEventListener("reader-settings-changed", render);
  global.addEventListener("reader-language-changed", render);
  const preferencesApi: ReaderPreferencesApi = Object.freeze({ open() { global.ReaderShell?.setOverlay?.(global.ReaderShell.OVERLAY.PREFERENCES, true); render(); } });
  global.ReaderPreferences = preferencesApi;
  async function hydrateSyncedPalettes() {
    if (!api) { paletteSyncReady = true; return; }
    try {
      const snapshot = await api.invoke("reader_palette_sync_get");
      if (Array.isArray(snapshot?.palettes) && snapshot.palettes.length) {
        const palettes = await Promise.all(snapshot.palettes.slice(0, MAX_CUSTOM_PALETTES).map(async (value) => {
          const palette = sanitizePalette(value);
          if (!palette.backgroundAssetId || !palette.backgroundAssetMime) return palette;
          try {
            const url = await api.invoke("reader_background_local_url", { assetId: palette.backgroundAssetId, mime: palette.backgroundAssetMime });
            return sanitizePalette(Object.assign({}, palette, { backgroundImage: url }));
          } catch { return sanitizePalette(palette); }
        }));
        localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(palettes));
        if (Array.isArray(snapshot.order)) localStorage.setItem(PALETTE_ORDER_KEY, JSON.stringify(snapshot.order));
      } else if (loadCustomPalettes().length) {
        paletteSyncReady = true;
        queuePaletteSync();
      }
    } catch { /* 本机浏览器预览仍使用原有 LocalStorage。 */ }
    paletteSyncReady = true;
    render();
  }
  applyPreferenceNavState();
  render();
  void hydrateSyncedPalettes();
  return preferencesApi;
}
