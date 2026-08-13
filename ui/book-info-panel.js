// 书架和阅读页共用的图书信息面板。页面只提供数据写入和跳转动作，结构、渲染和评分在这里维护。
(function exposeBookInfoPanel(global) {
  "use strict";

  const instances = new WeakMap();
  const fallbackText = (value, empty = "未添加") => {
    const items = Array.isArray(value) ? value.filter(Boolean).map(String) : [];
    return { text: items.length ? items.join("、") : empty, title: items.join("、") };
  };
  const fmtWords = (value) => {
    const words = Number(value || 0);
    return words >= 10000 ? `${(words / 10000).toFixed(2)} 万字` : `${words} 字`;
  };
  const fmtSize = (value) => {
    const bytes = Number(value || 0);
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
    return `${bytes}B`;
  };
  const coverColor = (title) => {
    let value = 0;
    for (const character of String(title || "")) value = ((value * 31) + character.charCodeAt(0)) >>> 0;
    return `hsl(${value % 360} 42% 42%)`;
  };
  const idsFor = (prefix, options) => ({
    cover: `${prefix}-cover`,
    title: `${prefix}-title`,
    author: `${prefix}-author`,
    format: `${prefix}-format`,
    words: `${prefix}-words`,
    size: `${prefix}-size`,
    stars: `${prefix}-stars`,
    tagSummary: `${prefix}-tag-summary`,
    collectionSummary: `${prefix}-collection-summary`,
    modelTags: `${prefix}-model-tags`,
    description: `${prefix}-desc`,
    coverChange: options.coverChangeId || `${prefix}-cover-change`,
    tagsManage: options.tagsManageId || `${prefix}-tags-manage`,
    collectionsManage: options.collectionsManageId || `${prefix}-collections-manage`,
    similar: options.similarId || `${prefix}-similar-books-btn`,
    timeline: options.timelineId || `${prefix}-reading-timeline-btn`,
  });

  function markup(ids) {
    return `
      <section class="modal-card book-info-card">
        <section class="book-info-hero">
          <div class="book-info-cover-stack">
            <div id="${ids.cover}" class="book-info-cover" aria-label="图书封面"></div>
            <button id="${ids.coverChange}" class="book-info-cover-change" type="button" title="选择图片更换封面" data-book-info-action="cover">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h4l1.5-2h5l1.5 2h4v11H4z" /><circle cx="12" cy="13" r="3.2" /></svg><span>更换封面</span>
            </button>
          </div>
          <div class="book-info-identity">
            <section class="book-info-primary">
              <label class="book-info-title-field"><span>书名</span><input id="${ids.title}" class="info-input" type="text" autocomplete="off" /></label>
              <div class="book-info-author-field"><span>作者</span><p id="${ids.author}" class="book-info-author"></p></div>
            </section>
            <section class="book-info-facts" aria-label="图书属性">
              <div><span>格式</span><strong id="${ids.format}"></strong></div>
              <div><span>字数</span><strong id="${ids.words}"></strong></div>
              <div><span>大小</span><strong id="${ids.size}"></strong></div>
              <div><span>我的评分</span><span id="${ids.stars}" class="info-stars" title="点击打分，再点同一颗清除"></span></div>
            </section>
          </div>
        </section>
        <section class="book-info-section book-info-organization-section" aria-label="标签与收藏书单">
          <div class="book-info-organization-grid">
            <div class="book-info-organization-entry"><span class="info-k">标签</span><span id="${ids.tagSummary}" class="info-v book-info-organization-summary">未添加</span><button id="${ids.tagsManage}" class="book-info-organization-link" type="button" data-book-info-action="tags">管理</button></div>
            <div class="book-info-organization-entry"><span class="info-k">收藏书单</span><span id="${ids.collectionSummary}" class="info-v book-info-organization-summary">未添加</span><button id="${ids.collectionsManage}" class="book-info-organization-link" type="button" data-book-info-action="collections">管理</button></div>
          </div>
        </section>
        <section class="book-info-section">
          <div class="book-info-section-head"><h3>AI 分类</h3><span>自动识别</span></div>
          <div id="${ids.modelTags}" class="info-v info-chips book-info-model-tags"></div>
        </section>
        <section class="book-info-section book-info-tools">
          <div class="book-info-section-head"><h3>操作</h3></div>
          <div class="info-action-buttons"><button id="${ids.similar}" class="btn-plain" type="button" data-book-info-action="similar">相似图书</button><button id="${ids.timeline}" class="btn-plain" type="button" data-book-info-action="timeline">阅读时间线</button></div>
        </section>
        <section class="book-info-section book-info-description">
          <div class="book-info-section-head"><h3>简介</h3><span>失焦后自动保存</span></div>
          <div id="${ids.description}" class="info-desc" contenteditable="true"></div>
        </section>
      </section>`;
  }

  function mount(options = {}) {
    const root = options.root || global.document;
    const host = options.host;
    if (!root || !host) throw new Error("图书信息面板需要 root 和 host。");
    const previous = instances.get(host);
    if (previous) return previous;
    const ids = idsFor(options.prefix || "book-info", options);
    host.innerHTML = markup(ids);
    const elements = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, root.getElementById(id)]));
    let handlers = { ...options };

    const stars = Array.from({ length: 5 }, () => {
      const star = root.createElement("span");
      star.className = "star";
      const background = root.createElement("span");
      background.className = "s-bg";
      background.textContent = "★";
      const foreground = root.createElement("span");
      foreground.className = "s-fg";
      foreground.textContent = "★";
      star.append(background, foreground);
      elements.stars.appendChild(star);
      return star;
    });
    const paintStars = (value) => stars.forEach((star, index) => {
      star.querySelector(".s-fg").style.width = `${Math.max(0, Math.min(1, value - index)) * 100}%`;
    });
    const ratingAt = (event) => {
      for (let index = 0; index < stars.length; index += 1) {
        const bounds = stars[index].getBoundingClientRect();
        if (event.clientX <= bounds.right) return index + (event.clientX < bounds.left + bounds.width / 2 ? 0.5 : 1);
      }
      return 5;
    };
    elements.stars.addEventListener("mousemove", (event) => paintStars(ratingAt(event)));
    elements.stars.addEventListener("mouseleave", () => paintStars(elements.stars._value || 0));
    elements.stars.addEventListener("click", (event) => {
      let rating = ratingAt(event);
      if (rating === elements.stars._value) rating = 0;
      controller.setRating(rating);
      handlers.onRating?.(rating);
    });
    elements.title.addEventListener("blur", () => handlers.onTitle?.(elements.title.value.trim()));
    elements.description.addEventListener("blur", () => handlers.onDescription?.(elements.description.textContent.trim()));
    host.addEventListener("click", (event) => {
      const action = event.target.closest("[data-book-info-action]")?.dataset.bookInfoAction;
      if (action) handlers.onAction?.(action);
    });

    function renderCover(meta) {
      const title = String(meta?.title || elements.title.value || "未命名");
      const renderFallback = () => {
        const fallback = root.createElement("span");
        fallback.className = "book-info-cover-fallback";
        fallback.style.background = coverColor(title);
        fallback.textContent = title.slice(0, 18);
        elements.cover.replaceChildren(fallback);
      };
      if (!meta?.cover) return renderFallback();
      const image = root.createElement("img");
      image.src = meta.cover;
      image.alt = title;
      image.draggable = false;
      image.decoding = "async";
      image.addEventListener("error", renderFallback, { once: true });
      elements.cover.replaceChildren(image);
    }
    function renderModelTags(values) {
      elements.modelTags.replaceChildren();
      const tags = Array.isArray(values) ? values.filter(Boolean) : [];
      if (!tags.length) {
        const empty = root.createElement("span");
        empty.className = "info-chip empty";
        empty.textContent = "未添加";
        elements.modelTags.appendChild(empty);
        return;
      }
      tags.forEach((value) => {
        const chip = root.createElement("span");
        chip.className = "info-chip model-tag";
        const origin = root.createElement("span");
        origin.className = "info-chip-origin";
        origin.textContent = "AI";
        chip.append(origin, root.createTextNode(String(value)));
        chip.title = "大模型分类标签";
        elements.modelTags.appendChild(chip);
      });
    }
    const controller = {
      elements,
      configure(next = {}) { handlers = { ...handlers, ...next }; return controller; },
      setRating(value) { elements.stars._value = Number(value) || 0; paintStars(elements.stars._value); },
      setLoading() { elements.words.textContent = "统计中…"; },
      setError(error) { elements.words.textContent = `读取失败：${error}`; },
      render(meta = {}) {
        elements.title.value = meta.title || "";
        elements.author.textContent = meta.author || "未知";
        elements.format.textContent = String(meta.format || "").toUpperCase();
        elements.words.textContent = fmtWords(meta.word_count ?? meta.wordCount);
        elements.size.textContent = fmtSize(meta.size);
        elements.description.textContent = meta.description || "";
        const tags = fallbackText(meta.tags);
        const collections = fallbackText(meta.collections);
        elements.tagSummary.textContent = tags.text;
        elements.tagSummary.title = tags.title;
        elements.collectionSummary.textContent = collections.text;
        elements.collectionSummary.title = collections.title;
        renderModelTags(meta.model_tags || meta.modelTags);
        controller.setRating(meta.rating || 0);
        renderCover(meta);
        return controller;
      },
      renderCover,
    };
    instances.set(host, controller);
    return controller;
  }

  global.ReaderBookInfoPanel = Object.freeze({ mount, fmtWords, fmtSize });
})(window);
