import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateLegacyTsManifest } from "./legacy-ts-manifest.mjs";
import { buildInputSha256, legacyBuildInputFiles } from "./build-input-fingerprint.mjs";
import {
  cleanupAbandonedStagingDirectories,
  createBuildStagingDirectory,
} from "./build-staging-directory.mjs";
import { verifyLegacyTsOutput } from "./verify-legacy-ts-output.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function validManifest() {
  return {
    schemaVersion: 1,
    outputDirectory: "ui/generated-ts",
    entries: [{
      id: "example-rules",
      source: "apps/desktop-ui/src/legacy-ts/example-rules.ts",
      output: "example-rules.js",
      globalName: "KunpengExampleRules",
      installExport: "installExampleRules",
      replaces: "ui/example-rules.js",
      hosts: ["ui/index.html"],
    }],
  };
}

test("manifest rejects TSX and renamed output entries", () => {
  const fixture = validManifest();
  fixture.entries[0].source = "apps/desktop-ui/src/legacy-ts/example-rules.tsx";
  assert.throws(() => validateLegacyTsManifest(fixture, repositoryRoot), /\.ts file/u);

  const renamed = validManifest();
  renamed.entries[0].output = "different.js";
  renamed.entries[0].replaces = "ui/different.js";
  assert.throws(() => validateLegacyTsManifest(renamed, repositoryRoot), /keep the source filename/u);
});

test("staging cleanup removes only confirmed abandoned build directories", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "kunpeng-build-staging-"));
  const prefix = ".generated-ts-build-";
  const deadOwner = resolve(parent, `${prefix}9007199254740991-interrupted`);
  const legacyEmpty = resolve(parent, `${prefix}legacy-empty`);
  const legacyWithOutput = resolve(parent, `${prefix}legacy-output`);
  const liveOwner = resolve(parent, `${prefix}${process.pid}-active`);
  const unrelatedOutput = resolve(parent, "generated-ts");
  try {
    await Promise.all([
      mkdir(deadOwner),
      mkdir(resolve(legacyEmpty, "second"), { recursive: true }),
      mkdir(legacyWithOutput),
      mkdir(liveOwner),
      mkdir(unrelatedOutput),
    ]);
    await Promise.all([
      writeFile(resolve(deadOwner, "partial.js"), "partial output\n"),
      writeFile(resolve(legacyWithOutput, "partial.js"), "partial output\n"),
      writeFile(resolve(liveOwner, ".kunpeng-build-staging.json"), "active\n"),
      writeFile(resolve(unrelatedOutput, "keep.js"), "effective output\n"),
    ]);
    const old = new Date(Date.now() - 6 * 60 * 1000);
    await utimes(legacyEmpty, old, old);

    const removed = await cleanupAbandonedStagingDirectories(parent, prefix);
    assert.deepEqual(removed.sort(), [deadOwner, legacyEmpty].sort());
    await Promise.all([
      assert.rejects(stat(deadOwner), /ENOENT/u),
      assert.rejects(stat(legacyEmpty), /ENOENT/u),
      stat(legacyWithOutput),
      stat(liveOwner),
      stat(unrelatedOutput),
    ]);

    const created = await createBuildStagingDirectory(parent, prefix, "fixture-generator");
    assert.match(created, new RegExp(`${prefix}${process.pid}-`, "u"));
    const owner = JSON.parse(await readFile(resolve(created, ".kunpeng-build-staging.json"), "utf8"));
    assert.equal(owner.generator, "fixture-generator");
    assert.equal(owner.ownerPid, process.pid);
    assert.equal((await cleanupAbandonedStagingDirectories(parent, prefix)).includes(created), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("current generated output is a classic script and each host loads one implementation", async () => {
  const manifest = await verifyLegacyTsOutput(repositoryRoot);
  assert.ok(manifest.entries.length > 0);
  const output = await readFile(resolve(repositoryRoot, manifest.outputDirectory, manifest.entries[0].output), "utf8");
  assert.match(output, /^\s*\(function\s*\(/u);
  assert.doesNotMatch(output, /\bimport\s*\(/u);
  assert.doesNotMatch(output, /\beval\s*\(/u);
  const buildManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, manifest.outputDirectory, "legacy-ts.manifest.json"), "utf8"),
  );
  assert.match(buildManifest.entries[0].sourceSha256, /^[a-f0-9]{64}$/u);
  assert.match(buildManifest.entries[0].outputSha256, /^[a-f0-9]{64}$/u);
});

test("verifier rejects a host that loads both implementations", async () => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "kunpeng-legacy-verifier-"));
  try {
    await mkdir(resolve(temporaryRoot, "apps/desktop-ui/src/legacy-ts"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "apps/desktop-ui"), { recursive: true });
    await mkdir(resolve(temporaryRoot, "ui/generated-ts"), { recursive: true });
    const source = "export function installExampleRules() {}\n";
    const output = "(function () { function installExampleRules() {} installExampleRules(globalThis); })();\n";
    const hash = (value) => createHash("sha256").update(value).digest("hex");
    await writeFile(resolve(temporaryRoot, "apps/desktop-ui/src/legacy-ts/example-rules.ts"), source);
    await writeFile(resolve(temporaryRoot, "ui/example-rules.js"), "\n");
    await writeFile(
      resolve(temporaryRoot, "ui/index.html"),
      '<script src="example-rules.js"></script><script src="generated-ts/example-rules.js"></script>',
    );
    await writeFile(
      resolve(temporaryRoot, "apps/desktop-ui/legacy-ts.entries.json"),
      JSON.stringify(validManifest()),
    );
    await Promise.all(legacyBuildInputFiles.map(async (input) => {
      const path = resolve(temporaryRoot, input);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `fixture input for ${input}\n`);
    }));
    await writeFile(resolve(temporaryRoot, "ui/generated-ts/example-rules.js"), output);
    await writeFile(resolve(temporaryRoot, "ui/generated-ts/legacy-ts.manifest.json"), JSON.stringify({
        schemaVersion: 1,
        generator: "apps/desktop-ui/scripts/build-legacy-ts.mjs",
        buildInputSha256: await buildInputSha256(temporaryRoot, legacyBuildInputFiles),
      entries: [{
        id: "example-rules",
        source: "apps/desktop-ui/src/legacy-ts/example-rules.ts",
        sourceSha256: hash(source),
        output: "example-rules.js",
        outputSha256: hash(output),
      }],
    }));
    await assert.rejects(() => verifyLegacyTsOutput(temporaryRoot), /exactly one/u);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
