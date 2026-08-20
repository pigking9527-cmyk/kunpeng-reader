import { readFile } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

export const manifestRelativePath = "apps/desktop-ui/legacy-ts.entries.json";

function assertPlainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.trim() !== value || !value) {
    throw new Error(`${label} must be a non-empty normalized string.`);
  }
  const normalized = value.replaceAll("\\", "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`${label} must stay inside the repository.`);
  }
  return normalized;
}

function assertIdentifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z_$][\w$]*$/.test(value)) {
    throw new Error(`${label} must be a JavaScript identifier.`);
  }
  return value;
}

function resolveInside(repositoryRoot, relativePath, label) {
  const root = resolve(repositoryRoot);
  const target = resolve(root, relativePath);
  const pathFromRoot = relative(root, target);
  if (!pathFromRoot || pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === "..") {
    throw new Error(`${label} must resolve to a child of the repository root.`);
  }
  return target;
}

export function validateLegacyTsManifest(rawManifest, repositoryRoot) {
  const manifest = assertPlainObject(rawManifest, "legacy TypeScript manifest");
  if (manifest.schemaVersion !== 1) {
    throw new Error("legacy TypeScript manifest schemaVersion must be 1.");
  }
  const outputDirectory = assertSafeRelativePath(
    manifest.outputDirectory,
    "legacy TypeScript outputDirectory",
  );
  if (outputDirectory !== "ui/generated-ts") {
    throw new Error("legacy TypeScript outputDirectory must remain ui/generated-ts.");
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    throw new Error("legacy TypeScript manifest must contain at least one entry.");
  }

  const ids = new Set();
  const outputs = new Set();
  const replacements = new Set();
  const entries = manifest.entries.map((rawEntry, index) => {
    const label = `legacy TypeScript entry ${index}`;
    const entry = assertPlainObject(rawEntry, label);
    const id = assertSafeRelativePath(entry.id, `${label}.id`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) {
      throw new Error(`${label}.id must be unique kebab-case.`);
    }
    ids.add(id);

    const source = assertSafeRelativePath(entry.source, `${label}.source`);
    if (!source.startsWith("apps/desktop-ui/src/legacy-ts/") || extname(source) !== ".ts") {
      throw new Error(`${label}.source must be a .ts file under apps/desktop-ui/src/legacy-ts/.`);
    }
    if (/\.(?:test|type-test)\.ts$/i.test(source) || /\.(?:tsx|jsx)$/i.test(source)) {
      throw new Error(`${label}.source cannot be a test, TSX, or JSX file.`);
    }

    const output = assertSafeRelativePath(entry.output, `${label}.output`);
    if (dirname(output) !== "." || extname(output) !== ".js") {
      throw new Error(`${label}.output must be a single classic .js filename.`);
    }
    if (basename(source, ".ts") !== basename(output, ".js") || outputs.has(output)) {
      throw new Error(`${label}.output must be unique and keep the source filename.`);
    }
    outputs.add(output);

    const replaces = assertSafeRelativePath(entry.replaces, `${label}.replaces`);
    if (replaces !== `ui/${output}` || replacements.has(replaces)) {
      throw new Error(`${label}.replaces must be unique and equal ui/${output}.`);
    }
    replacements.add(replaces);

    if (!Array.isArray(entry.hosts) || entry.hosts.length === 0) {
      throw new Error(`${label}.hosts must name at least one existing ui/*.html page.`);
    }
    const hosts = entry.hosts.map((host, hostIndex) => {
      const normalized = assertSafeRelativePath(host, `${label}.hosts[${hostIndex}]`);
      if (!/^ui\/[^/]+\.html$/.test(normalized)) {
        throw new Error(`${label}.hosts[${hostIndex}] must be a top-level ui/*.html page.`);
      }
      return normalized;
    });

    const globalName = assertIdentifier(entry.globalName, `${label}.globalName`);
    const installExport = assertIdentifier(entry.installExport, `${label}.installExport`);
    resolveInside(repositoryRoot, source, `${label}.source`);
    for (const host of hosts) resolveInside(repositoryRoot, host, `${label}.host`);

    return Object.freeze({ id, source, output, globalName, installExport, replaces, hosts });
  });

  return Object.freeze({ schemaVersion: 1, outputDirectory, entries: Object.freeze(entries) });
}

export async function loadLegacyTsManifest(repositoryRoot) {
  const manifestPath = resolve(repositoryRoot, manifestRelativePath);
  const raw = JSON.parse(await readFile(manifestPath, "utf8"));
  return validateLegacyTsManifest(raw, repositoryRoot);
}
