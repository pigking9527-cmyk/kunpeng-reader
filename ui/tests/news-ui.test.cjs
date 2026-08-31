const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const script = fs.readFileSync(
  path.join(ui, "generated-ts", "news-ui.js"),
  "utf8",
);
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");
const backend = fs.readFileSync(
  path.join(ui, "..", "src", "newsnow.rs"),
  "utf8",
);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  toggle(value, force) {
    const next = force === undefined ? !this.values.has(value) : Boolean(force);
    if (next) this.values.add(value);
    else this.values.delete(value);
    return next;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.classList = new FakeClassList();
    this.style = { setProperty: () => {} };
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.isConnected = true;
    this.clientWidth = 640;
    this.scrollTop = 0;
    this.value = "";
    this.textContent = "";
    this.innerHTML = "";
    this.disabled = false;
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    if (child) this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  dispatch(name, event = {}) {
    for (const listener of this.listeners.get(name) || []) {
      listener({
        target: this,
        key: "",
        preventDefault() {},
        ...event,
      });
    }
  }

  click() {
    this.dispatch("click");
  }

  focus() {
    this.focused = true;
  }

  reset() {
    this.resetCalled = true;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : "";
    const result = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (child instanceof FakeElement) {
          if (
            className &&
            (child.classList.contains(className) ||
              String(child.className || "")
                .split(/\s+/)
                .includes(className))
          )
            result.push(child);
          visit(child);
        }
      }
    };
    visit(this);
    return result;
  }
}

class FakeDocument {
  constructor(elements = new Map()) {
    this.elements = elements;
    this.body = new FakeElement("body");
  }

  getElementById(id) {
    return this.elements.get(id) || null;
  }

  querySelector(selector) {
    if (selector === ".content-shell")
      return this.elements.get("content-shell") || null;
    return null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

function newsFixture() {
  const ids = [
    "newsnow-toolbar-btn",
    "newsnow-page",
    "newsnow-back",
    "newsnow-refresh",
    "newsnow-gesture-settings",
    "newsnow-source-toggle",
    "newsnow-source-picker",
    "newsnow-source-search",
    "newsnow-custom-source-form",
    "newsnow-custom-source-name",
    "newsnow-custom-source-url",
    "newsnow-custom-source-category",
    "newsnow-custom-source-list",
    "newsnow-custom-source-count",
    "newsnow-source-directory-summary",
    "newsnow-source-provider-filters",
    "newsnow-source-options",
    "newsnow-source-status",
    "newsnow-source-close",
    "newsnow-tieba-bars",
    "newsnow-tieba-add-toggle",
    "newsnow-tieba-bar-form",
    "newsnow-tieba-bar-input",
    "newsnow-tieba-bar-cancel",
    "newsnow-tieba-bar-list",
    "newsnow-tieba-bar-count",
    "newsnow-source-selection",
    "newsnow-layout-list",
    "newsnow-layout-grid",
    "newsnow-order-mixed",
    "newsnow-order-source",
    "newsnow-status",
    "newsnow-feed",
    "newsnow-feed-view",
    "newsnow-reader",
    "newsnow-reader-status",
    "newsnow-reader-back",
    "newsnow-reader-meta",
    "newsnow-reader-title",
    "newsnow-reader-original",
    "newsnow-reader-content",
    "newsnow-categories",
    "newsnow-updated",
    "content-shell",
  ];
  const elements = new Map(ids.map((id) => [id, new FakeElement()]));
  elements.get("newsnow-page").hidden = true;
  elements.get("newsnow-reader").hidden = true;
  elements.get("newsnow-source-picker").hidden = true;
  elements.get("newsnow-tieba-bar-form").hidden = true;
  const root = new FakeDocument(elements);
  const storage = new Map();
  const invocations = [];
  const context = {
    Document: FakeDocument,
    Element: FakeElement,
    HTMLImageElement: FakeElement,
    document: new FakeDocument(),
    URL,
    Intl,
    Date,
    Promise,
    console,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 2,
    clearInterval() {},
    requestAnimationFrame(callback) {
      callback();
      return 3;
    },
    addEventListener() {},
    ReaderNewsGesture: {
      loadEnabled: () => false,
      load: () => [],
      loadPrecision: () => "5",
      matchThreshold: () => 0.78,
    },
    ReaderExperimentalFeatures: {
      enabled: (key) => key === "newsnow" || key === "newsnowHideReturnIcon",
    },
    localStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
    __TAURI__: {
      core: {
        invoke(command, args) {
          invocations.push({ command, args });
          if (command === "newsnow_sources") {
            return Promise.resolve([
              {
                id: "alpha",
                name: "Alpha",
                category: "科技",
                provider: "reader",
                kind: "news",
                defaultEnabled: true,
              },
              {
                id: "beta",
                name: "Beta",
                category: "时事",
                provider: "horizon",
                kind: "advisory",
                defaultEnabled: true,
              },
              {
                id: "gamma",
                name: "Gamma",
                category: "灾害",
                provider: "worldmonitor",
                kind: "earthquake",
                defaultEnabled: false,
              },
              { id: "tieba", name: "贴吧", category: "社区" },
            ]);
          }
          if (command === "newsnow_list" || command === "newsnow_refresh") {
            return Promise.resolve({
              items: [
                {
                  id: "article-1",
                  sourceId: "alpha",
                  source: "Alpha",
                  title: "资讯标题",
                  summary: "资讯摘要",
                  url: "https://example.com/article",
                  publishedAt: "2026-01-01T00:00:00Z",
                },
              ],
            });
          }
          if (command === "newsnow_open_article") {
            return Promise.resolve({
              local: true,
              source: "Alpha",
              title: "资讯标题",
              contentHtml: "<p>离线正文</p>",
            });
          }
          if (command === "app_settings_sync_get")
            return Promise.resolve({ hasNewsSourceSettings: false });
          return Promise.resolve({});
        },
      },
    },
  };
  context.window = context;
  vm.runInNewContext(script, context, { filename: "news-ui.js" });
  return { context, root, elements, storage, invocations };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadBrowserGestureApi() {
  const context = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(ui, "generated-ts", "news-gesture.js"), "utf8"),
    context,
    { filename: "news-gesture.js" },
  );
  return context.ReaderNewsGesture;
}

// `news-gesture.js` is loaded as a classic browser script.  The root package is
// ESM now, so CommonJS `require()` correctly yields no named module exports;
// exercise the production global API instead of testing a loader-only branch.
const gestures = loadBrowserGestureApi();

test("NewsNow has a shelf toolbar entry and an independently mounted news page", () => {
  assert.match(html, /id="newsnow-toolbar-btn"[^>]*hidden/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="newsnow-back"/);
  assert.match(
    html,
    /<div class="newsnow-toolbar-actions">[\s\S]*?<div class="newsnow-actions">[\s\S]*?<span[\s\S]*?id="newsnow-updated"/,
  );
  assert.match(
    html,
    /id="newsnow-order-source"[\s\S]*?<button[\s\S]*?id="newsnow-back"/,
  );
  assert.doesNotMatch(html, /<header class="newsnow-head">/);
  assert.doesNotMatch(backend, /正在显示本地缓存，后台正在更新/);
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<\/section>\s*<section[\s\S]*?id="newsnow-reader"/);
  assert.match(
    html,
    /<script src="generated-ts\/news-layout-rules\.js"><\/script>\s*<script src="generated-ts\/news-ui\.js"><\/script>/,
  );
  assert.doesNotMatch(
    html,
    /<script src="generated-ts\/news-rules\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /class="newsnow-title-row"/);
  assert.doesNotMatch(html, />READING BRIEF</);
  assert.doesNotMatch(html, />今日资讯</);
  assert.doesNotMatch(html, /按时间归并的轻量资讯流/);
  assert.doesNotMatch(html, /id="newsnow-source-summary"/);
  assert.doesNotMatch(
    html,
    /<div class="newsnow-layout-control"[^>]*>\s*<span[^>]*>布局<\/span>/,
  );
});

test("NewsNow is always available while its detailed local options remain configurable", () => {
  const experiments = fs.readFileSync(
    path.join(ui, "generated-ts", "experimental-features.js"),
    "utf8",
  );
  assert.doesNotMatch(html, /id="experimental-newsnow"(?![-\w])/);
  assert.match(html, /id="experimental-newsnow-gear"/);
  assert.match(
    html,
    /id="newsnow-settings-modal"[\s\S]*?class="modal settings-detail-modal"/,
  );
  assert.match(html, /id="newsnow-settings-close"/);
  assert.match(html, /id="experimental-newsnow-prefetch"/);
  assert.match(html, /id="experimental-newsnow-hide-return-icon"/);
  assert.match(
    html,
    /<section class="experimental-settings" aria-label="资讯">/,
  );
  assert.doesNotMatch(html, /<div class="fp-title">实验室<\/div>/);
  assert.match(
    experiments,
    /const EXPERIMENTAL_FEATURE_DEFAULTS = Object\.freeze\(\{[\s\S]*?newsnowPrefetch: true,[\s\S]*?newsnowHideReturnIcon: false[\s\S]*?\}\)/,
  );
  assert.match(experiments, /if \(key === "newsnow"\) return true;/);
  assert.match(experiments, /set\("newsnowPrefetch", prefetch\.checked\)/);
  assert.match(
    experiments,
    /set\("newsnowHideReturnIcon", hideReturnIcon\.checked\)/,
  );
  assert.match(experiments, /settingsModal\.classList\.add\("show"\)/);
  assert.match(experiments, /settingsModal\.classList\.remove\("show"\)/);
  assert.doesNotMatch(experiments, /fp-settings-modal/);
  assert.match(experiments, /"kunpeng\.reader\.experimental-features\.v1"/);
});

test("NewsNow keeps the local article reader surface in the original page", () => {
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(html, /id="newsnow-reader-content"/);
  assert.match(html, /id="newsnow-reader-original"/);
  assert.doesNotMatch(html, /id="newsnow-reader-frame"/);
});

test("NewsNow keeps its return surface usable while external pages load", () => {
  assert.match(backend, /const ARTICLE_LOADING_EVENT: &str = "newsnow-article-loading"/);
  assert.match(backend, /const ARTICLE_READY_EVENT: &str = "newsnow-article-ready"/);
  assert.match(backend, /\.on_page_load\(move \|webview, payload\|/);
  assert.match(backend, /ArticleWebviewPhase::Loading[\s\S]*?webview\.show\(\)/);
  assert.match(backend, /ArticleWebviewPhase::Ready[\s\S]*?webview\.show\(\)/);
  assert.match(backend, /Duration::from_millis\(700\)/);
  assert.match(script, /newsnow-article-loading/);
  assert.match(script, /newsnow-article-ready/);
  assert.match(script, /正在加载网页原文…可随时返回。/);
});

test("News original-page return icon can be hidden while gesture close remains available", () => {
  const experiments = fs.readFileSync(
    path.join(ui, "generated-ts", "experimental-features.js"),
    "utf8",
  );
  assert.match(html, /data-i18n="newsHideReturnIcon">关闭返回图标/);
  assert.match(html, /data-i18n="newsHideReturnIconNote"/);
  assert.match(experiments, /newsnowHideReturnIcon: false/);
  assert.match(backend, /pub hide_return_icon: bool/);
  assert.match(backend, /const hideReturnIcon = __KUNPENG_HIDE_RETURN_ICON__;/);
  assert.match(
    backend,
    /if \(hideReturnIcon \|\| document\.getElementById\("kunpeng-news-return"\)\) return;/,
  );
  assert.match(backend, /也可以通过手势关闭页面/);
  assert.match(
    backend,
    /if request\.hide_return_icon\s*\{\s*"true"\s*\}\s*else\s*\{\s*"false"\s*\}/,
  );
});

test("NewsNow syncs its bounded source selection and optional Tieba bar names", () => {
  assert.match(html, /id="newsnow-source-picker"/);
  assert.match(html, /id="newsnow-source-search"/);
  assert.match(html, /<details\s+id="newsnow-custom-sources"[^>]*>/);
  assert.match(html, /<summary class="newsnow-custom-sources-summary">/);
  assert.match(html, /id="newsnow-custom-source-form"/);
  assert.match(html, /id="newsnow-custom-source-name"[^>]*maxlength="80"/);
  assert.match(html, /id="newsnow-custom-source-url"[^>]*type="url"[^>]*maxlength="2048"/);
  assert.match(html, /id="newsnow-custom-source-category"[^>]*maxlength="48"/);
  assert.match(html, /id="newsnow-custom-source-list"/);
  assert.match(html, /id="newsnow-source-directory-summary"/);
  assert.match(html, /id="newsnow-source-provider-filters"/);
  assert.match(html, /id="newsnow-source-options"[^>]*data-layout="catalog"/);
  assert.doesNotMatch(html, /id="newsnow-source-apply"/);
  assert.doesNotMatch(html, /id="newsnow-source-reset"/);
  assert.match(html, /id="newsnow-tieba-bar-form"/);
  assert.doesNotMatch(html, /id="newsnow-tieba-enabled"/);
  assert.match(html, /id="newsnow-tieba-bar-input"/);
  assert.match(html, /id="newsnow-tieba-add-toggle"/);
  assert.match(html, /id="newsnow-tieba-bar-cancel"/);
  assert.match(html, /id="newsnow-tieba-bar-list"/);
});

test("source management keeps one scalable provider and category directory", () => {
  assert.match(html, /class="newsnow-source-directory"/);
  assert.match(html, /class="newsnow-source-provider-filters"/);
  assert.match(styles, /\.newsnow-source-options\s*\{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\)/s);
  assert.match(styles, /\.newsnow-source-group\[data-provider="horizon"\]/);
  assert.match(styles, /\.newsnow-source-group\[data-provider="worldmonitor"\]/);
  assert.match(styles, /\.newsnow-source-group\[data-provider="custom"\]/);
  assert.match(styles, /\.newsnow-custom-sources-summary\s*\{/);
  assert.match(styles, /\.newsnow-custom-sources-content\s*\{/);
  assert.match(styles, /\.newsnow-source-choice::after\s*\{[\s\S]*?content: attr\(data-source-tooltip\)/);
  assert.match(script, /const sourceDescription = \(source\) =>/);
  assert.match(script, /label\.dataset\.sourceTooltip = description/);
  assert.match(script, /label\.dataset\.gestureInfoStop = "true"/);
  assert.doesNotMatch(script, /sourceHoverDescription/);
  assert.doesNotMatch(script, /gestureInfoTitle/);
  assert.doesNotMatch(script, /newsnow_source_availability/);
  assert.doesNotMatch(html, /newsnow-source-check/);
  assert.doesNotMatch(html, /newsnow-source-health-status/);
  assert.doesNotMatch(html, /newsnow-source-pipeline/);
  assert.doesNotMatch(html, /勾选后会加入资讯/);
  assert.doesNotMatch(html, /newsnow-source-picker-actions/);
});

test("source management is an independent page that hides and restores the news feed", () => {
  assert.match(html, /id="newsnow-feed-view" class="newsnow-feed-view"/);
  assert.match(html, /id="newsnow-source-status"/);
  assert.match(html, /id="newsnow-source-close"[^>]*>\s*←\s*<\/button>/);
  assert.match(
    styles,
    /\.newsnow-feed-view\[hidden\],\s*\.newsnow-source-picker\[hidden\]\s*\{\s*display: none/,
  );
  assert.match(
    styles,
    /\.newsnow-source-picker\s*\{[^}]*width: 100%;[^}]*border: 0;[^}]*box-shadow: none/s,
  );
  assert.doesNotMatch(html, /newsnow-source-picker-actions/);
  assert.doesNotMatch(styles, /\.newsnow-source-picker-actions/);
});

test("classic NewsNow installer opens feeds, persists display choices, and restores source pages", async () => {
  const { context, root, elements, storage, invocations } = newsFixture();
  const uiApi = context.ReaderNewsUI;
  const controller = uiApi.init({ root });

  assert.equal(
    uiApi.safeHttpUrl("https://example.com/article"),
    "https://example.com/article",
  );
  assert.equal(uiApi.safeHttpUrl("http://example.com/article"), "");
  assert.deepEqual(
    Array.from(
      uiApi.allowedSourceIds(
        ["beta", "missing", "beta", "alpha"],
        [
          { id: "alpha", defaultEnabled: true },
          { id: "beta", defaultEnabled: true },
        ],
      ),
    ),
    ["beta", "alpha"],
  );

  await controller.open();
  await settle();
  assert.equal(elements.get("newsnow-page").hidden, false);
  assert.equal(elements.get("content-shell").hidden, true);
  assert.equal(elements.get("newsnow-feed").children.length, 1);
  assert.deepEqual(
    plain(
      invocations.filter(({ command }) => command === "newsnow_list")[0].args
        .request,
    ),
    { sourceIds: ["alpha", "beta"], tiebaBars: [], customSources: [] },
  );

  elements.get("newsnow-layout-grid").click();
  elements.get("newsnow-order-source").click();
  assert.equal(controller.layout(), "grid");
  assert.equal(controller.order(), "source");
  assert.equal(storage.get("kunpeng.reader.news.layout.v1"), "grid");
  assert.equal(storage.get("kunpeng.reader.news.order.v1"), "source");
  assert.equal(
    elements.get("newsnow-feed").classList.contains("newsnow-feed-grid"),
    true,
  );
  assert.equal(
    elements.get("newsnow-feed").classList.contains("newsnow-feed-by-source"),
    true,
  );

  elements.get("newsnow-source-toggle").click();
  await settle();
  assert.equal(elements.get("newsnow-feed-view").hidden, true);
  assert.equal(elements.get("newsnow-source-picker").hidden, false);
  assert.equal(
    elements
      .get("newsnow-page")
      .classList.contains("newsnow-source-page-active"),
    true,
  );
  assert.equal(
    elements.get("newsnow-source-directory-summary").textContent,
    "共 3 个来源 · 3 个提供方 · 当前显示 3 个",
  );
  assert.deepEqual(
    Array.from(elements.get("newsnow-source-provider-filters").children).map(
      (button) => button.dataset.provider,
    ),
    ["all", "reader", "horizon", "worldmonitor"],
  );
  elements.get("newsnow-custom-source-name").value = "不安全地址";
  elements.get("newsnow-custom-source-url").value = "http://example.com/feed.xml";
  elements.get("newsnow-custom-source-category").value = "科技";
  elements.get("newsnow-custom-source-form").dispatch("submit");
  assert.equal(elements.get("newsnow-custom-source-count").textContent, "已添加 0 / 200");
  elements.get("newsnow-custom-source-name").value = "我的 RSS";
  elements.get("newsnow-custom-source-url").value = "https://example.com/atom.xml";
  elements.get("newsnow-custom-source-category").value = "科技";
  elements.get("newsnow-custom-source-form").dispatch("submit");
  assert.equal(elements.get("newsnow-custom-source-count").textContent, "已添加 1 / 200");
  assert.equal(
    elements.get("newsnow-source-directory-summary").textContent,
    "共 4 个来源 · 4 个提供方 · 当前显示 4 个",
  );
  assert.equal(
    elements
      .get("newsnow-source-provider-filters")
      .children.some((button) => button.dataset.provider === "custom"),
    true,
  );
  assert.deepEqual(
    plain(await controller.sourceRequest()),
    {
      sourceIds: ["alpha", "beta", "custom-rss-1fnz5cq1egon7w"],
      tiebaBars: [],
      customSources: [
        {
          id: "custom-rss-1fnz5cq1egon7w",
          name: "我的 RSS",
          url: "https://example.com/atom.xml",
          category: "科技",
        },
      ],
    },
  );
  const custom = elements
    .get("newsnow-source-provider-filters")
    .children.find((button) => button.dataset.provider === "custom");
  custom.click();
  assert.equal(elements.get("newsnow-source-options").children.length, 1);
  assert.equal(
    elements.get("newsnow-source-options").children[0].dataset.category,
    "科技",
  );
  const customChoice = elements.get("newsnow-source-options").children[0].children[1].children[0];
  assert.equal(customChoice.dataset.gestureInfoTitle, undefined);
  assert.equal(customChoice.dataset.gestureInfo, undefined);
  assert.match(
    customChoice.dataset.sourceTooltip,
    /我的 RSS：这是你添加的自定义订阅；是否跨设备保存由账户页的“自定义 RSS \/ Atom 订阅”开关决定。主要覆盖科技分类，内容形式为RSS \/ Atom。/,
  );
  const worldmonitor = elements
    .get("newsnow-source-provider-filters")
    .children.find((button) => button.dataset.provider === "worldmonitor");
  worldmonitor.click();
  assert.equal(elements.get("newsnow-source-options").children.length, 1);
  assert.equal(
    elements.get("newsnow-source-options").children[0].dataset.provider,
    "worldmonitor",
  );
  assert.equal(
    elements.get("newsnow-source-options").children[0].children[0].textContent,
    "WorldMonitor · 灾害",
  );
  let customToggle = elements.get("newsnow-custom-source-list").children[0].children[0];
  customToggle.checked = false;
  customToggle.dispatch("change");
  assert.deepEqual(
    plain(await controller.sourceRequest()),
    { sourceIds: ["alpha", "beta"], tiebaBars: [], customSources: [] },
  );
  customToggle = elements.get("newsnow-custom-source-list").children[0].children[0];
  customToggle.checked = true;
  customToggle.dispatch("change");
  assert.equal(
    plain(await controller.sourceRequest()).customSources.length,
    1,
  );
  elements.get("newsnow-custom-source-list").children[0].children[2].click();
  assert.equal(elements.get("newsnow-custom-source-count").textContent, "已添加 0 / 200");
  assert.deepEqual(
    plain(await controller.sourceRequest()),
    { sourceIds: ["alpha", "beta"], tiebaBars: [], customSources: [] },
  );
  const reopenSources = controller.gestureReopen();
  controller.gestureBack();
  assert.equal(elements.get("newsnow-source-picker").hidden, true);
  reopenSources();
  await settle();
  assert.equal(elements.get("newsnow-source-picker").hidden, false);
  elements.get("newsnow-source-close").click();
  assert.equal(elements.get("newsnow-feed-view").hidden, false);
  assert.equal(elements.get("newsnow-source-picker").hidden, true);
  assert.equal(
    elements
      .get("newsnow-page")
      .classList.contains("newsnow-source-page-active"),
    false,
  );
});

test("classic NewsNow installer opens local articles and returns to the feed", async () => {
  const { context, root, elements, invocations } = newsFixture();
  const controller = context.ReaderNewsUI.init({ root });
  await controller.open();
  await settle();
  controller.render([
    {
      id: "article-1",
      sourceId: "alpha",
      source: "Alpha",
      title: "资讯标题",
      summary: "资讯摘要",
      url: "https://example.com/article",
      publishedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  const card = elements.get("newsnow-feed").querySelector(".newsnow-card");
  assert.ok(
    card,
    `feed rendering should expose the loaded article as a clickable card; children=${elements
      .get("newsnow-feed")
      .children.map((child) => child.className)
      .join(",")}`,
  );
  card.click();
  await settle();

  assert.equal(elements.get("newsnow-reader").hidden, false);
  assert.equal(elements.get("newsnow-page").hidden, true);
  assert.equal(elements.get("newsnow-reader-title").textContent, "资讯标题");
  assert.equal(
    elements.get("newsnow-reader-content").innerHTML,
    "<p>离线正文</p>",
  );
  assert.deepEqual(
    plain(
      invocations.find(({ command }) => command === "newsnow_open_article").args
        .request,
    ),
    {
      url: "https://example.com/article",
      title: "资讯标题",
      summary: "资讯摘要",
      publishedAt: "2026-01-01T00:00:00Z",
      gestureEnabled: false,
      gesturePoints: [],
      gestureThreshold: 0.78,
      hideReturnIcon: true,
    },
  );

  const reopenArticle = controller.gestureReopen();
  controller.gestureBack();
  assert.equal(elements.get("newsnow-reader").hidden, true);
  reopenArticle();
  await settle();
  assert.equal(elements.get("newsnow-reader").hidden, false);
  assert.equal(elements.get("newsnow-reader-title").textContent, "资讯标题");

  elements.get("newsnow-reader-back").click();
  assert.equal(elements.get("newsnow-reader").hidden, true);
  assert.equal(elements.get("newsnow-page").hidden, false);
  assert.ok(
    invocations.some(({ command }) => command === "newsnow_close_article"),
  );
});

test("Gesture settings live in common settings and close news, library, and reader surfaces", () => {
  const gestureUi = fs.readFileSync(
    path.join(ui, "generated-ts", "gesture-ui.js"),
    "utf8",
  );
  const readerGesture = fs.readFileSync(
    path.join(ui, "generated-ts", "reader-gesture.js"),
    "utf8",
  );
  const readerHtml = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
  const readerPageTestSource = require("./reader-page-test-source.cjs");
  const readerPage = readerPageTestSource.compact;
  const readerPageSource = readerPageTestSource.source;
  const readerMessage = fs.readFileSync(
    path.join(ui, "generated-ts", "reader-message.js"),
    "utf8",
  );
  assert.match(
    html,
    /id="gesture-gear"[^>]*fp-settings-detail[\s\S]*?data-i18n="settingsManage"[\s\S]*?<\/button>/,
  );
  assert.match(html, /id="gesture-settings-modal"/);
  assert.doesNotMatch(html, /id="gesture-settings-close"/);
  assert.match(html, /id="set-gesture-enabled"[\s\S]*?type="checkbox"/);
  assert.doesNotMatch(html, /id="gesture-manager-enabled"/);
  assert.match(
    html,
    /id="gesture-settings-toggle"[^>]*aria-controls="gesture-settings-content"[^>]*aria-expanded="false"[\s\S]*?手势设置[\s\S]*?⌄/,
  );
  assert.match(
    html,
    /id="gesture-editor-close"[^>]*aria-label="收起手势编辑器"/,
  );
  assert.match(html, /id="gesture-settings-content"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-global-precision-toggle"[^>]*aria-controls="gesture-global-precision-settings"/,
  );
  assert.match(html, /id="gesture-global-precision-settings"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-global-precision"[\s\S]*?type="range"[\s\S]*?min="1"[\s\S]*?max="10"[\s\S]*?step="1"/,
  );
  assert.match(
    html,
    /id="gesture-hint-enabled"[\s\S]*?type="checkbox"[\s\S]*?role="switch"/,
  );
  assert.match(html, /id="gesture-hint-settings-toggle"[^>]*>\s*手势提示/);
  assert.match(html, /id="gesture-hint-settings"[^>]*hidden/);
  assert.match(
    html,
    /id="gesture-new"[\s\S]*?class="gesture-create-button"[^>]*>\s*创建手势\s*<\/button>/,
  );
  assert.match(
    html,
    /id="gesture-global-precision-settings"[\s\S]*?id="gesture-hint-enabled"/,
  );
  assert.match(
    styles,
    /\.gesture-settings-toggle \{[^}]*background: transparent;[^}]*font-size: 22px/,
  );
  assert.match(
    styles,
    /\.fp-settings-content::\-webkit-scrollbar-button,[\s\S]*?\.gesture-settings-card::\-webkit-scrollbar-button \{[^}]*display: none !important;[^}]*width: 0 !important;[^}]*height: 0 !important/,
  );
  assert.match(
    styles,
    /\.fp-settings-content::\-webkit-scrollbar-thumb,[\s\S]*?\.gesture-settings-card::\-webkit-scrollbar-thumb \{/,
  );
  assert.match(
    styles,
    /\.gesture-settings-content \{[^}]*border-left: 2px solid/,
  );
  assert.match(
    styles,
    /\.gesture-disclosure-toggle \{[^}]*font-size: 16px;[^}]*font-weight: 650/,
  );
  assert.match(
    styles,
    /\.gesture-hint-settings-entry \{[^}]*font-size: 16px;[^}]*font-weight: 650/,
  );
  assert.match(
    styles,
    /\.gesture-disclosure \{[^}]*border: 0;[^}]*background: transparent/,
  );
  assert.match(
    html,
    /id="gesture-action-choice"[\s\S]*?id="gesture-search"[\s\S]*?id="gesture-new"[\s\S]*?id="gesture-list"/,
  );
  assert.match(
    html,
    /id="gesture-editor"[\s\S]*?id="gesture-editor-options"[\s\S]*?id="gesture-editor-title"[\s\S]*?id="gesture-pad"[\s\S]*?id="gesture-save"/,
  );
  assert.match(html, /id="gesture-search"/);
  assert.doesNotMatch(html, /id="gesture-scope-filters"/);
  assert.match(html, /id="gesture-list"/);
  assert.match(html, /id="gesture-editor"[^>]*hidden/);
  assert.doesNotMatch(html, /id="gesture-scope-options"/);
  assert.doesNotMatch(html, /id="gesture-scope" type="hidden"/);
  assert.match(
    html,
    /id="gesture-action-choice"[\s\S]*?class="gesture-choice-section"[\s\S]*?hidden/,
  );
  assert.match(
    html,
    /id="gesture-editor-options"[\s\S]*?class="gesture-editor-options"[\s\S]*?hidden/,
  );
  assert.match(
    html,
    /id="gesture-action-options"[\s\S]*?class="gesture-action-options"/,
  );
  assert.match(html, /data-gesture-action="back"/);
  assert.match(
    html,
    /data-gesture-action="back"[\s\S]*?<strong>✕ 关闭<\/strong\s*>[\s\S]*?不执行返回或后退/,
  );
  assert.doesNotMatch(html, /返回／关闭当前页|返回上一级/);
  assert.match(
    html,
    /id="gesture-action-hint" class="gesture-auto-scope-note"/,
  );
  assert.match(html, /id="gesture-action"[\s\S]*?type="hidden"/);
  assert.doesNotMatch(html, /id="gesture-test"/);
  assert.match(html, /id="gesture-precision-global"[^>]*value="global"/);
  assert.match(
    html,
    /id="gesture-precision-independent"[^>]*value="independent"/,
  );
  assert.doesNotMatch(html, /id="gesture-settings-enabled"/);
  assert.match(
    html,
    /id="gesture-precision"[\s\S]*?type="range"[\s\S]*?min="1"[\s\S]*?max="10"[\s\S]*?step="1"/,
  );
  assert.match(
    html,
    /<script src="generated-ts\/news-ui\.js"><\/script>[\s\S]*?<script src="generated-ts\/gesture-ui\.js"><\/script>/,
  );
  assert.doesNotMatch(html, /id="newsnow-gesture-enabled"/);
  assert.doesNotMatch(html, /id="newsnow-gesture-precision"/);
  assert.match(html, /<canvas[\s\S]*?id="newsnow-gesture-trail"[^>]*hidden/);
  assert.match(gestureUi, /kunpeng\.reader\.gesture-manager\.v1/);
  assert.match(gestureUi, /syncLegacyGesture/);
  assert.match(gestureUi, /kunpeng\.reader\.gesture-manager\.enabled\.v1/);
  assert.match(
    gestureUi,
    /gestureSettings: normalizedGestureSettingsSyncPayload\(\)/,
  );
  assert.match(gestureUi, /app_settings_sync_get/);
  assert.match(gestureUi, /app_settings_sync_save/);
  assert.match(gestureUi, /hasGestureSettings/);
  assert.match(gestureUi, /profilesInitialized: true/);
  assert.match(gestureUi, /isLegacyUnconfiguredEmptyGestureSettings/);
  assert.match(gestureUi, /app-settings-synced/);
  const enabledDefault = gestureUi.slice(
    gestureUi.indexOf("function loadManagerEnabled"),
    gestureUi.indexOf("function saveManagerEnabled"),
  );
  assert.match(enabledDefault, /return true;/);
  assert.match(
    gestureUi,
    /function collapseNewGestureDisclosures\(\) \{[\s\S]*?settingsOpen = false;[\s\S]*?globalPrecisionSettingsOpen = false;[\s\S]*?hintSettingsOpen = false;/,
  );
  assert.match(
    gestureUi,
    /function openEditor\(profile\) \{\s*if \(!profile\) collapseNewGestureDisclosures\(\);/,
  );
  assert.match(
    gestureUi,
    /newButton\.addEventListener\("click", \(\) => \{\s*collapseNewGestureDisclosures\(\);\s*openEditor\(\);/,
  );
  assert.match(
    gestureUi,
    /function saveEditor\(\) \{[\s\S]*?saveProfiles\(\);\s*training = \[\];\s*editing = next;\s*gestureApi\.draw\(pad, \[\]\);/,
  );
  const gestureConflict = gestureUi.slice(
    gestureUi.indexOf("function conflictFor"),
    gestureUi.indexOf("function deleteProfile"),
  );
  assert.match(
    gestureConflict,
    /function profileBoundToAction\(profile\)[\s\S]*?other\.action === profile\.action/,
  );
  assert.match(
    gestureConflict,
    /const actionOwner = profileBoundToAction\(next\);[\s\S]*?一个功能只能保留一条手势[\s\S]*?return;/,
  );
  assert.doesNotMatch(
    gestureConflict.slice(
      gestureConflict.indexOf("function conflictFor"),
      gestureConflict.indexOf("function profileBoundToAction"),
    ),
    /other\.action === profile\.action/,
  );
  assert.match(
    gestureUi,
    /profile\.points\.length === gestureApi\.SAMPLE_COUNT/,
  );
  assert.match(gestureUi, /return false;/);
  assert.match(
    gestureUi,
    /precisionMode:\s*source\.precisionMode === "global"/,
  );
  assert.match(gestureUi, /global\.ReaderNewsUI\?\.instance/);
  assert.match(gestureUi, /ReaderLibraryAiEntry\?\.close/);
  assert.match(gestureUi, /optional\("fp-settings-modal"\)/);
  assert.match(gestureUi, /commonSettings\.classList\.remove\("show"\)/);
  assert.match(gestureUi, /optional\("stats-modal"\)/);
  assert.match(gestureUi, /ReaderStatsUI\?\.close\?\.\(\)/);
  assert.match(gestureUi, /querySelector\("\.content-shell"\)/);
  assert.match(gestureUi, /invoke\("main_window_close"\)/);
  assert.match(gestureUi, /event\.button !== 2/);
  assert.match(
    gestureUi,
    /pad\.addEventListener\("pointermove", movePointerTraining/,
  );
  assert.match(
    gestureUi,
    /pad\.addEventListener\("lostpointercapture", cancelTraining\)/,
  );
  assert.match(gestureUi, /"PointerEvent" in global/);
  assert.doesNotMatch(gestureUi, /test\.addEventListener\("click"/);
  assert.match(gestureUi, /gestureApi\.similarity\(profile\.points, points\)/);
  assert.match(gestureUi, /相似度较高/);
  assert.match(
    script,
    /gestureSurface: \(\) => !reader\.hidden \? reader/,
  );
  assert.match(
    script,
    /function gestureBack\(\) \{[\s\S]*?if \(!reader\.hidden\) closeArticle/,
  );
  assert.match(
    script,
    /function gestureReopen\(\) \{[\s\S]*?currentArticleItem[\s\S]*?openArticle\(item, \{ returnToIntelligence \}\)[\s\S]*?loadSources\(\)\.then\(openSourcePicker\)/,
  );
  assert.match(
    gestureUi,
    /news\.gestureReopen\?\.\(\) \|\| \(\(\) => void news\.open/,
  );
  assert.match(
    readerHtml,
    /<script src="generated-ts\/news-gesture\.js"><\/script>[\s\S]*?<script src="generated-ts\/reader-gesture\.js"><\/script>/,
  );
  assert.match(
    readerGesture,
    /typeof global\.closeReaderWindow === "function"[\s\S]*?root\.getElementById\("win-close"\)\?\.click\(\)/,
  );
  assert.match(
    readerPage,
    /readerGestureDrawing=true;readerGestureSource=source;readerGesturePointerId=source==='pointer'&&e instanceof PointerEvent\?e\.pointerId:null/,
  );
  assert.match(
    readerPage,
    /document\.documentElement\.setPointerCapture\(e\.pointerId\)/,
  );
  assert.match(readerPage, /readerGesture:\{phase,x:e\.clientX,y:e\.clientY\}/);
  assert.match(readerPageSource, /ToSwak.*MouseEvent/);
  assert.match(readerMessage, /"readerGesture"/);
  assert.match(styles, /\.gesture-precision-control input\[type="range"\]/);
  assert.match(styles, /\.gesture-create-button/);
  assert.match(styles, /\.gesture-manager-card\.is-editor-open/);

  const reference = [
    { x: 0, y: 0 },
    { x: 70, y: 10 },
    { x: 30, y: 60 },
    { x: 100, y: 100 },
  ];
  const translatedAndScaled = reference.map((point) => ({
    x: point.x * 2 + 30,
    y: point.y * 2 - 10,
  }));
  const different = [
    { x: 0, y: 0 },
    { x: 0, y: 100 },
    { x: 100, y: 100 },
  ];
  assert.equal(gestures.normalize(reference).length, gestures.SAMPLE_COUNT);
  assert.ok(
    gestures.similarity(reference, translatedAndScaled) >=
      gestures.MATCH_THRESHOLD,
  );
  assert.ok(
    gestures.similarity(reference, different) < gestures.MATCH_THRESHOLD,
  );
  assert.ok(
    gestures.similarity(reference, reference.slice().reverse()) <
      gestures.matchThreshold("5"),
  );
  const downThenRight = [
    { x: 0, y: 0 },
    { x: 0, y: 110 },
    { x: 90, y: 110 },
  ];
  const downThenShortRight = [
    { x: 20, y: 10 },
    { x: 20, y: 150 },
    { x: 35, y: 150 },
  ];
  const rightThenDown = [
    { x: 0, y: 0 },
    { x: 90, y: 0 },
    { x: 90, y: 110 },
  ];
  assert.deepEqual(
    gestures.directionSequence(downThenRight),
    gestures.directionSequence(downThenShortRight),
  );
  assert.ok(
    gestures.similarity(downThenRight, downThenShortRight) >=
      gestures.matchThreshold("10"),
  );
  assert.ok(
    gestures.similarity(downThenRight, rightThenDown) <
      gestures.matchThreshold("5"),
  );
  assert.equal(
    gestures.similarity(downThenRight, [
      { x: 0, y: 0 },
      { x: 0, y: 8 },
      { x: 5, y: 8 },
    ]),
    0,
  );
  assert.equal(
    gestures.normalize([
      { x: 0, y: 0 },
      { x: 24, y: 24 },
    ]).length,
    gestures.SAMPLE_COUNT,
  );
  const storage = new Map();
  const local = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  assert.equal(gestures.loadEnabled(local), false);
  assert.equal(gestures.saveEnabled(true, local), true);
  assert.equal(gestures.savePrecision("10", local), "10");
  assert.equal(gestures.loadPrecision(local), "10");
  assert.equal(gestures.loadPrecision({ getItem: () => "low" }), "3");
  assert.equal(gestures.loadPrecision({ getItem: () => "medium" }), "5");
  assert.equal(gestures.loadPrecision({ getItem: () => "high" }), "7");
  assert.ok(gestures.matchThreshold("1") < gestures.matchThreshold("5"));
  assert.ok(gestures.matchThreshold("10") > gestures.matchThreshold("5"));
});

test("Close gesture dismisses gesture editing before closing settings and preserves undo state", () => {
  const gestureUi = fs.readFileSync(
    path.join(ui, "generated-ts", "gesture-ui.js"),
    "utf8",
  );
  assert.match(
    gestureUi,
    /gestureSettings\.contains\(target\)[\s\S]*?if \(!editor\.hidden\)[\s\S]*?returnToSettingsOverview\(\);[\s\S]*?runCloseOrUndo\([\s\S]*?"手势设置"[\s\S]*?closeSettings/,
  );
  assert.match(
    gestureUi,
    /function returnToSettingsOverview\(\) \{[\s\S]*?captureEditorSnapshot\(\);[\s\S]*?closeEditor\(\);[\s\S]*?rememberClosedPage\([\s\S]*?restoreEditorSnapshot\(snapshot\)/,
  );
});

test("Gesture feedback, reopen, and contextual information are integrated across the shell and reader", () => {
  const gestureUi = fs.readFileSync(
    path.join(ui, "generated-ts", "gesture-ui.js"),
    "utf8",
  );
  const readerGesture = fs.readFileSync(
    path.join(ui, "generated-ts", "reader-gesture.js"),
    "utf8",
  );
  const app = fs.readFileSync(path.join(ui, "generated-ts", "app.js"), "utf8");
  assert.match(html, /data-gesture-action="book_info"/);
  assert.match(
    html,
    /data-gesture-action="book_info"[^>]*>[\s\S]*?信息提取／说明/,
  );
  assert.match(html, /data-gesture-action="undo_last"/);
  assert.match(html, /id="gesture-info-modal"[^>]*role="dialog"/);
  assert.match(html, /id="gesture-info-title"/);
  assert.match(html, /id="gesture-info-body"/);
  assert.match(html, /id="gesture-info-close"/);
  assert.match(
    html,
    /id="stats-modal"[^>]*data-gesture-info-title="阅读统计"[^>]*data-gesture-info=/,
  );
  assert.match(
    html,
    /id="library-ai-page"[^>]*data-gesture-info-title="书库问答"[^>]*data-gesture-info=/,
  );
  assert.match(
    html,
    /id="newsnow-page"[^>]*data-gesture-info-title="资讯"[^>]*data-gesture-info=/,
  );
  assert.match(
    html,
    /id="newsnow-source-picker"[^>]*data-gesture-info-title="管理资讯来源"[^>]*data-gesture-info=/,
  );
  assert.match(html, /id="gesture-hint-font-size"/);
  assert.match(html, /id="gesture-hint-background-enabled"/);
  assert.match(
    html,
    /gesture-hint-background-switch"[\s\S]*?role="switch"[\s\S]*?id="gesture-hint-background-state"/,
  );
  assert.match(html, /id="gesture-hint-background"/);
  assert.match(html, /id="gesture-hint-background-reset"[^>]*>\s*恢复默认/);
  assert.match(html, /id="gesture-hint-background-presets"/);
  assert.match(
    html,
    /id="gesture-hint-color-picker-toggle"[^>]*aria-label="打开背景色盘"/,
  );
  assert.match(
    html,
    /id="gesture-hint-background"[^>]*class="gesture-hint-native-color-input"[^>]*type="color"/,
  );
  assert.match(
    html,
    /id="gesture-hint-quick-color-add"[^>]*aria-label="添加当前颜色为快捷色"[^>]*hidden[^>]*>\s*\+/,
  );
  assert.match(html, /id="gesture-hint-shape-rect"[^>]*aria-pressed="true"/);
  assert.match(
    html,
    /id="gesture-hint-shape-freeform"[^>]*aria-pressed="false"/,
  );
  assert.match(html, /id="gesture-hint-preview-path"/);
  assert.doesNotMatch(html, /gesture-hint-frame-draw/);
  assert.match(html, /id="gesture-hint-background"[^>]*type="color"/);
  assert.doesNotMatch(html, /gesture-hint-quick-color-editor/);
  assert.match(html, />\s*20px\s*<\/output>/);
  assert.match(html, />\s*60%\s*<\/output>/);
  assert.match(html, /id="gesture-hint-opacity"/);
  assert.match(html, /id="gesture-hint-preview-text"/);
  assert.match(html, /拖动提示文字可调整显示位置/);
  assert.match(html, /id="gesture-action-search"/);
  assert.match(html, /id="gesture-action-empty"[^>]*hidden/);
  assert.match(gestureUi, /get\("gesture-action-choice"\)/);
  assert.match(gestureUi, /actionChoice\.hidden = false/);
  assert.match(gestureUi, /actionChoice\.hidden = true/);
  assert.match(gestureUi, /editorOptions\.hidden = false/);
  assert.match(gestureUi, /editorOptions\.hidden = true/);
  assert.match(gestureUi, /function filterActionOptions\(\)/);
  assert.match(
    gestureUi,
    /actionSearch\.addEventListener\("input", filterActionOptions\)/,
  );
  assert.match(gestureUi, /value === "book_info"/);
  assert.match(gestureUi, /value === "reopen_last"/);
  assert.match(gestureUi, /value === "restore_jump"/);
  assert.match(gestureUi, /return "undo_last"/);
  assert.match(gestureUi, /HINT_SETTINGS_KEY/);
  assert.match(gestureUi, /enabled: saved\.enabled === true/);
  assert.match(
    gestureUi,
    /backgroundEnabled:\s*saved\.backgroundEnabled !== false/,
  );
  assert.match(gestureUi, /const DEFAULT_HINT_SETTINGS = Object\.freeze/);
  assert.match(gestureUi, /fontSize: 20/);
  assert.match(gestureUi, /opacity: 60/);
  assert.match(gestureUi, /positionX: 0\.96/);
  assert.match(gestureUi, /positionY: 0\.04/);
  assert.match(gestureUi, /frameWidth: 200/);
  assert.match(gestureUi, /frameHeight: 60/);
  assert.match(gestureUi, /frameShape: "rect"/);
  assert.match(gestureUi, /hintBackgroundReset\.addEventListener\("click"/);
  assert.match(gestureUi, /function normalizeHintQuickColors\(value\)/);
  assert.match(gestureUi, /function renderHintBackgroundPresets\(\)/);
  assert.match(gestureUi, /let selectedQuickColorId = null/);
  assert.match(gestureUi, /let hoveredQuickColorId = null/);
  assert.match(gestureUi, /gesture-hint-quick-color-bridge/);
  assert.match(
    gestureUi,
    /hoveredQuickColorId = null;\s*selectedQuickColorId = null/,
  );
  assert.match(gestureUi, /let hintColorPickerOpen = false/);
  assert.match(gestureUi, /hintQuickColorAdd\.addEventListener\("click"/);
  assert.match(gestureUi, /hintColorPickerToggle\.addEventListener\("click"/);
  assert.match(gestureUi, /hintQuickColorAdd\.hidden = !hintColorPickerOpen/);
  assert.match(gestureUi, /hintBackground\.addEventListener\("change"/);
  assert.match(gestureUi, /hintSettings\.quickColors\.length < 6/);
  assert.match(
    gestureUi,
    /hintPreview\.hidden = hintDrawingFrame/,
  );
  assert.match(gestureUi, /function updateHintFrame\(event\)/);
  assert.match(gestureUi, /function commitHintFrame\(\)/);
  assert.match(gestureUi, /hintDrawingFrame = true/);
  assert.match(gestureUi, /function cancelHintPreviewDrawing\(\)/);
  assert.match(gestureUi, /hintPreviewPathLine\.setAttribute\("points", ""\)/);
  assert.match(gestureUi, /hintPreviewPath\.style\.display = "none"/);
  assert.match(gestureUi, /hintPreviewArea\.addEventListener\("pointerleave"/);
  assert.doesNotMatch(
    gestureUi,
    /\.\.\.hintFreeformPoints, hintFreeformPoints\[0\]/,
  );
  assert.match(
    gestureUi,
    /commitHintFreeform\(\);[\s\S]*?clearHintDraftPreview\(\);[\s\S]*?releasePointerCapture\?\.\(pointerId\)/,
  );
  assert.match(gestureUi, /function commitHintFreeform\(\)/);
  assert.match(
    gestureUi,
    /function compactHintFreeformPoints\(points, maximum\)/,
  );
  assert.match(
    gestureUi,
    /compactHintFreeformPoints\(hintFreeformPoints, 48\)/,
  );
  assert.match(gestureUi, /hintBackground\.click\(\)/);
  assert.match(gestureUi, /if \(event\.target === hintPreview\)/);
  assert.match(gestureUi, /get\("gesture-hint-enabled"\)/);
  assert.match(gestureUi, /function applySettingsDisclosure\(\)/);
  assert.match(gestureUi, /settingsToggle\.addEventListener\("click"/);
  assert.match(
    gestureUi,
    /editorClose\.addEventListener\("click", \(\) => \{\s*if \(editor\.hidden\) closeSettings\(\);\s*else closeEditor\(\);/,
  );
  assert.match(gestureUi, /globalPrecisionToggle\.addEventListener\("click"/);
  assert.match(gestureUi, /function showHint\(name\)/);
  assert.match(gestureUi, /function gestureInfoForTarget\(target\)/);
  assert.match(
    gestureUi,
    /element\?\.closest\("\[data-gesture-info-stop\]"\)/,
  );
  assert.match(gestureUi, /if \(!body\) return null/);
  assert.match(gestureUi, /function openGestureInfo\(info\)/);
  assert.match(gestureUi, /function withGestureInfo\(target, surface\)/);
  assert.match(gestureUi, /surface\.allowedActions\.concat\("book_info"\)/);
  assert.match(
    gestureUi,
    /if \(action === "book_info"\) \{\s*openGestureInfo\(info\);\s*return;\s*\}/,
  );
  assert.match(
    gestureUi,
    /return withGestureInfo\(target, baseSurface\(target\)\)/,
  );
  assert.match(gestureUi, /没有说明时不会执行/);
  assert.match(gestureUi, /function previewMatch\(gesture\)/);
  assert.match(
    gestureUi,
    /paintTrail\(active\.points\);\s*previewMatch\(active\);/,
  );
  assert.match(
    readerGesture,
    /paint\(active\.points\);\s*previewMatch\(active\);/,
  );
  assert.match(gestureUi, /if \(!hintSettings\.enabled\) return;/);
  assert.match(
    gestureUi,
    /if \(!hintSettings\.backgroundEnabled\) return "transparent"/,
  );
  assert.match(
    styles,
    /\.gesture-hint-background-switch \{[^}]*align-items: center/,
  );
  assert.match(
    styles,
    /\.gesture-hint-controls \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(styles, /\.gesture-hint-background-row \{[^}]*flex-wrap: wrap/);
  assert.match(
    styles,
    /\.gesture-hint-quick-color-bridge \{[^}]*top: 100%;[^}]*width: 18px;[^}]*height: 6px/,
  );
  assert.match(
    styles,
    /\.gesture-hint-quick-color-remove \{[^}]*top: calc\(100% \+ 5px\)/,
  );
  assert.match(
    styles,
    /\.gesture-hint-quick-color-remove\[hidden\] \{[^}]*display: none/,
  );
  assert.match(styles, /\.gesture-hint-background-preset \{[^}]*border: 0/);
  assert.match(
    styles,
    /\.gesture-hint-preview span\[hidden\] \{[^}]*display: none/,
  );
  assert.doesNotMatch(styles, /\.gesture-hint-color-picker-panel \{/);
  assert.match(
    styles,
    /\.gesture-hint-color-picker-toggle \{[^}]*conic-gradient/,
  );
  assert.match(
    styles,
    /\.gesture-hint-native-color-input \{[^}]*inset: 0;[^}]*width: 28px;[^}]*height: 28px;[^}]*opacity: 0/,
  );
  assert.match(
    styles,
    /\.gesture-hint-shape-tools \{[^}]*backdrop-filter: blur/,
  );
  assert.match(
    styles,
    /\.gesture-hint-quick-color-add \{[^}]*background: #3478d4/,
  );
  assert.match(styles, /\.gesture-hint-preview \{[^}]*min-height: 180px/);
  assert.match(styles, /\.gesture-hint-preview span \{[^}]*cursor: grab/);
  assert.match(
    styles,
    /\.gesture-hint-preview span,\s*\.reader-gesture-hint \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap/,
  );
  assert.match(styles, /\.gesture-info-card \{[^}]*width: min\(560px/);
  assert.match(styles, /\.gesture-info-body \{[^}]*white-space: pre-line/);
  assert.match(gestureUi, /function placeHintPreview\(\)/);
  assert.match(gestureUi, /function updateHintPreviewPosition\(event\)/);
  assert.match(readerGesture, /function placeHint\(settings\)/);
  assert.match(readerGesture, /if \(!settings\.enabled\) return;/);
  assert.match(gestureUi, /function cancelGestureKeepHint\(\)/);
  assert.match(gestureUi, /scope: normalizeScope\(action, source\.scope\)/);
  assert.match(gestureUi, /自动适用会在该操作支持的页面执行/);
  assert.match(gestureUi, /function fallbackSurface\(target\)/);
  assert.match(
    gestureUi,
    /const gestureSettings = get\("gesture-settings-modal"\)/,
  );
  assert.doesNotMatch(gestureUi, /if \(pad\.contains\(target\)\) return null;/);
  assert.doesNotMatch(gestureUi, /editor\.contains\(target\)/);
  assert.match(
    gestureUi,
    /gestureSettings\.contains\(target\)[\s\S]*?allowedActions: supportedActions\(\["back"\]\),[\s\S]*?runCloseOrUndo\([\s\S]*?"手势设置"[\s\S]*?closeSettings/,
  );
  assert.match(gestureUi, /allowedActions: supportedActions\(\["back"\]\)/);
  assert.match(gestureUi, /function canApplyAction\(surface, action\)/);
  assert.doesNotMatch(gestureUi, /startPointerGesture|activePointerId/);
  assert.match(
    gestureUi,
    /global\.addEventListener\("mousedown", startMouseGesture, true\);[\s\S]*?global\.addEventListener\("mousemove", move,[\s\S]*?global\.addEventListener\("mouseup", \(event\) => finish\((?:event)?\), true\);/,
  );
  assert.match(gestureUi, /reader-closed-for-reopen/);
  assert.match(gestureUi, /invoke\("open_book", \{ id \}\)/);
  assert.match(
    gestureUi,
    /matched && canApplyAction\(gesture\.surface, matched\.profile\.action\)/,
  );
  assert.match(gestureUi, /onMatch\(matched\.profile\.action\)/);
  assert.match(gestureUi, /optional\("book-info-modal"\)/);
  assert.match(gestureUi, /bookInfo\.classList\.remove\("show"\)/);
  assert.match(gestureUi, /optional\("book-organization-modal"\)/);
  assert.match(gestureUi, /optional\("book-organization-close"\)\?\.click\(\)/);
  assert.match(gestureUi, /optional\("booklist-modal"\)/);
  assert.match(gestureUi, /optional\("booklist-close"\)\?\.click\(\)/);
  assert.match(gestureUi, /supportedActions\(\["back"\]\)/);
  assert.match(
    gestureUi,
    /asElement\(target\)\?\.closest\("\.book\[data-id\]"\)/,
  );
  assert.match(gestureUi, /const bookId = cardBookId \|\| selectedBookId/);
  assert.match(gestureUi, /ReaderBookInfo\?\.openById\?\.\(bookId\)/);
  assert.match(gestureUi, /reader-gesture-settings-request/);
  assert.match(gestureUi, /reader-gesture-settings/);
  assert.match(gestureUi, /reader_gesture_settings_save/);
  assert.match(gestureUi, /function runCloseOrUndo\(/);
  assert.match(
    gestureUi,
    /function closeMainWindowOrUndo\(action\) \{[\s\S]*?if \(action === "undo_last"\)[\s\S]*?reopenLastClosedPage\(\);[\s\S]*?mainWindowClose\(\);/,
  );
  assert.doesNotMatch(gestureUi, /action === "back"[^\n]*reopenLastClosedPage/);
  assert.match(
    styles,
    /\.gesture-settings-card \{[^}]*max-height: calc\(100dvh - 32px\);[^}]*overflow-y: auto/,
  );
  assert.match(
    styles,
    /\.gesture-manager-card\.is-editor-open \.gesture-manager-layout \{\s*align-items: start;\s*\}/,
  );
  assert.match(
    styles,
    /\.gesture-manager-list-pane,\s*\.gesture-editor \{\s*display: grid;\s*align-content: start;/,
  );
  assert.doesNotMatch(styles, /\.gesture-editor \{[^}]*overflow-y: auto/);
  assert.doesNotMatch(styles, /\.gesture-list \{[^}]*overflow: auto/);
  assert.doesNotMatch(
    styles,
    /\.gesture-action-options \{[^}]*overflow-y: auto/,
  );
  assert.match(
    gestureUi,
    /pad\.addEventListener\("pointermove", movePointerTraining, \{\s*passive: false\s*\}\)/,
  );
  assert.match(
    gestureUi,
    /pad\.addEventListener\("pointerup", finishPointerTraining\)/,
  );
  assert.match(
    gestureUi,
    /pad\.addEventListener\("mousedown", beginTraining\)/,
  );
  assert.match(
    gestureUi,
    /global\.addEventListener\("mousemove", moveTraining, \{[\s\S]*?capture: true,[\s\S]*?passive: false/,
  );
  assert.match(
    gestureUi,
    /global\.addEventListener\("mouseup", finishTraining, true\)/,
  );
  assert.match(
    gestureUi,
    /function beginPointerTraining\(event\) \{[\s\S]*?if \(event\.pointerType === "mouse"\) return;/,
  );
  assert.doesNotMatch(
    gestureUi,
    /if \(modal\.contains\(event\.target\)\) return;/,
  );
  assert.match(
    gestureUi,
    /function appendTrainingPoints\(event\) \{[\s\S]*?event\.getCoalescedEvents\?\.\(\)[\s\S]*?\[\.\.\.coalesced, event\][\s\S]*?training\.push\(point\)/,
  );
  const trainingStart = gestureUi.slice(
    gestureUi.indexOf("function beginTraining"),
    gestureUi.indexOf("function appendTrainingPoints"),
  );
  assert.match(trainingStart, /if \(event\.button !== 0\) return;/);
  assert.match(trainingStart, /event\.preventDefault\(\);/);
  const trainingFinish = gestureUi.slice(
    gestureUi.indexOf("function finishTraining"),
    gestureUi.indexOf("function cancelTraining"),
  );
  assert.match(
    trainingFinish,
    /appendTrainingPoints\(event\);[\s\S]*?if \(length < gestureApi\.MIN_PATH_LENGTH\) \{\s*training = \[\];\s*gestureApi\.draw\(pad, training\);[\s\S]*?已清除，请重新画。[\s\S]*?return;/,
  );
  assert.match(
    gestureUi,
    /global\.addEventListener\("mousedown", startMouseGesture, true\);[\s\S]*?global\.addEventListener\("mousemove", move,[\s\S]*?global\.addEventListener\("mouseup", \(event\) => finish\((?:event)?\), true\);/,
  );
  const matcher = gestureUi.slice(
    gestureUi.indexOf("function matchProfile"),
    gestureUi.indexOf("function begin"),
  );
  assert.doesNotMatch(matcher, /profile\.action === "back"/);
  assert.doesNotMatch(matcher, /profile\.scope === surface\.scope/);
  assert.doesNotMatch(
    matcher,
    /surface\.allowedActions\.includes\(profile\.action\)/,
  );
  assert.match(readerGesture, /async function closeReaderSurface\(source\)/);
  assert.match(
    readerGesture,
    /if \(global\.ReaderShell\?\.closeSurface\?\.\(\)\) return;/,
  );
  assert.match(
    readerGesture,
    /root\.getElementById\("win-close"\)\?\.click\(\)/,
  );
  assert.match(
    readerGesture,
    /const publicApi = \{\s*activate: startGestureRuntime,\s*fromFrame,\s*frameSurfaceClosed\s*\};[\s\S]*?global\.ReaderGestureClose = publicApi/,
  );
  assert.match(
    readerGesture,
    /previous\.sidePanel === "ai-reader" \? "智读" : previous\.sidePanel/,
  );
  assert.match(
    readerGesture,
    /ReaderShell\?\.setSidePanel\?\.\(String\(previous\.sidePanel\), true\)/,
  );
  assert.match(readerGesture, /function requestFrameSurfaceClose\(\)/);
  assert.match(
    readerGesture,
    /frame\.contentWindow\?\.postMessage\(\{ readerGestureAction: "back" \}, "\*"\)/,
  );
  assert.match(
    readerGesture,
    /source === "frame" && await requestFrameSurfaceClose\(\)/,
  );
  assert.match(readerGesture, /frameSurfaceClosed/);
  assert.doesNotMatch(
    readerGesture,
    /event\.target\?\.closest\?\.\("\.modal"\)/,
  );
  assert.match(readerGesture, /function undoLastReaderAction\(\)/);
  assert.match(readerGesture, /const undoHistory = \[\];/);
  assert.match(readerGesture, /reader-undo-checkpoint/);
  assert.match(readerGesture, /global\.openReaderBookInfo/);
  assert.match(readerGesture, /book_info: "信息提取／说明"/);
  assert.match(
    readerGesture,
    /action === "book_info" && typeof global\.openReaderBookInfo === "function"/,
  );
  assert.match(readerGesture, /connectSharedSettings\(\)/);
  assert.match(readerGesture, /reader-gesture-settings-request/);
  assert.match(readerGesture, /reader_gesture_settings_load/);
  assert.doesNotMatch(
    readerGesture,
    /profile\.action !== "book_info" \|\| String\(global\.currentBookId/,
  );
  assert.doesNotMatch(readerGesture, /reader-gesture-action/);
  assert.match(readerGesture, /function cancelKeepHint\(\)/);
  assert.match(readerGesture, /function hideHint\(\)/);
  assert.match(
    readerGesture,
    /if \(!active\) \{\s*hideHint\(\);\s*return;\s*\}/,
  );
  assert.match(app, /hasSingleSelected: hasSingleSelectedBook/);
  assert.match(app, /openById: openBookInfoById/);
  assert.match(app, /tauriEvent\.listen\("reader-gesture-action"/);
});
test("NewsNow has a persisted horizontal and grid layout switch", () => {
  assert.match(html, /id="newsnow-layout-list"/);
  assert.match(html, /id="newsnow-layout-grid"/);
  assert.match(styles, /\.newsnow-card-image\.loading/);
  assert.match(styles, /\.newsnow-feed\.newsnow-feed-grid\s*\{/);
  assert.match(styles, /\.newsnow-layout-grid-icon\s*\{/);
  assert.match(
    styles,
    /\.newsnow-layout-grid-icon::before\s*\{[^}]*width: 9px[^}]*height: 9px[^}]*box-shadow:\s*11px 0 currentColor,\s*0 11px currentColor,\s*11px 11px currentColor/s,
  );
  assert.match(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*repeat\(var\(--newsnow-grid-columns, 1\)/s,
  );
  assert.match(
    styles,
    /\.newsnow-masonry-column\s*\{[^}]*flex-direction: column/s,
  );
  assert.doesNotMatch(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid\s*\{[^}]*column-width/s,
  );
  assert.match(styles, /\.newsnow-card-image\s*\{/);
  assert.match(styles, /\.newsnow-card-image\[hidden\]\s*\{\s*display: none/);
  assert.doesNotMatch(
    styles,
    /\.newsnow-feed\.newsnow-feed-grid \.newsnow-card\s*\{[^}]*height: 222px/s,
  );
  assert.match(styles, /\.newsnow-card h2\s*\{[^}]*-webkit-line-clamp: 4/s);
});

test("NewsNow prefetches enabled sources and bounds visible image requests", () => {
  assert.match(
    backend,
    /const PREVIEW_IMAGE_MAX_BYTES: u64 = 4 \* 1024 \* 1024/,
  );
  assert.match(backend, /const NEWS_FEED_SOURCE_TIMEOUT: Duration = Duration::from_secs\(6\)/);
  assert.match(backend, /const MAX_REFRESH_CONCURRENCY: usize = 12/);
  assert.match(
    backend,
    /fetch_selected_source\(\s*&news_feed_agent\(\),\s*&base,\s*&source,\s*force_refresh,\s*&tieba_bars,\s*\)/,
  );
  assert.match(backend, /remember_preview_attempt/);
  assert.match(script, /const enqueueWhenConnected = \(\) => \{/);
  assert.match(
    script,
    /if \(!image\.isConnected \|\| image\.dataset\.previewLoaded === "true"\) return;/,
  );
  assert.match(script, /host\.requestAnimationFrame\(enqueueWhenConnected\);/);
  assert.match(
    styles,
    /\.experimental-settings\s*\{[^}]*padding: 0;[^}]*border: 0/s,
  );
  assert.doesNotMatch(styles, /\.experimental-settings \.fp-set-row\s*\{/);
  assert.match(
    styles,
    /\.experimental-settings \+ \.default-apps-setting\s*\{[^}]*border-top: 0/s,
  );
});

test("NewsNow persists mixed or source-grouped ordering", () => {
  assert.match(html, /id="newsnow-order-mixed"/);
  assert.match(html, /id="newsnow-order-source"/);
  assert.match(styles, /\.newsnow-source-section\s*\{/);
});

test("NewsNow presents a chronological reading feed and stays usable on narrow windows", () => {
  assert.match(styles, /\.newsnow-page\s*\{/);
  assert.match(styles, /\.newsnow-toolbar\s*\{[^}]*max-width: 1280px/s);
  assert.match(styles, /\.newsnow-categories\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card-rail\s*\{/);
  assert.match(styles, /\.newsnow-source-picker\s*\{/);
  assert.match(styles, /\.newsnow-card:hover,\s*\.newsnow-card:focus-visible/);
  assert.match(styles, /\.newsnow-reader\s*\{/);
  assert.match(styles, /\.newsnow-reader\[hidden\]\s*\{\s*display: none/);
  assert.match(styles, /\.newsnow-reader\s*\{[^}]*flex: 1 1 auto/s);
  assert.match(html, /id="newsnow-reader-back"/);
  assert.match(styles, /\.newsnow-reader-back\s*\{/);
  assert.match(styles, /\.newsnow-reader-content\s*\{/);
  assert.match(styles, /\.newsnow-source-notice\s*\{/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
