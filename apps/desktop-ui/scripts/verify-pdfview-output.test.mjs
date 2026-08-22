import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { verifyPdfViewOutput } from "./verify-pdfview-output.mjs";

const validOutput = `${'import * as pdfjsLib from "./pdfjs/pdf.min.mjs";\n'}${'import { createPdfLegacyAdapter } from "./bridge/pdf-engine-legacy-adapter.js";\n'}${'const pages = document.getElementById("pages");\n'}${'createPdfLegacyAdapter();\n'}${"void pdfjsLib; void pages;\n".repeat(1_300)}`;

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "kunpeng-pdfview-verifier-"));
  await mkdir(resolve(root, "ui"), { recursive: true });
  await writeFile(
    resolve(root, "ui/pdfview.html"),
    '<div id="pages"></div><script src="generated-ts/browser-native-guard.js"></script><script type="module" src="pdfview.js"></script>',
  );
  await writeFile(resolve(root, "ui/pdfview.js"), validOutput);
  return root;
}

test("PDF output verifier accepts the single original page and guarded renderer", async () => {
  const root = await fixture();
  try {
    await assert.doesNotReject(() => verifyPdfViewOutput(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PDF output verifier rejects a second application entry", async () => {
  const root = await fixture();
  try {
    await writeFile(
      resolve(root, "ui/pdfview.html"),
      '<div id="pages"></div><script src="generated-ts/browser-native-guard.js"></script><script type="module" src="pdfview.js"></script><script type="module" src="second-ui.js"></script>',
    );
    await assert.rejects(() => verifyPdfViewOutput(root), /second application/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PDF output verifier rejects wildcard messaging and source maps", async () => {
  const root = await fixture();
  try {
    await writeFile(resolve(root, "ui/pdfview.js"), `${validOutput}\nparent.postMessage({}, "*");\n//# sourceMappingURL=pdfview.js.map\n`);
    await assert.rejects(() => verifyPdfViewOutput(root), /unsafe generated construct/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
