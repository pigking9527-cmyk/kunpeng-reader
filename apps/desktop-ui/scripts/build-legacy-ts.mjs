import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLegacyTsManifest } from "./legacy-ts-manifest.mjs";
import { buildInputSha256, legacyBuildInputFiles } from "./build-input-fingerprint.mjs";
import {
  cleanupAbandonedStagingDirectories,
  createBuildStagingDirectory,
} from "./build-staging-directory.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const viteCli = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const viteConfig = resolve(repositoryRoot, "apps/desktop-ui/vite.legacy-ts.config.ts");

function buildEntry(entry, outputDirectory) {
  const result = spawnSync(
    process.execPath,
    [viteCli, "build", "--config", viteConfig, "--logLevel", "warn"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        KUNPENG_LEGACY_TS_SOURCE: entry.source,
        KUNPENG_LEGACY_TS_OUTPUT_DIRECTORY: outputDirectory,
        KUNPENG_LEGACY_TS_OUTPUT: entry.output,
        KUNPENG_LEGACY_TS_GLOBAL_NAME: entry.globalName,
        KUNPENG_LEGACY_TS_INSTALL_EXPORT: entry.installExport,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [`Vite failed for ${entry.id}.`, result.stdout, result.stderr].filter(Boolean).join("\n"),
    );
  }
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function writeBuildManifest(outputDirectory, entries, inputSha256) {
  const records = [];
  for (const entry of entries) {
    const [source, output] = await Promise.all([
      readFile(resolve(repositoryRoot, entry.source)),
      readFile(resolve(outputDirectory, entry.output)),
    ]);
    records.push({
      id: entry.id,
      source: entry.source,
      sourceSha256: sha256(source),
      output: entry.output,
      outputSha256: sha256(output),
    });
  }
  const buildManifest = {
    schemaVersion: 1,
    generator: "apps/desktop-ui/scripts/build-legacy-ts.mjs",
    buildInputSha256: inputSha256,
    entries: records,
  };
  await writeFile(
    resolve(outputDirectory, "legacy-ts.manifest.json"),
    `${JSON.stringify(buildManifest, null, 2)}\n`,
  );
}

async function canReuseBuild(outputDirectory, entries, inputSha256) {
  try {
    const expected = [...entries.map((entry) => entry.output), "legacy-ts.manifest.json"].sort();
    if (JSON.stringify((await readdir(outputDirectory)).sort()) !== JSON.stringify(expected)) return false;
    const record = JSON.parse(await readFile(resolve(outputDirectory, "legacy-ts.manifest.json"), "utf8"));
    if (record.schemaVersion !== 1 || record.generator !== "apps/desktop-ui/scripts/build-legacy-ts.mjs" ||
      record.buildInputSha256 !== inputSha256 || !Array.isArray(record.entries)) return false;
    const records = new Map(record.entries.map((entry) => [entry.id, entry]));
    if (records.size !== entries.length) return false;
    for (const entry of entries) {
      const [source, output] = await Promise.all([
        readFile(resolve(repositoryRoot, entry.source)),
        readFile(resolve(outputDirectory, entry.output)),
      ]);
      const current = records.get(entry.id);
      if (!current || current.source !== entry.source || current.output !== entry.output ||
        current.sourceSha256 !== sha256(source) || current.outputSha256 !== sha256(output)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function replaceOutputDirectory(stagedDirectory, outputDirectory) {
  const backupDirectory = `${outputDirectory}.previous-${process.pid}-${Date.now()}`;
  let movedExisting = false;
  try {
    try {
      await stat(outputDirectory);
      await rename(outputDirectory, backupDirectory);
      movedExisting = true;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") throw error;
    }
    await rename(stagedDirectory, outputDirectory);
    if (movedExisting) await rm(backupDirectory, { recursive: true, force: true });
  } catch (error) {
    try {
      await stat(outputDirectory);
    } catch {
      if (movedExisting) await rename(backupDirectory, outputDirectory);
    }
    throw error;
  }
}

async function assertSameBuild(firstDirectory, secondDirectory, entries) {
  const expected = [...entries.map((entry) => entry.output), "legacy-ts.manifest.json"].sort();
  const firstFiles = (await readdir(firstDirectory)).sort();
  const secondFiles = (await readdir(secondDirectory)).sort();
  if (JSON.stringify(firstFiles) !== JSON.stringify(expected)) {
    throw new Error(`First legacy TypeScript build emitted unexpected files: ${firstFiles.join(", ")}`);
  }
  if (JSON.stringify(secondFiles) !== JSON.stringify(expected)) {
    throw new Error(`Second legacy TypeScript build emitted unexpected files: ${secondFiles.join(", ")}`);
  }
  for (const output of expected) {
    const [first, second] = await Promise.all([
      readFile(resolve(firstDirectory, output)),
      readFile(resolve(secondDirectory, output)),
    ]);
    if (!first.equals(second)) {
      throw new Error(`Legacy TypeScript output is not deterministic: ${output}`);
    }
  }
}

const manifest = await loadLegacyTsManifest(repositoryRoot);
const deterministic = process.argv.includes("--deterministic");
const finalDirectory = resolve(repositoryRoot, manifest.outputDirectory);
const inputSha256 = await buildInputSha256(repositoryRoot, legacyBuildInputFiles);

for (const directory of await cleanupAbandonedStagingDirectories(
  resolve(repositoryRoot, "ui"),
  ".generated-ts-build-",
)) {
  console.log(`Removed abandoned classic TypeScript staging directory: ${directory}`);
}

if (!deterministic && await canReuseBuild(finalDirectory, manifest.entries, inputSha256)) {
  console.log(`Reused ${manifest.entries.length} verified classic TypeScript entries.`);
  process.exit(0);
}

const temporaryRoot = await createBuildStagingDirectory(
  resolve(repositoryRoot, "ui"),
  ".generated-ts-build-",
  "apps/desktop-ui/scripts/build-legacy-ts.mjs",
);
const firstDirectory = resolve(temporaryRoot, "first");
const secondDirectory = resolve(temporaryRoot, "second");

try {
  await mkdir(firstDirectory);
  if (deterministic) await mkdir(secondDirectory);
  for (const entry of manifest.entries) {
    buildEntry(entry, firstDirectory);
    if (deterministic) buildEntry(entry, secondDirectory);
  }
  await writeBuildManifest(firstDirectory, manifest.entries, inputSha256);
  if (deterministic) {
    await writeBuildManifest(secondDirectory, manifest.entries, inputSha256);
    await assertSameBuild(firstDirectory, secondDirectory, manifest.entries);
  }
  await replaceOutputDirectory(firstDirectory, finalDirectory);
  console.log(`Built ${manifest.entries.length} ${deterministic ? "deterministic " : ""}classic TypeScript entr${manifest.entries.length === 1 ? "y" : "ies"}.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
