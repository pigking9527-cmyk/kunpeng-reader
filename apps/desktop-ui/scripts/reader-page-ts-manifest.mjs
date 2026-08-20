import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

export const readerPageManifestRelativePath = "apps/desktop-ui/reader-page-ts.entries.json";
const injectionOrder = Object.freeze([
  "ui/reader-page-style.html",
  "ui/reader-page-bug-trace.js",
  "ui/reader-page-scroll-rules.js",
  "ui/reader-page-layout.js",
  "ui/reader-page-end.js",
  "ui/reader-page-pagination.js",
  "ui/reader-page-measurement.js",
  "ui/reader-page-highlight-rules.js",
  "ui/reader-page-annotations.js",
  "ui/reader-page-mode-switch.js",
  "ui/reader-page-runtime.js",
  "ui/reader-page-transition.js",
]);

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function safePath(value, label) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} must be a normalized non-empty path.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return normalized;
}

function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_$][\w$]*$/u.test(value)) {
    throw new Error(`${label} must be a JavaScript identifier.`);
  }
  return value;
}

function replacementPaths(value, label, output) {
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) throw new Error(`${label} must not be empty.`);
  const paths = values.map((item, index) => safePath(item, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error(`${label} must not contain duplicates.`);
  if (paths.some((path) => !path.startsWith("ui/reader-page-") || extname(path) !== ".js")) {
    throw new Error(`${label} must contain reader-page JavaScript paths.`);
  }
  if (!Array.isArray(value) && paths[0] !== `ui/${output}`) {
    throw new Error(`${label} must equal ui/${output} for a single replacement.`);
  }
  if (Array.isArray(value)) {
    const first = injectionOrder.indexOf(paths[0]);
    if (first < 0 || paths.some((path, index) => injectionOrder[first + index] !== path)) {
      throw new Error(`${label} must name one contiguous reader-page injection range.`);
    }
  }
  return Object.freeze(paths);
}

function insideRoot(repositoryRoot, path, label) {
  const root = resolve(repositoryRoot);
  const target = resolve(root, path);
  const fromRoot = relative(root, target);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} must resolve below the repository root.`);
  }
}

export function validateReaderPageTsManifest(raw, repositoryRoot) {
  const manifest = plainObject(raw, "reader-page TypeScript manifest");
  if (manifest.schemaVersion !== 1) throw new Error("reader-page TypeScript manifest schemaVersion must be 1.");
  const outputDirectory = safePath(manifest.outputDirectory, "outputDirectory");
  if (outputDirectory !== "ui/generated-reader-page-ts") {
    throw new Error("reader-page TypeScript outputDirectory must remain ui/generated-reader-page-ts.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("reader-page TypeScript manifest requires entries.");
  }
  const ids = new Set();
  const outputs = new Set();
  const replacements = new Set();
  const entries = manifest.entries.map((rawEntry, index) => {
    const label = `reader-page TypeScript entry ${index}`;
    const entry = plainObject(rawEntry, label);
    const id = safePath(entry.id, `${label}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id) || ids.has(id)) {
      throw new Error(`${label}.id must be unique kebab-case.`);
    }
    ids.add(id);
    const source = safePath(entry.source, `${label}.source`);
    if (!source.startsWith("apps/desktop-ui/src/legacy-ts/reader-page-modules/") || extname(source) !== ".ts") {
      throw new Error(`${label}.source must be strict reader-page TypeScript.`);
    }
    if (/\.(?:test|type-test)\.ts$/iu.test(source) || /\.(?:tsx|jsx)$/iu.test(source)) {
      throw new Error(`${label}.source cannot be a test or view source.`);
    }
    const output = safePath(entry.output, `${label}.output`);
    if (dirname(output) !== "." || extname(output) !== ".js" || outputs.has(output)) {
      throw new Error(`${label}.output must be a unique JavaScript filename.`);
    }
    if (basename(source, ".ts") !== basename(output, ".js")) {
      throw new Error(`${label}.output must keep the source basename.`);
    }
    outputs.add(output);
    const replacementList = replacementPaths(entry.replaces, `${label}.replaces`, output);
    for (const replacement of replacementList) {
      if (replacements.has(replacement)) throw new Error(`${label}.replaces must be unique across entries.`);
      replacements.add(replacement);
    }
    const replaces = Array.isArray(entry.replaces) ? replacementList : replacementList[0];
    const after = safePath(entry.after, `${label}.after`);
    if (!after.startsWith("ui/reader-page-") ||
      (extname(after) !== ".js" && after !== "ui/reader-page-style.html")) {
      throw new Error(`${label}.after must name the previously injected reader-page module.`);
    }
    const terminal = entry.terminal === true;
    if (entry.terminal !== undefined && typeof entry.terminal !== "boolean") {
      throw new Error(`${label}.terminal must be a boolean when present.`);
    }
    if (terminal && entry.before !== undefined) {
      throw new Error(`${label} cannot declare both terminal and before.`);
    }
    if (!terminal && entry.before === undefined) {
      throw new Error(`${label}.before must name the next injected reader-page module.`);
    }
    const before = terminal ? undefined : safePath(entry.before, `${label}.before`);
    if (before !== undefined && (!before.startsWith("ui/reader-page-") || extname(before) !== ".js")) {
      throw new Error(`${label}.before must name the next injected reader-page module.`);
    }
    const globalName = identifier(entry.globalName, `${label}.globalName`);
    const installExport = identifier(entry.installExport, `${label}.installExport`);
    insideRoot(repositoryRoot, source, `${label}.source`);
    for (const replacement of replacementList) {
      insideRoot(repositoryRoot, replacement, `${label}.replaces`);
    }
    insideRoot(repositoryRoot, after, `${label}.after`);
    if (before !== undefined) insideRoot(repositoryRoot, before, `${label}.before`);
    return Object.freeze({
      id, source, output, globalName, installExport, replaces, replacementList, after, before, terminal,
    });
  });
  return Object.freeze({ schemaVersion: 1, outputDirectory, entries: Object.freeze(entries) });
}

export async function loadReaderPageTsManifest(repositoryRoot) {
  const raw = JSON.parse(await readFile(resolve(repositoryRoot, readerPageManifestRelativePath), "utf8"));
  return validateReaderPageTsManifest(raw, repositoryRoot);
}
