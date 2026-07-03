// 阅读页目录、书签与批注/高亮 UI
// 先于 reader.js 加载：提供 buildToc/renderBookmarks/renderHighlights/addHighlight/openAnnotations 等阅读页辅助函数。

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
