import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface VocabEntry {
  readonly word: unknown;
  readonly lang: unknown;
  readonly phonetic?: unknown;
  readonly count?: unknown;
  readonly def?: unknown;
  readonly def_en?: unknown;
  readonly level?: unknown;
  readonly last_at?: unknown;
}

interface WordPackState extends Record<string, unknown> {
  readonly total?: unknown;
  readonly cached?: unknown;
  readonly bytes?: unknown;
  readonly running?: unknown;
  readonly message?: unknown;
  readonly current?: unknown;
}

type VocabCommands = {
  word_tts_cache_size: { readonly result: unknown };
  word_tts_pack_status: { readonly result: WordPackState };
  word_tts: {
    readonly args: { readonly text: unknown; readonly cache: boolean };
    readonly result: { readonly audio: unknown };
  };
  vocab_list: {
    readonly args: { readonly lang: string };
    readonly result: VocabEntry[];
  };
  vocab_set_level: {
    readonly args: { readonly word: unknown; readonly lang: unknown; readonly level: unknown };
    readonly result: unknown;
  };
  vocab_remove: {
    readonly args: { readonly word: unknown; readonly lang: unknown };
    readonly result: unknown;
  };
  pause_word_tts_pack: { readonly result: unknown };
  clear_word_tts_cache: { readonly result: unknown };
  start_word_tts_pack: { readonly result: unknown };
  clear_word_tts_pack: { readonly result: unknown };
};

type VerifiedVocabCommands = VocabCommands extends TauriCommandMap ? VocabCommands : never;

interface ReaderShellApi {
  readonly OVERLAY: { readonly VOCAB: unknown };
  setOverlay(overlay: unknown, open: boolean): void;
  registerOverlay(
    overlay: unknown,
    handlers: { readonly onOpen: () => void; readonly onClose: () => void },
  ): void;
  isOverlay(overlay: unknown): boolean;
}

interface ReaderI18nApi {
  t?(key: string, values?: Readonly<Record<string, unknown>>): string;
}

interface VocabRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Storage;
  readonly ReaderShell: ReaderShellApi;
  readonly ReaderI18n?: ReaderI18nApi;
  readonly speechSynthesis?: SpeechSynthesis;
  readonly Audio: typeof Audio;
  readonly SpeechSynthesisUtterance: typeof SpeechSynthesisUtterance;
  readonly confirm: (message?: string) => boolean;
  readonly alert: (message?: unknown) => void;
  readonly pauseReadTracking?: (source: string) => void;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  addEventListener(type: string, listener: () => void): void;
  vocabAutoSpeak?: boolean;
  prefetchMicrosoftWord?: (word: unknown) => void;
  speakMicrosoftWord?: (word: unknown) => void;
}

export interface VocabUiController {
  readonly applyVocabSettings: () => void;
  readonly formatCacheSize: (bytes: number) => string;
  readonly prefetchMicrosoftWord: (word: unknown) => void;
  readonly refreshWordAudioCacheSize: () => void;
  readonly refreshWordPackStatus: () => Promise<WordPackState>;
  readonly renderVocab: () => void;
  readonly renderWordPackState: (message?: unknown) => void;
  readonly setVocab: (open: unknown) => void;
  readonly setVocabSort: (sort: string) => void;
  readonly setVocabTab: (lang: string) => void;
  readonly speakMicrosoftWord: (word: unknown) => void;
  readonly speakSystemWord: (word: unknown) => void;
  readonly speakVocabWord: (word: unknown) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): VocabRuntime | null {
  const runtime = record(value);
  if (
    !runtime ||
    !record(runtime.document) ||
    !record(runtime.localStorage) ||
    !record(runtime.ReaderShell) ||
    typeof runtime.Audio !== "function" ||
    typeof runtime.SpeechSynthesisUtterance !== "function" ||
    typeof runtime.confirm !== "function" ||
    typeof runtime.alert !== "function" ||
    typeof runtime.clearInterval !== "function" ||
    typeof runtime.setInterval !== "function" ||
    typeof runtime.addEventListener !== "function"
  ) {
    return null;
  }
  return runtime as unknown as VocabRuntime;
}

function requiredElement<TElement extends HTMLElement>(document: Document, id: string): TElement {
  return document.getElementById(id) as TElement;
}

export function initializeVocabUi(
  runtime: VocabRuntime,
  transport: TauriTransport,
): VocabUiController {
  const api = createTauriApi<VerifiedVocabCommands>(transport);
  const document = runtime.document;
  const storage = runtime.localStorage;
  const vocabEl = requiredElement<HTMLElement>(document, "vocab");
  const vocabPane = requiredElement<HTMLElement>(document, "vocab-pane");
  const vocabSettings = requiredElement<HTMLElement>(document, "vocab-settings");
  const vocabGear = requiredElement<HTMLElement>(document, "vocab-gear");
  const vocabCountToggle = requiredElement<HTMLInputElement>(document, "vocab-count-toggle");
  const vocabSortTime = requiredElement<HTMLElement>(document, "vsort-time");
  const vocabSortCount = requiredElement<HTMLElement>(document, "vsort-count");
  const dictAutoSpeakToggle = requiredElement<HTMLInputElement>(document, "dict-auto-speak-toggle");
  const wordAudioCacheToggle = requiredElement<HTMLInputElement>(document, "word-audio-cache-toggle");
  const wordAudioCacheInfo = requiredElement<HTMLElement>(document, "word-audio-cache-info");
  const wordAudioCacheSize = requiredElement<HTMLElement>(document, "word-audio-cache-size");
  const wordAudioCacheDelete = requiredElement<HTMLElement>(document, "word-audio-cache-delete");
  const wordAudioPack = requiredElement<HTMLElement>(document, "word-audio-pack");
  const wordPackCount = requiredElement<HTMLElement>(document, "word-pack-count");
  const wordPackProgress = requiredElement<HTMLProgressElement>(document, "word-pack-progress");
  const wordPackMeta = requiredElement<HTMLElement>(document, "word-pack-meta");
  const wordPackToggle = requiredElement<HTMLButtonElement>(document, "word-pack-toggle");
  const wordPackDelete = requiredElement<HTMLButtonElement>(document, "word-pack-delete");
  const readerVocabText = (
    key: string,
    fallback: string,
    values?: Readonly<Record<string, unknown>>,
  ): string => {
    const value = runtime.ReaderI18n?.t?.(key, values);
    return value && value !== key ? value : fallback;
  };
  let vocabLang = "zh";
  let vocabShowCount = storage.getItem("vocabShowCount") !== "0";
  let vocabSort = storage.getItem("vocabSort") || "time";
  let vocabAutoSpeak = storage.getItem("vocabAutoSpeak") !== "0";
  let wordAudioDiskCache = storage.getItem("wordAudioDiskCache") === "1";
  let wordAudio: HTMLAudioElement | null = null;
  const wordAudioCache = new Map<string, Promise<unknown>>();
  let wordPackPoll: ReturnType<typeof setInterval> | null = null;
  let wordPackState: WordPackState = { total: 10_000, cached: 0, bytes: 0 };

  const formatCacheSize = (bytes: number): string => {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  };
  const refreshWordAudioCacheSize = (): void => {
    if (!wordAudioDiskCache) return;
    void api
      .invoke("word_tts_cache_size")
      .then((bytes) => {
        wordAudioCacheSize.textContent = readerVocabText("cached", "缓存：{size}", {
          size: formatCacheSize(Number(bytes) || 0),
        });
      })
      .catch(() => {
        wordAudioCacheSize.textContent = readerVocabText(
          "cacheUnavailable",
          "缓存：无法读取",
        );
      });
  };
  const renderWordPackState = (message?: unknown): void => {
    const total = Number(wordPackState.total) || 10_000;
    const cached = Math.min(total, Number(wordPackState.cached) || 0);
    const percent = total ? ((cached / total) * 100).toFixed(1) : "0.0";
    wordPackProgress.max = total;
    wordPackProgress.value = cached;
    wordPackCount.textContent = `${cached} / ${total}`;
    if (message) {
      wordPackMeta.textContent = String(message);
    } else if (wordPackState.running) {
      wordPackMeta.textContent = `${String(wordPackState.message || readerVocabText("creating", "生成中：{current}", { current: wordPackState.current || "" }))} · ${percent}%`;
    } else if (cached >= total) {
      wordPackMeta.textContent = `${readerVocabText("generated", "已完成")} · ${formatCacheSize(Number(wordPackState.bytes) || 0)}`;
    } else if (cached > 0) {
      wordPackMeta.textContent = `${readerVocabText("paused", "已暂停")} · ${percent}% · ${formatCacheSize(Number(wordPackState.bytes) || 0)}`;
    } else {
      wordPackMeta.textContent = "尚未生成";
    }
    wordPackToggle.textContent = wordPackState.running
      ? readerVocabText("pause", "暂停")
      : cached > 0
        ? readerVocabText("resumeCreate", "继续生成")
        : readerVocabText("createAudioPack", "开始生成");
    wordPackToggle.disabled = !wordAudioDiskCache || cached >= total;
    wordPackDelete.disabled = cached === 0 && !wordPackState.running;
  };
  const refreshWordPackStatus = (): Promise<WordPackState> => {
    if (!wordAudioDiskCache) return Promise.resolve(wordPackState);
    return api
      .invoke("word_tts_pack_status")
      .then((status) => {
        wordPackState = status;
        renderWordPackState();
        return status;
      })
      .catch(() => {
        renderWordPackState(
          readerVocabText("cacheReadFailed", "无法读取语音包进度"),
        );
        return wordPackState;
      });
  };
  const ensureWordPackPolling = (): void => {
    if (wordPackPoll) return;
    wordPackPoll = runtime.setInterval(() => {
      if (!wordAudioDiskCache || !vocabSettings.classList.contains("show")) {
        if (wordPackPoll) runtime.clearInterval(wordPackPoll);
        wordPackPoll = null;
        return;
      }
      void refreshWordPackStatus().then((status) => {
        if (!status.running) {
          refreshWordAudioCacheSize();
          if (wordPackPoll) runtime.clearInterval(wordPackPoll);
          wordPackPoll = null;
        }
      });
    }, 2_000);
  };
  const speakSystemWord = (word: unknown): void => {
    try {
      if (!word || !runtime.speechSynthesis) return;
      runtime.speechSynthesis.cancel();
      const utterance = new runtime.SpeechSynthesisUtterance(String(word));
      utterance.lang = "en-US";
      utterance.rate = 0.9;
      const voices = runtime.speechSynthesis.getVoices();
      const voice = voices.find(({ lang }) => /^en[-_]/iu.test(lang) || /^en$/iu.test(lang));
      if (voice) utterance.voice = voice;
      runtime.speechSynthesis.speak(utterance);
    } catch {
      // Speech synthesis is optional in the WebView.
    }
  };
  const loadMicrosoftWord = (word: unknown): Promise<unknown> => {
    const key = String(word || "").trim().toLowerCase();
    if (!key) return Promise.reject(new Error("empty word"));
    const cached = wordAudioCache.get(key);
    if (cached) return cached;
    const request = api
      .invoke("word_tts", { text: word, cache: wordAudioDiskCache })
      .then((response) => {
        if (wordAudioDiskCache) refreshWordAudioCacheSize();
        return response.audio;
      })
      .catch((error: unknown) => {
        wordAudioCache.delete(key);
        throw error;
      });
    wordAudioCache.set(key, request);
    if (wordAudioCache.size > 50) {
      const oldest = wordAudioCache.keys().next().value;
      if (oldest !== undefined) wordAudioCache.delete(oldest);
    }
    return request;
  };
  const prefetchMicrosoftWord = (word: unknown): void => {
    void loadMicrosoftWord(word).catch(() => undefined);
  };
  const speakMicrosoftWord = (word: unknown): void => {
    if (!word) return;
    try {
      runtime.speechSynthesis?.cancel();
      if (wordAudio) {
        wordAudio.pause();
        wordAudio = null;
      }
    } catch {
      // A stopped WebView can reject media cleanup.
    }
    void loadMicrosoftWord(word)
      .then((audioData) => {
        const audio = new runtime.Audio(`data:audio/mpeg;base64,${String(audioData)}`);
        wordAudio = audio;
        audio.onerror = () => speakSystemWord(word);
        return audio.play().catch(() => speakSystemWord(word));
      })
      .catch(() => speakSystemWord(word));
  };
  const speakVocabWord = (word: unknown): void => {
    speakMicrosoftWord(word);
  };
  const applyVocabSettings = (): void => {
    vocabCountToggle.checked = vocabShowCount;
    dictAutoSpeakToggle.checked = vocabAutoSpeak;
    wordAudioCacheToggle.checked = wordAudioDiskCache;
    wordAudioCacheInfo.hidden = !wordAudioDiskCache;
    wordAudioPack.hidden = !wordAudioDiskCache;
    vocabEl.classList.toggle("hide-count", !vocabShowCount);
    vocabSortTime.classList.toggle("active", vocabSort === "time");
    vocabSortCount.classList.toggle("active", vocabSort === "count");
    if (!wordAudioDiskCache) renderWordPackState();
  };
  const setVocab = (open: unknown): void => {
    runtime.ReaderShell.setOverlay(runtime.ReaderShell.OVERLAY.VOCAB, Boolean(open));
  };
  const renderVocab = (): void => {
    void api
      .invoke("vocab_list", { lang: vocabLang })
      .then((source) => {
        vocabPane.innerHTML = "";
        const list = source.slice().sort((left, right) => {
          if (vocabSort === "count") {
            return (
              (Number(right.count) || 0) - (Number(left.count) || 0) ||
              (Number(right.last_at) || 0) - (Number(left.last_at) || 0)
            );
          }
          return (Number(right.last_at) || 0) - (Number(left.last_at) || 0);
        });
        if (!list.length) {
          const empty = document.createElement("div");
          empty.className = "vc-empty";
          empty.textContent = readerVocabText("vocabEmpty", "还没有查过的{language}词", {
            language:
              vocabLang === "zh"
                ? readerVocabText("chinese", "中文")
                : readerVocabText("english", "英文"),
          });
          vocabPane.appendChild(empty);
          return;
        }
        const columns = [document.createElement("div"), document.createElement("div")];
        columns.forEach((column) => {
          column.className = "vc-col";
          vocabPane.appendChild(column);
        });
        list.forEach((item) => {
          const row = document.createElement("div");
          row.className = "vc-item";
          if (item.lang === "en") {
            row.classList.add("vc-speak");
            row.title = readerVocabText("clickToPronounce", "点击播放读音");
            row.addEventListener("click", (event) => {
              const target = event.target as Element | null;
              if (target?.closest(".vc-del") || target?.closest(".vc-level")) return;
              speakVocabWord(item.word);
            });
          }
          const main = document.createElement("div");
          main.className = "vc-main";
          const head = document.createElement("div");
          head.className = "vc-head";
          const word = document.createElement("div");
          word.className = "vc-word";
          word.textContent = String(item.word);
          if (item.phonetic) {
            const phonetic = document.createElement("span");
            phonetic.className = "vc-phon";
            phonetic.textContent = item.lang === "en" ? ` [${String(item.phonetic)}]` : ` ${String(item.phonetic)}`;
            word.appendChild(phonetic);
          }
          const count = document.createElement("span");
          count.className = "vc-cnt";
          count.textContent = item.count ? (item.count as string) : "1";
          const definition = document.createElement("div");
          definition.className = "vc-def";
          definition.textContent = String(item.def || item.def_en || "");
          head.append(word, count);
          main.append(head, definition);
          const levels = document.createElement("div");
          levels.className = "vc-level";
          const choices: ReadonlyArray<readonly [string, number]> = [
            [readerVocabText("unfamiliar", "陌生"), 0],
            [readerVocabText("familiar", "认识"), 1],
            [readerVocabText("mastered", "掌握"), 2],
          ];
          choices.forEach(([label, value]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            button.className = (item.level || 0) === value ? "active" : "";
            button.addEventListener("click", (event) => {
              event.stopPropagation();
              void api
                .invoke("vocab_set_level", {
                  word: item.word,
                  lang: item.lang,
                  level: value,
                })
                .then(renderVocab)
                .catch(() => undefined);
            });
            levels.appendChild(button);
          });
          main.appendChild(levels);
          const remove = document.createElement("button");
          remove.className = "vc-del";
          remove.textContent = "✕";
          remove.title = readerVocabText("removeFromVocabulary", "从生词本删除");
          remove.addEventListener("click", (event) => {
            event.stopPropagation();
            void api
              .invoke("vocab_remove", { word: item.word, lang: item.lang })
              .then(renderVocab)
              .catch(() => undefined);
          });
          row.append(main, remove);
          const target = (columns[0]?.offsetHeight ?? 0) <= (columns[1]?.offsetHeight ?? 0)
            ? columns[0]
            : columns[1];
          target?.appendChild(row);
        });
      })
      .catch(() => undefined);
  };
  const setVocabTab = (lang: string): void => {
    vocabLang = lang;
    requiredElement<HTMLElement>(document, "vtab-zh").classList.toggle("active", lang === "zh");
    requiredElement<HTMLElement>(document, "vtab-en").classList.toggle("active", lang === "en");
    renderVocab();
  };
  runtime.ReaderShell.registerOverlay(runtime.ReaderShell.OVERLAY.VOCAB, {
    onOpen() {
      runtime.pauseReadTracking?.("vocab");
      applyVocabSettings();
      renderVocab();
    },
    onClose() {
      vocabSettings.classList.remove("show");
    },
  });
  requiredElement<HTMLElement>(document, "vtab-zh").addEventListener("click", () => setVocabTab("zh"));
  requiredElement<HTMLElement>(document, "vtab-en").addEventListener("click", () => setVocabTab("en"));
  vocabGear.addEventListener("click", (event) => {
    event.stopPropagation();
    vocabSettings.classList.toggle("show");
    if (vocabSettings.classList.contains("show") && wordAudioDiskCache) {
      refreshWordAudioCacheSize();
      void refreshWordPackStatus().then((status) => {
        if (status.running) ensureWordPackPolling();
      });
    }
  });
  vocabSettings.addEventListener("click", (event) => event.stopPropagation());
  vocabEl.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target?.closest("#vocab-gear") || target?.closest("#vocab-settings")) return;
    vocabSettings.classList.remove("show");
  });
  vocabCountToggle.addEventListener("change", () => {
    vocabShowCount = vocabCountToggle.checked;
    storage.setItem("vocabShowCount", vocabShowCount ? "1" : "0");
    applyVocabSettings();
  });
  dictAutoSpeakToggle.addEventListener("change", () => {
    vocabAutoSpeak = dictAutoSpeakToggle.checked;
    runtime.vocabAutoSpeak = vocabAutoSpeak;
    storage.setItem("vocabAutoSpeak", vocabAutoSpeak ? "1" : "0");
  });
  wordAudioCacheToggle.addEventListener("change", () => {
    wordAudioDiskCache = wordAudioCacheToggle.checked;
    storage.setItem("wordAudioDiskCache", wordAudioDiskCache ? "1" : "0");
    if (!wordAudioDiskCache) void api.invoke("pause_word_tts_pack").catch(() => undefined);
    wordAudioCache.clear();
    applyVocabSettings();
  });
  wordAudioCacheDelete.addEventListener("click", async () => {
    if (!runtime.confirm(readerVocabText("removeAllAudioCache", "删除全部英文单词语音缓存？"))) return;
    await api.invoke("pause_word_tts_pack").catch(() => undefined);
    try {
      await api.invoke("clear_word_tts_cache");
      wordAudioCache.clear();
      await refreshWordPackStatus();
      refreshWordAudioCacheSize();
    } catch (error) {
      runtime.alert(readerVocabText("deleteCacheFailed", "删除语音缓存失败：{error}", { error }));
    }
  });
  wordPackToggle.addEventListener("click", () => {
    if (wordPackState.running) {
      void api.invoke("pause_word_tts_pack").catch(() => undefined);
      renderWordPackState(readerVocabText("pausing", "正在暂停，当前请求完成后停止…"));
      return;
    }
    if (!wordAudioDiskCache) return;
    ensureWordPackPolling();
    void api
      .invoke("start_word_tts_pack")
      .then(refreshWordPackStatus)
      .catch((error: unknown) =>
        runtime.alert(readerVocabText("audioPackFailed", "启动高频词语音包失败：{error}", { error })),
      );
  });
  wordPackDelete.addEventListener("click", async () => {
    if (!runtime.confirm(readerVocabText("removeAudioPack", "删除已生成的高频词语音包？其他查词缓存会保留。"))) return;
    await api.invoke("pause_word_tts_pack").catch(() => undefined);
    try {
      await api.invoke("clear_word_tts_pack");
      wordAudioCache.clear();
      await refreshWordPackStatus();
      refreshWordAudioCacheSize();
    } catch (error) {
      runtime.alert(readerVocabText("deleteAudioPackFailed", "删除高频词语音包失败：{error}", { error }));
    }
  });
  const setVocabSort = (sort: string): void => {
    vocabSort = sort;
    storage.setItem("vocabSort", sort);
    applyVocabSettings();
    renderVocab();
  };
  vocabSortTime.addEventListener("click", () => setVocabSort("time"));
  vocabSortCount.addEventListener("click", () => setVocabSort("count"));
  applyVocabSettings();
  requiredElement<HTMLElement>(document, "vocab-btn").addEventListener("click", () => {
    setVocab(!runtime.ReaderShell.isOverlay(runtime.ReaderShell.OVERLAY.VOCAB));
  });
  runtime.addEventListener("reader-language-changed", () => {
    applyVocabSettings();
    if (runtime.ReaderShell.isOverlay(runtime.ReaderShell.OVERLAY.VOCAB)) renderVocab();
  });

  runtime.vocabAutoSpeak = vocabAutoSpeak;
  runtime.prefetchMicrosoftWord = prefetchMicrosoftWord;
  runtime.speakMicrosoftWord = speakMicrosoftWord;
  return {
    applyVocabSettings,
    formatCacheSize,
    prefetchMicrosoftWord,
    refreshWordAudioCacheSize,
    refreshWordPackStatus,
    renderVocab,
    renderWordPackState,
    setVocab,
    setVocabSort,
    setVocabTab,
    speakMicrosoftWord,
    speakSystemWord,
    speakVocabWord,
  };
}

/** Classic installer replacing `ui/vocab-ui.js`. */
export function installVocabUi(
  target: unknown,
  transport?: TauriTransport,
): VocabUiController | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      return null;
    }
  }
  return initializeVocabUi(runtime, resolvedTransport);
}
