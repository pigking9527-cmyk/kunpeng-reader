import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { validateReaderPageTsManifest } from "./reader-page-ts-manifest.mjs";
import { verifyReaderPageTsOutput } from "./verify-reader-page-ts-output.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

test("embedded manifest rejects view sources, renamed output, and HTML hosts", () => {
  const base = {
    schemaVersion: 1,
    outputDirectory: "ui/generated-reader-page-ts",
    entries: [{
      id: "reader-page-example-rules",
      source: "apps/desktop-ui/src/legacy-ts/reader-page-modules/reader-page-example-rules.ts",
      output: "reader-page-example-rules.js",
      globalName: "ReaderPageExampleRules",
      installExport: "installReaderPageExampleRules",
      replaces: "ui/reader-page-example-rules.js",
      after: "ui/reader-page-bug-trace.js",
      before: "ui/reader-page-layout.js",
    }],
  };
  const view = structuredClone(base);
  view.entries[0].source = "apps/desktop-ui/src/legacy-ts/reader-page-modules/reader-page-example-rules.tsx";
  assert.throws(() => validateReaderPageTsManifest(view, repositoryRoot), /strict reader-page TypeScript/u);
  const renamed = structuredClone(base);
  renamed.entries[0].output = "renamed.js";
  renamed.entries[0].replaces = "ui/renamed.js";
  assert.throws(() => validateReaderPageTsManifest(renamed, repositoryRoot), /source basename/u);
  const htmlHost = structuredClone(base);
  htmlHost.entries[0].before = "ui/reader.html";
  assert.throws(() => validateReaderPageTsManifest(htmlHost, repositoryRoot), /next injected reader-page module/u);
  const terminal = structuredClone(base);
  terminal.entries[0].terminal = true;
  assert.throws(() => validateReaderPageTsManifest(terminal, repositoryRoot), /both terminal and before/u);
  delete terminal.entries[0].before;
  assert.equal(validateReaderPageTsManifest(terminal, repositoryRoot).entries[0].terminal, true);

  const combined = structuredClone(base);
  combined.entries[0] = {
    ...combined.entries[0],
    id: "reader-page-layout-annotations",
    source: "apps/desktop-ui/src/legacy-ts/reader-page-modules/reader-page-layout-annotations.ts",
    output: "reader-page-layout-annotations.js",
    replaces: [
      "ui/reader-page-layout.js",
      "ui/reader-page-end.js",
      "ui/reader-page-pagination.js",
      "ui/reader-page-measurement.js",
      "ui/reader-page-highlight-rules.js",
      "ui/reader-page-annotations.js",
    ],
  };
  const combinedEntry = validateReaderPageTsManifest(combined, repositoryRoot).entries[0];
  assert.deepEqual(combinedEntry.replacementList, combined.entries[0].replaces);
  const duplicate = structuredClone(combined);
  duplicate.entries[0].replaces.push("ui/reader-page-layout.js");
  assert.throws(() => validateReaderPageTsManifest(duplicate, repositoryRoot), /duplicates/u);
  const unrelated = structuredClone(combined);
  unrelated.entries[0].replaces[2] = "ui/reader.html";
  assert.throws(() => validateReaderPageTsManifest(unrelated, repositoryRoot), /reader-page JavaScript paths/u);
  const noncontiguous = structuredClone(combined);
  noncontiguous.entries[0].replaces.splice(2, 1);
  assert.throws(() => validateReaderPageTsManifest(noncontiguous, repositoryRoot), /contiguous/u);
});

test("current embedded outputs are deterministic classic IIFEs injected exactly once", async () => {
  const manifest = await verifyReaderPageTsOutput(repositoryRoot);
  assert.deepEqual(manifest.entries.map(({ id }) => id), [
    "reader-page-bug-trace", "reader-page-scroll-rules", "reader-page-layout-annotations",
    "reader-page-mode-switch", "reader-page-runtime", "reader-page-transition",
  ]);
  const htmlManifest = await readFile(resolve(repositoryRoot, "apps/desktop-ui/legacy-ts.entries.json"), "utf8");
  for (const entry of manifest.entries) {
    assert.equal(htmlManifest.includes(entry.id), false, `${entry.id} must not enter the HTML classic manifest`);
    const output = await readFile(resolve(repositoryRoot, manifest.outputDirectory, entry.output), "utf8");
    assert.match(output, /^\s*\(function\s*\(/u);
    assert.doesNotMatch(output, /\bimport\s*\(|\beval\s*\(/u);
  }
  const combined = manifest.entries.find(({ id }) => id === "reader-page-layout-annotations");
  assert(combined);
  assert.deepEqual(combined.replaces, [
    "ui/reader-page-layout.js", "ui/reader-page-end.js", "ui/reader-page-pagination.js",
    "ui/reader-page-measurement.js", "ui/reader-page-highlight-rules.js", "ui/reader-page-annotations.js",
  ]);
  const combinedOutput = await readFile(resolve(repositoryRoot, manifest.outputDirectory, combined.output), "utf8");
  assert.equal((combinedOutput.match(/^\s*\(function\s*\(/gmu) ?? []).length, 1);
  assert.equal((combinedOutput.match(/installReaderPageLayoutAnnotations\(globalThis\)/gu) ?? []).length, 1);
  for (const stale of ["reader-page-end.js", "reader-page-pagination.js", "reader-page-measurement.js", "reader-page-highlight-rules.js"]) {
    await assert.rejects(readFile(resolve(repositoryRoot, manifest.outputDirectory, stale)), /ENOENT/u);
  }
});
