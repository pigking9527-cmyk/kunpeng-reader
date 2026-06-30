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
function addQHist(q) {
  q = (q || "").trim();
  if (!q) return;
  qhist = qhist.filter((h) => h !== q);
  qhist.unshift(q);
  qhist = qhist.slice(0, 12);
  const old = qcommon[q] || { count: 0, last: 0 };
  qcommon[q] = { count: old.count + 1, last: Date.now() };
  saveQHist();
  saveQCommon();
}
function renderQHist() {
  qhistEl.innerHTML = "";
  const common = Object.entries(qcommon)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0) || (b[1].last || 0) - (a[1].last || 0))
    .slice(0, 6)
    .map(([q, v]) => ({ q, count: v.count || 0 }));
  if (common.length) {
    const title = document.createElement("div");
    title.className = "qh-empty";
    title.textContent = "常搜词";
    qhistEl.appendChild(title);
    common.forEach(({ q, count }) => {
      const item = document.createElement("div");
      item.className = "qh-item";
      item.innerHTML = '<span class="qh-text"></span><span class="qh-del">×' + count + "</span>";
      item.querySelector(".qh-text").textContent = q;
      item.addEventListener("click", () => {
        qEl.value = q;
        hideQHist();
        runSearch(q);
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
        qhist = qhist.filter((h) => h !== q);
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
let curSimilar = []; // 关键词搜索时顺带展示的语义相似段落
let searchSeq = 0;

function parseInitial() {
  const p = new URLSearchParams(location.search);
  curTerm = (p.get("q") || "").trim();
  const ids = (p.get("ids") || "").trim();
  curIds = ids ? ids.split(",").filter(Boolean) : [];
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function highlight(snippet, term) {
  if (!term) return escapeHtml(snippet);
  const low = snippet.toLowerCase(),
    t = term.toLowerCase();
  let html = "",
    last = 0,
    idx = low.indexOf(t);
  while (idx >= 0) {
    html += escapeHtml(snippet.slice(last, idx)) + "<mark>" + escapeHtml(snippet.slice(idx, idx + term.length)) + "</mark>";
    last = idx + term.length;
    idx = low.indexOf(t, last);
  }
  html += escapeHtml(snippet.slice(last));
  return html;
}

function sortResults(list) {
  const a = list.slice();
  const mode = sortEl.value;
  if (mode === "title") a.sort((x, y) => (x.title || "").localeCompare(y.title || "", "zh"));
  else if (mode === "author") a.sort((x, y) => (x.author || "").localeCompare(y.author || "", "zh"));
  else a.sort((x, y) => y.count - x.count);
  return a;
}

// 把某本书的命中片段实际建进 DOM（懒加载：展开时才建，避免一次性渲染上千条而卡顿）
function buildHits(book, hitsWrap) {
  const frag = document.createDocumentFragment();
  book.hits.forEach((h) => {
    const hit = document.createElement("div");
    hit.className = "hit";
    const scoreTag = typeof h.score === "number" ? '<span class="score">' + Math.round(h.score * 100) + "%</span>" : "";
    const body = mode === "sem" ? escapeHtml(h.snippet) : highlight(h.snippet, curTerm);
    hit.innerHTML = scoreTag + '<span class="ch">第' + (h.chapter + 1) + "章</span>" + body;
    hit.addEventListener("click", () => openHit(book.book_id, h.chapter));
    frag.appendChild(hit);
  });
  if (typeof book.count === "number" && book.count > book.hits.length) {
    const more = document.createElement("div");
    more.className = "more";
    more.textContent = "… 另有 " + (book.count - book.hits.length) + " 处未显示";
    frag.appendChild(more);
  }
  hitsWrap.appendChild(frag);
}

function render() {
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
  const frag = document.createDocumentFragment(); // 一次性插入，避免逐条 reflow
  list.forEach((book) => {
    const group = document.createElement("div");
    group.className = "book-group"; // 默认展开

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
    head.addEventListener("click", () => group.classList.toggle("collapsed")); // 仍可手动收起
    buildHits(book, hitsWrap); // 默认就把片段建好（展开）
    group.appendChild(head);
    group.appendChild(hitsWrap);
    frag.appendChild(group);
  });
  resultsEl.appendChild(frag);
}

function openHit(bookId, chapter) {
  invoke("open_book_at", { id: bookId, chapter, term: curTerm }).catch(() => {});
}

async function runSearch(term) {
  const seq = ++searchSeq;
  curTerm = (term || "").trim();
  qEl.value = curTerm;
  if (!curTerm) {
    curResults = [];
    curSimilar = [];
    summaryEl.textContent = "";
    resultsEl.innerHTML = '<div class="empty">输入文字后回车检索</div>';
    return;
  }
  addQHist(curTerm);
  hideQHist();
  summaryEl.textContent = "检索中…";
  resultsEl.innerHTML = '<div class="loading">检索中…</div>';
  const limit = curIds.length ? curIds : null;
  try {
    if (mode === "sem") {
      curResults = await invoke("semantic_search", { query: curTerm, ids: limit });
      curSimilar = [];
    } else {
      curResults = await invoke("shelf_search", { term: curTerm, ids: limit });
      curSimilar = [];
    }
  } catch (e) {
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
    summaryEl.textContent = books
      ? "在 " + books + " 本书中找到 " + hits + " 处" + (curIds.length ? "（限定 " + curIds.length + " 本）" : "")
      : "未找到结果";
  }
  render();
  if (mode === "kw") {
    const q = curTerm;
    Promise.resolve()
      .then(() => invoke("semantic_index_done", { ids: limit }))
      .then((semReady) => semReady ? invoke("semantic_search", { query: q, ids: limit }) : [])
      .then((similar) => {
        if (seq !== searchSeq || mode !== "kw" || q !== curTerm) return;
        curSimilar = similar || [];
        render();
      })
      .catch(() => {});
  }
}

// ---- 关键词 / 语义 模式切换 ----
let mode = "kw";
const modeKw = document.getElementById("mode-kw");
const modeSem = document.getElementById("mode-sem");
const sortBox = sortEl;
function setMode(m) {
  mode = m;
  modeKw.classList.toggle("active", m === "kw");
  modeSem.classList.toggle("active", m === "sem");
  sortBox.style.display = m === "sem" ? "none" : ""; // 语义按相似度固定排序
  qEl.placeholder = m === "sem" ? "描述你想找的“意思”，回车检索…" : "输入要在书架中检索的文字…";
  if (curTerm) runSearch(curTerm);
}
modeKw.addEventListener("click", () => setMode("kw"));
modeSem.addEventListener("click", () => setMode("sem"));

// ---- 建立语义索引 + 进度 ----
const buildBtn = document.getElementById("build-sem");
const semProgEl = document.getElementById("sem-progress");
let semPoll = null;
function pollSemStatus() {
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
        semProgEl.textContent = "建立语义索引中… " + p.done + "/" + p.total + "（" + (p.current || "") + "）";
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
buildBtn.addEventListener("click", async () => {
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
