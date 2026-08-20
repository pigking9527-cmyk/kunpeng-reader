import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { checkFrontendSourcePolicy } from "./check-frontend-source-policy.mjs";

test("desktop frontend keeps the original single UI and view-free TypeScript", async () => {
  const result = await checkFrontendSourcePolicy(resolve(import.meta.dirname, ".."));
  assert.ok(result.checkedFiles > 0);
  assert.ok(result.entries > 0);
  assert.ok(result.directTauriOccurrences >= result.directTauriUsage.length);
  assert.equal(result.directTauriOccurrences, result.directTauriBaseline);
});

test("source policy rejects duplicate conflict-copy UI assets", async () => {
  const sourceRoot = resolve(import.meta.dirname, "..");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "kunpeng-source-policy-"));
  try {
    await Promise.all([
      cp(resolve(sourceRoot, "apps"), resolve(temporaryRoot, "apps"), { recursive: true }),
      cp(resolve(sourceRoot, "packages"), resolve(temporaryRoot, "packages"), { recursive: true }),
      cp(resolve(sourceRoot, "scripts"), resolve(temporaryRoot, "scripts"), { recursive: true }),
      cp(resolve(sourceRoot, "ui"), resolve(temporaryRoot, "ui"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(temporaryRoot, "package.json"), '{"private":true}\n'),
      writeFile(resolve(temporaryRoot, "tauri.conf.json"), '{"build":{"frontendDist":"./ui"}}\n'),
      mkdir(resolve(temporaryRoot, "ui"), { recursive: true }),
    ]);
    await writeFile(resolve(temporaryRoot, "ui", "index 2.html"), "duplicate");
    await assert.rejects(
      checkFrontendSourcePolicy(temporaryRoot),
      /duplicate conflict-copy assets/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

async function withTemporaryFrontend(callback) {
  const sourceRoot = resolve(import.meta.dirname, "..");
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "kunpeng-visual-contract-"));
  try {
    await Promise.all([
      cp(resolve(sourceRoot, "apps"), resolve(temporaryRoot, "apps"), { recursive: true }),
      cp(resolve(sourceRoot, "packages"), resolve(temporaryRoot, "packages"), { recursive: true }),
      cp(resolve(sourceRoot, "scripts"), resolve(temporaryRoot, "scripts"), { recursive: true }),
      cp(resolve(sourceRoot, "ui"), resolve(temporaryRoot, "ui"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(resolve(temporaryRoot, "package.json"), '{"private":true}\n'),
      writeFile(resolve(temporaryRoot, "tauri.conf.json"), '{"build":{"frontendDist":"./ui"}}\n'),
    ]);
    await callback(temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

test("source policy rejects original DOM and CSS drift", async () => {
  await withTemporaryFrontend(async (temporaryRoot) => {
    await writeFile(resolve(temporaryRoot, "ui", "index.html"), "<!doctype html><title>replacement</title>\n");
    await assert.rejects(
      checkFrontendSourcePolicy(temporaryRoot),
      /changed outside an approved TypeScript script-path migration/u,
    );
  });
  await withTemporaryFrontend(async (temporaryRoot) => {
    await writeFile(resolve(temporaryRoot, "ui", "styles.css"), "body { display: none; }\n");
    await assert.rejects(
      checkFrontendSourcePolicy(temporaryRoot),
      /changed from the original visual contract/u,
    );
  });
});

test("source policy rejects undeclared UI HTML or CSS", async () => {
  await withTemporaryFrontend(async (temporaryRoot) => {
    await writeFile(resolve(temporaryRoot, "ui", "alternate.html"), "<!doctype html>\n");
    await assert.rejects(
      checkFrontendSourcePolicy(temporaryRoot),
      /UI HTML\/CSS files differ from the original visual contract/u,
    );
  });
});
