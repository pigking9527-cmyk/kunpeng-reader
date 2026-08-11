(function initAboutUi(global) {
  "use strict";

  let activeController = null;

  function init({ root = document, invoke, storage = global.localStorage, menuElement, alertAction = global.alert } = {}) {
    if (activeController) return activeController;
    const modal = root.getElementById("about-modal");
    const updateBar = root.getElementById("update-bar");
    const updateButton = root.getElementById("about-update");
    const notesElement = root.getElementById("about-notes");
    const updateNotesElement = root.getElementById("ub-notes");
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

    function safeReleaseUrl(value) {
      try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
      } catch (_) {
        return "";
      }
    }

    // Release notes are remote Markdown. Build a small allowlist directly with
    // DOM nodes instead of assigning remote text to innerHTML.
    function appendReleaseInline(parent, value) {
      const source = String(value || "");
      const token = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*([^*\n]+)\*)/g;
      let cursor = 0;
      let match;
      while ((match = token.exec(source))) {
        parent.append(root.createTextNode(source.slice(cursor, match.index)));
        if (match[2] !== undefined) {
          const strong = root.createElement("strong");
          appendReleaseInline(strong, match[2]);
          parent.append(strong);
        } else if (match[4] !== undefined) {
          const code = root.createElement("code");
          code.textContent = match[4];
          parent.append(code);
        } else if (match[6] !== undefined) {
          const url = safeReleaseUrl(match[7]);
          if (!url) parent.append(root.createTextNode(match[5]));
          else {
            const link = root.createElement("a");
            link.href = url;
            link.textContent = match[6];
            link.addEventListener("click", (event) => {
              event.preventDefault();
              invoke("open_url", { url }).catch(() => {});
            });
            parent.append(link);
          }
        } else {
          const emphasis = root.createElement("em");
          appendReleaseInline(emphasis, match[9]);
          parent.append(emphasis);
        }
        cursor = token.lastIndex;
      }
      parent.append(root.createTextNode(source.slice(cursor)));
    }

    function renderReleaseNotes(target, value, fallback = "") {
      const fragment = root.createDocumentFragment();
      const lines = String(value || fallback || "").replace(/\r/g, "").split("\n");
      let paragraph = [];
      let list = null;
      let listKind = "";
      let codeLines = null;
      const closeList = () => { list = null; listKind = ""; };
      const flushParagraph = () => {
        if (!paragraph.length) return;
        const element = root.createElement("p");
        appendReleaseInline(element, paragraph.join(" "));
        fragment.append(element);
        paragraph = [];
      };
      const appendListItem = (kind, text) => {
        flushParagraph();
        if (!list || listKind !== kind) {
          list = root.createElement(kind);
          listKind = kind;
          fragment.append(list);
        }
        const item = root.createElement("li");
        appendReleaseInline(item, text);
        list.append(item);
      };
      lines.forEach((raw) => {
        const line = raw.trim();
        if (/^```/.test(line)) {
          if (codeLines) {
            const block = root.createElement("pre");
            const code = root.createElement("code");
            code.textContent = codeLines.join("\n");
            block.append(code);
            fragment.append(block);
            codeLines = null;
          } else {
            flushParagraph();
            closeList();
            codeLines = [];
          }
          return;
        }
        if (codeLines) { codeLines.push(raw); return; }
        if (!line) { flushParagraph(); closeList(); return; }
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          flushParagraph();
          closeList();
          const element = root.createElement(heading[1].length === 1 ? "h3" : heading[1].length === 2 ? "h4" : "h5");
          appendReleaseInline(element, heading[2]);
          fragment.append(element);
          return;
        }
        const bullet = line.match(/^[-*+]\s+(.+)$/);
        if (bullet) { appendListItem("ul", bullet[1]); return; }
        const numbered = line.match(/^\d+[.)]\s+(.+)$/);
        if (numbered) { appendListItem("ol", numbered[1]); return; }
        const quote = line.match(/^>\s?(.+)$/);
        if (quote) {
          flushParagraph();
          closeList();
          const block = root.createElement("blockquote");
          appendReleaseInline(block, quote[1]);
          fragment.append(block);
          return;
        }
        if (/^([-*_])\1\1+$/.test(line)) {
          flushParagraph();
          closeList();
          fragment.append(root.createElement("hr"));
          return;
        }
        closeList();
        paragraph.push(line);
      });
      if (codeLines) {
        const block = root.createElement("pre");
        const code = root.createElement("code");
        code.textContent = codeLines.join("\n");
        block.append(code);
        fragment.append(block);
      }
      flushParagraph();
      target.classList.add("release-notes-markdown");
      target.replaceChildren(fragment);
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
      renderReleaseNotes(updateNotesElement, info.notes, "已发布新版本，查看更新说明了解改进内容。");
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
        renderReleaseNotes(notesElement, cached);
      } else {
        setNotesState("releaseNotesLoading");
      }
      const notes = String(await invoke("release_notes", { tag: version }).catch(() => "")).trim();
      if (notes) {
        storage.setItem("notes_" + version, notes);
        notesElement.dataset.i18nState = "";
        renderReleaseNotes(notesElement, notes);
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
