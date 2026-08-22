import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputDirectory = resolve(import.meta.dirname, "../../../ui/bridge");
const pdfAdapter = resolve(outputDirectory, "pdf-engine-legacy-adapter.js");
const readerProtocol = resolve(outputDirectory, "reader-protocol-bridge.js");

await access(pdfAdapter);
const pdfAdapterText = await readFile(pdfAdapter, "utf8");
if (!pdfAdapterText.includes("createPdfLegacyAdapter")
  || !pdfAdapterText.includes("kunpeng-pdf-renderer")) {
  throw new Error("The PDF engine adapter output is missing its guarded protocol runtime.");
}

await access(readerProtocol);
const readerProtocolText = await readFile(readerProtocol, "utf8");
if (!readerProtocolText.includes("KunpengReaderProtocolBridge")
  || !readerProtocolText.includes("kunpeng-reader-engine")) {
  throw new Error("The reader protocol output is missing its guarded runtime.");
}

console.log("Verified standalone reader bridge outputs.");
