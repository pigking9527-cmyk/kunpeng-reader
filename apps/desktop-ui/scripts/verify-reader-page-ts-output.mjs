import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadReaderPageTsManifest } from "./reader-page-ts-manifest.mjs";
import { buildInputSha256, readerPageBuildInputFiles } from "./build-input-fingerprint.mjs";

const forbidden = [
  /\bimport\s*\(/u,
  /\bexport\s+(?:default|const|let|var|function|class|\{)/u,
  /\bimport\.meta\b/u,
  /\beval\s*\(/u,
  /\bnew\s+Function\s*\(/u,
  /sourceMappingURL=/u,
];
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function verifyReaderPageTsOutput(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const manifest = await loadReaderPageTsManifest(root);
  const outputDirectory = resolve(root, manifest.outputDirectory);
  const expected = [...manifest.entries.map(({ output }) => output), "reader-page-ts.manifest.json"].sort();
  const actual = (await readdir(outputDirectory)).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Embedded reader-page output differs from the manifest: ${actual.join(", ")}`);
  }
  const buildManifest = JSON.parse(await readFile(resolve(outputDirectory, "reader-page-ts.manifest.json"), "utf8"));
  if (buildManifest.schemaVersion !== 1 || buildManifest.generator !== "apps/desktop-ui/scripts/build-reader-page-ts.mjs" ||
    typeof buildManifest.buildInputSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(buildManifest.buildInputSha256) ||
    !Array.isArray(buildManifest.entries)) {
    throw new Error("Embedded reader-page build manifest has an invalid shape.");
  }
  if (buildManifest.buildInputSha256 !== await buildInputSha256(root, readerPageBuildInputFiles)) {
    throw new Error("Embedded reader-page output was built with stale build inputs.");
  }
  const records = new Map(buildManifest.entries.map((record) => [record.id, record]));
  const rust = await readFile(resolve(root, "src/reader_page.rs"), "utf8");
  const generatedByReplacement = new Map(
    manifest.entries.flatMap((entry) => entry.replacementList.map((replacement) => [
      replacement, `include_str!("../${manifest.outputDirectory}/${entry.output}")`,
    ])),
  );
  const injectedInclude = (logicalPath) => generatedByReplacement.get(logicalPath) ??
    `include_str!("../${logicalPath}")`;
  for (const entry of manifest.entries) {
    const outputPath = resolve(outputDirectory, entry.output);
    if (!(await stat(outputPath)).isFile()) throw new Error(`${entry.output} is not a file.`);
    const [source, output] = await Promise.all([
      readFile(resolve(root, entry.source)),
      readFile(outputPath, "utf8"),
    ]);
    const record = records.get(entry.id);
    if (!record || record.source !== entry.source || record.output !== entry.output ||
      JSON.stringify(record.replaces) !== JSON.stringify(entry.replaces) ||
      record.after !== entry.after || record.before !== entry.before ||
      record.terminal !== entry.terminal ||
      record.sourceSha256 !== sha256(source) || record.outputSha256 !== sha256(output)) {
      throw new Error(`${entry.output} does not match its source/output record.`);
    }
    if (!/^\s*\(function\s*\(/u.test(output) || forbidden.some((pattern) => pattern.test(output))) {
      throw new Error(`${entry.output} is not a safe classic IIFE.`);
    }
    if (!output.includes(entry.installExport) || !output.includes("globalThis")) {
      throw new Error(`${entry.output} does not install the declared global API.`);
    }
    const generatedInclude = `include_str!("../${manifest.outputDirectory}/${entry.output}")`;
    const legacyIncludes = entry.replacementList.map((replacement) => `include_str!("../${replacement}")`);
    if (rust.split(generatedInclude).length !== 2 || legacyIncludes.some((legacyInclude) => rust.includes(legacyInclude))) {
      throw new Error(`src/reader_page.rs must inject exactly one generated ${entry.output} and no legacy copy.`);
    }
    const generatedPosition = rust.indexOf(generatedInclude);
    const previousPosition = rust.indexOf(injectedInclude(entry.after));
    const nextPosition = entry.before === undefined ? -1 : rust.indexOf(injectedInclude(entry.before));
    if (previousPosition < 0 || generatedPosition < 0 || previousPosition >= generatedPosition ||
      (entry.terminal ? rust.indexOf("include_str!", generatedPosition + generatedInclude.length) >= 0 :
        nextPosition < 0 || generatedPosition >= nextPosition)) {
      const placement = entry.terminal ? `after ${entry.after} as the final injected module` :
        `between ${entry.after} and ${entry.before}`;
      throw new Error(`${entry.output} must remain ${placement} in src/reader_page.rs.`);
    }
  }
  if (records.size !== manifest.entries.length) throw new Error("Embedded reader-page build contains undeclared entries.");
  return manifest;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const repositoryRoot = resolve(dirname(currentFile), "../../..");
  const manifest = await verifyReaderPageTsOutput(repositoryRoot);
  console.log(`Verified ${manifest.entries.length} embedded reader-page TypeScript entries.`);
}
