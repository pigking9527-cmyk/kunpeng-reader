#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));
const args = process.argv.slice(2);
const values = new Map();
const repeated = new Map();
const allowedKeys = new Set([
  "--format",
  "--file",
  "--sample-id",
  "--license",
  "--source-id",
  "--units",
  "--app-build",
  "--platform",
  "--device-id",
  "--condition",
  "--warmup",
  "--timing",
  "--screenshot",
  "--recording",
  "--memory-cycle-5-mib",
  "--memory-cycle-20-mib",
  "--output",
]);

const requiredMetricsByFormat = {
  epub: ["firstReadableMs", "turnPageMs", "searchMs"],
  pdf: ["firstReadableMs", "turnPageMs", "searchMs", "pdfRenderMs", "zoomMs"],
};

const requiredEvidenceIdsByFormat = {
  epub: ["EPUB-FIRST-PAGE", "EPUB-PAGE-TURN", "EPUB-SEARCH"],
  pdf: ["PDF-FIRST-PAGE", "PDF-PAGE-TURN", "PDF-SEARCH", "PDF-RENDER-ZOOM"],
};

function usage(message) {
  if (message) console.error(`错误：${message}`);
  console.error(`用法：
  node scripts/record-reader-sample.mjs \\
    --format epub|pdf --file /受控样本/reader.epub \\
    --sample-id LEGAL-SAMPLE-001 --license SPDX-or-approved-reference \\
    --source-id approved-source-reference --units 12 \\
    --app-build 1.0.0 --platform macos-arm64 --device-id bench-mac-01 --condition cold-start \\
    --warmup firstReadableMs=120,115,118 \\
    --timing firstReadableMs=109,112,110,108,111 \\
    --memory-cycle-5-mib 420 --memory-cycle-20-mib 435 \\
    --output /受控验收记录/epub-LEGAL-SAMPLE-001.json

每个 --warmup 必须有 3 个毫秒值；每个 --timing 必须有 5 个毫秒值。
EPUB 必须记录 firstReadableMs、turnPageMs、searchMs；PDF 还必须记录 pdfRenderMs、zoomMs。
可重复传入 --screenshot 或 --recording，EPUB 必须覆盖 EPUB-FIRST-PAGE、EPUB-PAGE-TURN、EPUB-SEARCH；PDF 必须覆盖 PDF-FIRST-PAGE、PDF-PAGE-TURN、PDF-SEARCH、PDF-RENDER-ZOOM。
输出文件与证据文件都必须在仓库外；工具只写入 SHA-256、证据编号和显式传入的匿名元数据，绝不写入样本或证据路径、标题、正文、URL 或媒体内容。`);
  process.exit(2);
}

function addRepeated(key, value) {
  const list = repeated.get(key) ?? [];
  list.push(value);
  repeated.set(key, list);
}

for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (!key.startsWith("--") || !allowedKeys.has(key)) usage(`不允许参数 ${key}`);
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage(`参数 ${key} 缺少值`);
  index += 1;
  if (key === "--warmup" || key === "--timing" || key === "--screenshot" || key === "--recording") addRepeated(key, value);
  else if (values.has(key)) usage(`参数 ${key} 只能指定一次`);
  else values.set(key, value);
}

const required = ["--format", "--file", "--sample-id", "--license", "--source-id", "--units", "--app-build", "--platform", "--device-id", "--condition", "--output"];
for (const key of required) if (!values.has(key)) usage(`缺少必填参数 ${key}`);

const format = values.get("--format");
if (format !== "epub" && format !== "pdf") usage("--format 只能是 epub 或 pdf");

function safeReference(value, field) {
  if (value.length === 0 || value.length > 160 || /[\\/]/u.test(value) || value.includes("://") || value.startsWith("file:")) {
    throw new Error(`${field} 必须是简短的非路径引用，不能包含 URL 或文件路径`);
  }
  return value;
}

function parsePositiveInteger(value, field) {
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${field} 必须是正整数`);
  return Number(value);
}

function parseMiB(value, field) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${field} 必须是非负数字`);
  return parsed;
}

function parseMeasurements(entries, expectedCount, field) {
  const result = {};
  for (const entry of entries) {
    const match = /^([A-Za-z][A-Za-z0-9]*Ms)=([0-9]+(?:\.[0-9]+)?(?:,[0-9]+(?:\.[0-9]+)?){0,})$/u.exec(entry);
    if (!match) throw new Error(`${field} 格式应为 metricMs=值1,值2,...`);
    const [, name, rawValues] = match;
    if (Object.hasOwn(result, name)) throw new Error(`${field} 中的 ${name} 重复`);
    const measurements = rawValues.split(",").map(Number);
    if (measurements.length !== expectedCount || measurements.some((value) => !Number.isFinite(value) || value < 0)) {
      throw new Error(`${field} 的 ${name} 必须恰有 ${expectedCount} 个非负毫秒值`);
    }
    result[name] = measurements;
  }
  return result;
}

function isOutsideRepository(path) {
  const relativePath = relative(repositoryRoot, path);
  return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\");
}

function parseEvidence(entries, kind) {
  const ids = new Set();
  return entries.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`--${kind} 格式应为证据编号=/仓库外/受控媒体文件`);
    }
    const id = safeReference(entry.slice(0, separator), `--${kind} 证据编号`);
    if (ids.has(id)) throw new Error(`--${kind} 中的证据编号 ${id} 重复`);
    ids.add(id);

    const requestedPath = entry.slice(separator + 1);
    if (!isAbsolute(requestedPath)) throw new Error(`--${kind} 的媒体文件必须使用绝对路径`);
    const mediaPath = realpathSync(requestedPath);
    if (!isOutsideRepository(mediaPath)) throw new Error(`--${kind} 的媒体文件必须位于仓库外`);
    if (!statSync(mediaPath).isFile()) throw new Error(`--${kind} 的媒体文件必须是普通文件`);
    return { id, kind, mediaPath };
  });
}

function percentile(sorted, percentileValue) {
  return sorted[Math.ceil(sorted.length * percentileValue) - 1];
}

async function sha256(file) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

try {
  const samplePath = realpathSync(values.get("--file"));
  if (!existsSync(samplePath)) throw new Error("--file 指向的样本不存在");
  if (extname(samplePath).toLowerCase() !== `.${format}`) throw new Error(`--file 的扩展名必须为 .${format}`);
  const requestedOutput = values.get("--output");
  const outputPath = resolve(requestedOutput);
  if (!isAbsolute(requestedOutput)) throw new Error("--output 必须是绝对路径");
  const outputDirectory = realpathSync(dirname(outputPath));
  const resolvedOutput = resolve(outputDirectory, basename(outputPath));
  if (!isOutsideRepository(resolvedOutput)) throw new Error("--output 必须位于仓库外，避免把验收记录或私密引用提交进仓库");

  const sampleId = safeReference(values.get("--sample-id"), "--sample-id");
  const license = safeReference(values.get("--license"), "--license");
  const sourceId = safeReference(values.get("--source-id"), "--source-id");
  const appBuild = safeReference(values.get("--app-build"), "--app-build");
  const platform = safeReference(values.get("--platform"), "--platform");
  const deviceId = safeReference(values.get("--device-id"), "--device-id");
  const condition = safeReference(values.get("--condition"), "--condition");
  const units = parsePositiveInteger(values.get("--units"), "--units");
  const warmups = parseMeasurements(repeated.get("--warmup") ?? [], 3, "--warmup");
  const timings = parseMeasurements(repeated.get("--timing") ?? [], 5, "--timing");
  const timingNames = Object.keys(timings);
  const requiredMetrics = requiredMetricsByFormat[format];
  const missingMetrics = requiredMetrics.filter((name) => !Object.hasOwn(timings, name));
  if (missingMetrics.length > 0) throw new Error(`--timing 缺少 ${format.toUpperCase()} 必填项目：${missingMetrics.join(", ")}`);
  for (const name of timingNames) if (!Object.hasOwn(warmups, name)) throw new Error(`--timing 的 ${name} 缺少对应的 3 次 --warmup`);
  for (const name of Object.keys(warmups)) if (!Object.hasOwn(timings, name)) throw new Error(`--warmup 的 ${name} 缺少对应的 5 次 --timing`);

  const hasCycle5 = values.has("--memory-cycle-5-mib");
  const hasCycle20 = values.has("--memory-cycle-20-mib");
  if (hasCycle5 !== hasCycle20) throw new Error("内存循环记录必须同时提供第 5 次和第 20 次工作集");
  const memory = hasCycle5 ? (() => {
    const cycle5MiB = parseMiB(values.get("--memory-cycle-5-mib"), "--memory-cycle-5-mib");
    const cycle20MiB = parseMiB(values.get("--memory-cycle-20-mib"), "--memory-cycle-20-mib");
    const growthMiB = cycle20MiB - cycle5MiB;
    return { cycle5MiB, cycle20MiB, growthMiB, within100MiBLimit: growthMiB <= 100 };
  })() : null;

  const evidence = [
    ...parseEvidence(repeated.get("--screenshot") ?? [], "screenshot"),
    ...parseEvidence(repeated.get("--recording") ?? [], "recording"),
  ];
  const evidenceIds = new Set();
  for (const item of evidence) {
    if (evidenceIds.has(item.id)) throw new Error(`证据编号 ${item.id} 不能同时用于截图和录屏`);
    evidenceIds.add(item.id);
  }
  const requiredEvidenceIds = requiredEvidenceIdsByFormat[format];
  const missingEvidence = requiredEvidenceIds.filter((id) => !evidenceIds.has(id));
  if (missingEvidence.length > 0) throw new Error(`缺少 ${format.toUpperCase()} 必填视觉证据：${missingEvidence.join(", ")}`);

  const metrics = Object.fromEntries(timingNames.map((name) => {
    const sorted = [...timings[name]].sort((left, right) => left - right);
    return [name, {
      warmupMs: warmups[name],
      measuredMs: timings[name],
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    }];
  }));

  const record = {
    schemaVersion: 3,
    recordedAt: new Date().toISOString(),
    sample: {
      id: sampleId,
      format,
      sha256: await sha256(samplePath),
      license,
      sourceId,
      unitKind: format === "epub" ? "chapters" : "pages",
      unitCount: units,
    },
    environment: { appBuild, platform, deviceId, condition },
    metrics,
    evidence: await Promise.all(evidence.map(async ({ id, kind, mediaPath }) => ({
      id,
      kind,
      sha256: await sha256(mediaPath),
    }))),
    closeCycleMemory: memory,
    privacy: {
      samplePathRecorded: false,
      titleRecorded: false,
      contentRecorded: false,
      screenshotOrVideoContentRecorded: false,
      evidencePathRecorded: false,
      evidenceMetadataRecorded: evidence.length > 0,
    },
  };

  writeFileSync(resolvedOutput, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  console.log("已写入私有验收记录（路径未输出）");
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}
