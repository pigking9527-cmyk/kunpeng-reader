/**
 * Type-safe boundary for the imperative EPUB/PDF reader engine.
 *
 * This package is deliberately framework-free. The original reader owns its chrome and
 * feature panels; pagination, scrolling, selection, gestures and PDF/EPUB
 * rendering remain inside an imperative engine behind `ReaderEnginePort`.
 */

export const READER_PROTOCOL_NAME = "kunpeng-reader-engine";
export const READER_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_READER_MESSAGE_BYTES = 64 * 1024;
export const MAX_READER_SELECTION_TEXT_CHARS = 20_000;

type ReaderProtocolDirection = "shell-to-frame" | "frame-to-shell";

export interface ReaderMessageEnvelope<TAction extends string, TPayload> {
  readonly protocol: typeof READER_PROTOCOL_NAME;
  readonly version: typeof READER_PROTOCOL_VERSION;
  readonly action: TAction;
  readonly payload: TPayload;
}

export interface ReaderPosition {
  readonly chapter: number;
  readonly page?: number;
  readonly progress?: number;
  /** Stable text offset only; never a local path or a chapter body. */
  readonly textOffset?: number;
}

export interface ReaderLayoutSettings {
  readonly flowMode: "paged" | "scroll";
  readonly pageMode: "single" | "dual";
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly margin: number;
}

export type ReaderShellCommand =
  | ReaderMessageEnvelope<"turn-page", { readonly direction: "forward" | "backward" }>
  | ReaderMessageEnvelope<"go-to-position", ReaderPosition>
  | ReaderMessageEnvelope<"set-layout", ReaderLayoutSettings>
  | ReaderMessageEnvelope<"set-search", { readonly query: string; readonly direction?: "next" | "previous" }>
  | ReaderMessageEnvelope<"clear-search", Record<string, never>>
  | ReaderMessageEnvelope<"set-overlay-state", { readonly open: boolean }>
  | ReaderMessageEnvelope<"request-position-snapshot", { readonly requestId: number }>;

export type ReaderSelectionIntent =
  | "dictionary"
  | "web-search"
  | "cross-search"
  | "semantic-search"
  | "ai-reader"
  | "annotate";

export type ReaderFrameEvent =
  | ReaderMessageEnvelope<"ready", { readonly engine: "epub" | "pdf" }>
  | ReaderMessageEnvelope<"progress", ReaderPosition & { readonly totalChapters: number }>
  | ReaderMessageEnvelope<"layout-status", { readonly busy: boolean }>
  | ReaderMessageEnvelope<"navigation", { readonly kind: "link" | "footnote"; readonly position: ReaderPosition }>
  | ReaderMessageEnvelope<"gesture", {
    readonly phase: "start" | "move" | "end" | "cancel";
    readonly x: number;
    readonly y: number;
  }>
  | ReaderMessageEnvelope<"selection-action", {
    readonly intent: ReaderSelectionIntent;
    /** User-selected text is transient and bounded; do not log or fixture it. */
    readonly text: string;
    readonly start?: number;
    readonly end?: number;
  }>
  | ReaderMessageEnvelope<"search-status", { readonly index: number; readonly count: number }>
  | ReaderMessageEnvelope<"position-snapshot", { readonly requestId: number; readonly position: ReaderPosition }>;

export type ReaderProtocolMessage = ReaderShellCommand | ReaderFrameEvent;

export interface ReaderEnginePort {
  /** Imperatively attach the existing EPUB/PDF engine to a DOM host. */
  mount(host: HTMLElement): void;
  /** Stop render loops/listeners and detach the imperative engine. */
  unmount(): void;
  /** The shell sends typed commands; no UI layer issues DOM/page operations itself. */
  send(command: ReaderShellCommand): void;
  /** Subscribe to typed engine events without exposing a DOM implementation. */
  onEvent(listener: (event: ReaderFrameEvent) => void): ReaderUnsubscribe;
}

export type ReaderUnsubscribe = () => void;

export interface ReaderMessageEventLike {
  readonly data: unknown;
  readonly source: unknown;
  readonly origin: string;
}

export interface TrustedReaderMessageContext {
  /** Must be the exact Window/MessagePort expected for this reader frame. */
  readonly expectedSource: unknown;
  /** Explicit origins only. `*` and opaque `null` origins are never accepted. */
  readonly allowedOrigins: readonly string[];
  readonly maxMessageBytes?: number;
}

export type ReaderProtocolError =
  | "invalid-envelope"
  | "unknown-version"
  | "unknown-action"
  | "invalid-payload"
  | "message-too-large"
  | "untrusted-source"
  | "untrusted-origin";

export type ReaderParseResult<TMessage> =
  | { readonly ok: true; readonly value: TMessage }
  | { readonly ok: false; readonly error: ReaderProtocolError };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(record: UnknownRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isFiniteInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function isFiniteNumber(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function isBoundedText(value: unknown, maximum = MAX_READER_SELECTION_TEXT_CHARS): value is string {
  return typeof value === "string" && value.length <= maximum;
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

function sameKeysOrOptional(record: UnknownRecord, required: readonly string[], optional: readonly string[]): boolean {
  const actual = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key))
    && actual.every((key) => required.includes(key) || optional.includes(key));
}

function isReaderPosition(value: unknown, options: { readonly requireChapter: boolean }): value is ReaderPosition {
  if (!isRecord(value)) return false;
  const required = options.requireChapter ? ["chapter"] : [];
  if (!sameKeysOrOptional(value, required, ["chapter", "page", "progress", "textOffset"])) return false;
  return (value.chapter === undefined || isFiniteInteger(value.chapter, 0, 100_000))
    && (value.page === undefined || isFiniteInteger(value.page, 0, 10_000_000))
    && (value.progress === undefined || isFiniteNumber(value.progress, 0, 100))
    && (value.textOffset === undefined || isFiniteInteger(value.textOffset, 0, Number.MAX_SAFE_INTEGER));
}

function isLayoutSettings(value: unknown): value is ReaderLayoutSettings {
  return isRecord(value)
    && hasOnlyKeys(value, ["flowMode", "pageMode", "fontSize", "lineHeight", "margin"])
    && (value.flowMode === "paged" || value.flowMode === "scroll")
    && (value.pageMode === "single" || value.pageMode === "dual")
    && isFiniteNumber(value.fontSize, 8, 96)
    && isFiniteNumber(value.lineHeight, 0.8, 4)
    && isFiniteNumber(value.margin, 0, 240);
}

function isShellPayload(action: string, payload: unknown): boolean {
  if (action === "turn-page") {
    return isRecord(payload) && hasOnlyKeys(payload, ["direction"])
      && (payload.direction === "forward" || payload.direction === "backward");
  }
  if (action === "go-to-position") return isReaderPosition(payload, { requireChapter: true });
  if (action === "set-layout") return isLayoutSettings(payload);
  if (action === "set-search") {
    return isRecord(payload)
      && sameKeysOrOptional(payload, ["query"], ["direction"])
      && isBoundedText(payload.query, 4_000)
      && (payload.direction === undefined || payload.direction === "next" || payload.direction === "previous");
  }
  if (action === "clear-search") return isRecord(payload) && hasOnlyKeys(payload, []);
  if (action === "set-overlay-state") return isRecord(payload) && hasOnlyKeys(payload, ["open"]) && typeof payload.open === "boolean";
  if (action === "request-position-snapshot") {
    return isRecord(payload) && hasOnlyKeys(payload, ["requestId"])
      && isFiniteInteger(payload.requestId, 0, Number.MAX_SAFE_INTEGER);
  }
  return false;
}

function isFramePayload(action: string, payload: unknown): boolean {
  if (action === "ready") {
    return isRecord(payload) && hasOnlyKeys(payload, ["engine"])
      && (payload.engine === "epub" || payload.engine === "pdf");
  }
  if (action === "progress") {
    return isRecord(payload)
      && sameKeysOrOptional(payload, ["chapter", "totalChapters"], ["page", "progress", "textOffset"])
      // `totalChapters` belongs to the progress event rather than a position,
      // so validate the shared position fields in-place instead of passing the
      // larger object to the exact-key position validator.
      && isFiniteInteger(payload.chapter, 0, 100_000)
      && (payload.page === undefined || isFiniteInteger(payload.page, 0, 10_000_000))
      && (payload.progress === undefined || isFiniteNumber(payload.progress, 0, 100))
      && (payload.textOffset === undefined || isFiniteInteger(payload.textOffset, 0, Number.MAX_SAFE_INTEGER))
      && isFiniteInteger(payload.totalChapters, 1, 100_000);
  }
  if (action === "layout-status") return isRecord(payload) && hasOnlyKeys(payload, ["busy"]) && typeof payload.busy === "boolean";
  if (action === "navigation") {
    return isRecord(payload) && hasOnlyKeys(payload, ["kind", "position"])
      && (payload.kind === "link" || payload.kind === "footnote")
      && isReaderPosition(payload.position, { requireChapter: true });
  }
  if (action === "gesture") {
    return isRecord(payload) && hasOnlyKeys(payload, ["phase", "x", "y"])
      && (payload.phase === "start" || payload.phase === "move" || payload.phase === "end" || payload.phase === "cancel")
      && isFiniteNumber(payload.x, -100_000, 100_000)
      && isFiniteNumber(payload.y, -100_000, 100_000);
  }
  if (action === "selection-action") {
    return isRecord(payload)
      && sameKeysOrOptional(payload, ["intent", "text"], ["start", "end"])
      && (payload.intent === "dictionary" || payload.intent === "web-search" || payload.intent === "cross-search"
        || payload.intent === "semantic-search" || payload.intent === "ai-reader" || payload.intent === "annotate")
      && isBoundedText(payload.text)
      && (payload.start === undefined || isFiniteInteger(payload.start, 0, Number.MAX_SAFE_INTEGER))
      && (payload.end === undefined || isFiniteInteger(payload.end, 0, Number.MAX_SAFE_INTEGER))
      && (payload.start === undefined || payload.end === undefined || payload.end > payload.start);
  }
  if (action === "search-status") {
    return isRecord(payload) && hasOnlyKeys(payload, ["index", "count"])
      && isFiniteInteger(payload.index, 0, 1_000_000)
      && isFiniteInteger(payload.count, 0, 1_000_000)
      && payload.index <= payload.count;
  }
  if (action === "position-snapshot") {
    return isRecord(payload) && hasOnlyKeys(payload, ["requestId", "position"])
      && isFiniteInteger(payload.requestId, 0, Number.MAX_SAFE_INTEGER)
      && isReaderPosition(payload.position, { requireChapter: true });
  }
  return false;
}

function parseMessage<TMessage extends ReaderProtocolMessage>(
  value: unknown,
  direction: ReaderProtocolDirection,
  maxMessageBytes = DEFAULT_MAX_READER_MESSAGE_BYTES,
): ReaderParseResult<TMessage> {
  if (!isWithinMessageLimit(value, maxMessageBytes)) return { ok: false, error: "message-too-large" };
  if (!isRecord(value) || !hasOnlyKeys(value, ["protocol", "version", "action", "payload"])
    || value.protocol !== READER_PROTOCOL_NAME || typeof value.action !== "string") {
    return { ok: false, error: "invalid-envelope" };
  }
  if (value.version !== READER_PROTOCOL_VERSION) return { ok: false, error: "unknown-version" };
  const valid = direction === "shell-to-frame"
    ? isShellPayload(value.action, value.payload)
    : isFramePayload(value.action, value.payload);
  if (!valid) {
    const known = direction === "shell-to-frame"
      ? ["turn-page", "go-to-position", "set-layout", "set-search", "clear-search", "set-overlay-state", "request-position-snapshot"]
      : ["ready", "progress", "layout-status", "navigation", "gesture", "selection-action", "search-status", "position-snapshot"];
    return { ok: false, error: known.includes(value.action) ? "invalid-payload" : "unknown-action" };
  }
  return { ok: true, value: value as TMessage };
}

/** Parse a shell command without a Window/iframe dependency. */
export function parseReaderShellCommand(
  value: unknown,
  maxMessageBytes = DEFAULT_MAX_READER_MESSAGE_BYTES,
): ReaderParseResult<ReaderShellCommand> {
  return parseMessage<ReaderShellCommand>(value, "shell-to-frame", maxMessageBytes);
}

/** Parse a frame event without a Window/iframe dependency. */
export function parseReaderFrameEvent(
  value: unknown,
  maxMessageBytes = DEFAULT_MAX_READER_MESSAGE_BYTES,
): ReaderParseResult<ReaderFrameEvent> {
  return parseMessage<ReaderFrameEvent>(value, "frame-to-shell", maxMessageBytes);
}

function validateMessageEvent<TMessage extends ReaderProtocolMessage>(
  event: ReaderMessageEventLike,
  context: TrustedReaderMessageContext,
  parser: (value: unknown, maxMessageBytes: number) => ReaderParseResult<TMessage>,
): ReaderParseResult<TMessage> {
  if (event.source !== context.expectedSource) return { ok: false, error: "untrusted-source" };
  const origin = canonicalOrigin(event.origin);
  const allowed = context.allowedOrigins.map(canonicalOrigin).filter((value): value is string => value !== null);
  if (origin === null || !allowed.includes(origin)) return { ok: false, error: "untrusted-origin" };
  return parser(event.data, context.maxMessageBytes ?? DEFAULT_MAX_READER_MESSAGE_BYTES);
}

/** Verify origin and source before accepting a typed command in the reader frame. */
export function validateReaderShellCommandEvent(
  event: ReaderMessageEventLike,
  context: TrustedReaderMessageContext,
): ReaderParseResult<ReaderShellCommand> {
  return validateMessageEvent(event, context, parseReaderShellCommand);
}

/** Verify origin and source before accepting a typed event in the reader shell. */
export function validateReaderFrameEvent(
  event: ReaderMessageEventLike,
  context: TrustedReaderMessageContext,
): ReaderParseResult<ReaderFrameEvent> {
  return validateMessageEvent(event, context, parseReaderFrameEvent);
}
