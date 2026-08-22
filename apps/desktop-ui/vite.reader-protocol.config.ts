import { defineConfig } from "vite";

/** Standalone validation bridge used by the original reader window. */
export default defineConfig({
  root: "apps/desktop-ui",
  build: {
    outDir: "../../ui/bridge",
    emptyOutDir: false,
    lib: {
      entry: "src/reader-protocol-bridge.ts",
      name: "KunpengReaderProtocolBridge",
      formats: ["iife"],
      fileName: () => "reader-protocol-bridge.js",
    },
  },
});
