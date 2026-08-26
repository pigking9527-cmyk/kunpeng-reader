import { dirname, resolve } from "node:path";

import { defineConfig, type LibraryFormats, type Plugin, type UserConfig } from "vite";

const virtualEntryName = "kunpeng-legacy-ts-entry.js";
const virtualEntryId = `\0${virtualEntryName}`;

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name} for the legacy TypeScript build.`);
  return value;
}

function classicEntryPlugin(source: string, installExport: string): Plugin {
  return {
    name: "kunpeng-classic-legacy-entry",
    resolveId(id) {
      const normalizedId = id.replaceAll("\\", "/");
      return id === virtualEntryName || normalizedId.endsWith(`/${virtualEntryName}`)
        ? virtualEntryId
        : null;
    },
    load(id) {
      if (id !== virtualEntryId) return null;
      return [
        `import { ${installExport} as install } from ${JSON.stringify(source)};`,
        "const installed = install(globalThis);",
        "if (typeof module === 'object' && module && 'exports' in module) module.exports = installed;",
      ].join("\n");
    },
    generateBundle(_options, bundle) {
      for (const artifact of Object.values(bundle)) {
        if (artifact.type !== "chunk") {
          this.error(`Legacy TypeScript entries cannot emit assets: ${artifact.fileName}`);
        }
      }
    },
  };
}

export default defineConfig(() => {
  const repositoryRoot = resolve(import.meta.dirname, "../..");
  const source = resolve(repositoryRoot, requiredEnvironment("KUNPENG_LEGACY_TS_SOURCE"));
  const outputDirectory = resolve(
    repositoryRoot,
    requiredEnvironment("KUNPENG_LEGACY_TS_OUTPUT_DIRECTORY"),
  );
  const output = requiredEnvironment("KUNPENG_LEGACY_TS_OUTPUT");
  const globalName = requiredEnvironment("KUNPENG_LEGACY_TS_GLOBAL_NAME");
  const installExport = requiredEnvironment("KUNPENG_LEGACY_TS_INSTALL_EXPORT");
  // Each classic entry is built in a distinct staging directory.  Keep Vite's
  // dependency cache beside that directory as well: concurrent desktop
  // checks otherwise share node_modules/.vite and can intermittently disturb
  // a different entry's build on Windows.
  const cacheDirectory = resolve(dirname(outputDirectory), `.vite-cache-${output}`);

  const config: UserConfig = {
    root: resolve(repositoryRoot, "apps/desktop-ui"),
    cacheDir: cacheDirectory,
    plugins: [classicEntryPlugin(source, installExport)],
    build: {
      outDir: outputDirectory,
      emptyOutDir: false,
      target: "es2022",
      minify: false,
      sourcemap: false,
      cssCodeSplit: false,
      lib: {
        entry: virtualEntryName,
        name: globalName,
        formats: ["iife" as LibraryFormats],
        fileName: () => output,
      },
      rollupOptions: {
        output: {
          entryFileNames: output,
          inlineDynamicImports: true,
          generatedCode: "es2015" as const,
        },
      },
    },
  };
  return config;
});
