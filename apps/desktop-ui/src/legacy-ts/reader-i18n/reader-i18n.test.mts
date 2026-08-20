import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { installReaderI18n } from "./reader-i18n.ts";

interface TestEvent {
  readonly type: string;
  readonly detail?: unknown;
  readonly key?: string | null;
}

class TestCustomEvent implements TestEvent {
  readonly type: string;
  readonly detail?: unknown;
  constructor(type: string, init?: CustomEventInit<unknown>) {
    this.type = type;
    this.detail = init?.detail;
  }
}

class TestElement {
  readonly dataset: Record<string, string> = {};
  textContent = "原文";
  title = "原标题";
  placeholder = "原占位";
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

interface Listener {
  readonly type: string;
  readonly callback: (event: TestEvent) => void;
  readonly options?: unknown;
}

interface Harness {
  readonly runtime: Record<string, unknown>;
  readonly storage: Map<string, string>;
  readonly dispatched: TestEvent[];
  readonly windowListeners: Listener[];
  readonly documentListeners: Listener[];
  readonly elements: {
    readonly text: TestElement;
    readonly title: TestElement;
    readonly aria: TestElement;
    readonly placeholder: TestElement;
  };
  readonly document: { readyState: string; documentElement: { lang: string }; title: string };
}

function createHarness(options: { readonly selected?: string; readonly system?: string; readonly loading?: boolean } = {}): Harness {
  const storage = new Map<string, string>();
  if (options.selected !== undefined) storage.set("appLanguageV1", options.selected);
  const dispatched: TestEvent[] = [];
  const windowListeners: Listener[] = [];
  const documentListeners: Listener[] = [];
  const text = new TestElement(); text.dataset.readerI18n = "chapterProgress";
  const title = new TestElement(); title.dataset.readerI18nTitle = "close";
  const aria = new TestElement(); aria.dataset.readerI18nAria = "windowControls";
  const placeholder = new TestElement(); placeholder.dataset.readerI18nPlaceholder = "aiQuestionPlaceholder";
  const selectors = new Map<string, TestElement[]>([
    ["[data-reader-i18n]", [text]],
    ["[data-reader-i18n-title]", [title]],
    ["[data-reader-i18n-aria]", [aria]],
    ["[data-reader-i18n-placeholder]", [placeholder]],
  ]);
  const document = {
    readyState: options.loading ? "loading" : "complete",
    documentElement: { lang: "" },
    title: "",
    querySelectorAll: (selector: string) => selectors.get(selector) ?? [],
    addEventListener: (type: string, callback: EventListenerOrEventListenerObject, listenerOptions?: unknown) => {
      const listener = typeof callback === "function"
        ? callback as unknown as (event: TestEvent) => void
        : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
      documentListeners.push({ type, callback: listener, options: listenerOptions });
    },
  };
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    navigator: { language: options.system ?? "zh-CN" },
    CustomEvent: TestCustomEvent,
    addEventListener: (type: string, callback: EventListenerOrEventListenerObject) => {
      const listener = typeof callback === "function"
        ? callback as unknown as (event: TestEvent) => void
        : (event: TestEvent) => callback.handleEvent(event as unknown as Event);
      windowListeners.push({ type, callback: listener });
    },
    dispatchEvent: (event: TestEvent) => { dispatched.push(event); return true; },
  };
  return {
    runtime, storage, dispatched, windowListeners, documentListeners,
    elements: { text, title, aria, placeholder }, document,
  };
}

function install(harness: Harness) {
  const api = installReaderI18n(harness.runtime as never);
  assert.ok(api);
  return api;
}

test("installer exposes the exact frozen classic API and refreshes a ready document", () => {
  const harness = createHarness({ selected: "en" });
  const api = install(harness);
  assert.equal(Object.isFrozen(api), true);
  assert.deepEqual(Object.keys(api), ["apply", "refresh", "resolvedLanguage", "selectedLanguage", "t", "missingKeys"]);
  assert.equal(harness.runtime.ReaderI18n, api);
  assert.equal(harness.document.documentElement.lang, "en");
  assert.equal(harness.document.title, "Reader");
  assert.equal(harness.elements.text.textContent, "Chapter / · this chapter / pages · %");
  assert.equal(harness.elements.title.title, "Close");
  assert.equal(harness.elements.aria.attributes.get("aria-label"), "Window controls");
  assert.equal(harness.elements.placeholder.placeholder, "Enter a question. Enter asks; Shift + Enter adds a line.");
  assert.equal(harness.dispatched[0]?.type, "reader-language-changed");
  assert.deepEqual(harness.dispatched[0]?.detail, { resolved: "en" });
  assert.deepEqual(harness.windowListeners.map(({ type }) => type), ["storage"]);
});

test("all ten language routes and exact catalog overrides remain stable", () => {
  const expected = new Map<string, [string, string]>([
    ["zh-CN", ["阅读", "生词本"]], ["zh-TW", ["閱讀", "生詞本"]],
    ["en", ["Reader", "Vocabulary"]], ["ja", ["リーダー", "単語帳"]],
    ["ko", ["리더", "단어장"]], ["fr", ["Lecteur", "Vocabulaire"]],
    ["de", ["Leser", "Vokabeln"]], ["es", ["Lector", "Vocabulario"]],
    ["ru", ["Читалка", "Словарь"]], ["pt-BR", ["Leitor", "Vocabulário"]],
  ]);
  for (const [locale, [title, vocabulary]] of expected) {
    const api = install(createHarness({ selected: locale }));
    assert.equal(api.resolvedLanguage(), locale);
    assert.equal(api.t("pageTitle"), title);
    assert.equal(api.t("vocabulary"), vocabulary);
    assert.equal(api.t("crossSummary", { books: 2, hits: 3 }).includes("2"), true);
  }
});

test("all 355 catalog entries per language match the frozen classic snapshot", () => {
  const expected = new Map<string, string>([
    ["zh-CN", "7b8b4cd78c58c569995b0598123fe7962c3991cc96f2ea120bac2d0e91736772"],
    ["zh-TW", "cc8aba9671db4c49b5ee41754879b7631db5d50be9e1e43a761fa91dca0c0e6e"],
    ["en", "b1612513e74ddbbe9a54aea934da8deb64e126a5990753833cca0a80fad95307"],
    ["ja", "3eea219a4dd6b5a7b4188fb332c5be32a56f81a05ab3ad0e7e7bf055230cc25d"],
    ["ko", "521e309666c62a8c7098113df5f6a70d6ac1e0e29bfa1f6188b430efeb7c1594"],
    ["fr", "90f0610acc3aac8e02add96267ac807d4a506086cecf6947c2716611228f2283"],
    ["de", "7dcac6c87f31bd417d0399f7352faf6f5b7a3bb49aaeaa79a32322bcf51ade9f"],
    ["es", "411e9ef63f833189f91834e71de6b253f79a5fdf37639bebf8c06846a4be636e"],
    ["ru", "7edacca0055e11991fb63f4dfde29c37f9f08b4bedec0dc501fdb4a171b40692"],
    ["pt-BR", "d5210215fbefd63e20b0dbbd77694687b64c42929b653381024150468fd15b13"],
  ]);
  const values = Object.fromEntries([
    "error", "stages", "index", "current", "total", "stage", "page", "chapter",
    "chapters", "progress", "part", "size", "count", "term", "books", "hits",
    "state", "language", "kind", "number", "unit", "name", "nextChapter",
  ].map((name) => [name, `<${name}>`]));
  for (const [locale, digest] of expected) {
    const api = install(createHarness({ selected: locale }));
    const keys = api.missingKeys("__missing__");
    assert.equal(keys.length, 355);
    const rows = keys.map((key) => [key, api.t(key, values)]);
    assert.equal(createHash("sha256").update(JSON.stringify(rows)).digest("hex"), digest, locale);
  }
});

test("system language resolution keeps Chinese variants, locale prefixes, and English fallback", () => {
  const cases = [
    ["zh-HK", "zh-TW"], ["zh-MO", "zh-TW"], ["zh-SG", "zh-CN"],
    ["ja-JP", "ja"], ["pt-PT", "pt-BR"], ["it-IT", "en"],
  ];
  for (const [system, expected] of cases) {
    assert.ok(system);
    const api = install(createHarness({ selected: "system", system }));
    assert.equal(api.resolvedLanguage(), expected);
  }
  const unsupportedSelection = createHarness({ selected: "xx", system: "de-DE" });
  assert.equal(install(unsupportedSelection).resolvedLanguage(), "de");
});

test("Japanese remains independent, complete, and visibly diagnoses unknown keys", () => {
  const english = install(createHarness({ selected: "en" }));
  const japanese = install(createHarness({ selected: "ja" }));
  const keys = [
    "pageTitle", "toc", "readAloud", "measuringPages", "aiReading", "ttsMicrosoftAuto",
    "crossSemanticTitle", "traceFrozen", "readerPreferences", "readerJumpBack",
  ];
  for (const key of keys) assert.notEqual(japanese.t(key), english.t(key), key);
  assert.deepEqual(japanese.missingKeys("ja"), []);
  assert.equal(japanese.t("not-a-real-key"), "⟦not-a-real-key⟧");
  assert.equal(english.t("not-a-real-key"), "not-a-real-key");
});

test("template substitution, scoped apply, loading bootstrap, and storage refresh match classic behavior", () => {
  const loading = createHarness({ selected: "zh-CN", loading: true });
  const api = install(loading);
  assert.equal(loading.dispatched.length, 0);
  assert.equal(loading.documentListeners.length, 1);
  assert.equal(loading.documentListeners[0]?.type, "DOMContentLoaded");
  assert.deepEqual(loading.documentListeners[0]?.options, { once: true });
  loading.documentListeners[0]?.callback({ type: "DOMContentLoaded" });
  assert.equal(loading.dispatched.length, 1);
  assert.equal(api.t("crossSummary", { books: 4, hits: 8 }), "4 本 · 8 处");
  assert.equal(api.t("crossSummary", { books: 0 }), "0 本 ·  处");

  const scopedText = new TestElement(); scopedText.dataset.readerI18n = "close";
  const scoped = {
    querySelectorAll: (selector: string) => selector === "[data-reader-i18n]" ? [scopedText] : [],
  };
  api.apply(scoped as never);
  assert.equal(scopedText.textContent, "关闭");
  loading.storage.set("appLanguageV1", "en");
  loading.windowListeners[0]?.callback({ type: "storage", key: "unrelated" });
  assert.equal(loading.dispatched.length, 1);
  loading.windowListeners[0]?.callback({ type: "storage", key: "appLanguageV1" });
  assert.equal(loading.document.title, "Reader");
  assert.equal(loading.dispatched.length, 2);
});

test("installer fails closed when the original browser dependencies are absent", () => {
  const harness = createHarness();
  for (const key of ["document", "localStorage", "navigator", "CustomEvent"] as const) {
    const runtime = { ...harness.runtime };
    delete runtime[key];
    assert.equal(installReaderI18n(runtime as never), null);
  }
});
