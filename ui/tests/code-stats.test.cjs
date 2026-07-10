const test = require("node:test");
const assert = require("node:assert/strict");
const { detectLanguage, countLines, shouldExclude, aggregateStats } = require("../code-stats.js");

test("detects exact names and compound extensions", () => {
  assert.equal(detectLanguage("src/main.rs").name, "Rust");
  assert.equal(detectLanguage("types/app.d.ts").name, "TypeScript");
  assert.equal(detectLanguage("Dockerfile").name, "Dockerfile");
  assert.equal(detectLanguage("image.png"), null);
});

test("classifies code, comments, mixed lines and blanks", () => {
  const source = [
    "// heading",
    "const url = \"https://example.com\"; // trailing",
    "",
    "/* multi",
    " * line",
    " */",
    "return url;"
  ].join("\n");
  assert.deepEqual(countLines(source, "slash"), { total: 7, code: 2, comment: 4, blank: 1 });
});

test("handles code after a closing block comment", () => {
  const source = "/* note */ const ready = true;\n/* open\nclose */";
  assert.deepEqual(countLines(source, "slash"), { total: 3, code: 1, comment: 2, blank: 0 });
});

test("matches directory, path and wildcard exclusions", () => {
  const patterns = ["node_modules", "ui/pdfjs", "*.min.js"];
  assert.equal(shouldExclude("src/node_modules/pkg/a.js", patterns), true);
  assert.equal(shouldExclude("ui/pdfjs/pdf.mjs", patterns), true);
  assert.equal(shouldExclude("assets/app.min.js", patterns), true);
  assert.equal(shouldExclude("src/app.js", patterns), false);
});

test("aggregates totals by language", () => {
  const rust = detectLanguage("main.rs");
  const js = detectLanguage("app.js");
  const report = aggregateStats([
    { language: rust, total: 10, code: 7, comment: 2, blank: 1, bytes: 100 },
    { language: rust, total: 5, code: 4, comment: 0, blank: 1, bytes: 50 },
    { language: js, total: 4, code: 3, comment: 1, blank: 0, bytes: 40 }
  ]);
  assert.equal(report.files, 3);
  assert.equal(report.total, 19);
  assert.equal(report.code, 14);
  assert.equal(report.languages[0].name, "Rust");
  assert.equal(report.languages[0].files, 2);
});
