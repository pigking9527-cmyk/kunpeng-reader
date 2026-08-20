import { defineConfig } from "vite";

/** ESM bridge imported directly by the original PDF iframe. */
export default defineConfig({
  root: "apps/desktop-ui",
  build: {
    outDir: "../../ui/bridge",
    emptyOutDir: false,
    lib: {
      entry: "src/pdf-engine-legacy-adapter.ts",
      formats: ["es"],
      fileName: () => "pdf-engine-legacy-adapter.js",
    },
    rollupOptions: {
      output: { assetFileNames: "pdf-engine-legacy-adapter.[ext]" },
    },
  },
});
