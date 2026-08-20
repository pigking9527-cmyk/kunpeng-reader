#!/usr/bin/env node

/**
 * Records only aggregate, privacy-safe search benchmark measurements.
 *
 * This program deliberately does not open a database, corpus, book, index,
 * model, query file, or vector file.  A separate, controlled harness performs
 * those operations outside the repository and passes only the resulting
 * counts, timings, and SHA-256 labels here.
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const values = new Map();
const repeated = new Map();
const SHA256 = /^[a-f0-9]{64}$/u;
const allowedKeys = new Set([
  "--implementation",
  "--corpus-sha256",
  "--corpus-books",
  "--corpus-chapters",
  "--query-set-sha256",
  "--warmup",
  "--measurement",
  "--plan-check",
  "--output",
]);

function usage(message) {
  if (message) console.error(`错误：${message}`);
  console.error(`用法：
  node scripts/record-search-index-benchmark.mjs \\
    --implementation current-chapter-index|sqlite-fts5 \\
    --corpus-sha256 <64位小写SHA-256> --corpus-books <数量> --corpus-chapters <数量> \\
    --query-set-sha256 <64位小写SHA-256> \\
    --warmup <查询标签SHA>:<范围标签SHA>:<候选行数>:<返回行数>:<3个毫秒值> \\
    --measurement <查询标签SHA>:<范围标签SHA>:<候选行数>:<返回行数>:<5个毫秒值> \\
    --plan-check <检查标签SHA>:pass|fail \\
    --output /受控记录/search-index-aggregate.json

所有标签都是 SHA-256；不要传入书名、路径、正文、查询原文、SQL、EXPLAIN 文本或向量。
输出必须在仓库外。工具不会连接 SQLite、读取书籍/索引/模型，亦不执行任何检索。`);
  process.exit(2);
}

function addRepeated(key, value) {
  const list = repeated.get(key) ?? [];
  list.push(value);
  repeated.set(key, list);
}

for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (!key.startsWith("--")) usage("存在无法识别的参数");
  if (!allowedKeys.has(key)) usage(`不允许参数 ${key}`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`参数 ${key} 缺少值`);
  index += 1;
  if (key === "--warmup" || key === "--measurement" || key === "--plan-check") {
    addRepeated(key, value);
  } else if (values.has(key)) {
    usage(`参数 ${key} 只能指定一次`);
  } else {
    values.set(key, value);
  }
}

for (const key of ["--implementation", "--corpus-sha256", "--corpus-books", "--corpus-chapters", "--query-set-sha256", "--output"]) {
  if (!values.has(key)) usage(`缺少必填参数 ${key}`);
}

function parseSha256(value, field) {
  if (!SHA256.test(value)) throw new Error(`${field} 必须是 64 位小写 SHA-256`);
  return value;
}

function parseCount(value, field, { allowZero = true } = {}) {
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${field} 必须是非负整数`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed === 0)) {
    throw new Error(`${field} 不在允许范围内`);
  }
  return parsed;
}

function parseTimingValues(value, expectedCount, field) {
  const timings = value.split(",").map(Number);
  if (timings.length !== expectedCount || timings.some((timing) => !Number.isFinite(timing) || timing < 0)) {
    throw new Error(`${field} 必须恰有 ${expectedCount} 个非负毫秒值`);
  }
  return timings;
}

function parseMeasurement(value, expectedCount, field) {
  const parts = value.split(":");
  if (parts.length !== 5) throw new Error(`${field} 必须由 5 个冒号分隔字段组成`);
  const [queryLabelSha256, scopeLabelSha256, candidateRows, returnedRows, timings] = parts;
  return {
    queryLabelSha256: parseSha256(queryLabelSha256, `${field} 查询标签`),
    scopeLabelSha256: parseSha256(scopeLabelSha256, `${field} 范围标签`),
    candidateRows: parseCount(candidateRows, `${field} 候选行数`),
    returnedRows: parseCount(returnedRows, `${field} 返回行数`),
    timings: parseTimingValues(timings, expectedCount, field),
  };
}

function percentile(sorted, percentileValue) {
  return sorted[Math.ceil(sorted.length * percentileValue) - 1];
}

function measurementKey(measurement) {
  return `${measurement.queryLabelSha256}:${measurement.scopeLabelSha256}:${measurement.candidateRows}:${measurement.returnedRows}`;
}

try {
  const implementation = values.get("--implementation");
  if (!new Set(["current-chapter-index", "sqlite-fts5"]).has(implementation)) {
    throw new Error("--implementation 只能为 current-chapter-index 或 sqlite-fts5");
  }

  const warmups = (repeated.get("--warmup") ?? []).map((value) => parseMeasurement(value, 3, "--warmup"));
  const measurements = (repeated.get("--measurement") ?? []).map((value) => parseMeasurement(value, 5, "--measurement"));
  if (measurements.length === 0) throw new Error("至少提供一项 --measurement");
  const warmupKeys = new Set(warmups.map(measurementKey));
  const measuredKeys = new Set(measurements.map(measurementKey));
  if (warmupKeys.size !== warmups.length || measuredKeys.size !== measurements.length) {
    throw new Error("同一指标/范围/行数组合不能重复");
  }
  if (warmupKeys.size !== measuredKeys.size || [...measuredKeys].some((key) => !warmupKeys.has(key))) {
    throw new Error("每个 --measurement 必须有且只有一个对应的 --warmup");
  }
  if (new Set(measurements.map((measurement) => measurement.queryLabelSha256)).size < 3) {
    throw new Error("至少记录三个不同的查询标签，覆盖短词、短语和罕见词类别");
  }

  const planChecks = (repeated.get("--plan-check") ?? []).map((value) => {
    const [checkLabelSha256, status, ...extra] = value.split(":");
    if (extra.length !== 0 || !["pass", "fail"].includes(status)) {
      throw new Error("--plan-check 必须是 检查标签SHA:pass 或 检查标签SHA:fail");
    }
    return { checkLabelSha256: parseSha256(checkLabelSha256, "--plan-check 标签"), passed: status === "pass" };
  });
  if (new Set(planChecks.map((item) => item.checkLabelSha256)).size !== planChecks.length) {
    throw new Error("--plan-check 标签不能重复");
  }
  if (implementation === "sqlite-fts5" && planChecks.length === 0) {
    throw new Error("sqlite-fts5 记录必须至少提供一个 --plan-check");
  }

  const requestedOutput = values.get("--output");
  if (!isAbsolute(requestedOutput)) throw new Error("--output 必须是绝对路径");
  const outputPath = resolve(requestedOutput);
  const outputDirectory = dirname(outputPath);
  if (!existsSync(outputDirectory)) throw new Error("--output 的父目录必须已存在");
  const resolvedOutput = resolve(realpathSync(outputDirectory), basename(outputPath));
  if (!relative(repositoryRoot, resolvedOutput).startsWith("..")) {
    throw new Error("--output 必须位于仓库外，避免提交任何基准记录");
  }

  const aggregateMeasurements = measurements.map((measurement) => {
    const sorted = [...measurement.timings].sort((left, right) => left - right);
    return {
      queryLabelSha256: measurement.queryLabelSha256,
      scopeLabelSha256: measurement.scopeLabelSha256,
      candidateRows: measurement.candidateRows,
      returnedRows: measurement.returnedRows,
      recordedSamples: measurement.timings.length,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    };
  });

  const record = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    implementation,
    corpus: {
      sha256: parseSha256(values.get("--corpus-sha256"), "--corpus-sha256"),
      books: parseCount(values.get("--corpus-books"), "--corpus-books", { allowZero: false }),
      chapters: parseCount(values.get("--corpus-chapters"), "--corpus-chapters", { allowZero: false }),
    },
    querySetSha256: parseSha256(values.get("--query-set-sha256"), "--query-set-sha256"),
    measurements: aggregateMeasurements,
    queryPlanChecks: planChecks,
    privacy: {
      corpusPathRecorded: false,
      titleRecorded: false,
      contentRecorded: false,
      queryTextRecorded: false,
      sqlRecorded: false,
      queryPlanTextRecorded: false,
      vectorRecorded: false,
    },
  };

  writeFileSync(resolvedOutput, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log("已写入私有聚合基准记录。");
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
