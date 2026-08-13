const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const readerHtml = readFileSync(resolve(root, "reader.html"), "utf8");
const readerJs = readFileSync(resolve(root, "reader.js"), "utf8");
const panelJs = readFileSync(resolve(root, "book-info-panel.js"), "utf8");
const panelCss = readFileSync(resolve(root, "book-info-panel.css"), "utf8");
const relatedJs = readFileSync(resolve(root, "book-info-related.js"), "utf8");
const relatedCss = readFileSync(resolve(root, "book-info-related.css"), "utf8");

test("阅读页图书信息与书架使用相同的完整信息面", () => {
  const infoModal = readerHtml.slice(
    readerHtml.indexOf('<div id="info-modal"'),
    readerHtml.indexOf('<div id="reader-end-modal"'),
  );

  assert.match(infoModal, /<div id="info-modal" class="modal"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-label="书籍信息"><\/div>/);
  assert.match(readerHtml, /<link rel="stylesheet" href="book-info-panel\.css" \/>/);
  assert.match(readerHtml, /<link rel="stylesheet" href="book-info-related\.css" \/>/);
  assert.match(readerHtml, /<script src="book-info-panel\.js"><\/script>[\s\S]*?<script src="book-info-related\.js"><\/script>[\s\S]*?<script src="reader\.js"><\/script>/);
  assert.match(panelJs, /function markup\(ids\)/);
  assert.match(panelJs, /class="modal-card book-info-card"/);
  assert.match(panelJs, /data-book-info-action="tags"/);
  assert.match(panelJs, /data-book-info-action="timeline"/);
  assert.match(panelJs, /class="book-info-author-field"/);
  assert.doesNotMatch(panelJs, /<h3>整理<\/h3>|<span>标签与书单<\/span>/);
  assert.match(panelCss, /\.modal-card\.book-info-card \{ width:\s*min\(820px/);
  assert.doesNotMatch(readerHtml, /reader-book-info-/);
});

test("阅读页信息卡通过统一图书接口保存并显示封面", () => {
  assert.match(readerJs, /const readerInfoPanel = window\.ReaderBookInfoPanel\.mount\(\{ root: document, host: infoModal, prefix: "info" \}\)/);
  assert.match(readerJs, /readerInfoPanel\.render\(m\)/);
  assert.match(readerJs, /readerInfoPanel\.configure\(\{/);
  assert.match(readerJs, /action: "book_organization", field, bookId: String\(currentBookId\)/);
  assert.match(readerJs, /action: "change_cover", bookId: String\(currentBookId\)/);
  assert.match(readerJs, /readerBookInfoRelated\.openSimilar\(currentBookId, readerInfoMeta\)/);
  assert.match(readerJs, /readerBookInfoRelated\.openTimeline\(currentBookId\)/);
  assert.match(readerJs, /invoke\("set_book_title", \{ id: String\(currentBookId\), title \}\)/);
  assert.match(readerJs, /invoke\("set_book_description", \{ id: String\(currentBookId\), description \}\)/);
  assert.match(readerJs, /invoke\("set_book_rating", \{ id: String\(currentBookId\), rating \}\)/);
  assert.doesNotMatch(readerJs, /invoke\("set_description", \{ description: desc \}\)/);
  assert.doesNotMatch(readerJs, /invoke\("set_rating", \{ rating: v \}\)/);
});

test("相似图书和阅读时间线只有一套共享信息层实现", () => {
  assert.match(readerJs, /window\.ReaderBookInfoRelated\.mount\(\{/);
  assert.match(relatedJs, /data-book-related="similar" data-overlay-role="information"/);
  assert.match(relatedJs, /data-book-related="timeline" data-overlay-role="information"/);
  assert.match(relatedJs, /function timelineMarkup\(data\)/);
  assert.match(relatedCss, /\.timeline-summary \{/);
  assert.match(relatedCss, /\.timeline-event-list::before/);
  assert.doesNotMatch(readerJs, /function renderSimilarBooks|function timelineMarkup/);
});
