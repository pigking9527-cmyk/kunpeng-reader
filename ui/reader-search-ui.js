// 阅读页全书搜索 UI 与正文消息桥
// 先于 reader.js 加载：提供 sendToPage/rsearch/toggleSearch 给阅读页主逻辑复用。

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
document.querySelector(".toolbar").addEventListener("click", (e) => {
  if (!rsearch.classList.contains("show")) return;
  if (e.target.closest(".search-wrap")) return;
  toggleSearch(false);
});
window.addEventListener("mouseout", (e) => {
  if (!rsearch.classList.contains("show")) return;
  if (e.relatedTarget) return;
  if (e.clientY <= 0) toggleSearch(false);
});
window.addEventListener("blur", () => {
  if (rsearch.classList.contains("show")) toggleSearch(false);
});
rsearchInput.addEventListener("input", () => {
  if (searchTimer) clearTimeout(searchTimer);
  const q = rsearchInput.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 350);
});
rsearchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") toggleSearch(false);
  else if (e.key === "Enter") addRHistory(rsearchInput.value);
});
