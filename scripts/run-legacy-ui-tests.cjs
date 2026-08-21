const { readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const testsDirectory = resolve(__dirname, "..", "ui", "tests");
const testFiles = readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.cjs"))
  .map((entry) => resolve(testsDirectory, entry.name))
  .sort();

if (testFiles.length === 0) {
  throw new Error(`No legacy UI tests found in ${testsDirectory}`);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  cwd: resolve(__dirname, ".."),
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
