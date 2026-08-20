import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLegacyTsManifest } from "../apps/desktop-ui/scripts/legacy-ts-manifest.mjs";

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeMigratedScriptPaths(html, manifest) {
  const replacements = new Map(
    manifest.entries.map((entry) => [
      `generated-ts/${entry.output}`,
      entry.replaces.slice("ui/".length),
    ]),
  );
  return html.replace(
    /(<script\b[^>]*\bsrc\s*=\s*)(["'])([^"']+)(\2)([^>]*>)/giu,
    (tag, prefix, quote, source, closingQuote, suffix) => {
      const [path, tail = ""] = source.split(/(?=[?#])/u, 2);
      const replacement = replacements.get(path);
      return replacement
        ? `${prefix}${quote}${replacement}${tail}${closingQuote}${suffix}`
        : tag;
    },
  );
}

function assertVisualContractShape(visualContract) {
  if (!visualContract || typeof visualContract !== "object" || Array.isArray(visualContract)) {
    throw new Error("scripts/frontend-source-policy.json has no visual contract.");
  }
  for (const kind of ["html", "css"]) {
    const entries = visualContract[kind];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`visualContract.${kind} must be a path-to-SHA-256 object.`);
    }
    for (const [path, digest] of Object.entries(entries)) {
      if (typeof path !== "string" || !/^[a-f0-9]{64}$/u.test(digest)) {
        throw new Error(`visualContract.${kind}.${path} must be a lowercase SHA-256 digest.`);
      }
    }
  }
}

async function verifyVisualContract(root, uiFiles, manifest, visualContract) {
  assertVisualContractShape(visualContract);
  const protectedUiAssets = uiFiles
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .filter((path) => /\.(?:html|css)$/iu.test(path))
    .sort();
  const declaredUiAssets = [
    ...Object.keys(visualContract.html),
    ...Object.keys(visualContract.css),
  ].filter((path) => path.startsWith("ui/")).sort();
  if (JSON.stringify(protectedUiAssets) !== JSON.stringify(declaredUiAssets)) {
    throw new Error(
      `UI HTML/CSS files differ from the original visual contract. Expected ${declaredUiAssets.join(", ")}; got ${protectedUiAssets.join(", ")}.`,
    );
  }
  for (const [path, expected] of Object.entries(visualContract.html)) {
    const html = await readFile(resolve(root, path), "utf8");
    const actual = sha256(normalizeMigratedScriptPaths(html, manifest));
    if (actual !== expected) {
      throw new Error(`${path} changed outside an approved TypeScript script-path migration.`);
    }
  }
  for (const [path, expected] of Object.entries(visualContract.css)) {
    const actual = sha256(await readFile(resolve(root, path)));
    if (actual !== expected) throw new Error(`${path} changed from the original visual contract.`);
  }
}

export async function checkFrontendSourcePolicy(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const desktopRoot = resolve(root, "apps/desktop-ui");
  const sourceRoot = resolve(desktopRoot, "src");
  const files = await collectFiles(desktopRoot);
  const forbiddenVisualFiles = files.filter((path) => /\.(?:jsx|tsx|html|css|scss|sass|less)$/iu.test(path));
  if (forbiddenVisualFiles.length > 0) {
    throw new Error(
      `apps/desktop-ui must remain view-free; found:\n${forbiddenVisualFiles.map((path) => relative(root, path)).join("\n")}`,
    );
  }

  const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  for (const dependency of ["react", "react-dom", "@vitejs/plugin-react"]) {
    if (packageJson.dependencies?.[dependency] || packageJson.devDependencies?.[dependency]) {
      throw new Error(`Forbidden second-UI dependency: ${dependency}`);
    }
  }
  const tauriConfig = JSON.parse(await readFile(resolve(root, "tauri.conf.json"), "utf8"));
  if (tauriConfig.build?.frontendDist !== "./ui") {
    throw new Error("Tauri frontendDist must remain ./ui, the single original UI.");
  }

  const uiFiles = await collectFiles(resolve(root, "ui"));
  const conflictCopies = uiFiles.filter((path) => /(?:^|\/)\S+ 2\.[^/]+$/u.test(path));
  if (conflictCopies.length > 0) {
    throw new Error(
      `ui/ contains duplicate conflict-copy assets that could form a second UI:\n${conflictCopies.map((path) => relative(root, path)).join("\n")}`,
    );
  }

  const manifest = await loadLegacyTsManifest(root);
  const policy = JSON.parse(
    await readFile(resolve(root, "scripts/frontend-source-policy.json"), "utf8"),
  );
  await verifyVisualContract(root, uiFiles, manifest, policy.visualContract);
  for (const entry of manifest.entries) {
    const sourcePath = resolve(root, entry.source);
    const sourceRelativePath = relative(sourceRoot, sourcePath);
    if (sourceRelativePath === ".." || sourceRelativePath.startsWith("../") || sourceRelativePath.startsWith("..\\")) {
      throw new Error(`${entry.source} is outside the view-free TypeScript source root.`);
    }
    const source = await readFile(sourcePath, "utf8");
    for (const [pattern, label] of [
      [/\bimport\s*\(/u, "dynamic import"],
      [/\beval\s*\(/u, "eval"],
      [/\bnew\s+Function\s*\(/u, "new Function"],
    ]) {
      if (pattern.test(source)) throw new Error(`${entry.source} contains forbidden ${label}.`);
    }
  }
  const uiScripts = uiFiles.filter(
    (path) => {
      const normalized = path.replaceAll("\\", "/");
      return normalized.endsWith(".js") && !normalized.includes("/pdfjs/") && !normalized.includes("/bridge/") && !normalized.includes("/generated-ts/") && !normalized.includes("/generated-reader-page-ts/");
    },
  );
  const directTauriUsage = [];
  for (const script of uiScripts) {
    const content = await readFile(script, "utf8");
    const matches = content.match(/__TAURI__/gu) ?? [];
    if (matches.length > 0) {
      directTauriUsage.push(Object.freeze({ file: relative(root, script), occurrences: matches.length }));
    }
  }
  directTauriUsage.sort((left, right) => left.file.localeCompare(right.file));
  const directTauriOccurrences = directTauriUsage.reduce(
    (total, item) => total + item.occurrences,
    0,
  );
  if (
    policy.schemaVersion !== 1 ||
    !Number.isInteger(policy.expectedDirectTauriOccurrences) ||
    policy.expectedDirectTauriOccurrences < 0
  ) {
    throw new Error("scripts/frontend-source-policy.json has an invalid direct Tauri ceiling.");
  }
  if (directTauriOccurrences !== policy.expectedDirectTauriOccurrences) {
    throw new Error(
      `Direct legacy __TAURI__ usage changed from the recorded ${policy.expectedDirectTauriOccurrences} occurrences to ${directTauriOccurrences}; update the baseline downward only after intentional migration.`,
    );
  }
  return Object.freeze({
    checkedFiles: files.length,
    entries: manifest.entries.length,
    directTauriUsage: Object.freeze(directTauriUsage),
    directTauriOccurrences,
    directTauriBaseline: policy.expectedDirectTauriOccurrences,
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const repositoryRoot = resolve(dirname(currentFile), "..");
  const result = await checkFrontendSourcePolicy(repositoryRoot);
  console.log(`Frontend source policy passed (${result.checkedFiles} files, ${result.entries} migration entry).`);
  console.log(`Direct legacy __TAURI__ usage: ${result.directTauriOccurrences}/${result.directTauriBaseline} occurrence(s) in ${result.directTauriUsage.length} file(s).`);
  for (const item of result.directTauriUsage) console.log(`  ${item.file}: ${item.occurrences}`);
}
