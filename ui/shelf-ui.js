// 书架渲染、排序、过滤与自定义滚动条
// 依赖 app.js 中的书架状态变量；保持纯 JS 轻量边界。

// 阅读状态：done 已读 / unread 未读 / reading 正在阅读
function readStatus(b) {
  const p = b.progress || 0;
  if (p >= 99) return "done";
  if (p < 1) return "unread";
  return "reading";
}

const PALETTE = [
  "#3e5a8c", "#8c4650", "#46785f", "#82643c",
  "#5f5082", "#3c6e78", "#78556e", "#5a6446",
];
function colorFor(title) {
  let h = 2166136261;
  for (let i = 0; i < title.length; i++) {
    h ^= title.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

// 只读的评分小星（支持半星），叠在封面底部
function staticStars(v) {
  const wrap = document.createElement("div");
  wrap.className = "cover-stars";
  for (let i = 0; i < 5; i++) {
    const st = document.createElement("span");
    st.className = "star";
    const bg = document.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = document.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    fg.style.width = Math.max(0, Math.min(1, v - i)) * 100 + "%";
    st.append(bg, fg);
    wrap.appendChild(st);
  }
  return wrap;
}

function bookRenderKey(b) {
  return [
    b.id || "",
    b.title || "",
    b.cover || "",
    b.progress || 0,
    b.rating || 0,
    b.missing ? 1 : 0,
    showCoverProgress ? 1 : 0,
    showCoverRating ? 1 : 0,
  ].join("\u001f");
}
function bookCard(b, index = 0) {
  const card = document.createElement("div");
  card.className = "book";

  const cover = document.createElement("div");
  cover.className = "cover";

  if (b.cover) {
    // EPUB 真实封面。封面带 Cache-Control，命中缓存时同帧直接画出，无任何过渡。
    // 真实封面加载前只用中性底色，避免用户看到“纯色封面”再跳成图片。
    cover.classList.add("has-img");
    const img = document.createElement("img");
    img.alt = b.title;
    img.loading = index < 24 ? "eager" : "lazy";
    img.decoding = index < 24 ? "sync" : "async";
    img.src = b.cover;
    cover.appendChild(img);
  } else {
    // 生成的占位封面：书名 + 配色
    cover.style.background = colorFor(b.title);
    const spine = document.createElement("div");
    spine.className = "spine";
    const gen = document.createElement("div");
    gen.className = "gen";
    gen.textContent = b.title;
    cover.appendChild(spine);
    cover.appendChild(gen);
  }
  if (b.progress > 0 && showCoverProgress) {
    const badge = document.createElement("div");
    badge.className = "badge";
    badge.textContent = b.progress.toFixed(0) + "%"; // 封面右下角阅读进度
    cover.appendChild(badge);
  }
  if (b.missing) {
    card.classList.add("missing");
    const warn = document.createElement("div");
    warn.className = "missing-badge";
    warn.textContent = "⚠ 文件丢失";
    cover.appendChild(warn);
  }
  if (showCoverRating && b.rating > 0) cover.appendChild(staticStars(b.rating)); // 封面底部评分小星

  const title = document.createElement("div");
  title.className = "title";
  title.textContent = b.title;

  const prog = document.createElement("div");
  prog.className = "prog";
  prog.textContent = b.progress > 0 ? b.progress.toFixed(1) + "%" : "未读";

  card.dataset.id = b.id;
  card.dataset.renderKey = bookRenderKey(b);
  if (selected.has(b.id)) card.classList.add("selected");

  card.appendChild(cover);
  card.appendChild(title);
  card.appendChild(prog);

  // 单击选中（防抖以区分双击）；双击打开
  let clickTimer = null;
  card.addEventListener("click", (e) => {
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      return; // 双击的第二下，不当作选中
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      toggleSelect(b.id, card);
    }, 230);
  });
  card.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    if (b.missing) {
      relocateBook(b);
      return;
    }
    if (typeof window.clearCrossReturnMemory === "function") window.clearCrossReturnMemory();
    invoke("open_book", { id: b.id }).catch((err) => {
      const s = String(err);
      if (s.includes("丢失") || s.includes("定位")) relocateBook(b);
      else alert("打开失败：" + s);
    });
  });

  return card;
}

// 更换封面：挑一张图片 → 后端缩略并替换
async function changeCover(b) {
  const sel = await dialog.open({
    multiple: false,
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  try {
    render(await invoke("set_cover", { id: b.id, path }));
  } catch (e) {
    alert("更换封面失败：" + e);
  }
}

// 文件丢失 → 让用户重新定位到文件新位置（指纹一致则各项数据都保留）
async function relocateBook(b) {
  if (!confirm("《" + b.title + "》的源文件找不到了。\n是否重新定位到它现在的位置？")) return;
  const ext = (b.format || "").toLowerCase();
  const sel = await dialog.open({
    multiple: false,
    filters: [{ name: "电子书", extensions: ext ? [ext] : ["epub", "pdf", "txt", "md", "markdown", "mobi", "azw3", "azw"] }],
  });
  if (!sel) return;
  const path = Array.isArray(sel) ? sel[0] : sel;
  render(await invoke("relocate_book", { id: b.id, path }));
}

function sortBooks(list) {
  const arr = list.slice();
  arr.sort((a, b) => {
    switch (sortKey) {
      case "author":
        return (
          (a.author || "").localeCompare(b.author || "", "zh") ||
          a.title.localeCompare(b.title, "zh")
        );
      case "added":
        return (b.added_at || 0) - (a.added_at || 0); // 新导入在前
      case "dir":
        return (a.path || "").localeCompare(b.path || "", "zh"); // 按存储目录/路径
      case "read":
        return (b.last_read_at || 0) - (a.last_read_at || 0); // 最近读的在前
      default: {
        // 书名：按拼音首字母分组排序（# 组排最后），同字母内按书名
        const ra = !a.initial || a.initial === "#" ? "~" : a.initial;
        const rb = !b.initial || b.initial === "#" ? "~" : b.initial;
        return ra.localeCompare(rb) || a.title.localeCompare(b.title, "zh");
      }
    }
  });
  return arr;
}

function matchesShelfSearch(b) {
  if (!searchQuery) return true;
  return (
    (b.title || "").toLowerCase().includes(searchQuery) ||
    (b.author || "").toLowerCase().includes(searchQuery) ||
    (b.description || "").toLowerCase().includes(searchQuery)
  );
}
function hasActiveShelfFilters() {
  return minRating > 0 || !(readingFilter.unread && readingFilter.reading && readingFilter.done);
}

// 当前真正显示在书架上的书。搜索永远搜索整座书架，避免被评分/阅读过滤误挡住。
function currentList() {
  let list = books;
  if (searchQuery) {
    return books.filter(matchesShelfSearch);
  }
  // 阅读状态过滤（三项全勾=全部显示）
  if (!(readingFilter.unread && readingFilter.reading && readingFilter.done)) {
    list = list.filter((b) => readingFilter[readStatus(b)]);
  }
  // 评分过滤（minRating>0 → 只显示评分≥该值的书）
  if (minRating > 0) {
    list = list.filter((b) => (b.rating || 0) >= minRating);
  }
  return list;
}

let shelfScrollUpdateRaf = 0;
let shelfRendering = false;
function updateShelfScrollbar() {
  shelfScrollUpdateRaf = 0;
  if (shelfRendering) return;
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  const viewport = contentEl.clientHeight;
  const total = contentEl.scrollHeight;
  const maxScroll = Math.max(0, total - viewport);
  if (viewport <= 0 || maxScroll <= 1) {
    shelfScrollbar.classList.remove("show");
    return;
  }
  shelfScrollbar.classList.add("show");
  const trackHeight = shelfScrollbar.clientHeight;
  const thumbHeight = Math.max(28, Math.round((viewport / total) * trackHeight));
  const maxTop = Math.max(0, trackHeight - thumbHeight);
  const top = maxScroll ? Math.round((contentEl.scrollTop / maxScroll) * maxTop) : 0;
  shelfScrollbarThumb.style.height = thumbHeight + "px";
  shelfScrollbarThumb.style.transform = "translateY(" + top + "px)";
}
function scheduleShelfScrollbarUpdate() {
  if (shelfScrollUpdateRaf) return;
  shelfScrollUpdateRaf = requestAnimationFrame(updateShelfScrollbar);
}
function initShelfScrollbar() {
  if (!contentEl || !shelfScrollbar || !shelfScrollbarThumb) return;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  contentEl.addEventListener("scroll", scheduleShelfScrollbarUpdate, { passive: true });
  window.addEventListener("resize", scheduleShelfScrollbarUpdate);

  shelfScrollbar.addEventListener("pointerdown", (e) => {
    if (!shelfScrollbar.classList.contains("show")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = shelfScrollbar.getBoundingClientRect();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    const maxTop = Math.max(1, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    if (e.target !== shelfScrollbarThumb) {
      const targetTop = Math.min(maxTop, Math.max(0, e.clientY - rect.top - thumbHeight / 2));
      contentEl.scrollTop = (targetTop / maxTop) * maxScroll;
    }
    dragging = true;
    dragStartY = e.clientY;
    dragStartScrollTop = contentEl.scrollTop;
    shelfScrollbar.classList.add("dragging");
    shelfScrollbar.setPointerCapture(e.pointerId);
  });
  shelfScrollbar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    e.preventDefault();
    const trackHeight = shelfScrollbar.clientHeight;
    const thumbHeight = shelfScrollbarThumb.offsetHeight;
    const maxTop = Math.max(1, trackHeight - thumbHeight);
    const maxScroll = Math.max(1, contentEl.scrollHeight - contentEl.clientHeight);
    contentEl.scrollTop = dragStartScrollTop + ((e.clientY - dragStartY) / maxTop) * maxScroll;
  });
  const stopDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    shelfScrollbar.classList.remove("dragging");
    try { shelfScrollbar.releasePointerCapture(e.pointerId); } catch (_) {}
    scheduleShelfScrollbarUpdate();
  };
  shelfScrollbar.addEventListener("pointerup", stopDrag);
  shelfScrollbar.addEventListener("pointercancel", stopDrag);
  scheduleShelfScrollbarUpdate();
}
initShelfScrollbar();

let viewRenderToken = 0;
function applyView(options = {}) {
  const token = ++viewRenderToken;
  const preserveScroll = options.preserveScroll !== false && shelfLoaded;
  const savedScrollTop = preserveScroll && contentEl ? contentEl.scrollTop : 0;
  shelfEl.classList.toggle("list", layout === "list");
  shelfEl.classList.toggle("show-titles", showCoverTitle); // 网格视图是否显示书名
  applyShelfGridColumns();
  shelfRendering = true;
  const list = currentList();
  if (!shelfLoaded) {
    emptyEl.style.display = "none";
  } else if (list.length) {
    emptyEl.style.display = "none";
  } else {
    emptyEl.textContent = searchQuery
      ? "没有匹配的书籍"
      : hasActiveShelfFilters()
        ? "没有符合当前筛选条件的书籍。"
        : "书架还是空的。点右上角「⋮」→「导入书籍」添加（可一次选多本）。";
    emptyEl.style.display = "block";
  }
  const sorted = sortBooks(list);
  const finishCoverRender = startupPerfStart("cover-render", "critical books=" + sorted.length + " layout=" + layout);
  let chunks = 0;
  function restoreShelfScroll() {
    if (!preserveScroll || !contentEl) return;
    const maxScroll = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
    contentEl.scrollTop = Math.min(savedScrollTop, maxScroll);
  }
  function finishRender() {
    restoreShelfScroll();
    shelfRendering = false;
    finishCoverRender("chunks=" + chunks);
    scheduleShelfScrollbarUpdate();
  }
  if (!sorted.length) {
    shelfEl.replaceChildren();
    finishRender();
    return;
  }

  const existingCards = new Map();
  Array.from(shelfEl.children).forEach((node) => {
    if (node.classList && node.classList.contains("book") && node.dataset.id) existingCards.set(node.dataset.id, node);
  });
  let changedCards = 0;
  for (const b of sorted) {
    const card = existingCards.get(b.id);
    if (!card || card.dataset.renderKey !== bookRenderKey(b)) changedCards += 1;
  }
  const shouldReuse = existingCards.size > 0 && changedCards <= Math.max(24, sorted.length * 0.35);
  if (shouldReuse) {
    const frag = document.createDocumentFragment();
    sorted.forEach((b, index) => {
      const key = bookRenderKey(b);
      let card = existingCards.get(b.id);
      if (!card || card.dataset.renderKey !== key) {
        card = bookCard(b, index);
      } else {
        card.classList.toggle("selected", selected.has(b.id));
      }
      frag.appendChild(card);
    });
    shelfEl.replaceChildren(frag);
    chunks = 1;
    finishRender();
    return;
  }

  let i = 0;
  function makeChunk() {
    const frag = document.createDocumentFragment();
    const end = Math.min(i + 28, sorted.length);
    for (; i < end; i++) frag.appendChild(bookCard(sorted[i], i));
    chunks += 1;
    return frag;
  }
  shelfEl.replaceChildren(makeChunk());
  restoreShelfScroll();
  function appendChunk() {
    if (token !== viewRenderToken) {
      shelfRendering = false;
      return;
    }
    shelfEl.appendChild(makeChunk());
    restoreShelfScroll();
    if (i < sorted.length) setTimeout(appendChunk, 0);
    else finishRender();
  }
  if (i < sorted.length) setTimeout(appendChunk, 0);
  else finishRender();
}
let lastJSON = ""; // 上次渲染的数据快照，数据没变就不重渲染（避免封面重载闪烁）
function render(list) {
  shelfLoaded = true;
  books = list;
  if (books.length && minRating > 0 && !books.some((b) => (b.rating || 0) >= minRating)) {
    minRating = 0;
    localStorage.removeItem("minRating");
    filterStarsEl?.setVal?.(0);
  }
  const j = JSON.stringify(list);
  if (j === lastJSON) return;
  lastJSON = j;
  applyView();
}
