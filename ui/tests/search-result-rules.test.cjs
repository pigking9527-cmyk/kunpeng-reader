const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "generated-ts", "search-result-rules.js"), "utf8");
const context = { Set };
context.window = context;
vm.runInNewContext(source, context, { filename: "search-result-rules.js" });
const rules = context.window.ReaderSearchResultRules;

test("search result rules escape snippets before adding highlight markup", () => {
  assert.equal(rules.escapeHtml('<book & "author">'), "&lt;book &amp; \"author\"&gt;");
  assert.equal(rules.highlightSnippet("<alpha & beta>", "beta"), "&lt;alpha &amp; <mark>beta</mark>&gt;");
});

test("Chinese highlight needles prefer longer overlapping ngrams", () => {
  assert.deepEqual(
    Array.from(rules.highlightNeedles("中文检索")),
    ["中文检索", "中文检", "文检索", "中文", "文检", "检索"],
  );
  assert.equal(rules.highlightSnippet("中文检索结果", "中文检索"), "<mark>中文检索</mark>结果");
});

test("one CJK character remains searchable while one ASCII character does not", () => {
  assert.deepEqual(Array.from(rules.highlightNeedles("书")), ["书"]);
  assert.deepEqual(Array.from(rules.highlightNeedles("a")), []);
});

test("result sorting is non-mutating and preserves the existing mode semantics", () => {
  const books = [
    { title: "beta", author: "li", count: 2, score: 0.3 },
    { title: "alpha", author: "wang", count: 4, score: 0.2 },
    { title: "gamma", author: "zhao", count: 1, score: 0.9 },
  ];
  assert.deepEqual(Array.from(rules.sortSearchResults(books, "title"), (book) => book.title), ["alpha", "beta", "gamma"]);
  assert.deepEqual(Array.from(rules.sortSearchResults(books, "hits"), (book) => book.count), [4, 2, 1]);
  assert.deepEqual(Array.from(rules.sortSearchResults(books, "count"), (book) => book.title), ["gamma", "beta", "alpha"]);
  assert.deepEqual(Array.from(books, (book) => book.title), ["beta", "alpha", "gamma"]);
});
