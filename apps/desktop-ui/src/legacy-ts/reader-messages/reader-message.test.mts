import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { installReaderMessageGuard } from "./reader-message.ts";
import type { ReaderMessageGuardApi } from "./reader-message.ts";

function loadClassic(target: Record<string, unknown>): ReaderMessageGuardApi {
  const source = readFileSync(new URL("../../../../../ui/generated-ts/reader-message.js", import.meta.url), "utf8");
  vm.runInNewContext(source, {
    globalThis: target,
    Object,
    Number,
    Math,
    String,
    Array,
    Set,
    JSON,
    URL,
  });
  return target.ReaderMessageGuard as ReaderMessageGuardApi;
}

function guards() {
  const classicTarget: Record<string, unknown> = {};
  const typedTarget: Record<string, unknown> = {};
  return {
    classicTarget,
    typedTarget,
    classic: loadClassic(classicTarget),
    typed: installReaderMessageGuard(typedTarget),
  };
}

test("message guard installer preserves the exact classic frozen API and action allowlist", () => {
  const { classic, typed, typedTarget } = guards();
  assert.equal(typedTarget.ReaderMessageGuard, typed);
  assert.equal(Object.isFrozen(typed), true);
  assert.deepEqual(Object.keys(typed).sort(), Object.keys(classic).sort());
  assert.deepEqual([...typed.ACTIONS].sort(), [...classic.ACTIONS].sort());
});

test("message payload acceptance matches classic for every specialized validation branch", () => {
  const { classic, typed } = guards();
  const valid = [
    { ready: true },
    { readerJump: { kind: "link", chapter: 2, chFrac: 0.5 } },
    { readerGesture: { phase: "move", x: 10, y: -20 } },
    { readerGestureSurfaceClosed: true },
    { readerPerf: "ok" },
    { bugTrace: { kind: "turn", chapter: 1, layout_fast: true } },
    { bugTrace: { kind: "footnote", chapter: 1, note_marker: true, note_virtual: true, note_link_present: true, note_fragment_present: true, note_click_consumed: true, note_popup_visible: true, note_target_chapter: 2, note_search_chapters: 8 } },
    { bugTrace: { kind: "layout", outcome: "modern_media_overlap", chapter: 1, media_count: 2, media_background_count: 1, media_table_count: 1, media_positioned_count: 1, media_visible_count: 1, media_text_overlap_count: 1, media_background_text_overlap_count: 1 } },
    { webSearch: { term: "query", engine: "google" } },
    { semanticSearch: "query" },
    { aiReader: { text: "excerpt", anchorStart: 0, anchorEnd: 7 } },
    { setHighlightColor: { index: 0, color: "g" } },
    { readerHighlightMenuPreferences: { displayMode: "both", actions: [{ key: "dict", visible: true }] } },
    { readerHighlightMenuPreferencesReady: true },
    { readerHighlightMenuSettings: { requestId: 1, settings: { layout: "row" } } },
    { translateText: { text: "x", source: "zh", target: "en", provider: "p", credentialConfigId: "id" } },
    { getTranslationCredentialStatus: "provider" },
    { saveTranslationCredential: { provider: "p", apiId: "id", apiKey: "key" } },
    { downloadImage: { name: "x.png", dataUrl: "data:image/png;base64,AA==" } },
    { pageCache: { sig: "s", pages: [0, 1, 2], complete: true } },
  ];
  const invalid = [
    null,
    {},
    [],
    { ready: true, progress: 1 },
    { readerJump: { kind: "external", chapter: 2, chFrac: 0.5 } },
    { readerGesture: { phase: "move", x: 100_001, y: 0 } },
    { readerGestureSurfaceClosed: "true" },
    { bugTrace: { secret: "no" } },
    { webSearch: { term: "query", engine: "other" } },
    { aiReader: { text: "excerpt", anchorStart: 7, anchorEnd: 2 } },
    { setHighlightColor: { index: -1, color: "x" } },
    { readerHighlightMenuPreferences: { actions: [{ key: "dict", visible: "yes" }] } },
    { readerHighlightMenuSettings: { requestId: 0, settings: { layout: "row" } } },
    { downloadImage: { name: "x", dataUrl: "data:text/plain;base64,AA==" } },
    { pageCache: { sig: "s", pages: [-1] } },
  ];
  for (const value of [...valid, ...invalid]) {
    assert.equal(typed.validateData(value), classic.validateData(value), JSON.stringify(value));
  }
  assert.ok(valid.every((value) => typed.validateData(value)));
  assert.ok(invalid.every((value) => !typed.validateData(value)));
  const circular: Record<string, unknown> = { ready: true };
  circular.self = circular;
  assert.equal(typed.validateData(circular), classic.validateData(circular));
});

test("event validation matches source, concrete origin, opaque origin, and malformed URL behavior", () => {
  const { classic, typed } = guards();
  const contentWindow = {};
  const frame = { src: "reader://localhost/book/1", contentWindow };
  const location = { href: "tauri://localhost/reader.html" };
  const events = [
    { source: contentWindow, origin: "reader://localhost", data: { ready: true } },
    { source: {}, origin: "reader://localhost", data: { ready: true } },
    { source: contentWindow, origin: "null", data: { ready: true } },
    { source: contentWindow, origin: "https://evil.example", data: { ready: true } },
    { source: contentWindow, origin: "reader://localhost", data: { ready: true, progress: 1 } },
  ];
  for (const event of events) {
    assert.equal(typed.validateEvent(event, frame, location), classic.validateEvent(event, frame, location));
    assert.deepEqual(typed.normalizeEvent(event, frame, location), classic.normalizeEvent(event, frame, location));
  }
  const malformedFrame = { src: "http://[", contentWindow };
  const event = { source: contentWindow, origin: "reader://localhost", data: { ready: true } };
  assert.equal(typed.validateEvent(event, malformedFrame, location), classic.validateEvent(event, malformedFrame, location));
});

test("v1 protocol bridge remains opt-in and normalized payload must pass the classic guard", () => {
  const contentWindow = {};
  const frame = { src: "reader://localhost/book/1", contentWindow };
  const location = { href: "tauri://localhost/reader.html" };
  const event = { source: contentWindow, origin: "reader://localhost", data: { protocol: "v1" } };
  for (const normalized of [{ progress: 20 }, { progress: 20, ready: true }, null]) {
    const bridge = {
      isReaderFrameProtocolEnvelope: () => true,
      normalizeReaderFrameProtocolEvent: () => normalized,
    };
    const classicTarget: Record<string, unknown> = { KunpengReaderProtocolBridge: bridge };
    const typedTarget: Record<string, unknown> = { KunpengReaderProtocolBridge: bridge };
    const classic = loadClassic(classicTarget);
    const typed = installReaderMessageGuard(typedTarget);
    assert.equal(typed.validateEvent(event, frame, location), classic.validateEvent(event, frame, location));
    assert.deepEqual(typed.normalizeEvent(event, frame, location), classic.normalizeEvent(event, frame, location));
  }
});
