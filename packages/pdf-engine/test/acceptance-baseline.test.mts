import {
  createPdfBinaryDocument,
  createPdfDocumentId,
  createPdfOperationId,
  createPdfRendererPort,
} from "../src/index.js";
import type { PdfBinaryDocument, PdfJsDocument } from "../src/index.js";

function expect(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

const documentId = createPdfDocumentId("acceptance-document");
const bytes = createPdfBinaryDocument(documentId, new Uint8Array([37, 80, 68, 70]));

let documentDestroyCount = 0;
let surfaceClearCount = 0;
let surfaceUnmountCount = 0;
let renderStarted: (() => void) | undefined;
const renderStartedPromise = new Promise<void>((resolve) => { renderStarted = resolve; });

const port = createPdfRendererPort({
  resolver: { async resolve(): Promise<PdfBinaryDocument> { return bytes; } },
  loader: {
    getDocument() {
      return {
        promise: Promise.resolve({ numPages: 2, destroy: (): void => { documentDestroyCount += 1; } }),
        destroy(): void {},
      };
    },
  },
  surface: {
    mount(): void {},
    render(_document: PdfJsDocument, _request, signal): Promise<{ readonly width: number; readonly height: number }> {
      renderStarted?.();
      return new Promise((resolve, reject: (reason: unknown) => void) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        void resolve;
      });
    },
    clear(): void { surfaceClearCount += 1; },
    unmount(): void { surfaceUnmountCount += 1; },
  },
});

await port.open({ documentId, operationId: createPdfOperationId("acceptance-open"), initialPage: 1 });
const render = port.renderPage({
  documentId,
  operationId: createPdfOperationId("acceptance-render"),
  page: 1,
  scale: 1,
  rotation: 0,
});
await renderStartedPromise;
await port.close();
await render;

const closed = port.diagnostics;
expect(documentDestroyCount === 1, "close during render destroys the active document exactly once");
expect(surfaceClearCount >= 2, "open and close clear the imperative surface");
expect(closed.activeOperationCount === 0, "close during render releases the render operation");
expect(!closed.hasActiveDocument && !closed.hasLoadingTask, "close during render retains no PDF.js object");

await port.dispose();
expect(port.diagnostics.listenerCount === 0, "dispose after an in-flight render retains no listeners");
expect(surfaceUnmountCount === 1, "dispose after an in-flight render unmounts exactly once");

console.log("pdf-engine close-during-render acceptance specimen passed");
