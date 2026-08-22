const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repositoryRoot = path.resolve(__dirname, "..", "..");
const read = (...parts) => fs.readFileSync(path.join(repositoryRoot, ...parts), "utf8");

test("test intelligence workspace replaces the standalone World Monitor entry without changing news", () => {
  const html = read("ui", "index.html");
  const news = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "news-ui.ts");
  const rust = read("src", "newsnow.rs");

  assert.match(html, /id="newsnow-toolbar-btn"/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="intelligence-lab-toolbar-btn"[\s\S]*?情报中心（测试）/);
  assert.match(html, /id="intelligence-workspace-page"[\s\S]*?id="intelligence-digest-list"[\s\S]*?id="intelligence-signal-list"[\s\S]*?id="intelligence-context-body"/);
  assert.match(html, /今日综合要点/);
  assert.doesNotMatch(html, /intelligence-briefing-summary|intelligence-briefing-pipeline|不是逐条罗列资讯/);
  assert.match(html, /id="intelligence-layout-interstellar"[\s\S]*?星际旅行/);
  assert.match(html, /id="interstellar-progress-view"[\s\S]*?载人近邻恒星际飞行[\s\S]*?综合进度8%/);
  assert.match(html, /基础研究[\s\S]*?工程实现[\s\S]*?制度与产业/);
  assert.match(html, /id="interstellar-manage-sources"[\s\S]*?id="interstellar-source-summary"[\s\S]*?id="interstellar-source-groups"/);
  assert.match(html, /来源接入 · 本地模型预备[\s\S]*?当前来源覆盖/);
  assert.match(html, /id="interstellar-signal-list"[\s\S]*?id="interstellar-open-news"/);
  assert.match(html, /id="intelligence-open-sources"/);
  assert.match(html, /id="intelligence-source-directory"[\s\S]*?全目录信息来源[\s\S]*?不会更改资讯页的个人来源管理/);
  assert.match(html, /Horizon[\s\S]*?全目录信号处理/);
  assert.match(html, /WorldMonitor[\s\S]*?已接入地震、自然事件与灾害预警源/);
  assert.doesNotMatch(html, /world-monitor-toolbar-btn|全球监测/iu);
  assert.doesNotMatch(news, /worldMonitor(Open|Button)|openWorldMonitor/);
  assert.doesNotMatch(rust, /world_monitor/);
});

test("test intelligence workspace has one generated controller after the existing news controller", () => {
  const html = read("ui", "index.html");
  const manifest = JSON.parse(read("apps", "desktop-ui", "legacy-ts.entries.json"));
  const controller = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "intelligence-workspace-ui.ts");
  const news = read("apps", "desktop-ui", "src", "legacy-ts", "main-news", "news-ui.ts");
  const rust = read("src", "newsnow.rs");
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
  assert.match(controller, /sourceRequest/);
  assert.match(controller, /transport\.invoke<unknown>\("newsnow_sources"/);
  assert.match(controller, /sourceIds: allSourceIds/);
  assert.match(controller, /forceRefresh \? "newsnow_refresh" : "newsnow_list"/);
  assert.match(controller, /newsnow_intelligence_snapshot_get/);
  assert.match(controller, /newsnow_intelligence_snapshot_save/);
  assert.match(rust, /newsnow_intelligence_snapshot_save/);
  assert.match(controller, /buildIntelligenceBriefing/);
  assert.match(controller, /interstellarSourceCoverage/);
  assert.match(controller, /classifyInterstellarSignals/);
  assert.match(controller, /openNewsItem\(item, "资讯详情暂时无法打开。"\)/);
  assert.match(controller, /returnToIntelligence: true/);
  assert.match(controller, /尚未自动计分/);
  assert.match(controller, /news\?\.openItem/);
  assert.match(controller, /openSourceDirectory/);
  assert.match(controller, /sourceDirectoryCatalogue/);
  assert.match(controller, /1 条信息/);
  assert.match(controller, /canonicalItemUrl/);
  assert.match(controller, /mergeRelatedEventEntries/);
  assert.match(controller, /visibleEntries/);
  assert.match(controller, /默认隐藏/);
  assert.doesNotMatch(controller, /topic\.entries\.length} 条要点/);
  assert.doesNotMatch(controller, /sourcesButton\.addEventListener\("click", openSources\)/);
  assert.doesNotMatch(controller, /world_monitor_open|newsnow_open_article|fetch\(/);
  assert.match(controller, /ReaderNewsUI\?\.instance\?\.close/);
  assert.match(controller, /ReaderLibraryAiEntry\?\.close/);
  assert.match(news, /ReaderIntelligenceWorkspace\?\.instance\?\.close/);
  assert.match(libraryAi, /ReaderIntelligenceWorkspace\?\.instance\?\.close/);
  assert.match(styles, /\.intelligence-workspace-page\s*\{/);
  assert.match(styles, /\.intelligence-workspace-page\[data-layout="monitor"\]/);
  assert.match(styles, /\.intelligence-workspace-page\[data-layout="research"\]/);
  assert.match(styles, /\.interstellar-progress-view\s*\{/);
  assert.match(styles, /\.interstellar-bottlenecks\s*\{/);
  assert.match(styles, /\.interstellar-source-groups\s*\{/);
  assert.doesNotMatch(styles, /\.intelligence-briefing-pipeline\s*\{/);
  assert.match(styles, /\.intelligence-source-directory\s*\{/);
  assert.match(news, /open\(\{ allowWhenDisabled: true \}\)/);
  assert.match(news, /skipFeedLoad: true/);
  assert.match(news, /gestureThreshold: newsGesture\.matchThreshold/);
  assert.match(news, /articleReturnsToIntelligence/);
});
