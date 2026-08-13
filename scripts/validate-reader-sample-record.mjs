#!/usr/bin/env node

import { existsSync, realpathSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, ".."));
const [recordArgument] = process.argv.slice(2);

const requiredMetricsByFormat = {
  epub: ["firstReadableMs", "turnPageMs", "searchMs"],
  pdf: ["firstReadableMs", "turnPageMs", "searchMs", "pdfRenderMs", "zoomMs"],
};

const requiredEvidenceIdsByFormat = {
  epub: ["EPUB-FIRST-PAGE", "EPUB-PAGE-TURN", "EPUB-SEARCH"],
  pdf: ["PDF-FIRST-PAGE", "PDF-PAGE-TURN", "PDF-SEARCH", "PDF-RENDER-ZOOM"],
};

function fail(message) {
  throw new Error(message);
}

function isOutsideRepository(path) {
  const relativePath = relative(repositoryRoot, path);
  return relativePath === ".." || relativePath.startsWith("../") || relativePath.startsWith("..\\");
}

function object(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${field} 必须是对象`);
  return value;
}

function exactKeys(value, field, expected) {
  const keys = Object.keys(object(value, field)).sort();
  const wanted = [...expected].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    fail(`${field} 字段不匹配；记录不得包含未知字段或遗漏字段`);
  }
}

function safeReference(value, field) {
  if (typeof value !== "string" || value.length === 0 || value.length > 160 || /[\\/]/u.test(value) || value.includes("://") || value.startsWith("file:")) {
    fail(`${field} 必须是简短的非路径引用，不能包含 URL 或文件路径`);
  }
}

function sha256(value, field) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) fail(`${field} 必须是 64 位小写 SHA-256`);
}

function milliseconds(values, expectedLength, field) {
  if (!Array.isArray(values) || values.length !== expectedLength || values.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    fail(`${field} 必须恰有 ${expectedLength} 个非负毫秒数`);
  }
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function validateMetric(name, value) {
  exactKeys(value, `metrics.${name}`, ["warmupMs", "measuredMs", "p50Ms", "p95Ms"]);
  milliseconds(value.warmupMs, 3, `metrics.${name}.warmupMs`);
  milliseconds(value.measuredMs, 5, `metrics.${name}.measuredMs`);
  if (typeof value.p50Ms !== "number" || !Number.isFinite(value.p50Ms) || value.p50Ms !== percentile(value.measuredMs, 0.5)) fail(`metrics.${name}.p50Ms 必须由记录值计算`);
  if (typeof value.p95Ms !== "number" || !Number.isFinite(value.p95Ms) || value.p95Ms !== percentile(value.measuredMs, 0.95)) fail(`metrics.${name}.p95Ms 必须由记录值计算`);
}

function validate(record) {
  exactKeys(record, "记录根对象", ["schemaVersion", "recordedAt", "sample", "environment", "metrics", "evidence", "closeCycleMemory", "privacy"]);
  if (record.schemaVersion !== 3) fail("只接受 schemaVersion 3 的阅读样本记录");
  if (typeof record.recordedAt !== "string" || Number.isNaN(Date.parse(record.recordedAt))) fail("recordedAt 必须是有效 ISO 时间");

  exactKeys(record.sample, "sample", ["id", "format", "sha256", "license", "sourceId", "unitKind", "unitCount"]);
  const { format } = record.sample;
  if (format !== "epub" && format !== "pdf") fail("sample.format 只能是 epub 或 pdf");
  safeReference(record.sample.id, "sample.id");
  safeReference(record.sample.license, "sample.license");
  safeReference(record.sample.sourceId, "sample.sourceId");
  sha256(record.sample.sha256, "sample.sha256");
  if (record.sample.unitKind !== (format === "epub" ? "chapters" : "pages")) fail("sample.unitKind 与格式不一致");
  if (!Number.isInteger(record.sample.unitCount) || record.sample.unitCount < 1) fail("sample.unitCount 必须是正整数");

  exactKeys(record.environment, "environment", ["appBuild", "platform", "deviceId", "condition"]);
  for (const field of ["appBuild", "platform", "deviceId", "condition"]) safeReference(record.environment[field], `environment.${field}`);

  const requiredMetrics = requiredMetricsByFormat[format];
  exactKeys(record.metrics, "metrics", requiredMetrics);
  for (const name of requiredMetrics) validateMetric(name, record.metrics[name]);

  if (!Array.isArray(record.evidence) || record.evidence.length !== requiredEvidenceIdsByFormat[format].length) fail("evidence 必须完整覆盖格式要求的视觉证据");
  const evidenceIds = new Set();
  const evidenceHashes = new Set();
  for (const item of record.evidence) {
    exactKeys(item, "evidence 条目", ["id", "kind", "sha256"]);
    safeReference(item.id, "evidence.id");
    if (item.kind !== "screenshot" && item.kind !== "recording") fail("evidence.kind 只能是 screenshot 或 recording");
    sha256(item.sha256, "evidence.sha256");
    if (evidenceIds.has(item.id)) fail("evidence.id 不能重复");
    if (evidenceHashes.has(item.sha256)) fail("每个必测视觉场景必须使用独立的媒体摘要");
    evidenceIds.add(item.id);
    evidenceHashes.add(item.sha256);
  }
  for (const id of requiredEvidenceIdsByFormat[format]) if (!evidenceIds.has(id)) fail(`evidence 缺少必填视觉证据 ${id}`);

  exactKeys(record.closeCycleMemory, "closeCycleMemory", ["cycle5MiB", "cycle20MiB", "growthMiB", "within100MiBLimit"]);
  for (const field of ["cycle5MiB", "cycle20MiB", "growthMiB"]) if (typeof record.closeCycleMemory[field] !== "number" || !Number.isFinite(record.closeCycleMemory[field])) fail(`closeCycleMemory.${field} 必须是有限数字`);
  if (record.closeCycleMemory.growthMiB !== record.closeCycleMemory.cycle20MiB - record.closeCycleMemory.cycle5MiB) fail("closeCycleMemory.growthMiB 必须由两次工作集计算");
  if (typeof record.closeCycleMemory.within100MiBLimit !== "boolean" || record.closeCycleMemory.within100MiBLimit !== (record.closeCycleMemory.growthMiB <= 100)) fail("closeCycleMemory.within100MiBLimit 必须由增长量计算");

  exactKeys(record.privacy, "privacy", ["samplePathRecorded", "titleRecorded", "contentRecorded", "screenshotOrVideoContentRecorded", "evidencePathRecorded", "evidenceMetadataRecorded"]);
  for (const field of ["samplePathRecorded", "titleRecorded", "contentRecorded", "screenshotOrVideoContentRecorded", "evidencePathRecorded"]) if (record.privacy[field] !== false) fail(`privacy.${field} 必须为 false`);
  if (record.privacy.evidenceMetadataRecorded !== true) fail("privacy.evidenceMetadataRecorded 必须为 true");
}

try {
  if (!recordArgument || process.argv.length !== 3) fail("用法：node scripts/validate-reader-sample-record.mjs /仓库外/record.json");
  if (!isAbsolute(recordArgument)) fail("记录文件必须使用绝对路径");
  if (!existsSync(recordArgument)) fail("记录文件不存在");
  const recordPath = realpathSync(recordArgument);
  if (!isOutsideRepository(recordPath)) fail("记录文件必须位于仓库外");
  if (!statSync(recordPath).isFile()) fail("记录文件必须是普通文件");
  validate(JSON.parse(readFileSync(recordPath, "utf8")));
  console.log("阅读样本记录校验通过（路径未输出）");
} catch (error) {
  console.error(`错误：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}
