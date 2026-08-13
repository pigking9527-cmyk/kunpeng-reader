#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = new URL("validate-reader-sample-record.mjs", import.meta.url);
const temporaryDirectory = mkdtempSync(join(tmpdir(), "kunpeng-reader-sample-validator-"));
const recordPath = join(temporaryDirectory, "record.json");

const record = {
  schemaVersion: 3,
  recordedAt: "2026-08-13T00:00:00.000Z",
  sample: { id: "LEGAL-EPUB-001", format: "epub", sha256: "a".repeat(64), license: "CC-BY-4.0", sourceId: "approval-2026-001", unitKind: "chapters", unitCount: 12 },
  environment: { appBuild: "1.0.0", platform: "macos-arm64", deviceId: "bench-mac-01", condition: "cold-start" },
  metrics: {
    firstReadableMs: { warmupMs: [120, 115, 118], measuredMs: [109, 112, 110, 108, 111], p50Ms: 110, p95Ms: 112 },
    turnPageMs: { warmupMs: [42, 41, 43], measuredMs: [40, 41, 42, 43, 44], p50Ms: 42, p95Ms: 44 },
    searchMs: { warmupMs: [62, 61, 63], measuredMs: [60, 61, 62, 63, 64], p50Ms: 62, p95Ms: 64 },
  },
  evidence: [
    { id: "EPUB-FIRST-PAGE", kind: "screenshot", sha256: "b".repeat(64) },
    { id: "EPUB-PAGE-TURN", kind: "recording", sha256: "c".repeat(64) },
    { id: "EPUB-SEARCH", kind: "screenshot", sha256: "d".repeat(64) },
  ],
  closeCycleMemory: { cycle5MiB: 420, cycle20MiB: 435, growthMiB: 15, within100MiBLimit: true },
  privacy: { samplePathRecorded: false, titleRecorded: false, contentRecorded: false, screenshotOrVideoContentRecorded: false, evidencePathRecorded: false, evidenceMetadataRecorded: true },
};

function run(path) {
  return spawnSync(process.execPath, [fileURLToPath(script), path], { encoding: "utf8" });
}

function write(value) {
  writeFileSync(recordPath, `${JSON.stringify(value)}\n`, "utf8");
}

try {
  write(record);
  const success = run(recordPath);
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /校验通过/u);
  assert.doesNotMatch(success.stdout, new RegExp(temporaryDirectory.replaceAll("/", "\\\\/"), "u"));

  const missingTiming = JSON.parse(readFileSync(recordPath, "utf8"));
  delete missingTiming.metrics.searchMs;
  write(missingTiming);
  const missingTimingResult = run(recordPath);
  assert.equal(missingTimingResult.status, 2);
  assert.match(missingTimingResult.stderr, /metrics 字段不匹配/u);

  const privacyLeak = structuredClone(record);
  privacyLeak.sample.title = "not-allowed";
  write(privacyLeak);
  const privacyLeakResult = run(recordPath);
  assert.equal(privacyLeakResult.status, 2);
  assert.match(privacyLeakResult.stderr, /sample 字段不匹配/u);

  const pathLeak = structuredClone(record);
  pathLeak.sample.sourceId = "/private/reader.epub";
  write(pathLeak);
  const pathLeakResult = run(recordPath);
  assert.equal(pathLeakResult.status, 2);
  assert.match(pathLeakResult.stderr, /不能包含 URL 或文件路径/u);

  const missingEvidence = structuredClone(record);
  missingEvidence.evidence.pop();
  write(missingEvidence);
  const missingEvidenceResult = run(recordPath);
  assert.equal(missingEvidenceResult.status, 2);
  assert.match(missingEvidenceResult.stderr, /视觉证据/u);

  console.log("reader sample record validator checks passed");
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
