#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const script = new URL("record-reader-sample.mjs", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kunpeng-reader-sample-"));
const sample = join(temporaryDirectory, "sample.epub");
const pdfSample = join(temporaryDirectory, "sample.pdf");
const records = join(temporaryDirectory, "records");
const output = join(records, "sample.json");
const pdfOutput = join(records, "sample-pdf.json");
const firstPageScreenshot = join(temporaryDirectory, "first-page.png");
const pageTurnRecording = join(temporaryDirectory, "page-turn.mov");
const baseArgs = [
  fileURLToPath(script),
  "--format", "epub",
  "--file", sample,
  "--sample-id", "LEGAL-SAMPLE-001",
  "--license", "CC-BY-4.0",
  "--source-id", "approval-2026-001",
  "--units", "12",
  "--app-build", "1.0.0",
  "--platform", "macos-arm64",
  "--device-id", "bench-mac-01",
  "--condition", "cold-start",
    "--warmup", "firstReadableMs=120,115,118",
    "--timing", "firstReadableMs=109,112,110,108,111",
    "--warmup", "turnPageMs=42,41,43",
    "--timing", "turnPageMs=40,41,42,43,44",
    "--warmup", "searchMs=62,61,63",
    "--timing", "searchMs=60,61,62,63,64",
  "--memory-cycle-5-mib", "420",
  "--memory-cycle-20-mib", "435",
];

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

function replaceScalar(args, key, value) {
  const index = args.indexOf(key);
  assert.notEqual(index, -1, `${key} must occur in the base arguments`);
  const updated = [...args];
  updated[index + 1] = value;
  return updated;
}

try {
  // Deliberately not an EPUB fixture: the recorder only hashes bytes and must
  // never parse, copy, or persist reading content.
  writeFileSync(sample, "%PDF-like-content-is-not-read", "utf8");
  writeFileSync(pdfSample, "%PDF-like-content-is-not-read", "utf8");
  writeFileSync(firstPageScreenshot, "not-a-real-image", "utf8");
  writeFileSync(pageTurnRecording, "not-a-real-recording", "utf8");
  mkdirSync(records);

  const success = run([
    ...baseArgs,
    "--screenshot", `EPUB-FIRST-PAGE=${firstPageScreenshot}`,
    "--recording", `EPUB-PAGE-TURN=${pageTurnRecording}`,
    "--screenshot", `EPUB-SEARCH=${firstPageScreenshot}`,
    "--output", output,
  ]);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /已写入私有验收记录/u);
  assert.doesNotMatch(success.stdout, new RegExp(temporaryDirectory.replaceAll("/", "\\\\/"), "u"));
  const record = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(record.sample.format, "epub");
  assert.equal(record.schemaVersion, 3);
  assert.match(record.sample.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(record.sample.unitKind, "chapters");
  assert.deepEqual(record.metrics.firstReadableMs, {
    warmupMs: [120, 115, 118],
    measuredMs: [109, 112, 110, 108, 111],
    p50Ms: 110,
    p95Ms: 112,
  });
  assert.deepEqual(record.evidence.map(({ id, kind }) => ({ id, kind })), [
    { id: "EPUB-FIRST-PAGE", kind: "screenshot" },
    { id: "EPUB-SEARCH", kind: "screenshot" },
    { id: "EPUB-PAGE-TURN", kind: "recording" },
  ]);
  assert.match(record.evidence[0].sha256, /^[a-f0-9]{64}$/u);
  assert.match(record.evidence[1].sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(record.privacy, {
    samplePathRecorded: false,
    titleRecorded: false,
    contentRecorded: false,
    screenshotOrVideoContentRecorded: false,
    evidencePathRecorded: false,
    evidenceMetadataRecorded: true,
  });
  assert.doesNotMatch(JSON.stringify(record), /sample\.epub|PDF-like-content-is-not-read|first-page\.png|not-a-real-image|page-turn\.mov|not-a-real-recording/u);

  const pdfArgs = replaceScalar(
    replaceScalar(
      replaceScalar(baseArgs, "--format", "pdf"),
      "--file",
      pdfSample,
    ),
    "--sample-id",
    "LEGAL-PDF-001",
  );
  const pdfSuccess = run([
    ...pdfArgs,
    "--warmup", "pdfRenderMs=60,61,62",
    "--timing", "pdfRenderMs=60,61,62,63,64",
    "--warmup", "zoomMs=70,71,72",
    "--timing", "zoomMs=70,71,72,73,74",
    "--screenshot", `PDF-FIRST-PAGE=${firstPageScreenshot}`,
    "--recording", `PDF-PAGE-TURN=${pageTurnRecording}`,
    "--screenshot", `PDF-SEARCH=${firstPageScreenshot}`,
    "--recording", `PDF-RENDER-ZOOM=${pageTurnRecording}`,
    "--output", pdfOutput,
  ]);
  assert.equal(pdfSuccess.status, 0, pdfSuccess.stderr);
  const pdfRecord = JSON.parse(readFileSync(pdfOutput, "utf8"));
  assert.equal(pdfRecord.sample.unitKind, "pages");
  assert.deepEqual(Object.keys(pdfRecord.metrics).sort(), [
    "firstReadableMs", "pdfRenderMs", "searchMs", "turnPageMs", "zoomMs",
  ]);

  const unknownArgument = run([...baseArgs, "--title", "private-title", "--output", join(records, "unknown.json")]);
  assert.equal(unknownArgument.status, 2);
  assert.match(unknownArgument.stderr, /不允许参数 --title/u);

  const sourceIdIndex = baseArgs.indexOf("--source-id");
  const forbiddenReference = run([
    ...baseArgs.slice(0, sourceIdIndex + 1),
    "https://private.example/sample",
    ...baseArgs.slice(sourceIdIndex + 2),
    "--output", join(records, "bad-reference.json"),
  ]);
  assert.equal(forbiddenReference.status, 2);
  assert.match(forbiddenReference.stderr, /不能包含 URL 或文件路径/u);

  const repositoryOutput = run([...baseArgs, "--output", fileURLToPath(new URL("docs/testing/forbidden-reader-sample.json", root))]);
  assert.equal(repositoryOutput.status, 2);
  assert.match(repositoryOutput.stderr, /仓库外/u);

  const repositoryEvidence = run([
    ...baseArgs,
    "--screenshot", `FORBIDDEN=${fileURLToPath(new URL("docs/testing/reader-pdf-sample-record.template.json", root))}`,
    "--output", join(records, "bad-evidence.json"),
  ]);
  assert.equal(repositoryEvidence.status, 2);
  assert.match(repositoryEvidence.stderr, /媒体文件必须位于仓库外/u);

  console.log("reader sample recorder checks passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
