import {
  DEFAULT_MAX_PDF_MESSAGE_BYTES,
  MAX_PDF_PAGE_NUMBER,
  PDF_RENDERER_PROTOCOL_NAME,
  PDF_RENDERER_PROTOCOL_VERSION,
  createPdfDocumentId,
  createPdfOperationId,
  parsePdfRendererCommand,
  type PdfDocumentId,
  type PdfOperationId,
  type PdfRendererCommand,
} from "../../../packages/pdf-engine/src/index";

/**
 * Transitional runtime adapter for `ui/pdfview.js`.
 *
 * It deliberately does not bring a UI framework, Tauri, or a second PDF.js render loop
 * into the PDF iframe.  The legacy resource URL is accepted only during the
 * transition from the trusted Rust resource protocol; all messages use opaque
 * document/operation ids and a fixed parent origin.
 */
export const PDF_ENGINE_LEGACY_GLOBAL = "KunpengPdfEngineLegacyAdapter";
export const PDF_ENGINE_LEGACY_FEATURE_KEY = "kunpeng.feature.pdf-engine-protocol.enabled";

export interface PdfLegacyLocationLike {
  readonly href: string;
  readonly search: string;
}

export interface PdfLegacyMessageEventLike {
  readonly data: unknown;
  readonly source: unknown;
  readonly origin: string;
}

export interface PdfLegacyBootstrap {
  readonly documentId: PdfDocumentId;
  readonly sourceUrl: string;
  readonly initialPage: number;
  readonly parentOrigin: string;
}

export interface PdfLegacySession {
  readonly documentId: PdfDocumentId;
  readonly signal: AbortSignal;
  readonly nextOperationId: (kind: string) => PdfOperationId;
  readonly trackLoadingTask: (task: { destroy?: () => unknown }) => void;
  readonly trackRenderTask: (task: { cancel?: () => unknown }) => () => void;
  readonly dispose: () => Promise<void>;
}

export interface PdfLegacyAdapter {
  readonly bootstrap: (location: PdfLegacyLocationLike) => PdfLegacyBootstrap | null;
  readonly normalizeIncomingMessage: (event: PdfLegacyMessageEventLike, bootstrap: PdfLegacyBootstrap) => unknown | null;
  readonly postLegacyEvent: (target: { postMessage: (message: unknown, targetOrigin: string) => void }, bootstrap: PdfLegacyBootstrap, payload: unknown) => boolean;
  readonly createSession: (bootstrap: PdfLegacyBootstrap) => PdfLegacySession;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function byteLength(value: unknown): number {
  try {
    const encoded = JSON.stringify(value);
    return typeof encoded === "string" ? new TextEncoder().encode(encoded).byteLength : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function explicitOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== "null") return url.origin;
    return url.host ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

function validPage(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PDF_PAGE_NUMBER;
}

function validSearchText(value: unknown): boolean {
  return typeof value === "string" && value.length <= 20_000;
}

function validLegacySettings(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "theme")
    && (value.theme === undefined || value.theme === "light" || value.theme === "dark" || value.theme === "sepia");
}

function validLegacyHighlight(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = [
    "chapter", "rects", "note", "color", "text", "corrected_text", "context", "start", "end", "created_at", "range_anchor",
  ];
  return Object.keys(value).every((key) => allowed.includes(key))
    && (value.chapter === undefined || (typeof value.chapter === "number" && Number.isInteger(value.chapter) && value.chapter >= 0 && value.chapter < MAX_PDF_PAGE_NUMBER))
    && (value.rects === undefined || (typeof value.rects === "string" && value.rects.length <= 8_000))
    && (value.note === undefined || (typeof value.note === "string" && value.note.length <= 4_000))
    && ["text", "corrected_text", "context", "color"].every((key) => value[key] === undefined || (typeof value[key] === "string" && value[key].length <= 20_000))
    && (value.start === undefined || (typeof value.start === "number" && Number.isInteger(value.start) && value.start >= 0))
    && (value.end === undefined || (typeof value.end === "number" && Number.isInteger(value.end) && value.end >= 0))
    && (value.created_at === undefined || (typeof value.created_at === "number" && Number.isSafeInteger(value.created_at) && value.created_at >= 0))
    && (value.range_anchor === undefined || isRecord(value.range_anchor));
}

/** Accept existing shell controls only; arbitrary URL/path/source payloads have no legacy slot. */
function validLegacyCommand(value: unknown): value is UnknownRecord {
  if (!isRecord(value) || byteLength(value) > DEFAULT_MAX_PDF_MESSAGE_BYTES) return false;
  const keys = Object.keys(value);
  // The old reader combines a pending PDF search jump into one message.
  // Keep precisely this historic shape; arbitrary multi-action payloads stay
  // rejected so a compromised parent cannot grow the PDF command surface.
  if (keys.length === 2 && keys.includes("gotoChapter") && keys.includes("search")) {
    return typeof value.gotoChapter === "number" && Number.isInteger(value.gotoChapter)
      && value.gotoChapter >= 0 && value.gotoChapter < MAX_PDF_PAGE_NUMBER
      && validSearchText(value.search);
  }
  if (keys.length !== 1) return false;
  const [key] = keys;
  if (key === "gotoChapter") return typeof value.gotoChapter === "number" && Number.isInteger(value.gotoChapter) && value.gotoChapter >= 0 && value.gotoChapter < MAX_PDF_PAGE_NUMBER;
  if (key === "gotoFrac") return typeof value.gotoFrac === "number" && Number.isFinite(value.gotoFrac) && value.gotoFrac >= 0 && value.gotoFrac <= 1;
  if (key === "zoom") return value.zoom === "in" || value.zoom === "out";
  if (key === "pageTurn") return value.pageTurn === 1 || value.pageTurn === -1;
  if (key === "dual") return typeof value.dual === "boolean";
  if (key === "overlayOpen") return typeof value.overlayOpen === "boolean" || value.overlayOpen === 0 || value.overlayOpen === 1;
  if (key === "settings") return validLegacySettings(value.settings);
  if (key === "search") return validSearchText(value.search);
  if (key === "searchNav") return value.searchNav === 1 || value.searchNav === -1;
  if (key === "clearMarks") return value.clearMarks === 1;
  if (key === "highlights") return Array.isArray(value.highlights) && value.highlights.length <= 128 && value.highlights.every(validLegacyHighlight);
  if (key === "showHlMenuFor" || key === "gotoHighlight") return Number.isInteger(value[key]) && Number(value[key]) >= 0 && Number(value[key]) < 100_000;
  return false;
}

function isPdfCommandForDocument(command: PdfRendererCommand, documentId: PdfDocumentId): boolean {
  if (command.action === "close-document") return command.payload.documentId === documentId;
  return command.payload.documentId === documentId;
}

function parseBootstrap(location: PdfLegacyLocationLike): PdfLegacyBootstrap | null {
  const parentOrigin = explicitOrigin(location.href);
  if (!parentOrigin) return null;
  const parameters = new URLSearchParams(location.search);
  const rawUrl = parameters.get("u");
  if (!rawUrl || rawUrl.length > 512) return null;
  let source: URL;
  try {
    source = new URL(rawUrl, location.href);
  } catch {
    return null;
  }
  // The Rust reader protocol is the only compatibility input accepted here:
  // reader://localhost/pdf/<numeric-id> in the app, http://reader.localhost
  // in the browser/test build. No filesystem paths, public URLs, query strings
  // or fragments can cross this point.
  const trustedHost = source.protocol === "reader:" && source.host === "localhost"
    || source.protocol === "http:" && source.host === "reader.localhost";
  // Desktop book IDs are stored as u64 values, whose decimal form may use up
  // to 20 digits. This value remains opaque here; accepting the full u64
  // textual range does not turn it into a filesystem path or a public URL.
  const match = /^\/pdf\/([0-9]{1,20})$/u.exec(source.pathname);
  if (!trustedHost || !match || source.search || source.hash || !match[1]) return null;
  const requestedPage = Number.parseInt(parameters.get("p") ?? "1", 10);
  if (!validPage(requestedPage)) return null;
  try {
    return Object.freeze({
      documentId: createPdfDocumentId(`book-${match[1]}`),
      sourceUrl: source.href,
      initialPage: requestedPage,
      parentOrigin,
    });
  } catch {
    return null;
  }
}

function createSession(bootstrap: PdfLegacyBootstrap): PdfLegacySession {
  const controller = new AbortController();
  const loadingTasks = new Set<{ destroy?: () => unknown }>();
  const renderTasks = new Set<{ cancel?: () => unknown }>();
  let disposed = false;
  let operationSequence = 0;
  const safely = async (work: () => unknown): Promise<void> => {
    try { await Promise.resolve(work()); } catch { /* PDF.js cleanup is best effort. */ }
  };
  return Object.freeze({
    documentId: bootstrap.documentId,
    signal: controller.signal,
    nextOperationId(kind: string): PdfOperationId {
      const safeKind = /^[A-Za-z0-9_-]{1,24}$/u.test(kind) ? kind : "operation";
      operationSequence += 1;
      return createPdfOperationId(`${safeKind}-${operationSequence}`);
    },
    trackLoadingTask(task: { destroy?: () => unknown }) {
      if (disposed) { void safely(() => task.destroy?.()); return; }
      loadingTasks.add(task);
    },
    trackRenderTask(task: { cancel?: () => unknown }) {
      if (disposed) { void safely(() => task.cancel?.()); return () => {}; }
      renderTasks.add(task);
      return () => renderTasks.delete(task);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      controller.abort();
      await Promise.allSettled([
        ...[...renderTasks].map((task) => safely(() => task.cancel?.())),
        ...[...loadingTasks].map((task) => safely(() => task.destroy?.())),
      ]);
      renderTasks.clear();
      loadingTasks.clear();
    },
  });
}

export function createPdfLegacyAdapter(): PdfLegacyAdapter {
  const adapter: PdfLegacyAdapter = {
    bootstrap: parseBootstrap,
    normalizeIncomingMessage(event: PdfLegacyMessageEventLike, bootstrap: PdfLegacyBootstrap) {
      const expectedParent = typeof window === "undefined" ? null : window.parent;
      if (!expectedParent || event.source !== expectedParent || explicitOrigin(event.origin) !== bootstrap.parentOrigin) return null;
      const typed = parsePdfRendererCommand(event.data);
      if (typed.ok) return isPdfCommandForDocument(typed.value, bootstrap.documentId) ? typed.value : null;
      return validLegacyCommand(event.data) ? event.data : null;
    },
    postLegacyEvent(target: { postMessage: (message: unknown, targetOrigin: string) => void }, bootstrap: PdfLegacyBootstrap, payload: unknown) {
      if (byteLength(payload) > DEFAULT_MAX_PDF_MESSAGE_BYTES) return false;
      target.postMessage(payload, bootstrap.parentOrigin);
      return true;
    },
    createSession,
  };
  return Object.freeze(adapter);
}

const browserGlobal = globalThis as unknown as Record<string, unknown>;
if (typeof window !== "undefined") {
  browserGlobal[PDF_ENGINE_LEGACY_GLOBAL] = createPdfLegacyAdapter();
}

export { PDF_RENDERER_PROTOCOL_NAME, PDF_RENDERER_PROTOCOL_VERSION };
