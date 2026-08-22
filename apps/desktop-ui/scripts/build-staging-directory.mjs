import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ownerFile = ".kunpeng-build-staging.json";
const legacyEmptyDirectoryGraceMs = 5 * 60 * 1000;

function ownerPidFromName(name, prefix) {
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(\\d+)-`, "u").exec(name);
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

async function isEmptyDirectoryTree(directory) {
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    if (!child.isDirectory() || !(await isEmptyDirectoryTree(resolve(directory, child.name)))) return false;
  }
  return true;
}

function shouldIgnoreCleanupError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

/**
 * Removes only abandoned staging directories. A directory made by the current
 * builder embeds its owner PID, so a live concurrent build is never removed.
 * Older builder versions did not record a PID; those are eligible only when
 * their complete directory tree is empty and has outlived a short grace period.
 */
export async function cleanupAbandonedStagingDirectories(parentDirectory, prefix) {
  const removed = [];
  let children;
  try {
    children = await readdir(parentDirectory, { withFileTypes: true });
  } catch (error) {
    if (shouldIgnoreCleanupError(error)) return removed;
    throw error;
  }

  for (const child of children) {
    if (!child.isDirectory() || !child.name.startsWith(prefix)) continue;
    const directory = resolve(parentDirectory, child.name);
    try {
      const ownerPid = ownerPidFromName(child.name, prefix);
      const abandonedByDeadOwner = ownerPid !== undefined && !processIsRunning(ownerPid);
      const details = await stat(directory);
      const abandonedEmptyLegacyDirectory = ownerPid === undefined &&
        Date.now() - details.mtimeMs >= legacyEmptyDirectoryGraceMs &&
        await isEmptyDirectoryTree(directory);
      if (!abandonedByDeadOwner && !abandonedEmptyLegacyDirectory) continue;
      await rm(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch (error) {
      if (!shouldIgnoreCleanupError(error)) {
        console.warn(`Skipped staging cleanup for ${directory}: ${error.message}`);
      }
    }
  }
  return removed;
}

export async function createBuildStagingDirectory(parentDirectory, prefix, generator) {
  const directory = await mkdtemp(resolve(parentDirectory, `${prefix}${process.pid}-`));
  await writeFile(resolve(directory, ownerFile), `${JSON.stringify({
    schemaVersion: 1,
    generator,
    ownerPid: process.pid,
    createdAt: new Date().toISOString(),
  })}\n`);
  return directory;
}
