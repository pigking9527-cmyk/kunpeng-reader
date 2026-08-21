export const READER_HIGHLIGHT_MENU_PREFERENCES_KEY = "readerHighlightMenuPreferencesV1";
export const READER_DICTIONARY_ENHANCEMENT_SETTINGS_KEY = "dictEnhancementSettingsV2";

export type ReaderHighlightDisplayMode = "both" | "text" | "icon";
export type ReaderHighlightLayout = "row" | "grid";
export type ReaderHighlightSize = "small" | "medium" | "large";
export type ReaderWebSearchEngine = "baidu" | "google";

export interface ReaderHighlightActionPreference {
  readonly key: string;
  readonly visible: boolean;
}

export interface ReaderHighlightMenuPreferences {
  readonly displayMode?: ReaderHighlightDisplayMode;
  readonly layout?: ReaderHighlightLayout;
  readonly size?: ReaderHighlightSize;
  readonly webSearchEngine?: ReaderWebSearchEngine;
  readonly colorful?: boolean;
  readonly actions?: readonly ReaderHighlightActionPreference[];
}

export interface ReaderDictionaryEnhancementSettings {
  readonly plain: boolean;
  readonly sense: boolean;
  readonly context: boolean;
  readonly hypernyms: boolean;
  readonly synonyms: boolean;
  readonly antonyms: boolean;
}

export type ReaderDictionaryEnhancementKey = keyof ReaderDictionaryEnhancementSettings;

export interface ReaderDictionaryEnhancementData {
  readonly plain?: unknown;
  readonly sense?: unknown;
  readonly example_note?: unknown;
  readonly hypernyms?: unknown;
  readonly synonyms?: unknown;
  readonly antonyms?: unknown;
}

export interface ReaderDictionaryResultLike {
  readonly hownet?: ReaderDictionaryEnhancementData | null;
}

export const DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS: ReaderDictionaryEnhancementSettings =
  Object.freeze({
    plain: false,
    sense: false,
    context: false,
    hypernyms: false,
    synonyms: false,
    antonyms: false,
  });

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReaderHighlightMenuPreferences(raw: string | null): Readonly<Record<string, unknown>> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Six dictionary options intentionally restore only explicit true values. */
export function parseReaderDictionaryEnhancementSettings(
  raw: string | null,
): ReaderDictionaryEnhancementSettings {
  if (!raw) return DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS;
    return Object.freeze({
      plain: value.plain === true,
      sense: value.sense === true,
      context: value.context === true,
      hypernyms: value.hypernyms === true,
      synonyms: value.synonyms === true,
      antonyms: value.antonyms === true,
    });
  } catch {
    return DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS;
  }
}

export function isReaderDictionaryEnhancementAvailable(
  result: ReaderDictionaryResultLike | null | undefined,
  key: ReaderDictionaryEnhancementKey,
): boolean {
  const hownet = result?.hownet;
  if (!hownet) return false;
  const field = key === "context" ? "example_note" : key;
  const value = hownet[field];
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim().length > 0;
  return value !== null && value !== undefined;
}

export interface ReaderDictionaryToggleResult {
  readonly settings: ReaderDictionaryEnhancementSettings;
  readonly enabled: boolean;
  readonly unavailable: boolean;
}

/**
 * Enabling is conditional on data for the current lookup. Unavailable options
 * are immediately persisted as false, exactly as the classic page requires.
 */
export function toggleReaderDictionaryEnhancement(
  settings: ReaderDictionaryEnhancementSettings,
  key: ReaderDictionaryEnhancementKey,
  requested: boolean,
  currentResult: ReaderDictionaryResultLike | null | undefined,
): ReaderDictionaryToggleResult {
  const available = !requested || isReaderDictionaryEnhancementAvailable(currentResult, key);
  const enabled = requested && available;
  return Object.freeze({
    settings: Object.freeze({ ...settings, [key]: enabled }),
    enabled,
    unavailable: requested && !available,
  });
}
