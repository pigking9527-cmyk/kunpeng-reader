import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoots = [
  join(repositoryRoot, "apps", "desktop-ui", "src"),
  join(repositoryRoot, "packages", "reader-engine", "test"),
  join(repositoryRoot, "packages", "pdf-engine", "test"),
];

function collectTestFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTestFiles(path);
    return entry.isFile() && entry.name.endsWith(".test.mts") ? [path] : [];
  });
}

const missingRoots = testRoots.filter((directory) => !existsSync(directory));
if (missingRoots.length > 0) {
  throw new Error(`Typed test roots are missing:\n${missingRoots.join("\n")}`);
}

const testFiles = testRoots.flatMap(collectTestFiles).sort();
if (testFiles.length === 0) throw new Error("No typed protocol or state tests were found.");

const tsxCli = join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(tsxCli)) throw new Error("The locked tsx test runner is missing. Run npm ci before testing.");

const result = spawnSync(process.execPath, [tsxCli, "--test", ...testFiles], {
  cwd: repositoryRoot,
  env: { ...process.env, FORCE_COLOR: "0" },
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
