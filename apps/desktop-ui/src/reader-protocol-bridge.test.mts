import assert from "node:assert/strict";
import test from "node:test";
import {
  READER_FRAME_PROTOCOL_FEATURE_KEY,
  isReaderFrameProtocolEnvelope,
  normalizeReaderFrameProtocolEvent,
} from "./reader-protocol-bridge.ts";
import { READER_PROTOCOL_NAME, READER_PROTOCOL_VERSION } from "../../../packages/reader-engine/src/index.ts";

const source = {};
const frame = { src: "https://reader.localhost/book/7", contentWindow: source };
const hostLocation = { href: "https://reader.localhost/reader.html" };

function frameEvent(data: unknown, overrides: Record<string, unknown> = {}) {
  return {
    data,
    source,
    origin: "https://reader.localhost",
    ...overrides,
  };
}

test("typed reader events are opt-in and translate only after parser validation", () => {
  const event = frameEvent({
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "progress",
    payload: { chapter: 4, totalChapters: 8, progress: 62.5, page: 3 },
  });
  assert.equal(normalizeReaderFrameProtocolEvent(event, frame, hostLocation, false), null);
  assert.deepEqual(normalizeReaderFrameProtocolEvent(event, frame, hostLocation, true), {
    progress: 62.5,
    chapter: 4,
    chFrac: 0.625,
    totalCh: 8,
    page: 3,
  });
  assert.equal(isReaderFrameProtocolEnvelope(event.data), true);
  assert.equal(isReaderFrameProtocolEnvelope({ ready: 1 }), false);
  assert.equal(READER_FRAME_PROTOCOL_FEATURE_KEY, "kunpeng.feature.reader-frame-protocol.enabled");
});

test("typed reader events reject forged sources, origins, unknown versions, and oversized bodies", () => {
  const ready = {
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "ready",
    payload: { engine: "epub" },
  };
  assert.equal(normalizeReaderFrameProtocolEvent(frameEvent(ready, { source: {} }), frame, hostLocation, true), null);
  assert.equal(normalizeReaderFrameProtocolEvent(frameEvent(ready, { origin: "https://evil.invalid" }), frame, hostLocation, true), null);
  assert.equal(normalizeReaderFrameProtocolEvent(frameEvent({ ...ready, version: 99 }), frame, hostLocation, true), null);
  assert.equal(normalizeReaderFrameProtocolEvent(frameEvent({
    ...ready,
    payload: { engine: "epub", padding: "x".repeat(64 * 1024) },
  }), frame, hostLocation, true), null);
});

test("selection actions preserve legacy handlers without inventing annotation geometry", () => {
  const dictionary = frameEvent({
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "selection-action",
    payload: { intent: "dictionary", text: "reader" },
  });
  assert.deepEqual(normalizeReaderFrameProtocolEvent(dictionary, frame, hostLocation, true), { dict: "reader" });
  const annotate = frameEvent({
    protocol: READER_PROTOCOL_NAME,
    version: READER_PROTOCOL_VERSION,
    action: "selection-action",
    payload: { intent: "annotate", text: "reader" },
  });
  assert.equal(normalizeReaderFrameProtocolEvent(annotate, frame, hostLocation, true), null);
});
