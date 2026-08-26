const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

test("账号资讯工作区只展示登录账号已校验的本地缓存", () => {
  const html = read("ui", "index.html");
  const news = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "news-ui.ts");
  const rust = read("src", "newsnow.rs");

  assert.match(html, /id="newsnow-toolbar-btn"/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="intelligence-lab-toolbar-btn"[\s\S]*?情报中心/);
  assert.match(html, /id="intelligence-workspace-page"[\s\S]*?只阅读当前登录账号已保存、已校验的正式资讯包/);
  assert.match(html, /账号资讯/);
  assert.match(html, /id="intelligence-filter-kind"[\s\S]*?id="intelligence-filter-importance"[\s\S]*?id="intelligence-filter-scope"/);
  assert.match(html, /id="intelligence-archive-request"[\s\S]*?id="intelligence-archive-retry"/);
  assert.match(html, /id="intelligence-digest-history"[\s\S]*?data-mode="live"[\s\S]*?id="intelligence-digest-history-previous"[\s\S]*?id="intelligence-digest-history-date"[\s\S]*?今天 · 实时简报[\s\S]*?id="intelligence-digest-history-next"[\s\S]*?id="intelligence-digest-history-readonly"[\s\S]*?历史快照 · 只读/);
  assert.match(html, /当前登录账号最近 30 天已校验并保存到本机/);
  assert.match(html, /综合正文/);
  assert.match(html, /段落“注”/);
  assert.doesNotMatch(html, /world-monitor-toolbar-btn|全球监测/iu);
  assert.doesNotMatch(news, /worldMonitor(Open|Button)|openWorldMonitor/);
  assert.doesNotMatch(rust, /world_monitor/);
});

test("账号资讯工作区通过单一控制器读取缓存、SSE 更新与历史回源", () => {
  const html = read("ui", "index.html");
  const manifest = JSON.parse(read("apps", "desktop-ui", "legacy-ts.entries.json"));
  const controller = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "intelligence-workspace-ui.ts");
  const news = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "news-ui.ts");
  const libraryAi = read("apps", "desktop-ui", "src", "legacy-ts", "main-business", "library-ai-entry.ts");
  const styles = read("ui", "styles.css");
  const entry = manifest.entries.find((candidate) => candidate.id === "intelligence-workspace-ui");

  assert.deepEqual(entry, {
    id: "intelligence-workspace-ui",
    source: "apps/desktop-ui/src/legacy-ts/main-news/intelligence-workspace-ui.ts",
    output: "intelligence-workspace-ui.js",
    globalName: "KunpengIntelligenceWorkspaceUi",
    installExport: "installIntelligenceWorkspaceUi",
    replaces: "ui/intelligence-workspace-ui.js",
    hosts: ["ui/index.html"],
  });
  assert.ok(
    html.indexOf("generated-ts/news-ui.js") < html.indexOf("generated-ts/intelligence-workspace-ui.js"),
  );
  assert.match(controller, /intelligence_client_refresh/);
  assert.match(controller, /intelligence_client_cache_status/);
  assert.match(controller, /intelligence_client_cached_publications/);
  assert.match(controller, /intelligence-delivery-updated/);
  assert.match(controller, /intelligence_archive_calendar/);
  assert.match(controller, /intelligence_archive_request/);
  assert.match(controller, /intelligence_archive_download/);
  assert.match(controller, /sync_get_settings/);
  assert.doesNotMatch(controller, /world_monitor_open|newsnow_open_article|fetch\(/);
  assert.match(controller, /ReaderNewsUI\?\.instance\?\.close/);
  assert.match(controller, /ReaderLibraryAiEntry\?\.close/);
  assert.match(news, /ReaderIntelligenceWorkspace\?\.instance\?\.close/);
  assert.match(libraryAi, /ReaderIntelligenceWorkspace\?\.instance\?\.close/);
  assert.match(styles, /\.intelligence-workspace-page\s*\{/);
  assert.match(styles, /\.intelligence-delivery-controls\s*\{/);
  assert.match(styles, /\.intelligence-delivery-state\s*\{/);
  assert.match(styles, /\.intelligence-digest-history\s*\{/);
  assert.match(styles, /\.intelligence-digest-history\[data-mode="historical"\] \.intelligence-digest-history-readonly:not\(\[hidden\]\)\s*\{/);
  assert.match(news, /open\(\{ allowWhenDisabled: true \}\)/);
  assert.match(news, /skipFeedLoad: true/);
  assert.match(news, /gestureThreshold: newsGesture\.matchThreshold/);
  assert.match(news, /articleReturnsToIntelligence/);
});
