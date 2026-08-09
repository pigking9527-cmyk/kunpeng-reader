// Main-settings entry for saved booklists. It deliberately reuses the same
// native commands as the shelf booklist sheet instead of maintaining a second
// local list in Web storage.
(function (global) {
  "use strict";

  function init({ root = global.document, invoke = global.__TAURI__?.core?.invoke } = {}) {
    const $ = (id) => root?.getElementById(id);
    const modal = $("booklist-shortcuts-modal"), open = $("booklist-shortcuts-open"), close = $("booklist-shortcuts-close");
    const form = $("booklist-shortcuts-create"), name = $("booklist-shortcuts-name"), list = $("booklist-shortcuts-list"), status = $("booklist-shortcuts-status");
    if (!modal || !open || !form || !list || !invoke) return null;

    const setStatus = (message = "", error = false) => {
      status.textContent = message;
      status.classList.toggle("error", error);
    };
    const countLabel = (entry) => `${Array.isArray(entry?.bookIds) ? entry.bookIds.length : 0} 本图书`;

    function render(entries) {
      list.replaceChildren();
      if (!Array.isArray(entries) || !entries.length) {
        const empty = root.createElement("p");
        empty.className = "booklist-shortcuts-empty";
        empty.textContent = "还没有保存的书单。可先新建一个空书单，或在书库问答中生成推荐书单。";
        list.append(empty);
        return;
      }
      entries.forEach((entry) => {
        const row = root.createElement("article");
        row.className = "booklist-shortcuts-row";
        const body = root.createElement("button");
        body.type = "button";
        body.className = "booklist-shortcuts-open-list";
        const title = root.createElement("strong");
        title.textContent = entry.name || "未命名书单";
        const meta = root.createElement("span");
        meta.textContent = `${countLabel(entry)}${entry.description ? " · " + entry.description : ""}`;
        body.append(title, meta);
        body.addEventListener("click", () => {
          modal.classList.remove("show");
          global.ReaderShelfUI?.openBooklist?.(entry.name);
        });
        const remove = root.createElement("button");
        remove.type = "button";
        remove.className = "btn-plain booklist-shortcuts-delete";
        remove.textContent = "删除";
        remove.addEventListener("click", async () => {
          const confirmed = await global.AppDialog?.confirm?.(`删除“${entry.name}”及其书单成员关系？图书本身不会删除。`, {
            title: "删除书单",
            confirmLabel: "删除",
            cancelLabel: "取消",
            tone: "warning",
          }) ?? global.confirm(`删除书单“${entry.name}”？`);
          if (!confirmed) return;
          remove.disabled = true;
          try {
            const next = await invoke("delete_booklist", { id: entry.id });
            render(next);
            setStatus("已删除书单；下次同步会同步删除。", false);
          } catch (error) {
            setStatus("删除书单失败：" + String(error), true);
          } finally { remove.disabled = false; }
        });
        row.append(body, remove);
        list.append(row);
      });
    }

    async function refresh() {
      setStatus("正在读取书单…");
      try {
        const entries = await invoke("list_booklists");
        render(entries);
        setStatus("");
        return entries;
      } catch (error) {
        setStatus("读取书单失败：" + String(error), true);
        throw error;
      }
    }

    open.addEventListener("click", () => { modal.classList.add("show"); void refresh(); });
    close?.addEventListener("click", () => modal.classList.remove("show"));
    modal.addEventListener("click", (event) => { if (event.target === modal) modal.classList.remove("show"); });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = String(name.value || "").trim();
      if (!value) { name.focus(); return; }
      const button = form.querySelector("button");
      button.disabled = true;
      try {
        const entries = await invoke("create_booklist", { name: value });
        name.value = "";
        render(entries);
        setStatus("已保存快捷书单。", false);
      } catch (error) {
        setStatus("新建书单失败：" + String(error), true);
      } finally { button.disabled = false; }
    });
    return { open: () => { modal.classList.add("show"); return refresh(); }, refresh };
  }

  global.ReaderBooklistSettingsUI = { init };
})(window);
