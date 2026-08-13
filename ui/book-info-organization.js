// 图书信息中的标签与收藏书单入口，以及独立管理页。所有写入继续复用既有书架命令。
(function exposeBookInfoOrganization(global) {
  "use strict";

  function init(options = {}) {
    const root = options.root || global.document;
    const invoke = options.invoke;
    const getBooks = options.getBooks;
    const onBooksChanged = options.onBooksChanged;
    const openBooklist = options.openBooklist;
    const alertAction = options.alertAction || ((message) => global.alert(message));
    const tagEditor = root?.getElementById("book-info-tags");
    const collectionEditor = root?.getElementById("book-info-collections");
    const modal = root?.getElementById("book-organization-modal");
    const infoModal = root?.getElementById("book-info-modal");
    const tagSummary = root?.getElementById("book-info-tag-summary");
    const collectionSummary = root?.getElementById("book-info-collection-summary");
    const panels = {
      tags: root?.getElementById("book-organization-tags-panel"),
      collections: root?.getElementById("book-organization-collections-panel"),
    };
    const tabs = {
      tags: root?.getElementById("book-organization-tags-tab"),
      collections: root?.getElementById("book-organization-collections-tab"),
    };
    if (!tagEditor || !collectionEditor || !modal || !tagSummary || !collectionSummary || typeof invoke !== "function" || typeof getBooks !== "function") return null;

    let bookId = "";
    let snapshot = null;
    let busy = false;
    const cleanName = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 32);
    const nameKey = (value) => cleanName(value).toLocaleLowerCase("zh-CN");
    const kindFor = (field) => field === "tags" ? "tag" : "collection";
    const labelFor = (field) => field === "tags" ? "标签" : "收藏书单";

    function currentBook() {
      return (getBooks() || []).find((book) => String(book.id) === bookId) || snapshot;
    }

    function organizationEntries(field) {
      const entries = new Map();
      (getBooks() || []).forEach((book) => {
        (book[field] || []).forEach((raw) => {
          const name = cleanName(raw), key = nameKey(name);
          if (!key) return;
          const entry = entries.get(key) || { key, name, count: 0 };
          entry.count += 1;
          entries.set(key, entry);
        });
      });
      (snapshot?.[field] || []).forEach((raw) => {
        const name = cleanName(raw), key = nameKey(name);
        if (key && !entries.has(key)) entries.set(key, { key, name, count: 1 });
      });
      return Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    }

    function updateFromList(list) {
      if (Array.isArray(list)) onBooksChanged?.(list);
      const refreshed = currentBook();
      if (refreshed) snapshot = { ...snapshot, ...refreshed };
      render();
    }

    function renderSummary(element, values) {
      const items = (Array.isArray(values) ? values : []).map(cleanName).filter(Boolean);
      element.textContent = items.length ? items.join("、") : "未添加";
      element.title = items.join("、");
    }

    async function run(action, failureText) {
      if (busy) return;
      busy = true;
      tagEditor.classList.add("busy");
      collectionEditor.classList.add("busy");
      try {
        updateFromList(await action());
      } catch (error) {
        alertAction(failureText + "：" + error);
        render();
      } finally {
        busy = false;
        tagEditor.classList.remove("busy");
        collectionEditor.classList.remove("busy");
      }
    }

    function nextValues(field, name, checked) {
      const values = new Map((currentBook()?.[field] || []).map((value) => [nameKey(value), cleanName(value)]));
      const key = nameKey(name);
      if (checked) values.set(key, cleanName(name)); else values.delete(key);
      return Array.from(values.values());
    }

    function saveMembership(field, name, checked) {
      const book = currentBook();
      if (!book) return;
      const values = nextValues(field, name, checked);
      const tags = field === "tags" ? values : (book.tags || []);
      const collections = field === "collections" ? values : (book.collections || []);
      run(() => invoke("set_book_organization", { id: bookId, tags, collections }), "保存" + labelFor(field) + "失败");
    }

    function renameEntry(field, entry, next) {
      run(
        () => invoke("rename_book_organization", { kind: kindFor(field), name: entry.name, newName: next }),
        labelFor(field) + "改名失败",
      );
    }

    function deleteEntry(field, entry) {
      run(
        () => invoke("delete_book_organization", { kind: kindFor(field), name: entry.name }),
        "删除" + labelFor(field) + "失败",
      );
    }

    function actionButton(text, className = "") {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "book-info-org-action " + className;
      button.textContent = text;
      return button;
    }

    function showInlineRename(row, field, entry) {
      row.replaceChildren();
      row.classList.add("renaming");
      const input = root.createElement("input");
      input.className = "book-info-org-rename";
      input.type = "text";
      input.maxLength = 32;
      input.value = entry.name;
      const save = actionButton("保存", "primary");
      const cancel = actionButton("取消");
      const submit = () => {
        const next = cleanName(input.value);
        if (!next || nameKey(next) === entry.key) { render(); return; }
        renameEntry(field, entry, next);
      };
      save.addEventListener("click", submit);
      cancel.addEventListener("click", render);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); submit(); }
        if (event.key === "Escape") { event.preventDefault(); render(); }
      });
      row.append(input, save, cancel);
      input.focus();
      input.select();
    }

    function renderEditor(container, field) {
      container.replaceChildren();
      const selected = new Set((currentBook()?.[field] || []).map(nameKey));
      const entries = organizationEntries(field);
      const choices = root.createElement("div");
      choices.className = "book-info-org-choices";
      if (!entries.length) {
        const empty = root.createElement("div");
        empty.className = "book-info-org-empty";
        empty.textContent = "暂无" + labelFor(field) + "，可在下方新建。";
        choices.appendChild(empty);
      }
      entries.forEach((entry) => {
        const row = root.createElement("div");
        row.className = "book-info-org-option";
        const label = root.createElement("label");
        const checkbox = root.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = selected.has(entry.key);
        checkbox.addEventListener("change", () => saveMembership(field, entry.name, checkbox.checked));
        const name = root.createElement("span");
        name.textContent = entry.name + "（" + entry.count + "）";
        label.append(checkbox, name);
        const actions = root.createElement("span");
        actions.className = "book-info-org-option-actions";
        if (field === "collections") {
          const open = actionButton("打开");
          open.addEventListener("click", () => {
            modal.classList.remove("show");
            openBooklist?.(entry.name);
          });
          actions.appendChild(open);
        }
        const rename = actionButton("改名");
        rename.addEventListener("click", () => showInlineRename(row, field, entry));
        const remove = actionButton("删除", "danger");
        let deleteArmed = false;
        remove.addEventListener("click", () => {
          if (!deleteArmed) {
            deleteArmed = true;
            remove.textContent = "确认删除";
            remove.title = "再次点击会从所有图书中移除";
            global.setTimeout(() => {
              if (!remove.isConnected) return;
              deleteArmed = false;
              remove.textContent = "删除";
              remove.title = "";
            }, 3000);
            return;
          }
          deleteEntry(field, entry);
        });
        actions.append(rename, remove);
        row.append(label, actions);
        choices.appendChild(row);
      });
      const create = root.createElement("div");
      create.className = "book-info-org-create";
      const input = root.createElement("input");
      input.type = "text";
      input.maxLength = 32;
      input.placeholder = field === "tags" ? "新建标签" : "新建收藏书单";
      const add = actionButton("新建并加入", "primary");
      const addValue = () => {
        const name = cleanName(input.value);
        if (!name) return;
        if (selected.has(nameKey(name))) {
          alertAction("这本书已经加入“" + name + "”。");
          return;
        }
        saveMembership(field, name, true);
      };
      add.addEventListener("click", addValue);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); addValue(); }
      });
      create.append(input, add);
      container.append(choices, create);
    }

    function render() {
      if (!bookId) return;
      const book = currentBook();
      renderSummary(tagSummary, book?.tags);
      renderSummary(collectionSummary, book?.collections);
      if (modal.classList.contains("show")) {
        renderEditor(tagEditor, "tags");
        renderEditor(collectionEditor, "collections");
      }
    }

    function selectPanel(field) {
      Object.keys(panels).forEach((key) => {
        const active = key === field;
        panels[key].hidden = !active;
        tabs[key].classList.toggle("active", active);
        tabs[key].setAttribute("aria-selected", active ? "true" : "false");
      });
    }

    function openManager(field) {
      if (!bookId) return;
      selectPanel(field);
      infoModal?.classList.remove("show");
      modal.classList.add("show");
      renderEditor(tagEditor, "tags");
      renderEditor(collectionEditor, "collections");
    }

    function closeManager() {
      modal.classList.remove("show");
      if (bookId) infoModal?.classList.add("show");
    }

    function open(id, book) {
      bookId = String(id || "");
      snapshot = { ...(book || {}), id: bookId };
      render();
    }

    tabs.tags?.addEventListener("click", () => selectPanel("tags"));
    tabs.collections?.addEventListener("click", () => selectPanel("collections"));
    root.getElementById("book-organization-close")?.addEventListener("click", closeManager);
    modal.addEventListener("click", (event) => { if (event.target === modal) closeManager(); });

    return Object.freeze({ open, openManager, closeManager });
  }

  global.ReaderBookOrganizationUI = Object.freeze({ init });
})(typeof window !== "undefined" ? window : globalThis);
