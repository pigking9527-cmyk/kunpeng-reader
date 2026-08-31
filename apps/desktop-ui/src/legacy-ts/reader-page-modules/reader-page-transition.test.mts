import assert from "node:assert/strict";
import test from "node:test";

import {
  installReaderPageTransition,
  type ReaderPageTransitionRuntime,
} from "./reader-page-transition.ts";

class Classes {
  public readonly values = new Set<string>();
  public add(...names: string[]): void { names.forEach((name) => this.values.add(name)); }
  public remove(...names: string[]): void { names.forEach((name) => this.values.delete(name)); }
  public contains(name: string): boolean { return this.values.has(name); }
}

class ElementFixture {
  public readonly classList = new Classes();
  public readonly children: ElementFixture[] = [];
  public readonly style = {
    bottom: "", height: "", top: "", transform: "", width: "", display: "",
    position: "", inset: "", pointerEvents: "", zIndex: "",
    setProperty: (name: string, value: string) => { this.properties[name] = value; },
  };
  public readonly properties: Record<string, string> = {};
  public className = "";
  public id = "";
  private html = "";
  public get innerHTML(): string { return this.html; }
  public set innerHTML(value: string) { this.html = value; if (value === "") this.children.length = 0; }
  public get lastElementChild(): ElementFixture | null { return this.children.at(-1) ?? null; }
  public isConnected = true;
  public clientHeight = 600;
  public scrollHeight = 800;
  public scrollWidth = 700;
  public scrollTop = 20;
  public offsetWidth = 700;
  public appendChild(child: ElementFixture): ElementFixture { this.children.push(child); return child; }
  public cloneNode(deep = false): ElementFixture {
    const clone = new ElementFixture();
    clone.className = this.className;
    clone.id = this.id;
    for (const name of this.classList.values) clone.classList.add(name);
    Object.assign(clone.style, this.style);
    clone.style.transform = this.style.transform;
    clone.scrollWidth = this.scrollWidth;
    clone.scrollHeight = this.scrollHeight;
    if (deep) this.children.forEach((child) => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
  public removeAttribute(name: string): void { if (name === "id") this.id = ""; }
  public getBoundingClientRect(): DOMRect {
    return { left: 0, top: 0, right: 700, bottom: 600, width: 700, height: 600, x: 0, y: 0, toJSON: () => ({}) };
  }
}

function harness(settings: Record<string, unknown> = {}, isMacWebKit = false) {
  const pager = new ElementFixture();
  const root = new ElementFixture();
  const port = new ElementFixture();
  const virtualPage = new ElementFixture();
  const elements = new Map<string, ElementFixture>();
  const messages: Record<string, unknown>[] = [];
  const timers: Array<{ callback: () => void; delay: number }> = [];
  let now = 12;
  const runtime = {
    localStorage: { getItem: () => null },
    document: {
      getElementById: (id: string) => elements.get(id) ?? null,
      createElement: () => new ElementFixture(),
    },
    window: { innerHeight: 600, innerWidth: 900 },
    parent: { postMessage: (message: Record<string, unknown>) => messages.push(message) },
    performance: { now: () => now },
    requestAnimationFrame: (callback: FrameRequestCallback) => { callback(now); return 1; },
    setTimeout: (callback: () => void, delay = 0) => { timers.push({ callback, delay }); return timers.length; },
    clearTimeout: () => undefined,
    S: { pageTurnEffect: "horizontal", pageTurnSpeed: 1, theme: "light", ...settings },
    pager,
    root,
    scroller: port,
    virtualPage,
    curCh: 0,
    pageInCh: 0,
    pagesInCh: 1,
    viewOffset: 0,
    IS_MAC_WEBKIT: isMacWebKit,
    isScrollMode: () => false,
    currentScrollPageClipBlank: () => 0,
    lineHeightPx: () => 20,
    viewportHeight: () => 600,
    sourceTextAround: () => "  sample   text  ",
    anchorRect: () => root.getBoundingClientRect(),
    topAnchor: () => null,
    anchorTextOffset: () => null,
    sourceAnchorRangeForOffset: () => null,
  } as unknown as ReaderPageTransitionRuntime;
  return { runtime, api: installReaderPageTransition(runtime), pager, root, port, virtualPage, messages, timers, setNow: (value: number) => { now = value; } };
}

test("installer exposes the original transition globals and initial shared state", () => {
  const { runtime, api } = harness();
  assert.equal(Object.isFrozen(api), true);
  for (const name of Object.keys(api)) assert.equal(runtime[name], api[name as keyof typeof api]);
  assert.equal(runtime.turnFxTimer, null);
  assert.equal(runtime.turnFxSheet, null);
  assert.equal(runtime.chapterTurnPending, false);
  assert.equal(runtime.fastChapterLayout, false);
  assert.equal(runtime.FAST_CHAPTER_LAYOUT_CHARS, 120 * 1024);
  assert.equal(runtime.modeSwitchDiagSeq, 0);
});

test("debug settings, durations, themes and chapter threshold retain classic bounds", () => {
  const view = harness({ pageTurnSpeed: "bad", pageTurnEffect: "other", theme: "dark" });
  assert.equal(view.api.pageDebugSettingOn("reader"), true);
  assert.equal(view.api.turnFxName(), "horizontal");
  assert.equal(view.api.turnFxSpeed(), 1);
  assert.equal(view.api.turnFxDuration(20), 80);
  assert.equal(view.api.turnFxBg(), "#1c1c1e");
  assert.equal(view.api.largeChapterFastLayout("x".repeat(120 * 1024 - 1)), false);
  assert.equal(view.api.largeChapterFastLayout("x".repeat(120 * 1024)), true);
  assert.equal(view.api.scrollGlyphSafePx(), 4);
  assert.equal(view.api.scrollBottomSafePx(), 4);
  assert.equal(view.api.scrollStartEpsilonPx(), 16);
});

test("macOS uses fast whole-chapter boundaries for modest compatibility chapters", () => {
  const view = harness({}, true);
  assert.equal(view.runtime.FAST_CHAPTER_LAYOUT_CHARS, 1 * 1024);
  assert.equal(view.api.largeChapterFastLayout("x".repeat(1 * 1024 - 1)), false);
  assert.equal(view.api.largeChapterFastLayout("x".repeat(1 * 1024)), true);
});

test("same-chapter transition keeps outgoing and incoming clones until its bounded timer", () => {
  const view = harness();
  let moved = 0;
  view.api.beginTurnFx(1, () => { moved += 1; });
  assert.equal(moved, 1);
  assert.equal(view.runtime.turnFxSheet instanceof ElementFixture, true);
  const sheet = view.runtime.turnFxSheet as unknown as ElementFixture;
  assert.equal(sheet.children.length, 2);
  assert.equal(sheet.children[0]?.className, "turn-fx-page turn-fx-outgoing");
  assert.equal(sheet.children[1]?.className, "turn-fx-page turn-fx-incoming");
  assert.equal(view.pager.classList.contains("turn-fx-next"), true);
  assert.equal(sheet.properties["--turn-fx-duration"], "360ms");
  assert.equal(view.timers.at(-1)?.delay, 400);
});

test("disabled animation moves immediately without creating a second visible surface", () => {
  const view = harness({ pageTurnEffect: "off" });
  let moved = 0;
  view.api.beginTurnFx(-1, () => { moved += 1; });
  assert.equal(moved, 1);
  assert.equal(view.runtime.turnFxSheet, null);
  assert.equal(view.pager.classList.values.size, 0);
});

test("compatible scroll chapter hold snapshots the visible virtual page instead of raw flow", async () => {
  const view = harness({ pageTurnEffect: "off" });
  view.runtime.isScrollMode = () => true;
  view.virtualPage.style.display = "block";
  view.virtualPage.className = "visible-page-sentinel";
  view.virtualPage.appendChild(new ElementFixture());
  let releaseChapter: (() => void) | undefined;
  view.runtime.showChapter = () => new Promise<void>((resolve) => { releaseChapter = resolve; });

  const transition = view.api.beginChapterTurnFx(-1, 1, "end");

  const sheet = view.runtime.turnFxSheet as unknown as ElementFixture;
  const page = sheet.children.at(-1);
  const clone = page?.children[0];
  assert.equal(clone?.className, "visible-page-sentinel");
  assert.equal(clone?.classList.contains("turn-fx-virtual-page"), true);
  assert.equal(clone?.id, "virtual-page");
  assert.equal(page?.style.height, "600px");
  assert.equal(clone?.style.top, "0");
  assert.ok(releaseChapter);
  releaseChapter();
  await transition;
});

test("compatible chapter paging retains the old page until the real chapter layout completes", async () => {
  const view = harness({ pageTurnEffect: "off" });
  view.runtime.isScrollMode = () => true;
  let releaseChapter: (() => void) | undefined;
  view.runtime.showChapter = () => new Promise<void>((resolve) => { releaseChapter = resolve; });

  const transition = view.api.beginChapterTurnFx(1, 1, "start");
  const sheet = view.runtime.turnFxSheet as unknown as ElementFixture;
  assert.equal(sheet.children.length, 1);
  assert.equal(sheet.children.at(-1)?.className, "turn-fx-page turn-fx-outgoing");
  assert.equal(view.pager.classList.contains("turn-fx-hold"), true);
  assert.ok(releaseChapter);
  releaseChapter();
  await transition;
});

test("chapter transitions retain only the final queued direction after a successful turn", async () => {
  const view = harness({ pageTurnEffect: "off" });
  const calls: Array<{ chapter: number; where: unknown }> = [];
  const gate: { release?: () => void } = {};
  let replayedDirection = 0;
  view.runtime.replayQueuedChapterTurn = (direction: number) => { replayedDirection = direction; };
  view.runtime.showChapter = async (chapter: number, where: unknown) => {
    calls.push({ chapter, where });
    if (calls.length === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
  };
  const first = view.api.beginChapterTurnFx(1, 1, "start");
  const second = view.api.beginChapterTurnFx(-1, 0, "end");
  const third = view.api.beginChapterTurnFx(1, 2, "after-dual-continuation");
  assert.equal(view.runtime.chapterTurnPending, true);
  assert.deepEqual(calls, [{ chapter: 1, where: "start" }]);
  await second;
  await third;
  assert.equal(view.runtime.pendingChapterTurnDirection, 1);
  assert.ok(gate.release);
  gate.release();
  await first;
  assert.deepEqual(calls, [{ chapter: 1, where: "start" }]);
  assert.equal(replayedDirection, 1);
  assert.equal(view.runtime.chapterTurnPending, false);
  assert.equal(view.runtime.pendingChapterTurnDirection, 0);
});

test("failed chapter turns clear queued input instead of replaying stale navigation", async () => {
  const view = harness({ pageTurnEffect: "off" });
  const gate: { reject?: (error: Error) => void } = {};
  let calls = 0;
  view.runtime.showChapter = async () => {
    calls += 1;
    await new Promise<void>((_resolve, reject) => { gate.reject = reject; });
  };
  let replayed = false;
  view.runtime.replayQueuedChapterTurn = () => { replayed = true; };
  const first = view.api.beginChapterTurnFx(1, 1, "start");
  await view.api.beginChapterTurnFx(-1, 0, "end");
  assert.ok(gate.reject);
  gate.reject(new Error("chapter unavailable"));
  await assert.rejects(first);
  assert.equal(calls, 1);
  assert.equal(replayed, false);
  assert.equal(view.runtime.chapterTurnPending, false);
  assert.equal(view.runtime.pendingChapterTurnDirection, 0);
});

test("paint and mode diagnostics preserve redacted message envelopes and schedule", () => {
  const view = harness();
  view.setNow(42);
  view.api.userNav();
  view.api.reportReaderPaintPerf("paint", 40, "chapter=1");
  const sequence = view.api.modeSwitchDiagBegin("scroll", "paged", "single", "dual", 9, 7);
  view.api.modeSwitchDiagSchedule(sequence, 9);
  assert.equal(sequence, 1);
  assert.deepEqual(view.timers.slice(-3).map(({ delay }) => delay), [80, 250, 800]);
  assert.equal(view.messages[0]?.userNav, 1);
  assert.match(String(view.messages[1]?.readerPerf), /^paint elapsed_ms=2\.0 chapter=1$/u);
  const diagnostic = String(view.messages[2]?.readerPerf);
  assert.match(diagnostic, /^mode_diag /u);
  assert.match(diagnostic, /"expectedText":" sample text "/u);
  assert.doesNotMatch(diagnostic, /credential|localStorage|innerHTML/iu);
});
