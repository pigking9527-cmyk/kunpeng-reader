import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = JSON.parse(readFileSync(resolve(repo, "scripts/license-policy.json"), "utf8"));
if (!policy.publicReleaseAllowed) {
  console.error(`Public release is paused by the license policy: ${policy.releaseHoldReason}`);
  process.exit(1);
}
console.log("Public release is allowed by the reviewed license policy.");
