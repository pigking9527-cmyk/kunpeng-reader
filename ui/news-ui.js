/* NewsNow 的资讯入口独立于书架和阅读器：只请求摘要，原文仍在用户选择时打开。 */
(function (global) {
  "use strict";

  const LOAD_TIMEOUT_MS = 15000;

  function text(value) {
    return String(value == null ? "" : value);
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(text(value));
      return url.protocol === "https:" ? url.href : "";
    } catch (_) {
      return "";
    }
  }

  function resultItems(result) {
    if (Array.isArray(result)) return result;
    if (Array.isArray(result && result.items)) return result.items;
    if (Array.isArray(result && result.data)) return result.data;
    if (Array.isArray(result && result.news)) return result.news;
    return [];
  }

  function withTimeout(promise, timeoutMs = LOAD_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = global.setTimeout(() => reject(new Error("资讯请求超时")), timeoutMs);
    });
    return Promise.race([Promise.resolve(promise), timeout])
      .finally(() => global.clearTimeout(timer));
  }

  function itemCategory(item) {
    return text(item.category || item.feed || item.channel || item.topic || "全部").trim() || "全部";
  }

  function itemDate(item) {
    const value = item.published_at || item.publishedAt || item.published || item.time || item.created_at;
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) {
      return new Intl.DateTimeFormat("zh-CN", {
        month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
      }).format(date);
    }
    return text(value);
  }

  function init({ root = document, invoke = global.__TAURI__?.core?.invoke } = {}) {
    const button = root.getElementById("newsnow-toolbar-btn");
    const page = root.getElementById("newsnow-page");
    const back = root.getElementById("newsnow-back");
    const refresh = root.getElementById("newsnow-refresh");
    const status = root.getElementById("newsnow-status");
    const feed = root.getElementById("newsnow-feed");
    const categories = root.getElementById("newsnow-categories");
    const updated = root.getElementById("newsnow-updated");
    const shell = root.querySelector(".content-shell");
    if (!button || !page || !back || !refresh || !status || !feed || !categories || !updated || !shell) return null;

    let allItems = [];
    let selectedCategory = "全部";
    let loading = false;

    function setStatus(message, kind = "") {
      status.textContent = text(message);
      status.className = "newsnow-status" + (kind ? " " + kind : "");
    }

    function renderCategories() {
      const list = ["全部", ...new Set(allItems.map(itemCategory).filter((name) => name !== "全部"))];
      categories.replaceChildren(...list.map((name) => {
        const tag = root.createElement("button");
        tag.type = "button";
        tag.className = "newsnow-category" + (name === selectedCategory ? " active" : "");
        tag.textContent = name;
        tag.addEventListener("click", () => {
          selectedCategory = name;
          renderCategories();
          renderFeed();
        });
        return tag;
      }));
      categories.hidden = list.length <= 1;
    }

    function openArticle(item) {
      const url = safeHttpUrl(item.url || item.link || item.href);
      if (!url) return;
      Promise.resolve(invoke && invoke("newsnow_open", { url }))
        .catch(() => invoke && invoke("open_url", { url }))
        .catch(() => setStatus("无法打开新闻原文。", "error"));
    }

    function makeCard(item) {
      const article = root.createElement("article");
      article.className = "newsnow-card";
      const url = safeHttpUrl(item.url || item.link || item.href);
      article.tabIndex = url ? 0 : -1;
      const title = root.createElement("h2");
      title.textContent = text(item.title || item.name || "未命名新闻");
      article.appendChild(title);
      const description = text(item.summary || item.description || item.content || item.excerpt).trim();
      if (description) {
        const summary = root.createElement("p");
        summary.className = "newsnow-summary";
        summary.textContent = description;
        article.appendChild(summary);
      }
      const meta = root.createElement("div");
      meta.className = "newsnow-meta";
      const source = text(item.source || item.source_name || item.site || itemCategory(item)).trim();
      if (source) {
        const sourceEl = root.createElement("span");
        sourceEl.textContent = source;
        meta.appendChild(sourceEl);
      }
      const time = itemDate(item);
      if (time) {
        const timeEl = root.createElement("time");
        timeEl.textContent = time;
        meta.appendChild(timeEl);
      }
      if (url) {
        const open = root.createElement("span");
        open.className = "newsnow-open-hint";
        open.textContent = "阅读原文 →";
        meta.appendChild(open);
        article.addEventListener("click", () => openArticle(item));
        article.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openArticle(item);
          }
        });
      }
      article.appendChild(meta);
      return article;
    }

    function renderFeed() {
      const filtered = selectedCategory === "全部" ? allItems : allItems.filter((item) => itemCategory(item) === selectedCategory);
      if (!filtered.length) {
        const empty = root.createElement("div");
        empty.className = "newsnow-empty";
        empty.textContent = allItems.length ? "这个分类暂时没有新闻。" : "暂无新闻。请稍后刷新，或在设置中连接你的 NewsNow 服务。";
        feed.replaceChildren(empty);
        return;
      }
      feed.replaceChildren(...filtered.map(makeCard));
    }

    async function load(force = false) {
      if (loading || !invoke) return;
      loading = true;
      refresh.disabled = true;
      refresh.textContent = force ? "刷新中…" : "加载中…";
      setStatus(force ? "正在刷新资讯…" : "正在加载资讯…");
      try {
        const command = force ? "newsnow_refresh" : "newsnow_list";
        const result = await withTimeout(invoke(command));
        allItems = resultItems(result);
        selectedCategory = "全部";
        renderCategories();
        renderFeed();
        const stamp = result && (result.fetched_at || result.fetchedAt || result.updated_at || result.updatedAt);
        updated.textContent = stamp ? "更新于 " + itemDate({ published_at: stamp }) : "";
        const message = text(result && result.message).trim();
        setStatus(message || (allItems.length ? "" : "没有获取到新闻。"), message && !allItems.length ? "error" : (allItems.length ? "" : "muted"));
      } catch (error) {
        allItems = [];
        renderCategories();
        renderFeed();
        setStatus(error && error.message === "资讯请求超时"
          ? "资讯请求超时，请检查网络连接后重试。"
          : "资讯加载失败，请检查网络连接后重试。", "error");
      } finally {
        loading = false;
        refresh.disabled = false;
        refresh.textContent = "刷新";
      }
    }

    function open() {
      root.getElementById("menu")?.classList.remove("show");
      root.getElementById("filter-panel")?.classList.remove("show");
      root.getElementById("account-panel")?.classList.remove("show");
      if (!root.getElementById("library-ai-page")?.hidden) global.ReaderLibraryAiEntry?.close();
      shell.hidden = true;
      page.hidden = false;
      global.document.body.classList.add("newsnow-active");
      button.setAttribute("aria-pressed", "true");
      load(false);
    }

    function close() {
      page.hidden = true;
      shell.hidden = false;
      global.document.body.classList.remove("newsnow-active");
      button.setAttribute("aria-pressed", "false");
      button.focus({ preventScroll: true });
    }

    function toggle() {
      if (page.hidden) {
        open();
      } else {
        close();
      }
    }

    button.addEventListener("click", toggle);
    back.addEventListener("click", close);
    refresh.addEventListener("click", () => load(true));
    global.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !page.hidden) close();
    });
    return { open, close, toggle, refresh: () => load(true), render: (items) => { allItems = resultItems(items); renderCategories(); renderFeed(); } };
  }

  global.ReaderNewsUI = { init, resultItems, safeHttpUrl, withTimeout };
  if (global.document) global.ReaderNewsUI.instance = init();
})(window);
