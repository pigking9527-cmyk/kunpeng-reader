import { resolve } from "node:path";

import { defineConfig } from "vite";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const outputDirectory = resolve(repositoryRoot, process.env.KUNPENG_PDFVIEW_OUTPUT_DIRECTORY ?? "ui");

/** Builds the original pdfview ESM entry without introducing a second page or loader. */
export default defineConfig({
  root: resolve(repositoryRoot, "apps/desktop-ui"),
  build: {
    outDir: outputDirectory,
    emptyOutDir: false,
    target: "es2022",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/legacy-ts/pdfview/pdfview.ts",
      formats: ["es"],
      fileName: () => "pdfview.js",
    },
    rollupOptions: {
      external: ["./pdfjs/pdf.min.mjs", "./bridge/pdf-engine-legacy-adapter.js"],
      output: {
        entryFileNames: "pdfview.js",
        inlineDynamicImports: true,
      },
    },
  },
});
