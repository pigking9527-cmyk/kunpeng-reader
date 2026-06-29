// PDF.js 自渲染阅读器（连续滚动 + 文字层选择 + 目录 + 缩放 + 主题），通过 postMessage 与外壳工具栏联动
import * as pdfjsLib from "./pdfjs/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", location.href).href;

window.addEventListener("contextmenu", (e) => e.preventDefault());

const P = new URLSearchParams(location.search);
const pdfUrl = P.get("u");
let resumePage = parseInt(P.get("p") || "1", 10) || 1;
let settings = {};
try { settings = JSON.parse(decodeURIComponent(P.get("s") || "{}")); } catch (e) {}

const pagesEl = document.getElementById("pages");
let pdf = null, total = 0, scale = 1.3, divs = [], baseW = 600, baseH = 800, curPage = 1, io = null;
let nativeW = 600, nativeH = 800, dualMode = false; // 页面原生尺寸(scale=1) + 双页模式
let HLD = []; // 高亮列表（外壳传来）
let pageText = {}; // 每页文字缓存
let searchTerm = "", searchMatches = [], searchIdx = 0;
let overlayOpen = false; // 外壳里搜索框/设置面板是否打开
let hlMenu = null, activeHi = -1;

async function getPageText(i) {
  if (pageText[i] != null) return pageText[i];
  try {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    pageText[i] = tc.items.map((it) => it.str).join("");
  } catch (e) { pageText[i] = ""; }
  return pageText[i];
}

// ---- 高亮叠层 ----
function renderPageHighlights(i) {
  const d = divs[i];
  if (!d || !d.dataset.done) return;
  d.querySelectorAll(".hl-box").forEach((b) => b.remove());
  const pw = parseFloat(d.style.width), ph = parseFloat(d.style.height);
  HLD.forEach((h, idx) => {
    if ((h.chapter || 0) + 1 !== i) return;
    let rects = [];
    try { rects = JSON.parse(h.rects || "[]"); } catch (e) {}
    rects.forEach((r) => {
      const box = document.createElement("div");
      box.className = "hl-box" + (h.note ? " has-note" : "");
      box.dataset.hi = idx;
      box.style.left = r[0] * pw + "px";
      box.style.top = r[1] * ph + "px";
      box.style.width = r[2] * pw + "px";
      box.style.height = r[3] * ph + "px";
      if (h.note) box.title = h.note;
      box.addEventListener("click", (e) => { e.stopPropagation(); showHlMenu(idx, box); });
      d.appendChild(box);
    });
  });
}
function renderAllHighlights() { for (let i = 1; i <= total; i++) renderPageHighlights(i); }

// ---- 书内搜索 ----
function clearSearchMarks() {
  document.querySelectorAll(".textLayer span.search-hit").forEach((s) => s.classList.remove("search-hit", "cur"));
}
function markSearchOnPage(i) {
  if (!searchTerm) return;
  const d = divs[i];
  if (!d) return;
  const tl = d.querySelector(".textLayer");
  if (!tl) return;
  const low = searchTerm.toLowerCase();
  tl.querySelectorAll("span").forEach((s) => {
    if ((s.textContent || "").toLowerCase().includes(low)) s.classList.add("search-hit");
  });
}
async function searchPdf(term) {
  searchTerm = (term || "").trim();
  clearSearchMarks();
  if (!searchTerm) { parent.postMessage({ searchResults: [], searchCount: 0 }, "*"); return; }
  const low = searchTerm.toLowerCase();
  searchMatches = [];
  for (let i = 1; i <= total; i++) {
    const t = await getPageText(i);
    const lt = t.toLowerCase();
    let idx = lt.indexOf(low), n = 0;
    while (idx >= 0 && n < 80) {
      searchMatches.push({ page: i, snippet: t.slice(Math.max(0, idx - 24), idx + searchTerm.length + 24).trim() });
      idx = lt.indexOf(low, idx + searchTerm.length);
      n++;
    }
    if (searchMatches.length > 1500) break;
  }
  parent.postMessage(
    { searchResults: searchMatches.map((m) => ({ page: m.page, chapter: m.page - 1, snippet: m.snippet })), searchCount: searchMatches.length },
    "*"
  );
  for (let i = 1; i <= total; i++) markSearchOnPage(i);
  if (searchMatches.length) { searchIdx = 0; gotoMatch(0); }
}
function gotoMatch(k) {
  if (!searchMatches.length) return;
  searchIdx = ((k % searchMatches.length) + searchMatches.length) % searchMatches.length;
  const m = searchMatches[searchIdx];
  gotoPage(m.page, true);
  setTimeout(() => {
    document.querySelectorAll(".textLayer span.cur").forEach((s) => s.classList.remove("cur"));
    const d = divs[m.page];
    const s = d && d.querySelector(".textLayer span.search-hit");
    if (s) { s.classList.add("cur"); s.scrollIntoView({ block: "center" }); }
    parent.postMessage({ searchPos: searchIdx + 1, searchCount: searchMatches.length }, "*");
  }, 250);
}

// ---- 已高亮菜单（web搜索 / 取消高亮 / 批注）----
function hideHlMenu() { if (hlMenu) hlMenu.style.display = "none"; }
function setupHlMenu() {
  hlMenu = document.createElement("div");
  hlMenu.id = "hl-menu";
  const web = document.createElement("button"); web.type = "button"; web.textContent = "🔍 web搜索";
  const del = document.createElement("button"); del.type = "button"; del.textContent = "🗑 取消高亮";
  const note = document.createElement("button"); note.type = "button"; note.textContent = "📝 批注";
  hlMenu.append(web, del, note);
  document.body.appendChild(hlMenu);
  [web, del, note].forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }));
  web.addEventListener("click", (e) => { e.stopPropagation(); const h = HLD[activeHi]; if (h) parent.postMessage({ webSearch: h.text }, "*"); hideHlMenu(); });
  del.addEventListener("click", (e) => { e.stopPropagation(); if (activeHi >= 0) parent.postMessage({ removeHighlight: activeHi }, "*"); hideHlMenu(); });
  note.addEventListener("click", (e) => { e.stopPropagation(); if (activeHi >= 0) parent.postMessage({ openAnnotations: activeHi }, "*"); hideHlMenu(); });
  document.addEventListener("mousedown", (e) => { if (hlMenu && !hlMenu.contains(e.target) && !(e.target.classList && e.target.classList.contains("hl-box"))) hideHlMenu(); });
  document.addEventListener("wheel", hideHlMenu, { passive: true });
}
function showHlMenu(idx, box) {
  activeHi = idx;
  const rect = box.getBoundingClientRect();
  hlMenu.style.display = "block";
  const mw = hlMenu.offsetWidth || 200, mh = hlMenu.offsetHeight || 34;
  let left = rect.left + rect.width / 2 - mw / 2;
  left = Math.max(6, Math.min(window.innerWidth - mw - 6, left));
  let top = rect.top - mh - 8; if (top < 6) top = rect.bottom + 8;
  hlMenu.style.left = left + "px"; hlMenu.style.top = top + "px";
}

// 选区 → {chapter(页-1), rects(归一化), text, context}
function selRects() {
  const sel = getSelection();
  if (!sel || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  const text = (sel + "").trim();
  if (!text) return null;
  let node = r.startContainer;
  const el = node.nodeType === 1 ? node : node.parentNode;
  const pg = el && el.closest ? el.closest(".pg") : null;
  if (!pg) return null;
  const pageRect = pg.getBoundingClientRect();
  const pageNo = +pg.dataset.p;
  const rects = [];
  const list = r.getClientRects();
  for (const cr of list) {
    if (cr.width < 1 || cr.height < 1) continue;
    rects.push([
      (cr.left - pageRect.left) / pageRect.width,
      (cr.top - pageRect.top) / pageRect.height,
      cr.width / pageRect.width,
      cr.height / pageRect.height,
    ]);
  }
  if (!rects.length) return null;
  return { chapter: pageNo - 1, start: 0, end: 0, rects: JSON.stringify(rects), text: text, context: text };
}

function applyTheme(t) {
  document.body.classList.remove("theme-dark", "theme-sepia");
  if (t === "dark") document.body.classList.add("theme-dark");
  else if (t === "sepia") document.body.classList.add("theme-sepia");
}
function throttle(fn, ms) {
  let t = 0, pend = null;
  return function () {
    const now = Date.now();
    if (now - t >= ms) { t = now; fn(); }
    else { clearTimeout(pend); pend = setTimeout(() => { t = Date.now(); fn(); }, ms); }
  };
}

async function renderPage(i) {
  const d = divs[i];
  if (!d || d.dataset.done) return;
  d.dataset.done = "1";
  const page = await pdf.getPage(i);
  const vp = page.getViewport({ scale });
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(vp.width * ratio);
  canvas.height = Math.floor(vp.height * ratio);
  canvas.style.width = vp.width + "px";
  canvas.style.height = vp.height + "px";
  d.style.width = vp.width + "px";
  d.style.height = vp.height + "px";
  d.innerHTML = "";
  d.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport: vp, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null }).promise;
  // 文字层（选择/复制/划词）
  try {
    const tl = document.createElement("div");
    tl.className = "textLayer";
    tl.style.width = vp.width + "px";
    tl.style.height = vp.height + "px";
    d.appendChild(tl);
    const tc = await page.getTextContent();
    const layer = new pdfjsLib.TextLayer({ textContentSource: tc, container: tl, viewport: vp });
    await layer.render();
  } catch (err) {}
  renderPageHighlights(i);
  markSearchOnPage(i);
}
function renderAround(i) {
  for (let k = i - 1; k <= i + 2; k++) if (k >= 1 && k <= total) renderPage(k);
}
function pageAtTop() {
  const y = window.scrollY + 12;
  for (let i = 1; i <= total; i++) {
    const d = divs[i];
    if (d && d.offsetTop + d.offsetHeight > y) return i;
  }
  return total;
}
function report() {
  const prog = total > 1 ? ((curPage - 1) / (total - 1)) * 100 : 100;
  parent.postMessage(
    { progress: prog, chapter: curPage - 1, chFrac: 0, totalCh: total, page: curPage, total: total, gPage: curPage, gTotal: total, isPdf: 1 },
    "*"
  );
  reportPdfState(); // 持续同步缩放/双页，保证关闭前一定保存过（不只在手动缩放时）
}
// 翻页目标页：单页 = ±1；双页 = 整对(行)前后移 2，对齐到行首(奇数页)，
// 否则双页里两页同一行、滚到同一处，要按两下才过一对。
function turnTarget(dir) {
  if (dualMode) {
    const first = curPage % 2 === 1 ? curPage : curPage - 1;
    return first + dir * 2;
  }
  return curPage + dir;
}
let progScrollUntil = 0; // 程序化滚动期间，忽略滚动监听对 curPage 的改写（否则平滑滚动中途会把 curPage 改回原页）
function gotoPage(n, smooth) {
  n = Math.max(1, Math.min(total, n | 0));
  curPage = n;
  renderAround(n);
  progScrollUntil = Date.now() + (smooth ? 700 : 150);
  const d = divs[n];
  if (d) d.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  report();
}
// 适配窗口的缩放：单页铺满窗口宽，双页则每页占一半
function fitScale() {
  const avail = Math.max(200, window.innerWidth - 28);
  const per = dualMode ? (avail - 12) / 2 : avail;
  return Math.max(0.4, Math.min(4, per / nativeW));
}
function reportPdfState() { parent.postMessage({ pdfState: { scale: scale, dual: dualMode } }, "*"); }
function applyScale(s) {
  const keep = curPage;
  scale = Math.max(0.4, Math.min(4, s));
  baseW = nativeW * scale; baseH = nativeH * scale;
  // 只改占位尺寸+清"已渲染"标记（不清 innerHTML，省得大书每次缩放都狂清 DOM）；
  // 可见页立即重渲，离屏页滚到时再重渲（renderPage 会自己换掉旧画布）
  divs.forEach((d) => {
    if (!d) return;
    d.dataset.done = "";
    d.style.width = baseW + "px"; d.style.height = baseH + "px";
  });
  renderAround(keep);
  gotoPage(keep, false);
  reportPdfState(); // 记住缩放/双页
}
function setZoom(dir) {
  if (dir === "in") applyScale(scale * 1.1); // 细粒度：每次 10%
  else if (dir === "out") applyScale(scale / 1.1);
}
function setDual(on) {
  dualMode = !!on;
  document.body.classList.toggle("dual", dualMode);
  applyScale(fitScale()); // 切换后按新模式重新铺满
}

// ---- 目录（PDF 内置书签）----
async function destToPage(dest) {
  try {
    let d = dest;
    if (typeof d === "string") d = await pdf.getDestination(d);
    if (!d || !d[0]) return 1;
    const idx = await pdf.getPageIndex(d[0]);
    return idx + 1;
  } catch (e) { return 1; }
}
async function flatOutline(items, level, out) {
  out = out || [];
  if (!items) return out;
  for (const it of items) {
    const pg = await destToPage(it.dest);
    out.push({ label: it.title || "", chapter: pg - 1, frag: "", level: level || 0 });
    if (it.items && it.items.length) await flatOutline(it.items, (level || 0) + 1, out);
  }
  return out;
}

// ---- 选区菜单（web搜索 / 书签）----
let selMenu = null;
function hideSelMenu() { if (selMenu) selMenu.style.display = "none"; }
function setupSelMenu() {
  selMenu = document.createElement("div");
  selMenu.id = "sel-menu";
  const bWeb = document.createElement("button"); bWeb.type = "button"; bWeb.textContent = "🔍 web搜索";
  const bHL = document.createElement("button"); bHL.type = "button"; bHL.textContent = "🖍 高亮";
  const bNote = document.createElement("button"); bNote.type = "button"; bNote.textContent = "📝 批注";
  const bBm = document.createElement("button"); bBm.type = "button"; bBm.textContent = "🔖 书签";
  selMenu.append(bWeb, bHL, bNote, bBm);
  document.body.appendChild(selMenu);
  [bWeb, bHL, bNote, bBm].forEach((b) => b.addEventListener("mousedown", (e) => { e.preventDefault(); e.stopPropagation(); }));
  // 操作后清掉选区并收起菜单：否则 mouseup 监听会因"仍有选区"把菜单重新弹出来（叠菜单）；
  // 而且高亮重绘期间仍残留 PDF 文字层选区，正是触发 WebView 崩溃的元凶。
  const done = () => { const s = getSelection(); if (s) s.removeAllRanges(); hideSelMenu(); };
  bWeb.addEventListener("click", (e) => { e.stopPropagation(); const t = (getSelection() + "").trim(); if (t) parent.postMessage({ webSearch: t }, "*"); done(); });
  bHL.addEventListener("click", (e) => { e.stopPropagation(); const o = selRects(); if (o) parent.postMessage({ addHighlight: o }, "*"); done(); });
  bNote.addEventListener("click", (e) => { e.stopPropagation(); const o = selRects(); if (o) parent.postMessage({ addHighlightNote: o }, "*"); done(); });
  bBm.addEventListener("click", (e) => { e.stopPropagation(); const t = (getSelection() + "").trim(); parent.postMessage({ addBookmark: { chapter: curPage - 1, frac: 0, text: t.slice(0, 24) } }, "*"); done(); });
  document.addEventListener("mouseup", () => {
    setTimeout(() => {
      const sel = getSelection();
      const t = sel ? (sel + "").trim() : "";
      if (!t) { hideSelMenu(); return; }
      let rect; try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch (_) { hideSelMenu(); return; }
      if (!rect || (!rect.width && !rect.height)) { hideSelMenu(); return; }
      selMenu.style.display = "block";
      const mw = selMenu.offsetWidth || 140, mh = selMenu.offsetHeight || 34;
      let left = rect.left + rect.width / 2 - mw / 2;
      left = Math.max(6, Math.min(window.innerWidth - mw - 6, left));
      let top = rect.top - mh - 8; if (top < 6) top = rect.bottom + 8;
      selMenu.style.left = left + "px"; selMenu.style.top = top + "px";
    }, 0);
  });
  document.addEventListener("mousedown", (e) => { if (selMenu && !selMenu.contains(e.target)) hideSelMenu(); });
  document.addEventListener("wheel", hideSelMenu, { passive: true });
}

// 点屏幕中间 → 通知外壳（沉浸模式唤出工具栏）
function setupCenterTap() {
  document.addEventListener("click", (e) => {
    parent.postMessage({ uiClick: 1 }, "*"); // 任何点击都通知外壳关闭搜索/设置浮层
    if (overlayOpen) return; // 浮层打开时，点击只用于关闭它，不唤出/切换工具栏
    const sel = getSelection();
    if (sel && (sel + "").trim()) return; // 在选字，不算点击
    const x = e.clientX, w = window.innerWidth;
    if (x > w * 0.33 && x < w * 0.67) parent.postMessage({ centerTap: 1 }, "*");
  });
  const nav = () => parent.postMessage({ userNav: 1 }, "*"); // 滚动/翻页 → 收起浮层
  const navThrottled = throttle(nav, 200);
  let zT = 0;
  window.addEventListener("wheel", (e) => {
    if (e.altKey) { // Alt + 滚轮 = 细粒度缩放，不滚动页面
      e.preventDefault();
      const now = Date.now();
      if (now - zT < 45) return;
      zT = now;
      applyScale(scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05));
      return;
    }
    navThrottled();
  }, { passive: false });
  window.addEventListener("keydown", (e) => {
    let dir = 0;
    if (e.key === "PageDown" || e.key === "ArrowRight" || (e.key === " " && !e.shiftKey)) dir = 1;
    else if (e.key === "PageUp" || e.key === "ArrowLeft" || (e.key === " " && e.shiftKey)) dir = -1;
    if (dir !== 0) { e.preventDefault(); gotoPage(turnTarget(dir), false); nav(); return; } // 翻页键：单页翻1页/双页翻一对（瞬移）
    if (["ArrowDown", "ArrowUp", "Home", "End"].indexOf(e.key) >= 0) nav(); // 这些保留原生滚动
  });
}

window.addEventListener("message", (e) => {
  if (!e.data) return;
  if (e.data.gotoChapter !== undefined) gotoPage((e.data.gotoChapter | 0) + 1, true);
  if (e.data.gotoFrac !== undefined) gotoPage(Math.round(e.data.gotoFrac * total) || 1, false);
  if (e.data.zoom) setZoom(e.data.zoom);
  if (e.data.pageTurn) gotoPage(turnTarget(e.data.pageTurn > 0 ? 1 : -1), false); // 外壳转发的翻页键：单页1页/双页一对
  if (e.data.dual !== undefined) setDual(e.data.dual);
  if (e.data.settings && e.data.settings.theme !== undefined) applyTheme(e.data.settings.theme);
  if (e.data.overlayOpen !== undefined) overlayOpen = !!e.data.overlayOpen;
  if (e.data.search !== undefined) searchPdf(e.data.search);
  if (e.data.searchNav) gotoMatch(searchIdx + e.data.searchNav);
  if (e.data.clearMarks) { searchTerm = ""; clearSearchMarks(); }
  if (e.data.highlights) { HLD = e.data.highlights; renderAllHighlights(); }
  if (e.data.showHlMenuFor !== undefined) {
    const idx = e.data.showHlMenuFor, h = HLD[idx];
    if (h) { gotoPage((h.chapter || 0) + 1, false); setTimeout(() => { const b = divs[(h.chapter || 0) + 1] && divs[(h.chapter || 0) + 1].querySelector('.hl-box[data-hi="' + idx + '"]'); if (b) showHlMenu(idx, b); }, 200); }
  }
  if (e.data.gotoHighlight !== undefined) {
    const h = HLD[e.data.gotoHighlight];
    if (h) gotoPage((h.chapter || 0) + 1, true);
  }
});

async function init() {
  applyTheme(settings.theme);
  try {
    pdf = await pdfjsLib.getDocument({ url: pdfUrl, disableRange: true, disableStream: true }).promise;
  } catch (e) {
    pagesEl.innerHTML = '<div class="loading">PDF 打开失败：' + e + "</div>";
    parent.postMessage({ ready: 1 }, "*");
    return;
  }
  total = pdf.numPages;
  const p1 = await pdf.getPage(1);
  const v1 = p1.getViewport({ scale: 1 });
  nativeW = v1.width; nativeH = v1.height;
  // 恢复上次的双页/缩放；没有则按窗口宽度铺满（开箱即舒适尺寸）
  const savedScale = parseFloat(P.get("scale") || "0") || 0;
  if (P.get("dual") === "1") { dualMode = true; document.body.classList.add("dual"); }
  scale = savedScale > 0 ? Math.max(0.4, Math.min(4, savedScale)) : fitScale();
  baseW = nativeW * scale; baseH = nativeH * scale;
  pagesEl.innerHTML = "";
  for (let i = 1; i <= total; i++) {
    const d = document.createElement("div");
    d.className = "pg"; d.dataset.p = i;
    d.style.width = baseW + "px"; d.style.height = baseH + "px";
    pagesEl.appendChild(d); divs[i] = d;
  }
  io = new IntersectionObserver(
    (ents) => ents.forEach((en) => { if (en.isIntersecting) { const i = +en.target.dataset.p; renderPage(i); } }),
    { root: null, rootMargin: "500px 0px" }
  );
  divs.forEach((d) => { if (d) io.observe(d); });
  window.addEventListener("scroll", throttle(() => {
    if (Date.now() < progScrollUntil) return; // 翻页/跳转的平滑滚动中：别用半路的 pageAtTop 覆盖 curPage
    curPage = pageAtTop();
    report();
  }, 200), { passive: true });
  setupSelMenu();
  setupHlMenu();
  setupCenterTap();
  pdf.getOutline().then((o) => flatOutline(o)).then((flat) => parent.postMessage({ outline: flat }, "*")).catch(() => {});
  gotoPage(resumePage, false);
  parent.postMessage({ ready: 1 }, "*");
  report();
}
init();
