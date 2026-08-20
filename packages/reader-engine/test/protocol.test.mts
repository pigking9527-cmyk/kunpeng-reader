import {
  DEFAULT_MAX_READER_MESSAGE_BYTES,
  READER_PROTOCOL_NAME,
  READER_PROTOCOL_VERSION,
  parseReaderFrameEvent,
  parseReaderShellCommand,
  validateReaderFrameEvent,
  validateReaderShellCommandEvent,
} from "../src/index.js";

function expect(condition: unknown, description: string): asserts condition {
  if (!condition) throw new Error(description);
}

const trustedSource = {};
const trustedContext = {
  expectedSource: trustedSource,
  allowedOrigins: ["https://reader.localhost", "tauri://localhost"],
} as const;

const readyEvent = {
  protocol: READER_PROTOCOL_NAME,
  version: READER_PROTOCOL_VERSION,
  action: "ready",
  payload: { engine: "epub" },
} as const;

const command = {
  protocol: READER_PROTOCOL_NAME,
  version: READER_PROTOCOL_VERSION,
  action: "turn-page",
  payload: { direction: "forward" },
} as const;

expect(parseReaderFrameEvent(readyEvent).ok, "accepts a valid synthetic reader frame event");
expect(parseReaderShellCommand(command).ok, "accepts a valid synthetic shell command");

const acceptedFrame = validateReaderFrameEvent(
  { data: readyEvent, source: trustedSource, origin: "https://reader.localhost" },
  trustedContext,
);
expect(acceptedFrame.ok && acceptedFrame.value.action === "ready", "accepts a known event from the expected frame");

const acceptedCommand = validateReaderShellCommandEvent(
  { data: command, source: trustedSource, origin: "tauri://localhost" },
  trustedContext,
);
expect(acceptedCommand.ok && acceptedCommand.value.action === "turn-page", "accepts explicit custom-scheme origin");

const forgedSource = validateReaderFrameEvent(
  { data: readyEvent, source: {}, origin: "https://reader.localhost" },
  trustedContext,
);
expect(!forgedSource.ok && forgedSource.error === "untrusted-source", "rejects a forged source");

const forgedOrigin = validateReaderFrameEvent(
  { data: readyEvent, source: trustedSource, origin: "https://evil.invalid" },
  trustedContext,
);
expect(!forgedOrigin.ok && forgedOrigin.error === "untrusted-origin", "rejects a forged origin");

const unknownVersion = parseReaderFrameEvent({ ...readyEvent, version: 999 });
expect(!unknownVersion.ok && unknownVersion.error === "unknown-version", "rejects an unknown protocol version");

const unknownAction = parseReaderShellCommand({ ...command, action: "erase-library" });
expect(!unknownAction.ok && unknownAction.error === "unknown-action", "rejects an unknown action");

const oversizedMessage = parseReaderFrameEvent(
  { ...readyEvent, payload: { engine: "epub", padding: "x".repeat(DEFAULT_MAX_READER_MESSAGE_BYTES) } },
);
expect(!oversizedMessage.ok && oversizedMessage.error === "message-too-large", "rejects an oversized payload before parsing it");

console.log("reader-engine protocol tests passed");
