import assert from "node:assert/strict";
import test from "node:test";

import { installReaderPageRuntime, type ReaderPageRuntime } from "./reader-page-runtime.ts";

function runtime(options: { readonly referrer?: string; readonly url?: string } = {}): { target: ReaderPageRuntime; messages: Record<string, unknown>[]; listeners: Record<string, EventListener>; timeouts: Array<() => void> } {
  const messages: Record<string, unknown>[] = [];
  const listeners: Record<string, EventListener> = {};
  const timeouts: Array<() => void> = [];
  const document = {
    readyState: "complete",
    referrer: options.referrer ?? "tauri://localhost/reader.html",
    URL: options.url ?? "reader://localhost/book/1",
    documentElement: { lang: "zh-CN" },
    addEventListener: () => undefined,
    getElementById: () => null,
    createElement: () => ({ id: "", style: {}, isConnected: true }),
    body: { appendChild: () => undefined },
    fonts: { ready: Promise.resolve() },
  } as unknown as Document;
  const target: ReaderPageRuntime = {
    document,
    window: {
      innerWidth: 1_000,
      ReaderHighlightMenuSettings: { get: () => ({}), update: () => ({}), activate: () => ({}) },
      addEventListener: (type, listener) => { listeners[type] = listener as EventListener; },
    },
    parent: { postMessage: (message) => messages.push(message) },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    Highlight: class {} as unknown as new (range: Range) => Highlight,
    Audio: class {} as unknown as typeof Audio,
    SpeechSynthesisUtterance: class {} as unknown as typeof SpeechSynthesisUtterance,
    requestAnimationFrame: (callback) => { callback(0); return 1; },
    cancelAnimationFrame: () => undefined,
    setTimeout: (callback) => { timeouts.push(callback); return 1 as unknown as ReturnType<typeof setTimeout>; },
    S: { uiLanguage: "zh-CN", flowMode: "paged", pageMode: "single", imagePagination: "next-page" },
    setViewOffset: () => undefined,
    init: () => undefined,
    isScrollMode: () => false,
    isDualPage: () => false,
    pageCountSig: () => "one",
    scheduleMeasure: () => undefined,
    applyPageCache: (value: unknown) => messages.push({ applied: value }),
    report: () => undefined,
    root: null,
    pager: null,
  };
  return { target, messages, listeners, timeouts };
}

test("installer freezes and restores the classic runtime API", () => {
  const { target } = runtime();
  const api = installReaderPageRuntime(target);
  assert.equal(Object.isFrozen(api), true);
  for (const key of Object.keys(api)) assert.equal(target[key], api[key]);
  assert.equal(Object.keys(api).length, 43);
  assert.equal(typeof target.ttsStart, "function");
  assert.equal(typeof target.refreshPagedImagePreview, "function");
  assert.equal(typeof target.probeNextPagedImage, "function");
  assert.equal(typeof target.immediatePagedImageAfterVisibleText, "function");
  assert.equal(typeof target.baseSetViewOffset, "function");
  assert.equal(Object.isFrozen(target.TTS_AUTO_VOICES), true);
});

test("language selection preserves script and latin heuristics", () => {
  const { target } = runtime();
  const api = installReaderPageRuntime(target);
  assert.equal(api.ttsLanguageForText("這個國家"), "zh-TW");
  assert.equal(api.ttsLanguageForText("안녕하세요"), "ko");
  assert.equal(api.ttsLanguageForText("こんにちは"), "ja");
  assert.equal(api.ttsLatinLanguage("bonjour avec vous"), "fr");
  assert.equal(api.ttsVoiceForText("hello and thanks"), "en-US-JennyNeural");
});

test("queued mode input applies once and retains replay state", () => {
  const { target, messages, timeouts } = runtime();
  const api = installReaderPageRuntime(target);
  target.pendingReaderModeSettings = { flowMode: "scroll" };
  assert.equal(api.queuePendingReaderModeInput({ deltaY: 1 }), true);
  assert.equal(target.pendingReaderModeApplying, true);
  assert.deepEqual(target.pendingReaderModeReplay, { deltaY: 1 });
  assert.equal(messages.length, 0);
  assert.equal(timeouts.length, 2);
  assert.equal(api.queuePendingReaderModeInput({ deltaY: 2 }), false);
});

test("message router keeps page-cache, overlay, navigation and TTS stop commands", () => {
  const { target, messages, listeners } = runtime();
  installReaderPageRuntime(target);
  listeners.message?.({ source: target.parent, origin: "tauri://localhost", data: { overlayOpen: true, pageCache: { key: 1 }, vchaps: [{ ch: 1 }] } } as MessageEvent);
  assert.equal(target.overlayOpen, true);
  assert.deepEqual(target.VC, [{ ch: 1 }]);
  assert.deepEqual(messages.find((message) => "applied" in message), { applied: { key: 1 } });
  target.ttsOn = true;
  target.ttsGen = 4;
  target.ttsCache = {};
  listeners.message?.({ source: target.parent, origin: "tauri://localhost", data: { tts: "stop" } } as MessageEvent);
  assert.equal(target.ttsOn, false);
  assert.equal(target.ttsGen, 5);
  assert.deepEqual(messages.at(-1), { ttsState: 0 });
});

test("message router accepts only the reader shell and its concrete origin", () => {
  const { target, listeners } = runtime();
  installReaderPageRuntime(target);
  const receive = listeners.message;
  receive?.({ source: {}, origin: "tauri://localhost", data: { overlayOpen: true } } as MessageEvent);
  assert.equal(target.overlayOpen, undefined);
  receive?.({ source: target.parent, origin: "https://evil.example", data: { overlayOpen: true } } as MessageEvent);
  assert.equal(target.overlayOpen, undefined);
  receive?.({ source: target.parent, origin: "tauri://localhost", data: { overlayOpen: true } } as MessageEvent);
  assert.equal(target.overlayOpen, true);
});

test("same-book resume accepts only a bounded numeric anchor from the trusted shell", () => {
  const { target, listeners } = runtime();
  const restores: unknown[] = [];
  target.scheduleSameBookResumeRestore = (request: unknown) => restores.push(request);
  installReaderPageRuntime(target);

  listeners.message?.({
    source: target.parent,
    origin: "tauri://localhost",
    data: { sameBookResume: { chapter: 7, anchor: { text_offset: 92_341, viewport_offset: 18.4, context_after: "正文不得转发" } } },
  } as MessageEvent);
  listeners.message?.({
    source: target.parent,
    origin: "tauri://localhost",
    data: { sameBookResume: { chapter: 7, anchor: { text_offset: -1, viewport_offset: 0 } } },
  } as MessageEvent);

  assert.deepEqual(restores, [{ chapter: 7, anchor: { text_offset: 92_341, viewport_offset: 18 } }]);
});

test("Windows reader page accepts the paired Tauri host when no-referrer omits the shell URL", () => {
  const { target, listeners } = runtime({ referrer: "", url: "http://reader.localhost/book/1" });
  const relayouts: unknown[] = [];
  const traces: unknown[][] = [];
  target.anchorValid = () => false;
  target.topAnchor = () => null;
  target.anchorTextOffset = () => null;
  target.captureImageVisualAnchor = () => null;
  target.relayout = (options: unknown) => { relayouts.push(options); return null; };
  target.invalidateMeasure = () => undefined;
  target.scheduleImageVisualAnchorRestore = () => undefined;
  target.readerBugTrace = (...args: unknown[]) => { traces.push(args); };
  installReaderPageRuntime(target);
  const settings = { theme: "dark", fontSize: 32, flowMode: "paged", pageMode: "dual" };
  listeners.message?.({ source: target.parent, origin: "https://evil.example", data: { settings } } as MessageEvent);
  listeners.message?.({ source: {}, origin: "http://tauri.localhost", data: { settings } } as MessageEvent);
  assert.equal(target.S.theme, undefined);
  listeners.message?.({
    source: target.parent,
    origin: "http://tauri.localhost",
    data: { settings },
  } as MessageEvent);
  assert.equal(target.S.theme, "dark");
  assert.equal(target.S.fontSize, 32);
  assert.equal(target.S.pageMode, "dual");
  assert.equal(relayouts.length, 1);
  assert.deepEqual(traces, [["settings", "applied", null]]);
});

test("a same-flow settings replay keeps active scroll paging and its partial-line mask", () => {
  const { target, listeners } = runtime();
  const style = { clipPath: "inset(12px 0px 9px 0px)", setProperty: () => undefined };
  target.S = { ...target.S, flowMode: "scroll", pageMode: "single", theme: "light" };
  target.scrollPagedView = true;
  target.scroller = { style } as unknown as HTMLElement;
  target.anchorValid = () => false;
  target.topAnchor = () => null;
  target.anchorTextOffset = () => null;
  target.captureImageVisualAnchor = () => null;
  target.relayout = () => null;
  target.invalidateMeasure = () => undefined;
  target.isScrollMode = () => true;
  installReaderPageRuntime(target);

  listeners.message?.({
    source: target.parent,
    origin: "tauri://localhost",
    data: { settings: { ...target.S, theme: "dark" } },
  } as MessageEvent);

  assert.equal(target.scrollPagedView, true);
  assert.equal(style.clipPath, "inset(12px 0px 9px 0px)");
});

test("switch snapshot bounds an unfinished chapter turn and reports the latest stable anchor", () => {
  const { target, listeners } = runtime();
  const calls: unknown[][] = [];
  target.chapterTurnPending = true;
  target.captureAnchor = () => undefined;
  target.report = (...args: unknown[]) => calls.push(args);
  installReaderPageRuntime(target);
  listeners.message?.({
    source: target.parent,
    origin: "tauri://localhost",
    data: { positionSnapshotRequest: 19, positionSnapshotTurnWaitMs: 0 },
  } as MessageEvent);
  assert.deepEqual(calls, [[false, false, 19]]);
});

test("continuous-image primitives preserve exact page and free-height arithmetic", () => {
  const { target } = runtime();
  target.mg = (value: unknown) => Number(value) || 0;
  target.viewportHeight = () => 800;
  target.pagedBoxHeight = () => 800;
  target.S.marginTop = 20;
  target.S.marginBottom = 30;
  const api = installReaderPageRuntime(target);
  assert.equal(api.pagedImageSourcePage({ left: 1_201 }, { left: 0 }, 1_200), 1);
  assert.equal(api.pagedTextLineBottomOnPage({ bottom: 200, left: 1_210 }, { left: 0 }, 1_200, 1), 200);
  assert.deepEqual(api.pagedImageFreeHeight([{ bottom: 200, left: 10 }], { left: 0 }, 1_200, 0, { height: 800 }), { last: 200, free: 564 });
  assert.equal(api.hasPagedTextBeforeMedia([{ bottom: 200, left: 1_210 }], { left: 0 }, 1_200, 1, 210), true);
});
