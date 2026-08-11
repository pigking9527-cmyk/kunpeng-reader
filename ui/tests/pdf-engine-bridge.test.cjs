const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const uiRoot = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(uiRoot, "pdfview.js"), "utf8");
const html = fs.readFileSync(path.join(uiRoot, "pdfview.html"), "utf8");

test("PDF iframe imports the guarded adapter as an explicit imperative-module dependency", () => {
  assert.doesNotMatch(html, /pdf-engine-legacy-adapter\.js/);
  assert.match(html, /<script type="module" src="pdfview\.js">/);
  assert.match(source, /import \{ createPdfLegacyAdapter \} from "\.\/bridge\/pdf-engine-legacy-adapter\.js"/);
  assert.match(source, /const pdfEngineAdapter = createPdfLegacyAdapter\(\)/);
  assert.match(
    fs.readFileSync(path.join(uiRoot, "..", "apps", "desktop-ui", "src", "pdf-engine-legacy-adapter.ts"), "utf8"),
    /\[0-9\]\{1,20\}/,
  );
  assert.match(source, /pdfEngineAdapter\?\.normalizeIncomingMessage/);
});

test("PDF compatibility path owns cancellation and resource cleanup without replacing PDF.js", () => {
  assert.match(source, /pdfSession\.trackLoadingTask\(loadingTask\)/);
  assert.match(source, /pdfSession\?\.trackRenderTask\?\.\(renderTask\)/);
  assert.match(source, /window\.addEventListener\("pagehide", disposePdfView/);
  assert.match(source, /io\.disconnect\(\)/);
  assert.match(source, /pdf\.destroy\(\)/);
  assert.match(source, /disableRange: true, disableStream: true, disableAutoFetch: true/);
});

test("PDF iframe continues to use the established raw controls behind a fixed-origin adapter", () => {
  assert.match(source, /const parent = Object\.freeze\(/);
  assert.match(source, /postLegacyEvent\?\.\(actualParent, pdfBootstrap, payload\)/);
  assert.match(source, /boundedSearchResultsPayload\(\)/);
  assert.match(source, /command\.action === "close-document"/);
  assert.match(source, /cancelRenderOperation\(command\.payload\.operationId\)/);
});
