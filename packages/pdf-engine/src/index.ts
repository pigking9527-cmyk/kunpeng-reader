/**
 * Controlled boundary for the imperative PDF.js renderer.
 *
 * A surrounding UI may render controls around this port, but must not own the PDF
 * canvas/text-layer lifecycle. This module deliberately has no dependency on
 * PDF.js: a platform adapter supplies the tiny surface it needs.
 */

export const PDF_RENDERER_PROTOCOL_NAME = "kunpeng-pdf-renderer";
export const PDF_RENDERER_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_PDF_MESSAGE_BYTES = 16 * 1024;
export const MAX_PDF_DOCUMENT_BYTES = 200 * 1024 * 1024;
export const MAX_PDF_PAGE_NUMBER = 10_000_000;

declare const pdfDocumentIdBrand: unique symbol;
declare const pdfOperationIdBrand: unique symbol;

/**
 * An opaque application content identifier, never a filesystem path or URL.
 * The binary is resolved by a trusted native/asset adapter outside messages.
 */
export type PdfDocumentId = string & { readonly [pdfDocumentIdBrand]: "PdfDocumentId" };
export type PdfOperationId = string & { readonly [pdfOperationIdBrand]: "PdfOperationId" };

export interface PdfMessageEnvelope<TAction extends string, TPayload> {
  readonly protocol: typeof PDF_RENDERER_PROTOCOL_NAME;
  readonly version: typeof PDF_RENDERER_PROTOCOL_VERSION;
  readonly action: TAction;
  readonly payload: TPayload;
}

export interface PdfOpenDocumentRequest {
  readonly documentId: PdfDocumentId;
  readonly operationId: PdfOperationId;
  readonly initialPage: number;
}

export interface PdfRenderPageRequest {
  readonly documentId: PdfDocumentId;
  readonly operationId: PdfOperationId;
  readonly page: number;
  readonly scale: number;
  readonly rotation: 0 | 90 | 180 | 270;
}

export type PdfRendererCommand =
  | PdfMessageEnvelope<"open-document", PdfOpenDocumentRequest>
  | PdfMessageEnvelope<"render-page", PdfRenderPageRequest>
  | PdfMessageEnvelope<"cancel-operation", {
    readonly documentId: PdfDocumentId;
    readonly operationId: PdfOperationId;
  }>
  | PdfMessageEnvelope<"close-document", { readonly documentId: PdfDocumentId }>;

export type PdfRendererErrorCode =
  | "document-not-found"
  | "invalid-document"
  | "document-too-large"
  | "load-failed"
  | "render-failed"
  | "cancelled"
  | "disposed";

export type PdfRendererEvent =
  | PdfMessageEnvelope<"lifecycle", PdfRendererLifecycle>
  | PdfMessageEnvelope<"document-ready", {
    readonly documentId: PdfDocumentId;
    readonly operationId: PdfOperationId;
    readonly pageCount: number;
  }>
  | PdfMessageEnvelope<"page-rendered", {
    readonly documentId: PdfDocumentId;
    readonly operationId: PdfOperationId;
    readonly page: number;
    readonly width: number;
    readonly height: number;
  }>
  | PdfMessageEnvelope<"operation-cancelled", {
    readonly documentId: PdfDocumentId;
    readonly operationId: PdfOperationId;
  }>
  | PdfMessageEnvelope<"renderer-error", {
    readonly documentId?: PdfDocumentId;
    readonly operationId?: PdfOperationId;
    readonly code: PdfRendererErrorCode;
  }>;

export type PdfRendererLifecycle =
  | { readonly state: "idle" }
  | { readonly state: "loading"; readonly documentId: PdfDocumentId; readonly operationId: PdfOperationId }
  | { readonly state: "ready"; readonly documentId: PdfDocumentId; readonly pageCount: number }
  | { readonly state: "rendering"; readonly documentId: PdfDocumentId; readonly operationId: PdfOperationId; readonly page: number }
  | { readonly state: "failed"; readonly documentId?: PdfDocumentId; readonly code: PdfRendererErrorCode }
  | { readonly state: "disposed" };

export type PdfRendererLifecycleState = PdfRendererLifecycle["state"];
export type PdfUnsubscribe = () => void;

/**
 * Application-owned bytes for a PDF. Only trusted code can resolve an opaque
 * document id to this data; command messages can never carry a path or URL.
 */
export interface PdfBinaryDocument {
  readonly documentId: PdfDocumentId;
  readonly bytes: Uint8Array;
}

/** The only PDF.js loading configuration emitted by this package. */
export interface PdfJsLoadParameters {
  readonly data: Uint8Array;
  readonly disableRange: true;
  readonly disableStream: true;
  readonly disableAutoFetch: true;
}

/**
 * Minimal PDF.js surface. Keep its rendering loops and DOM work imperative in
 * an adapter; neither a UI nor this protocol needs to know PDF.js internals.
 */
export interface PdfJsLoadingTask<TDocument> {
  readonly promise: Promise<TDocument>;
  destroy(): Promise<void> | void;
}

export interface PdfJsLoader<TDocument> {
  getDocument(parameters: PdfJsLoadParameters): PdfJsLoadingTask<TDocument>;
}

/** The part of a PDF.js document needed to enforce its lifecycle. */
export interface PdfJsDocument {
  readonly numPages: number;
  destroy(): Promise<void> | void;
}

export interface PdfDocumentResolver {
  resolve(documentId: PdfDocumentId, signal: AbortSignal): Promise<PdfBinaryDocument>;
}

/**
 * The imperative adapter owns Canvas/TextLayer work. It is intentionally a
 * port dependency rather than a visual component or a `postMessage` handler.
 */
export interface PdfSurfaceAdapter<TDocument extends PdfJsDocument> {
  mount(host: HTMLElement): void;
  render(document: TDocument, request: PdfRenderPageRequest, signal: AbortSignal): Promise<{
    readonly width: number;
    readonly height: number;
  }>;
  clear(): void;
  unmount(): void;
}

export interface PdfRendererDependencies<TDocument extends PdfJsDocument> {
  readonly resolver: PdfDocumentResolver;
  readonly loader: PdfJsLoader<TDocument>;
  readonly surface: PdfSurfaceAdapter<TDocument>;
}

export interface PdfRendererPort {
  readonly lifecycle: PdfRendererLifecycle;
  /**
   * Bounded ownership counters for lifecycle tests and operational diagnostics.
   * They deliberately expose no document bytes, page content, path, or URL.
   */
  readonly diagnostics: PdfRendererDiagnostics;
  mount(host: HTMLElement): void;
  open(request: PdfOpenDocumentRequest, signal?: AbortSignal): Promise<void>;
  renderPage(request: PdfRenderPageRequest, signal?: AbortSignal): Promise<void>;
  cancel(operationId: PdfOperationId): void;
  close(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: PdfRendererEvent) => void): PdfUnsubscribe;
}

/**
 * A snapshot of references owned by the controlled renderer boundary.
 *
 * A fully closed or disposed port must report zero operations, no active
 * loading task, and no active document. This makes lifecycle retention
 * observable without relying on non-deterministic garbage collection.
 */
export interface PdfRendererDiagnostics {
  readonly activeOperationCount: number;
  readonly listenerCount: number;
  readonly hasActiveDocument: boolean;
  readonly hasLoadingTask: boolean;
  readonly disposed: boolean;
}

export interface PdfMessageEventLike {
  readonly data: unknown;
  readonly source: unknown;
  readonly origin: string;
}

export interface TrustedPdfMessageContext {
  readonly expectedSource: unknown;
  /** Explicit origins only. Wildcards and opaque origins are rejected. */
  readonly allowedOrigins: readonly string[];
  readonly maxMessageBytes?: number;
}

export type PdfProtocolError =
  | "invalid-envelope"
  | "unknown-version"
  | "unknown-action"
  | "invalid-payload"
  | "message-too-large"
  | "untrusted-source"
  | "untrusted-origin";

export type PdfParseResult<TMessage> =
  | { readonly ok: true; readonly value: TMessage }
  | { readonly ok: false; readonly error: PdfProtocolError };

type UnknownRecord = Record<string, unknown>;
type PdfDirection = "shell-to-renderer" | "renderer-to-shell";

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function hasRequiredAndOptionalKeys(record: UnknownRecord, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key))
    && actual.every((key) => required.includes(key) || optional.includes(key));
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value);
}

function isPageNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PDF_PAGE_NUMBER;
}

function isOperationId(value: unknown): value is PdfOperationId {
  return isBoundedIdentifier(value) && value.length <= 64;
}

function isDocumentId(value: unknown): value is PdfDocumentId {
  return isBoundedIdentifier(value);
}

function isScale(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.25 && value <= 8;
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100_000;
}

function serializedByteLength(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? new TextEncoder().encode(serialized).byteLength
      : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isWithinMessageLimit(value: unknown, maximum: number): boolean {
  return Number.isSafeInteger(maximum) && maximum > 0 && serializedByteLength(value) <= maximum;
}

function isErrorCode(value: unknown): value is PdfRendererErrorCode {
  return value === "document-not-found"
    || value === "invalid-document"
    || value === "document-too-large"
    || value === "load-failed"
    || value === "render-failed"
    || value === "cancelled"
    || value === "disposed";
}

function isLifecycleState(value: unknown): value is PdfRendererLifecycleState {
  return value === "idle" || value === "loading" || value === "ready"
    || value === "rendering" || value === "failed" || value === "disposed";
}

function isLifecycle(value: unknown): value is PdfRendererLifecycle {
  if (!isRecord(value) || !isLifecycleState(value.state)) return false;
  if (value.state === "idle" || value.state === "disposed") return hasOnlyKeys(value, ["state"]);
  if (value.state === "loading") {
    return hasOnlyKeys(value, ["state", "documentId", "operationId"])
      && isDocumentId(value.documentId)
      && isOperationId(value.operationId);
  }
  if (value.state === "ready") {
    return hasOnlyKeys(value, ["state", "documentId", "pageCount"])
      && isDocumentId(value.documentId)
      && isPageNumber(value.pageCount);
  }
  if (value.state === "rendering") {
    return hasOnlyKeys(value, ["state", "documentId", "operationId", "page"])
      && isDocumentId(value.documentId)
      && isOperationId(value.operationId)
      && isPageNumber(value.page);
  }
  return hasRequiredAndOptionalKeys(value, ["state", "code"], ["documentId"])
    && isErrorCode(value.code)
    && (value.documentId === undefined || isDocumentId(value.documentId));
}

function isShellPayload(action: string, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (action === "open-document") {
    return hasOnlyKeys(payload, ["documentId", "operationId", "initialPage"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId)
      && isPageNumber(payload.initialPage);
  }
  if (action === "render-page") {
    return hasOnlyKeys(payload, ["documentId", "operationId", "page", "scale", "rotation"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId)
      && isPageNumber(payload.page)
      && isScale(payload.scale)
      && (payload.rotation === 0 || payload.rotation === 90 || payload.rotation === 180 || payload.rotation === 270);
  }
  if (action === "cancel-operation") {
    return hasOnlyKeys(payload, ["documentId", "operationId"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId);
  }
  if (action === "close-document") {
    return hasOnlyKeys(payload, ["documentId"]) && isDocumentId(payload.documentId);
  }
  return false;
}

function isRendererPayload(action: string, payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (action === "lifecycle") {
    return isLifecycle(payload);
  }
  if (action === "document-ready") {
    return hasOnlyKeys(payload, ["documentId", "operationId", "pageCount"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId)
      && isPageNumber(payload.pageCount);
  }
  if (action === "page-rendered") {
    return hasOnlyKeys(payload, ["documentId", "operationId", "page", "width", "height"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId)
      && isPageNumber(payload.page)
      && isDimension(payload.width)
      && isDimension(payload.height);
  }
  if (action === "operation-cancelled") {
    return hasOnlyKeys(payload, ["documentId", "operationId"])
      && isDocumentId(payload.documentId)
      && isOperationId(payload.operationId);
  }
  if (action === "renderer-error") {
    return hasRequiredAndOptionalKeys(payload, ["code"], ["documentId", "operationId"])
      && isErrorCode(payload.code)
      && (payload.documentId === undefined || isDocumentId(payload.documentId))
      && (payload.operationId === undefined || isOperationId(payload.operationId));
  }
  return false;
}

function parseMessage<TMessage extends PdfRendererCommand | PdfRendererEvent>(
  value: unknown,
  direction: PdfDirection,
  maxMessageBytes = DEFAULT_MAX_PDF_MESSAGE_BYTES,
): PdfParseResult<TMessage> {
  if (!isWithinMessageLimit(value, maxMessageBytes)) return { ok: false, error: "message-too-large" };
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocol", "version", "action", "payload"])
    || value.protocol !== PDF_RENDERER_PROTOCOL_NAME || typeof value.action !== "string") {
    return { ok: false, error: "invalid-envelope" };
  }
  if (value.version !== PDF_RENDERER_PROTOCOL_VERSION) return { ok: false, error: "unknown-version" };
  const valid = direction === "shell-to-renderer"
    ? isShellPayload(value.action, value.payload)
    : isRendererPayload(value.action, value.payload);
  if (valid) return { ok: true, value: value as TMessage };
  const known = direction === "shell-to-renderer"
    ? ["open-document", "render-page", "cancel-operation", "close-document"]
    : ["lifecycle", "document-ready", "page-rendered", "operation-cancelled", "renderer-error"];
  return { ok: false, error: known.includes(value.action) ? "invalid-payload" : "unknown-action" };
}

/** Parse command messages without a Window or PDF.js dependency. */
export function parsePdfRendererCommand(
  value: unknown,
  maxMessageBytes = DEFAULT_MAX_PDF_MESSAGE_BYTES,
): PdfParseResult<PdfRendererCommand> {
  return parseMessage<PdfRendererCommand>(value, "shell-to-renderer", maxMessageBytes);
}

/** Parse renderer events without exposing unbounded error messages or document data. */
export function parsePdfRendererEvent(
  value: unknown,
  maxMessageBytes = DEFAULT_MAX_PDF_MESSAGE_BYTES,
): PdfParseResult<PdfRendererEvent> {
  return parseMessage<PdfRendererEvent>(value, "renderer-to-shell", maxMessageBytes);
}

function canonicalOrigin(value: string): string | null {
  if (!value || value === "null" || value === "*") return null;
  try {
    const url = new URL(value);
    if (url.origin !== "null") return url.origin;
    return url.host ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

function validateMessageEvent<TMessage extends PdfRendererCommand | PdfRendererEvent>(
  event: PdfMessageEventLike,
  context: TrustedPdfMessageContext,
  parser: (value: unknown, maxMessageBytes: number) => PdfParseResult<TMessage>,
): PdfParseResult<TMessage> {
  if (event.source !== context.expectedSource) return { ok: false, error: "untrusted-source" };
  const origin = canonicalOrigin(event.origin);
  const allowed = context.allowedOrigins.map(canonicalOrigin).filter((value): value is string => value !== null);
  if (origin === null || !allowed.includes(origin)) return { ok: false, error: "untrusted-origin" };
  return parser(event.data, context.maxMessageBytes ?? DEFAULT_MAX_PDF_MESSAGE_BYTES);
}

export function validatePdfRendererCommandEvent(
  event: PdfMessageEventLike,
  context: TrustedPdfMessageContext,
): PdfParseResult<PdfRendererCommand> {
  return validateMessageEvent(event, context, parsePdfRendererCommand);
}

export function validatePdfRendererEvent(
  event: PdfMessageEventLike,
  context: TrustedPdfMessageContext,
): PdfParseResult<PdfRendererEvent> {
  return validateMessageEvent(event, context, parsePdfRendererEvent);
}

export function createPdfDocumentId(value: string): PdfDocumentId {
  if (!isDocumentId(value)) {
    throw new TypeError("PDF document id must be a bounded opaque identifier, not a path or URL.");
  }
  return value;
}

export function createPdfOperationId(value: string): PdfOperationId {
  if (!isOperationId(value)) {
    throw new TypeError("PDF operation id must be a bounded opaque identifier.");
  }
  return value;
}

export function createPdfBinaryDocument(documentId: PdfDocumentId, bytes: Uint8Array): PdfBinaryDocument {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > MAX_PDF_DOCUMENT_BYTES) {
    throw new RangeError("PDF bytes must be non-empty and within the renderer size limit.");
  }
  return Object.freeze({ documentId, bytes: new Uint8Array(bytes) });
}

/**
 * PDF.js is loaded from trusted bytes only. The returned object intentionally
 * has no `url`, `range`, `stream` or arbitrary source fields.
 */
export function createPdfJsLoadParameters(document: PdfBinaryDocument): PdfJsLoadParameters {
  return Object.freeze({
    data: new Uint8Array(document.bytes),
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
  });
}

function isValidOpenRequest(value: PdfOpenDocumentRequest): boolean {
  return isDocumentId(value.documentId) && isOperationId(value.operationId) && isPageNumber(value.initialPage);
}

function isValidRenderRequest(value: PdfRenderPageRequest): boolean {
  return isDocumentId(value.documentId)
    && isOperationId(value.operationId)
    && isPageNumber(value.page)
    && isScale(value.scale)
    && (value.rotation === 0 || value.rotation === 90 || value.rotation === 180 || value.rotation === 270);
}

/**
 * Creates a lifecycle-owning port around a PDF.js loader and an imperative
 * canvas/text-layer adapter. The production legacy adapter in
 * `apps/desktop-ui/src/pdf-engine-legacy-adapter.ts` consumes this port from
 * `ui/pdfview.js`; the port does not own the PDF canvas or text layer.
 */
export function createPdfRendererPort<TDocument extends PdfJsDocument>(
  dependencies: PdfRendererDependencies<TDocument>,
): PdfRendererPort {
  return new ControlledPdfRendererPort(dependencies);
}

class ControlledPdfRendererPort<TDocument extends PdfJsDocument> implements PdfRendererPort {
  private readonly listeners = new Set<(event: PdfRendererEvent) => void>();
  private readonly controllers = new Map<PdfOperationId, AbortController>();
  private lifecycleValue: PdfRendererLifecycle = { state: "idle" };
  private documentValue: { readonly id: PdfDocumentId; readonly document: TDocument } | null = null;
  private loadingTask: PdfJsLoadingTask<TDocument> | null = null;
  private disposed = false;
  private epoch = 0;

  public constructor(private readonly dependencies: PdfRendererDependencies<TDocument>) {}

  public get lifecycle(): PdfRendererLifecycle {
    return this.lifecycleValue;
  }

  public get diagnostics(): PdfRendererDiagnostics {
    return Object.freeze({
      activeOperationCount: this.controllers.size,
      listenerCount: this.listeners.size,
      hasActiveDocument: this.documentValue !== null,
      hasLoadingTask: this.loadingTask !== null,
      disposed: this.disposed,
    });
  }

  public mount(host: HTMLElement): void {
    this.ensureUsable();
    this.dependencies.surface.mount(host);
  }

  public async open(request: PdfOpenDocumentRequest, signal?: AbortSignal): Promise<void> {
    this.ensureUsable();
    if (!isValidOpenRequest(request)) throw new TypeError("Invalid controlled PDF open request.");
    await this.close();
    this.ensureUsable();

    const epoch = ++this.epoch;
    const controller = this.beginOperation(request.operationId, signal);
    this.setLifecycle({ state: "loading", documentId: request.documentId, operationId: request.operationId });
    try {
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      const binary = await this.dependencies.resolver.resolve(request.documentId, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (binary.documentId !== request.documentId) throw new TypeError("Resolved document id does not match the request.");
      const parameters = createPdfJsLoadParameters(binary);
      const task = this.dependencies.loader.getDocument(parameters);
      this.loadingTask = task;
      const abortLoading = () => { void Promise.resolve(task.destroy()); };
      controller.signal.addEventListener("abort", abortLoading, { once: true });
      const document = await task.promise;
      controller.signal.removeEventListener("abort", abortLoading);
      if (epoch !== this.epoch || controller.signal.aborted) {
        await Promise.resolve(document.destroy());
        throw new DOMException("Aborted", "AbortError");
      }
      if (!isPageNumber(document.numPages)) throw new TypeError("PDF.js returned an invalid page count.");
      this.documentValue = { id: request.documentId, document };
      this.loadingTask = null;
      this.setLifecycle({ state: "ready", documentId: request.documentId, pageCount: document.numPages });
      this.emit({
        protocol: PDF_RENDERER_PROTOCOL_NAME,
        version: PDF_RENDERER_PROTOCOL_VERSION,
        action: "document-ready",
        payload: { documentId: request.documentId, operationId: request.operationId, pageCount: document.numPages },
      });
    } catch (error: unknown) {
      if (epoch !== this.epoch || controller.signal.aborted || isAbortLike(error)) {
        this.emitCancelled(request.documentId, request.operationId);
        if (epoch === this.epoch && !this.disposed && this.documentValue === null) {
          this.setLifecycle({ state: "failed", documentId: request.documentId, code: "cancelled" });
        }
      } else {
        this.fail(request.documentId, request.operationId, mapOpenError(error));
      }
    } finally {
      this.loadingTask = null;
      this.endOperation(request.operationId, controller);
    }
  }

  public async renderPage(request: PdfRenderPageRequest, signal?: AbortSignal): Promise<void> {
    this.ensureUsable();
    if (!isValidRenderRequest(request)) throw new TypeError("Invalid controlled PDF render request.");
    const active = this.documentValue;
    if (active === null || active.id !== request.documentId) {
      this.fail(request.documentId, request.operationId, "document-not-found");
      return;
    }
    if (request.page > active.document.numPages) {
      this.fail(request.documentId, request.operationId, "invalid-document");
      return;
    }

    const epoch = this.epoch;
    const controller = this.beginOperation(request.operationId, signal);
    this.setLifecycle({
      state: "rendering",
      documentId: request.documentId,
      operationId: request.operationId,
      page: request.page,
    });
    try {
      const result = await this.dependencies.surface.render(active.document, request, controller.signal);
      if (epoch !== this.epoch || controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!isDimension(result.width) || !isDimension(result.height)) throw new TypeError("PDF renderer returned invalid dimensions.");
      this.emit({
        protocol: PDF_RENDERER_PROTOCOL_NAME,
        version: PDF_RENDERER_PROTOCOL_VERSION,
        action: "page-rendered",
        payload: {
          documentId: request.documentId,
          operationId: request.operationId,
          page: request.page,
          width: result.width,
          height: result.height,
        },
      });
      this.setLifecycle({ state: "ready", documentId: active.id, pageCount: active.document.numPages });
    } catch (error: unknown) {
      if (epoch !== this.epoch || controller.signal.aborted || isAbortLike(error)) {
        this.emitCancelled(request.documentId, request.operationId);
        if (this.documentValue !== null) {
          this.setLifecycle({
            state: "ready",
            documentId: this.documentValue.id,
            pageCount: this.documentValue.document.numPages,
          });
        }
      } else {
        this.fail(request.documentId, request.operationId, "render-failed");
      }
    } finally {
      this.endOperation(request.operationId, controller);
    }
  }

  public cancel(operationId: PdfOperationId): void {
    this.controllers.get(operationId)?.abort();
  }

  public async close(): Promise<void> {
    ++this.epoch;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    if (this.loadingTask !== null) {
      await Promise.resolve(this.loadingTask.destroy());
      this.loadingTask = null;
    }
    const active = this.documentValue;
    this.documentValue = null;
    this.dependencies.surface.clear();
    if (active !== null) await Promise.resolve(active.document.destroy());
    if (!this.disposed) this.setLifecycle({ state: "idle" });
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.close();
    this.disposed = true;
    this.dependencies.surface.unmount();
    this.setLifecycle({ state: "disposed" });
    this.listeners.clear();
  }

  public onEvent(listener: (event: PdfRendererEvent) => void): PdfUnsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private beginOperation(operationId: PdfOperationId, externalSignal?: AbortSignal): AbortController {
    this.cancel(operationId);
    const controller = new AbortController();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    this.controllers.set(operationId, controller);
    return controller;
  }

  private endOperation(operationId: PdfOperationId, controller: AbortController): void {
    if (this.controllers.get(operationId) === controller) this.controllers.delete(operationId);
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error("PDF renderer port has been disposed.");
  }

  private emitCancelled(documentId: PdfDocumentId, operationId: PdfOperationId): void {
    this.emit({
      protocol: PDF_RENDERER_PROTOCOL_NAME,
      version: PDF_RENDERER_PROTOCOL_VERSION,
      action: "operation-cancelled",
      payload: { documentId, operationId },
    });
  }

  private fail(documentId: PdfDocumentId, operationId: PdfOperationId, code: PdfRendererErrorCode): void {
    this.setLifecycle({ state: "failed", documentId, code });
    this.emit({
      protocol: PDF_RENDERER_PROTOCOL_NAME,
      version: PDF_RENDERER_PROTOCOL_VERSION,
      action: "renderer-error",
      payload: { documentId, operationId, code },
    });
  }

  private setLifecycle(lifecycle: PdfRendererLifecycle): void {
    this.lifecycleValue = lifecycle;
    this.emit({
      protocol: PDF_RENDERER_PROTOCOL_NAME,
      version: PDF_RENDERER_PROTOCOL_VERSION,
      action: "lifecycle",
      payload: lifecycle,
    });
  }

  private emit(event: PdfRendererEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function isAbortLike(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function mapOpenError(error: unknown): PdfRendererErrorCode {
  if (error instanceof RangeError) return "document-too-large";
  if (error instanceof TypeError) return "invalid-document";
  return "load-failed";
}
