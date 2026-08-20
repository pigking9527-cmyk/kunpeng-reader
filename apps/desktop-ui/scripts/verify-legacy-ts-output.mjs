import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLegacyTsManifest } from "./legacy-ts-manifest.mjs";
import { buildInputSha256, legacyBuildInputFiles } from "./build-input-fingerprint.mjs";

const forbiddenOutputPatterns = [
  [/(?:^|[;\n])\s*import\s*\(/u, "dynamic import"],
  [/(?:^|[;\n])\s*import\s+(?:[\w*{])/u, "ES module import"],
  [/\bexport\s+(?:default|const|let|var|function|class|\{)/u, "ES module export"],
  [/\bimport\.meta\b/u, "import.meta"],
  [/\beval\s*\(/u, "eval"],
  [/\bnew\s+Function\s*\(/u, "new Function"],
  [/sourceMappingURL=/u, "source map reference"],
];

function scriptReferences(html) {
  return [...html.matchAll(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/giu)].map(
    (match) => Object.freeze({
      source: match[2]?.split(/[?#]/u, 1)[0] ?? "",
      module: /\btype\s*=\s*["']module["']/iu.test(`${match[1] ?? ""} ${match[3] ?? ""}`),
    }),
  );
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export async function verifyLegacyTsOutput(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const manifest = await loadLegacyTsManifest(root);
  const outputDirectory = resolve(root, manifest.outputDirectory);
  const fromRoot = relative(root, outputDirectory);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === "..") {
    throw new Error("Legacy TypeScript output escaped the repository.");
  }

  const actualOutputs = (await readdir(outputDirectory)).sort();
  const expectedOutputs = [
    ...manifest.entries.map((entry) => entry.output),
    "legacy-ts.manifest.json",
  ].sort();
  if (JSON.stringify(actualOutputs) !== JSON.stringify(expectedOutputs)) {
    throw new Error(
      `Legacy TypeScript output set differs from the manifest. Expected ${expectedOutputs.join(", ")}; got ${actualOutputs.join(", ")}.`,
    );
  }

  const buildManifest = JSON.parse(
    await readFile(resolve(outputDirectory, "legacy-ts.manifest.json"), "utf8"),
  );
  if (buildManifest.schemaVersion !== 1 || typeof buildManifest.buildInputSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(buildManifest.buildInputSha256) || !Array.isArray(buildManifest.entries)) {
    throw new Error("Legacy TypeScript build manifest has an invalid shape.");
  }
  if (buildManifest.generator !== "apps/desktop-ui/scripts/build-legacy-ts.mjs") {
    throw new Error("Legacy TypeScript build manifest has an unexpected generator.");
  }
  if (buildManifest.buildInputSha256 !== await buildInputSha256(root, legacyBuildInputFiles)) {
    throw new Error("Legacy TypeScript output was built with stale build inputs.");
  }
  const buildRecords = new Map(buildManifest.entries.map((record) => [record.id, record]));

  for (const entry of manifest.entries) {
    const outputPath = resolve(outputDirectory, entry.output);
    if (!(await stat(outputPath)).isFile()) throw new Error(`${entry.output} is not a file.`);
    const output = await readFile(outputPath, "utf8");
    const source = await readFile(resolve(root, entry.source));
    const record = buildRecords.get(entry.id);
    if (
      !record ||
      record.source !== entry.source ||
      record.output !== entry.output ||
      record.sourceSha256 !== sha256(source) ||
      record.outputSha256 !== sha256(output)
    ) {
      throw new Error(`${entry.output} does not match its source/output SHA-256 record.`);
    }
    if (!/^\s*\(function\s*\(/u.test(output)) {
      throw new Error(`${entry.output} is not a classic IIFE.`);
    }
    for (const [pattern, label] of forbiddenOutputPatterns) {
      if (pattern.test(output)) throw new Error(`${entry.output} contains forbidden ${label}.`);
    }
    if (!output.includes(entry.installExport) || !output.includes("globalThis")) {
      throw new Error(`${entry.output} does not install its declared classic global.`);
    }

    for (const host of entry.hosts) {
      const references = scriptReferences(await readFile(resolve(root, host), "utf8"));
      const legacyReference = entry.replaces.slice("ui/".length);
      const generatedReference = `generated-ts/${entry.output}`;
      const loadedLegacy = references.some((reference) => reference.source === legacyReference);
      const generatedTags = references.filter((reference) => reference.source === generatedReference);
      const loadedGenerated = generatedTags.length > 0;
      if (loadedLegacy === loadedGenerated) {
        throw new Error(
          `${host} must load exactly one of ${legacyReference} or ${generatedReference}.`,
        );
      }
      if (generatedTags.some((reference) => reference.module)) {
        throw new Error(`${host} must load ${generatedReference} as a classic script, not a module.`);
      }
    }
  }
  if (buildRecords.size !== manifest.entries.length) {
    throw new Error("Legacy TypeScript build manifest contains undeclared entries.");
  }
  return manifest;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const repositoryRoot = resolve(dirname(currentFile), "../../..");
  const manifest = await verifyLegacyTsOutput(repositoryRoot);
  console.log(`Verified ${manifest.entries.length} classic TypeScript output entr${manifest.entries.length === 1 ? "y" : "ies"}.`);
}
