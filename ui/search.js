// 书架全文检索结果窗口
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;

const qEl = document.getElementById("q");
const goEl = document.getElementById("go");
const sortEl = document.getElementById("sort");
const summaryEl = document.getElementById("summary");
const resultsEl = document.getElementById("results");
const qhistEl = document.getElementById("qhistory");

// ---- 搜索历史 ----
let qhist = [];
try {
  qhist = JSON.parse(localStorage.getItem("shelfSearchHistory") || "[]");
} catch (e) {
  qhist = [];
}
function saveQHist() {
  localStorage.setItem("shelfSearchHistory", JSON.stringify(qhist.slice(0, 12)));
}
function addQHist(q) {
  q = (q || "").trim();
  if (!q) return;
  qhist = qhist.filter((h) => h !== q);
  qhist.unshift(q);
  qhist = qhist.slice(0, 12);
  saveQHist();
}
function renderQHist() {
  qhistEl.innerHTML = "";
  if (!qhist.length) {
    const e = document.createElement("div");
    e.className = "qh-empty";
    e.textContent = "暂无搜索记录";
    qhistEl.appendChild(e);
    return;
  }
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

function render() {
  resultsEl.innerHTML = "";
  if (!curResults.length) {
    resultsEl.innerHTML = '<div class="empty">未找到「' + escapeHtml(curTerm) + "」</div>";
    return;
  }
  for (const book of sortResults(curResults)) {
    const group = document.createElement("div");
    group.className = "book-group";

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
    // 点书名这一行 → 收起/展开本书的检索结果
    head.addEventListener("click", () => group.classList.toggle("collapsed"));
    group.appendChild(head);

    book.hits.forEach((h) => {
      const hit = document.createElement("div");
      hit.className = "hit";
      const scoreTag = typeof h.score === "number" ? '<span class="score">' + Math.round(h.score * 100) + "%</span>" : "";
      const body = mode === "sem" ? escapeHtml(h.snippet) : highlight(h.snippet, curTerm);
      hit.innerHTML = scoreTag + '<span class="ch">第' + (h.chapter + 1) + "章</span>" + body;
      hit.addEventListener("click", () => openHit(book.book_id, h.chapter)); // 点具体片段才跳转
      hitsWrap.appendChild(hit);
    });
    if (typeof book.count === "number" && book.count > book.hits.length) {
      const more = document.createElement("div");
      more.className = "more";
      more.textContent = "… 另有 " + (book.count - book.hits.length) + " 处未显示";
      hitsWrap.appendChild(more);
    }
    group.appendChild(hitsWrap);
    resultsEl.appendChild(group);
  }
}

function openHit(bookId, chapter) {
  invoke("open_book_at", { id: bookId, chapter, term: curTerm }).catch(() => {});
}

async function runSearch(term) {
  curTerm = (term || "").trim();
  qEl.value = curTerm;
  if (!curTerm) {
    curResults = [];
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
    } else {
      curResults = await invoke("shelf_search", { term: curTerm, ids: limit });
    }
  } catch (e) {
    curResults = [];
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
        semProgEl.textContent = "建立索引失败：" + p.error;
        buildBtn.disabled = false;
        if (semPoll) clearInterval(semPoll);
        semPoll = null;
        return;
      }
      if (p.building) {
        semProgEl.textContent = "建立语义索引中… " + p.done + "/" + p.total + "（" + (p.current || "") + "）";
      } else {
        semProgEl.textContent = p.total ? "语义索引已就绪（" + p.total + " 本）" : "";
        buildBtn.disabled = false;
        if (semPoll) clearInterval(semPoll);
        semPoll = null;
      }
    })
    .catch(() => {});
}
buildBtn.addEventListener("click", () => {
  const limit = curIds.length ? curIds : null;
  const scope = curIds.length ? "选定的 " + curIds.length + " 本" : "全部图书";
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
