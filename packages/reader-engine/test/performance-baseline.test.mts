import {
  READER_PROTOCOL_NAME,
  READER_PROTOCOL_VERSION,
  parseReaderFrameEvent,
  parseReaderShellCommand,
  validateReaderFrameEvent,
  validateReaderShellCommandEvent,
} from "../src/index.js";

const SAMPLE_COUNT = 10_000;
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

  // The cap is intentionally generous for shared/slow CI hosts. It catches
  // accidental retention of the whole batch without turning normal V8 GC
  // timing into a flaky assertion.
  expect(elapsedMilliseconds < MAX_BATCH_MILLISECONDS, `${label} exceeded ${MAX_BATCH_MILLISECONDS}ms`);
  expect(
    heapGrowthBytes < MAX_BATCH_HEAP_GROWTH_BYTES,
    `${label} retained more than ${MAX_BATCH_HEAP_GROWTH_BYTES} bytes in one synthetic batch`,
  );
  console.log(`[reader-engine performance] ${label}: ${elapsedMilliseconds.toFixed(1)}ms, +${heapGrowthBytes} bytes`);
}

const trustedSource = {};
const trustedContext = {
  expectedSource: trustedSource,
  allowedOrigins: ["https://reader.localhost", "tauri://localhost"],
} as const;

const shellCommands = [
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "turn-page",
    payload: { direction: "forward" },
  },
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "set-layout",
    payload: { flowMode: "paged", pageMode: "single", fontSize: 18, lineHeight: 1.6, margin: 24 },
  },
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "set-search",
    payload: { query: "synthetic-query", direction: "next" },
  },
] as const;

const frameEvents = [
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "progress",
    payload: { chapter: 7, page: 19, progress: 42.5, textOffset: 6_400, totalChapters: 18 },
  },
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "gesture",
    payload: { phase: "move", x: 384, y: 216 },
  },
  {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "search-status",
    payload: { index: 5, count: 28 },
  },
] as const;

measureBatch(`parse ${SAMPLE_COUNT} synthetic commands and events`, () => {
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const command = parseReaderShellCommand(shellCommands[index % shellCommands.length]);
    const event = parseReaderFrameEvent(frameEvents[index % frameEvents.length]);
    expect(command.ok && event.ok, "synthetic reader protocol data remains valid");
  }
});

measureBatch(`validate ${SAMPLE_COUNT} trusted synthetic message events`, () => {
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const command = validateReaderShellCommandEvent(
      { data: shellCommands[index % shellCommands.length], source: trustedSource, origin: "tauri://localhost" },
      trustedContext,
    );
    const event = validateReaderFrameEvent(
      { data: frameEvents[index % frameEvents.length], source: trustedSource, origin: "https://reader.localhost" },
      trustedContext,
    );
    expect(command.ok && event.ok, "trusted synthetic reader message event remains valid");
  }
});

console.log("reader-engine performance baseline passed");
