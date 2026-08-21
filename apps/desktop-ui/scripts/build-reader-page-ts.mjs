import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReaderPageTsManifest } from "./reader-page-ts-manifest.mjs";
import { buildInputSha256, readerPageBuildInputFiles } from "./build-input-fingerprint.mjs";
import {
  cleanupAbandonedStagingDirectories,
  createBuildStagingDirectory,
} from "./build-staging-directory.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const viteCli = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const viteConfig = resolve(repositoryRoot, "apps/desktop-ui/vite.legacy-ts.config.ts");

function build(entry, directory) {
  const result = spawnSync(process.execPath, [viteCli, "build", "--config", viteConfig, "--logLevel", "warn"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      KUNPENG_LEGACY_TS_SOURCE: entry.source,
      KUNPENG_LEGACY_TS_OUTPUT_DIRECTORY: directory,
      KUNPENG_LEGACY_TS_OUTPUT: entry.output,
      KUNPENG_LEGACY_TS_GLOBAL_NAME: entry.globalName,
      KUNPENG_LEGACY_TS_INSTALL_EXPORT: entry.installExport,
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error([`Vite failed for embedded ${entry.id}.`, result.stdout, result.stderr].filter(Boolean).join("\n"));
  }
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function writeManifest(directory, entries, inputSha256) {
  const records = [];
  for (const entry of entries) {
    const [source, output] = await Promise.all([
      readFile(resolve(repositoryRoot, entry.source)),
      readFile(resolve(directory, entry.output)),
    ]);
    records.push({
      id: entry.id,
      source: entry.source,
      sourceSha256: sha256(source),
      output: entry.output,
      outputSha256: sha256(output),
      replaces: entry.replaces,
      after: entry.after,
      before: entry.before,
      terminal: entry.terminal,
    });
  }
  await writeFile(resolve(directory, "reader-page-ts.manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    generator: "apps/desktop-ui/scripts/build-reader-page-ts.mjs",
    buildInputSha256: inputSha256,
    entries: records,
  }, null, 2)}\n`);
}

async function canReuseBuild(directory, entries, inputSha256) {
  try {
    const expected = [...entries.map(({ output }) => output), "reader-page-ts.manifest.json"].sort();
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expected)) return false;
    const manifest = JSON.parse(await readFile(resolve(directory, "reader-page-ts.manifest.json"), "utf8"));
    if (manifest.schemaVersion !== 1 || manifest.generator !== "apps/desktop-ui/scripts/build-reader-page-ts.mjs" ||
      manifest.buildInputSha256 !== inputSha256 || !Array.isArray(manifest.entries)) return false;
    const records = new Map(manifest.entries.map((entry) => [entry.id, entry]));
    if (records.size !== entries.length) return false;
    for (const entry of entries) {
      const [source, output] = await Promise.all([
        readFile(resolve(repositoryRoot, entry.source)),
        readFile(resolve(directory, entry.output)),
      ]);
      const current = records.get(entry.id);
      if (!current || current.source !== entry.source || current.output !== entry.output ||
        current.sourceSha256 !== sha256(source) || current.outputSha256 !== sha256(output) ||
        JSON.stringify(current.replaces) !== JSON.stringify(entry.replaces) || current.after !== entry.after ||
        current.before !== entry.before || current.terminal !== entry.terminal) return false;
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

async function assertDeterministic(first, second, entries) {
  const expected = [...entries.map(({ output }) => output), "reader-page-ts.manifest.json"].sort();
  for (const directory of [first, second]) {
    const actual = (await readdir(directory)).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Embedded reader-page build emitted unexpected files: ${actual.join(", ")}`);
    }
  }
  for (const file of expected) {
    const [left, right] = await Promise.all([readFile(resolve(first, file)), readFile(resolve(second, file))]);
    if (!left.equals(right)) throw new Error(`Embedded reader-page output is not deterministic: ${file}`);
  }
}

const manifest = await loadReaderPageTsManifest(repositoryRoot);
const deterministic = process.argv.includes("--deterministic");
const destination = resolve(repositoryRoot, manifest.outputDirectory);
const inputSha256 = await buildInputSha256(repositoryRoot, readerPageBuildInputFiles);

for (const directory of await cleanupAbandonedStagingDirectories(
  resolve(repositoryRoot, "ui"),
  ".generated-reader-page-ts-build-",
)) {
  console.log(`Removed abandoned embedded reader-page staging directory: ${directory}`);
}

if (!deterministic && await canReuseBuild(destination, manifest.entries, inputSha256)) {
  console.log(`Reused ${manifest.entries.length} verified embedded reader-page TypeScript entries.`);
  process.exit(0);
}

const temporaryRoot = await createBuildStagingDirectory(
  resolve(repositoryRoot, "ui"),
  ".generated-reader-page-ts-build-",
  "apps/desktop-ui/scripts/build-reader-page-ts.mjs",
);
const first = resolve(temporaryRoot, "first");
const second = resolve(temporaryRoot, "second");

try {
  await mkdir(first);
  if (deterministic) await mkdir(second);
  for (const entry of manifest.entries) {
    build(entry, first);
    if (deterministic) build(entry, second);
  }
  await writeManifest(first, manifest.entries, inputSha256);
  if (deterministic) {
    await writeManifest(second, manifest.entries, inputSha256);
    await assertDeterministic(first, second, manifest.entries);
  }
  await replaceOutputDirectory(first, destination);
  console.log(`Built ${manifest.entries.length} ${deterministic ? "deterministic " : ""}embedded reader-page TypeScript entries.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
