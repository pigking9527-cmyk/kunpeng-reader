import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const forbiddenPaths = [
  "vendor/epub",
  "src/hownet.rs",
  "src/dict/hownet.tsv.gz",
  "src/dict/zh_cc.tsv.gz",
  "src/dict/FREQUENCY_SOURCE.md",
  "src/dict/HOWNET_SOURCE.md",
  "tools/export_hownet_tsv.py",
  "scripts/prepare-windows-gpu-runtime.ps1"
];
for (const path of forbiddenPaths) {
  if (existsSync(join(repo, path))) failures.push(`forbidden historical or unreviewed path: ${path}`);
}

const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: repo,
  encoding: "utf8"
}).split("\0").filter((path) => path && existsSync(join(repo, path)));
for (const path of candidates) {
  if (/\.(dll|so(?:\.\d+)*)$|cuda|cudnn/i.test(path)) {
    const full = join(repo, path);
    if (existsSync(full) && statSync(full).isFile()) {
      const textLike = /\.(md|txt|rs|js|mjs|json|toml|ya?ml|ps1|sh)$/i.test(path);
      if (!textLike) failures.push(`unapproved GPU binary in snapshot: ${path}`);
    }
  }
}

const required = [
  "docs/legal/FIRST_PARTY_ASSET_ATTESTATION.md",
  "docs/legal/NEW_REPOSITORY_IP_CHECKLIST.md",
  "src/dict/ECDICT_SOURCE.md",
  "src/dict/CC_CEDICT_SOURCE.md",
  "src/dict/ZHWIKTIONARY_SOURCE.md",
  "LICENSES/ECDICT-MIT.txt",
  "LICENSES/CC-BY-SA-4.0.txt"
];
for (const path of required) {
  if (!existsSync(join(repo, path)) || !readFileSync(join(repo, path)).length) failures.push(`required IP evidence is missing: ${path}`);
}

const sourceFiles = candidates.filter((path) =>
  existsSync(join(repo, path)) && /\.(rs|toml|lock|js|mjs|ts|tsx|json|md|ps1|sh|ya?ml)$/i.test(path)
);
for (const path of sourceFiles) {
  const text = readFileSync(join(repo, path), "utf8");
  if (/epub\s*=\s*["']2(?:\.|["'])/i.test(text)) failures.push(`old GPL epub dependency reference: ${path}`);
  if (path !== "scripts/check-ip-clean-snapshot.mjs" && /cuda-runtime-windows-v1|nvidia_(?:cuda|cudnn)_cu12-[^\s"']+\.whl/i.test(text)) {
    failures.push(`unapproved NVIDIA redistribution path: ${path}`);
  }
}

if (failures.length) {
  console.error(["IP clean-snapshot check failed:", ...failures.map((item) => `- ${item}`)].join("\n"));
  process.exit(1);
}
console.log(`IP clean-snapshot check passed for ${candidates.length} candidate paths.`);
