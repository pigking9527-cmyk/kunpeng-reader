import assert from "node:assert/strict";
import test from "node:test";

import { RERANKER_CATALOG } from "../i18n-catalogs/app-i18n-reranker-catalog.ts";
import { installAppI18n, type AppI18nApi } from "./app-i18n.ts";

class TestCustomEvent<TDetail = unknown> {
  readonly type: string;
  readonly detail: TDetail | undefined;
  constructor(type: string, init?: CustomEventInit<TDetail>) {
    this.type = type;
    this.detail = init?.detail;
  }
}

class TestElement {
  readonly dataset: Record<string, string> = {};
  textContent = "original";
  placeholder = "original";
  title = "original";
  readonly attributes = new Map<string, string>();
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

class TestSelect extends TestElement {
  value = "";
  readonly options: Array<{ value: string; textContent: string }> = [];
  replaceChildren(...options: Array<{ value: string; textContent: string }>): void {
    this.options.splice(0, this.options.length, ...options);
  }
}

interface Harness {
  readonly runtime: Record<string, unknown>;
  readonly storage: Map<string, string>;
  readonly events: TestCustomEvent[];
  readonly documentListeners: Array<{ type: string; options: unknown }>;
  readonly text: TestElement;
  readonly placeholder: TestElement;
  readonly title: TestElement;
  readonly aria: TestElement;
  readonly select: TestSelect;
  readonly documentElement: { lang: string };
}

function createHarness(selected = "system", system = "zh-CN"): Harness {
  const storage = new Map<string, string>([["appLanguageV1", selected]]);
  const events: TestCustomEvent[] = [];
  const documentListeners: Array<{ type: string; options: unknown }> = [];
  const text = new TestElement(); text.dataset.i18n = "settings";
  const placeholder = new TestElement(); placeholder.dataset.i18nPlaceholder = "shelfSearchPlaceholder";
  const title = new TestElement(); title.dataset.i18nTitle = "news";
  const aria = new TestElement(); aria.dataset.i18nAria = "menu";
  const select = new TestSelect();
  const documentElement = { lang: "" };
  const selectors = new Map<string, TestElement[]>([
    ["[data-i18n]", [text]],
    ["[data-i18n-placeholder]", [placeholder]],
    ["[data-i18n-title]", [title]],
    ["[data-i18n-aria]", [aria]],
    [".app-language-select", [select]],
  ]);
  const document = {
    documentElement,
    querySelectorAll: (selector: string) => selectors.get(selector) ?? [],
    createElement: () => ({ value: "", textContent: "" }),
    addEventListener: (type: string, _listener: unknown, options: unknown) => {
      documentListeners.push({ type, options });
    },
  };
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    navigator: { language: system },
    CustomEvent: TestCustomEvent,
    dispatchEvent: (event: TestCustomEvent) => { events.push(event); return true; },
    ReaderAppI18nRerankerCatalog: RERANKER_CATALOG,
  };
  return { runtime, storage, events, documentListeners, text, placeholder, title, aria, select, documentElement };
}

function install(harness: Harness): AppI18nApi {
  const api = installAppI18n(harness.runtime);
  assert.ok(api);
  return api;
}

test("installer preserves the exact classic global API and deferred DOMContentLoaded hook", () => {
  const harness = createHarness("en");
  const api = install(harness);
  assert.equal(harness.runtime.ReaderAppI18n, api);
  assert.deepEqual(Object.keys(api), [
    "STORAGE_KEY", "apply", "populate", "selectedLanguage", "resolvedLanguage", "setLanguage", "t", "missingKeys",
  ]);
  assert.equal(api.STORAGE_KEY, "appLanguageV1");
  assert.deepEqual(harness.documentListeners, [{ type: "DOMContentLoaded", options: { once: true } }]);
});

test("system locale resolution and release-gated catalogs preserve fallback behavior", () => {
  assert.equal(install(createHarness("system", "zh-HK")).resolvedLanguage(), "zh-TW");
  assert.equal(install(createHarness("system", "zh-SG")).resolvedLanguage(), "zh-CN");
  assert.equal(install(createHarness("system", "pt-BR")).resolvedLanguage(), "pt-BR");
  assert.equal(install(createHarness("system", "fr-CA")).resolvedLanguage(), "fr");
  assert.equal(install(createHarness("bogus", "en-US")).resolvedLanguage(), "bogus");
  const japanese = install(createHarness("ja"));
  assert.equal(japanese.missingKeys("ja").length, 0);
  assert.equal(japanese.t("missing-contract-key"), "⟦missing-contract-key⟧");
  assert.equal(install(createHarness("fr")).t("missing-contract-key"), "missing-contract-key");
});

test("Japanese and Korean release-gated catalogs retain complete English-key coverage", () => {
  const api = install(createHarness("en"));
  for (const locale of ["en", "ja", "ko"]) {
    assert.deepEqual(api.missingKeys(locale), [], `${locale} catalog must remain complete`);
  }
  for (const locale of ["zh-CN", "zh-TW", "fr", "de", "es", "ru", "pt-BR"]) {
    for (const key of ["settings", "news", "libraryQuestion", "syncNow", "about", "semTitle"]) {
      assert.doesNotMatch(install(createHarness(locale)).t(key), /^⟦.+⟧$/);
    }
  }
  assert.equal(api.t("settings"), "Settings");
  assert.match(api.t("semRerankerReady"), /Ready/);
});

test("Chinese statistics quality messages override the English fallback", () => {
  const zhCn = install(createHarness("zh-CN"));
  assert.equal(zhCn.t("statsQualityDwell"), "本时段可能包含空闲时间：阅读时长较长，但统计字数较少。");
  assert.equal(zhCn.t("statsQualityFast"), "本时段平均阅读速度偏高，可能包含快速翻页或重复计数。");
  assert.equal(zhCn.t("statsQualitySlow"), "本时段平均阅读速度偏低，可能包含空闲时间或扫描版 PDF。");
});

test("apply and populate update only the original data attributes and language selector", () => {
  const harness = createHarness("en");
  const api = install(harness);
  api.apply();
  api.populate(harness.select as unknown as HTMLSelectElement);
  assert.equal(harness.documentElement.lang, "en");
  assert.equal(harness.text.textContent, "Settings");
  assert.match(harness.placeholder.placeholder, /Search/);
  assert.equal(harness.title.title, "News");
  assert.equal(harness.aria.attributes.get("aria-label"), "Menu");
  assert.equal(harness.select.options.length, 11);
  assert.equal(harness.select.options[0]?.value, "system");
  assert.equal(harness.select.options[0]?.textContent, "Follow system");
  assert.equal(harness.select.value, "en");
});

test("setLanguage persists valid choices, rejects unknown values, reapplies and dispatches the frozen detail", () => {
  const harness = createHarness("zh-CN");
  const api = install(harness);
  api.setLanguage("ja");
  assert.equal(harness.storage.get("appLanguageV1"), "ja");
  assert.equal(harness.documentElement.lang, "ja");
  assert.deepEqual(harness.events[0]?.detail, { selected: "ja", resolved: "ja" });
  api.setLanguage("not-a-language");
  assert.equal(harness.storage.get("appLanguageV1"), "system");
});

test("required reranker and optional staged catalog shapes fail exactly at install time", () => {
  const missing = createHarness();
  delete missing.runtime.ReaderAppI18nRerankerCatalog;
  assert.throws(() => installAppI18n(missing.runtime), /must load before app-i18n/);

  const invalidStats = createHarness();
  invalidStats.runtime.ReaderAppI18nStatsCatalog = {};
  assert.throws(() => installAppI18n(invalidStats.runtime), /must expose statistics appliers/);

  const invalidNews = createHarness();
  invalidNews.runtime.ReaderAppI18nNewsSurfaceCatalog = {};
  assert.throws(() => installAppI18n(invalidNews.runtime), /must expose a news surface applier/);

  const invalidSemantic = createHarness();
  invalidSemantic.runtime.ReaderAppI18nSemanticRuntimeCatalog = {};
  assert.throws(() => installAppI18n(invalidSemantic.runtime), /must expose a semantic runtime applier/);
});
