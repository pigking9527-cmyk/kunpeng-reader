// 阅读页生词本、英文发音缓存和高频词语音包 UI。
// 阅读主体、目录和设置仍由 reader.js 负责。
// ---------- 生词本（查过的词，中/英分开）----------
const vocabEl = document.getElementById("vocab");
const vocabPane = document.getElementById("vocab-pane");
const vocabSettings = document.getElementById("vocab-settings");
const vocabGear = document.getElementById("vocab-gear");
const vocabCountToggle = document.getElementById("vocab-count-toggle");
const vocabSortTime = document.getElementById("vsort-time");
const vocabSortCount = document.getElementById("vsort-count");
const dictAutoSpeakToggle = document.getElementById("dict-auto-speak-toggle");
const wordAudioCacheToggle = document.getElementById("word-audio-cache-toggle");
const wordAudioCacheInfo = document.getElementById("word-audio-cache-info");
const wordAudioCacheSize = document.getElementById("word-audio-cache-size");
const wordAudioCacheDelete = document.getElementById("word-audio-cache-delete");
const wordAudioPack = document.getElementById("word-audio-pack");
const wordPackCount = document.getElementById("word-pack-count");
const wordPackProgress = document.getElementById("word-pack-progress");
const wordPackMeta = document.getElementById("word-pack-meta");
const wordPackToggle = document.getElementById("word-pack-toggle");
const wordPackDelete = document.getElementById("word-pack-delete");
let vocabLang = "zh";
let vocabShowCount = localStorage.getItem("vocabShowCount") !== "0";
let vocabSort = localStorage.getItem("vocabSort") || "time";
let vocabAutoSpeak = localStorage.getItem("vocabAutoSpeak") !== "0";
let wordAudioDiskCache = localStorage.getItem("wordAudioDiskCache") === "1";
let wordAudio = null;
const wordAudioCache = new Map();
let wordPackPoll = null;
let wordPackState = { total: 10000, cached: 0, bytes: 0 };
function formatCacheSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}
function refreshWordAudioCacheSize() {
  if (!wordAudioDiskCache) return;
  invoke("word_tts_cache_size")
    .then((bytes) => {
      wordAudioCacheSize.textContent = "缓存：" + formatCacheSize(Number(bytes) || 0);
    })
    .catch(() => {
      wordAudioCacheSize.textContent = "缓存：无法读取";
    });
}
function renderWordPackState(message) {
  const total = Number(wordPackState.total) || 10000;
  const cached = Math.min(total, Number(wordPackState.cached) || 0);
  const percent = total ? ((cached / total) * 100).toFixed(1) : "0.0";
  wordPackProgress.max = total;
  wordPackProgress.value = cached;
  wordPackCount.textContent = cached + " / " + total;
  if (message) {
    wordPackMeta.textContent = message;
  } else if (wordPackState.running) {
    wordPackMeta.textContent = (wordPackState.message || ("生成中：" + (wordPackState.current || ""))) + " · " + percent + "%";
  } else if (cached >= total) {
    wordPackMeta.textContent = "已完成 · " + formatCacheSize(Number(wordPackState.bytes) || 0);
  } else if (cached > 0) {
    wordPackMeta.textContent = "已暂停 · " + percent + "% · " + formatCacheSize(Number(wordPackState.bytes) || 0);
  } else {
    wordPackMeta.textContent = "尚未生成";
  }
  wordPackToggle.textContent = wordPackState.running ? "暂停" : cached > 0 ? "继续生成" : "开始生成";
  wordPackToggle.disabled = !wordAudioDiskCache || cached >= total;
  wordPackDelete.disabled = cached === 0 && !wordPackState.running;
}
function refreshWordPackStatus() {
  if (!wordAudioDiskCache) return Promise.resolve(wordPackState);
  return invoke("word_tts_pack_status")
    .then((status) => {
      wordPackState = status;
      renderWordPackState();
      return status;
    })
    .catch(() => {
      renderWordPackState("无法读取语音包进度");
      return wordPackState;
    });
}
function ensureWordPackPolling() {
  if (wordPackPoll) return;
  wordPackPoll = setInterval(() => {
    if (!wordAudioDiskCache || !vocabSettings.classList.contains("show")) {
      clearInterval(wordPackPoll);
      wordPackPoll = null;
      return;
    }
    refreshWordPackStatus().then((status) => {
      if (!status.running) {
        refreshWordAudioCacheSize();
        clearInterval(wordPackPoll);
        wordPackPoll = null;
      }
    });
  }, 2000);
}
function speakSystemWord(word) {
  try {
    if (!word || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(word);
    u.lang = "en-US";
    u.rate = 0.9;
    const voices = window.speechSynthesis.getVoices();
    const voice = voices.find((v) => /^en[-_]/i.test(v.lang) || /^en$/i.test(v.lang));
    if (voice) u.voice = voice;
    window.speechSynthesis.speak(u);
  } catch (_) {}
}
function loadMicrosoftWord(word) {
  const key = String(word || "").trim().toLowerCase();
  if (!key) return Promise.reject(new Error("empty word"));
  if (wordAudioCache.has(key)) return wordAudioCache.get(key);
  const request = invoke("word_tts", { text: word, cache: wordAudioDiskCache })
    .then((res) => {
      if (wordAudioDiskCache) refreshWordAudioCacheSize();
      return res.audio;
    })
    .catch((err) => {
      wordAudioCache.delete(key);
      throw err;
    });
  wordAudioCache.set(key, request);
  if (wordAudioCache.size > 50) wordAudioCache.delete(wordAudioCache.keys().next().value);
  return request;
}
function prefetchMicrosoftWord(word) {
  loadMicrosoftWord(word).catch(() => {});
}
function speakMicrosoftWord(word) {
  if (!word) return;
  try {
    window.speechSynthesis && window.speechSynthesis.cancel();
    if (wordAudio) {
      wordAudio.pause();
      wordAudio = null;
    }
  } catch (_) {}
  loadMicrosoftWord(word)
    .then((audioData) => {
      const audio = new Audio("data:audio/mpeg;base64," + audioData);
      wordAudio = audio;
      audio.onerror = () => speakSystemWord(word);
      return audio.play().catch(() => speakSystemWord(word));
    })
    .catch(() => speakSystemWord(word));
}
function speakVocabWord(word) {
  speakMicrosoftWord(word);
}
function applyVocabSettings() {
  vocabCountToggle.checked = vocabShowCount;
  dictAutoSpeakToggle.checked = vocabAutoSpeak;
  wordAudioCacheToggle.checked = wordAudioDiskCache;
  wordAudioCacheInfo.hidden = !wordAudioDiskCache;
  wordAudioPack.hidden = !wordAudioDiskCache;
  vocabEl.classList.toggle("hide-count", !vocabShowCount);
  vocabSortTime.classList.toggle("active", vocabSort === "time");
  vocabSortCount.classList.toggle("active", vocabSort === "count");
  if (!wordAudioDiskCache) {
    renderWordPackState();
  }
}
function setVocab(open) {
  ReaderShell.setOverlay(ReaderShell.OVERLAY.VOCAB, !!open);
}
ReaderShell.registerOverlay(ReaderShell.OVERLAY.VOCAB, {
  onOpen() {
    window.pauseReadTracking?.("vocab");
    applyVocabSettings();
    renderVocab();
  },
  onClose() {
    vocabSettings.classList.remove("show");
  },
});
function setVocabTab(lang) {
  vocabLang = lang;
  document.getElementById("vtab-zh").classList.toggle("active", lang === "zh");
  document.getElementById("vtab-en").classList.toggle("active", lang === "en");
  renderVocab();
}
function renderVocab() {
  invoke("vocab_list", { lang: vocabLang })
    .then((list) => {
      vocabPane.innerHTML = "";
      list = list.slice().sort((a, b) => {
        if (vocabSort === "count") return (b.count || 0) - (a.count || 0) || (b.last_at || 0) - (a.last_at || 0);
        return (b.last_at || 0) - (a.last_at || 0);
      });
      if (!list.length) {
        const e = document.createElement("div");
        e.className = "vc-empty";
        e.textContent = "还没有查过的" + (vocabLang === "zh" ? "中文" : "英文") + "词";
        vocabPane.appendChild(e);
        return;
      }
      const cols = [document.createElement("div"), document.createElement("div")];
      cols.forEach((col) => {
        col.className = "vc-col";
        vocabPane.appendChild(col);
      });
      list.forEach((it) => {
        const row = document.createElement("div");
        row.className = "vc-item";
        if (it.lang === "en") {
          row.classList.add("vc-speak");
          row.title = "点击播放读音";
          row.addEventListener("click", (e) => {
            if (e.target.closest(".vc-del") || e.target.closest(".vc-level")) return;
            speakVocabWord(it.word);
          });
        }
        const main = document.createElement("div");
        main.className = "vc-main";
        const head = document.createElement("div");
        head.className = "vc-head";
        const wd = document.createElement("div");
        wd.className = "vc-word";
        wd.textContent = it.word;
        if (it.phonetic) {
          const ph = document.createElement("span");
          ph.className = "vc-phon";
          ph.textContent = it.lang === "en" ? " [" + it.phonetic + "]" : " " + it.phonetic;
          wd.appendChild(ph);
        }
        const c = document.createElement("span");
        c.className = "vc-cnt";
        c.textContent = it.count || 1;
        const df = document.createElement("div");
        df.className = "vc-def";
        df.textContent = it.def || it.def_en || "";
        head.append(wd, c);
        main.append(head, df);
        const levels = document.createElement("div");
        levels.className = "vc-level";
        [
          ["陌生", 0],
          ["认识", 1],
          ["掌握", 2],
        ].forEach(([label, value]) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = label;
          b.className = (it.level || 0) === value ? "active" : "";
          b.addEventListener("click", (e) => {
            e.stopPropagation();
            invoke("vocab_set_level", { word: it.word, lang: it.lang, level: value }).then(() => renderVocab()).catch(() => {});
          });
          levels.appendChild(b);
        });
        main.appendChild(levels);
        const del = document.createElement("button");
        del.className = "vc-del";
        del.textContent = "✕";
        del.title = "从生词本删除";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          invoke("vocab_remove", { word: it.word, lang: it.lang }).then(() => renderVocab()).catch(() => {});
        });
        row.append(main, del);
        const target = cols[0].offsetHeight <= cols[1].offsetHeight ? cols[0] : cols[1];
        target.appendChild(row);
      });
    })
    .catch(() => {});
}
document.getElementById("vtab-zh").addEventListener("click", () => setVocabTab("zh"));
document.getElementById("vtab-en").addEventListener("click", () => setVocabTab("en"));
vocabGear.addEventListener("click", (e) => {
  e.stopPropagation();
  vocabSettings.classList.toggle("show");
  if (vocabSettings.classList.contains("show") && wordAudioDiskCache) {
    refreshWordAudioCacheSize();
    refreshWordPackStatus().then((status) => {
      if (status.running) ensureWordPackPolling();
    });
  }
});
vocabSettings.addEventListener("click", (e) => e.stopPropagation());
vocabEl.addEventListener("click", (e) => {
  if (e.target.closest("#vocab-gear") || e.target.closest("#vocab-settings")) return;
  vocabSettings.classList.remove("show");
});
vocabCountToggle.addEventListener("change", () => {
  vocabShowCount = vocabCountToggle.checked;
  localStorage.setItem("vocabShowCount", vocabShowCount ? "1" : "0");
  applyVocabSettings();
});
dictAutoSpeakToggle.addEventListener("change", () => {
  vocabAutoSpeak = dictAutoSpeakToggle.checked;
  localStorage.setItem("vocabAutoSpeak", vocabAutoSpeak ? "1" : "0");
});
wordAudioCacheToggle.addEventListener("change", () => {
  wordAudioDiskCache = wordAudioCacheToggle.checked;
  localStorage.setItem("wordAudioDiskCache", wordAudioDiskCache ? "1" : "0");
  if (!wordAudioDiskCache) invoke("pause_word_tts_pack").catch(() => {});
  wordAudioCache.clear();
  applyVocabSettings();
});
wordAudioCacheDelete.addEventListener("click", async () => {
  if (!confirm("删除全部英文单词语音缓存？")) return;
  await invoke("pause_word_tts_pack").catch(() => {});
  try {
    await invoke("clear_word_tts_cache");
    wordAudioCache.clear();
    await refreshWordPackStatus();
    refreshWordAudioCacheSize();
  } catch (err) {
    alert("删除语音缓存失败：" + err);
  }
});
wordPackToggle.addEventListener("click", () => {
  if (wordPackState.running) {
    invoke("pause_word_tts_pack").catch(() => {});
    renderWordPackState("正在暂停，当前请求完成后停止…");
    return;
  }
  if (!wordAudioDiskCache) return;
  ensureWordPackPolling();
  invoke("start_word_tts_pack")
    .then(() => refreshWordPackStatus())
    .catch((err) => alert("启动高频词语音包失败：" + err));
});
wordPackDelete.addEventListener("click", async () => {
  if (!confirm("删除已生成的高频词语音包？其他查词缓存会保留。")) return;
  await invoke("pause_word_tts_pack").catch(() => {});
  try {
    await invoke("clear_word_tts_pack");
    wordAudioCache.clear();
    await refreshWordPackStatus();
    refreshWordAudioCacheSize();
  } catch (err) {
    alert("删除高频词语音包失败：" + err);
  }
});
function setVocabSort(sort) {
  vocabSort = sort;
  localStorage.setItem("vocabSort", sort);
  applyVocabSettings();
  renderVocab();
}
vocabSortTime.addEventListener("click", () => setVocabSort("time"));
vocabSortCount.addEventListener("click", () => setVocabSort("count"));
applyVocabSettings();
document.getElementById("vocab-btn").addEventListener("click", () => {
  setVocab(!ReaderShell.isOverlay(ReaderShell.OVERLAY.VOCAB));
});
