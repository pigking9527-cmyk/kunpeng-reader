// Local-library RAG controller. It is initialized lazily by the main-window
// entry, so the shelf can finish its first render before this work starts.
(function (global) {
  "use strict";
  const MAX_COMPARE_BOOKS = 8;
  const MAX_QUESTION_SOURCES = 20;
  const ANSWER_FONT_SIZE_KEY = "libraryAiAnswerFontSizeV1";
  const HISTORY_SOURCES_KEY = "libraryAiHistorySourcesV1";
  const HISTORY_SOURCE_MAX_CHARS = 2400;
  const HISTORY_SOURCE_CARD_CHARS = 520;
  const HISTORY_SOURCE_POPUP_CHARS = 900;
  const DEFAULT_ANSWER_FONT_SIZE = 16;
  const MIN_ANSWER_FONT_SIZE = 14;
  const MAX_ANSWER_FONT_SIZE = 22;
  const i18n = (key, fallback) => global.ReaderAppI18n?.t?.(key) || fallback;
  const i18nFormat = (key, fallback, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), i18n(key, fallback));

  function init({ root = global.document, invoke = global.__TAURI__?.core?.invoke } = {}) {
    const $ = (id) => root?.getElementById(id);
    const page = $("library-ai-page");
    const booksEl = $("books"), stateEl = $("state"), answerEl = $("answer"), sourcesEl = $("sources"), sourceList = $("source-list"), sourcePreview = $("source-preview");
    if (!page || !booksEl || !stateEl || !answerEl || !sourcesEl || !sourceList || !sourcePreview) return null;

    const selectedBookIds = new Set();
    let books = [], useModelTags = true, mode = "question", running = false, loading = false, activeSource = null, previewPinned = false, previewHideTimer = null;
    let libraryHistory = [], historySyncEnabled = false, showingHistory = false, latestAnswer = null;
    let classificationPoll = null;
    let answerFontSize = DEFAULT_ANSWER_FONT_SIZE;
    let questionContextMenu = null;
    const organizationName = (value) => String(value || "").trim();
    const organizationKey = (value) => organizationName(value).toLocaleLowerCase("zh-CN");
    const tagsForBook = (book) => {
      const tags = Array.isArray(book.tags) ? book.tags : [];
      const modelTags = useModelTags && Array.isArray(book.modelTags) ? book.modelTags : [];
      return Array.from(new Set([...tags, ...modelTags].map(organizationName).filter(Boolean)));
    };
    const selectionLimit = () => mode === "compare" ? MAX_COMPARE_BOOKS : Infinity;
    const selectedIds = () => Array.from(selectedBookIds);

    function readAnswerFontSize() {
      try {
        const stored = Number(global.localStorage?.getItem(ANSWER_FONT_SIZE_KEY));
        return Number.isFinite(stored) ? Math.max(MIN_ANSWER_FONT_SIZE, Math.min(MAX_ANSWER_FONT_SIZE, Math.round(stored))) : DEFAULT_ANSWER_FONT_SIZE;
      } catch (_) { return DEFAULT_ANSWER_FONT_SIZE; }
    }

    function applyAnswerFontSize(save = false) {
      answerEl.style.setProperty("--library-ai-answer-font-size", `${answerFontSize}px`);
      const output = $("library-ai-font-size"), decrease = $("library-ai-font-decrease"), increase = $("library-ai-font-increase");
      if (output) output.textContent = `${answerFontSize}px`;
      if (decrease) decrease.disabled = answerFontSize <= MIN_ANSWER_FONT_SIZE;
      if (increase) increase.disabled = answerFontSize >= MAX_ANSWER_FONT_SIZE;
      if (save) try { global.localStorage?.setItem(ANSWER_FONT_SIZE_KEY, String(answerFontSize)); } catch (_) {}
    }

    function closeQuestionContextMenu() {
      questionContextMenu?.remove();
      questionContextMenu = null;
    }

    async function copyQuestionText(value) {
      if (!value) return false;
      if (global.navigator?.clipboard?.writeText) {
        try { await global.navigator.clipboard.writeText(value); return true; } catch (_) {}
      }
      const fallback = root.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("aria-hidden", "true");
      fallback.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      root.body.appendChild(fallback);
      fallback.select();
      const copied = Boolean(root.execCommand?.("copy"));
      fallback.remove();
      return copied;
    }

    function insertQuestionText(value) {
      const question = $("question");
      if (!question || !value) return;
      const start = Number(question.selectionStart || 0), end = Number(question.selectionEnd || start);
      question.setRangeText(value, start, end, "end");
      question.dispatchEvent(new Event("input", { bubbles: true }));
      question.focus({ preventScroll: true });
    }

    function showQuestionContextMenu(event) {
      event.preventDefault();
      event.stopPropagation();
      closeQuestionContextMenu();
      const question = $("question");
      const selectedText = question.value.slice(question.selectionStart || 0, question.selectionEnd || 0);
      const menu = root.createElement("div");
      menu.className = "library-ai-question-menu";
      menu.setAttribute("role", "menu");
      const addAction = (label, action, disabled = false) => {
        const button = root.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("pointerdown", (pointerEvent) => pointerEvent.preventDefault());
        button.addEventListener("click", async () => {
          closeQuestionContextMenu();
          await action();
        });
        menu.appendChild(button);
      };
      addAction(i18n("copy", "复制"), async () => {
        if (!(await copyQuestionText(selectedText))) state("无法复制所选文字。", true);
      }, !selectedText);
      addAction(i18n("cut", "剪切"), async () => {
        if (!(await copyQuestionText(selectedText))) { state("无法剪切所选文字。", true); return; }
        const start = Number(question.selectionStart || 0), end = Number(question.selectionEnd || start);
        question.setRangeText("", start, end, "start");
        question.dispatchEvent(new Event("input", { bubbles: true }));
        question.focus({ preventScroll: true });
      }, !selectedText);
      addAction(i18n("paste", "粘贴"), async () => {
        try {
          if (!global.navigator?.clipboard?.readText) throw new Error("clipboard unavailable");
          insertQuestionText(await global.navigator.clipboard.readText());
        }
        catch (_) { state("无法读取剪贴板，请确认系统已允许阅读器访问剪贴板。", true); }
      });
      const width = 136, height = 126;
      menu.style.left = `${Math.max(8, Math.min(event.clientX, (global.innerWidth || width) - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(event.clientY, (global.innerHeight || height) - height - 8))}px`;
      root.body.appendChild(menu);
      questionContextMenu = menu;
    }

    function stopClassificationPoll() {
      if (classificationPoll) global.clearInterval(classificationPoll);
      classificationPoll = null;
    }

    async function classificationCoverageHint() {
      const coverage = await invoke("library_profile_coverage_status");
      const total = Number(coverage?.totalBooks || 0);
      const incomplete = Number(coverage?.incompleteBooks || 0);
      const webPending = Number(coverage?.webPendingBooks || 0);
      const missing = Array.isArray(coverage?.missingDimensions) ? coverage.missingDimensions.slice(0, 4).join("、") : "";
      const hints = [];
      if (incomplete) hints.push(`检测到 ${incomplete}/${total} 本图书的暗标签未覆盖完整八维${missing ? `（缺少：${missing}${coverage.missingDimensions.length > 4 ? "等" : ""}）` : ""}，点击“书籍分类”可重新分类`);
      if (webPending) hints.push(`${webPending} 本尚待联网补全，点击“书籍分类”会继续处理`);
      return hints.join("；");
    }

    async function showClassificationSummary(label = "") {
      const status = $("library-ai-classify-status");
      const button = $("library-ai-classify");
      try {
        const coverage = await invoke("library_profile_coverage_status");
        const total = Number(coverage?.totalBooks || 0);
        const summary = total ? `完成：${total} 本图书的分类` : "尚未发现可分类的图书";
        const hint = await classificationCoverageHint();
        const text = [label || summary, hint].filter(Boolean).join("；");
        status.textContent = text;
        if (text) status.title = text;
        else status.removeAttribute("title");
        if (button) button.title = text || summary;
      } catch (_) {
        status.textContent = label;
        if (label) status.title = label;
        else status.removeAttribute("title");
        if (button) button.title = label || "书籍分类状态读取失败";
      }
    }

    async function refreshClassificationStatus() {
      try {
        const task = await invoke("library_profile_status");
        const active = task && ["queued", "running", "pausing"].includes(task.state);
        const button = $("library-ai-classify"), status = $("library-ai-classify-status");
        button.disabled = Boolean(active);
        if (active) {
          const progress = task.progress || {};
          // `current` already includes the canonical completed/total count
          // from the worker. Do not append the registry progress again.
          const label = task.current || `正在分类（${Number(progress.done || 0)}/${Number(progress.total || 0)}）`;
          status.textContent = label;
          status.title = label;
          button.title = label;
          if (!classificationPoll) classificationPoll = global.setInterval(refreshClassificationStatus, 900);
          return;
        }
        if (task?.state === "paused") {
          const label = task.current || "书籍分类已中断";
          const resumeLabel = `${label}；点击“书籍分类”从已保存的位置继续`;
          status.textContent = resumeLabel;
          status.title = resumeLabel;
          button.title = resumeLabel;
          stopClassificationPoll();
          return;
        }
        if (task?.state === "completed" || task?.state === "failed" || task?.state === "cancelled") {
          const label = task.current || task.error || (task.state === "completed" ? "书籍分类完成" : "书籍分类已停止");
          await showClassificationSummary(label);
          stopClassificationPoll();
        } else {
          await showClassificationSummary();
        }
      } catch (error) {
        $("library-ai-classify-status").textContent = "分类状态读取失败";
        const button = $("library-ai-classify");
        if (button) button.title = "分类状态读取失败";
        stopClassificationPoll();
      }
    }

    function state(message, error) {
      stateEl.textContent = message;
      stateEl.className = "library-ai-state" + (error ? " error" : "");
    }

    function renderModelProfiles(status) {
      const select = $("library-ai-model-profile");
      if (!select) return;
      const profiles = Array.isArray(status?.profiles) ? status.profiles.filter((profile) => profile.configured) : [];
      select.replaceChildren();
      if (!profiles.length) {
        const option = root.createElement("option");
        option.value = "";
        option.textContent = "请先在设置中配置大模型";
        select.appendChild(option);
        select.disabled = true;
        return;
      }
      profiles.forEach((profile) => {
        const option = root.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name || profile.model || "已配置大模型";
        select.appendChild(option);
      });
      select.value = profiles.some((profile) => profile.id === status?.activeId) ? status.activeId : profiles[0].id;
      select.disabled = false;
    }

    function organizationEntries(field) {
      const entries = new Map();
      books.forEach((book) => (field === "tags" ? tagsForBook(book) : (book[field] || [])).forEach((rawName) => {
        const name = organizationName(rawName), key = organizationKey(name);
        if (!key) return;
        const entry = entries.get(key) || { name, key, count: 0 };
        entry.count += 1;
        entries.set(key, entry);
      }));
      return Array.from(entries.values()).sort((left, right) => left.name.localeCompare(right.name, "zh"));
    }

    function renderFilterOptions(element, field, allLabel) {
      const previous = element.value;
      element.replaceChildren();
      const all = root.createElement("option");
      all.value = "";
      all.textContent = allLabel;
      element.append(all);
      organizationEntries(field).forEach((entry) => {
        const option = root.createElement("option");
        option.value = entry.key;
        option.textContent = `${entry.name}（${entry.count}）`;
        element.append(option);
      });
      element.value = Array.from(element.options).some((option) => option.value === previous) ? previous : "";
    }

    function currentBooks() {
      const tag = $("tag-filter").value, collection = $("collection-filter").value;
      const query = String($("library-ai-book-search")?.value || "").trim().toLocaleLowerCase();
      return books.filter((book) => {
        const tags = new Set(tagsForBook(book).map(organizationKey));
        const collections = new Set((book.collections || []).map(organizationKey));
        const searchText = [book.title, book.author, book.description, book.summary, ...tagsForBook(book)].filter(Boolean).join(" ").toLocaleLowerCase();
        return (!tag || tags.has(tag)) && (!collection || collections.has(collection)) && (!query || searchText.includes(query));
      });
    }

    function updateScopeStatus(visibleBooks) {
      const selected = selectedBookIds.size;
      const visibleSelected = visibleBooks.filter((book) => selectedBookIds.has(String(book.id))).length;
      if (mode === "question") {
        const visible = visibleSelected < selected ? i18nFormat("scopeVisible", " ({count} currently shown)", { count: visibleSelected }) : "";
        $("scope-summary").textContent = selected
          ? i18nFormat("questionScopeSelected", "Current scope: {selected} selected book(s){visible}", { selected, visible })
          : i18nFormat("questionScopeAll", "Current scope: Entire library (all indexed books; top {limit} matches)", { limit: MAX_QUESTION_SOURCES });
        $("clear-selection").textContent = i18n("cancelLimit", "取消限定");
        $("selection-tools").hidden = false;
        $("select-visible").disabled = !visibleBooks.length || visibleSelected === visibleBooks.length;
        $("invert-visible").disabled = !visibleBooks.length;
      } else {
        const visible = visibleSelected < selected ? i18nFormat("scopeVisible", " ({count} currently shown)", { count: visibleSelected }) : "";
        $("scope-summary").textContent = i18nFormat("compareScope", "Comparison scope: {selected}/{limit} book(s){visible}", { selected, limit: MAX_COMPARE_BOOKS, visible });
        $("clear-selection").textContent = i18n("clearSelection", "清空选择");
        $("selection-tools").hidden = true;
      }
      $("clear-selection").disabled = selected === 0;
    }

    function syncBookSelectionControls(visibleBooks) {
      const limit = selectionLimit();
      const atLimit = Number.isFinite(limit) && selectedBookIds.size >= limit;
      booksEl.querySelectorAll("input[type=checkbox]").forEach((box) => {
        const checked = selectedBookIds.has(box.value);
        box.checked = checked;
        box.disabled = atLimit && !checked;
        box.closest(".library-ai-book")?.classList.toggle("unavailable", box.disabled);
      });
      updateScopeStatus(visibleBooks);
    }

    function renderBooks() {
      const visibleBooks = currentBooks();
      $("book-count").textContent = visibleBooks.length === books.length
        ? i18nFormat("bookCountAll", "{count} books on shelf", { count: books.length })
        : i18nFormat("bookCountFiltered", "Showing {visible} of {total} books", { visible: visibleBooks.length, total: books.length });
      $("clear-filters").disabled = !$("tag-filter").value && !$("collection-filter").value;
      booksEl.replaceChildren();
      if (!books.length) {
        booksEl.innerHTML = '<div class="library-ai-empty-books">' + i18n("noBooks", "书架中还没有图书。") + "</div>";
        updateScopeStatus(visibleBooks);
        return;
      }
      if (!visibleBooks.length) {
        const query = String($("library-ai-book-search")?.value || "").trim();
        booksEl.innerHTML = '<div class="library-ai-empty-books">' + (query ? i18n("noBookSearchMatches", "No books match the title, author, description, or tags.") : i18n("noFilteredBooks", "No books match the current tags and collections.")) + "</div>";
        updateScopeStatus(visibleBooks);
        return;
      }
      visibleBooks.forEach((book) => {
        const id = String(book.id);
        const label = root.createElement("label");
        label.className = "library-ai-book";
        const box = root.createElement("input");
        box.type = "checkbox";
        box.value = id;
        box.checked = selectedBookIds.has(id);
        box.addEventListener("change", () => {
          if (box.checked) {
            const limit = selectionLimit();
            if (Number.isFinite(limit) && selectedBookIds.size >= limit) {
              box.checked = false;
              state(i18nFormat("selectionLimitMessage", "{mode} supports up to {limit} books.", { mode: i18n(mode === "compare" ? "crossBookCompare" : "libraryQuestion", mode), limit: selectionLimit() }), true);
              return;
            }
            selectedBookIds.add(id);
          } else {
            selectedBookIds.delete(id);
          }
          syncBookSelectionControls(visibleBooks);
        });
        const text = root.createElement("span");
        const title = root.createElement("span");
        title.className = "library-ai-book-name";
        title.textContent = book.title || i18n("unnamedBook", "Untitled book");
        const author = root.createElement("span");
        author.className = "library-ai-book-author";
        author.textContent = book.author || i18n("unknownAuthor", "Unknown author");
        text.append(title, author);
        label.append(box, text);
        booksEl.append(label);
      });
      syncBookSelectionControls(visibleBooks);
    }

    function selectVisibleBooks() {
      if (mode !== "question") return;
      currentBooks().forEach((book) => selectedBookIds.add(String(book.id)));
      renderBooks();
    }

    function invertVisibleBooks() {
      if (mode !== "question") return;
      currentBooks().forEach((book) => {
        const id = String(book.id);
        if (selectedBookIds.has(id)) selectedBookIds.delete(id);
        else selectedBookIds.add(id);
      });
      renderBooks();
    }

    function setMode(next) {
      mode = next;
      if (mode === "compare" && selectedBookIds.size > MAX_COMPARE_BOOKS) {
        const kept = selectedIds().slice(0, MAX_COMPARE_BOOKS);
        selectedBookIds.clear();
        kept.forEach((id) => selectedBookIds.add(id));
        state(`跨书对比最多选择 ${MAX_COMPARE_BOOKS} 本，已保留前 ${MAX_COMPARE_BOOKS} 本。`, true);
      }
      $("mode-question").classList.toggle("active", mode === "question");
      $("mode-compare").classList.toggle("active", mode === "compare");
      $("question").placeholder = mode === "compare"
        ? "比较选中作品对同一主题的观点、分歧与依据。"
        : "例如：这些书如何解释清末财政困境？";
      renderBooks();
    }

    function sourceLabel(source, index) {
      const kind = source.sourceKind ? ` · ${source.sourceKind}` : "";
      return `《${source.bookTitle || "未命名图书"}》· 第 ${Number(source.chapter || 0) + 1} 章${kind} · 来源 ${index + 1}`;
    }

    async function openSource(source) {
      if (source?.unavailable) {
        state(source.unavailableReason || "原书未加入本机书架，无法跳转引用正文。", true);
        return;
      }
      try {
        await invoke("open_book_at", { request: { id: String(source.bookId), chapter: Number(source.chapter || 0), term: "" } });
      } catch (error) {
        state("无法跳转原文：" + String(error), true);
      }
    }

    function hideSourcePreview(force = false) {
      if (previewPinned && !force) return;
      clearTimeout(previewHideTimer);
      previewHideTimer = null;
      previewPinned = false;
      activeSource = null;
      sourcePreview.hidden = true;
    }

    function scheduleSourcePreviewHide() {
      clearTimeout(previewHideTimer);
      previewHideTimer = setTimeout(() => hideSourcePreview(), 180);
    }

    function positionSourcePreview(anchor) {
      const view = global.window || global;
      const width = Math.min(560, Math.max(360, (view.innerWidth || 760) - 28));
      const height = Math.min(340, Math.max(190, (view.innerHeight || 600) - 28));
      const rect = anchor?.getBoundingClientRect?.();
      const left = rect
        ? Math.max(14, Math.min(rect.left + (rect.width / 2) - (width / 2), (view.innerWidth || width) - width - 14))
        : Math.max(14, ((view.innerWidth || width) - width) / 2);
      const below = rect ? rect.bottom + 10 : 80;
      const top = Math.max(14, Math.min(below, (view.innerHeight || height) - height - 14));
      sourcePreview.style.width = `${width}px`;
      sourcePreview.style.maxHeight = `${height}px`;
      sourcePreview.style.left = `${left}px`;
      sourcePreview.style.top = `${top}px`;
    }

    function showSourcePreview(source, index, pin = false, anchor) {
      clearTimeout(previewHideTimer);
      previewHideTimer = null;
      activeSource = source;
      previewPinned = pin;
      $("source-preview-title").textContent = sourceLabel(source, index);
      $("source-preview-excerpt").textContent = displaySourceExcerpt(source.excerpt, HISTORY_SOURCE_POPUP_CHARS);
      positionSourcePreview(anchor);
      sourcePreview.hidden = false;
    }

    function displaySourceExcerpt(value, limit) {
      const text = String(value || "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) return "没有可显示的原文片段。";
      return text.length > limit ? `${text.slice(0, limit)}…\n\n（原文预览已截断；可点击打开原文查看完整章节。）` : text;
    }

    function appendAnswerInline(parent, text, sources) {
      const token = /\[来源\s*(\d+)\]|\*\*([^*\n]+)\*\*/g;
      let cursor = 0, match;
      while ((match = token.exec(text))) {
        parent.append(root.createTextNode(text.slice(cursor, match.index)));
        if (match[2] !== undefined) {
          const strong = root.createElement("strong");
          appendAnswerInline(strong, match[2], sources);
          parent.append(strong);
        } else {
          const index = Number(match[1]) - 1;
          const source = sources[index];
          if (!source) {
            parent.append(root.createTextNode(match[0]));
          } else {
            const footnote = root.createElement("button");
            footnote.type = "button";
            footnote.className = "library-ai-footnote";
            footnote.textContent = `[${index + 1}]`;
            footnote.setAttribute("aria-label", `查看${sourceLabel(source, index)}的脚注原文`);
            footnote.addEventListener("pointerenter", (event) => showSourcePreview(source, index, false, event.currentTarget));
            footnote.addEventListener("pointerleave", scheduleSourcePreviewHide);
            footnote.addEventListener("focus", (event) => showSourcePreview(source, index, false, event.currentTarget));
            footnote.addEventListener("blur", scheduleSourcePreviewHide);
            footnote.addEventListener("click", () => {
              if (activeSource === source && previewPinned) hideSourcePreview(true);
              else showSourcePreview(source, index, true, footnote);
            });
            parent.append(footnote);
          }
        }
        cursor = token.lastIndex;
      }
      parent.append(root.createTextNode(text.slice(cursor)));
    }

    function renderAnswer(content, sources, { hideDirectAnswerHeading = false } = {}) {
      answerEl.replaceChildren();
      const byNumber = Array.isArray(sources) ? sources : [];
      const lines = String(content || "没有得到可显示的回答。").replace(/\r/g, "").split("\n");
      let list = null, listKind = "";
      const closeList = () => { list = null; listKind = ""; };
      const appendListItem = (kind, text) => {
        if (!list || listKind !== kind) {
          list = root.createElement(kind);
          list.className = "library-ai-answer-list";
          listKind = kind;
          answerEl.append(list);
        }
        const item = root.createElement("li");
        appendAnswerInline(item, text, byNumber);
        list.append(item);
      };
      lines.forEach((raw) => {
        const line = raw.trim();
        if (!line) {
          closeList();
          return;
        }
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          closeList();
          if (hideDirectAnswerHeading && heading[2].trim() === "直接回答") return;
          const element = root.createElement(heading[1].length === 1 ? "h3" : "h4");
          appendAnswerInline(element, heading[2], byNumber);
          answerEl.append(element);
          return;
        }
        if (/^(---|\*\*\*|___)$/.test(line)) {
          closeList();
          answerEl.append(root.createElement("hr"));
          return;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          appendListItem("ul", bullet[1]);
          return;
        }
        const ordered = line.match(/^\d+[.)]\s+(.+)$/);
        if (ordered) {
          appendListItem("ol", ordered[1]);
          return;
        }
        closeList();
        const paragraph = root.createElement("p");
        appendAnswerInline(paragraph, line, byNumber);
        answerEl.append(paragraph);
      });
    }

    function renderSources(sources) {
      sourceList.replaceChildren();
      hideSourcePreview(true);
      if (!Array.isArray(sources) || !sources.length) {
        sourcesEl.hidden = true;
        return;
      }
      const oneBook = mode === "question" && new Set(sources.map((source) => String(source.bookId))).size === 1;
      $("source-title").textContent = mode === "question"
        ? (oneBook
          ? `单书深度依据（${sources.length} 段；回答仅引用经筛选的脚注）`
          : `检索候选（前 ${sources.length} 本 · 每本 1 段；回答仅引用经筛选的脚注）`)
        : `脚注来源（对比依据 ${sources.length} 段）`;
      sources.forEach((source, index) => {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "library-ai-source";
        const title = root.createElement("span");
        title.className = "library-ai-source-title";
        title.textContent = `[${index + 1}] ${sourceLabel(source, index)}`;
        const excerpt = root.createElement("span");
        excerpt.className = "library-ai-source-excerpt";
        excerpt.textContent = displaySourceExcerpt(source.excerpt, HISTORY_SOURCE_CARD_CHARS);
        button.append(title, excerpt);
        button.addEventListener("click", (event) => showSourcePreview(source, index, true, event.currentTarget));
        sourceList.append(button);
      });
      sourcesEl.hidden = false;
    }

    function libraryHistoryTaskLabel(task) {
      return task === "compare" ? "跨书对比" : "书库问答";
    }

    function portableSourceReference(source) {
      return {
        bookTitle: String(source?.bookTitle || "未命名图书").slice(0, 800),
        chapter: Number(source?.chapter || 0),
        sourceKind: String(source?.sourceKind || "正文检索").slice(0, 120),
      };
    }

    function libraryHistoryIdentity(entry) {
      return String(entry?.id || [entry?.at || "", entry?.task || "", entry?.question || "", String(entry?.content || "").slice(0, 160)].join("\u001f"));
    }

    function historyEntryId(entry) {
      return String(entry?.id || `legacy:${entry?.at || "unknown"}`);
    }

    function newHistoryEntryId() {
      const suffix = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return `library:${new Date().toISOString()}:${suffix}`;
    }

    function historyEntryIsDeleted(entry) {
      return Boolean(entry?.deletedAt || entry?.deleted_at);
    }

    function sourceTitleKey(value) {
      return String(value || "")
        .replace(/[《》〈〉“”‘’「」『』"]/g, "")
        .replace(/\s+/g, "")
        .trim()
        .toLocaleLowerCase("zh-CN");
    }

    function readLocalHistorySources() {
      try {
        const saved = JSON.parse(global.localStorage?.getItem(HISTORY_SOURCES_KEY) || "{}");
        return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
      } catch (_) { return {}; }
    }

    function writeLocalHistorySources(entry, sources) {
      try {
        const cache = readLocalHistorySources();
        cache[libraryHistoryIdentity(entry)] = {
          savedAt: entry.at || new Date().toISOString(),
          sources: sources.map((source) => ({
            bookId: String(source?.bookId || ""),
            bookTitle: String(source?.bookTitle || "未命名图书").slice(0, 800),
            chapter: Number(source?.chapter || 0),
            sourceKind: String(source?.sourceKind || "正文检索").slice(0, 120),
            excerpt: String(source?.excerpt || "").slice(0, HISTORY_SOURCE_MAX_CHARS),
          })),
        };
        const keys = Object.keys(cache).sort((left, right) => String(cache[right]?.savedAt || "").localeCompare(String(cache[left]?.savedAt || "")));
        keys.slice(30).forEach((key) => delete cache[key]);
        global.localStorage?.setItem(HISTORY_SOURCES_KEY, JSON.stringify(cache));
      } catch (_) { /* 本机正文缓存不可用时，仍保留可同步的来源索引。 */ }
    }

    function deleteLocalHistorySources(entry) {
      try {
        const cache = readLocalHistorySources();
        delete cache[libraryHistoryIdentity(entry)];
        global.localStorage?.setItem(HISTORY_SOURCES_KEY, JSON.stringify(cache));
      } catch (_) { /* 删除云端记录不应受本机缓存失败影响。 */ }
    }

    function hydrateLibraryHistory(entries) {
      const cache = readLocalHistorySources();
      return (Array.isArray(entries) ? entries : []).filter((entry) => !historyEntryIsDeleted(entry)).map((entry) => {
        const saved = cache[libraryHistoryIdentity(entry)];
        const portable = Array.isArray(entry?.sources) ? entry.sources : [];
        const recovered = Array.isArray(saved?.sources) ? saved.sources : [];
        const sameReference = portable.length === recovered.length && portable.every((source, index) => {
          const candidate = recovered[index];
          return sourceTitleKey(source?.bookTitle) === sourceTitleKey(candidate?.bookTitle)
            && Number(source?.chapter || 0) === Number(candidate?.chapter || 0);
        });
        return sameReference && recovered.length ? { ...entry, sources: recovered } : entry;
      });
    }

    function historySourcesForDisplay(entry) {
      const titleKey = (value) => String(value || "")
        .replace(/[《》〈〉“”‘’「」『』"']/g, "")
        .replace(/\s+/g, "")
        .trim()
        .toLocaleLowerCase("zh-CN");
      return (Array.isArray(entry?.sources) ? entry.sources : []).map((source) => {
        const bookId = String(source?.bookId || "");
        const sourceTitle = titleKey(source?.bookTitle);
        const matchedBook = books.find((book) => sourceTitle && titleKey(book.title) === sourceTitle)
          || books.find((book) => String(book.contentId || book.content_id || "") === bookId)
          || (!sourceTitle ? books.find((book) => String(book.id) === bookId) : null);
        if (matchedBook && String(source?.excerpt || "").trim()) {
          // Earlier builds stored a source id from a different local import.
          // Resolve it back to the current shelf entry by stable content id or
          // title so a moved/re-imported book is not falsely reported missing.
          return { ...source, bookId: String(matchedBook.id) };
        }
        if (matchedBook) {
          // Entries created by older releases contain a portable reference
          // only.  Recover a readable local chapter once, then persist that
          // text in this device's private history cache (never in sync).
          return {
            ...source,
            bookId: String(matchedBook.id),
            recoveryNeeded: true,
            excerpt: "正在从本机书架恢复该章节正文…",
          };
        }
        return {
          ...source,
          unavailable: true,
          unavailableReason: "原书未加入本机书架或已从本机书架移除，无法显示或跳转引用正文。",
          excerpt: "原书未加入本机书架或已从本机书架移除，引用正文不可用。",
        };
      });
    }

    async function recoverLegacyHistorySources(entry, sources) {
      const recovered = await Promise.all(sources.map(async (source) => {
        if (!source?.recoveryNeeded) return source;
        try {
          const preview = await invoke("library_history_source_preview", {
            request: {
              bookId: String(source.bookId || ""),
              bookTitle: String(source.bookTitle || ""),
              chapter: Number(source.chapter || 0),
              sourceKind: String(source.sourceKind || "正文检索"),
            },
          });
          return { ...preview, recoveredFromLegacyHistory: true };
        } catch (error) {
          return {
            ...source,
            recoveryNeeded: false,
            unavailable: true,
            unavailableReason: `无法恢复旧记录的引用正文：${String(error)}`,
            excerpt: "原书仍在书架，但无法读取当时引用的章节正文。",
          };
        }
      }));
      writeLocalHistorySources(entry, recovered);
      return recovered;
    }

    function renderLibraryHistory() {
      showingHistory = true;
      latestAnswer = latestAnswer || null;
      $("library-ai-history").classList.add("active");
      $("library-ai-history").textContent = i18n("returnToAnswer", "返回本次回答");
      answerEl.className = "library-ai-answer";
      answerEl.replaceChildren();
      const note = root.createElement("p");
      note.className = "library-ai-history-note";
      note.textContent = historySyncEnabled
        ? "本机历史保留引用正文；记录会在下次同步时上传。为保护书籍内容，跨设备仅同步来源书名、章节与材料类型。"
        : "记录已保存在本机。开启设置中的“同步智读历史”后，会在下次同步时上传。";
      answerEl.append(note);
      const list = root.createElement("div");
      list.className = "library-ai-history-list";
      libraryHistory.forEach((entry) => {
        const row = root.createElement("div");
        row.className = "library-ai-history-row";
        const button = root.createElement("button");
        button.type = "button";
        button.className = "library-ai-history-item";
        const question = root.createElement("span");
        question.className = "library-ai-history-question";
        question.textContent = entry.question || i18n("unnamedQuestion", "未命名问答");
        const meta = root.createElement("span");
        meta.className = "library-ai-history-meta";
        const at = entry.at ? new Date(entry.at).toLocaleString() : "历史记录";
        const sourceCount = Array.isArray(entry.sources) ? entry.sources.length : 0;
        meta.textContent = `${libraryHistoryTaskLabel(entry.task)} · ${at} · ${sourceCount} 条来源索引`;
        button.append(question, meta);
        button.addEventListener("click", () => showLibraryHistoryEntry(entry));
        const remove = root.createElement("button");
        remove.type = "button";
        remove.className = "library-ai-history-delete";
        remove.textContent = i18n("delete", "删除");
        remove.setAttribute("aria-label", `删除书库问答记录：${question.textContent}`);
        remove.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (global.confirm && !global.confirm("删除这条书库问答记录？删除后会同步到其他设备。")) return;
          try {
            const snapshot = await invoke("private_sync_library_history_delete", { request: { id: historyEntryId(entry) } });
            deleteLocalHistorySources(entry);
            libraryHistory = hydrateLibraryHistory(snapshot?.entries);
            historySyncEnabled = Boolean(snapshot?.syncEnabled);
            renderLibraryHistory();
            state("已删除书库问答记录；删除会在下次同步时传到其他设备。", false);
          } catch (error) {
            state("删除书库问答记录失败：" + String(error), true);
          }
        });
        row.append(button, remove);
        list.append(row);
      });
      if (!libraryHistory.length) {
        const empty = root.createElement("p");
        empty.className = "library-ai-history-note";
        empty.textContent = i18n("noQuestionHistory", "还没有保存的书库问答。完成一次问答后会自动保存到这里。");
        answerEl.append(empty);
      } else {
        answerEl.append(list);
      }
      renderSources([]);
      state("问答记录已载入。", false);
    }

    async function showLibraryHistoryEntry(entry) {
      showingHistory = false;
      $("library-ai-history").classList.remove("active");
      $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
      answerEl.className = "library-ai-answer";
      let sources = historySourcesForDisplay(entry);
      renderAnswer(entry.content, sources, { hideDirectAnswerHeading: true });
      renderSources(sources);
      const needsRecovery = sources.some((source) => source?.recoveryNeeded);
      state(needsRecovery
        ? "正在从本机书架恢复旧记录的章节正文…"
        : `已打开保存的${libraryHistoryTaskLabel(entry.task)}记录。`, false);
      if (!needsRecovery) return;
      sources = await recoverLegacyHistorySources(entry, sources);
      renderAnswer(entry.content, sources, { hideDirectAnswerHeading: true });
      renderSources(sources);
      state("已从本机书架恢复旧记录的章节正文；原记录未保存的精确片段不会进入同步。", false);
    }

    async function refreshLibraryHistory() {
      const snapshot = await invoke("private_sync_library_history_list");
      libraryHistory = hydrateLibraryHistory(snapshot?.entries);
      historySyncEnabled = Boolean(snapshot?.syncEnabled);
      return libraryHistory;
    }

    async function saveLibraryHistory(question, answer) {
      const entry = {
        id: newHistoryEntryId(),
        version: 1,
        scope: "library",
        task: mode,
        question,
        content: answer.content || "",
        sources: Array.isArray(answer.sources) ? answer.sources.map(portableSourceReference) : [],
        at: new Date().toISOString(),
      };
      writeLocalHistorySources(entry, Array.isArray(answer.sources) ? answer.sources : []);
      const snapshot = await invoke("private_sync_library_history_merge", { request: { entries: [entry] } });
      libraryHistory = hydrateLibraryHistory(snapshot?.entries || libraryHistory);
      historySyncEnabled = Boolean(snapshot?.syncEnabled);
    }

    async function toggleLibraryHistory() {
      if (showingHistory) {
        showingHistory = false;
        $("library-ai-history").classList.remove("active");
        $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
        if (latestAnswer) {
          answerEl.className = "library-ai-answer";
          renderAnswer(latestAnswer.content, latestAnswer.sources);
          renderSources(latestAnswer.sources);
          state("已返回本次回答。", false);
        } else {
          answerEl.className = "library-ai-answer empty";
          answerEl.textContent = i18n("answerPlaceholder", "选择范围并输入问题后开始。若没有结果，请先在主窗口的设置中建立语义索引。");
          renderSources([]);
        }
        return;
      }
      try {
        await refreshLibraryHistory();
        renderLibraryHistory();
      } catch (error) {
        state("读取问答记录失败：" + String(error), true);
      }
    }

    async function run() {
      if (running) return;
      const question = $("question").value.trim(), selectedBookIdsForRequest = selectedIds();
      if (!question) {
        state(i18n("enterQuestion", "请输入问题。"), true);
        $("question").focus();
        return;
      }
      if (mode === "compare" && selectedBookIdsForRequest.length < 2) {
        state("跨书对比至少选择两本图书。", true);
        return;
      }
      running = true;
      $("run").disabled = true;
      $("run").textContent = i18n("askInProgress", "检索并问答中…");
      const explicitBookTitle = /《[^》]+》/.test(question);
      state(mode === "question" && !selectedBookIdsForRequest.length
        ? (explicitBookTitle
          ? "正在识别题中书名；唯一匹配时将使用单书深度问答…"
          : "正在检索全部书库，并筛选可支撑回答的文本证据…")
        : mode === "question" && selectedBookIdsForRequest.length === 1
          ? "正在对所选图书进行书内多轮检索、证据筛选与自检…"
          : "正在检索所选图书的本地语义索引…");
      answerEl.className = "library-ai-answer empty";
      answerEl.textContent = "正在整理引用片段并向你的智读服务提问…";
      renderSources([]);
      try {
        const answer = await invoke("ask_library_assistant", { request: { task: mode, question, selectedBookIds: selectedBookIdsForRequest } });
        showingHistory = false;
        $("library-ai-history").classList.remove("active");
        $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
        latestAnswer = answer;
        answerEl.className = "library-ai-answer";
        renderAnswer(answer.content, answer.sources);
        renderSources(answer.sources);
        const singleBookTitle = answer.sources?.[0]?.bookTitle;
        let saveNote = "问答已保存到本机。";
        try {
          await saveLibraryHistory(question, answer);
          saveNote = historySyncEnabled ? "问答已保存；将在下次同步时上传。" : "问答已保存到本机；开启“同步智读历史”后会同步。";
        } catch (_) {
          saveNote = "回答完成，但问答记录保存失败。";
        }
        state(answer.singleBook
          ? `完成。已按《${singleBookTitle || "所选图书"}》执行单书深度问答；${saveNote}`
          : `完成。回答仅依据下方列出的本地检索片段；${saveNote}`);
      } catch (error) {
        answerEl.className = "library-ai-answer empty";
        answerEl.textContent = i18n("libraryQuestionFailed", "书库问答失败。");
        state(String(error), true);
      } finally {
        running = false;
        $("run").disabled = false;
        $("run").textContent = i18n("startQuestion", "开始问答");
      }
    }

    async function load() {
      if (loading) return;
      loading = true;
      state(i18n("loadingLibrary", "正在读取书架与智读配置…"));
      try {
        const [status, profiles, list, modelTagSettings, history] = await Promise.all([
          invoke("ai_reader_status"),
          invoke("ai_reader_profiles"),
          invoke("list_books"),
          invoke("library_model_tags_settings"),
          invoke("private_sync_library_history_list"),
        ]);
        libraryHistory = hydrateLibraryHistory(history?.entries);
        historySyncEnabled = Boolean(history?.syncEnabled);
        renderModelProfiles(profiles);
        useModelTags = modelTagSettings?.enabled !== false;
        books = Array.isArray(list) ? list.filter((book) => !book.missing) : [];
        const knownIds = new Set(books.map((book) => String(book.id)));
        Array.from(selectedBookIds).forEach((id) => { if (!knownIds.has(id)) selectedBookIds.delete(id); });
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderFilterOptions($("collection-filter"), "collections", i18n("allCollections", "全部收藏夹"));
        renderBooks();
        state(status?.configured ? "智读已配置。建立语义索引后即可检索。" : "请先在任意阅读页的“智读”中配置 API、模型和密钥。", !status?.configured);
        refreshClassificationStatus();
      } catch (error) {
        state("无法读取书架或智读配置：" + String(error), true);
      } finally {
        loading = false;
      }
    }

    $("mode-question").addEventListener("click", () => setMode("question"));
    $("mode-compare").addEventListener("click", () => setMode("compare"));
    $("tag-filter").addEventListener("change", renderBooks);
    $("collection-filter").addEventListener("change", renderBooks);
    $("library-ai-book-search").addEventListener("input", renderBooks);
    $("clear-filters").addEventListener("click", () => {
      $("tag-filter").value = "";
      $("collection-filter").value = "";
      renderBooks();
    });
    $("clear-selection").addEventListener("click", () => {
      selectedBookIds.clear();
      renderBooks();
    });
    $("select-visible").addEventListener("click", selectVisibleBooks);
    $("invert-visible").addEventListener("click", invertVisibleBooks);
    $("library-ai-classify").addEventListener("click", async () => {
      try {
        $("library-ai-classify").disabled = true;
        $("library-ai-classify-status").textContent = "正在建立分类任务…";
        await invoke("start_library_auto_classification");
        await refreshClassificationStatus();
      } catch (error) {
        $("library-ai-classify").disabled = false;
        $("library-ai-classify-status").textContent = String(error);
      }
    });
    $("library-ai-history").addEventListener("click", toggleLibraryHistory);
    answerFontSize = readAnswerFontSize();
    applyAnswerFontSize();
    $("library-ai-font-decrease")?.addEventListener("click", () => {
      answerFontSize = Math.max(MIN_ANSWER_FONT_SIZE, answerFontSize - 1);
      applyAnswerFontSize(true);
    });
    $("library-ai-font-increase")?.addEventListener("click", () => {
      answerFontSize = Math.min(MAX_ANSWER_FONT_SIZE, answerFontSize + 1);
      applyAnswerFontSize(true);
    });
    $("library-ai-model-profile")?.addEventListener("change", async (event) => {
      const id = event.currentTarget.value;
      if (!id) return;
      event.currentTarget.disabled = true;
      try {
        const status = await invoke("select_ai_reader_profile", { id });
        state(status?.configured ? "已切换本次问答使用的大模型。" : "所选大模型配置不完整。", !status?.configured);
      } catch (error) {
        state("切换大模型失败：" + String(error), true);
      } finally { event.currentTarget.disabled = false; }
    });
    $("source-preview-close").addEventListener("click", () => hideSourcePreview(true));
    $("source-preview-open").addEventListener("click", () => { if (activeSource) openSource(activeSource); });
    sourcePreview.addEventListener("pointerenter", () => clearTimeout(previewHideTimer));
    sourcePreview.addEventListener("pointerleave", scheduleSourcePreviewHide);
    $("run").addEventListener("click", run);
    $("question").addEventListener("contextmenu", showQuestionContextMenu);
    $("question").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void run();
      }
    });
    global.addEventListener("library-model-tags-setting-changed", (event) => {
      useModelTags = event?.detail?.enabled !== false;
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderBooks();
    });
    global.addEventListener("ai-reader-profiles-changed", () => {
      invoke("ai_reader_profiles").then(renderModelProfiles).catch(() => {});
    });
    global.addEventListener("app-language-changed", () => {
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderFilterOptions($("collection-filter"), "collections", i18n("allCollections", "全部收藏夹"));
      renderBooks();
      if (showingHistory) renderLibraryHistory();
      else if (!latestAnswer && !running) answerEl.textContent = i18n("answerPlaceholder", "选择范围并输入问题后开始。若没有结果，请先在主窗口的设置中建立语义索引。");
    });
    global.addEventListener("pointerdown", (event) => {
      if (questionContextMenu && !questionContextMenu.contains(event.target)) closeQuestionContextMenu();
    }, true);
    global.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeQuestionContextMenu();
    });
    return { load, run, setMode, renderBooks };
  }

  global.ReaderLibraryAiUI = { init, MAX_QUESTION_SOURCES, MAX_COMPARE_BOOKS };
})(window);
