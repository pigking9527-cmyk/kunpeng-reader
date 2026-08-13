import {
  PDF_RENDERER_PROTOCOL_NAME,
  PDF_RENDERER_PROTOCOL_VERSION,
  createPdfBinaryDocument,
  createPdfDocumentId,
  createPdfOperationId,
  createPdfRendererPort,
  parsePdfRendererCommand,
  parsePdfRendererEvent,
  validatePdfRendererCommandEvent,
  validatePdfRendererEvent,
} from "../src/index.js";
import type { PdfBinaryDocument, PdfJsDocument } from "../src/index.js";

const SAMPLE_COUNT = 10_000;
const CANCELLATION_COUNT = 128;
const MAX_BATCH_MILLISECONDS = 5_000;
const MAX_BATCH_HEAP_GROWTH_BYTES = 64 * 1024 * 1024;

function expect(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

function measureBatch(label: string, run: () => void): void {
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  run();
  const elapsedMilliseconds = performance.now() - start;
  const heapGrowthBytes = Math.max(0, process.memoryUsage().heapUsed - heapBefore);

  // This is intentionally a broad ceiling: it is a repeated-work regression
  // detector, not a claim about exact V8 garbage-collection timing.
  expect(elapsedMilliseconds < MAX_BATCH_MILLISECONDS, `${label} exceeded ${MAX_BATCH_MILLISECONDS}ms`);
  expect(
    heapGrowthBytes < MAX_BATCH_HEAP_GROWTH_BYTES,
    `${label} retained more than ${MAX_BATCH_HEAP_GROWTH_BYTES} bytes in one synthetic batch`,
  );
  console.log(`[pdf-engine performance] ${label}: ${elapsedMilliseconds.toFixed(1)}ms, +${heapGrowthBytes} bytes`);
}

const documentId = createPdfDocumentId("synthetic-document-01");
const operationId = createPdfOperationId("synthetic-operation-01");
const trustedSource = {};
const trustedContext = {
  expectedSource: trustedSource,
  allowedOrigins: ["https://reader.localhost", "tauri://localhost"],
} as const;

const commands = [
  {
    protocol: PDF_RENDERER_PROTOCOL_NAME,
    version: PDF_RENDERER_PROTOCOL_VERSION,
    action: "open-document",
    payload: { documentId, operationId, initialPage: 1 },
  },
  {
    protocol: PDF_RENDERER_PROTOCOL_NAME,
    version: PDF_RENDERER_PROTOCOL_VERSION,
    action: "render-page",
    payload: { documentId, operationId, page: 3, scale: 1.25, rotation: 0 },
  },
] as const;

const events = [
  {
    protocol: PDF_RENDERER_PROTOCOL_NAME,
    version: PDF_RENDERER_PROTOCOL_VERSION,
    action: "document-ready",
    payload: { documentId, operationId, pageCount: 24 },
  },
  {
    protocol: PDF_RENDERER_PROTOCOL_NAME,
    version: PDF_RENDERER_PROTOCOL_VERSION,
    action: "page-rendered",
    payload: { documentId, operationId, page: 3, width: 1080, height: 1440 },
  },
] as const;

measureBatch(`parse ${SAMPLE_COUNT} synthetic commands and events`, () => {
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const command = parsePdfRendererCommand(commands[index % commands.length]);
    const event = parsePdfRendererEvent(events[index % events.length]);
    expect(command.ok && event.ok, "synthetic PDF protocol data remains valid");
  }
});

measureBatch(`validate ${SAMPLE_COUNT} trusted synthetic message events`, () => {
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const command = validatePdfRendererCommandEvent(
      { data: commands[index % commands.length], source: trustedSource, origin: "tauri://localhost" },
      trustedContext,
    );
    const event = validatePdfRendererEvent(
      { data: events[index % events.length], source: trustedSource, origin: "https://reader.localhost" },
      trustedContext,
    );
    expect(command.ok && event.ok, "trusted synthetic PDF message event remains valid");
  }
});

let loadingTaskDestroyCount = 0;
let surfaceClearCount = 0;
let surfaceUnmountCount = 0;
const port = createPdfRendererPort({
  resolver: {
    resolve(_id, signal): Promise<PdfBinaryDocument> {
      return new Promise((_, reject: (reason: unknown) => void) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    },
  },
  loader: {
    getDocument() {
      return {
        promise: Promise.resolve({ numPages: 1, destroy: (): void => {} }),
        destroy: (): void => { loadingTaskDestroyCount += 1; },
      };
    },
  },
  surface: {
    mount(): void {},
    async render(): Promise<{ readonly width: number; readonly height: number }> { return { width: 1, height: 1 }; },
    clear(): void { surfaceClearCount += 1; },
    unmount(): void { surfaceUnmountCount += 1; },
  },
});

const unsubscribe = port.onEvent(() => {});
const listenerCountBeforeUnsubscribe = port.diagnostics.listenerCount;
expect(listenerCountBeforeUnsubscribe === 1, "diagnostics reports the temporary event listener");
unsubscribe();
const listenerCountAfterUnsubscribe = port.diagnostics.listenerCount;
expect(listenerCountAfterUnsubscribe === 0, "unsubscribing releases the temporary event listener");

const lifecycleStart = performance.now();
for (let index = 0; index < CANCELLATION_COUNT; index += 1) {
  const controller = new AbortController();
  const operation = createPdfOperationId(`synthetic-cancel-${index}`);
  const opening = port.open({ documentId, operationId: operation, initialPage: 1 }, controller.signal);
  controller.abort();
  await opening;
  expect(port.diagnostics.activeOperationCount === 0, "cancelled open leaves no active operation reference");
  expect(!port.diagnostics.hasLoadingTask, "cancelled open leaves no loading-task reference");
  expect(!port.diagnostics.hasActiveDocument, "cancelled open leaves no document reference");
}
await port.close();
await port.dispose();
expect(port.diagnostics.disposed, "dispose is observable in diagnostics");
expect(port.diagnostics.activeOperationCount === 0, "dispose leaves no active operation references");
expect(port.diagnostics.listenerCount === 0, "dispose leaves no listener references");
expect(!port.diagnostics.hasLoadingTask && !port.diagnostics.hasActiveDocument, "dispose releases renderer-owned objects");
expect(surfaceClearCount >= CANCELLATION_COUNT, "every controlled close clears the imperative surface");
expect(surfaceUnmountCount === 1, "dispose unmounts the imperative surface exactly once");
expect(loadingTaskDestroyCount === 0, "cancelling before resolution never creates a PDF.js loading task");

const resolvedBytes = createPdfBinaryDocument(documentId, new Uint8Array([37, 80, 68, 70]));
let resolvePendingLoaderStarted: (() => void) | undefined;
const pendingLoaderStartedPromise = new Promise<void>((resolve) => { resolvePendingLoaderStarted = resolve; });
let pendingTaskDestroyCount = 0;
const pendingLoadPort = createPdfRendererPort({
  resolver: { async resolve(): Promise<typeof resolvedBytes> { return resolvedBytes; } },
  loader: {
    getDocument() {
      let rejectPending: ((reason: unknown) => void) | undefined;
      const task: { readonly promise: Promise<PdfJsDocument>; readonly destroy: () => void } = {
        promise: new Promise<PdfJsDocument>((_resolve, reject: (reason: unknown) => void) => { rejectPending = reject; }),
        destroy(): void {
          pendingTaskDestroyCount += 1;
          rejectPending?.(new DOMException("Aborted", "AbortError"));
        },
      };
      resolvePendingLoaderStarted?.();
      return task;
    },
  },
  surface: {
    mount(): void {},
    async render(): Promise<{ readonly width: number; readonly height: number }> { return { width: 1, height: 1 }; },
    clear(): void {},
    unmount(): void {},
  },
});
const pendingOperationId = createPdfOperationId("synthetic-pending-load");
const pendingOpen = pendingLoadPort.open({ documentId, operationId: pendingOperationId, initialPage: 1 });
await pendingLoaderStartedPromise;
pendingLoadPort.cancel(pendingOperationId);
await pendingOpen;
const pendingLoadDiagnostics = pendingLoadPort.diagnostics;
expect(pendingTaskDestroyCount === 1, "cancelling a pending PDF.js task destroys it exactly once");
expect(pendingLoadDiagnostics.activeOperationCount === 0, "pending-load cancellation releases its operation");
expect(!pendingLoadDiagnostics.hasLoadingTask && !pendingLoadDiagnostics.hasActiveDocument, "pending-load cancellation retains no renderer object");
await pendingLoadPort.dispose();

let firstLoaderStarted: (() => void) | undefined;
const firstLoaderStartedPromise = new Promise<void>((resolve) => { firstLoaderStarted = resolve; });
let secondLoaderStarted: (() => void) | undefined;
const secondLoaderStartedPromise = new Promise<void>((resolve) => { secondLoaderStarted = resolve; });
let rejectFirstLoad: ((reason: unknown) => void) | undefined;
let rejectSecondLoad: ((reason: unknown) => void) | undefined;
let firstSupersededTaskDestroyCount = 0;
let secondActiveTaskDestroyCount = 0;
let loaderCallCount = 0;
const replacementOpenPort = createPdfRendererPort({
  resolver: { async resolve(): Promise<typeof resolvedBytes> { return resolvedBytes; } },
  loader: {
    getDocument() {
      loaderCallCount += 1;
      if (loaderCallCount === 1) {
        firstLoaderStarted?.();
        return {
          promise: new Promise<PdfJsDocument>((_resolve, reject: (reason: unknown) => void) => { rejectFirstLoad = reject; }),
          destroy(): void {
            firstSupersededTaskDestroyCount += 1;
            rejectFirstLoad?.(new DOMException("Aborted", "AbortError"));
          },
        };
      }
      secondLoaderStarted?.();
      return {
        promise: new Promise<PdfJsDocument>((_resolve, reject: (reason: unknown) => void) => { rejectSecondLoad = reject; }),
        destroy(): void {
          secondActiveTaskDestroyCount += 1;
          rejectSecondLoad?.(new DOMException("Aborted", "AbortError"));
        },
      };
    },
  },
  surface: {
    mount(): void {},
    async render(): Promise<{ readonly width: number; readonly height: number }> { return { width: 1, height: 1 }; },
    clear(): void {},
    unmount(): void {},
  },
});
const firstReplacementOpen = replacementOpenPort.open({
  documentId,
  operationId: createPdfOperationId("replacement-first-open"),
  initialPage: 1,
});
await firstLoaderStartedPromise;
const secondReplacementOpen = replacementOpenPort.open({
  documentId,
  operationId: createPdfOperationId("replacement-second-open"),
  initialPage: 1,
});
await secondLoaderStartedPromise;
expect(firstSupersededTaskDestroyCount === 1, "a replacement open destroys the superseded loading task once");
await firstReplacementOpen;
expect(replacementOpenPort.diagnostics.hasLoadingTask, "a superseded request cannot clear the replacement loading task");
await replacementOpenPort.close();
await secondReplacementOpen;
expect(secondActiveTaskDestroyCount === 1, "close still destroys the replacement loading task exactly once");
expect(!replacementOpenPort.diagnostics.hasLoadingTask, "replacement cleanup retains no loading-task reference");
await replacementOpenPort.dispose();

let activeDocumentDestroyCount = 0;
let activeSurfaceClearCount = 0;
let activeSurfaceUnmountCount = 0;
const activeDocumentPort = createPdfRendererPort({
  resolver: { async resolve(): Promise<typeof resolvedBytes> { return resolvedBytes; } },
  loader: {
    getDocument() {
      return {
        promise: Promise.resolve({ numPages: 2, destroy: (): void => { activeDocumentDestroyCount += 1; } }),
        destroy(): void {},
      };
    },
  },
  surface: {
    mount(): void {},
    async render(): Promise<{ readonly width: number; readonly height: number }> { return { width: 1, height: 1 }; },
    clear(): void { activeSurfaceClearCount += 1; },
    unmount(): void { activeSurfaceUnmountCount += 1; },
  },
});
await activeDocumentPort.open({ documentId, operationId: createPdfOperationId("synthetic-active-load"), initialPage: 1 });
expect(activeDocumentPort.diagnostics.hasActiveDocument, "opened port owns exactly its active document");
await activeDocumentPort.close();
const closedDiagnostics = activeDocumentPort.diagnostics;
expect(activeDocumentDestroyCount === 1, "close destroys the active PDF.js document exactly once");
expect(activeSurfaceClearCount >= 2, "open and close both clear the imperative surface");
expect(!closedDiagnostics.hasActiveDocument && !closedDiagnostics.hasLoadingTask, "close releases active document ownership");
await activeDocumentPort.dispose();
expect(activeSurfaceUnmountCount === 1, "disposing a closed port unmounts its surface exactly once");

const lifecycleMilliseconds = performance.now() - lifecycleStart;
expect(lifecycleMilliseconds < MAX_BATCH_MILLISECONDS, `cancel/cleanup exceeded ${MAX_BATCH_MILLISECONDS}ms`);
console.log(`[pdf-engine performance] ${CANCELLATION_COUNT} cancelled opens and cleanup: ${lifecycleMilliseconds.toFixed(1)}ms`);
console.log("pdf-engine performance and lifecycle baseline passed");
