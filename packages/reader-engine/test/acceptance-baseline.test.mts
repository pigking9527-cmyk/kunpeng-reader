import {
  READER_PROTOCOL_NAME,
  READER_PROTOCOL_VERSION,
  parseReaderFrameEvent,
  parseReaderShellCommand,
} from "../src/index.js";

function expect(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

const envelope = <TAction extends string, TPayload>(action: TAction, payload: TPayload) => ({
  protocol: READER_PROTOCOL_NAME,
  version: READER_PROTOCOL_VERSION,
  action,
  payload,
});

// These specimens are deliberately content-free. They pin every public action
// to a stable, minimal payload so a protocol expansion cannot silently drop a
// reader operation from the repeatable acceptance baseline.
const shellSpecimens = [
  envelope("turn-page", { direction: "forward" }),
  envelope("go-to-position", { chapter: 0, page: 0, progress: 0, textOffset: 0 }),
  envelope("set-layout", { flowMode: "scroll", pageMode: "dual", fontSize: 8, lineHeight: 0.8, margin: 0 }),
  envelope("set-search", { query: "query", direction: "previous" }),
  envelope("clear-search", {}),
  envelope("set-overlay-state", { open: true }),
  envelope("request-position-snapshot", { requestId: 0 }),
] as const;

const frameSpecimens = [
  envelope("ready", { engine: "epub" }),
  envelope("progress", { chapter: 0, totalChapters: 1, page: 0, progress: 0, textOffset: 0 }),
  envelope("layout-status", { busy: false }),
  envelope("navigation", { kind: "footnote", position: { chapter: 0 } }),
  envelope("gesture", { phase: "cancel", x: 0, y: 0 }),
  envelope("selection-action", { intent: "annotate", text: "" }),
  envelope("search-status", { index: 0, count: 0 }),
  envelope("position-snapshot", { requestId: 0, position: { chapter: 0 } }),
] as const;

for (const specimen of shellSpecimens) {
  const parsed = parseReaderShellCommand(specimen);
  expect(parsed.ok, `reader shell specimen ${specimen.action} remains accepted`);
}

for (const specimen of frameSpecimens) {
  const parsed = parseReaderFrameEvent(specimen);
  expect(parsed.ok, `reader frame specimen ${specimen.action} remains accepted`);
}

const invalidRanges = [
  envelope("set-layout", { flowMode: "paged", pageMode: "single", fontSize: 7.99, lineHeight: 1, margin: 0 }),
  envelope("go-to-position", { chapter: -1 }),
  envelope("progress", { chapter: 1, totalChapters: 0 }),
  envelope("search-status", { index: 2, count: 1 }),
] as const;

expect(!parseReaderShellCommand(invalidRanges[0]).ok, "layout values below the documented lower bound are rejected");
expect(!parseReaderShellCommand(invalidRanges[1]).ok, "negative reader chapters are rejected");
expect(!parseReaderFrameEvent(invalidRanges[2]).ok, "progress requires at least one total chapter");
expect(!parseReaderFrameEvent(invalidRanges[3]).ok, "search status cannot report an index beyond its count");

console.log(`reader-engine acceptance specimens passed (${shellSpecimens.length} shell, ${frameSpecimens.length} frame)`);
