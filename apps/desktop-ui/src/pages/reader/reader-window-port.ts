/**
 * Typed, deliberately small native boundary for the reader window.
 *
 * The returned resource URL is an opaque `reader://` capability.  Source
 * files, chapter HTML and PDF canvas data must remain inside the imperative
 * reader engine and never enter React state.
 */
export type ReaderBookFormat = "epub" | "pdf" | "text";

export interface ReaderBookInfo {
  readonly id: string;
  readonly contentId: string;
  readonly title: string;
  readonly format: ReaderBookFormat;
  readonly resourceUrl: string;
  readonly resumeChapter: number;
  readonly resumeFraction: number;
}

export interface ReaderWindowPort {
  loadBook(signal: AbortSignal): Promise<ReaderBookInfo>;
  close(signal: AbortSignal): Promise<void>;
  /** Native title-bar close request; undefined in browser-only tests. */
  readonly listenCloseRequested?: (listener: () => void) => Promise<ReaderWindowUnlisten>;
}

export type ReaderWindowUnlisten = () => void;

export interface ReaderWindowTransport {
  invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult>;
  readonly listen?: <TPayload>(
    event: string,
    handler: (event: { readonly payload: TPayload }) => void,
  ) => Promise<ReaderWindowUnlisten>;
}

type UnknownRecord = Record<string, unknown>;

function aborted(): never {
  throw new DOMException("The reader request was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) aborted();
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function resourceUrl(value: unknown, id: string, format: ReaderBookFormat): string | null {
  const text = nonEmptyText(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    const expectedPath = format === "pdf" ? `/pdf/${id}` : `/book/${id}`;
    return parsed.protocol === "reader:"
      && parsed.host === "localhost"
      && parsed.pathname === expectedPath
      && !parsed.search
      && !parsed.hash
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function parseBookInfo(value: unknown): ReaderBookInfo {
  const input = record(value);
  const id = nonEmptyText(input?.id);
  const title = nonEmptyText(input?.title);
  const rawFormat = nonEmptyText(input?.format)?.toLowerCase();
  const format: ReaderBookFormat | null = rawFormat === "pdf"
    ? "pdf"
    : rawFormat === "epub" ? "epub" : rawFormat ? "text" : null;
  const resumeChapter = finiteNonNegative(input?.resume_chapter);
  const resumeFraction = finiteNonNegative(input?.resume_frac);
  if (!id || !title || !format || resumeChapter === null || resumeFraction === null) {
    throw new Error("Reader book metadata is unavailable.");
  }
  const url = resourceUrl(input?.url, id, format);
  if (!url) throw new Error("Reader book resource is unavailable.");
  return Object.freeze({
    id,
    contentId: nonEmptyText(input?.content_id) ?? "",
    title,
    format,
    resourceUrl: url,
    resumeChapter: Math.floor(resumeChapter),
    resumeFraction: Math.min(1, resumeFraction),
  });
}

/** Adapts exactly the existing `book_info` and close commands. */
export function createTauriReaderWindowPort(transport: ReaderWindowTransport): ReaderWindowPort {
  const listen = transport.listen;
  const listenCloseRequested = listen
    ? async (listener: () => void): Promise<ReaderWindowUnlisten> => listen("reader-hide-request", () => listener())
    : undefined;
  return {
    async loadBook(signal: AbortSignal): Promise<ReaderBookInfo> {
      throwIfAborted(signal);
      const value = await transport.invoke<unknown>("book_info");
      throwIfAborted(signal);
      return parseBookInfo(value);
    },
    async close(signal: AbortSignal): Promise<void> {
      throwIfAborted(signal);
      await transport.invoke<void>("main_window_close");
      throwIfAborted(signal);
    },
    ...(listenCloseRequested ? { listenCloseRequested } : {}),
  };
}
