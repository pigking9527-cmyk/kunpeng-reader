#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const script = new URL("record-search-index-benchmark.mjs", import.meta.url);
const hash = (character) => character.repeat(64);
const tempDirectory = mkdtempSync(join(tmpdir(), "kunpeng-search-benchmark-"));
const output = join(tempDirectory, "aggregate.json");
const baseArgs = [
  fileURLToPath(script),
  "--implementation", "current-chapter-index",
  "--corpus-sha256", hash("a"),
  "--corpus-books", "240",
  "--corpus-chapters", "42000",
  "--query-set-sha256", hash("b"),
  "--warmup", `${hash("c")}:${hash("d")}:81:8:12,10,11`,
  "--measurement", `${hash("c")}:${hash("d")}:81:8:9,10,11,8,12`,
  "--warmup", `${hash("f")}:${hash("d")}:43:5:13,12,14`,
  "--measurement", `${hash("f")}:${hash("d")}:43:5:11,12,10,13,11`,
  "--warmup", `${hash("0")}:${hash("d")}:27:2:15,13,14`,
  "--measurement", `${hash("0")}:${hash("d")}:27:2:12,13,11,14,12`,
  "--plan-check", `${hash("e")}:pass`,
];

function run(args) {
  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

try {
  const success = run([...baseArgs, "--output", output]);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.stdout.trim(), "已写入私有聚合基准记录。");
  const record = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(record.implementation, "current-chapter-index");
  assert.deepEqual(record.measurements, [{
    queryLabelSha256: hash("c"),
    scopeLabelSha256: hash("d"),
    candidateRows: 81,
    returnedRows: 8,
    recordedSamples: 5,
    p50Ms: 10,
    p95Ms: 12,
  }, {
    queryLabelSha256: hash("f"),
    scopeLabelSha256: hash("d"),
    candidateRows: 43,
    returnedRows: 5,
    recordedSamples: 5,
    p50Ms: 11,
    p95Ms: 13,
  }, {
    queryLabelSha256: hash("0"),
    scopeLabelSha256: hash("d"),
    candidateRows: 27,
    returnedRows: 2,
    recordedSamples: 5,
    p50Ms: 12,
    p95Ms: 14,
  }]);
  assert.deepEqual(record.queryPlanChecks, [{ checkLabelSha256: hash("e"), passed: true }]);
  assert.deepEqual(record.privacy, {
    corpusPathRecorded: false,
    titleRecorded: false,
    contentRecorded: false,
    queryTextRecorded: false,
    sqlRecorded: false,
    queryPlanTextRecorded: false,
    vectorRecorded: false,
  });

  const forbiddenArgument = run([...baseArgs, "--db", "/private/reader.db", "--output", join(tempDirectory, "forbidden.json")]);
  assert.equal(forbiddenArgument.status, 2);
  assert.match(forbiddenArgument.stderr, /不允许参数 --db/u);

  const repositoryOutput = run([...baseArgs, "--output", fileURLToPath(new URL("docs/testing/forbidden-benchmark.json", root))]);
  assert.equal(repositoryOutput.status, 2);
  assert.match(repositoryOutput.stderr, /仓库外/u);

  const tooFewQueries = run([
    fileURLToPath(script),
    "--implementation", "sqlite-fts5",
    "--corpus-sha256", hash("a"), "--corpus-books", "1", "--corpus-chapters", "1",
    "--query-set-sha256", hash("b"),
    "--warmup", `${hash("c")}:${hash("d")}:1:1:1,1,1`,
    "--measurement", `${hash("c")}:${hash("d")}:1:1:1,1,1,1,1`,
    "--output", join(tempDirectory, "too-few.json"),
  ]);
  assert.equal(tooFewQueries.status, 2);
  assert.match(tooFewQueries.stderr, /三个不同的查询标签/u);

  const ftsWithoutPlanCheck = run([
    fileURLToPath(script),
    "--implementation", "sqlite-fts5",
    "--corpus-sha256", hash("a"), "--corpus-books", "1", "--corpus-chapters", "1",
    "--query-set-sha256", hash("b"),
    "--warmup", `${hash("c")}:${hash("d")}:1:1:1,1,1`, "--measurement", `${hash("c")}:${hash("d")}:1:1:1,1,1,1,1`,
    "--warmup", `${hash("f")}:${hash("d")}:1:1:1,1,1`, "--measurement", `${hash("f")}:${hash("d")}:1:1:1,1,1,1,1`,
    "--warmup", `${hash("0")}:${hash("d")}:1:1:1,1,1`, "--measurement", `${hash("0")}:${hash("d")}:1:1:1,1,1,1,1`,
    "--output", join(tempDirectory, "missing-plan-check.json"),
  ]);
  assert.equal(ftsWithoutPlanCheck.status, 2);
  assert.match(ftsWithoutPlanCheck.stderr, /plan-check/u);

  console.log("search index aggregate benchmark recorder checks passed");
} finally {
  rmSync(tempDirectory, { recursive: true, force: true });
}
