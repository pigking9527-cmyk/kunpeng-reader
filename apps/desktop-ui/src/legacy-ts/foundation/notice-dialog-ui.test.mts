import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { installDialogUi, type AppDialogApi } from "./dialog-ui.ts";
import { installNoticeUi, type AppNoticeApi } from "./notice-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(fileName: string): string {
  try {
    return readFileSync(new URL(`ui/generated-ts/${fileName}`, repositoryRoot), "utf8");
  } catch {
    return execFileSync("git", ["show", `HEAD:ui/generated-ts/${fileName}`], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
}

class FakeClassList {
  public constructor(private readonly element: FakeElement) {}

  public add(...values: string[]): void {
    const classes = this.values();
    for (const value of values) classes.add(value);
    this.write(classes);
  }

  public remove(...values: string[]): void {
    const classes = this.values();
    for (const value of values) classes.delete(value);
    this.write(classes);
  }

  public contains(value: string): boolean {
    return this.values().has(value);
  }

  public toggle(value: string, force?: boolean): boolean {
    const classes = this.values();
    const enabled = force ?? !classes.has(value);
    if (enabled) classes.add(value);
    else classes.delete(value);
    this.write(classes);
    return enabled;
  }

  private values(): Set<string> {
    return new Set(this.element.className.split(/\s+/u).filter(Boolean));
  }

  private write(values: Set<string>): void {
    this.element.className = [...values].join(" ");
  }
}

interface FakeEvent {
  readonly target: FakeElement;
  readonly key?: string;
  preventDefault(): void;
}

class FakeElement {
  public className = "";
  public readonly classList = new FakeClassList(this);
  public readonly dataset: Record<string, string> = {};
  public readonly attributes = new Map<string, string>();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
  public readonly styles = new Map<string, string>();
  public hidden = false;
  public id = "";
  public textContent = "";
  public type = "";
  public offsetWidth = 320;
  public focusCount = 0;

  public constructor(
    public readonly tagName: string,
    private readonly focusHandler: (element: FakeElement) => void,
  ) {}

  public get style(): { setProperty(name: string, value: string): void } {
    return { setProperty: (name, value) => this.styles.set(name, value) };
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  public fire(type: string, target: FakeElement = this): { readonly prevented: boolean } {
    let prevented = false;
    const event: FakeEvent = {
      target,
      preventDefault: () => {
        prevented = true;
      },
    };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
    return { prevented };
  }

  public focus(): void {
    this.focusCount += 1;
    this.focusHandler(this);
  }
}

interface PendingTimer {
  readonly callback: () => void;
  readonly milliseconds: number;
  cancelled: boolean;
}

function fixture() {
  let activeElement: FakeElement | null = null;
  const body = new FakeElement("body", (element) => {
    activeElement = element;
  });
  const frames: Array<() => void> = [];
  const timers = new Map<number, PendingTimer>();
  const keydownListeners: Array<(event: FakeEvent) => void> = [];
  let nextTimer = 1;
  const document = {
    body,
    get activeElement() {
      return activeElement;
    },
    createElement: (tagName: string) =>
      new FakeElement(tagName, (element) => {
        activeElement = element;
      }),
  };
  const target: Record<string, unknown> = {
    document,
    clearTimeout: (timer: number) => {
      const pending = timers.get(timer);
      if (pending) pending.cancelled = true;
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      const timer = nextTimer;
      nextTimer += 1;
      timers.set(timer, { callback, milliseconds, cancelled: false });
      return timer;
    },
    requestAnimationFrame: (callback: () => void) => {
      frames.push(callback);
      return frames.length;
    },
    addEventListener: (type: string, listener: (event: FakeEvent) => void) => {
      if (type === "keydown") keydownListeners.push(listener);
    },
  };
  target.window = target;
  target.globalThis = target;
  return {
    target,
    body,
    frames,
    timers,
    keydownListeners,
    setActiveElement: (element: FakeElement | null) => {
      activeElement = element;
    },
  };
}

function elementSnapshot(element: FakeElement): unknown {
  return {
    tag: element.tagName,
    className: element.className,
    dataset: { ...element.dataset },
    attributes: Object.fromEntries(element.attributes),
    hidden: element.hidden,
    id: element.id,
    textContent: element.textContent,
    type: element.type,
    styles: Object.fromEntries(element.styles),
    focusCount: element.focusCount,
    children: element.children.map(elementSnapshot),
  };
}

function runFrames(frames: Array<() => void>): void {
  frames.splice(0).forEach((callback) => callback());
}

function runLatestTimer(timers: Map<number, PendingTimer>): void {
  const pending = [...timers.values()].at(-1);
  if (pending && !pending.cancelled) pending.callback();
}

function exerciseNotice(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource("notice-ui.js"), view.target);
  else installNoticeUi(view.target);
  const api = view.target.AppNotice as AppNoticeApi;
  const lazyChildren = view.body.children.length;
  let actions = 0;
  api.show("已保存", {
    actionLabel: "撤销",
    duration: 100,
    onAction: () => {
      actions += 1;
    },
  });
  runFrames(view.frames);
  const actionNotice = elementSnapshot(view.body.children[0] as FakeElement);
  const firstDelay = [...view.timers.values()].at(-1)?.milliseconds;
  view.body.children[0]?.children[1]?.fire("click");
  const actionResult = {
    actions,
    shown: view.body.children[0]?.classList.contains("show"),
  };
  api.show(0, { variant: "text", duration: "invalid" });
  runFrames(view.frames);
  const textNotice = elementSnapshot(view.body.children[0] as FakeElement);
  const secondDelay = [...view.timers.values()].at(-1)?.milliseconds;
  runLatestTimer(view.timers);
  return {
    lazyChildren,
    apiKeys: Object.keys(api).sort(),
    frozen: Object.isFrozen(api),
    childCount: view.body.children.length,
    firstDelay,
    secondDelay,
    actionNotice,
    actionResult,
    textNotice,
    shownAfterTimer: view.body.children[0]?.classList.contains("show"),
  };
}

test("notice strict installer is VM-equivalent to the original classic script", () => {
  assert.equal(JSON.stringify(exerciseNotice(false)), JSON.stringify(exerciseNotice(true)));
});

test("notice preserves original DOM contract, defaults and minimum duration", () => {
  const result = exerciseNotice(false);
  assert.equal(result.lazyChildren, 0);
  assert.equal(result.childCount, 1);
  assert.equal(result.firstDelay, 300);
  assert.equal(result.secondDelay, 3_600);
  assert.deepEqual(result.apiKeys, ["hide", "show"]);
  assert.equal(result.frozen, true);
  assert.deepEqual(result.actionResult, { actions: 1, shown: false });
  const textNotice = result.textNotice as {
    readonly className: string;
    readonly children: ReadonlyArray<{ readonly hidden: boolean; readonly textContent: string }>;
  };
  assert.equal(textNotice.className, "app-notice text-only show");
  assert.deepEqual(textNotice.children.map(({ hidden }) => hidden), [false, true, true]);
  assert.equal(textNotice.children[0]?.textContent, "");
  assert.equal(result.shownAfterTimer, false);
});

async function exerciseDialog(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource("dialog-ui.js"), view.target);
  else installDialogUi(view.target);
  const api = view.target.AppDialog as AppDialogApi;
  const lazyChildren = view.body.children.length;
  const originalFocus = new FakeElement("button", () => undefined);
  view.setActiveElement(originalFocus);
  const confirmation = api.confirm("确定删除？", {
    tone: "warning",
    title: "删除图书",
    cancelLabel: "保留",
    confirmLabel: "删除",
  });
  runFrames(view.frames);
  const shownDialog = elementSnapshot(view.body.children[0] as FakeElement);
  view.body.children[0]?.children[0]?.children[2]?.children[1]?.fire("click");
  const confirmationResult = await confirmation;
  const hideDelay = [...view.timers.values()].at(-1)?.milliseconds;
  runLatestTimer(view.timers);
  const hiddenAfterDelay = view.body.children[0]?.hidden;

  const alert = api.alert(0, { tone: "unknown", title: "", confirmLabel: "知道了" });
  runFrames(view.frames);
  const shownAlert = elementSnapshot(view.body.children[0] as FakeElement);
  let prevented = false;
  const escapeEvent: FakeEvent = {
    target: view.body,
    key: "Escape",
    preventDefault: () => {
      prevented = true;
    },
  };
  for (const listener of view.keydownListeners) listener(escapeEvent);
  const alertResult = await alert;
  return {
    lazyChildren,
    apiKeys: Object.keys(api).sort(),
    frozen: Object.isFrozen(api),
    childCount: view.body.children.length,
    shownDialog,
    confirmationResult,
    hideDelay,
    restoredFocus: originalFocus.focusCount,
    hiddenAfterDelay,
    shownAlert,
    alertResult,
    prevented,
  };
}

test("dialog strict installer is VM-equivalent to the original classic script", async () => {
  assert.equal(
    JSON.stringify(await exerciseDialog(false)),
    JSON.stringify(await exerciseDialog(true)),
  );
});

test("dialog preserves original DOM, copy, tones, focus and animation timing", async () => {
  const result = await exerciseDialog(false);
  assert.equal(result.lazyChildren, 0);
  assert.equal(result.childCount, 1);
  assert.deepEqual(result.apiKeys, ["alert", "confirm"]);
  assert.equal(result.frozen, true);
  assert.equal(result.confirmationResult, true);
  assert.equal(result.hideDelay, 170);
  assert.equal(result.restoredFocus, 1);
  assert.equal(result.hiddenAfterDelay, true);
  assert.equal(result.alertResult, false);
  assert.equal(result.prevented, true);
  const alert = result.shownAlert as {
    readonly attributes: Record<string, string>;
    readonly children: ReadonlyArray<{
      readonly dataset: Record<string, string>;
      readonly children: ReadonlyArray<{
        readonly textContent: string;
        readonly children: ReadonlyArray<{ readonly hidden: boolean; readonly textContent: string }>;
      }>;
    }>;
  };
  assert.equal(alert.attributes["aria-hidden"], "false");
  assert.equal(alert.children[0]?.dataset.tone, "info");
  const sections = alert.children[0]?.children;
  assert.equal(sections?.[0]?.children[0]?.textContent, "i");
  assert.equal(sections?.[0]?.children[1]?.textContent, "提示");
  assert.equal(sections?.[1]?.textContent, "");
  assert.equal(sections?.[2]?.children[0]?.hidden, true);
  assert.equal(sections?.[2]?.children[1]?.textContent, "知道了");
});

test("foundation installers fail closed without the required browser runtime", () => {
  assert.equal(installNoticeUi({ document: {} }), null);
  assert.equal(installDialogUi({ document: {} }), null);
});
