import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installAboutUi,
  type AboutUiApi,
} from "./about-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  try {
    return readFileSync(new URL("ui/generated-ts/about-ui.js", repositoryRoot), "utf8");
  } catch {
    return execFileSync("git", ["show", "HEAD:ui/generated-ts/about-ui.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
}

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...values: string[]): void {
    values.forEach((value) => this.values.add(value));
  }
  public remove(...values: string[]): void {
    values.forEach((value) => this.values.delete(value));
  }
}

interface FakeEvent {
  readonly target: FakeNode;
  preventDefault(): void;
}

class FakeNode {
  public readonly classList = new FakeClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeNode[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  public textContent = "";
  public href = "";

  public constructor(
    public readonly kind: "element" | "text" | "fragment",
    public readonly name: string,
  ) {}

  public append(...nodes: FakeNode[]): void {
    this.children.push(...nodes);
  }

  public addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public replaceChildren(...nodes: FakeNode[]): void {
    this.children.splice(0, this.children.length, ...nodes);
    this.textContent = "";
  }

  public fire(type: string, target: FakeNode = this): { readonly prevented: boolean } {
    let prevented = false;
    const event: FakeEvent = {
      target,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return { prevented };
  }
}

function nodeSnapshot(node: FakeNode): unknown {
  return {
    kind: node.kind,
    name: node.name,
    text: node.textContent,
    href: node.href,
    classes: [...node.classList.values].sort(),
    dataset: { ...node.dataset },
    children: node.children.map(nodeSnapshot),
  };
}

interface StorageFixture extends Storage {
  readonly values: Map<string, string>;
}

function storageFixture(initial: Readonly<Record<string, string>> = {}): StorageFixture {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

type InvokeCall = { readonly command: string; readonly args?: Record<string, unknown> };

function fixture(initialStorage: Readonly<Record<string, string>> = {}) {
  const ids = [
    "about-modal",
    "update-bar",
    "about-update",
    "about-github",
    "about-notes",
    "about-release-title",
    "about-update-arrow",
    "about-update-version",
    "ub-notes",
    "ub-current",
    "ub-ver",
    "ub-view",
    "ub-ignore",
    "ub-close",
    "mi-about",
    "about-close",
  ];
  const elements = Object.fromEntries(
    ids.map((id) => [id, new FakeNode("element", id)]),
  );
  if (elements["about-github"]) {
    elements["about-github"].href =
      "https://github.com/pigking9527-cmyk/kunpeng-reader";
  }
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (name: string) => new FakeNode("element", name),
    createTextNode: (text: string) => {
      const node = new FakeNode("text", "#text");
      node.textContent = text;
      return node;
    },
    createDocumentFragment: () => new FakeNode("fragment", "#fragment"),
  };
  const storage = storageFixture(initialStorage);
  const calls: InvokeCall[] = [];
  const checkResults: unknown[] = [];
  const languageListeners: Array<() => void> = [];
  const alerts: string[] = [];
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    if (command === "check_update") {
      const next = checkResults.shift();
      if (next instanceof Error) throw next;
      return next as TResult;
    }
    if (command === "app_version") return "v1.5.0" as TResult;
    if (command === "release_notes") {
      return "# 1.5.0\n\n- **修复** `EPUB`\n- [详情](https://example.test/release)" as TResult;
    }
    return undefined as TResult;
  };
  const target: Record<string, unknown> = {
    document,
    localStorage: storage,
    ReaderAppI18n: {
      t: (key: string) => `i18n:${key}`,
    },
    URL,
    addEventListener: (type: string, listener: () => void) => {
      if (type === "app-language-changed") languageListeners.push(listener);
    },
    alert: (message: unknown) => alerts.push(String(message)),
  };
  target.window = target;
  target.globalThis = target;
  const menu = new FakeNode("element", "menu");
  menu.classList.add("show");
  return {
    target,
    document,
    elements,
    storage,
    calls,
    checkResults,
    languageListeners,
    alerts,
    invoke,
    menu,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function exercise(legacy: boolean) {
  const cached = JSON.stringify({
    current: "1.4.0",
    latest: "1.5.0",
    notes: "## 更新\n\n- **更快**\n> 稳定",
    url: "https://example.test/download",
  });
  const view = fixture({ pendingUpdateV1: cached });
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else installAboutUi(view.target);
  const exposed = view.target.ReaderAboutUI as AboutUiApi;
  const controller = exposed.init({
    root: view.document as unknown as Document,
    invoke: view.invoke,
    storage: view.storage,
    menuElement: view.menu as unknown as HTMLElement,
    alertAction: (message) => view.alerts.push(message),
  });
  const restored = {
    cardShown: view.elements["update-bar"]?.classList.values.has("show"),
    current: view.elements["ub-current"]?.textContent,
    latest: view.elements["ub-ver"]?.textContent,
    notes: nodeSnapshot(view.elements["ub-notes"] as FakeNode),
  };
  view.elements["ub-view"]?.fire("click");
  await settle();
  view.elements["ub-close"]?.fire("click");
  const hidden = !view.elements["update-bar"]?.classList.values.has("show");
  exposed.reopenUpdateCard();
  const reopened = view.elements["update-bar"]?.classList.values.has("show");
  controller.hideUpdateCard();

  view.elements["mi-about"]?.fire("click");
  await settle();
  view.elements["about-github"]?.fire("click");
  await settle();
  const about = {
    shown: view.elements["about-modal"]?.classList.values.has("show"),
    menuHidden: !view.menu.classList.values.has("show"),
    updateArrow: view.elements["about-update-arrow"]?.classList.values.has("show"),
    updateVersion: view.elements["about-update-version"]?.textContent,
    releaseTitle: view.elements["about-release-title"]?.textContent,
    notes: nodeSnapshot(view.elements["about-notes"] as FakeNode),
    cachedNotes: view.storage.getItem("notes_v1.5.0"),
  };
  view.elements["about-modal"]?.fire("click");

  view.checkResults.push({
    ok: true,
    current: "1.4.0",
    latest: "1.4.0",
    notes: "",
    url: "",
    source: "github",
    has_update: false,
  });
  await controller.checkUpdate(false);
  const staleCleared = view.storage.getItem("pendingUpdateV1");

  view.checkResults.push({
    ok: true,
    current: "1.5.0",
    latest: "1.6.0",
    notes: "- 新版本",
    url: "https://example.test/1.6",
    source: "server",
    has_update: true,
  });
  await controller.checkUpdate(false);
  const update = {
    modalShown: view.elements["about-modal"]?.classList.values.has("show"),
    current: view.elements["ub-current"]?.textContent,
    latest: view.elements["ub-ver"]?.textContent,
    notes: nodeSnapshot(view.elements["ub-notes"] as FakeNode),
    updateCardShown: view.elements["update-bar"]?.classList.values.has("show"),
    pending: view.storage.getItem("pendingUpdateV1"),
  };
  view.elements["ub-ignore"]?.fire("click");
  const ignored = {
    version: view.storage.getItem("ignoredUpdate"),
    pending: view.storage.getItem("pendingUpdateV1"),
    hidden: !view.elements["update-bar"]?.classList.values.has("show"),
  };

  view.checkResults.push(new Error("offline"));
  view.elements["about-update"]?.fire("click");
  await settle();
  view.languageListeners.forEach((listener) => listener());
  return {
    exposed: { keys: Object.keys(exposed).sort(), frozen: Object.isFrozen(exposed) },
    controller: { keys: Object.keys(controller).sort(), frozen: Object.isFrozen(controller) },
    restored,
    hidden,
    reopened,
    about,
    modalClosed: !view.elements["about-modal"]?.classList.values.has("show"),
    staleCleared,
    update,
    ignored,
    alerts: view.alerts,
    button: {
      state: view.elements["about-update"]?.dataset.i18nState,
      text: view.elements["about-update"]?.textContent,
    },
    calls: view.calls,
  };
}

test("about strict installer is behavior-equivalent to the original classic script", async () => {
  assert.equal(JSON.stringify(await exercise(false)), JSON.stringify(await exercise(true)));
});

test("about UI ignores withdrawn cached releases and opens only freshly detected updates", async () => {
  const result = await exercise(false);
  assert.deepEqual(result.exposed, {
    keys: ["hideUpdateCard", "init", "reopenUpdateCard"],
    frozen: true,
  });
  assert.deepEqual(result.controller, {
    keys: ["checkUpdate", "hideUpdateCard", "reopenUpdateCard"],
    frozen: true,
  });
  assert.equal(result.restored.cardShown, false);
  assert.equal(result.restored.current, "");
  assert.equal(result.restored.latest, "");
  assert.equal(result.hidden, true);
  assert.equal(result.reopened, false);
  assert.equal(result.about.shown, true);
  assert.equal(result.about.menuHidden, true);
  assert.equal(result.about.updateArrow, false);
  assert.equal(result.about.updateVersion, "");
  assert.match(result.about.releaseTitle ?? "", /aboutReleaseNotes/u);
  assert.match(JSON.stringify(result.about.notes), /EPUB/u);
  assert.match(result.about.cachedNotes ?? "", /EPUB/u);
  assert.equal(result.modalClosed, true);
  assert.equal(result.staleCleared, null);
  assert.equal(result.update.modalShown, false);
  assert.equal(result.update.current, "当前 v1.5.0");
  assert.equal(result.update.latest, "v1.6.0");
  assert.match(JSON.stringify(result.update.notes), /新版本/u);
  assert.equal(result.update.updateCardShown, true);
  assert.equal(result.ignored.version, "1.6.0");
  assert.equal(result.ignored.pending, null);
  assert.equal(result.ignored.hidden, true);
  assert.deepEqual(result.alerts, ["i18n:updateCheckFailed"]);
  assert.ok(result.calls.some(({ command }) => command === "check_update"));
  assert.ok(result.calls.some(({ command }) => command === "release_notes"));
});

test("about renderer only invokes safe HTTP links and never uses an HTML sink", async () => {
  const view = fixture();
  const controller = installAboutUi(view.target)?.init({
    root: view.document as unknown as Document,
    invoke: view.invoke,
    storage: view.storage,
  });
  view.checkResults.push({
    ok: true,
    current: "1.0.0",
    latest: "2.0.0",
    notes: "[安全](https://example.test) [拒绝](javascript:alert(1))",
    url: "https://example.test/download",
    source: "github",
    has_update: true,
  });
  await controller?.checkUpdate(false);
  const fragment = view.elements["ub-notes"]?.children[0];
  const paragraph = fragment?.children[0];
  const link = paragraph?.children.find(({ name }) => name === "a");
  assert.ok(link);
  const result = link.fire("click");
  await settle();
  assert.equal(result.prevented, true);
  assert.deepEqual(view.calls, [
    { command: "check_update" },
    { command: "open_url", args: { url: "https://example.test/" } },
  ]);
});

async function manualUpdateResult(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else installAboutUi(view.target);
  (view.target.ReaderAboutUI as AboutUiApi).init({
    root: view.document as unknown as Document,
    invoke: view.invoke,
    storage: view.storage,
  });
  view.checkResults.push({
    ok: true,
    current: "1.1.0-beta.1",
    latest: "1.1.0",
    notes: "# 测试版 1.1\n\n- 自动发现更新\n- 关于页内显示说明",
    url: "https://example.test/1.1",
    source: "server",
    has_update: true,
  });
  view.elements["about-update"]?.fire("click");
  await settle();
  const beforeOpen = {
    arrowShown: view.elements["about-update-arrow"]?.classList.values.has("show"),
    version: view.elements["about-update-version"]?.textContent,
    releaseTitle: view.elements["about-release-title"]?.textContent,
    notes: nodeSnapshot(view.elements["about-notes"] as FakeNode),
    updateCardShown: view.elements["update-bar"]?.classList.values.has("show"),
  };
  return { beforeOpen, calls: view.calls };
}

test("manual checks render the available release and notes inside About", async () => {
  const strict = await manualUpdateResult(false);
  const classic = await manualUpdateResult(true);
  assert.equal(JSON.stringify(strict), JSON.stringify(classic));
  assert.equal(strict.beforeOpen.arrowShown, true);
  assert.equal(strict.beforeOpen.version, "v1.1.0");
  assert.equal(strict.beforeOpen.releaseTitle, "新版更新内容");
  assert.equal(strict.beforeOpen.updateCardShown, false);
  assert.match(JSON.stringify(strict.beforeOpen.notes), /关于页内显示说明/u);
  assert.deepEqual(strict.calls, [{ command: "check_update" }]);
});

test("about installer fails closed without the original browser runtime", () => {
  assert.equal(installAboutUi({ document: {} }), null);
});
