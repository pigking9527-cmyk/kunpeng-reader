// 阅读页跨书搜索：从选区/高亮文字直接检索其它书中的同词或同句。
const crossModal = document.getElementById("cross-modal");
const crossInput = document.getElementById("cross-input");
const crossStatus = document.getElementById("cross-status");
const crossResults = document.getElementById("cross-results");
const crossClose = document.getElementById("cross-close");
const crossRun = document.getElementById("cross-run");
const crossReturn = document.getElementById("cross-return");
let crossSeq = 0;
let crossTerm = "";
let crossLastResults = [];
let crossExpanded = new Map();
let crossCollapsed = new Set();
let crossReturnPoll = 0;

function crossEscapeHtml(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function crossHighlight(snippet, term) {
  snippet = String(snippet || "");
  term = String(term || "").trim();
  if (!term) return crossEscapeHtml(snippet);
  const low = snippet.toLowerCase();
  const t = term.toLowerCase();
  let html = "";
  let last = 0;
  let idx = low.indexOf(t);
  while (idx >= 0) {
    html += crossEscapeHtml(snippet.slice(last, idx)) + "<mark>" + crossEscapeHtml(snippet.slice(idx, idx + term.length)) + "</mark>";
    last = idx + term.length;
    idx = low.indexOf(t, last);
  }
  html += crossEscapeHtml(snippet.slice(last));
  return html;
}
function closeCrossSearch() {
  crossModal.classList.remove("show");
}
function crossCurrentBookId() {
  return String(window.currentBookId || (typeof currentBookId !== "undefined" ? currentBookId : "") || "");
}
function crossResultLimit(book) {
  const bookId = String(book.book_id || "");
  return Math.max(8, crossExpanded.get(bookId) || 8);
}
function crossStoreReturnTarget(bookId, chapter) {
  const currentBookId = crossCurrentBookId();
  if (!currentBookId || !bookId || String(bookId) === currentBookId) return;
  const existing = readCrossReturnState();
  const keepFirstOrigin = existing && String(existing.originBookId || "") && String(existing.originBookId) !== currentBookId;
  const originBookId = keepFirstOrigin ? String(existing.originBookId) : currentBookId;
  const state = {
    originBookId,
    originChapter: keepFirstOrigin ? Number(existing.originChapter || 0) : (typeof curChapter === "number" ? curChapter : 0),
    targetBookId: String(bookId),
    targetChapter: chapter || 0,
    term: keepFirstOrigin ? String(existing.term || crossTerm) : crossTerm,
    lastTerm: crossTerm,
    chain: keepFirstOrigin ? String(existing.chain || "") : String(Date.now()),
    ts: Date.now(),
  };
  localStorage.setItem("crossReturnState", JSON.stringify(state));
  updateCrossReturnButton();
}
function readCrossReturnState() {
  try {
    const state = JSON.parse(localStorage.getItem("crossReturnState") || "null");
    if (!state || !state.originBookId || Date.now() - (state.ts || 0) > 24 * 60 * 60 * 1000) return null;
    return state;
  } catch (_) {
    return null;
  }
}
function updateCrossReturnButton() {
  if (!crossReturn) return;
  const state = readCrossReturnState();
  const current = crossCurrentBookId();
  const show = !!(state && current && String(state.originBookId) !== current);
  crossReturn.classList.toggle("show", show);
}
function scheduleCrossReturnRefresh() {
  if (!crossReturn || crossReturnPoll) return;
  let ticks = 0;
  crossReturnPoll = window.setInterval(() => {
    ticks += 1;
    updateCrossReturnButton();
    if (crossCurrentBookId() || ticks >= 12) {
      window.clearInterval(crossReturnPoll);
      crossReturnPoll = 0;
    }
  }, 250);
}
function consumePendingCrossSearch() {
  let pending = null;
  try {
    pending = JSON.parse(localStorage.getItem("pendingCrossSearch") || "null");
  } catch (_) {
    pending = null;
  }
  if (!pending || !pending.term) return;
  const current = crossCurrentBookId();
  if (pending.originBookId && (!current || String(pending.originBookId) !== current)) {
    setTimeout(consumePendingCrossSearch, 250);
    return;
  }
  localStorage.removeItem("pendingCrossSearch");
  openCrossSearch(pending.term);
}
window.updateCrossReturnButton = updateCrossReturnButton;
window.consumePendingCrossSearch = consumePendingCrossSearch;

function renderCrossSearch(results) {
  crossLastResults = results || [];
  crossResults.innerHTML = "";
  const currentId = crossCurrentBookId();
  const list = crossLastResults.filter((book) => String(book.book_id || "") !== String(currentId));
  if (!list.length) {
    crossResults.innerHTML = '<div class="cross-empty">其它书里没有找到「' + crossEscapeHtml(crossTerm) + '」</div>';
    crossStatus.textContent = "未找到";
    return;
  }
  const total = list.reduce((sum, book) => sum + (book.count || 0), 0);
  crossStatus.textContent = list.length + " 本 · " + total + " 处";
  const frag = document.createDocumentFragment();
  list.slice(0, 30).forEach((book) => {
    const bookId = String(book.book_id || "");
    const hits = book.hits || [];
    const limit = Math.min(crossResultLimit(book), hits.length);
    const collapsed = crossCollapsed.has(bookId);
    const group = document.createElement("div");
    group.className = "cross-book" + (collapsed ? " collapsed" : "");
    const head = document.createElement("div");
    head.className = "cross-head";
    head.innerHTML =
      '<span class="cross-toggle">' + (collapsed ? "▸" : "▾") + "</span>" +
      '<span class="cross-title">' + crossEscapeHtml(book.title || "未命名") + "</span>" +
      (book.author ? '<span class="cross-author">' + crossEscapeHtml(book.author) + "</span>" : "") +
      '<span class="cross-count">' + (book.count || 0) + " 处</span>";
    head.addEventListener("click", () => {
      if (crossCollapsed.has(bookId)) crossCollapsed.delete(bookId);
      else crossCollapsed.add(bookId);
      renderCrossSearch(crossLastResults);
    });
    group.appendChild(head);
    hits.slice(0, limit).forEach((hit) => {
      const item = document.createElement("div");
      item.className = "cross-hit";
      item.innerHTML = '<div class="cross-hit-line"><span class="cross-ch">第' + ((hit.chapter || 0) + 1) + "章</span>" + crossHighlight(hit.snippet || "", crossTerm) + "</div>";
      item.addEventListener("click", () => {
        crossStoreReturnTarget(bookId, hit.chapter || 0);
        invoke("open_book_at", { id: String(book.book_id || ""), chapter: hit.chapter || 0, term: crossTerm }).catch(() => {});
      });
      group.appendChild(item);
    });
    if ((book.count || 0) > limit) {
      const more = document.createElement("button");
      more.className = "cross-more";
      const rest = (book.count || 0) - limit;
      const canExpand = limit < hits.length;
      more.innerHTML =
        '<span class="cross-more-ico">' + (canExpand ? "+25" : "…") + "</span>" +
        "另有 " + rest + (canExpand ? " 处未显示" : " 处未载入");
      more.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!canExpand) return;
        crossExpanded.set(bookId, Math.min(limit + 25, hits.length));
        renderCrossSearch(crossLastResults);
      });
      group.appendChild(more);
    }
    frag.appendChild(group);
  });
  crossResults.appendChild(frag);
}
async function runCrossSearch(term) {
  const seq = ++crossSeq;
  crossTerm = String(term || "").replace(/\s+/g, " ").trim();
  crossInput.value = crossTerm;
  if (!crossTerm) {
    crossStatus.textContent = "";
    crossResults.innerHTML = '<div class="cross-empty">输入文字后搜索</div>';
    return;
  }
  crossStatus.textContent = "检索中…";
  crossResults.innerHTML = '<div class="cross-empty">检索中…</div>';
  try {
    const results = await invoke("shelf_search", { term: crossTerm, ids: null });
    if (seq === crossSeq) renderCrossSearch(results);
  } catch (e) {
    if (seq !== crossSeq) return;
    crossStatus.textContent = "检索失败";
    crossResults.innerHTML = '<div class="cross-empty">检索失败：' + crossEscapeHtml(String(e || "")) + "</div>";
  }
}
function openCrossSearch(term) {
  term = String(term || "").trim();
  if (!term) return;
  if (typeof readerDebugSettingOn === "function" && !readerDebugSettingOn("reader_cross_search")) return;
  crossExpanded = new Map();
  crossCollapsed = new Set();
  window.pauseReadTracking?.("cross-search");
  closeSettings();
  if (rsearch.classList.contains("show")) toggleSearch(false);
  if (typeof setToc === "function") setToc(false);
  if (typeof setVocab === "function") setVocab(false);
  crossModal.classList.add("show");
  crossInput.focus();
  crossInput.select();
  runCrossSearch(term);
}

crossClose.addEventListener("click", closeCrossSearch);
crossModal.addEventListener("click", (e) => {
  if (e.target === crossModal) closeCrossSearch();
});
crossRun.addEventListener("click", () => runCrossSearch(crossInput.value));
crossInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeCrossSearch();
  else if (e.key === "Enter") runCrossSearch(crossInput.value);
});
if (crossReturn) {
  crossReturn.addEventListener("click", () => {
    const state = readCrossReturnState();
    if (!state) return;
    localStorage.setItem("pendingCrossSearch", JSON.stringify({
      term: state.term || state.lastTerm || "",
      originBookId: state.originBookId,
      ts: Date.now(),
    }));
    closeCrossSearch();
    invoke("open_book_at", {
      id: String(state.originBookId),
      chapter: Number(state.originChapter || 0),
      term: "",
    }).catch(() => {});
  });
  setTimeout(updateCrossReturnButton, 400);
  setTimeout(consumePendingCrossSearch, 900);
  scheduleCrossReturnRefresh();
}
