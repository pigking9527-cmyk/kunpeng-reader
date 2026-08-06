(function (global) {
  "use strict";

  const STORAGE_KEY = "readerEndRecommendationsV1";
  const MIN_WORDS_STORAGE_KEY = "readerRecommendationMinWordsV1";
  const PREFETCH_PROGRESS_PERCENT = 90;
  const DEFAULT_MIN_RECOMMENDATION_WORDS = 10000;
  const MAX_MIN_RECOMMENDATION_WORDS = 1000000;

  function getStorage(storage) {
    if (storage) return storage;
    try {
      return global.localStorage;
    } catch (_) {
      return null;
    }
  }

  function isEnabled(storage) {
    try {
      return getStorage(storage)?.getItem(STORAGE_KEY) !== "0";
    } catch (_) {
      return true;
    }
  }

  function normalizeMinimumWords(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_MIN_RECOMMENDATION_WORDS;
    return Math.max(0, Math.min(MAX_MIN_RECOMMENDATION_WORDS, Math.round(number)));
  }

  function minimumWords(storage) {
    try {
      const saved = getStorage(storage)?.getItem(MIN_WORDS_STORAGE_KEY);
      return saved === null || saved === undefined
        ? DEFAULT_MIN_RECOMMENDATION_WORDS
        : normalizeMinimumWords(saved);
    } catch (_) {
      return DEFAULT_MIN_RECOMMENDATION_WORDS;
    }
  }

  function setMinimumWords(value, storage) {
    const normalized = normalizeMinimumWords(value);
    try {
      getStorage(storage)?.setItem(MIN_WORDS_STORAGE_KEY, String(normalized));
    } catch (_) {
      // 本地存储不可用时仍允许当前设置页显示输入值。
    }
    return normalized;
  }

  function init(root, storage) {
    const documentRoot = root || global.document;
    const checkbox = documentRoot?.getElementById("set-end-recommendations");
    if (!checkbox || checkbox.dataset.recommendationSettingReady === "1") return checkbox || null;

    const localStorage = getStorage(storage);
    const gear = documentRoot.getElementById("end-recommendations-gear");
    const settingsModal = documentRoot.getElementById("reader-recommendation-settings-modal");
    const closeButton = documentRoot.getElementById("reader-recommendation-settings-close");
    const input = documentRoot.getElementById("reader-recommendation-min-words");

    checkbox.checked = isEnabled(localStorage);
    checkbox.dataset.recommendationSettingReady = "1";
    checkbox.addEventListener("change", () => {
      try {
        localStorage?.setItem(STORAGE_KEY, checkbox.checked ? "1" : "0");
      } catch (_) {
        // 本地存储不可用时保留当前会话中的勾选状态。
      }
    });

    function reflectMinimumWords() {
      if (input) input.value = String(minimumWords(localStorage) / 10000);
    }

    function closeSettings() {
      settingsModal?.classList.remove("show");
    }

    reflectMinimumWords();
    input?.addEventListener("change", () => {
      const tenThousands = Number(input.value);
      const saved = setMinimumWords(tenThousands * 10000, localStorage);
      input.value = String(saved / 10000);
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

  function recommendationLengthEligible(wordCount, threshold = minimumWords()) {
    const required = normalizeMinimumWords(threshold);
    if (required === 0) return true;
    return Number(wordCount || 0) > required;
  }

  function shouldPrefetch(position = {}) {
    return Number(position.progress || 0) >= PREFETCH_PROGRESS_PERCENT;
  }

  function createPrefetcher(options = {}) {
    const invoke = options.invoke;
    const recommendationEnabled = options.enabled || isEnabled;
    const getMinimumWords = options.minimumWords || minimumWords;
    const loadWordCount = options.loadWordCount || (() => invoke("book_meta").then((meta) => meta?.word_count));
    const ImageCtor = options.ImageCtor || global.Image;
    if (typeof invoke !== "function") return null;

    let bookId = "";
    let cached = null;
    let pending = null;
    let failed = null;
    let bookWordCount = 0;
    let wordCountPending = null;

    function reset(nextBookId, metadata = {}) {
      bookId = String(nextBookId || "");
      bookWordCount = Number(metadata.wordCount || 0);
      cached = null;
      pending = null;
      failed = null;
      wordCountPending = null;
    }

    function warmCovers(list) {
      if (typeof ImageCtor !== "function") return;
      list.forEach((book) => {
        if (!book?.cover) return;
        const image = new ImageCtor();
        image.decoding = "async";
        image.src = book.cover;
      });
    }

    function ensureWordCount() {
      if (bookWordCount > 0 || normalizeMinimumWords(getMinimumWords()) === 0) {
        return Promise.resolve(bookWordCount);
      }
      if (wordCountPending) return wordCountPending;
      const requestedBookId = bookId;
      const request = Promise.resolve(loadWordCount())
        .then((value) => {
          const count = Math.max(0, Number(value || 0));
          if (bookId === requestedBookId) bookWordCount = count;
          return count;
        })
        .finally(() => {
          if (bookId === requestedBookId && wordCountPending === request) wordCountPending = null;
        });
      wordCountPending = request;
      return request;
    }

    async function ensureEligible() {
      const threshold = normalizeMinimumWords(getMinimumWords());
      if (threshold === 0) return true;
      return recommendationLengthEligible(await ensureWordCount(), threshold);
    }

    function start(retry = false) {
      if (!bookId || !recommendationEnabled()) return Promise.resolve(null);
      if (pending) return pending;
      if (failed && !retry) return Promise.reject(failed);
      if (retry) failed = null;

      const requestedBookId = bookId;
      const request = ensureEligible()
        .then((eligible) => {
          if (!eligible || bookId !== requestedBookId) return null;
          if (cached) return cached;
          return Promise.resolve(invoke("similar_books", { id: requestedBookId })).then((value) => {
            const list = Array.isArray(value) ? value.slice(0, 5) : [];
            if (bookId !== requestedBookId) return null;
            cached = list;
            failed = null;
            warmCovers(list);
            return list;
          });
        })
        .catch((error) => {
          if (bookId === requestedBookId) failed = error;
          throw error;
        })
        .finally(() => {
          if (bookId === requestedBookId && pending === request) pending = null;
        });
      pending = request;
      return request;
    }

    function observe(position) {
      if (!recommendationEnabled() || !shouldPrefetch(position) || pending || failed) return null;
      const threshold = normalizeMinimumWords(getMinimumWords());
      if (bookWordCount > 0 && !recommendationLengthEligible(bookWordCount, threshold)) return null;
      if (cached && recommendationLengthEligible(bookWordCount, threshold)) return null;
      return start().catch(() => []);
    }

    async function loadAtEnd() {
      if (!recommendationEnabled()) return null;
      try {
        return await start();
      } catch (_) {
        return start(true);
      }
    }

    return Object.freeze({ reset, observe, loadAtEnd });
  }

  global.ReaderRecommendationSettings = Object.freeze({
    STORAGE_KEY,
    MIN_WORDS_STORAGE_KEY,
    PREFETCH_PROGRESS_PERCENT,
    DEFAULT_MIN_RECOMMENDATION_WORDS,
    MAX_MIN_RECOMMENDATION_WORDS,
    isEnabled,
    minimumWords,
    setMinimumWords,
    recommendationLengthEligible,
    shouldPrefetch,
    createPrefetcher,
    init,
  });
  if (global.document) init(global.document);
})(typeof window !== "undefined" ? window : globalThis);
