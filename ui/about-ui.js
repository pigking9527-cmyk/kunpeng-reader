(function initAboutUi(global) {
  "use strict";

  let activeController = null;

  function init({ root = document, invoke, storage = global.localStorage, menuElement, alertAction = global.alert } = {}) {
    if (activeController) return activeController;
    const modal = root.getElementById("about-modal");
    const updateBar = root.getElementById("update-bar");
    const updateButton = root.getElementById("about-update");
    const notesElement = root.getElementById("about-notes");
    let pendingRelease = null;

    function text(key, fallback, values = {}) {
      let value = global.ReaderAppI18n?.t?.(key) || fallback || key;
      for (const [name, replacement] of Object.entries(values)) {
        value = value.replaceAll(`{${name}}`, String(replacement));
      }
      return value;
    }

    function setUpdateState(key = "checkUpdates") {
      updateButton.dataset.i18nState = key;
      updateButton.textContent = text(key);
    }

    function setNotesState(key) {
      notesElement.dataset.i18nState = key || "";
      if (key) notesElement.textContent = text(key);
    }

    function compareVersions(left, right) {
      const a = String(left).replace(/^v/i, "").split(".").map((value) => parseInt(value, 10) || 0);
      const b = String(right).replace(/^v/i, "").split(".").map((value) => parseInt(value, 10) || 0);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] || 0) - (b[index] || 0);
        if (difference) return difference > 0 ? 1 : -1;
      }
      return 0;
    }

    function conciseNotes(notes) {
      return String(notes || "")
        .replace(/\r\n?/g, "\n")
        .replace(/^\s*[-*]\s*/gm, "• ")
        .trim();
    }

    function showUpdateBanner(info) {
      pendingRelease = { version: info.latest, url: info.url || "" };
      root.getElementById("ub-current").textContent = "当前 v" + String(info.current || "?").replace(/^v/i, "");
      root.getElementById("ub-ver").textContent = "v" + String(info.latest).replace(/^v/i, "");
      root.getElementById("ub-notes").textContent = conciseNotes(info.notes) || "已发布新版本，查看更新说明了解改进内容。";
      updateBar.classList.add("show");
    }

    async function checkUpdate(force) {
      let info;
      try {
        info = await invoke("check_update");
      } catch (error) {
        if (force) alertAction(text("updateCheckFailed", "检查更新失败：{error}", { error }));
        setUpdateState();
        return;
      }
      if (!info || !info.ok) {
        if (force) alertAction(text("updateCheckNetworkFailed", "检查更新失败：无法连接更新服务器，请检查网络后重试。"));
        setUpdateState();
        return;
      }
      if (!info.has_update) {
        if (force) setUpdateState("latestVersion");
        return;
      }
      if (force) setUpdateState();
      if (!force) {
        const ignored = storage.getItem("ignoredUpdate");
        if (ignored && compareVersions(info.latest, ignored) <= 0) return;
      }
      showUpdateBanner(info);
    }

    async function loadCurrentNotes() {
      const version = "v" + String(await invoke("app_version").catch(() => "")).replace(/^v/i, "");
      const cached = storage.getItem("notes_" + version);
      if (cached) {
        notesElement.dataset.i18nState = "";
        notesElement.textContent = cached;
      } else {
        setNotesState("releaseNotesLoading");
      }
      const notes = String(await invoke("release_notes", { tag: version }).catch(() => "")).trim();
      if (notes) {
        storage.setItem("notes_" + version, notes);
        notesElement.dataset.i18nState = "";
        notesElement.textContent = notes;
      } else if (!cached) {
        setNotesState("releaseNotesUnavailable");
      }
    }

    root.getElementById("ub-view").addEventListener("click", () => {
      if (pendingRelease?.url) invoke("open_url", { url: pendingRelease.url }).catch(() => {});
    });
    root.getElementById("ub-ignore").addEventListener("click", () => {
      if (pendingRelease) storage.setItem("ignoredUpdate", pendingRelease.version);
      updateBar.classList.remove("show");
    });
    root.getElementById("ub-close").addEventListener("click", () => updateBar.classList.remove("show"));
    updateButton.addEventListener("click", () => {
      setUpdateState("checkingUpdate");
      checkUpdate(true);
    });
    root.getElementById("mi-about").addEventListener("click", () => {
      menuElement?.classList.remove("show");
      modal.classList.add("show");
      loadCurrentNotes();
    });
    root.getElementById("about-close").addEventListener("click", () => modal.classList.remove("show"));
    modal.addEventListener("click", (event) => {
      if (event.target === modal) modal.classList.remove("show");
    });
    global.addEventListener?.("app-language-changed", () => {
      setUpdateState(updateButton.dataset.i18nState || "checkUpdates");
      if (notesElement.dataset.i18nState) setNotesState(notesElement.dataset.i18nState);
    });

    activeController = Object.freeze({ checkUpdate });
    return activeController;
  }

  global.ReaderAboutUI = Object.freeze({ init });
})(window);
