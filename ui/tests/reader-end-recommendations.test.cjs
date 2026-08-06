const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "reader.html"), "utf8");
const mainHtml = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const reader = fs.readFileSync(path.join(ui, "reader.js"), "utf8");
const layout = fs.readFileSync(path.join(ui, "reader-page-layout.js"), "utf8");
const end = fs.readFileSync(path.join(ui, "reader-page-end.js"), "utf8");
const transition = fs.readFileSync(path.join(ui, "reader-page-transition.js"), "utf8");
const shell = fs.readFileSync(path.join(ui, "reader-shell-state.js"), "utf8");
const settings = fs.readFileSync(path.join(ui, "reader-recommendation-settings.js"), "utf8");
const appI18n = fs.readFileSync(path.join(ui, "app-i18n.js"), "utf8");

test("last-page recommendations show five horizontal cover cards with relevance", () => {
  assert.match(html, /id="reader-end-modal"/);
  assert.match(html, /\.reader-end-list\s*\{[^}]*grid-template-columns:\s*repeat\(5,/s);
  assert.match(html, /\.reader-end-cover\s*\{[^}]*aspect-ratio:\s*3\/4/s);
  assert.match(reader, /invoke\("similar_books"/);
  assert.match(reader, /list\.slice\(0, 5\)/);
  assert.match(reader, /scoreLabel\.textContent = "相关度"/);
  assert.match(reader, /scoreValue\.textContent = score \+ "%"/);
  assert.match(reader, /invoke\("open_book_at"/);
});

test("the final page stays readable until another forward turn crosses the end", () => {
  assert.match(end, /function notifyReaderEndIfReached\(dir,boundaryAttempt\)/);
  assert.match(end, /if\(!atEnd\)\{readerEndNotified=false;return false;\}/);
  assert.match(end, /dir>0&&boundaryAttempt===true&&!readerEndNotified/);
  assert.match(layout, /report\(\);notifyReaderEndIfReached\(dir\);captureAnchor\(\)/);
  assert.match(layout, /updateScrollPageAfterProgrammatic\(\);\s*notifyReaderEndIfReached\(dir\)/);
  assert.match(transition, /showChapter\(chapter,where\)[\s\S]*?notifyReaderEndIfReached\(dir\)/);
  assert.match(layout, /else notifyReaderEndIfReached\(1,true\);/);
  assert.match(layout, /if\(!target\)[\s\S]*?notifyReaderEndIfReached\(dir,dir>0\);/);

  const messages = [];
  const state = {
    curCh: 0,
    CH: 1,
    pageInCh: 0,
    pagesInCh: 1,
    parent: { postMessage(message) { messages.push(message); } },
  };
  vm.runInNewContext(end, state);

  assert.equal(state.notifyReaderEndIfReached(1), false, "entering the last page must not open recommendations");
  assert.equal(messages.length, 0);
  assert.equal(state.notifyReaderEndIfReached(1, true), true, "one more forward turn opens recommendations");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].bookEnd, true);
  assert.equal(state.notifyReaderEndIfReached(1, true), false, "the same boundary does not reopen repeatedly");

  state.pagesInCh = 2;
  state.pageInCh = 0;
  state.notifyReaderEndIfReached(-1);
  state.pageInCh = 1;
  assert.equal(state.notifyReaderEndIfReached(1, true), true, "leaving the end rearms the recommendation boundary");
});

test("recommendations participate in exclusive reader overlays", () => {
  assert.match(shell, /END_RECOMMENDATIONS:\s*"end-recommendations"/);
  assert.match(shell, /OVERLAY\.END_RECOMMENDATIONS, document\.getElementById\("reader-end-modal"\)/);
  assert.match(reader, /ReaderShell\.setOverlay\(ReaderShell\.OVERLAY\.END_RECOMMENDATIONS, true\)/);
});

test("the persistent recommendation setting has a gear, word threshold, and shorter label", () => {
  assert.match(html, /src="reader-recommendation-settings\.js"/);
  assert.match(mainHtml, /data-i18n="endRecommendations">读后推荐<\/span>/);
  assert.match(mainHtml, /id="end-recommendations-gear"[\s\S]*?id="set-end-recommendations"/);
  assert.match(mainHtml, /id="reader-recommendation-settings-modal"/);
  assert.match(mainHtml, /id="reader-recommendation-min-words"[^>]*step="0\.5"/);
  assert.match(mainHtml, /不超过[\s\S]*万字不推荐/);
  assert.match(appI18n, /"zh-CN": "读后推荐"/);
  assert.match(settings, /const STORAGE_KEY = "readerEndRecommendationsV1"/);
  assert.match(settings, /const MIN_WORDS_STORAGE_KEY = "readerRecommendationMinWordsV1"/);
  assert.match(settings, /const DEFAULT_MIN_RECOMMENDATION_WORDS = 10000/);
  assert.match(settings, /setItem\(STORAGE_KEY, checkbox\.checked \? "1" : "0"\)/);
  assert.match(reader, /ReaderRecommendationSettings\?\.isEnabled\(\)\) openReaderEnd\(\)/);
  assert.match(reader, /if \(list === null\) return/);
});

test("opening recommendation details keeps the common settings page visible", () => {
  assert.doesNotMatch(settings, /fp-settings-modal/);
  assert.match(settings, /settingsModal\?\.classList\.add\("show"\)/);
  assert.match(settings, /settingsModal\?\.classList\.remove\("show"\)/);
});

test("the word threshold is stored in words and exposed in ten-thousand units", () => {
  const stored = new Map();
  const fakeWindow = {
    localStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
  };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  const api = fakeWindow.ReaderRecommendationSettings;
  assert.equal(api.minimumWords(), 10000);
  assert.equal(api.setMinimumWords(25000), 25000);
  assert.equal(stored.get(api.MIN_WORDS_STORAGE_KEY), "25000");
  assert.equal(api.minimumWords(), 25000);
});

test("recommendations prefetch once at ninety percent and reuse the result at book end", async () => {
  const stored = new Map();
  const warmed = [];
  class FakeImage {
    set src(value) { warmed.push(value); }
  }
  const fakeWindow = {
    localStorage: {
      getItem(key) { return stored.get(key) ?? null; },
      setItem(key, value) { stored.set(key, String(value)); },
    },
    Image: FakeImage,
  };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  const calls = [];
  const prefetcher = fakeWindow.ReaderRecommendationSettings.createPrefetcher({
    invoke: async (command, payload) => {
      calls.push({ command, payload });
      return [{ id: "next", cover: "cover://next" }];
    },
    enabled: () => true,
    ImageCtor: FakeImage,
  });
  prefetcher.reset("book-1", { wordCount: 10001 });
  assert.equal(prefetcher.observe({ gPage: 99, gTotal: 100, progress: 89.9 }), null);
  await prefetcher.observe({ gPage: 1, gTotal: 999, progress: 90 });
  assert.equal(prefetcher.observe({ progress: 95 }), null);
  const result = await prefetcher.loadAtEnd();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "similar_books");
  assert.equal(calls[0].payload.id, "book-1");
  assert.equal(result[0].id, "next");
  assert.deepEqual(warmed, ["cover://next"]);
  assert.match(reader, /readerEndRecommendations\?\.observe\(e\.data\)/);
  assert.match(reader, /readerEndRecommendations\.loadAtEnd\(\)/);
  assert.match(reader, /readerEndRecommendations\?\.reset\(currentBookId, \{ wordCount: info\.word_count \}\)/);
});

test("unknown word counts are loaded at ninety percent before prefetching", async () => {
  const fakeWindow = { localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  const calls = [];
  const prefetcher = fakeWindow.ReaderRecommendationSettings.createPrefetcher({
    invoke: async (command) => {
      calls.push(command);
      if (command === "book_meta") return { word_count: 15000 };
      return [{ id: "known-long-enough" }];
    },
    enabled: () => true,
  });
  prefetcher.reset("book-unknown");
  const result = await prefetcher.observe({ progress: 90 });
  assert.equal(result[0].id, "known-long-enough");
  assert.equal(calls.join(","), "book_meta,similar_books");
});

test("a failed ninety-percent prefetch retries at book end", async () => {
  const fakeWindow = { localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  let calls = 0;
  const prefetcher = fakeWindow.ReaderRecommendationSettings.createPrefetcher({
    invoke: async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary failure");
      return [{ id: "retry-ok" }];
    },
    enabled: () => true,
  });
  prefetcher.reset("book-2", { wordCount: 20000 });
  assert.equal(prefetcher.observe({ progress: 89.9 }), null);
  assert.equal((await prefetcher.observe({ progress: 90 })).length, 0);
  const result = await prefetcher.loadAtEnd();
  assert.equal(calls, 2);
  assert.equal(result[0].id, "retry-ok");
});

test("disabled recommendations never start prefetching", () => {
  const fakeWindow = { localStorage: { getItem() { return "0"; }, setItem() {} } };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  let calls = 0;
  const prefetcher = fakeWindow.ReaderRecommendationSettings.createPrefetcher({
    invoke: async () => { calls += 1; return []; },
    enabled: () => false,
  });
  prefetcher.reset("book-3", { wordCount: 30000 });
  assert.equal(prefetcher.observe({ progress: 99 }), null);
  assert.equal(calls, 0);
});

test("word threshold alone filters short documents and ignores page counts", async () => {
  const fakeWindow = { localStorage: { getItem() { return null; }, setItem() {} } };
  vm.runInNewContext(settings, { window: fakeWindow, globalThis: fakeWindow });
  let calls = 0;
  const prefetcher = fakeWindow.ReaderRecommendationSettings.createPrefetcher({
    invoke: async () => { calls += 1; return [{ id: "long-enough" }]; },
    enabled: () => true,
    minimumWords: () => 20000,
  });

  prefetcher.reset("exact-threshold", { wordCount: 20000 });
  assert.equal(prefetcher.observe({ gPage: 1000, gTotal: 1000, progress: 100 }), null);
  assert.equal(await prefetcher.loadAtEnd(), null);
  assert.equal(calls, 0);

  prefetcher.reset("over-threshold", { wordCount: 20001 });
  const result = await prefetcher.observe({ gPage: 1, gTotal: 1, progress: 100 });
  assert.equal(result[0].id, "long-enough");
  assert.equal(calls, 1);
  assert.doesNotMatch(settings, /MIN_RECOMMENDATION_PAGES|PREFETCH_REMAINING_PAGES/);
});
