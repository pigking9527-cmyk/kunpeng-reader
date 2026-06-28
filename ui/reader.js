// 阅读窗口逻辑（整本合并为一页，连续滚动）
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

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
// 逻辑（虚拟）章节：按目录把大文件细分。vchaps 为 [{ch:spine序号, frag}]
let vchaps = [];
let curVchap = 0;
let vchapTotal = 1;

function closeSettings() {
  settingsEl.classList.remove("show");
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
});
vbar.addEventListener("mousedown", (e) => {
  if (e.target === vthumb) return; // 点轨道空白处跳转
  sendToPage({ gotoFrac: fracFromY(e.clientY) });
});
document.addEventListener("mousemove", (e) => {
  if (!vdragging) return;
  sendToPage({ gotoFrac: fracFromY(e.clientY) });
});
document.addEventListener("mouseup", () => {
  if (vdragging) {
    vdragging = false;
    document.body.style.userSelect = "";
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
    ch.textContent = "第" + (h.chapter + 1) + "章";
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
      sendToPage({ gotoChapter: h.chapter, search: term });
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
function runSearch(q) {
  q = (q || "").trim();
  if (!q) {
    renderRHistory();
    return;
  }
  rsearchCount.textContent = "搜索中…";
  invoke("search_book", { term: q })
    .then((hits) => {
      if (rsearchInput.value.trim() === q) renderResults(q, hits);
    })
    .catch(() => {});
}
function toggleSearch(show) {
  rsearch.classList.toggle("show", show);
  if (show) {
    rsearchInput.value = "";
    renderRHistory(); // 打开就显示自有历史
    rsearchInput.focus();
  } else {
    sendToPage({ clearMarks: 1 }); // 只清高亮，不改变阅读位置
    rsearchInput.value = "";
    rsearchCount.textContent = "";
    rsearchResults.innerHTML = "";
  }
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
    const gP = e.data.gPage || 0,
      gT = e.data.gTotal || 0;
    const pageStr =
      gT > 0
        ? gP + "/" + gT + "页"
        : (e.data.page || 1) + "/" + (e.data.total || 1) + "页(本章)";
    progressEl.textContent =
      "第" + (curVchap + 1) + "/" + vchapTotal + "章 · " + pageStr + " · " + curProgress.toFixed(1) + "%";
    reportProgress();
    if (!vdragging) updateThumb();
    hideLoading(); // 当前章排版完成
  }
  if (e.data.uiClick) closeSettings();
  if (e.data.ready) {
    hideLoading();
    frameReady = true;
    if (vchaps.length) sendToPage({ vchaps }); // 把逻辑章节表交给合并页
    if (pendingJump) {
      doJump(pendingJump);
      pendingJump = null;
    }
  }
  if (e.data.webSearch) {
    invoke("web_search", { term: e.data.webSearch }).catch(() => {});
  }
  if (e.data.tocResolved && tocEl.classList.contains("show")) {
    const r = e.data.tocResolved;
    if (r.chapter === curChapter) {
      const items = [...tocEl.querySelectorAll(".toc-item")];
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
  let dir = 0;
  if (e.key === "PageDown" || e.key === "ArrowRight" || (e.key === " " && !e.shiftKey)) dir = 1;
  else if (e.key === "PageUp" || e.key === "ArrowLeft" || (e.key === " " && e.shiftKey)) dir = -1;
  if (dir !== 0) {
    e.preventDefault();
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
  el.value = settings[key];
  el.addEventListener("input", () => {
    settings[key] = parseInt(el.value || "0", 10);
    onChange();
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
}

// ---------- 目录 / 导航 ----------
function setToc(open) {
  tocEl.classList.toggle("show", open);
  backdropEl.classList.toggle("show", open);
  if (open) highlightCurrentToc();
}
// 高亮当前阅读位置对应的目录条目，打勾并滚到中间
function highlightCurrentToc() {
  const items = [...tocEl.querySelectorAll(".toc-item")];
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
  tocEl.querySelectorAll(".toc-item").forEach((it) => it.classList.remove("toc-current"));
  if (!el) return;
  el.classList.add("toc-current");
  el.scrollIntoView({ block: "center" });
}
document.getElementById("toc-btn").addEventListener("click", () => {
  settingsEl.classList.remove("show");
  setToc(!tocEl.classList.contains("show"));
});
backdropEl.addEventListener("click", () => setToc(false));
document.getElementById("gear-btn").addEventListener("click", () => {
  settingsEl.classList.toggle("show");
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
  tocEl.innerHTML = "";
  if (!toc.length) {
    const hint = document.createElement("div");
    hint.className = "toc-item";
    hint.style.color = "#999";
    hint.textContent = "（无目录）";
    tocEl.appendChild(hint);
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
    tocEl.appendChild(item);
  }
}

// ---------- 启动 ----------
// ---- 书签 ----
const bmPanel = document.getElementById("bm-panel");
const bmList = document.getElementById("bm-list");
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
    t.textContent = bm.label;
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
      bmPanel.classList.remove("show");
    });
    bmList.appendChild(item);
  });
}
document.getElementById("bm-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  bmPanel.classList.toggle("show");
});
bmPanel.addEventListener("click", (e) => e.stopPropagation());
document.getElementById("bm-add").addEventListener("click", async () => {
  const label = "第 " + (curChapter + 1) + " 章 · " + curProgress.toFixed(1) + "%";
  bookmarks = await invoke("add_bookmark", {
    chapter: curChapter,
    frac: curChFrac,
    label,
  });
  renderBookmarks();
});
document.addEventListener("click", () => bmPanel.classList.remove("show"));

(async () => {
  initSettingsUI();
  applyShellTheme(settings.theme);
  try {
    const info = await invoke("book_info");
    bookmarks = info.bookmarks || [];
    renderBookmarks();
    if (info.format === "pdf") {
      document.body.classList.add("pdf-mode"); // 交给 WebView2 自带 PDF 阅读器
      frame.src = info.url;
      return;
    }
    resumeChapter = info.resume_chapter || 0;
    resumeFrac = info.resume_frac || 0;
    buildToc(info.toc || []);
    // 用目录把（可能整本塞进一个文件的）spine 细分成逻辑章节；只取最上层目录，避免把子小节也当成章
    const toc = info.toc || [];
    let top = toc;
    if (toc.length) {
      const minL = Math.min(...toc.map((e) => e.level || 0));
      top = toc.filter((e) => (e.level || 0) === minL);
      if (top.length < 3) top = toc.filter((e) => (e.level || 0) <= minL + 1); // 顶层太少则带上次一层
    }
    vchaps = top.map((e) => ({ ch: e.chapter || 0, frag: e.frag || "" }));
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
