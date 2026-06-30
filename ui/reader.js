// 阅读窗口逻辑（整本合并为一页，连续滚动）
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单
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
  if (!j || !j.term) return;
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

let resumeChapter = 0;
let resumeFrac = 0;
// 当前位置（由合并页上报）
let curProgress = 0; // 全书进度 0~100
let curChapter = 0;
let curChFrac = 0; // 章内比例
let curTotalCh = 1;
let isPdf = false; // PDF.js 模式
let lastPosSig = ""; // 阅读位置签名，用于沉浸模式翻页时自动收起工具栏
// 逻辑（虚拟）章节：按目录把大文件细分。vchaps 为 [{ch:spine序号, frag}]
let vchaps = [];
let curVchap = 0;
let vchapTotal = 1;

function closeSettings() {
  settingsEl.classList.remove("show");
  syncOverlay();
}
// 把"搜索框/设置面板是否打开"同步给合并页：打开时正文点击只用于关闭浮层
function syncOverlay() {
  const open = rsearch.classList.contains("show") || settingsEl.classList.contains("show");
  sendToPage({ overlayOpen: open ? 1 : 0 });
}

// 把阅读位置回传后端（节流，避免频繁写盘）
let progTimer = null;
function reportProgress() {
  if (progTimer) clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    invoke("set_progress", {
      progress: curProgress,
      chapter: curChapter,
      frac: curChFrac,
    }).catch(() => {});
  }, 800);
}

// ---- 已读字数统计：只把"停留≥READ_SEC 秒、且逐页前进翻过"的页计入，避免按进度高估 ----
const READ_SEC = 3;
let rwPrevGP = 0,
  rwPrevChars = 0,
  rwPrevTime = 0,
  rwAccum = 0,
  rwTimer = null;
const rwCredited = new Set();
function flushReadWords() {
  if (rwTimer) return;
  rwTimer = setTimeout(() => {
    rwTimer = null;
    if (rwAccum > 0) {
      invoke("add_read_words", { words: rwAccum }).catch(() => {});
      rwAccum = 0;
    }
  }, 1500);
}
function trackReadWords(d) {
  if (isPdf) return; // PDF 暂不计入已读字数
  const gp = d.gPage || 0,
    chars = d.pageChars || 0,
    now = Date.now();
  if (gp === rwPrevGP) return; // 同一页的重复上报：不重置停留计时
  // 仅"前一页停够时间 + 这次是逐页前进一页"才把前一页计入
  if (rwPrevTime && rwPrevGP > 0 && gp === rwPrevGP + 1) {
    if ((now - rwPrevTime) / 1000 >= READ_SEC && !rwCredited.has(rwPrevGP)) {
      rwCredited.add(rwPrevGP);
      rwAccum += rwPrevChars;
      flushReadWords();
    }
  }
  rwPrevGP = gp;
  rwPrevChars = chars;
  rwPrevTime = now;
}

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
window.addEventListener("resize", updateThumb);

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

document.getElementById("info-btn").addEventListener("click", async () => {
  document.getElementById("info-words").textContent = "统计中…";
  infoModal.classList.add("show");
  try {
    const m = await invoke("book_meta");
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

// ---- 全书文本搜索（结果带上下文片段）----
const rsearch = document.getElementById("rsearch");
const rsearchInput = document.getElementById("rsearch-input");
const rsearchCount = document.getElementById("rsearch-count");
const rsearchResults = document.getElementById("rsearch-results");
let searchTimer = null;

function sendToPage(msg) {
  if (frame.contentWindow) frame.contentWindow.postMessage(msg, "*");
}
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function renderResults(term, hits) {
  rsearchResults.innerHTML = "";
  rsearchCount.textContent = hits.length ? "约 " + hits.length + " 处" : "未找到";
  const low = term.toLowerCase();
  hits.forEach((h) => {
    const item = document.createElement("div");
    item.className = "rs-item";
    const ch = document.createElement("span");
    ch.className = "rs-ch";
    ch.textContent = "第" + (h.chapter + 1) + (isPdf ? "页" : "章");
    // 高亮片段里的搜索词
    let html = "",
      snip = h.snippet,
      ls = snip.toLowerCase(),
      last = 0,
      idx = ls.indexOf(low);
    while (idx >= 0) {
      html += escapeHtml(snip.slice(last, idx)) + "<mark>" +
        escapeHtml(snip.slice(idx, idx + term.length)) + "</mark>";
      last = idx + term.length;
      idx = ls.indexOf(low, last);
    }
    html += escapeHtml(snip.slice(last));
    const span = document.createElement("span");
    span.innerHTML = html;
    item.append(ch, span);
    item.addEventListener("click", () => {
      addRHistory(term);
      if (isPdf) sendToPage({ gotoChapter: h.chapter }); // PDF：跳到该页（已高亮命中）
      else sendToPage({ gotoChapter: h.chapter, search: term });
      toggleSearch(false); // 跳转后自动关闭搜索框（位置保留）
    });
    rsearchResults.appendChild(item);
  });
}

// 自有搜索历史
let rhistory = [];
try {
  rhistory = JSON.parse(localStorage.getItem("rsearchHistory") || "[]");
} catch (e) {
  rhistory = [];
}
function saveRHistory() {
  localStorage.setItem("rsearchHistory", JSON.stringify(rhistory.slice(0, 12)));
}
function addRHistory(q) {
  q = (q || "").trim();
  if (!q) return;
  rhistory = rhistory.filter((h) => h !== q);
  rhistory.unshift(q);
  rhistory = rhistory.slice(0, 12);
  saveRHistory();
}
function renderRHistory() {
  rsearchResults.innerHTML = "";
  rsearchCount.textContent = "";
  if (!rhistory.length) {
    const e = document.createElement("div");
    e.className = "rs-empty";
    e.textContent = "暂无搜索记录";
    rsearchResults.appendChild(e);
    return;
  }
  rhistory.forEach((q) => {
    const item = document.createElement("div");
    item.className = "rs-item";
    item.style.display = "flex";
    item.style.justifyContent = "space-between";
    const t = document.createElement("span");
    t.textContent = q;
    const del = document.createElement("span");
    del.className = "rs-ch";
    del.style.cursor = "pointer";
    del.textContent = "✕";
    item.append(t, del);
    item.addEventListener("click", (e) => {
      if (e.target === del) {
        rhistory = rhistory.filter((h) => h !== q);
        saveRHistory();
        renderRHistory();
        return;
      }
      rsearchInput.value = q;
      runSearch(q);
    });
    rsearchResults.appendChild(item);
  });
}
let rsearchTerm = "";
function runSearch(q) {
  q = (q || "").trim();
  rsearchTerm = q;
  if (!q) {
    renderRHistory();
    return;
  }
  rsearchCount.textContent = "搜索中…";
  if (isPdf) {
    sendToPage({ search: q }); // PDF：交给 pdfview 搜索，结果通过 searchResults 回传
    return;
  }
  invoke("search_book", { term: q })
    .then((hits) => {
      if (rsearchInput.value.trim() === q) renderResults(q, hits);
    })
    .catch(() => {});
}
function toggleSearch(show) {
  rsearch.classList.toggle("show", show);
  if (show) {
    closeSettings(); // 一次只开一个浮层
    rsearchInput.value = "";
    renderRHistory(); // 打开就显示自有历史
    rsearchInput.focus();
  } else {
    sendToPage({ clearMarks: 1 }); // 只清高亮，不改变阅读位置
    rsearchInput.value = "";
    rsearchCount.textContent = "";
    rsearchResults.innerHTML = "";
  }
  syncOverlay();
}
document.getElementById("rsearch-btn").addEventListener("click", () => {
  toggleSearch(!rsearch.classList.contains("show"));
});
document.getElementById("rsearch-close").addEventListener("click", () => toggleSearch(false));
rsearchInput.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  const q = rsearchInput.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 350);
});
rsearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleSearch(false);
  else if (e.key === "Enter") addRHistory(rsearchInput.value);
});

// 接收合并页上报：阅读进度 / 正文被点击 / 搜索结果数
window.addEventListener("message", (e) => {
  if (!e.data) return;
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
      const pageStr =
        gT > 0
          ? gP + "/" + gT + "页"
          : (e.data.page || 1) + "/" + (e.data.total || 1) + "页(本章)";
      progressEl.textContent =
        "第" + (curVchap + 1) + "/" + vchapTotal + "章 · " + pageStr + " · " + curProgress.toFixed(1) + "%";
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
    if (lastPosSig && sig !== lastPosSig && immersive && document.body.classList.contains("bar-show") && !panelOpen) {
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
  if (e.data.dict !== undefined) {
    invoke("dict_lookup", { term: e.data.dict })
      .then((r) => sendToPage({ dictResult: r }))
      .catch(() => sendToPage({ dictResult: { found: false, word: e.data.dict } }));
  }
  if (e.data.vocabAdd) {
    const v = e.data.vocabAdd;
    invoke("vocab_add", {
      entry: { word: v.word, lang: v.lang, def: v.def || "", def_en: v.def_en || "", phonetic: v.phonetic || "" },
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
const DEFAULTS = {
  theme: "light",
  fontFamily: "",
  fontSize: 18,
  lineHeight: 1.7,
  paraSpacing: 0.6,
  letterSpacing: 0,
  marginTop: 18,
  marginBottom: 24,
  marginLeft: 28,
  marginRight: 28,
  ttsSource: "edge",
  ttsVoice: "zh-CN-XiaoxiaoNeural",
  ttsRate: 1,
};

// 外壳（工具栏/目录/设置）的深色应用
function applyShellTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
}

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("readerSettings") || "{}"));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
let settings = loadSettings();

function saveSettings() {
  localStorage.setItem("readerSettings", JSON.stringify(settings));
}
// 把设置发给合并页（实时注入样式）
function pushSettings() {
  if (frame.contentWindow) frame.contentWindow.postMessage({ settings }, "*");
}
function onChange() {
  saveSettings();
  pushSettings();
}
// 合并页加载完成后，应用当前设置（也修复首/末行被切的问题——上下边距生效）
frame.addEventListener("load", () => {
  // 设置/续读已通过 URL 传入，这里无需再发；合并页就绪后会回 {ready}
  if (document.body.classList.contains("pdf-mode")) hideLoading(); // PDF 直接由 WebView 渲染
});

// 阅读时长统计：窗口在前台时每 15 秒累计一次
setInterval(() => {
  if (document.hasFocus()) invoke("add_reading_time", { seconds: 15 }).catch(() => {});
}, 15000);

function bindRange(id, vid, key, fmt) {
  const el = document.getElementById(id);
  const vEl = document.getElementById(vid);
  el.value = settings[key];
  vEl.textContent = fmt(settings[key]);
  el.addEventListener("input", () => {
    settings[key] = parseFloat(el.value);
    vEl.textContent = fmt(settings[key]);
    onChange();
  });
}
function bindNum(id, key) {
  const el = document.getElementById(id);
  const lo = el.min !== "" ? parseInt(el.min, 10) : 0;
  const hi = el.max !== "" ? parseInt(el.max, 10) : 9999;
  const clamp = (v) => Math.max(lo, Math.min(hi, isNaN(v) ? 0 : v));
  el.value = clamp(parseInt(settings[key], 10));
  el.addEventListener("input", () => {
    settings[key] = clamp(parseInt(el.value, 10)); // 用于排版的值始终夹紧（负边距会让页面变形）
    onChange();
  });
  el.addEventListener("change", () => {
    el.value = clamp(parseInt(el.value, 10)); // 失焦时把输入框也纠正回合法范围
  });
}

function initSettingsUI() {
  // 主题按钮
  function refreshThemeBtns() {
    document
      .querySelectorAll(".theme-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.theme === settings.theme));
  }
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.addEventListener("click", () => {
      settings.theme = b.dataset.theme;
      refreshThemeBtns();
      applyShellTheme(settings.theme);
      onChange();
    });
  });
  refreshThemeBtns();

  const font = document.getElementById("set-font");
  font.value = settings.fontFamily;
  font.addEventListener("change", () => {
    settings.fontFamily = font.value;
    onChange();
  });
  bindRange("set-size", "v-size", "fontSize", (v) => v + "px");
  bindRange("set-line", "v-line", "lineHeight", (v) => v.toFixed(1));
  bindRange("set-para", "v-para", "paraSpacing", (v) => v.toFixed(1) + "em");
  bindRange("set-letter", "v-letter", "letterSpacing", (v) => v + "px");
  bindNum("set-mt", "marginTop");
  bindNum("set-mb", "marginBottom");
  bindNum("set-ml", "marginLeft");
  bindNum("set-mr", "marginRight");
  // 朗读设置
  const bindSel = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = settings[key];
    el.addEventListener("change", () => { settings[key] = el.value; onChange(); });
  };
  bindSel("set-ttssrc", "ttsSource");
  bindSel("set-ttsvoice", "ttsVoice");
  bindRange("set-ttsrate", "v-ttsrate", "ttsRate", (v) => v.toFixed(1) + "×");
}

// ---------- 目录 / 导航 ----------
const tocPane = document.getElementById("toc-pane");
const bmPane = document.getElementById("bm-pane");
function setToc(open) {
  tocEl.classList.toggle("show", open);
  backdropEl.classList.toggle("show", open);
  if (open) setTocTab("toc"); // 每次打开默认目录页
}
// 目录 / 书签 标签切换
function setTocTab(which) {
  const isToc = which === "toc";
  document.getElementById("tab-toc").classList.toggle("active", isToc);
  document.getElementById("tab-bm").classList.toggle("active", !isToc);
  tocPane.hidden = !isToc;
  bmPane.hidden = isToc;
  if (isToc) highlightCurrentToc();
  else renderBookmarks();
}
document.getElementById("tab-toc").addEventListener("click", () => setTocTab("toc"));
document.getElementById("tab-bm").addEventListener("click", () => setTocTab("bm"));
// 高亮当前阅读位置对应的目录条目，打勾并滚到中间
function highlightCurrentToc() {
  const items = [...tocPane.querySelectorAll(".toc-item")];
  items.forEach((it) => it.classList.remove("toc-current"));
  // 当前章内的目录条目（同一 spine 章里常有多条，如“卷一 七绝/咏华清宫…”）
  const inCh = items.filter((it) => parseInt(it.dataset.chapter || "-1", 10) === curChapter);
  if (inCh.length > 1) {
    // 多条同章条目：让阅读页按当前页判断落在哪一条 frag 上
    sendToPage({ resolveToc: inCh.map((it) => it.dataset.frag || "") });
    return; // 等 tocResolved 回复再高亮
  }
  // 0 或 1 条：退回“章节序号 <= 当前章 的最近一条”
  let best = null,
    bestCh = -1;
  items.forEach((it) => {
    const c = parseInt(it.dataset.chapter || "-1", 10);
    if (c <= curChapter && c > bestCh) {
      best = it;
      bestCh = c;
    }
  });
  markToc(best);
}
// 给某个目录条目打勾并滚到中间
function markToc(el) {
  tocPane.querySelectorAll(".toc-item").forEach((it) => it.classList.remove("toc-current"));
  if (!el) return;
  el.classList.add("toc-current");
  el.scrollIntoView({ block: "center" });
}
document.getElementById("toc-btn").addEventListener("click", () => {
  closeSettings();
  if (rsearch.classList.contains("show")) toggleSearch(false);
  setVocab(false); // 与生词本互斥
  setToc(!tocEl.classList.contains("show"));
});
backdropEl.addEventListener("click", () => {
  setToc(false);
  setVocab(false);
});

// ---------- 生词本（查过的词，中/英分开）----------
const vocabEl = document.getElementById("vocab");
const vocabPane = document.getElementById("vocab-pane");
const vocabSettings = document.getElementById("vocab-settings");
const vocabGear = document.getElementById("vocab-gear");
const vocabCountToggle = document.getElementById("vocab-count-toggle");
const vocabSortTime = document.getElementById("vsort-time");
const vocabSortCount = document.getElementById("vsort-count");
let vocabLang = "zh";
let vocabShowCount = localStorage.getItem("vocabShowCount") !== "0";
let vocabSort = localStorage.getItem("vocabSort") || "time";
function applyVocabSettings() {
  vocabCountToggle.checked = vocabShowCount;
  vocabEl.classList.toggle("hide-count", !vocabShowCount);
  vocabSortTime.classList.toggle("active", vocabSort === "time");
  vocabSortCount.classList.toggle("active", vocabSort === "count");
}
function setVocab(open) {
  vocabEl.classList.toggle("show", open);
  backdropEl.classList.toggle("show", open);
  if (!open) vocabSettings.classList.remove("show");
  if (open) {
    tocEl.classList.remove("show"); // 与目录互斥
    applyVocabSettings();
    renderVocab();
  }
}
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
      list.forEach((it) => {
        const row = document.createElement("div");
        row.className = "vc-item";
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
        const del = document.createElement("button");
        del.className = "vc-del";
        del.textContent = "✕";
        del.title = "从生词本删除";
        del.addEventListener("click", () => {
          invoke("vocab_remove", { word: it.word, lang: it.lang }).then(() => renderVocab()).catch(() => {});
        });
        row.append(main, del);
        vocabPane.appendChild(row);
      });
    })
    .catch(() => {});
}
document.getElementById("vtab-zh").addEventListener("click", () => setVocabTab("zh"));
document.getElementById("vtab-en").addEventListener("click", () => setVocabTab("en"));
vocabGear.addEventListener("click", (e) => {
  e.stopPropagation();
  vocabSettings.classList.toggle("show");
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
  closeSettings();
  if (rsearch.classList.contains("show")) toggleSearch(false);
  setToc(false); // 与目录互斥
  setVocab(!vocabEl.classList.contains("show"));
});
document.getElementById("gear-btn").addEventListener("click", () => {
  const willShow = !settingsEl.classList.contains("show");
  if (willShow && rsearch.classList.contains("show")) toggleSearch(false); // 一次只开一个浮层
  settingsEl.classList.toggle("show");
  syncOverlay();
});
document.getElementById("prev-btn").addEventListener("click", () => {
  if (vchaps.length) {
    if (curVchap > 0) {
      const v = vchaps[curVchap - 1];
      sendToPage({ gotoChapter: v.ch, frag: v.frag || undefined });
    }
  } else if (curChapter > 0) sendToPage({ gotoChapter: curChapter - 1 });
});
document.getElementById("next-btn").addEventListener("click", () => {
  if (vchaps.length) {
    if (curVchap < vchapTotal - 1) {
      const v = vchaps[curVchap + 1];
      sendToPage({ gotoChapter: v.ch, frag: v.frag || undefined });
    }
  } else if (curChapter < curTotalCh - 1) sendToPage({ gotoChapter: curChapter + 1 });
});

function buildToc(toc) {
  tocPane.innerHTML = "";
  if (!toc.length) {
    const hint = document.createElement("div");
    hint.className = "toc-item";
    hint.style.color = "#999";
    hint.textContent = "（无目录）";
    tocPane.appendChild(hint);
    return;
  }
  for (const entry of toc) {
    const item = document.createElement("div");
    item.className = "toc-item";
    item.style.paddingLeft = 8 + entry.level * 14 + "px";
    item.textContent = entry.label;
    item.title = entry.label;
    item.dataset.chapter = entry.chapter;
    item.dataset.frag = entry.frag || "";
    item.addEventListener("click", () => {
      sendToPage({ gotoChapter: entry.chapter, frag: entry.frag || undefined });
      setToc(false);
    });
    tocPane.appendChild(item);
  }
}

// ---------- 启动 ----------
// ---- 书签（在目录抽屉的「书签」标签里管理）----
const bmList = document.getElementById("bm-list2");
let bookmarks = [];
function renderBookmarks() {
  bmList.innerHTML = "";
  if (!bookmarks.length) {
    const e = document.createElement("div");
    e.className = "bm-empty";
    e.textContent = "暂无书签";
    bmList.appendChild(e);
    return;
  }
  bookmarks.forEach((bm, i) => {
    const item = document.createElement("div");
    item.className = "bm-item";
    const t = document.createElement("span");
    t.className = "bm-text";
    let txt = bm.label || "第 " + ((bm.chapter || 0) + 1) + " " + (isPdf ? "页" : "章");
    if (isPdf) txt = txt.replace(/^(第\s*\d+\s*)章/, "$1页"); // 旧书签把"页"错标成"章"，显示时纠正
    t.textContent = txt;
    const del = document.createElement("span");
    del.className = "bm-del";
    del.textContent = "✕";
    item.append(t, del);
    item.addEventListener("click", async (e) => {
      if (e.target === del) {
        bookmarks = await invoke("remove_bookmark", { index: i });
        renderBookmarks();
        return;
      }
      sendToPage({ gotoChapter: bm.chapter || 0, chFrac: bm.frac || 0 });
      // 不关书签页：允许连续点多个书签跳转；点正文（侧栏外的遮罩）才关闭
    });
    bmList.appendChild(item);
  });
}
document.getElementById("bm-add2").addEventListener("click", async () => {
  const label = "第 " + (curChapter + 1) + " " + (isPdf ? "页" : "章") + " · " + curProgress.toFixed(1) + "%";
  bookmarks = await invoke("add_bookmark", { chapter: curChapter, frac: curChFrac, label });
  renderBookmarks();
});

// ---- 批注 / 高亮（大批注页：列出多条，含上下文，可点编辑）----
const annoModal = document.getElementById("anno-modal");
const annoList = document.getElementById("anno-list");
let highlights = [];
function renderHighlights() {
  // 兼容旧调用名；实际只在批注页打开时才需要重绘
  if (annoModal.classList.contains("show")) renderAnnotations();
}
async function addHighlight(o, note, openNote) {
  highlights = await invoke("add_highlight", {
    chapter: o.chapter,
    start: o.start,
    end: o.end,
    text: o.text || "",
    context: o.context || "",
    rects: o.rects || "",
    color: "y",
    note: note || "",
  });
  sendToPage({ highlights }); // 让合并页重绘高亮（带正确的下标）
  if (openNote) openAnnotations(highlights.length - 1); // 批注：打开大批注页
  // EPUB：就地把工具栏换成"取消高亮"菜单；PDF：高亮后直接收菜单，不再弹（避免叠菜单）
  else if (!isPdf) sendToPage({ showHlMenuFor: highlights.length - 1 });
}
// 在上下文里把"被批注的文字本身"高亮出来
function ctxHtml(h) {
  const ctx = h.context || h.text || "";
  const t = (h.text || "").trim();
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  if (t && ctx.includes(t)) {
    const i = ctx.indexOf(t);
    return esc(ctx.slice(0, i)) + "<mark>" + esc(t) + "</mark>" + esc(ctx.slice(i + t.length));
  }
  return esc(ctx);
}
function renderAnnotations(targetIdx) {
  annoList.innerHTML = "";
  if (!highlights.length) {
    annoList.innerHTML = '<div class="anno-empty">还没有批注 / 高亮。<br>在正文里选中文字 → 点「高亮」或「批注」即可添加。</div>';
    return;
  }
  highlights.forEach((h, i) => {
    const item = document.createElement("div");
    item.className = "anno-item";
    if (i === targetIdx) item.classList.add("target");

    const meta = document.createElement("div");
    meta.className = "anno-meta";
    const ch = document.createElement("span");
    ch.className = "anno-ch";
    ch.textContent = "第 " + ((h.chapter || 0) + 1) + " 章 · 跳转";
    ch.addEventListener("click", () => {
      sendToPage({ gotoHighlight: i });
      annoModal.classList.remove("show");
    });
    const editBtn = document.createElement("span");
    editBtn.className = "anno-edit-btn";
    editBtn.textContent = h.note ? "✏ 编辑批注" : "✏ 添加批注";
    const del = document.createElement("span");
    del.className = "anno-del";
    del.textContent = "🗑 删除";
    del.addEventListener("click", async () => {
      highlights = await invoke("remove_highlight", { index: i });
      sendToPage({ highlights });
      renderAnnotations();
    });
    meta.append(ch, editBtn, del);

    const ctx = document.createElement("div");
    ctx.className = "anno-ctx";
    ctx.innerHTML = ctxHtml(h);

    // 批注只读展示（有批注才显示，不白占空间）
    const noteView = document.createElement("div");
    noteView.className = "anno-note-view";
    noteView.textContent = h.note || "";
    if (!h.note) noteView.style.display = "none";

    // 编辑区：默认收起，点"编辑"滑开
    const edit = document.createElement("div");
    edit.className = "anno-edit";
    const ta = document.createElement("textarea");
    ta.className = "anno-note";
    ta.value = h.note || "";
    const acts = document.createElement("div");
    acts.className = "anno-edit-actions";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
    cancel.className = "cancel";
    const save = document.createElement("button");
    save.textContent = "保存";
    save.className = "save";
    acts.append(cancel, save);
    edit.append(ta, acts);

    editBtn.addEventListener("click", () => {
      const opening = !edit.classList.contains("open");
      edit.classList.toggle("open", opening);
      if (opening) {
        ta.value = h.note || "";
        ta.focus();
      }
    });
    cancel.addEventListener("click", () => edit.classList.remove("open"));
    save.addEventListener("click", async () => {
      highlights = await invoke("set_highlight_note", { index: i, note: ta.value });
      sendToPage({ highlights });
      h.note = ta.value;
      noteView.textContent = ta.value;
      noteView.style.display = ta.value ? "" : "none";
      editBtn.textContent = ta.value ? "✏ 编辑批注" : "✏ 添加批注";
      edit.classList.remove("open");
    });

    item.append(meta, ctx, noteView, edit);
    annoList.appendChild(item);
  });
}
function openAnnotations(idx) {
  annoModal.classList.add("show");
  renderAnnotations(idx);
  if (typeof idx === "number") {
    const items = annoList.querySelectorAll(".anno-item");
    if (items[idx]) {
      items[idx].scrollIntoView({ block: "center" });
      const edit = items[idx].querySelector(".anno-edit");
      const ta = items[idx].querySelector(".anno-note");
      if (edit) edit.classList.add("open"); // 新建/点编辑进来 → 直接展开编辑区
      if (ta) setTimeout(() => ta.focus(), 50);
    }
  }
}
document.getElementById("hl-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  openAnnotations();
});
document.getElementById("anno-close").addEventListener("click", () => annoModal.classList.remove("show"));
annoModal.addEventListener("click", (e) => {
  if (e.target === annoModal) annoModal.classList.remove("show"); // 点遮罩关闭
});

(async () => {
  initSettingsUI();
  applyShellTheme(settings.theme);
  try {
    const info = await invoke("book_info");
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
