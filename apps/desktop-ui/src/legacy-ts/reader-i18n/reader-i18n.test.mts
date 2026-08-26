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
    assert.notEqual(api.t("readerContextMedia"), "readerContextMedia");
    assert.notEqual(api.t("readerContextImageDensity"), "readerContextImageDensity");
    assert.notEqual(api.t("readerContextVideoSummaryEnd"), "readerContextVideoSummaryEnd");
  }
});

test("all 380 catalog entries per language match the frozen classic snapshot", () => {
  const expected = new Map<string, string>([
    ["zh-CN", "f1f480649ae16fd6aa0885b5e38828d12737bd854049b22102b30bc690bf8707"],
    ["zh-TW", "86a8eed44a7a3313f36c2d45a485e5f7d1bd90e0c7676624aec9441b7b92c8e1"],
    ["en", "c383e38a1e93ef9572a7635c4e670d8f0bd5363de27a684e66fbac19d4d3cddc"],
    ["ja", "043630f992cee30c5d721baa36cde38faf1d8f5d01ddbb1e09205d90823ac356"],
    ["ko", "d41fc02041939fcca6c4129b211754513b72a2c7040ad405af69712d26a09352"],
    ["fr", "f95ecfa4c7699b15ecb0b354fd43d5c98a9d8de1e1beb0f8bd18f6ed10be0348"],
    ["de", "4e8a8281a258224ef74e62c3899ab314165974b6552c560fd023c6c79306aba8"],
    ["es", "803edaef6c92a78f86cfdc9897123660219557161eaf232c68a4d8ed224b4777"],
    ["ru", "be899ca1dd77abb93601502059d98c2b9b0464f5cf3bad9040d84a9f103a8b70"],
    ["pt-BR", "c691c71c84f54960a0340794b5b179df9656be10d08ebcc0a3cc3b8cd4e18677"],
  ]);
  const values = Object.fromEntries([
    "error", "stages", "index", "current", "total", "stage", "page", "chapter",
    "chapters", "progress", "part", "size", "count", "term", "books", "hits",
    "state", "language", "kind", "number", "unit", "name", "nextChapter",
  ].map((name) => [name, `<${name}>`]));
  for (const [locale, digest] of expected) {
    const api = install(createHarness({ selected: locale }));
    const keys = api.missingKeys("__missing__");
    assert.equal(keys.length, 380);
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
