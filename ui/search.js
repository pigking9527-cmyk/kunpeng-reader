// 书架全文检索结果窗口
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单
// 禁用浏览器自带查找（Ctrl+F / F3）
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

const qEl = document.getElementById("q");
const goEl = document.getElementById("go");
const sortEl = document.getElementById("sort");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const qhistEl = document.getElementById("qhistory");
const searchAlert = document.getElementById("search-alert");
const searchAlertTitle = document.getElementById("search-alert-title");
const searchAlertMessage = document.getElementById("search-alert-message");
const searchAlertOk = document.getElementById("search-alert-ok");

function showSearchAlert(message, title = "提示") {
  if (window.parent !== window && window.parent.AppDialog?.alert) {
    return window.parent.AppDialog.alert(message, { title, confirmLabel: "知道了", tone: "warning" });
  }
  searchAlertTitle.textContent = title;
  searchAlertMessage.textContent = message;
  if (typeof searchAlert.showModal === "function") searchAlert.showModal();
  else window.alert(message);
  return Promise.resolve();
}
searchAlertOk.addEventListener("click", () => searchAlert.close());

// 搜索窗口打开即预热模型；不加载全局向量图，也不等待结果，因此不影响关键词输入。
// 这样用户切换到语义模式时，模型加载通常已经完成。
function warmSemanticModelForShelfSearch() {
  window.setTimeout(() => invoke("warm_semantic_model").catch(() => {}), 120);
}
warmSemanticModelForShelfSearch();

// ---- 搜索历史 ----
let qhist = [];
let qcommon = {};
try {
  qhist = JSON.parse(localStorage.getItem("shelfSearchHistory") || "[]");
} catch (e) {
  qhist = [];
}
try {
  qcommon = JSON.parse(localStorage.getItem("shelfSearchCommon") || "{}");
} catch (e) {
  qcommon = {};
}
function saveQHist() {
  localStorage.setItem("shelfSearchHistory", JSON.stringify(qhist.slice(0, 12)));
}
function saveQCommon() {
  localStorage.setItem("shelfSearchCommon", JSON.stringify(qcommon));
}

// search-history-rules.js 未加载时继续使用这一份等价纯规则回退，避免独立
// WebView 的脚本加载失败破坏历史搜索入口。
const searchHistoryRules = window.ReaderSearchHistoryRules || (() => {
  function normalizedSearchTerm(value) {
    return String(value || "").trim();
  }
  function recordSearchQuery(history, common, query, now, maxHistory) {
    const term = normalizedSearchTerm(query);
    const limit = Number.isInteger(maxHistory) && maxHistory > 0 ? maxHistory : 12;
    const entries = Array.isArray(history) ? history : [];
    const counts = common && typeof common === "object" && !Array.isArray(common) ? common : {};
    if (!term) return { history: entries.slice(0, limit), common: { ...counts } };
    const previous = counts[term] || {};
    return {
      history: [term, ...entries.filter((entry) => entry !== term)].slice(0, limit),
      common: { ...counts, [term]: { count: (Number(previous.count) || 0) + 1, last: now } },
    };
  }
  function removeSearchQuery(history, query) {
    const term = normalizedSearchTerm(query);
    return (Array.isArray(history) ? history : []).filter((entry) => entry !== term);
  }
  function commonSearches(common, limit) {
    const maximum = Number.isInteger(limit) && limit >= 0 ? limit : 6;
    const counts = common && typeof common === "object" && !Array.isArray(common) ? common : {};
    return Object.entries(counts)
      .sort((left, right) => (Number(right[1]?.count) || 0) - (Number(left[1]?.count) || 0)
        || (Number(right[1]?.last) || 0) - (Number(left[1]?.last) || 0))
      .slice(0, maximum)
      .map(([query, value]) => ({ query, count: Number(value?.count) || 0 }));
  }
  return { normalizedSearchTerm, recordSearchQuery, removeSearchQuery, commonSearches };
})();

function addQHist(q) {
  const next = searchHistoryRules.recordSearchQuery(qhist, qcommon, q, Date.now(), 12);
  qhist = next.history;
  qcommon = next.common;
  saveQHist();
  saveQCommon();
}
function renderQHist() {
  qhistEl.innerHTML = "";
  const common = searchHistoryRules.commonSearches(qcommon, 6);
  if (common.length) {
    const title = document.createElement("div");
    title.className = "qh-empty";
    title.textContent = "常搜词";
    qhistEl.appendChild(title);
    common.forEach(({ query, count }) => {
      const item = document.createElement("div");
      item.className = "qh-item";
      item.innerHTML = '<span class="qh-text"></span><span class="qh-del">×' + count + "</span>";
      item.querySelector(".qh-text").textContent = query;
      item.addEventListener("click", () => {
        qEl.value = query;
        hideQHist();
        runSearch(query);
      });
      qhistEl.appendChild(item);
    });
  }
  if (!qhist.length) {
    const e = document.createElement("div");
    e.className = "qh-empty";
    e.textContent = "暂无搜索记录";
    qhistEl.appendChild(e);
    return;
  }
  const histTitle = document.createElement("div");
  histTitle.className = "qh-empty";
  histTitle.textContent = "搜索历史";
  qhistEl.appendChild(histTitle);
  qhist.forEach((q) => {
    const item = document.createElement("div");
    item.className = "qh-item";
    const t = document.createElement("span");
    t.className = "qh-text";
    t.textContent = q;
    const del = document.createElement("span");
    del.className = "qh-del";
    del.textContent = "✕";
    item.append(t, del);
    item.addEventListener("click", (e) => {
      if (e.target === del) {
        qhist = searchHistoryRules.removeSearchQuery(qhist, q);
        saveQHist();
        renderQHist();
        return;
      }
      qEl.value = q;
      hideQHist();
      runSearch(q);
    });
    qhistEl.appendChild(item);
  });
}
function showQHist() {
  renderQHist();
  qhistEl.classList.add("show");
}
function hideQHist() {
  qhistEl.classList.remove("show");
}

let curTerm = "";
let curIds = []; // 限定的图书 id（空 = 全部）
let curResults = []; // 后端返回的分组结果
let curSimilar = []; // 保留结果结构兼容；关键词检索不再偷偷追加语义计算
let pendingBooks = 0; // 缺少已发布全文索引、已转交后台补建的图书数
let searchSeq = 0;
let renderGeneration = 0;
let keywordRetryTimer = 0;
let keywordRetryCount = 0;
const RESULT_GROUPS_PER_FRAME = 8;
const INITIAL_EXPANDED_BOOKS = 1;
const KEYWORD_RETRY_LIMIT = 180;

function stopKeywordRetry() {
  window.clearTimeout(keywordRetryTimer);
  keywordRetryTimer = 0;
  keywordRetryCount = 0;
}

function scheduleKeywordRetry(term) {
  if (mode !== "kw" || !pendingBooks || keywordRetryTimer || keywordRetryCount >= KEYWORD_RETRY_LIMIT) return;
  keywordRetryCount += 1;
  keywordRetryTimer = window.setTimeout(() => {
    keywordRetryTimer = 0;
    if (mode === "kw" && qEl.value.trim() === term && pendingBooks > 0) {
      void runSearch(term, { retry: true });
    }
  }, 1000);
}

function parseInitial() {
  const p = new URLSearchParams(location.search);
  curTerm = (p.get("q") || "").trim();
  const ids = (p.get("ids") || "").trim();
  curIds = ids ? ids.split(",").filter(Boolean) : [];
}

// search-result-rules.js 尚未加入 search.html 时继续使用这里的等价回退。
// 这样提取纯规则不会改变当前独立窗口的加载顺序或可用性。
const searchResultRules = window.ReaderSearchResultRules || (() => {
  function escapeHtml(value) {
    return String(value).replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[character]));
  }
  function cjkNgramsForHighlight(text) {
    const chars = Array.from(String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu) || []);
    const out = [];
    for (const n of [3, 2]) {
      if (chars.length < n) continue;
      for (let i = 0; i + n <= chars.length; i += 1) out.push(chars.slice(i, i + n).join(""));
    }
    return out;
  }
  function highlightNeedles(term) {
    const raw = String(term || "").trim();
    const seen = new Set();
    const out = [];
    function add(value, allowSingleCjk) {
      const normalized = String(value || "").trim();
      if (normalized.length < 2 && !allowSingleCjk) return;
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(normalized);
      }
    }
    add(raw, /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$/u.test(raw));
    (raw.match(/[A-Za-z0-9]{2,}/g) || []).forEach(add);
    cjkNgramsForHighlight(raw).forEach(add);
    return out.sort((left, right) => right.length - left.length);
  }
  function highlightSnippet(snippet, term) {
    const text = String(snippet || "");
    const needles = highlightNeedles(term);
    if (!needles.length) return escapeHtml(text);
    const low = text.toLowerCase();
    let html = "";
    let pos = 0;
    while (pos < text.length) {
      const match = needles.find((needle) => low.startsWith(needle.toLowerCase(), pos));
      if (match) {
        html += "<mark>" + escapeHtml(text.slice(pos, pos + match.length)) + "</mark>";
        pos += match.length;
      } else {
        html += escapeHtml(text[pos]);
        pos += 1;
      }
    }
    return html;
  }
  function sortSearchResults(list, mode) {
    const results = list.slice();
    if (mode === "title") results.sort((left, right) => (left.title || "").localeCompare(right.title || "", "zh"));
    else if (mode === "author") results.sort((left, right) => (left.author || "").localeCompare(right.author || "", "zh"));
    else if (mode === "hits") results.sort((left, right) => right.count - left.count);
    else results.sort((left, right) => (right.score || right.count || 0) - (left.score || left.count || 0));
    return results;
  }
  return { escapeHtml, cjkNgramsForHighlight, highlightNeedles, highlightSnippet, sortSearchResults };
})();
const escapeHtml = searchResultRules.escapeHtml;
const highlight = searchResultRules.highlightSnippet;
function sortResults(list) {
  return searchResultRules.sortSearchResults(list, sortEl.value);
}

// 把某本书的命中片段实际建进 DOM（懒加载：展开时才建，避免一次性渲染上千条而卡顿）
function buildHits(book, hitsWrap) {
  const frag = document.createDocumentFragment();
  const visibleHits = Array.isArray(book.hits) ? book.hits : [];
  function createHit(h) {
    const hit = document.createElement("div");
    hit.className = "hit";
    const meta = [];
    if (typeof h.count === "number" && h.count > 1) meta.push(h.count + " 处");
    if (typeof h.score === "number" && h.score > 0 && mode === "sem") {
      meta.push("相似 " + Math.round(h.score * 100) + "%");
    }
    const scoreTag = meta.length ? '<span class="hit-meta">' + meta.join(" · ") + "</span>" : "";
    const body = mode === "sem" ? escapeHtml(h.snippet) : highlight(h.snippet, curTerm);
    hit.innerHTML = scoreTag + '<span class="ch">第' + (h.chapter + 1) + "章</span>" + body;
    hit.addEventListener("click", () => openHit(book.book_id, h.chapter));
    return hit;
  }
  visibleHits.forEach((hit) => frag.appendChild(createHit(hit)));
  if (typeof book.count === "number" && book.count > visibleHits.length) {
    const more = document.createElement("div");
    more.className = "more";
    let loaded = visibleHits.length;
    let loading = false;
    const query = curTerm;
    const generation = renderGeneration;
    function updateMore() {
      const remaining = Math.max(0, book.count - loaded);
      if (!remaining) {
        more.remove();
        return;
      }
      more.textContent = "… 另有 " + remaining + " 处未显示，点击再显示 " + Math.min(10, remaining) + " 处";
    }
    more.addEventListener("click", async () => {
      if (loading) return;
      loading = true;
      more.textContent = "正在加载…";
      try {
        const extra = await invoke("shelf_search_book_hits", {
          request: { bookId: book.book_id, term: query, offset: loaded, limit: 10 },
        });
        if (generation !== renderGeneration || query !== curTerm || mode !== "kw") return;
        const page = Array.isArray(extra) ? extra : [];
        const pageFragment = document.createDocumentFragment();
        page.forEach((hit) => pageFragment.appendChild(createHit(hit)));
        hitsWrap.insertBefore(pageFragment, more);
        loaded += page.length;
        if (!page.length) {
          loaded = book.count;
          updateMore();
          return;
        }
        updateMore();
      } catch (error) {
        more.textContent = "加载失败，点击重试";
      } finally {
        loading = false;
      }
    });
    updateMore();
    frag.appendChild(more);
  }
  hitsWrap.appendChild(frag);
}

function createBookGroup(book, index) {
  const group = document.createElement("div");
  const startsExpanded = index < INITIAL_EXPANDED_BOOKS;
  group.className = "book-group" + (startsExpanded ? "" : " collapsed");

  const head = document.createElement("div");
  head.className = "book-head";
  head.innerHTML =
    '<span class="caret">▾</span>' +
    '<span class="book-title">' + escapeHtml(book.title || "未命名") + "</span>" +
    (book.author ? '<span class="book-author">' + escapeHtml(book.author) + "</span>" : "") +
    '<span class="book-count">' +
      (typeof book.count === "number" ? book.count + " 处" : "相似 " + Math.round(book.score * 100) + "%") +
    "</span>";
  const hitsWrap = document.createElement("div");
  hitsWrap.className = "hits";
  function ensureHits() {
    if (hitsWrap.dataset.built) return;
    buildHits(book, hitsWrap);
    hitsWrap.dataset.built = "1";
  }
  head.addEventListener("click", () => {
    const willOpen = group.classList.contains("collapsed");
    if (willOpen) ensureHits();
    group.classList.toggle("collapsed");
  });
  if (startsExpanded) ensureHits();
  group.append(head, hitsWrap);
  return group;
}

function render() {
  const generation = ++renderGeneration;
  resultsEl.innerHTML = "";
  if (!curResults.length && !curSimilar.length) {
    resultsEl.innerHTML = '<div class="empty">未找到「' + escapeHtml(curTerm) + "」</div>";
    return;
  }
  if (mode === "kw" && curSimilar.length) {
    const sim = document.createElement("div");
    sim.className = "book-group similar-group collapsed";
    const head = document.createElement("div");
    head.className = "book-head";
    head.innerHTML = '<span class="caret">▾</span><span class="book-title">相似段落推荐</span><span class="book-count">' + curSimilar.length + " 本</span>";
    const hitsWrap = document.createElement("div");
    hitsWrap.className = "hits";
    head.addEventListener("click", () => {
      const willOpen = sim.classList.contains("collapsed");
      sim.classList.toggle("collapsed");
      if (willOpen && !hitsWrap.dataset.built) {
        curSimilar.slice(0, 3).forEach((book) => buildHits({ ...book, hits: (book.hits || []).slice(0, 2) }, hitsWrap));
        hitsWrap.dataset.built = "1";
      }
    });
    sim.append(head, hitsWrap);
    resultsEl.appendChild(sim);
  }
  if (!curResults.length) return;
  const list = sortResults(curResults);
  let nextIndex = 0;
  function appendNextFrame() {
    if (generation !== renderGeneration) return;
    const frag = document.createDocumentFragment();
    const end = Math.min(nextIndex + RESULT_GROUPS_PER_FRAME, list.length);
    while (nextIndex < end) {
      frag.appendChild(createBookGroup(list[nextIndex], nextIndex));
      nextIndex += 1;
    }
    resultsEl.appendChild(frag);
    if (nextIndex < list.length) window.requestAnimationFrame(appendNextFrame);
  }
  appendNextFrame();
}

function openHit(bookId, chapter) {
  try {
    localStorage.removeItem("crossReturnState");
    localStorage.removeItem("pendingCrossSearch");
  } catch (e) {}
  invoke("open_book_at", { request: { id: bookId, chapter, term: curTerm } }).catch(() => {});
}

async function runSearch(term, options = {}) {
  const retry = options.retry === true;
  if (!retry) stopKeywordRetry();
  const seq = ++searchSeq;
  if (!retry) renderGeneration += 1; // 立即终止上一轮仍在分帧追加的结果
  curTerm = (term || "").trim();
  qEl.value = curTerm;
  if (!curTerm) {
    curResults = [];
    curSimilar = [];
    pendingBooks = 0;
    summaryEl.textContent = "";
    resultsEl.innerHTML = '<div class="empty">输入文字后回车检索</div>';
    return;
  }
  if (!retry) {
    addQHist(curTerm);
    hideQHist();
    summaryEl.textContent = "检索中…";
    resultsEl.innerHTML = '<div class="loading">正在检索书架内容…</div>';
  }
  const limit = curIds.length ? curIds : null;
  try {
    if (mode === "sem") {
      curResults = await invoke("semantic_search", { query: curTerm, ids: limit });
      curSimilar = [];
      pendingBooks = 0;
    } else {
      const response = await invoke("shelf_search", { term: curTerm, ids: limit });
      // 兼容旧后端直接返回数组；新后端会把缺失索引的图书转后台建立，避免
      // 首次检索在 IPC 中同步解压大量 EPUB 而把窗口卡死。
      curResults = Array.isArray(response) ? response : (response?.results || []);
      pendingBooks = Array.isArray(response) ? 0 : Math.max(0, Number(response?.pendingBooks || 0));
      curSimilar = [];
    }
    if (seq !== searchSeq) return;
  } catch (e) {
    if (seq !== searchSeq) return;
    curResults = [];
    curSimilar = [];
    summaryEl.textContent = "检索出错：" + e;
    resultsEl.innerHTML = "";
    return;
  }
  const books = curResults.length;
  if (mode === "sem") {
    summaryEl.textContent = books
      ? "语义相近的结果（共 " + books + " 本书）" + (curIds.length ? "（限定 " + curIds.length + " 本）" : "")
      : "没有匹配（这些书是否已建立语义索引？）";
  } else {
    const hits = curResults.reduce((s, b) => s + b.count, 0);
    const pendingHint = pendingBooks
      ? "；另有 " + pendingBooks + " 本正在后台建立全文索引，完成后再次搜索即可纳入"
      : "";
    summaryEl.textContent = books
      ? "在 " + books + " 本书中找到 " + hits + " 处" + (curIds.length ? "（限定 " + curIds.length + " 本）" : "") + pendingHint
      : (pendingBooks ? "正在准备 " + pendingBooks + " 本书的全文索引，页面将自动显示结果…" : "未找到结果");
  }
  render();
  if (mode === "kw" && pendingBooks > 0) scheduleKeywordRetry(curTerm);
  else if (mode === "kw") stopKeywordRetry();
}

// ---- 关键词 / 语义 模式切换 ----
let mode = "kw";
const modeKw = document.getElementById("mode-kw");
const modeSem = document.getElementById("mode-sem");
const sortBox = sortEl;
async function semanticReadiness() {
  try {
    const status = await invoke("semantic_status");
    if (!status?.model_ready) {
      return "语义模型尚未下载或加载。\n请先在“语义索引设置”中下载模型。";
    }
    const ready = await invoke("semantic_index_done", { ids: curIds.length ? curIds : null });
    if (!ready) {
      const scope = curIds.length ? "当前选定的图书" : "书架图书";
      return scope + "还没有完成语义索引。\n请点击“建立语义索引”，完成后再使用语义检索。";
    }
    return "";
  } catch (_error) {
    return "暂时无法确认语义检索状态。\n请稍后重试，或在语义索引设置中检查模型与索引。";
  }
}

async function setMode(m) {
  if (mode === m) return;
  if (m === "sem") {
    const warning = await semanticReadiness();
    if (warning) {
      await showSearchAlert(warning, "语义检索未就绪");
      return;
    }
  }
  stopKeywordRetry();
  mode = m;
  document.body.classList.toggle("semantic-mode", m === "sem");
  modeKw.classList.toggle("active", m === "kw");
  modeSem.classList.toggle("active", m === "sem");
  sortBox.style.display = m === "sem" ? "none" : ""; // 语义按相似度固定排序
  qEl.placeholder = m === "sem" ? "描述你想找的“意思”，回车检索…" : "输入要在书架中检索的文字…";
  if (m === "sem") {
    window.setTimeout(() => invoke("warm_semantic_model").catch(() => {}), 0);
  }
  const inputTerm = qEl.value.trim();
  if (inputTerm) runSearch(inputTerm);
}
modeKw.addEventListener("click", () => { void setMode("kw"); });
modeSem.addEventListener("click", () => { void setMode("sem"); });

// ---- 建立语义索引 + 进度 ----
const buildBtn = document.getElementById("build-sem");
const semProgEl = document.getElementById("sem-progress");
let semPoll = null;
function pollSemStatus() {
  if (!semProgEl || !buildBtn) return;
  invoke("semantic_status")
    .then((p) => {
      if (p.error) {
        semProgEl.textContent = "无法建立语义索引：" + p.error;
        buildBtn.disabled = false;
        if (semPoll) clearInterval(semPoll);
        semPoll = null;
        return;
      }
      if (p.building) {
        if (p.shard_total) {
          semProgEl.textContent = "建立语义索引中… " + p.done + "/" + p.total +
            "；加速分片 " + p.shard_done + "/" + p.shard_total +
            "（" + (p.current || "") + "）";
        } else {
          semProgEl.textContent = "建立语义索引中… " + p.done + "/" + p.total + "（" + (p.current || "") + "）";
        }
      } else {
        // p.current 在结束时可能带“加速索引未建成”的温和说明（检索仍可用），优先展示
        semProgEl.textContent = p.current && p.current !== "完成"
          ? p.current
          : (p.total ? "语义索引已就绪（" + p.total + " 本）" : "");
        buildBtn.disabled = false;
        if (semPoll) clearInterval(semPoll);
        semPoll = null;
      }
    })
    .catch(() => {});
}
if (buildBtn) buildBtn.addEventListener("click", async () => {
  const limit = curIds.length ? curIds : null;
  const scope = curIds.length ? "选定的 " + curIds.length + " 本" : "全部图书";
  // 已建立完成就别重复建了
  try {
    const done = await invoke("semantic_index_done", { ids: limit });
    if (done) {
      alert("语义索引已建立完成（" + scope + "），无需重复建立。");
      semProgEl.textContent = "语义索引已就绪（已完成）";
      return;
    }
  } catch (e) {}
  if (!confirm("将为" + scope + "建立语义索引。\n首次会下载约120MB模型；大书库可能耗时较长（后台进行）。\n继续？")) return;
  buildBtn.disabled = true;
  semProgEl.textContent = "正在启动…";
  invoke("build_semantic_index", { ids: limit }).catch((e) => {
    semProgEl.textContent = "启动失败：" + e;
    buildBtn.disabled = false;
  });
  if (semPoll) clearInterval(semPoll);
  semPoll = setInterval(pollSemStatus, 1000);
});

goEl.addEventListener("click", () => runSearch(qEl.value));
qEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch(qEl.value);
});
qEl.addEventListener("focus", showQHist);
qEl.addEventListener("input", () => {
  // 用户已经开始改下一次查询时，旧请求即使随后返回也不得重建结果 DOM。
  searchSeq += 1;
  renderGeneration += 1;
  stopKeywordRetry();
  if (qEl.value.trim()) hideQHist();
  else showQHist();
});
// 点击搜索框外（输入框失焦）自动收起历史；留点延迟让历史项的点击先生效
qEl.addEventListener("blur", () => setTimeout(hideQHist, 150));
qhistEl.addEventListener("mousedown", (e) => e.preventDefault()); // 防止点历史项时输入框先失焦
sortEl.addEventListener("change", render);

// 窗口被复用时，主窗口发来新查询
listen("shelf-search-query", (e) => {
  const pl = e.payload || {};
  curIds = Array.isArray(pl.ids) ? pl.ids.filter(Boolean) : [];
  runSearch(pl.term || "");
});

parseInitial();
runSearch(curTerm);
