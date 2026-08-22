export const READER_STARTUP_TIMEOUT_MS = 12_000;
export const READER_CLOSE_FALLBACK_MS = 4_200;

export interface ReaderStartupState {
  readonly scriptReady: boolean;
  readonly bookLoadStarted: boolean;
  readonly frameNavigationStarted: boolean;
  readonly frameReady: boolean;
  readonly closeRequested: boolean;
  readonly firstFailureReported: boolean;
}

export type ReaderStartupAction =
  | { readonly type: "MARK_SCRIPT_READY" }
  | { readonly type: "BEGIN_BOOK_LOAD" }
  | { readonly type: "BEGIN_FRAME_NAVIGATION" }
  | { readonly type: "MARK_FRAME_READY" }
  | { readonly type: "REQUEST_CLOSE" }
  | { readonly type: "REPORT_FIRST_FAILURE" };

export function createReaderStartupState(): ReaderStartupState {
  return Object.freeze({
    scriptReady: false,
    bookLoadStarted: false,
    frameNavigationStarted: false,
    frameReady: false,
    closeRequested: false,
    firstFailureReported: false,
  });
}

export function reduceReaderStartup(
  state: ReaderStartupState,
  action: ReaderStartupAction,
): ReaderStartupState {
  switch (action.type) {
    case "MARK_SCRIPT_READY":
      return Object.freeze({ ...state, scriptReady: true });
    case "BEGIN_BOOK_LOAD":
      return Object.freeze({ ...state, bookLoadStarted: true });
    case "BEGIN_FRAME_NAVIGATION":
      return Object.freeze({ ...state, frameNavigationStarted: true });
    case "MARK_FRAME_READY":
      return Object.freeze({ ...state, frameReady: true });
    case "REQUEST_CLOSE":
      return Object.freeze({ ...state, closeRequested: true });
    case "REPORT_FIRST_FAILURE":
      return state.firstFailureReported
        ? state
        : Object.freeze({ ...state, firstFailureReported: true });
  }
}

export function compactReaderStartupDiagnostic(value: unknown, fallback = "unknown"): string {
  return String(value || fallback || "unknown").replace(/\s+/g, " ").slice(0, 260);
}

/** Exact source allowlist used by the classic startup guard. */
export function isValidReaderDocumentSource(value: unknown): boolean {
  const source = String(value ?? "").trim();
  return Boolean(
    source &&
      source !== "about:blank" &&
      (source.startsWith("reader://") ||
        source.startsWith("http://reader.localhost/") ||
        source.startsWith("pdfview.html?")),
  );
}

export const READER_STARTUP_DEPENDENCIES = Object.freeze([
  "ReaderShell",
  "ReaderSettings",
  "ReaderAiHistoryRules",
  "ReaderReadingMetrics",
  "ReaderJumpBackRules",
  "ReaderBookInfoPanel",
  "ReaderBookInfoRelated",
] as const);

export type ReaderStartupDependencyName = (typeof READER_STARTUP_DEPENDENCIES)[number];

export function readerStartupDependencySummary(
  lookup: Readonly<Record<ReaderStartupDependencyName, unknown>>,
): string {
  return READER_STARTUP_DEPENDENCIES.map((name) => `${name}=${typeof lookup[name]}`).join(" ");
}
