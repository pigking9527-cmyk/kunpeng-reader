import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface UpdateInfo extends Record<string, unknown> {
  readonly ok?: unknown;
  readonly current?: unknown;
  readonly latest?: unknown;
  readonly notes?: unknown;
  readonly url?: unknown;
  readonly source?: unknown;
  readonly has_update?: unknown;
}

type AboutCommands = {
  check_update: { readonly result: UpdateInfo | null };
  app_version: { readonly result: unknown };
  release_notes: {
    readonly args: { readonly tag: string };
    readonly result: unknown;
  };
  open_url: {
    readonly args: { readonly url: string };
    readonly result: unknown;
  };
};

type VerifiedAboutCommands = AboutCommands extends TauriCommandMap ? AboutCommands : never;

interface AboutI18n {
  t?(key: string): string;
}

interface AboutRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage: Storage;
  readonly ReaderAppI18n?: AboutI18n;
  readonly alert?: (message?: unknown) => unknown;
  addEventListener?(type: string, listener: () => void): void;
  ReaderAboutUI?: AboutUiApi;
}

export interface AboutInitOptions {
  readonly root?: Document;
  readonly invoke?: TauriTransport["invoke"];
  readonly storage?: Storage;
  readonly menuElement?: HTMLElement | null;
  readonly alertAction?: (message: string) => unknown;
}

export interface AboutController {
  checkUpdate(force: boolean): Promise<void>;
  hideUpdateCard(): void;
  reopenUpdateCard(): void;
}

export interface AboutUiApi {
  init(options?: AboutInitOptions): AboutController;
  hideUpdateCard(): void;
  reopenUpdateCard(): void;
}

interface PendingRelease {
  readonly version: unknown;
  readonly url: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): AboutRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || !record(runtime.localStorage)) return null;
  return runtime as unknown as AboutRuntime;
}

function requiredElement<TElement extends HTMLElement>(root: Document, id: string): TElement {
  return root.getElementById(id) as TElement;
}

export function createAboutUi(runtime: AboutRuntime): AboutUiApi {
  let activeController: AboutController | null = null;

  const init = (options: AboutInitOptions = {}): AboutController => {
    if (activeController) return activeController;
    const root = options.root ?? runtime.document;
    const invoke = options.invoke;
    const storage = options.storage ?? runtime.localStorage;
    const menuElement = options.menuElement;
    const alertAction = options.alertAction ?? runtime.alert;
    if (typeof invoke !== "function") {
      throw new TypeError("About UI requires an invoke transport.");
    }
    const api = createTauriApi<VerifiedAboutCommands>({ invoke });
    const modal = requiredElement<HTMLElement>(root, "about-modal");
    const updateBar = requiredElement<HTMLElement>(root, "update-bar");
    const updateButton = requiredElement<HTMLButtonElement>(root, "about-update");
    const githubLink = requiredElement<HTMLAnchorElement>(root, "about-github");
    const notesElement = requiredElement<HTMLElement>(root, "about-notes");
    const updateNotesElement = requiredElement<HTMLElement>(root, "ub-notes");
    const pendingUpdateKey = "pendingUpdateV1";
    let pendingRelease: PendingRelease | null = null;

    const text = (
      key: string,
      fallback?: string,
      values: Readonly<Record<string, unknown>> = {},
    ): string => {
      let value = runtime.ReaderAppI18n?.t?.(key) || fallback || key;
      for (const [name, replacement] of Object.entries(values)) {
        value = value.replaceAll(`{${name}}`, String(replacement));
      }
      return value;
    };

    const setUpdateState = (key = "checkUpdates"): void => {
      updateButton.dataset.i18nState = key;
      updateButton.textContent = text(key);
    };

    const setNotesState = (key: string): void => {
      notesElement.dataset.i18nState = key || "";
      if (key) notesElement.textContent = text(key);
    };

    const compareVersions = (left: unknown, right: unknown): number => {
      const a = String(left)
        .replace(/^v/iu, "")
        .split(".")
        .map((value) => Number.parseInt(value, 10) || 0);
      const b = String(right)
        .replace(/^v/iu, "")
        .split(".")
        .map((value) => Number.parseInt(value, 10) || 0);
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] || 0) - (b[index] || 0);
        if (difference) return difference > 0 ? 1 : -1;
      }
      return 0;
    };

    const safeReleaseUrl = (value: unknown): string => {
      try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
      } catch {
        return "";
      }
    };

    const appendReleaseInline = (parent: ParentNode, value: unknown): void => {
      const source = String(value || "");
      const token = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(\*([^*\n]+)\*)/gu;
      let cursor = 0;
      let match: RegExpExecArray | null;
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
          if (!url) parent.append(root.createTextNode(match[5] ?? ""));
          else {
            const link = root.createElement("a");
            link.href = url;
            link.textContent = match[6];
            link.addEventListener("click", (event) => {
              event.preventDefault();
              void api.invoke("open_url", { url }).catch(() => undefined);
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
    };

    const renderReleaseNotes = (
      target: HTMLElement,
      value: unknown,
      fallback = "",
    ): void => {
      const fragment = root.createDocumentFragment();
      const lines = String(value || fallback || "").replace(/\r/gu, "").split("\n");
      let paragraph: string[] = [];
      let list: HTMLElement | null = null;
      let listKind = "";
      let codeLines: string[] | null = null;
      const closeList = (): void => {
        list = null;
        listKind = "";
      };
      const flushParagraph = (): void => {
        if (!paragraph.length) return;
        const element = root.createElement("p");
        appendReleaseInline(element, paragraph.join(" "));
        fragment.append(element);
        paragraph = [];
      };
      const appendListItem = (kind: "ul" | "ol", itemText: string): void => {
        flushParagraph();
        if (!list || listKind !== kind) {
          list = root.createElement(kind);
          listKind = kind;
          fragment.append(list);
        }
        const item = root.createElement("li");
        appendReleaseInline(item, itemText);
        list.append(item);
      };
      for (const raw of lines) {
        const line = raw.trim();
        if (/^```/u.test(line)) {
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
          continue;
        }
        if (codeLines) {
          codeLines.push(raw);
          continue;
        }
        if (!line) {
          flushParagraph();
          closeList();
          continue;
        }
        const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
        if (heading) {
          flushParagraph();
          closeList();
          const level = heading[1]?.length;
          const element = root.createElement(level === 1 ? "h3" : level === 2 ? "h4" : "h5");
          appendReleaseInline(element, heading[2]);
          fragment.append(element);
          continue;
        }
        const bullet = /^[-*+]\s+(.+)$/u.exec(line);
        if (bullet) {
          appendListItem("ul", bullet[1] ?? "");
          continue;
        }
        const numbered = /^\d+[.)]\s+(.+)$/u.exec(line);
        if (numbered) {
          appendListItem("ol", numbered[1] ?? "");
          continue;
        }
        const quote = /^>\s?(.+)$/u.exec(line);
        if (quote) {
          flushParagraph();
          closeList();
          const block = root.createElement("blockquote");
          appendReleaseInline(block, quote[1]);
          fragment.append(block);
          continue;
        }
        if (/^([-*_])\1\1+$/u.test(line)) {
          flushParagraph();
          closeList();
          fragment.append(root.createElement("hr"));
          continue;
        }
        closeList();
        paragraph.push(line);
      }
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
    };

    const isIgnored = (info: UpdateInfo): boolean => {
      const ignored = storage.getItem("ignoredUpdate");
      return Boolean(ignored && compareVersions(info.latest, ignored) <= 0);
    };

    const isNewerThanCurrent = (value: unknown): value is UpdateInfo => {
      const info = record(value) as UpdateInfo | null;
      return Boolean(
        info?.latest && info.current && compareVersions(info.latest, info.current) > 0,
      );
    };

    const cachePendingUpdate = (info: UpdateInfo): void => {
      if (!isNewerThanCurrent(info)) return;
      try {
        storage.setItem(
          pendingUpdateKey,
          JSON.stringify({
            current: String(info.current),
            latest: String(info.latest),
            notes: String(info.notes || ""),
            url: String(info.url || ""),
          }),
        );
      } catch {
        // The live network result can still be shown without a local cache.
      }
    };

    const installedVersion = async (): Promise<string> =>
      String(await api.invoke("app_version").catch(() => ""))
        .trim()
        .replace(/^v/iu, "");

    const cachedPendingUpdate = (currentVersion = ""): UpdateInfo | null => {
      try {
        const info: unknown = JSON.parse(storage.getItem(pendingUpdateKey) || "null");
        if (!isNewerThanCurrent(info)) return null;
        const cached = info as UpdateInfo;
        if (
          currentVersion &&
          String(cached.current || "").replace(/^v/iu, "") !== currentVersion
        ) {
          storage.removeItem(pendingUpdateKey);
          return null;
        }
        return cached;
      } catch {
        return null;
      }
    };

    const showUpdateBanner = (info: UpdateInfo): void => {
      pendingRelease = { version: info.latest, url: info.url || "" };
      requiredElement<HTMLElement>(root, "ub-current").textContent =
        `当前 v${String(info.current || "?").replace(/^v/iu, "")}`;
      requiredElement<HTMLElement>(root, "ub-ver").textContent =
        `v${String(info.latest).replace(/^v/iu, "")}`;
      renderReleaseNotes(
        updateNotesElement,
        info.notes,
        "已发布新版本，查看更新说明了解改进内容。",
      );
      updateBar.classList.add("show");
    };

    const hideUpdateCard = (): void => {
      updateBar.classList.remove("show");
    };

    const closeAbout = (): void => {
      modal.classList.remove("show");
    };

    const loadCurrentNotes = async (): Promise<void> => {
      const version = `v${String(await api.invoke("app_version").catch(() => "")).replace(/^v/iu, "")}`;
      const cached = storage.getItem(`notes_${version}`);
      if (cached) {
        notesElement.dataset.i18nState = "";
        renderReleaseNotes(notesElement, cached);
      } else {
        setNotesState("releaseNotesLoading");
      }
      const notes = String(
        await api.invoke("release_notes", { tag: version }).catch(() => ""),
      ).trim();
      if (notes) {
        storage.setItem(`notes_${version}`, notes);
        notesElement.dataset.i18nState = "";
        renderReleaseNotes(notesElement, notes);
      } else if (!cached) {
        setNotesState("releaseNotesUnavailable");
      }
    };

    const openAbout = (): void => {
      menuElement?.classList.remove("show");
      modal.classList.add("show");
      void loadCurrentNotes();
    };

    const reopenUpdateCard = (): void => {
      if (pendingRelease) {
        updateBar.classList.add("show");
        return;
      }
      void installedVersion().then((currentVersion) => {
        if (!currentVersion) return;
        const cached = cachedPendingUpdate(currentVersion);
        if (cached && !isIgnored(cached)) showUpdateBanner(cached);
      });
    };

    const restorePendingUpdate = (): void => {
      void installedVersion().then((currentVersion) => {
        if (!currentVersion) return;
        const cached = cachedPendingUpdate(currentVersion);
        if (cached && !isIgnored(cached)) showUpdateBanner(cached);
      });
    };

    const discardStalePendingUpdate = (info: UpdateInfo): void => {
      if (info.source !== "server" || info.has_update) return;
      const cached = cachedPendingUpdate(String(info.current || "").replace(/^v/iu, ""));
      if (!cached || String(cached.current) !== String(info.current)) return;
      try {
        storage.removeItem(pendingUpdateKey);
      } catch {
        // Removal is best effort, matching the original local cache behavior.
      }
      if (pendingRelease?.version === cached.latest) {
        pendingRelease = null;
        hideUpdateCard();
      }
    };

    const checkUpdate = async (force: boolean): Promise<void> => {
      let info: UpdateInfo | null;
      try {
        info = await api.invoke("check_update");
      } catch (error) {
        if (force) alertAction?.(text("updateCheckFailed", "检查更新失败：{error}", { error }));
        setUpdateState();
        return;
      }
      if (!info?.ok) {
        if (force) {
          alertAction?.(
            text(
              "updateCheckNetworkFailed",
              "检查更新失败：无法连接更新服务器，请检查网络后重试。",
            ),
          );
        }
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
      if (!force && isIgnored(info)) return;
      showUpdateBanner(info);
    };

    requiredElement<HTMLElement>(root, "ub-view").addEventListener("click", () => {
      if (pendingRelease?.url) {
        void api
          .invoke("open_url", { url: String(pendingRelease.url) })
          .catch(() => undefined);
      }
    });
    requiredElement<HTMLElement>(root, "ub-ignore").addEventListener("click", () => {
      if (pendingRelease) storage.setItem("ignoredUpdate", String(pendingRelease.version));
      try {
        storage.removeItem(pendingUpdateKey);
      } catch {
        // Removal is best effort, matching the original local cache behavior.
      }
      hideUpdateCard();
    });
    requiredElement<HTMLElement>(root, "ub-close").addEventListener("click", hideUpdateCard);
    updateButton.addEventListener("click", () => {
      setUpdateState("checkingUpdate");
      void checkUpdate(true);
    });
    requiredElement<HTMLElement>(root, "mi-about").addEventListener("click", openAbout);
    requiredElement<HTMLElement>(root, "about-close").addEventListener("click", closeAbout);
    githubLink.addEventListener("click", (event) => {
      event.preventDefault();
      const url = safeReleaseUrl(githubLink.href);
      if (url) void api.invoke("open_url", { url }).catch(() => undefined);
    });
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeAbout();
    });
    runtime.addEventListener?.("app-language-changed", () => {
      setUpdateState(updateButton.dataset.i18nState || "checkUpdates");
      if (notesElement.dataset.i18nState) setNotesState(notesElement.dataset.i18nState);
    });

    restorePendingUpdate();
    activeController = Object.freeze({ checkUpdate, hideUpdateCard, reopenUpdateCard });
    return activeController;
  };

  const publicApi: AboutUiApi = {
    init,
    hideUpdateCard: () => activeController?.hideUpdateCard(),
    reopenUpdateCard: () => activeController?.reopenUpdateCard(),
  };
  return Object.freeze(publicApi);
}

/** Classic installer replacing `ui/about-ui.js`. */
export function installAboutUi(target: unknown): AboutUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createAboutUi(runtime);
  runtime.ReaderAboutUI = api;
  return api;
}
