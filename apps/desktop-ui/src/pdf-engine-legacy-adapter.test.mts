import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_RENDERER_PROTOCOL_NAME,
  PDF_RENDERER_PROTOCOL_VERSION,
  createPdfLegacyAdapter,
} from "./pdf-engine-legacy-adapter.ts";

const adapter = createPdfLegacyAdapter();
const parent = {};
(globalThis as { window?: unknown }).window = { parent };
const bootstrap = adapter.bootstrap({
  href: "http://reader.localhost/pdfview.html",
  search: "?u=http%3A%2F%2Freader.localhost%2Fpdf%2F42&p=2",
});

if (!bootstrap) throw new Error("valid test bootstrap was rejected");

test("legacy adapter turns only the trusted PDF resource endpoint into an opaque id", () => {
  assert.equal(bootstrap.documentId, "book-42");
  assert.equal(bootstrap.initialPage, 2);
  assert.equal(
    adapter.bootstrap({
      href: "tauri://localhost/pdfview.html",
      search: "?u=reader%3A%2F%2Flocalhost%2Fpdf%2F5311288778494745635&p=1",
    })?.documentId,
    "book-5311288778494745635",
  );
  assert.equal(adapter.bootstrap({ href: "http://reader.localhost/pdfview.html", search: "?u=https%3A%2F%2Fevil.invalid%2Fa.pdf" }), null);
  assert.equal(adapter.bootstrap({ href: "http://reader.localhost/pdfview.html", search: "?u=%2FUsers%2Freader%2Fa.pdf" }), null);
  assert.equal(adapter.bootstrap({ href: "http://reader.localhost/pdfview.html", search: "?u=http%3A%2F%2Freader.localhost%2Fpdf%2F42%3Fx%3D1" }), null);
  assert.equal(adapter.bootstrap({ href: "tauri://localhost/pdfview.html", search: "?u=reader%3A%2F%2Flocalhost%2Fpdf%2F123456789012345678901&p=1" }), null);
});

test("legacy controls and typed commands require the exact parent source and origin", () => {
  assert.deepEqual(adapter.normalizeIncomingMessage({ data: { zoom: "in" }, source: parent, origin: "http://reader.localhost" }, bootstrap), { zoom: "in" });
  assert.deepEqual(adapter.normalizeIncomingMessage({ data: { gotoChapter: 3, search: "历史兼容" }, source: parent, origin: "http://reader.localhost" }, bootstrap), { gotoChapter: 3, search: "历史兼容" });
  assert.deepEqual(adapter.normalizeIncomingMessage({ data: { overlayOpen: 1 }, source: parent, origin: "http://reader.localhost" }, bootstrap), { overlayOpen: 1 });
  assert.equal(adapter.normalizeIncomingMessage({ data: { url: "https://evil.invalid" }, source: parent, origin: "http://reader.localhost" }, bootstrap), null);
  assert.equal(adapter.normalizeIncomingMessage({ data: { zoom: "in" }, source: {}, origin: "http://reader.localhost" }, bootstrap), null);
  assert.equal(adapter.normalizeIncomingMessage({ data: { zoom: "in" }, source: parent, origin: "https://evil.invalid" }, bootstrap), null);
  assert.deepEqual(adapter.normalizeIncomingMessage({
    data: {
      protocol: PDF_RENDERER_PROTOCOL_NAME,
      version: PDF_RENDERER_PROTOCOL_VERSION,
      action: "close-document",
      payload: { documentId: bootstrap.documentId },
    },
    source: parent,
    origin: "http://reader.localhost",
  }, bootstrap), {
    protocol: PDF_RENDERER_PROTOCOL_NAME,
    version: PDF_RENDERER_PROTOCOL_VERSION,
    action: "close-document",
    payload: { documentId: bootstrap.documentId },
  });
});

test("session cancellation destroys loading and rendering work exactly once", async () => {
  const session = adapter.createSession(bootstrap);
  let destroyed = 0;
  let cancelled = 0;
  session.trackLoadingTask({ destroy: () => { destroyed += 1; } });
  session.trackRenderTask({ cancel: () => { cancelled += 1; } });
  await session.dispose();
  await session.dispose();
  assert.equal(session.signal.aborted, true);
  assert.equal(destroyed, 1);
  assert.equal(cancelled, 1);
});

test("outbound compatibility messages use a fixed origin and reject oversized payloads", () => {
  const calls: Array<{ readonly payload: unknown; readonly origin: string }> = [];
  const target = { postMessage(payload: unknown, origin: string): void { calls.push({ payload, origin }); } };
  assert.equal(adapter.postLegacyEvent(target, bootstrap, { ready: 1 }), true);
  assert.deepEqual(calls, [{ payload: { ready: 1 }, origin: "http://reader.localhost" }]);
  assert.equal(adapter.postLegacyEvent(target, bootstrap, { padding: "x".repeat(20_000) }), false);
});
