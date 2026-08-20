import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const forbidden = [
  /\bimport\s*\(/u,
  /\beval\s*\(/u,
  /\bnew\s+Function\s*\(/u,
  /sourceMappingURL=/u,
  /postMessage\s*\([^\n]*,[\s]*["']\*["']/u,
];

export async function verifyPdfViewOutput(repositoryRoot) {
  const root = resolve(repositoryRoot);
  const htmlPath = resolve(root, "ui/pdfview.html");
  const outputPath = resolve(root, "ui/pdfview.js");
  const [html, output, outputStats] = await Promise.all([
    readFile(htmlPath, "utf8"),
    readFile(outputPath, "utf8"),
    stat(outputPath),
  ]);

  if (!outputStats.isFile() || outputStats.size < 16_000 || outputStats.size > 80_000) {
    throw new Error("The original PDF renderer output has an unexpected size.");
  }
  if ((html.match(/id=["']pages["']/gu) ?? []).length !== 1 ||
    (html.match(/<script\s+type=["']module["']\s+src=["']pdfview\.js["']><\/script>/gu) ?? []).length !== 1) {
    throw new Error("ui/pdfview.html must retain one original #pages host and one pdfview.js module entry.");
  }
  if ((html.match(/<script\b/gu) ?? []).length !== 2 || html.includes("apps/desktop-ui")) {
    throw new Error("ui/pdfview.html must not load a second application or source-tree entry.");
  }
  if (!output.startsWith('import * as pdfjsLib from "./pdfjs/pdf.min.mjs";') ||
    !output.includes('from "./bridge/pdf-engine-legacy-adapter.js"') ||
    !output.includes('document.getElementById("pages")') ||
    !output.includes("createPdfLegacyAdapter")) {
    throw new Error("ui/pdfview.js is missing the original PDF.js host or guarded bridge.");
  }
  const unexpectedImports = [...output.matchAll(/\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/gu)]
    .map((match) => match[1])
    .filter((specifier) => specifier !== "./pdfjs/pdf.min.mjs" && specifier !== "./bridge/pdf-engine-legacy-adapter.js");
  if (unexpectedImports.length > 0 || forbidden.some((pattern) => pattern.test(output))) {
    throw new Error("ui/pdfview.js contains an undeclared import or unsafe generated construct.");
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const repositoryRoot = resolve(dirname(currentFile), "../../..");
  await verifyPdfViewOutput(repositoryRoot);
  console.log("Verified the original PDF page TypeScript output.");
}
