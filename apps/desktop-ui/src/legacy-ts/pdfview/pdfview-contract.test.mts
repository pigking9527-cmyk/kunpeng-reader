import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedPdfSearchResults,
  clampPdfScale,
  countReadablePdfChars,
  fitPdfScale,
  normalisePdfPage,
  pdfTurnTarget,
} from "./pdfview-contract.ts";

test("PDF search results retain the historic page/chapter projection and payload ceiling", () => {
  const matches = [
    { page: 2, snippet: "第一处" },
    { page: 9, snippet: "第二处" },
  ];
  const result = boundedPdfSearchResults(matches, 90, (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength);
  assert.deepEqual(result, { searchResults: [{ page: 2, chapter: 1, snippet: "第一处" }], searchCount: 2 });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(countReadablePdfChars(" PDF\n文字 \t层 "), 6);
});

test("PDF navigation keeps single-page and spread-pair turns plus page bounds", () => {
  assert.equal(pdfTurnTarget(4, 1, false), 5);
  assert.equal(pdfTurnTarget(4, 1, true), 5);
  assert.equal(pdfTurnTarget(5, -1, true), 3);
  assert.equal(normalisePdfPage(12, -5), 1);
  assert.equal(normalisePdfPage(12, 20), 12);
});

test("PDF scale retains its 0.4–4 range and double-page fitting geometry", () => {
  assert.equal(clampPdfScale(0.1), 0.4);
  assert.equal(clampPdfScale(8), 4);
  assert.equal(fitPdfScale(1228, 600, false), 2);
  assert.equal(fitPdfScale(1240, 600, true), 1);
});
