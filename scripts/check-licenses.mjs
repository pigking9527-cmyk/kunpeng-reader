import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(join(repo, "scripts/license-policy.json"), "utf8"));
const failures = [];

function run(command, args, extra = {}) {
  return execFileSync(command, args, { cwd: repo, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"], ...extra });
}

function licenseIdentifiers(expression) {
  return expression.match(/[A-Za-z0-9][A-Za-z0-9.+-]*/g)?.filter((value) => !["AND", "OR", "WITH"].includes(value)) ?? [];
}

function validateExpression(ecosystem, name, version, expression, allowed) {
  if (!expression || expression === "NOASSERTION") {
    failures.push(`${ecosystem} ${name}@${version}: missing license metadata`);
    return;
  }
  const denied = policy.deniedLicenseTokens.find((token) => expression.toUpperCase().includes(token));
  if (denied) {
    failures.push(`${ecosystem} ${name}@${version}: denied license expression ${expression}`);
    return;
  }
  const ids = licenseIdentifiers(expression);
  const unrecognized = ids.filter((identifier) => !allowed.has(identifier));
  if (unrecognized.length) {
    failures.push(`${ecosystem} ${name}@${version}: unapproved identifiers ${unrecognized.join(", ")} in ${expression}`);
  }
}

function rustTarget() {
  if (process.env.RUST_TARGET) return process.env.RUST_TARGET;
  if (process.env.TARGET) return process.env.TARGET;
  if (process.platform === "darwin") return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  if (process.platform === "win32") return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
}

function legalFiles(packageDir) {
  const matches = [];
  const legalName = /^(license|copying|notice|copyright)([.\-_].*)?$/i;
  let entries = [];
  try {
    entries = readdirSync(packageDir, { withFileTypes: true });
  } catch {
    return matches;
  }
  for (const entry of entries) {
    const path = join(packageDir, entry.name);
    if (entry.isFile() && legalName.test(entry.name)) {
      matches.push(path);
      continue;
    }
    if (entry.isDirectory() && /^(licenses?|legal)$/i.test(entry.name)) {
      for (const nested of readdirSync(path, { withFileTypes: true })) {
        if (nested.isFile()) matches.push(join(path, nested.name));
      }
    }
  }
  return matches.sort();
}

function collectLegalTexts(items) {
  const groups = new Map();
  for (const item of items) {
    for (const path of legalFiles(item.packageDir)) {
      let content;
      try {
        content = readFileSync(path, "utf8").trim();
      } catch {
        continue;
      }
      if (!content || content.includes("\u0000")) continue;
      const hash = createHash("sha256").update(content).digest("hex");
      const existing = groups.get(hash) ?? { content, packages: [], filenames: new Set() };
      existing.packages.push(`${item.name}@${item.version}`);
      existing.filenames.add(path.slice(item.packageDir.length + 1));
      groups.set(hash, existing);
    }
  }
  return [...groups.values()].sort((left, right) => left.packages[0].localeCompare(right.packages[0]));
}

const cargoEnv = { ...process.env };
if (process.env.KUNPENG_LICENSE_OFFLINE === "1") cargoEnv.CARGO_NET_OFFLINE = "true";
const metadata = JSON.parse(run("cargo", ["metadata", "--filter-platform", rustTarget(), "--format-version", "1", "--locked"], { env: cargoEnv }));
const rust = metadata.packages
  .filter((item) => item.source)
  .map((item) => ({
    name: item.name,
    version: item.version,
    license: item.license || "NOASSERTION",
    packageDir: dirname(item.manifest_path)
  }))
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const rustAllowed = new Set(policy.allowedRustLicenseIds);
for (const item of rust) validateExpression("cargo", item.name, item.version, item.license, rustAllowed);

const lock = JSON.parse(readFileSync(join(repo, "package-lock.json"), "utf8"));
const npm = Object.entries(lock.packages || {})
  .filter(([path]) => path.startsWith("node_modules/"))
  .map(([path, item]) => ({
    name: item.name || path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length),
    version: item.version || "unknown",
    license: item.license || "NOASSERTION",
    packageDir: join(repo, path)
  }))
  .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
const npmAllowed = new Set(policy.allowedNpmLicenses);
for (const item of npm) validateExpression("npm", item.name, item.version, item.license, npmAllowed);

for (const path of policy.requiredDistributionNotices) {
  try {
    const content = readFileSync(join(repo, path));
    if (!content.length) failures.push(`required notice is empty: ${path}`);
  } catch {
    failures.push(`required notice is missing: ${path}`);
  }
}

for (const path of policy.forbiddenDistributionPaths || []) {
  try {
    readFileSync(join(repo, path));
    failures.push(`forbidden historical or unreviewed asset is present: ${path}`);
  } catch {
    try {
      const entries = readdirSync(join(repo, path));
      if (entries.length) failures.push(`forbidden historical or unreviewed directory is present: ${path}`);
    } catch {
      // Expected: the path is absent from the release candidate.
    }
  }
}

const output = join(repo, "target/license-audit/DEPENDENCY_LICENSES.md");
mkdirSync(dirname(output), { recursive: true });
const table = (items) => items.map((item) => `| ${item.name.replaceAll("|", "\\|")} | ${item.version} | ${item.license.replaceAll("|", "\\|")} |`).join("\n");
const legalTexts = collectLegalTexts([...rust, ...npm]);
const legalTextArchive = legalTexts.flatMap((entry, index) => [
  `### Text ${index + 1}`,
  "",
  `Applies to: ${[...new Set(entry.packages)].sort().join(", ")}`,
  "",
  `Source filenames: ${[...entry.filenames].sort().join(", ")}`,
  "",
  "````text",
  entry.content,
  "````",
  ""
]);
writeFileSync(output, [
  "# Locked dependency license inventory",
  "",
  "Generated by `scripts/check-licenses.mjs`; do not edit by hand.",
  "",
  "## Cargo dependencies",
  "",
  "| Package | Version | Declared license |",
  "| --- | --- | --- |",
  table(rust),
  "",
  "## npm dependencies",
  "",
  "| Package | Version | Declared license |",
  "| --- | --- | --- |",
  table(npm),
  "",
  "## Bundled dependency license and notice texts",
  "",
  "Identical texts are stored once and mapped to every package that supplied them.",
  "",
  ...legalTextArchive,
  ""
].join("\n"));

if (failures.length) {
  console.error(["License policy failed:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  process.exit(1);
}
console.log(`License policy passed: ${rust.length} Cargo and ${npm.length} npm packages; archived ${legalTexts.length} unique legal texts: ${output}`);
