import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export const legacyBuildInputFiles = Object.freeze([
  "apps/desktop-ui/scripts/build-input-fingerprint.mjs",
  "apps/desktop-ui/scripts/build-staging-directory.mjs",
  "apps/desktop-ui/scripts/build-legacy-ts.mjs",
  "apps/desktop-ui/scripts/legacy-ts-manifest.mjs",
  "apps/desktop-ui/vite.legacy-ts.config.ts",
  "package-lock.json",
]);

export const readerPageBuildInputFiles = Object.freeze([
  "apps/desktop-ui/scripts/build-input-fingerprint.mjs",
  "apps/desktop-ui/scripts/build-staging-directory.mjs",
  "apps/desktop-ui/scripts/build-reader-page-ts.mjs",
  "apps/desktop-ui/scripts/reader-page-ts-manifest.mjs",
  "apps/desktop-ui/vite.legacy-ts.config.ts",
  "package-lock.json",
]);

export async function buildInputSha256(repositoryRoot, inputFiles) {
  const hash = createHash("sha256");
  for (const input of inputFiles) {
    hash.update(input);
    hash.update("\0");
    hash.update(await readFile(resolve(repositoryRoot, input)));
    hash.update("\0");
  }
  return hash.digest("hex");
}
