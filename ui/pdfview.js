import * as pdfjsLib from "./pdfjs/pdf.min.mjs";
import { createPdfLegacyAdapter } from "./bridge/pdf-engine-legacy-adapter.js";
function countReadablePdfChars(text) {
  return text.replace(/\s+/g, "").length;
}
function boundedPdfSearchResults(matches, maximumBytes, serializedBytes) {
  const searchResults = [];
  for (const match of matches) {
    const next = { page: match.page, chapter: match.page - 1, snippet: match.snippet };
    if (serializedBytes({ searchResults: [...searchResults, next], searchCount: matches.length }) > maximumBytes) break;
    searchResults.push(next);
  }
  return Object.freeze({ searchResults: Object.freeze(searchResults), searchCount: matches.length });
}
function pdfTurnTarget(currentPage, direction, dualMode2) {
  return dualMode2 ? (currentPage % 2 === 1 ? currentPage : currentPage - 1) + direction * 2 : currentPage + direction;
}
function clampPdfScale(value) {
  return Math.max(0.4, Math.min(4, value));
}
function fitPdfScale(windowWidth, nativeWidth, dualMode2) {
  const available = Math.max(200, windowWidth - 28);
  return clampPdfScale((dualMode2 ? (available - 12) / 2 : available) / nativeWidth);
}
function normalisePdfPage(total2, requested) {
  return Math.max(1, Math.min(total2, requested | 0));
}
function isLegacyCommand(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isLegacySettings(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numberAt(value) {
  return Number(value ?? "");
}
function elementTarget(target) {
  return target instanceof Element ? target : null;
}
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("./pdfjs/pdf.worker.min.mjs", location.href).href;
window.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && (event.key === "f" || event.key === "F") || event.key === "F3") event.preventDefault();
}, true);
const parameters = new URLSearchParams(location.search);
const pdfEngineAdapter = createPdfLegacyAdapter();
const pdfBootstrap = pdfEngineAdapter.bootstrap({ href: location.href, search: location.search });
const actualParent = window.parent;
const parent = Object.freeze({ postMessage(payload) {
  if (pdfBootstrap) pdfEngineAdapter.postLegacyEvent(actualParent, pdfBootstrap, payload);
} });
const pdfUrl = pdfBootstrap?.sourceUrl ?? "";
const resumePage = pdfBootstrap?.initialPage ?? 1;
let settings = {};
try {
  const parsed = JSON.parse(decodeURIComponent(parameters.get("s") ?? "{}"));
  if (isLegacySettings(parsed)) settings = parsed;
} catch {
}
const pagesEl = document.getElementById("pages") ?? (() => {
  throw new Error("PDF page container is missing.");
})();
let pdf = null;
let total = 0;
let scale = 1.3;
const divs = [];
let baseW = 600;
let baseH = 800;
let curPage = 1;
let io = null;
let nativeW = 600;
let nativeH = 800;
let dualMode = false;
let highlights = [];
const pageText = {};
const pageTextChars = {};
let searchTerm = "";
let searchMatches = [];
let searchIdx = 0;
let overlayOpen = false;
let hlMenu = null;
let activeHi = -1;
let selMenu = null;
let pdfSession = null;
let pdfDisposed = false;
const renderOperations = /* @__PURE__ */ new Map();
function postToShell(payload) {
  parent.postMessage(payload);
}
function setupReaderGestureForwarding() {
  let drawing = false;
  let source = null;
  let pointerId = null;
  const report2 = (phase, clientX, clientY) => {
    postToShell({ readerGesture: { phase, x: clientX, y: clientY } });
  };
  const start = (event, nextSource) => {
    if (drawing || event.button !== 2) return;
    drawing = true;
    source = nextSource;
    if (nextSource === "pointer" && "pointerId" in event) {
      pointerId = event.pointerId;
      try {
        document.documentElement.setPointerCapture(pointerId);
      } catch {
      }
    }
    report2("start", event.clientX, event.clientY);
    event.preventDefault();
  };
  const finish = (phase, event) => {
    if (!drawing) return;
    const capturedPointerId = pointerId;
    drawing = false;
    source = null;
    pointerId = null;
    if (capturedPointerId !== null) {
      try {
        document.documentElement.releasePointerCapture(capturedPointerId);
      } catch {
      }
    }
    report2(phase, event?.clientX ?? 0, event?.clientY ?? 0);
    event?.preventDefault();
  };
  document.addEventListener("pointerdown", (event) => start(event, "pointer"), true);
  document.addEventListener("pointermove", (event) => {
    if (!drawing || source !== "pointer" || event.pointerId !== pointerId) return;
    report2("move", event.clientX, event.clientY);
    event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener("pointerup", (event) => {
    if (source === "pointer" && event.pointerId === pointerId) finish("end", event);
  }, true);
  document.addEventListener("pointercancel", (event) => {
    if (source === "pointer" && event.pointerId === pointerId) finish("cancel", event);
  }, true);
  document.addEventListener("mousedown", (event) => start(event, "mouse"), true);
  document.addEventListener("mousemove", (event) => {
    if (!drawing || source !== "mouse") return;
    report2("move", event.clientX, event.clientY);
    event.preventDefault();
  }, { capture: true, passive: false });
  document.addEventListener("mouseup", (event) => {
    if (source === "mouse" && event.button === 2) finish("end", event);
  }, true);
  window.addEventListener("blur", () => finish("cancel"));
}
function boundedSearchResultsPayload() {
  return boundedPdfSearchResults(searchMatches, 16 * 1024, (value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  });
}
function cancelRenderOperation(operationId) {
  const entry = renderOperations.get(operationId);
  if (!entry) return;
  renderOperations.delete(operationId);
  entry.untrack();
  try {
    entry.task.cancel();
  } catch {
  }
}
function disposePdfView() {
  if (pdfDisposed) return;
  pdfDisposed = true;
  io?.disconnect();
  io = null;
  for (const operationId of [...renderOperations.keys()]) cancelRenderOperation(operationId);
  void pdfSession?.dispose();
  if (pdf?.destroy) void Promise.resolve(pdf.destroy()).catch(() => void 0);
  pdf = null;
}
window.addEventListener("pagehide", disposePdfView, { once: true });
window.addEventListener("beforeunload", disposePdfView, { once: true });
function requirePdf() {
  if (!pdf) throw new Error("PDF is not loaded.");
  return pdf;
}
async function getPageText(pageNumber) {
  const cached = pageText[pageNumber];
  if (cached !== void 0) return cached;
  try {
    const content = await (await requirePdf().getPage(pageNumber)).getTextContent();
    pageText[pageNumber] = content.items.map((item) => item.str).join("");
  } catch {
    pageText[pageNumber] = "";
  }
  const text = pageText[pageNumber] ?? "";
  pageTextChars[pageNumber] = countReadablePdfChars(text);
  return text;
}
function renderPageHighlights(pageNumber) {
  const page = divs[pageNumber];
  if (!page?.dataset.done) return;
  page.querySelectorAll(".hl-box").forEach((box) => box.remove());
  const pageWidth = Number.parseFloat(page.style.width);
  const pageHeight = Number.parseFloat(page.style.height);
  highlights.forEach((highlight, index) => {
    if ((highlight.chapter ?? 0) + 1 !== pageNumber) return;
    let rects = [];
    try {
      rects = JSON.parse(highlight.rects ?? "[]");
    } catch {
      rects = [];
    }
    if (!Array.isArray(rects)) return;
    for (const rect of rects) {
      if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every((value) => typeof value === "number")) continue;
      const [left, top, width, height] = rect;
      const box = document.createElement("div");
      box.className = `hl-box${highlight.note ? " has-note" : ""}`;
      box.dataset.hi = String(index);
      box.style.left = `${left * pageWidth}px`;
      box.style.top = `${top * pageHeight}px`;
      box.style.width = `${width * pageWidth}px`;
      box.style.height = `${height * pageHeight}px`;
      if (highlight.note) box.title = highlight.note;
      box.addEventListener("click", (event) => {
        event.stopPropagation();
        showHlMenu(index, box);
      });
      page.appendChild(box);
    }
  });
}
function renderAllHighlights() {
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) renderPageHighlights(pageNumber);
}
function clearSearchMarks() {
  document.querySelectorAll(".textLayer span.search-hit").forEach((span) => span.classList.remove("search-hit", "cur"));
}
function markSearchOnPage(pageNumber) {
  const layer = divs[pageNumber]?.querySelector(".textLayer");
  if (!searchTerm || !layer) return;
  const lower = searchTerm.toLowerCase();
  layer.querySelectorAll("span").forEach((span) => {
    if ((span.textContent ?? "").toLowerCase().includes(lower)) span.classList.add("search-hit");
  });
}
async function searchPdf(term) {
  searchTerm = term.trim();
  clearSearchMarks();
  if (!searchTerm) {
    postToShell({ searchResults: [], searchCount: 0 });
    return;
  }
  const lower = searchTerm.toLowerCase();
  searchMatches = [];
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const text = await getPageText(pageNumber);
    const normalized = text.toLowerCase();
    let index = normalized.indexOf(lower);
    let count = 0;
    while (index >= 0 && count < 80) {
      searchMatches.push({ page: pageNumber, snippet: text.slice(Math.max(0, index - 24), index + searchTerm.length + 24).trim() });
      index = normalized.indexOf(lower, index + searchTerm.length);
      count += 1;
    }
    if (searchMatches.length > 1500) break;
  }
  postToShell(boundedSearchResultsPayload());
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) markSearchOnPage(pageNumber);
  if (searchMatches.length) {
    searchIdx = 0;
    gotoMatch(0);
  }
}
function gotoMatch(index) {
  if (!searchMatches.length) return;
  searchIdx = (index % searchMatches.length + searchMatches.length) % searchMatches.length;
  const match = searchMatches[searchIdx];
  if (!match) return;
  gotoPage(match.page, true);
  window.setTimeout(() => {
    document.querySelectorAll(".textLayer span.cur").forEach((span2) => span2.classList.remove("cur"));
    const span = divs[match.page]?.querySelector(".textLayer span.search-hit");
    if (span) {
      span.classList.add("cur");
      span.scrollIntoView({ block: "center" });
    }
    postToShell({ searchPos: searchIdx + 1, searchCount: searchMatches.length });
  }, 250);
}
function hideHlMenu() {
  if (hlMenu) hlMenu.style.display = "none";
}
function showHlMenu(index, box) {
  if (!hlMenu) return;
  activeHi = index;
  const rect = box.getBoundingClientRect();
  hlMenu.style.display = "block";
  const width = hlMenu.offsetWidth || 200;
  const height = hlMenu.offsetHeight || 34;
  const left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.left + rect.width / 2 - width / 2));
  let top = rect.top - height - 8;
  if (top < 6) top = rect.bottom + 8;
  hlMenu.style.left = `${left}px`;
  hlMenu.style.top = `${top}px`;
}
function setupHlMenu() {
  hlMenu = document.createElement("div");
  hlMenu.id = "hl-menu";
  const web = document.createElement("button");
  const remove = document.createElement("button");
  const note = document.createElement("button");
  web.type = "button";
  web.textContent = "🔍 web搜索";
  remove.type = "button";
  remove.textContent = "🗑 取消高亮";
  note.type = "button";
  note.textContent = "📝 批注";
  hlMenu.append(web, remove, note);
  document.body.appendChild(hlMenu);
  [web, remove, note].forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }));
  web.addEventListener("click", (event) => {
    event.stopPropagation();
    const highlight = highlights[activeHi];
    if (highlight) postToShell({ webSearch: highlight.text });
    hideHlMenu();
  });
  remove.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeHi >= 0) postToShell({ removeHighlight: activeHi });
    hideHlMenu();
  });
  note.addEventListener("click", (event) => {
    event.stopPropagation();
    if (activeHi >= 0) postToShell({ openAnnotations: activeHi });
    hideHlMenu();
  });
  document.addEventListener("mousedown", (event) => {
    const target = elementTarget(event.target);
    if (hlMenu && !hlMenu.contains(target) && !target?.classList.contains("hl-box")) hideHlMenu();
  });
  document.addEventListener("wheel", hideHlMenu, { passive: true });
}
function selectionPayload() {
  const selection = getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  const text = selection.toString().trim();
  if (!text) return null;
  const ancestor = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const page = ancestor?.closest(".pg");
  if (!page) return null;
  const pageRect = page.getBoundingClientRect();
  const pageNumber = numberAt(page.dataset.p);
  const rects = [];
  for (const rect of range.getClientRects()) if (rect.width >= 1 && rect.height >= 1) rects.push([(rect.left - pageRect.left) / pageRect.width, (rect.top - pageRect.top) / pageRect.height, rect.width / pageRect.width, rect.height / pageRect.height]);
  return rects.length ? { chapter: pageNumber - 1, start: 0, end: 0, rects: JSON.stringify(rects), text, context: text } : null;
}
function applyTheme(theme) {
  document.body.classList.remove("theme-dark", "theme-sepia");
  if (theme === "dark") document.body.classList.add("theme-dark");
  else if (theme === "sepia") document.body.classList.add("theme-sepia");
}
function throttle(callback, milliseconds) {
  let last = 0;
  let pending;
  return () => {
    const now = Date.now();
    if (now - last >= milliseconds) {
      last = now;
      callback();
    } else {
      if (pending !== void 0) window.clearTimeout(pending);
      pending = window.setTimeout(() => {
        last = Date.now();
        callback();
      }, milliseconds);
    }
  };
}
async function renderPage(pageNumber) {
  if (pdfDisposed || pdfSession?.signal.aborted) return;
  const pageElement = divs[pageNumber];
  if (!pageElement || pageElement.dataset.done) return;
  pageElement.dataset.done = "1";
  const page = await requirePdf().getPage(pageNumber);
  if (pdfDisposed || pdfSession?.signal.aborted) return;
  const viewport = page.getViewport({ scale });
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * ratio);
  canvas.height = Math.floor(viewport.height * ratio);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  pageElement.style.width = `${viewport.width}px`;
  pageElement.style.height = `${viewport.height}px`;
  pageElement.innerHTML = "";
  pageElement.appendChild(canvas);
  const context = canvas.getContext("2d");
  if (!context) return;
  const operationId = pdfSession?.nextOperationId("render");
  const task = page.render({ canvasContext: context, viewport, transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null });
  const untrack = pdfSession?.trackRenderTask(task) ?? (() => void 0);
  if (operationId) renderOperations.set(operationId, { task, untrack });
  try {
    await task.promise;
  } catch (error) {
    if (!pdfDisposed && !pdfSession?.signal.aborted) throw error;
    return;
  } finally {
    if (operationId) renderOperations.delete(operationId);
    untrack();
  }
  if (pdfDisposed || pdfSession?.signal.aborted) return;
  try {
    const layerElement = document.createElement("div");
    layerElement.className = "textLayer";
    layerElement.style.width = `${viewport.width}px`;
    layerElement.style.height = `${viewport.height}px`;
    pageElement.appendChild(layerElement);
    const textContent = await page.getTextContent();
    const text = textContent.items.map((item) => item.str).join("");
    pageText[pageNumber] = text;
    pageTextChars[pageNumber] = countReadablePdfChars(text);
    await new pdfjsLib.TextLayer({ textContentSource: textContent, container: layerElement, viewport }).render();
  } catch {
  }
  renderPageHighlights(pageNumber);
  markSearchOnPage(pageNumber);
}
function renderAround(pageNumber) {
  for (let next = pageNumber - 1; next <= pageNumber + 2; next += 1) if (next >= 1 && next <= total) void renderPage(next);
}
function pageAtTop() {
  const y = window.scrollY + 12;
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const page = divs[pageNumber];
    if (page && page.offsetTop + page.offsetHeight > y) return pageNumber;
  }
  return total;
}
function reportPdfState() {
  postToShell({ pdfState: { scale, dual: dualMode } });
}
function report() {
  const pageNumber = curPage;
  const progress = total > 1 ? (pageNumber - 1) / (total - 1) * 100 : 100;
  const pageChars = pageTextChars[pageNumber] ?? 0;
  postToShell({ progress, chapter: pageNumber - 1, chFrac: 0, totalCh: total, page: pageNumber, total, gPage: pageNumber, gTotal: total, isPdf: 1, pageChars });
  if (pageTextChars[pageNumber] === void 0) void getPageText(pageNumber).then(() => {
    if (curPage === pageNumber) report();
  });
  reportPdfState();
}
function turnTarget(direction) {
  return pdfTurnTarget(curPage, direction, dualMode);
}
let progScrollUntil = 0;
function gotoPage(pageNumber, smooth) {
  const next = normalisePdfPage(total, pageNumber);
  curPage = next;
  renderAround(next);
  progScrollUntil = Date.now() + (smooth ? 700 : 150);
  divs[next]?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
  report();
}
function fitScale() {
  return fitPdfScale(window.innerWidth, nativeW, dualMode);
}
function applyScale(nextScale) {
  const keep = curPage;
  scale = clampPdfScale(nextScale);
  baseW = nativeW * scale;
  baseH = nativeH * scale;
  for (const page of divs) if (page) {
    page.dataset.done = "";
    page.style.width = `${baseW}px`;
    page.style.height = `${baseH}px`;
  }
  renderAround(keep);
  gotoPage(keep, false);
  reportPdfState();
}
function setZoom(direction) {
  applyScale(direction === "in" ? scale * 1.1 : scale / 1.1);
}
function setDual(value) {
  dualMode = value;
  document.body.classList.toggle("dual", dualMode);
  applyScale(fitScale());
}
async function destToPage(destination) {
  try {
    let resolved = destination;
    if (typeof resolved === "string") resolved = await requirePdf().getDestination(resolved);
    if (!Array.isArray(resolved) || !resolved[0]) return 1;
    return await requirePdf().getPageIndex(resolved[0]) + 1;
  } catch {
    return 1;
  }
}
async function flatOutline(items, level = 0, output = []) {
  if (!items) return output;
  for (const item of items) {
    const page = await destToPage(item.dest);
    output.push({ label: item.title || "", chapter: page - 1, frag: "", level });
    if (item.items.length) await flatOutline(item.items, level + 1, output);
  }
  return output;
}
function hideSelMenu() {
  if (selMenu) selMenu.style.display = "none";
}
function setupSelMenu() {
  selMenu = document.createElement("div");
  selMenu.id = "sel-menu";
  const web = document.createElement("button");
  const highlight = document.createElement("button");
  const note = document.createElement("button");
  const bookmark = document.createElement("button");
  web.type = highlight.type = note.type = bookmark.type = "button";
  web.textContent = "🔍 web搜索";
  highlight.textContent = "🖍 高亮";
  note.textContent = "📝 批注";
  bookmark.textContent = "🔖 书签";
  selMenu.append(web, highlight, note, bookmark);
  document.body.appendChild(selMenu);
  [web, highlight, note, bookmark].forEach((button) => button.addEventListener("mousedown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  }));
  const done = () => {
    getSelection()?.removeAllRanges();
    hideSelMenu();
  };
  web.addEventListener("click", (event) => {
    event.stopPropagation();
    const text = getSelection()?.toString().trim() ?? "";
    if (text) postToShell({ webSearch: text });
    done();
  });
  highlight.addEventListener("click", (event) => {
    event.stopPropagation();
    const payload = selectionPayload();
    if (payload) postToShell({ addHighlight: payload });
    done();
  });
  note.addEventListener("click", (event) => {
    event.stopPropagation();
    const payload = selectionPayload();
    if (payload) postToShell({ addHighlightNote: payload });
    done();
  });
  bookmark.addEventListener("click", (event) => {
    event.stopPropagation();
    postToShell({ addBookmark: { chapter: curPage - 1, frac: 0, text: (getSelection()?.toString().trim() ?? "").slice(0, 24) } });
    done();
  });
  document.addEventListener("mouseup", () => {
    window.setTimeout(() => {
      const selection = getSelection();
      const text = selection?.toString().trim() ?? "";
      if (!selection?.rangeCount || !text || !selMenu) {
        hideSelMenu();
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hideSelMenu();
        return;
      }
      selMenu.style.display = "block";
      const width = selMenu.offsetWidth || 140;
      const height = selMenu.offsetHeight || 34;
      const left = Math.max(6, Math.min(window.innerWidth - width - 6, rect.left + rect.width / 2 - width / 2));
      let top = rect.top - height - 8;
      if (top < 6) top = rect.bottom + 8;
      selMenu.style.left = `${left}px`;
      selMenu.style.top = `${top}px`;
    }, 0);
  });
  document.addEventListener("mousedown", (event) => {
    if (selMenu && !selMenu.contains(elementTarget(event.target))) hideSelMenu();
  });
  document.addEventListener("wheel", hideSelMenu, { passive: true });
}
function setupCenterTap() {
  document.addEventListener("click", (event) => {
    postToShell({ uiClick: 1 });
    if (overlayOpen || getSelection()?.toString().trim()) return;
    if (event.clientX > window.innerWidth * 0.33 && event.clientX < window.innerWidth * 0.67) postToShell({ centerTap: 1 });
  });
  const navigation = () => postToShell({ userNav: 1 });
  const throttledNavigation = throttle(navigation, 200);
  let zoomAt = 0;
  window.addEventListener("wheel", (event) => {
    if (event.altKey) {
      event.preventDefault();
      const now = Date.now();
      if (now - zoomAt < 45) return;
      zoomAt = now;
      applyScale(scale * (event.deltaY < 0 ? 1.05 : 1 / 1.05));
      return;
    }
    throttledNavigation();
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    let direction = 0;
    if (event.key === "PageDown" || event.key === "ArrowRight" || event.key === " " && !event.shiftKey) direction = 1;
    else if (event.key === "PageUp" || event.key === "ArrowLeft" || event.key === " " && event.shiftKey) direction = -1;
    if (direction) {
      event.preventDefault();
      gotoPage(turnTarget(direction), false);
      navigation();
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) navigation();
  });
}
window.addEventListener("message", (event) => {
  const normalized = pdfBootstrap ? pdfEngineAdapter.normalizeIncomingMessage(event, pdfBootstrap) : null;
  if (!isLegacyCommand(normalized)) return;
  if (normalized.protocol === "kunpeng-pdf-renderer") {
    const action = normalized.action;
    const payload = normalized.payload;
    if (action === "close-document") disposePdfView();
    else if (action === "cancel-operation" && payload?.operationId) cancelRenderOperation(payload.operationId);
    else if ((action === "render-page" || action === "open-document") && (payload?.page ?? payload?.initialPage) !== void 0) gotoPage(payload?.page ?? payload?.initialPage ?? 1, false);
    return;
  }
  if (normalized.gotoChapter !== void 0) gotoPage((normalized.gotoChapter | 0) + 1, true);
  if (normalized.gotoFrac !== void 0) gotoPage(Math.round(normalized.gotoFrac * total) || 1, false);
  if (normalized.zoom) setZoom(normalized.zoom);
  if (normalized.pageTurn) gotoPage(turnTarget(normalized.pageTurn > 0 ? 1 : -1), false);
  if (normalized.dual !== void 0) setDual(normalized.dual);
  if (normalized.settings?.theme !== void 0) applyTheme(normalized.settings.theme);
  if (normalized.overlayOpen !== void 0) overlayOpen = normalized.overlayOpen;
  if (normalized.search !== void 0) void searchPdf(normalized.search);
  if (normalized.searchNav) gotoMatch(searchIdx + normalized.searchNav);
  if (normalized.clearMarks) {
    searchTerm = "";
    clearSearchMarks();
  }
  if (normalized.highlights) {
    highlights = normalized.highlights;
    renderAllHighlights();
  }
  if (normalized.showHlMenuFor !== void 0) {
    const index = normalized.showHlMenuFor;
    const highlight = highlights[index];
    if (highlight) {
      const page = (highlight.chapter ?? 0) + 1;
      gotoPage(page, false);
      window.setTimeout(() => {
        const box = divs[page]?.querySelector(`.hl-box[data-hi="${index}"]`);
        if (box) showHlMenu(index, box);
      }, 200);
    }
  }
  if (normalized.gotoHighlight !== void 0) {
    const highlight = highlights[normalized.gotoHighlight];
    if (highlight) gotoPage((highlight.chapter ?? 0) + 1, true);
  }
});
async function init() {
  if (!pdfBootstrap) {
    pagesEl.innerHTML = '<div class="loading">PDF 打开失败：阅读器安全桥未就绪。</div>';
    return;
  }
  setupReaderGestureForwarding();
  pdfSession = pdfEngineAdapter.createSession(pdfBootstrap);
  applyTheme(settings.theme);
  try {
    const loadingTask = pdfjsLib.getDocument({ url: pdfUrl, disableRange: true, disableStream: true, disableAutoFetch: true });
    pdfSession.trackLoadingTask(loadingTask);
    pdf = await loadingTask.promise;
    if (pdfDisposed || pdfSession.signal.aborted) {
      disposePdfView();
      return;
    }
  } catch {
    pagesEl.innerHTML = '<div class="loading">PDF 打开失败：无法读取受控图书资源。</div>';
    postToShell({ ready: 1 });
    return;
  }
  total = requirePdf().numPages;
  const firstViewport = (await requirePdf().getPage(1)).getViewport({ scale: 1 });
  nativeW = firstViewport.width;
  nativeH = firstViewport.height;
  const savedScale = Number.parseFloat(parameters.get("scale") ?? "0") || 0;
  if (parameters.get("dual") === "1") {
    dualMode = true;
    document.body.classList.add("dual");
  }
  scale = savedScale > 0 ? Math.max(0.4, Math.min(4, savedScale)) : fitScale();
  baseW = nativeW * scale;
  baseH = nativeH * scale;
  pagesEl.innerHTML = "";
  for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) {
    const page = document.createElement("div");
    page.className = "pg";
    page.dataset.p = String(pageNumber);
    page.style.width = `${baseW}px`;
    page.style.height = `${baseH}px`;
    pagesEl.appendChild(page);
    divs[pageNumber] = page;
  }
  io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) {
      const page = entry.target instanceof HTMLDivElement ? numberAt(entry.target.dataset.p) : 0;
      if (page) void renderPage(page);
    }
  }, { root: null, rootMargin: "500px 0px" });
  for (const page of divs) if (page) io.observe(page);
  window.addEventListener("scroll", throttle(() => {
    if (Date.now() < progScrollUntil) return;
    curPage = pageAtTop();
    report();
  }, 200), { passive: true });
  setupSelMenu();
  setupHlMenu();
  setupCenterTap();
  void requirePdf().getOutline().then((outline) => flatOutline(outline)).then((outline) => postToShell({ outline })).catch(() => void 0);
  gotoPage(resumePage, false);
  postToShell({ ready: 1 });
  report();
}
void init();
