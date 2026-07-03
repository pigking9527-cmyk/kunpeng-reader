// 阅读窗口逻辑（整本合并为一页，连续滚动）
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
let currentBookTitle = "";
let currentBookId = "";
window.currentBookId = "";
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单
function readerDebugSettingOn(key) {
  try {
    const settings = JSON.parse(localStorage.getItem("debugSettingsV1") || "{}");
    return settings[key] !== false;
  } catch (e) {
    return true;
  }
}
const DIAG_DISABLE_READER_REPORTS = !readerDebugSettingOn("reader_stats_report");
let windowDraggingUntil = 0;
let windowDragReleaseTimer = null;
function markWindowDragging() {
  // Tauri 的原生拖窗过程不总能把 move/up 事件稳定回传给 WebView。
  // 给一个较长保护窗，松手事件回来时再缩短，避免拖动数秒后后台写盘插入造成卡顿。
  windowDraggingUntil = Date.now() + 20000;
  if (typeof sendToPage === "function") sendToPage({ windowDragging: 1 });
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 20500);
}
function isWindowDragging() {
  return Date.now() < windowDraggingUntil;
}
function endWindowDraggingSoon() {
  windowDraggingUntil = Date.now() + 500;
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 650);
}

function initWindowControls() {
  document.querySelector(".reader-drag-space")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("progress")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("win-min")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_minimize").catch(() => {});
  });
  document.getElementById("win-max")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_toggle_maximize").catch(() => {});
  });
  document.getElementById("win-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_close").catch(() => {});
  });
  window.addEventListener("pointerup", endWindowDraggingSoon);
  window.addEventListener("mouseup", endWindowDraggingSoon);
}
initWindowControls();

// 禁用浏览器自带查找（Ctrl+F / F3），用阅读器自带搜索
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

// 沉浸模式：工具栏隐藏，点屏幕中间唤出
let immersive = localStorage.getItem("immersive") === "1";
function setImmersive(on) {
  immersive = on;
  document.body.classList.toggle("immersive", on);
  if (!on) document.body.classList.remove("bar-show");
  localStorage.setItem("immersive", on ? "1" : "0");
}
document.getElementById("immersive-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setImmersive(!immersive);
});
setImmersive(immersive); // 应用上次的沉浸状态
// PDF 缩放
document.getElementById("zoom-in").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "in" }); });
document.getElementById("zoom-out").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "out" }); });
let pdfDual = false;
let pdfStateTimer = null;
document.getElementById("pdf-dual").addEventListener("click", (e) => {
  e.stopPropagation();
  pdfDual = !pdfDual;
  document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
  sendToPage({ dual: pdfDual });
});
// 朗读
let ttsPlaying = false,
  ttsNoZhWarned = false;
const ttsBtn = document.getElementById("tts-btn");
ttsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ttsPlaying = !ttsPlaying;
  sendToPage({ tts: ttsPlaying ? "start" : "stop" });
});

// 书架检索点击 → 跳到命中章节并高亮（等合并页就绪后再发）
let frameReady = false;
let pendingJump = null;
function doJump(j) {
  if (!j || !j.term) {
    window.consumePendingCrossSearch?.();
    return;
  }
  if (frameReady) sendToPage({ gotoChapter: j.chapter || 0, search: j.term });
  else pendingJump = j;
}
listen("shelf-jump", (e) => doJump(e.payload));

const frame = document.getElementById("frame");
const tocEl = document.getElementById("toc");
const backdropEl = document.getElementById("backdrop");
const loadingEl = document.getElementById("loading");
let loadingHidden = false;
function hideLoading() {
  if (!loadingHidden) {
    loadingHidden = true;
    loadingEl.classList.add("hide");
  }
}
const settingsEl = document.getElementById("settings");
const progressEl = document.getElementById("progress");
function showProgressLoading() {
  if (isPdf) {
    progressEl.innerHTML = '<span class="mini-spinner" aria-label="加载中"></span>';
    return;
  }
  progressEl.innerHTML =
    '<span class="mini-spinner" aria-label="页数加载中"></span> 第' +
    (curVchap + 1) +
    "/" +
    vchapTotal +
    "章 " +
    curProgress.toFixed(1) +
    "%";
}

let resumeChapter = 0;
let resumeFrac = 0;
// 当前位置（由合并页上报）
let curProgress = 0; // 全书进度 0~100
let curChapter = 0;
let curChFrac = 0; // 章内比例
let curTotalCh = 1;
let isPdf = false; // PDF.js 模式
let lastPosSig = ""; // 阅读位置签名，用于沉浸模式翻页时自动收起工具栏
let keepImmersiveBarUntil = 0;
window.keepImmersiveBarAfterNav = function () {
  keepImmersiveBarUntil = Date.now() + 1800;
  if (immersive) document.body.classList.add("bar-show");
};
// 逻辑（虚拟）章节：按目录把大文件细分。vchaps 为 [{ch:spine序号, frag}]
let vchaps = [];
let curVchap = 0;
let vchapTotal = 1;
showProgressLoading();

function closeSettings() {
  settingsEl.classList.remove("show");
  syncOverlay();
}
// 把"搜索框/设置面板是否打开"同步给合并页：打开时正文点击只用于关闭浮层
function syncOverlay() {
  const open = rsearch.classList.contains("show") || settingsEl.classList.contains("show");
  if (open) pauseReadTracking("overlay");
  sendToPage({ overlayOpen: open ? 1 : 0 });
}

// 把阅读位置回传后端（节流，避免频繁写盘）
let progTimer = null;
function reportProgress() {
  if (DIAG_DISABLE_READER_REPORTS) return;
  if (isWindowDragging()) return;
  if (progTimer) clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    if (isWindowDragging()) return;
    invoke("set_progress", {
      progress: curProgress,
      chapter: curChapter,
      frac: curChFrac,
    }).catch(() => {});
  }, 800);
}

// ---- 已读字数统计：按可见字数、停留时间、短页和快速翻页折算，避免大窗口短停虚高 ----
const READ_TRACK = {
  normalCpmLimit: 1200,
  shortPageCpmLimit: 900,
  shortPageChars: 150,
  tinyPageChars: 30,
  shortMinMs: 2000,
  shortMaxMs: 8000,
  fastTurnRatio: 0.3,
  fastTurnStreak: 3,
  fastTurnCredit: 0.25,
  idleCapMs: 2 * 60 * 1000,
  minDwellMs: 500,
  maxCreditedPages: 3000,
};
let rwSegment = null,
  rwAccum = 0,
  rwTimer = null,
  rwFastStreak = 0;
const rwCreditedByPage = new Map();
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function flushReadWords(immediate = false) {
  if (DIAG_DISABLE_READER_REPORTS) return;
  if (isWindowDragging() && !immediate) return;
  if (rwTimer) {
    clearTimeout(rwTimer);
    rwTimer = null;
  }
  const flush = () => {
    if (isWindowDragging() && !immediate) return;
    const charsToAdd = Math.floor(rwAccum);
    if (charsToAdd > 0) {
      rwAccum -= charsToAdd;
      invoke("add_read_words", { words: charsToAdd }).catch(() => {});
    }
  };
  if (immediate) {
    flush();
    return;
  }
  rwTimer = setTimeout(() => {
    rwTimer = null;
    flush();
  }, 1500);
}
function hasShown(el) {
  return !!el && el.classList && el.classList.contains("show");
}
function readTrackingBlocked() {
  if (isWindowDragging()) return true;
  if (!document.hasFocus() || document.hidden) return true;
  return (
    hasShown(window.rsearch || rsearch) ||
    hasShown(window.settingsEl || settingsEl) ||
    hasShown(window.tocEl || tocEl) ||
    document.body.classList.contains("vocab-open")
  );
}
function readPageKey(d) {
  const chapter = Number.isFinite(d.chapter) ? d.chapter : curChapter || 0;
  const gp = Number(d.gPage || 0);
  const page = Number(d.page || 0);
  return chapter + ":" + (gp > 0 ? "g" + gp : "p" + page);
}
function requiredReadMs(chars) {
  if (chars <= 0) return 0;
  if (chars < READ_TRACK.tinyPageChars) return 1000;
  if (chars < READ_TRACK.shortPageChars) {
    return clamp((chars / READ_TRACK.shortPageCpmLimit) * 60000, READ_TRACK.shortMinMs, READ_TRACK.shortMaxMs);
  }
  return (chars / READ_TRACK.normalCpmLimit) * 60000;
}
function pruneCreditedPages() {
  while (rwCreditedByPage.size > READ_TRACK.maxCreditedPages) {
    const first = rwCreditedByPage.keys().next().value;
    rwCreditedByPage.delete(first);
  }
}
function creditReadSegment(reason, options = {}) {
  if (!rwSegment) return;
  const seg = rwSegment;
  rwSegment = null;
  if (options.discard) return;
  const rawDwell = Math.max(0, Date.now() - seg.startedAt);
  const chars = Math.max(0, seg.chars || 0);
  if (chars <= 0 || rawDwell < READ_TRACK.minDwellMs) return;
  const required = requiredReadMs(chars);
  if (required <= 0) return;
  const dwellCap = Math.max(READ_TRACK.idleCapMs, required);
  const dwell = clamp(rawDwell, 0, dwellCap);
  const ratio = clamp(dwell / required, 0, 1);
  if (ratio < READ_TRACK.fastTurnRatio) rwFastStreak += 1;
  else rwFastStreak = 0;
  const creditRatio = rwFastStreak >= READ_TRACK.fastTurnStreak ? ratio * READ_TRACK.fastTurnCredit : ratio;
  const totalCreditForPage = Math.floor(chars * creditRatio);
  const alreadyCredited = rwCreditedByPage.get(seg.key) || 0;
  const delta = Math.max(0, totalCreditForPage - alreadyCredited);
  if (delta <= 0) return;
  rwCreditedByPage.set(seg.key, alreadyCredited + delta);
  pruneCreditedPages();
  rwAccum += delta;
  if (window.__kunpengReadDebug) {
    console.debug("read-track", {
      key: seg.key,
      reason,
      chars,
      rawDwell,
      dwell,
      required,
      ratio,
      creditRatio,
      totalCreditForPage,
      alreadyCredited,
      delta,
    });
  }
  flushReadWords();
}
function pauseReadTracking(reason) {
  creditReadSegment(reason || "pause");
}
function discardReadTracking(reason) {
  if (window.__kunpengReadDebug && rwSegment) console.debug("read-track-discard", { key: rwSegment.key, reason });
  rwSegment = null;
}
function trackReadWords(d) {
  if (!readerDebugSettingOn("reader_words_detect")) return;
  if (readTrackingBlocked()) {
    pauseReadTracking("blocked");
    return;
  }
  const key = readPageKey(d);
  const chars = Math.max(0, d.pageChars || 0);
  if (!key || chars <= 0) return;
  if (rwSegment && rwSegment.key === key) {
    rwSegment.chars = Math.max(rwSegment.chars, chars);
    return;
  }
  creditReadSegment("page_change");
  rwSegment = { key, chars, startedAt: Date.now() };
}
window.addEventListener("blur", () => pauseReadTracking("blur"));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pauseReadTracking("hidden");
    flushReadWords(true);
  }
});
window.addEventListener("beforeunload", () => {
  pauseReadTracking("beforeunload");
  flushReadWords(true);
});
window.pauseReadTracking = pauseReadTracking;
window.discardReadTracking = discardReadTracking;
// ---- 右侧自定义垂直滚动条（代表全书进度）----
const vbar = document.getElementById("vbar");
const vthumb = document.getElementById("vthumb");
let vdragging = false;

function updateThumb() {
  const h = vbar.clientHeight;
  if (h <= 0) return;
  const th = 30;
  let top = (curProgress / 100) * (h - th);
  top = Math.max(0, Math.min(h - th, top));
  vthumb.style.height = th + "px";
  vthumb.style.top = top + "px";
}
function fracFromY(clientY) {
  const rect = vbar.getBoundingClientRect();
  const th = vthumb.offsetHeight;
  let top = clientY - rect.top - th / 2;
  const range = rect.height - th;
  top = Math.max(0, Math.min(range, top));
  vthumb.style.top = top + "px";
  return range > 0 ? top / range : 0; // 0~1 全书比例
}
vthumb.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  vdragging = true;
  document.body.style.userSelect = "none";
  // 拖动期间让 iframe 不吃鼠标事件，否则光标移到正文上时 mousemove/mouseup 被 iframe 截走，拖动卡住
  frame.style.pointerEvents = "none";
});
vbar.addEventListener("mousedown", (e) => {
  if (e.target === vthumb) return; // 点轨道空白处跳转
  sendToPage({ gotoFrac: fracFromY(e.clientY) });
});
let vLastFrac = 0,
  vLastSent = 0;
document.addEventListener("mousemove", (e) => {
  if (!vdragging) return;
  vLastFrac = fracFromY(e.clientY); // 立即移动滑块（视觉跟手）
  // 节流导航：跨章要加载，过密会卡；同章翻页很轻，40ms 足够平滑
  const now = Date.now();
  if (now - vLastSent >= 40) {
    vLastSent = now;
    sendToPage({ gotoFrac: vLastFrac });
  }
});
document.addEventListener("mouseup", () => {
  if (vdragging) {
    vdragging = false;
    document.body.style.userSelect = "";
    frame.style.pointerEvents = ""; // 恢复正文交互
    sendToPage({ gotoFrac: vLastFrac }); // 收尾：精确落到松手处
  }
});
window.addEventListener("resize", () => {
  if (!isPdf) showProgressLoading();
  updateThumb();
});

// ---- 书籍信息弹窗 ----
const infoModal = document.getElementById("info-modal");
function fmtWords(n) {
  n = n || 0;
  if (n >= 10000) return (n / 10000).toFixed(2) + " 万字";
  return n + " 字";
}
function fmtSize(b) {
  b = b || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + "M";
  if (b >= 1024) return Math.round(b / 1024) + "K";
  return b + "B";
}
// ---- 评分（五颗星，支持半星 0.5 刻度；点左半=半星、右半=整星，再点同一处清除）----
// 通用半星组件：在 container 里建 5 颗叠层星，鼠标悬停预览、点击回调 onPick(value)。
function makeStars(container, onPick) {
  for (let i = 0; i < 5; i++) {
    const st = document.createElement("span");
    st.className = "star";
    const bg = document.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = document.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    st.append(bg, fg);
    container.appendChild(st);
  }
  const stars = [...container.querySelectorAll(".star")];
  function paint(v) {
    stars.forEach((st, i) => {
      const f = Math.max(0, Math.min(1, v - i)); // 该颗的填充比例：0 / .5 / 1
      st.querySelector(".s-fg").style.width = f * 100 + "%";
    });
  }
  function valAt(e) {
    for (let i = 0; i < stars.length; i++) {
      const r = stars[i].getBoundingClientRect();
      if (e.clientX <= r.right) return i + (e.clientX < r.left + r.width / 2 ? 0.5 : 1);
    }
    return 5;
  }
  container.addEventListener("mousemove", (e) => paint(valAt(e)));
  container.addEventListener("mouseleave", () => paint(container._val || 0));
  container.addEventListener("click", (e) => {
    let v = valAt(e);
    if (v === container._val) v = 0; // 点中当前值 → 清除
    container._val = v;
    paint(v);
    onPick(v);
  });
  container.setVal = (v) => {
    container._val = v || 0;
    paint(container._val);
  };
  paint(0);
}
const infoStars = document.getElementById("info-stars");
makeStars(infoStars, (v) => invoke("set_rating", { rating: v }).catch(() => {}));
invoke("book_meta").then((m) => { currentBookTitle = m.title || ""; }).catch(() => {});

document.getElementById("info-btn").addEventListener("click", async () => {
  document.getElementById("info-words").textContent = "统计中…";
  infoModal.classList.add("show");
  try {
    const m = await invoke("book_meta");
    currentBookTitle = m.title || "";
    document.getElementById("info-title").textContent = m.title || "—";
    document.getElementById("info-author").textContent = m.author || "未知";
    document.getElementById("info-format").textContent = (m.format || "").toUpperCase();
    document.getElementById("info-words").textContent = fmtWords(m.word_count);
    document.getElementById("info-size").textContent = fmtSize(m.size);
    document.getElementById("info-desc").textContent = m.description || "";
    infoStars.setVal(m.rating || 0);
  } catch (e) {
    document.getElementById("info-words").textContent = "读取失败：" + e;
  }
});
document.getElementById("info-close").addEventListener("click", () => infoModal.classList.remove("show"));
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) infoModal.classList.remove("show"); // 点遮罩关闭
});
// 简介编辑：失焦保存
document.getElementById("info-desc").addEventListener("blur", () => {
  const desc = document.getElementById("info-desc").textContent.trim();
  invoke("set_description", { description: desc }).catch(() => {});
});

// 全书搜索 UI 与 sendToPage 消息桥在 reader-search-ui.js。

// 接收合并页上报：阅读进度 / 正文被点击 / 搜索结果数
window.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.layoutBusy) {
    if (!isPdf) showProgressLoading();
    return;
  }
  if (typeof e.data.progress === "number") {
    curProgress = e.data.progress;
    curChapter = e.data.chapter || 0;
    curChFrac = e.data.chFrac || 0;
    curTotalCh = e.data.totalCh || 1;
    if (typeof e.data.logicalCh === "number") curVchap = e.data.logicalCh;
    if (e.data.logicalTotal) vchapTotal = e.data.logicalTotal;
    if (isPdf) {
      progressEl.textContent =
        "第 " + (e.data.page || 1) + "/" + (e.data.total || 1) + " 页 · " + curProgress.toFixed(1) + "%";
    } else {
      const gP = e.data.gPage || 0,
        gT = e.data.gTotal || 0;
      if (gT > 0) {
        progressEl.textContent =
          "第" + (curVchap + 1) + "/" + vchapTotal + "章 · " + gP + "/" + gT + "页 · " + curProgress.toFixed(1) + "%";
      } else {
        showProgressLoading();
      }
    }
    reportProgress();
    trackReadWords(e.data); // 累计真正读过的字数
    if (!vdragging && !isPdf) updateThumb();
    hideLoading(); // 当前章/页排版完成
    // 沉浸模式下：翻页/滚到新页 → 自动收起浮现的工具栏，避免挡住正文。
    // 但若设置面板/搜索框正开着，则不收——否则调节滑块时正文重排会改变页码签名，
    // 误判为“翻页”而把工具栏（连同打开的设置面板）一起隐藏。
    const sig = (e.data.gPage || 0) + "_" + (e.data.page || 0) + "_" + (e.data.chapter || 0);
    const panelOpen = settingsEl.classList.contains("show") || rsearch.classList.contains("show");
    if (lastPosSig && sig !== lastPosSig && immersive && document.body.classList.contains("bar-show") && !panelOpen && Date.now() > keepImmersiveBarUntil) {
      document.body.classList.remove("bar-show");
    }
    lastPosSig = sig;
  }
  if (e.data.ttsState !== undefined) {
    ttsPlaying = !!e.data.ttsState;
    ttsBtn.textContent = ttsPlaying ? "⏸" : "🔊";
    ttsBtn.classList.toggle("active", ttsPlaying);
  }
  if (e.data.ttsSynth) {
    // 合并页要某句的在线音频 → 调 edge_tts → 回传音频+词时间戳
    const r = e.data.ttsSynth;
    invoke("edge_tts", { text: r.text, voice: r.voice, rate: r.rate })
      .then((res) => sendToPage({ ttsAudio: { seq: r.seq, idx: r.idx, audio: res.audio, marks: res.marks } }))
      .catch((err) => sendToPage({ ttsAudioErr: { seq: r.seq, idx: r.idx, err: String(err) } }));
  }
  if (e.data.dictPrefetch) prefetchMicrosoftWord(e.data.dictPrefetch);
  if (e.data.dictSpeak) speakMicrosoftWord(e.data.dictSpeak);
  if (e.data.ttsErr) {
    const m = e.data.ttsErr;
    alert(typeof m === "string"
      ? "在线朗读失败：" + m + "\n（可在设置→朗读 把音源切到“系统语音”。）"
      : m === 1 ? "当前环境不支持朗读（Web Speech API 不可用）。"
      : "在线朗读取音失败。可切换为系统语音。");
  }
  if (e.data.ttsNoZh && !ttsNoZhWarned) {
    ttsNoZhWarned = true;
    alert("没找到中文朗读语音，会用默认语音（中文可能读不准）。\n建议：Windows 设置 → 时间和语言 → 语音 → 添加“中文（中国）”自然语音，然后重开本书。");
  }
  if (e.data.outline) buildToc(e.data.outline); // PDF 内置目录
  if (e.data.pdfState) {
    // PDF 缩放/双页变化 → 记住（节流写盘），并同步双页按钮高亮
    const st = e.data.pdfState;
    pdfDual = !!st.dual;
    document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
    if (pdfStateTimer) clearTimeout(pdfStateTimer);
    pdfStateTimer = setTimeout(() => {
      invoke("set_pdf_state", { scale: st.scale, dual: !!st.dual }).catch(() => {});
    }, 600);
  }
  if (e.data.searchResults && isPdf) renderResults(rsearchTerm, e.data.searchResults); // PDF 书内搜索结果
  if (e.data.uiClick) {
    // 正文被点击：关闭已打开的搜索框/设置面板（沉浸与非沉浸一致）
    const had = rsearch.classList.contains("show") || settingsEl.classList.contains("show");
    if (rsearch.classList.contains("show")) toggleSearch(false);
    closeSettings();
    // 沉浸模式：同一次点击在关闭浮层的同时也收起工具栏，避免还要再点一下
    if (had && immersive) document.body.classList.remove("bar-show");
  }
  if (e.data.userNav) {
    // 正文区键盘/滚轮翻页：收起搜索框与沉浸工具栏。
    // 不在这里关设置面板——设置途中（滑块/数字框调节）可能触发翻页类事件，会误关；
    // 设置面板只在“点设置页之外”时关闭（见 uiClick 与下方 document 点击处理）。
    if (rsearch.classList.contains("show")) toggleSearch(false);
    if (immersive) document.body.classList.remove("bar-show");
  }
  if (e.data.centerTap && immersive) document.body.classList.toggle("bar-show");
  if (e.data.ready) {
    hideLoading();
    frameReady = true;
    if (vchaps.length) sendToPage({ vchaps }); // 把逻辑章节表交给合并页
    sendToPage({ highlights }); // 把高亮交给合并页渲染
    if (!isPdf) {
      // 取上次测好的页数缓存：版式一致则合并页直接采用，免重算
      invoke("get_page_cache")
        .then((pc) => { if (pc) sendToPage({ pageCache: pc }); })
        .catch(() => {});
    }
    if (pendingJump) {
      doJump(pendingJump);
      pendingJump = null;
    }
  }
  if (e.data.measured) {
    // 合并页测完整书页数 → 落盘缓存，下次同版式直接用
    invoke("save_page_cache", { sig: e.data.measured.sig, pages: e.data.measured.pages }).catch(() => {});
  }
  if (e.data.webSearch) {
    invoke("web_search", { term: e.data.webSearch }).catch(() => {});
  }
  if (e.data.crossSearch) {
    openCrossSearch(e.data.crossSearch);
  }
  if (e.data.dict !== undefined) {
    invoke("dict_lookup", { term: e.data.dict })
      .then((r) => sendToPage({ dictResult: { ...r, autoSpeak: vocabAutoSpeak } }))
      .catch(() => sendToPage({ dictResult: { found: false, word: e.data.dict } }));
  }
  if (e.data.vocabAdd) {
    const v = e.data.vocabAdd;
    invoke("vocab_add", {
      entry: {
        word: v.word,
        lang: v.lang,
        def: v.def || "",
        def_en: v.def_en || "",
        phonetic: v.phonetic || "",
        example: v.example || "",
        book_title: currentBookTitle || "",
      },
    }).catch(() => {});
  }
  if (e.data.addHighlight) {
    addHighlight(e.data.addHighlight, "");
  }
  if (e.data.addHighlightNote) {
    addHighlight(e.data.addHighlightNote, "", true); // 先建高亮，随即打开批注面板
  }
  if (typeof e.data.openAnnotations === "number") {
    openAnnotations(e.data.openAnnotations);
  }
  if (typeof e.data.removeHighlight === "number") {
    invoke("remove_highlight", { index: e.data.removeHighlight }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightNote) {
    const { index, note } = e.data.setHighlightNote;
    invoke("set_highlight_note", { index, note }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.addBookmark) {
    const o = e.data.addBookmark;
    // 统一标签：第 N 页/章 · 百分比 ·（选中的文字片段，若有）
    const pageNo = (o.chapter || 0) + 1;
    let label = "第 " + pageNo + " " + (isPdf ? "页" : "章") + " · " + curProgress.toFixed(1) + "%";
    if (o.text) label += " · " + o.text;
    invoke("add_bookmark", {
      chapter: o.chapter || 0,
      frac: o.frac || 0,
      label,
    }).then((list) => {
      bookmarks = list;
      renderBookmarks();
    });
  }
  if (e.data.tocResolved && tocEl.classList.contains("show")) {
    const r = e.data.tocResolved;
    if (r.chapter === curChapter) {
      const items = [...tocPane.querySelectorAll(".toc-item")];
      let el = items.find(
        (it) => parseInt(it.dataset.chapter, 10) === curChapter && (it.dataset.frag || "") === (r.frag || "")
      );
      if (!el) el = items.find((it) => parseInt(it.dataset.chapter, 10) === curChapter);
      markToc(el);
    }
  }
});

// 外壳内点击：只要不是点在齿轮按钮/设置面板上，就关闭设置面板
document.addEventListener("click", (e) => {
  if (!settingsEl.classList.contains("show")) return;
  if (e.target.closest(".gear-wrap")) return; // 点齿轮或面板内部，不关
  closeSettings();
});

// 焦点在外壳时，把翻页键转发给合并页
window.addEventListener("keydown", (e) => {
  // 焦点在输入控件（搜索框、设置里的滑块/数字框/下拉）时，方向键用于调节数值，
  // 不能抢去翻页，否则会 preventDefault 掉调节、还顺手关掉设置面板
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
  let dir = 0;
  if (e.key === "PageDown" || e.key === "ArrowRight" || (e.key === " " && !e.shiftKey)) dir = 1;
  else if (e.key === "PageUp" || e.key === "ArrowLeft" || (e.key === " " && e.shiftKey)) dir = -1;
  if (dir !== 0) {
    e.preventDefault();
    // 翻页同时收起浮层与沉浸工具栏
    if (rsearch.classList.contains("show")) toggleSearch(false);
    closeSettings();
    if (immersive) document.body.classList.remove("bar-show");
    if (frame.contentWindow) frame.contentWindow.postMessage({ pageTurn: dir }, "*");
  }
});

// ---------- 阅读设置 ----------
// 阅读设置状态与面板绑定在 reader-settings-ui.js。

// 合并页加载完成后，PDF 直接由 WebView 渲染，加载事件即可关掉遮罩。
frame.addEventListener("load", () => {
  if (document.body.classList.contains("pdf-mode")) hideLoading();
});

// 阅读时长统计：窗口在前台时每 15 秒累计一次
setInterval(() => {
  if (DIAG_DISABLE_READER_REPORTS) return;
  if (document.hasFocus() && !isWindowDragging()) invoke("add_reading_time", { seconds: 15 }).catch(() => {});
}, 15000);

// 目录、书签、批注/高亮 UI 在 reader-notes-ui.js。

(async () => {
  initSettingsUI();
  applyShellTheme(settings.theme);
  try {
    const info = await invoke("book_info");
    currentBookId = info.id || "";
    window.currentBookId = currentBookId;
    window.updateCrossReturnButton?.();
    window.consumePendingCrossSearch?.();
    currentBookTitle = info.title || currentBookTitle || "";
    bookmarks = info.bookmarks || [];
    renderBookmarks();
    highlights = info.highlights || [];
    renderHighlights();
    if (info.format === "pdf") {
      document.body.classList.add("pdf-mode");
      isPdf = true;
      const rp = (info.resume_chapter || 0) + 1; // resume_chapter 存的是页码-1
      // 恢复这本 PDF 上次的缩放/双页
      let pscale = 0, pdual = 0;
      try {
        const ps = await invoke("get_pdf_state");
        if (ps) { pscale = ps.scale || 0; pdual = ps.dual ? 1 : 0; }
      } catch (e) {}
      if (pdual) {
        pdfDual = true;
        document.getElementById("pdf-dual").classList.add("active");
      }
      frame.src =
        "pdfview.html?u=" + encodeURIComponent(info.url) +
        "&p=" + rp +
        "&scale=" + pscale +
        "&dual=" + pdual +
        "&s=" + encodeURIComponent(JSON.stringify(settings));
      return;
    }
    resumeChapter = info.resume_chapter || 0;
    resumeFrac = info.resume_frac || 0;
    buildToc(info.toc || []);
    // 逻辑章节 = 目录条目按"所在文件(spine)"去重，每个文件取第一条：
    // 金庸全集每"回"是独立文件 → 保留到回级；Python Cookbook 上千个"#锚点小节"同属十几个章节文件 → 合并回章级。
    const toc = info.toc || [];
    vchaps = [];
    const seenCh = new Set();
    for (const e of toc) {
      const ch = e.chapter || 0;
      if (seenCh.has(ch)) continue;
      seenCh.add(ch);
      vchaps.push({ ch, frag: e.frag || "" });
    }
    vchapTotal = vchaps.length || (info.chapter_count || 1);
    // 设置 + 续读位置（章节/章内比例）随 URL 传给合并页：据此只加载该章并定位
    const q =
      "?rc=" + resumeChapter +
      "&rf=" + resumeFrac +
      "&s=" + encodeURIComponent(JSON.stringify(settings));
    frame.src = info.url + q;
    // 若本次是从书架检索点开的，取走待跳转位置，合并页就绪后跳过去
    invoke("take_pending_jump").then((j) => { if (j) doJump(j); }).catch(() => {});
  } catch (e) {
    document.body.innerHTML =
      "<p style='padding:20px;color:#b00'>打开失败：" + e + "</p>";
  }
})();
