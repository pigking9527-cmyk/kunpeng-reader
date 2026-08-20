export const READER_RECOMMENDATION_STORAGE_KEY = "readerEndRecommendationsV1";
export const READER_RECOMMENDATION_MIN_WORDS_STORAGE_KEY = "readerRecommendationMinWordsV1";
export const READER_RECOMMENDATION_PREFETCH_PROGRESS_PERCENT = 90;
export const READER_RECOMMENDATION_DEFAULT_MIN_WORDS = 10_000;
export const READER_RECOMMENDATION_MAX_MIN_WORDS = 1_000_000;

interface StorageLike {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

interface RecommendationElement {
  checked: boolean;
  value: string;
  readonly dataset: Record<string, string | undefined>;
  readonly classList: Pick<DOMTokenList, "add" | "remove">;
  readonly addEventListener: (
    type: string,
    listener: (event: RecommendationEvent) => void,
  ) => void;
  readonly focus: () => void;
  readonly select: () => void;
}

interface RecommendationEvent {
  readonly target: unknown;
  readonly preventDefault: () => void;
  readonly stopPropagation: () => void;
}

interface RecommendationDocument {
  readonly getElementById: (id: string) => RecommendationElement | null;
}

interface RecommendationImage {
  decoding: string;
  src: string;
}

type RecommendationImageConstructor = new () => RecommendationImage;
type RecommendationInvoke = (
  command: string,
  arguments_?: Readonly<Record<string, unknown>>,
) => unknown;

export interface RecommendationBook extends Readonly<Record<string, unknown>> {
  readonly cover?: unknown;
}

export interface RecommendationPosition {
  readonly progress?: unknown;
}

export interface RecommendationPrefetcherOptions {
  readonly invoke?: unknown;
  readonly enabled?: unknown;
  readonly minimumWords?: unknown;
  readonly loadWordCount?: unknown;
  readonly ImageCtor?: unknown;
}

export interface RecommendationPrefetcher {
  readonly reset: (bookId: unknown, metadata?: Readonly<Record<string, unknown>>) => void;
  readonly observe: (position?: RecommendationPosition) => Promise<unknown[] | null> | null;
  readonly loadAtEnd: () => Promise<unknown[] | null>;
}

interface RecommendationRuntime extends Record<string, unknown> {
  readonly document?: RecommendationDocument;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function runtimeStorage(target: RecommendationRuntime): StorageLike | null {
  try {
    return target.localStorage as StorageLike;
  } catch {
    return null;
  }
}

function getRecommendationStorage(
  target: RecommendationRuntime,
  storage?: unknown,
): StorageLike | null {
  if (storage) return storage as StorageLike;
  return runtimeStorage(target);
}

export function normalizeRecommendationMinimumWords(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return READER_RECOMMENDATION_DEFAULT_MIN_WORDS;
  return Math.max(
    0,
    Math.min(READER_RECOMMENDATION_MAX_MIN_WORDS, Math.round(number)),
  );
}

function createRecommendationSettingsApi(target: RecommendationRuntime) {
  function isEnabled(storage?: unknown): boolean {
    try {
      return getRecommendationStorage(target, storage)?.getItem(
        READER_RECOMMENDATION_STORAGE_KEY,
      ) !== "0";
    } catch {
      return true;
    }
  }

  function minimumWords(storage?: unknown): number {
    try {
      const saved = getRecommendationStorage(target, storage)?.getItem(
        READER_RECOMMENDATION_MIN_WORDS_STORAGE_KEY,
      );
      return saved === null || saved === undefined
        ? READER_RECOMMENDATION_DEFAULT_MIN_WORDS
        : normalizeRecommendationMinimumWords(saved);
    } catch {
      return READER_RECOMMENDATION_DEFAULT_MIN_WORDS;
    }
  }

  function setMinimumWords(value: unknown, storage?: unknown): number {
    const normalized = normalizeRecommendationMinimumWords(value);
    try {
      getRecommendationStorage(target, storage)?.setItem(
        READER_RECOMMENDATION_MIN_WORDS_STORAGE_KEY,
        String(normalized),
      );
    } catch {
      // The current settings view still reflects the normalized input.
    }
    return normalized;
  }

  function init(root?: unknown, storage?: unknown): RecommendationElement | null {
    const documentRoot = (root || target.document) as RecommendationDocument | undefined;
    const checkbox = documentRoot?.getElementById("set-end-recommendations");
    if (!checkbox || checkbox.dataset.recommendationSettingReady === "1") {
      return checkbox || null;
    }

    if (!documentRoot) return null;
    const localStorage = getRecommendationStorage(target, storage);
    const gear = documentRoot.getElementById("end-recommendations-gear");
    const settingsModal = documentRoot.getElementById("reader-recommendation-settings-modal");
    const closeButton = documentRoot.getElementById("reader-recommendation-settings-close");
    const input = documentRoot.getElementById("reader-recommendation-min-words");

    checkbox.checked = isEnabled(localStorage);
    checkbox.dataset.recommendationSettingReady = "1";
    checkbox.addEventListener("change", () => {
      try {
        localStorage?.setItem(
          READER_RECOMMENDATION_STORAGE_KEY,
          checkbox.checked ? "1" : "0",
        );
      } catch {
        // Preserve the current-session checkbox state if storage is unavailable.
      }
    });

    function reflectMinimumWords(): void {
      if (input) input.value = String(minimumWords(localStorage) / 10_000);
    }

    function closeSettings(): void {
      settingsModal?.classList.remove("show");
    }

    reflectMinimumWords();
    input?.addEventListener("change", () => {
      const tenThousands = Number(input.value);
      const saved = setMinimumWords(tenThousands * 10_000, localStorage);
      input.value = String(saved / 10_000);
    });
    gear?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      reflectMinimumWords();
      settingsModal?.classList.add("show");
      input?.focus();
      input?.select();
    });
    closeButton?.addEventListener("click", closeSettings);
    settingsModal?.addEventListener("click", (event) => {
      if (event.target === settingsModal) closeSettings();
    });
    return checkbox;
  }

  function recommendationLengthEligible(
    wordCount: unknown,
    threshold: unknown = minimumWords(),
  ): boolean {
    const required = normalizeRecommendationMinimumWords(threshold);
    if (required === 0) return true;
    return Number(wordCount || 0) > required;
  }

  function shouldPrefetch(position: RecommendationPosition = {}): boolean {
    return Number(position.progress || 0) >= READER_RECOMMENDATION_PREFETCH_PROGRESS_PERCENT;
  }

  function createPrefetcher(
    options: RecommendationPrefetcherOptions = {},
  ): RecommendationPrefetcher | null {
    const invoke = options.invoke;
    const recommendationEnabled = options.enabled || isEnabled;
    const getMinimumWords = options.minimumWords || minimumWords;
    const typedInvoke = invoke as RecommendationInvoke;
    const loadWordCount = options.loadWordCount || (() => {
      const response = typedInvoke("book_meta") as PromiseLike<unknown>;
      return response.then((metadata) => isRecord(metadata) ? metadata.word_count : undefined);
    });
    const ImageCtor = (options.ImageCtor || target.Image) as RecommendationImageConstructor | undefined;
    if (typeof invoke !== "function") return null;

    let bookId = "";
    let cached: unknown[] | null = null;
    let pending: Promise<unknown[] | null> | null = null;
    let failed: unknown = null;
    let bookWordCount = 0;
    let wordCountPending: Promise<number> | null = null;

    function reset(
      nextBookId: unknown,
      metadata: Readonly<Record<string, unknown>> = {},
    ): void {
      bookId = String(nextBookId || "");
      bookWordCount = Number(metadata.wordCount || 0);
      cached = null;
      pending = null;
      failed = null;
      wordCountPending = null;
    }

    function warmCovers(list: readonly unknown[]): void {
      if (typeof ImageCtor !== "function") return;
      list.forEach((book) => {
        const record = isRecord(book) ? book : null;
        if (!record?.cover) return;
        const image = new ImageCtor();
        image.decoding = "async";
        image.src = String(record.cover);
      });
    }

    function ensureWordCount(): Promise<number> {
      if (
        bookWordCount > 0 ||
        normalizeRecommendationMinimumWords(
          (getMinimumWords as () => unknown)(),
        ) === 0
      ) {
        return Promise.resolve(bookWordCount);
      }
      if (wordCountPending) return wordCountPending;
      const requestedBookId = bookId;
      const request: Promise<number> = Promise.resolve((loadWordCount as () => unknown)())
        .then((value) => {
          const count = Math.max(0, Number(value || 0));
          if (bookId === requestedBookId) bookWordCount = count;
          return count;
        })
        .finally(() => {
          if (bookId === requestedBookId && wordCountPending === request) {
            wordCountPending = null;
          }
        });
      wordCountPending = request;
      return request;
    }

    async function ensureEligible(): Promise<boolean> {
      const threshold = normalizeRecommendationMinimumWords(
        (getMinimumWords as () => unknown)(),
      );
      if (threshold === 0) return true;
      return recommendationLengthEligible(await ensureWordCount(), threshold);
    }

    function start(retry = false): Promise<unknown[] | null> {
      if (!bookId || !(recommendationEnabled as () => unknown)()) {
        return Promise.resolve(null);
      }
      if (pending) return pending;
      if (failed && !retry) return Promise.reject(failed);
      if (retry) failed = null;

      const requestedBookId = bookId;
      const request: Promise<unknown[] | null> = ensureEligible()
        .then((eligible) => {
          if (!eligible || bookId !== requestedBookId) return null;
          if (cached) return cached;
          return Promise.resolve(
            typedInvoke("similar_books", { id: requestedBookId }),
          ).then((value) => {
            const list = Array.isArray(value) ? value.slice(0, 5) : [];
            if (bookId !== requestedBookId) return null;
            cached = list;
            failed = null;
            warmCovers(list);
            return list;
          });
        })
        .catch((error: unknown) => {
          if (bookId === requestedBookId) failed = error;
          throw error;
        })
        .finally(() => {
          if (bookId === requestedBookId && pending === request) pending = null;
        });
      pending = request;
      return request;
    }

    function observe(
      position: RecommendationPosition = {},
    ): Promise<unknown[] | null> | null {
      if (
        !(recommendationEnabled as () => unknown)() ||
        !shouldPrefetch(position) ||
        pending ||
        failed
      ) {
        return null;
      }
      const threshold = normalizeRecommendationMinimumWords(
        (getMinimumWords as () => unknown)(),
      );
      if (
        bookWordCount > 0 &&
        !recommendationLengthEligible(bookWordCount, threshold)
      ) {
        return null;
      }
      if (cached && recommendationLengthEligible(bookWordCount, threshold)) return null;
      return start().catch(() => []);
    }

    async function loadAtEnd(): Promise<unknown[] | null> {
      if (!(recommendationEnabled as () => unknown)()) return null;
      try {
        return await start();
      } catch {
        return start(true);
      }
    }

    return Object.freeze({ reset, observe, loadAtEnd });
  }

  return Object.freeze({
    STORAGE_KEY: READER_RECOMMENDATION_STORAGE_KEY,
    MIN_WORDS_STORAGE_KEY: READER_RECOMMENDATION_MIN_WORDS_STORAGE_KEY,
    PREFETCH_PROGRESS_PERCENT: READER_RECOMMENDATION_PREFETCH_PROGRESS_PERCENT,
    DEFAULT_MIN_RECOMMENDATION_WORDS: READER_RECOMMENDATION_DEFAULT_MIN_WORDS,
    MAX_MIN_RECOMMENDATION_WORDS: READER_RECOMMENDATION_MAX_MIN_WORDS,
    isEnabled,
    minimumWords,
    setMinimumWords,
    recommendationLengthEligible,
    shouldPrefetch,
    createPrefetcher,
    init,
  });
}

export type ReaderRecommendationSettingsApi = ReturnType<typeof createRecommendationSettingsApi>;

export function installReaderRecommendationSettings(
  target: RecommendationRuntime,
): ReaderRecommendationSettingsApi {
  const api = createRecommendationSettingsApi(target);
  target.ReaderRecommendationSettings = api;
  if (target.document) api.init(target.document);
  return api;
}
