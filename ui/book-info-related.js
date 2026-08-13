// 图书信息页的后续信息层。书架和阅读页只传入命令与打开图书动作，不再各自维护一套 UI。
(function exposeBookInfoRelated(global) {
  "use strict";

  const instances = new WeakMap();
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const formatWords = (value) => global.ReaderBookInfoPanel?.fmtWords(value) || `${Number(value || 0)} 字`;
  const formatDuration = (seconds) => {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (hours) return `${hours} 小时${minutes ? ` ${minutes} 分钟` : ""}`;
    if (minutes) return `${minutes} 分钟`;
    return `${Math.floor(total)} 秒`;
  };
  const formatDateTime = (seconds) => seconds
    ? new Date(Number(seconds) * 1000).toLocaleString("zh-CN", { hour12: false })
    : "尚无记录";
  const dayText = (day) => {
    const raw = String(day || "");
    return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : "未知日期";
  };
  const shortDay = (day) => {
    const raw = String(day || "");
    return raw.length === 8 ? `${raw.slice(4, 6)}/${raw.slice(6)}` : "—";
  };
  const coverColor = (title) => {
    let value = 0;
    for (const character of String(title || "")) value = ((value * 31) + character.charCodeAt(0)) >>> 0;
    return `hsl(${value % 360} 42% 42%)`;
  };

  function surfaceMarkup() {
    return `
      <div id="similar-books-modal" class="modal book-info-related-modal" data-book-related="similar" data-overlay-role="information" role="dialog" aria-modal="true" aria-labelledby="book-related-similar-title">
        <section class="modal-card similar-books-card">
          <div class="modal-head book-related-head"><span class="modal-title-stack"><strong id="book-related-similar-title">相似图书</strong><small data-book-related-source></small></span><button class="btn-plain" type="button" data-book-related-close aria-label="关闭">✕</button></div>
          <div class="similar-list" data-book-related-similar-list></div>
        </section>
      </div>
      <div id="reading-timeline-modal" class="modal book-info-related-modal" data-book-related="timeline" data-overlay-role="information" role="dialog" aria-modal="true" aria-labelledby="book-related-timeline-title">
        <section class="modal-card timeline-card">
          <div class="modal-head book-related-head"><span class="modal-title-stack"><strong id="book-related-timeline-title">阅读时间线</strong><small data-book-related-timeline-subtitle>从阅读时长到进度变化</small></span><button class="btn-plain" type="button" data-book-related-close aria-label="关闭">✕</button></div>
          <div class="timeline-body" data-book-related-timeline-body></div>
        </section>
      </div>`;
  }

  function timelineChart(buckets) {
    const days = new Map();
    (buckets || []).forEach((bucket) => {
      const key = String(bucket.day || "");
      const item = days.get(key) || { day: bucket.day, seconds: 0, words: 0 };
      item.seconds += Number(bucket.seconds || 0);
      item.words += Number(bucket.words || 0);
      days.set(key, item);
    });
    const items = [...days.values()].sort((a, b) => Number(a.day) - Number(b.day)).slice(-28);
    if (!items.length) return '<div class="book-related-empty">还没有可绘制的每日阅读记录</div>';
    const max = Math.max(...items.map((item) => item.seconds), 1);
    const width = Math.max(620, items.length * 48);
    const step = width / items.length;
    const bars = items.map((item, index) => {
      const height = Math.max(4, Math.round((item.seconds / max) * 116));
      const x = Math.round(index * step + step / 2);
      const title = `${dayText(item.day)} · ${formatDuration(item.seconds)} · ${formatWords(item.words)}`;
      return `<g class="timeline-bar"><title>${escapeHtml(title)}</title><rect x="${x - 8}" y="${132 - height}" width="16" height="${height}" rx="8"/><text x="${x}" y="154" text-anchor="middle">${shortDay(item.day)}</text></g>`;
    }).join("");
    return `<div class="timeline-chart"><svg viewBox="0 0 ${width} 166" role="img" aria-label="最近每日阅读时长"><defs><linearGradient id="timeline-bar-gradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6f8cff"/><stop offset="1" stop-color="#43b6a1"/></linearGradient></defs><line x1="0" y1="132" x2="${width}" y2="132"/><line x1="0" y1="74" x2="${width}" y2="74"/>${bars}</svg></div><div class="timeline-chart-caption"><span>最近 ${items.length} 个有记录的日期</span><span>悬停柱形查看时长与字数</span></div>`;
  }

  function timelineMarkup(data) {
    const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
    const events = Array.isArray(data?.events) ? data.events.slice().reverse() : [];
    const days = new Set(buckets.map((bucket) => String(bucket.day || ""))).size;
    const totalSeconds = buckets.reduce((sum, bucket) => sum + Number(bucket.seconds || 0), 0);
    const totalWords = buckets.reduce((sum, bucket) => sum + Number(bucket.words || 0), 0);
    const latest = events[0];
    const summary = `<section class="timeline-summary"><div><span>累计阅读</span><strong>${escapeHtml(formatDuration(totalSeconds))}</strong></div><div><span>活跃天数</span><strong>${days} 天</strong></div><div><span>阅读字数</span><strong>${escapeHtml(formatWords(totalWords))}</strong></div><div><span>最近进度</span><strong>${latest ? `${Number(latest.progress || 0).toFixed(1)}%` : "—"}</strong></div></section>`;
    const chart = `<section class="timeline-panel"><div class="timeline-panel-head"><div><span class="timeline-eyebrow">READING RHYTHM</span><h3>阅读节奏</h3></div><span>按天汇总阅读时长</span></div>${timelineChart(buckets)}</section>`;
    const eventList = events.length ? events.map((event, index) => `
      <article class="timeline-event-card">
        <span class="timeline-event-dot" aria-hidden="true"></span>
        <div class="timeline-event-date"><strong>${escapeHtml(formatDateTime(event.at))}</strong><span>${index === 0 ? "最近一次" : "进度记录"}</span></div>
        <div class="timeline-event-place"><span>第 ${Number(event.chapter || 0) + 1} 章</span><strong>${Number(event.progress || 0).toFixed(1)}%</strong></div>
      </article>`).join("") : '<div class="book-related-empty">从现在起，读到新的章节或进度时会记录在这里。</div>';
    return `${summary}${chart}<section class="timeline-panel timeline-history"><div class="timeline-panel-head"><div><span class="timeline-eyebrow">PROGRESS HISTORY</span><h3>进度足迹</h3></div><span>${events.length} 条记录</span></div><div class="timeline-event-list">${eventList}</div></section>`;
  }

  function mount(options = {}) {
    const root = options.root || global.document;
    if (!root?.body || typeof options.invoke !== "function") throw new Error("相关图书信息层需要 root 和 invoke。");
    const previous = instances.get(root);
    if (previous) return previous.configure(options);
    const holder = root.createElement("div");
    holder.className = "book-info-related-surfaces";
    holder.innerHTML = surfaceMarkup();
    while (holder.firstChild) root.body.appendChild(holder.firstChild);
    const similarModal = root.querySelector('[data-book-related="similar"]');
    const timelineModal = root.querySelector('[data-book-related="timeline"]');
    const source = similarModal.querySelector("[data-book-related-source]");
    const similarList = similarModal.querySelector("[data-book-related-similar-list]");
    const timelineSubtitle = timelineModal.querySelector("[data-book-related-timeline-subtitle]");
    const timelineBody = timelineModal.querySelector("[data-book-related-timeline-body]");
    let handlers = { ...options };

    const close = (modal) => modal.classList.remove("show");
    [similarModal, timelineModal].forEach((modal) => {
      modal.querySelector("[data-book-related-close]").addEventListener("click", () => close(modal));
      modal.addEventListener("click", (event) => { if (event.target === modal) close(modal); });
    });
    function renderSimilarBooks(list) {
      similarList.replaceChildren();
      if (!Array.isArray(list) || !list.length) {
        similarList.innerHTML = '<div class="book-related-empty">没有找到相似图书。可以先建立语义索引，或让更多图书参与索引。</div>';
        return;
      }
      list.forEach((book) => {
        const item = root.createElement("button");
        item.type = "button";
        item.className = "similar-item";
        const cover = root.createElement("div");
        cover.className = "similar-cover";
        if (book.cover) {
          cover.classList.add("has-img");
          const image = root.createElement("img");
          image.src = book.cover;
          image.alt = book.title || "";
          cover.appendChild(image);
        } else {
          cover.style.background = handlers.coverColor?.(book.title || "") || coverColor(book.title);
          const spine = root.createElement("span");
          spine.className = "spine";
          const fallback = root.createElement("span");
          fallback.className = "gen";
          fallback.textContent = book.title || "未命名";
          cover.append(spine, fallback);
        }
        const body = root.createElement("div");
        body.className = "similar-body";
        const title = root.createElement("strong");
        title.className = "similar-title";
        title.textContent = book.title || "未命名";
        const score = Math.round(Math.max(0, Math.min(1, Number(book.score || 0))) * 100);
        const meta = root.createElement("span");
        meta.className = "similar-meta";
        meta.textContent = `${book.author ? `${book.author} · ` : ""}相关性 ${score}%`;
        const bar = root.createElement("span");
        bar.className = "similar-score";
        const fill = root.createElement("span");
        fill.style.width = `${score}%`;
        bar.appendChild(fill);
        body.append(title, meta);
        if (book.description) {
          const description = root.createElement("span");
          description.className = "similar-description";
          description.textContent = book.description;
          body.appendChild(description);
        }
        body.appendChild(bar);
        item.append(cover, body);
        item.addEventListener("click", () => { close(similarModal); handlers.onOpenBook?.(book); });
        similarList.appendChild(item);
      });
    }
    const controller = {
      configure(next = {}) { handlers = { ...handlers, ...next }; return controller; },
      async openSimilar(id, book = {}) {
        if (!id) return;
        source.textContent = book.title ? `基于《${book.title}》的正文语义相似度` : "基于正文语义相似度";
        similarList.innerHTML = '<div class="book-related-empty is-loading">正在计算相似图书…</div>';
        similarModal.classList.add("show");
        try { renderSimilarBooks(await handlers.invoke("similar_books", { id: String(id) })); }
        catch (error) { similarList.innerHTML = `<div class="book-related-empty">读取失败：${escapeHtml(error)}</div>`; }
      },
      async openTimeline(id) {
        if (!id) return;
        timelineSubtitle.textContent = "正在整理阅读记录…";
        timelineBody.innerHTML = '<div class="book-related-empty is-loading">正在整理阅读记录…</div>';
        timelineModal.classList.add("show");
        try {
          const data = await handlers.invoke("book_reading_timeline", { id: String(id) });
          timelineSubtitle.textContent = data?.title ? `《${data.title}》的阅读轨迹` : "从阅读时长到进度变化";
          timelineBody.innerHTML = timelineMarkup(data || {});
        } catch (error) {
          timelineSubtitle.textContent = "阅读记录暂不可用";
          timelineBody.innerHTML = `<div class="book-related-empty">读取失败：${escapeHtml(error)}</div>`;
        }
      },
      closeAll() { close(similarModal); close(timelineModal); },
    };
    instances.set(root, controller);
    return controller;
  }

  global.ReaderBookInfoRelated = Object.freeze({ mount, formatDuration });
})(window);
