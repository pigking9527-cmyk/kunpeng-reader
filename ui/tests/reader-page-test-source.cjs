const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const sourcePath = path.join(
  __dirname,
  "..",
  "..",
  "apps",
  "desktop-ui",
  "src",
  "legacy-ts",
  "reader-page-modules",
  "reader-page-layout-annotations.ts",
);
const source = fs.readFileSync(sourcePath, "utf8");
const compact = esbuild
  .transformSync(source, {
    loader: "ts",
    format: "esm",
    target: "es2020",
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
  })
  .code.replaceAll('"', "'");

module.exports = Object.freeze({ sourcePath, source, compact });
