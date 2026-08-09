(function initAboutUi(global) {
  "use strict";

  let activeController = null;

  function init({ root = document, invoke, storage = global.localStorage, menuElement, alertAction = global.alert } = {}) {
    if (activeController) return activeController;
    const modal = root.getElementById("about-modal");
    const updateBar = root.getElementById("update-bar");
    const updateButton = root.getElementById("about-update");
    const notesElement = root.getElementById("about-notes");
    const pendingUpdateKey = "pendingUpdateV1";
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

    function isIgnored(info) {
      const ignored = storage.getItem("ignoredUpdate");
      return Boolean(ignored && compareVersions(info.latest, ignored) <= 0);
    }

    function isNewerThanCurrent(info) {
      return Boolean(info?.latest && info?.current && compareVersions(info.latest, info.current) > 0);
    }

    function cachePendingUpdate(info) {
      if (!isNewerThanCurrent(info)) return;
      try {
        storage.setItem(pendingUpdateKey, JSON.stringify({
          current: String(info.current), latest: String(info.latest), notes: String(info.notes || ""), url: String(info.url || ""),
        }));
      } catch (_) { /* The live network result can still be shown without a local cache. */ }
    }

    function cachedPendingUpdate() {
      try {
        const info = JSON.parse(storage.getItem(pendingUpdateKey) || "null");
        return isNewerThanCurrent(info) ? info : null;
      } catch (_) {
        return null;
      }
    }

    function showUpdateBanner(info) {
      pendingRelease = { version: info.latest, url: info.url || "" };
      root.getElementById("ub-current").textContent = "当前 v" + String(info.current || "?").replace(/^v/i, "");
      root.getElementById("ub-ver").textContent = "v" + String(info.latest).replace(/^v/i, "");
      root.getElementById("ub-notes").textContent = conciseNotes(info.notes) || "已发布新版本，查看更新说明了解改进内容。";
      updateBar.classList.add("show");
    }

    function hideUpdateCard() {
      updateBar.classList.remove("show");
    }

    function reopenUpdateCard() {
      if (pendingRelease) {
        updateBar.classList.add("show");
        return;
      }
      const cached = cachedPendingUpdate();
      if (cached && !isIgnored(cached)) showUpdateBanner(cached);
    }

    function restorePendingUpdate() {
      const cached = cachedPendingUpdate();
      if (cached && !isIgnored(cached)) showUpdateBanner(cached);
    }

    function discardStalePendingUpdate(info) {
      // A successful response from the deployment manifest is authoritative.
      // Keep cached notices through a transient network failure, but remove a
      // test/released notice once that manifest says this app is up to date.
      if (info?.source !== "server" || info?.has_update) return;
      const cached = cachedPendingUpdate();
      if (!cached || String(cached.current) !== String(info.current)) return;
      try { storage.removeItem(pendingUpdateKey); } catch (_) {}
      if (pendingRelease?.version === cached.latest) {
        pendingRelease = null;
        hideUpdateCard();
      }
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
        discardStalePendingUpdate(info);
        if (force) setUpdateState("latestVersion");
        return;
      }
      cachePendingUpdate(info);
      if (force) setUpdateState();
      if (!force) {
        if (isIgnored(info)) return;
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
      try { storage.removeItem(pendingUpdateKey); } catch (_) {}
      hideUpdateCard();
    });
    root.getElementById("ub-close").addEventListener("click", hideUpdateCard);
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

    restorePendingUpdate();
    activeController = Object.freeze({ checkUpdate, hideUpdateCard, reopenUpdateCard });
    return activeController;
  }

  global.ReaderAboutUI = Object.freeze({
    init,
    hideUpdateCard: () => activeController?.hideUpdateCard?.(),
    reopenUpdateCard: () => activeController?.reopenUpdateCard?.(),
  });
})(window);
