import {
  DEFAULT_MAX_PDF_MESSAGE_BYTES,
  PDF_RENDERER_PROTOCOL_NAME,
  PDF_RENDERER_PROTOCOL_VERSION,
  createPdfBinaryDocument,
  createPdfDocumentId,
  createPdfJsLoadParameters,
  createPdfOperationId,
  createPdfRendererPort,
  parsePdfRendererCommand,
  parsePdfRendererEvent,
  validatePdfRendererEvent,
} from "../src/index.js";

function expect(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

const documentId = createPdfDocumentId("book-8f3e2a");
const operationId = createPdfOperationId("render-001");
const trustedSource = {};
const trustedContext = {
  expectedSource: trustedSource,
  allowedOrigins: ["https://reader.localhost", "tauri://localhost"],
} as const;

const openDocument = {
  protocol: PDF_RENDERER_PROTOCOL_NAME,
  version: PDF_RENDERER_PROTOCOL_VERSION,
  action: "open-document",
  payload: { documentId, operationId, initialPage: 1 },
} as const;

const ready = {
  protocol: PDF_RENDERER_PROTOCOL_NAME,
  version: PDF_RENDERER_PROTOCOL_VERSION,
  action: "document-ready",
  payload: { documentId, operationId, pageCount: 10 },
} as const;

expect(parsePdfRendererCommand(openDocument).ok, "accepts an opaque document-id command");
expect(parsePdfRendererEvent(ready).ok, "accepts a bounded synthetic renderer event");

const acceptedEvent = validatePdfRendererEvent(
  { data: ready, source: trustedSource, origin: "tauri://localhost" },
  trustedContext,
);
expect(acceptedEvent.ok && acceptedEvent.value.action === "document-ready", "accepts an expected source and explicit origin");

const forgedSource = validatePdfRendererEvent(
  { data: ready, source: {}, origin: "https://reader.localhost" },
  trustedContext,
);
expect(!forgedSource.ok && forgedSource.error === "untrusted-source", "rejects a forged source");

const arbitraryUrl = parsePdfRendererCommand({
  ...openDocument,
  payload: { ...openDocument.payload, documentId: "https://example.invalid/book.pdf" },
});
expect(!arbitraryUrl.ok && arbitraryUrl.error === "invalid-payload", "rejects arbitrary document URLs");

const localPath = parsePdfRendererCommand({
  ...openDocument,
  payload: { ...openDocument.payload, documentId: "/Users/reader/book.pdf" },
});
expect(!localPath.ok && localPath.error === "invalid-payload", "rejects filesystem paths");

const unknownAction = parsePdfRendererCommand({ ...openDocument, action: "fetch-url" });
expect(!unknownAction.ok && unknownAction.error === "unknown-action", "rejects unknown commands");

const oversized = parsePdfRendererEvent({
  ...ready,
  payload: { ...ready.payload, padding: "x".repeat(DEFAULT_MAX_PDF_MESSAGE_BYTES) },
});
expect(!oversized.ok && oversized.error === "message-too-large", "rejects oversized messages before parsing");

const binaryDocument = createPdfBinaryDocument(documentId, new Uint8Array([37, 80, 68, 70]));
const loadParameters = createPdfJsLoadParameters(binaryDocument);
expect(loadParameters.data.byteLength === 4, "copies trusted PDF bytes into the PDF.js load input");
expect(loadParameters.disableRange && loadParameters.disableStream && loadParameters.disableAutoFetch, "disables URL/range streaming inputs");
expect(!Object.hasOwn(loadParameters, "url"), "PDF.js load parameters never expose an arbitrary URL");

const lifecycleEvents: string[] = [];
const fakeDocument = {
  numPages: 10,
  destroy(): void {},
};
const port = createPdfRendererPort({
  resolver: {
    async resolve(id): Promise<typeof binaryDocument> {
      return createPdfBinaryDocument(id, new Uint8Array([37, 80, 68, 70]));
    },
  },
  loader: {
    getDocument() {
      return { promise: Promise.resolve(fakeDocument), destroy(): void {} };
    },
  },
  surface: {
    mount(): void {},
    async render(_document, request): Promise<{ readonly width: number; readonly height: number }> {
      expect(request.documentId === documentId, "only the opened document reaches the surface adapter");
      return { width: 800, height: 1000 };
    },
    clear(): void {},
    unmount(): void {},
  },
});
port.onEvent((event) => lifecycleEvents.push(event.action));
await port.open(openDocument.payload);
expect(port.lifecycle.state === "ready", "open transitions the port to ready");
await port.renderPage({ documentId, operationId: createPdfOperationId("render-002"), page: 1, scale: 1, rotation: 0 });
expect(lifecycleEvents.includes("page-rendered"), "the imperative adapter reports typed render completion");

const cancelEvents: string[] = [];
const cancellablePort = createPdfRendererPort({
  resolver: {
    resolve(_id, signal): Promise<typeof binaryDocument> {
      return new Promise((_, reject: (reason: unknown) => void) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  },
  loader: {
    getDocument() {
      return { promise: Promise.resolve(fakeDocument), destroy(): void {} };
    },
  },
  surface: {
    mount(): void {},
    async render(): Promise<{ readonly width: number; readonly height: number }> {
      return { width: 800, height: 1000 };
    },
    clear(): void {},
    unmount(): void {},
  },
});
cancellablePort.onEvent((event) => cancelEvents.push(event.action));
const abortController = new AbortController();
const cancelledOperation = cancellablePort.open(
  { documentId, operationId: createPdfOperationId("load-cancel"), initialPage: 1 },
  abortController.signal,
);
abortController.abort();
await cancelledOperation;
expect(cancelEvents.includes("operation-cancelled"), "abort emits a typed cancellation event");
expect(cancellablePort.lifecycle.state === "failed" && cancellablePort.lifecycle.code === "cancelled", "abort has a defined lifecycle state");

console.log("pdf-engine protocol tests passed");
