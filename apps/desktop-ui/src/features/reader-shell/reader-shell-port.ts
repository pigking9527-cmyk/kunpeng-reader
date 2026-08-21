/**
 * Injected, low-frequency boundary for reader integration.
 *
 * The existing EPUB/PDF iframe, page layout loop, selection handling and
 * gesture stream remain behind the imperative reader engine. This port only
 * carries user-initiated chrome actions and short-lived panel data. Adapters
 * must not expose book paths, chapter HTML, page bitmaps, or raw engine events
 * to this feature.
 */

export type ReaderShellPanel = "preferences" | "highlight-menu" | "notes" | "search";
export type ReaderTheme = "light" | "dark" | "sepia";
export type ReaderFlowMode = "paged" | "scroll";
export type ReaderPageMode = "single" | "dual";
export type ReaderTextConversion = "t2s" | "s2t";
export type ReaderStyleMode = "local" | "book";
export type ReaderPageTurnEffect = "horizontal" | "off";
export type ReaderImagePagination = "next-page" | "continuous";
export type ReaderToolbarItem = "toc" | "chapters" | "tts" | "annotations" | "vocabulary" | "settings";
export type ReaderJumpBackDismissMode = "pages" | "time";
export type ReaderTtsSource = "edge" | "system";
export type ReaderBackgroundPreset = "light" | "dark" | "paper" | "custom";
export type ReaderAppearanceScope = "default" | "book";
export type ReaderClickZoneAction = "prev" | "center" | "next" | "none";
export type ReaderOptionalFontId = "lxgw-wenkai-lite" | "source-han-serif-sc" | "zhuque-fangsong";
export interface ReaderClickZone { readonly id: string; readonly action: ReaderClickZoneAction; readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface ReaderClickZonePreset { readonly id: string; readonly name: string; readonly zones: readonly ReaderClickZone[]; }
export interface ReaderClickZoneConfiguration { readonly zones: readonly ReaderClickZone[]; readonly presets: readonly ReaderClickZonePreset[]; readonly activePresetId: string; }
/** Download status only. Font binaries and their local paths stay native-side. */
export interface ReaderOptionalFontStatus {
  readonly id: ReaderOptionalFontId;
  readonly label: string;
  readonly fontFamily: string;
  readonly installed: boolean;
  readonly downloadBytes: number;
}

/** Metadata only; the native cache URL and image bytes never enter feature state. */
export interface ReaderBackgroundAsset {
  readonly id: string;
  readonly mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  readonly byteSize: number;
}

export interface ReaderCustomPalette {
  readonly id: string;
  readonly name: string;
  readonly background: string;
  readonly text: string;
  readonly link: string;
  readonly selection: string;
  readonly footnote: string;
  readonly border: string;
  readonly theme: ReaderTheme;
  readonly backgroundAsset: ReaderBackgroundAsset | null;
}

export interface ReaderAppearanceSnapshot {
  readonly preferences: ReaderShellPreferences;
  readonly scope: ReaderAppearanceScope;
  readonly bookScopeAvailable: boolean;
  readonly hasBookAppearance: boolean;
}

/** Safe, low-frequency preference subset. Per-book source text never enters it. */
export interface ReaderShellPreferences {
  readonly theme: ReaderTheme;
  readonly backgroundPreset: ReaderBackgroundPreset;
  readonly customPaletteId: string;
  readonly customBackgroundColor: string;
  readonly textColor: string;
  readonly linkColor: string;
  readonly selectionColor: string;
  readonly footnoteBackground: string;
  readonly footnoteBorder: string;
  readonly backgroundAsset: ReaderBackgroundAsset | null;
  readonly fontFamily: string;
  readonly styleMode: ReaderStyleMode;
  readonly textConversion: ReaderTextConversion;
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
  readonly flowMode: ReaderFlowMode;
  readonly pageMode: ReaderPageMode;
  readonly pageTurnEffect: ReaderPageTurnEffect;
  readonly pageTurnSpeed: number;
  readonly ttsSource: ReaderTtsSource;
  readonly ttsRate: number;
  readonly imagePagination: ReaderImagePagination;
  readonly showTextConversion: boolean;
  readonly showTocButton: boolean;
  readonly showChapterButtons: boolean;
  readonly showVocabularyButton: boolean;
  readonly showTtsButton: boolean;
  readonly showAnnotationButton: boolean;
  readonly toolbarOrder: readonly ReaderToolbarItem[];
  readonly showPageInfo: boolean;
  readonly showReaderJumpBack: boolean;
  readonly readerJumpBackDismissMode: ReaderJumpBackDismissMode;
  readonly readerJumpBackDismissSeconds: number;
  readonly readerJumpBackDismissPages: number;
  readonly readerJumpBackIconSizePx: number;
  /** Coordinates are a viewport-relative per-mille value, not screen pixels. */
  readonly readerJumpBackPositionX: number;
  readonly readerJumpBackPositionY: number;
}

export interface ReaderShellPreferencesPatch {
  readonly theme?: ReaderTheme;
  readonly backgroundPreset?: ReaderBackgroundPreset;
  readonly customPaletteId?: string;
  readonly customBackgroundColor?: string;
  readonly textColor?: string;
  readonly linkColor?: string;
  readonly selectionColor?: string;
  readonly footnoteBackground?: string;
  readonly footnoteBorder?: string;
  readonly fontFamily?: string;
  readonly styleMode?: ReaderStyleMode;
  readonly textConversion?: ReaderTextConversion;
  readonly fontSize?: number;
  readonly noteFontSize?: number;
  readonly lineHeight?: number;
  readonly paraSpacing?: number;
  readonly letterSpacing?: number;
  readonly marginTop?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly marginRight?: number;
  readonly dualPageGap?: number;
  readonly flowMode?: ReaderFlowMode;
  readonly pageMode?: ReaderPageMode;
  readonly pageTurnEffect?: ReaderPageTurnEffect;
  readonly pageTurnSpeed?: number;
  readonly ttsSource?: ReaderTtsSource;
  readonly ttsRate?: number;
  readonly imagePagination?: ReaderImagePagination;
  readonly showTextConversion?: boolean;
  readonly showTocButton?: boolean;
  readonly showChapterButtons?: boolean;
  readonly showVocabularyButton?: boolean;
  readonly showTtsButton?: boolean;
  readonly showAnnotationButton?: boolean;
  readonly toolbarOrder?: readonly ReaderToolbarItem[];
  readonly showPageInfo?: boolean;
  readonly showReaderJumpBack?: boolean;
  readonly readerJumpBackDismissMode?: ReaderJumpBackDismissMode;
  readonly readerJumpBackDismissSeconds?: number;
  readonly readerJumpBackDismissPages?: number;
  readonly readerJumpBackIconSizePx?: number;
  readonly readerJumpBackPositionX?: number;
  readonly readerJumpBackPositionY?: number;
}

/**
 * These are menu presentation choices, not selected text, highlights, or book
 * content. The imperative reader page remains responsible for rendering the
 * menu next to a selection.
 */
export type HighlightMenuDisplayMode = "text" | "icon" | "both";
export type HighlightMenuLayout = "grid" | "row";
export type HighlightMenuSize = "small" | "medium" | "large";
export type HighlightWebSearchEngine = "baidu" | "google";
export type HighlightMenuActionKey =
  | "web" | "dict" | "translate" | "copy" | "highlight" | "correct"
  | "excerpt" | "cross" | "semantic" | "aiReader" | "note" | "bookmark";

export interface HighlightMenuActionPreference {
  readonly key: HighlightMenuActionKey;
  readonly visible: boolean;
}

export interface ReaderHighlightMenuPreferences {
  readonly displayMode: HighlightMenuDisplayMode;
  readonly layout: HighlightMenuLayout;
  readonly size: HighlightMenuSize;
  readonly webSearchEngine: HighlightWebSearchEngine;
  readonly colorful: boolean;
  /** Ordered, bounded action metadata only; no selected text enters feature state. */
  readonly actions: readonly HighlightMenuActionPreference[];
}

export interface ReaderHighlightMenuPreferencesPatch {
  readonly displayMode?: HighlightMenuDisplayMode;
  readonly layout?: HighlightMenuLayout;
  readonly size?: HighlightMenuSize;
  readonly webSearchEngine?: HighlightWebSearchEngine;
  readonly colorful?: boolean;
  readonly actions?: readonly HighlightMenuActionPreference[];
}

/**
 * The text fields are bounded display values supplied by the host. They are
 * intentionally transient: this package never puts them in browser storage,
 * URLs, logs, history, or test fixtures.
 */
export interface ReaderNoteSummary {
  readonly id: string;
  readonly locationLabel: string;
  readonly excerpt: string;
  readonly note: string;
}

/** A search result may name a chapter/page but never a source path or body. */
export interface ReaderSearchHit {
  readonly id: string;
  readonly locationLabel: string;
  readonly excerpt: string;
}

/**
 * This event set is deliberately low frequency. An adapter may listen to the
 * imperative reader engine internally, but must not forward progress frames,
 * scroll positions, selections, pagination measurements, or pointer moves.
 */
export type ReaderShellEvent =
  | { readonly type: "engine-ready"; readonly engine: "epub" | "pdf" }
  | { readonly type: "engine-unavailable" }
  | { readonly type: "layout-idle" }
  | { readonly type: "open-panel"; readonly panel: ReaderShellPanel }
  | { readonly type: "close-requested" };

export type ReaderShellUnlisten = () => void | Promise<void>;

/**
 * Narrow command surface that maps to the imperative reader port. Sending a
 * command does not let callers mount, inspect, or render the reading iframe.
 */
export type ReaderShellCommand =
  | { readonly type: "previous-page" }
  | { readonly type: "next-page" }
  | { readonly type: "open-table-of-contents" }
  | { readonly type: "toggle-immersive" };

export class ReaderShellPortError extends Error {
  public constructor(public readonly kind: "offline" | "unavailable" | "invalid-input") {
    super(kind);
    this.name = "ReaderShellPortError";
  }
}

export interface ReaderShellPort {
  loadPreferences(signal: AbortSignal): Promise<ReaderShellPreferences>;
  savePreferences(patch: ReaderShellPreferencesPatch, signal: AbortSignal): Promise<ReaderShellPreferences>;
  loadAppearance(scope: ReaderAppearanceScope, signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  saveAppearance(scope: ReaderAppearanceScope, patch: ReaderShellPreferencesPatch, signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  clearBookAppearance(signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  listCustomPalettes(signal: AbortSignal): Promise<readonly ReaderCustomPalette[]>;
  createCustomPalette(name: string, scope: ReaderAppearanceScope, signal: AbortSignal): Promise<readonly ReaderCustomPalette[]>;
  renameCustomPalette(id: string, name: string, signal: AbortSignal): Promise<readonly ReaderCustomPalette[]>;
  deleteCustomPalette(id: string, signal: AbortSignal): Promise<readonly ReaderCustomPalette[]>;
  reorderCustomPalettes(ids: readonly string[], signal: AbortSignal): Promise<readonly ReaderCustomPalette[]>;
  applyPalette(paletteId: string, scope: ReaderAppearanceScope, signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  cacheBackgroundImage(file: File, scope: ReaderAppearanceScope, signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  clearBackgroundImage(scope: ReaderAppearanceScope, signal: AbortSignal): Promise<ReaderAppearanceSnapshot>;
  loadClickZoneConfiguration(signal: AbortSignal): Promise<ReaderClickZoneConfiguration>;
  saveClickZoneConfiguration(configuration: ReaderClickZoneConfiguration, signal: AbortSignal): Promise<ReaderClickZoneConfiguration>;
  listReaderFonts(signal: AbortSignal): Promise<readonly ReaderOptionalFontStatus[]>;
  downloadReaderFont(fontId: ReaderOptionalFontId, signal: AbortSignal): Promise<Pick<ReaderOptionalFontStatus, "id" | "installed" | "downloadBytes">>;

  loadHighlightMenuPreferences(signal: AbortSignal): Promise<ReaderHighlightMenuPreferences>;
  saveHighlightMenuPreferences(patch: ReaderHighlightMenuPreferencesPatch, signal: AbortSignal): Promise<ReaderHighlightMenuPreferences>;

  listNotes(signal: AbortSignal): Promise<readonly ReaderNoteSummary[]>;
  saveNote(noteId: string, note: string, signal: AbortSignal): Promise<readonly ReaderNoteSummary[]>;
  deleteNote(noteId: string, signal: AbortSignal): Promise<readonly ReaderNoteSummary[]>;
  openNote(noteId: string, signal: AbortSignal): Promise<void>;

  searchInCurrentBook(query: string, signal: AbortSignal): Promise<readonly ReaderSearchHit[]>;
  openSearchHit(hitId: string, signal: AbortSignal): Promise<void>;
  clearSearchHighlights(signal: AbortSignal): Promise<void>;

  sendReaderCommand(command: ReaderShellCommand, signal: AbortSignal): Promise<void>;
  listenForShellEvents(listener: (event: ReaderShellEvent) => void): Promise<ReaderShellUnlisten>;
  closeReaderWindow(signal: AbortSignal): Promise<void>;
}
