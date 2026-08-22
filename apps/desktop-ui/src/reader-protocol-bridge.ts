import {
  READER_PROTOCOL_NAME,
  validateReaderFrameEvent,
  type ReaderFrameEvent,
  type ReaderMessageEventLike,
} from "../../../packages/reader-engine/src/index";

/**
 * Compatibility boundary for the imperative reader iframe.
 *
 * The flag is deliberately opt-in while the EPUB/PDF pages continue emitting
 * their established one-key payloads.  A future engine can emit the typed
 * envelope without making the legacy shell accept an unvalidated object.
 */
export const READER_FRAME_PROTOCOL_FEATURE_KEY = "kunpeng.feature.reader-frame-protocol.enabled";

export interface ReaderFrameElementLike {
  readonly src: string;
  readonly contentWindow: unknown;
}

export interface ReaderHostLocationLike {
  readonly href: string;
}

type LegacyReaderPayload = Readonly<Record<string, unknown>>;

function explicitOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.origin !== "null") return url.origin;
    // Tauri custom schemes do not have a WHATWG tuple origin, but their
    // scheme + host is still an explicit, comparable sender identity.
    return url.host ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

function readerFrameOrigin(frame: ReaderFrameElementLike, hostLocation: ReaderHostLocationLike): string | null {
  try {
    return explicitOrigin(new URL(frame.src, hostLocation.href).href);
  } catch {
    return null;
  }
}

function boundedFraction(percent: number | undefined): number {
  return Math.max(0, Math.min(1, (percent ?? 0) / 100));
}

function toLegacyPayload(event: ReaderFrameEvent): LegacyReaderPayload | null {
  switch (event.action) {
    case "ready":
      return { ready: 1 };
    case "progress":
      return {
        progress: event.payload.progress ?? 0,
        chapter: event.payload.chapter,
        chFrac: boundedFraction(event.payload.progress),
        totalCh: event.payload.totalChapters,
        ...(event.payload.page === undefined ? {} : { page: event.payload.page }),
      };
    case "layout-status":
      return { layoutBusy: event.payload.busy ? 1 : 0 };
    case "navigation":
      return {
        readerJump: {
          kind: event.payload.kind,
          chapter: event.payload.position.chapter,
          chFrac: boundedFraction(event.payload.position.progress),
        },
      };
    case "gesture":
      return { readerGesture: event.payload };
    case "selection-action": {
      const selection = event.payload;
      if (selection.intent === "dictionary") return { dict: selection.text };
      if (selection.intent === "web-search") return { webSearch: selection.text };
      if (selection.intent === "cross-search") return { crossSearch: selection.text };
      if (selection.intent === "semantic-search") return { semanticSearch: selection.text };
      if (selection.intent === "ai-reader") {
        return {
          aiReader: {
            text: selection.text,
            ...(selection.start === undefined ? {} : { anchorStart: selection.start }),
            ...(selection.end === undefined ? {} : { anchorEnd: selection.end }),
          },
        };
      }
      // Highlight geometry remains in the imperative engine.  An envelope
      // with only selection text must not fabricate a legacy annotation.
      return null;
    }
    case "search-status":
      // The current shell only has a legacy list payload, not a count-only
      // update.  Keep the event validated but do not clear search results.
      return null;
    case "position-snapshot":
      return {
        progress: event.payload.position.progress ?? 0,
        chapter: event.payload.position.chapter,
        chFrac: boundedFraction(event.payload.position.progress),
        totalCh: 1,
        positionSnapshotRequestId: event.payload.requestId,
        ...(event.payload.position.page === undefined ? {} : { page: event.payload.position.page }),
      };
  }
}

/** Returns whether the typed frame protocol is explicitly enabled for this device. */
export function isReaderFrameProtocolEnabled(): boolean {
  try {
    return window.localStorage.getItem(READER_FRAME_PROTOCOL_FEATURE_KEY) === "true";
  } catch {
    return false;
  }
}

/**
 * Parse and translate an incoming v1 reader frame envelope.
 *
 * Both the exact frame WindowProxy and its explicit origin are passed into
 * `reader-engine`; a wildcard, an opaque origin, a forged source, an unknown
 * envelope, or a message larger than the package default is rejected there.
 */
export function normalizeReaderFrameProtocolEvent(
  event: ReaderMessageEventLike,
  frame: ReaderFrameElementLike,
  hostLocation: ReaderHostLocationLike,
  enabled = isReaderFrameProtocolEnabled(),
): LegacyReaderPayload | null {
  if (!enabled || !frame.contentWindow) return null;
  const origin = readerFrameOrigin(frame, hostLocation);
  if (!origin) return null;
  const parsed = validateReaderFrameEvent(event, {
    expectedSource: frame.contentWindow,
    allowedOrigins: [origin],
  });
  return parsed.ok ? toLegacyPayload(parsed.value) : null;
}

/** True only for a syntactically recognizable reader-engine envelope. */
export function isReaderFrameProtocolEnvelope(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && !Array.isArray(value)
    && (value as { readonly protocol?: unknown }).protocol === READER_PROTOCOL_NAME;
}
