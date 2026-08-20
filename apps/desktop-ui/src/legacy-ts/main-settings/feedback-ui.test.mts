import assert from "node:assert/strict";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { initializeFeedbackUi, installFeedbackUi } from "./feedback-ui.ts";

class FakeClassList {
  public readonly values = new Set<string>();
  public add(value: string): void {
    this.values.add(value);
  }
  public remove(value: string): void {
    this.values.delete(value);
  }
  public contains(value: string): boolean {
    return this.values.has(value);
  }
}

class FakeElement {
  public textContent = "";
  public className = "";
  public hidden = false;
  public disabled = false;
  public value = "";
  public readonly dataset: Record<string, string> = {};
  public readonly classList = new FakeClassList();
  public readonly listeners = new Map<string, (event: Event) => void>();
  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") this.listeners.set(type, listener);
  }
  public querySelector(selector: string): FakeElement | null {
    return selector === ".feedback-note" ? this : null;
  }
  public querySelectorAll(): FakeElement[] {
    return [];
  }
  public cloneNode(): FakeElement {
    return Object.assign(new FakeElement(), {
      textContent: this.textContent,
      innerText: this.textContent,
    });
  }
  public replaceChildren(): void {
    this.textContent = "";
  }
  public focus(): void {}
  public click(): void {}
  public fire(type: string): void {
    this.listeners.get(type)?.({ target: this } as unknown as Event);
  }
}

function fixture() {
  const ids = [
    "feedback-modal",
    "feedback-editor",
    "feedback-title",
    "feedback-close",
    "feedback-image-input",
    "feedback-insert-image",
    "feedback-image-status",
    "feedback-json-row",
    "feedback-problem-trace-note",
    "feedback-trace-status",
    "feedback-attach-problem-trace",
    "feedback-save-problem-trace",
    "feedback-clear-json",
    "feedback-json-status",
    "feedback-submit",
    "feedback-status",
    "about-feedback-bug",
    "about-feedback-feature",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const modal = elements["feedback-modal"];
  const note = new FakeElement();
  if (modal) modal.querySelector = () => note;
  const traceControls = [new FakeElement(), new FakeElement()];
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    querySelectorAll: () => traceControls,
    createElement: () => new FakeElement(),
  } as unknown as Document;
  return { elements, note, traceControls, document };
}

test("typed feedback transport preserves open, submit and request payload behavior", async () => {
  const priorAnimationFrame = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
  });
  const view = fixture();
  const calls: Array<{ readonly command: string; readonly args?: Record<string, unknown> }> = [];
  const transport: TauriTransport = {
    invoke: async <TResult,>(command: string, args?: Record<string, unknown>) => {
      calls.push(args ? { command, args } : { command });
      return (command === "app_version" ? "1.2.3" : { accepted: true }) as TResult;
    },
  };
  const editor = view.elements["feedback-editor"];
  if (editor) editor.textContent = "  闪退问题  ";
  const runtime = {
    document: view.document,
    navigator: { userAgent: "typed-test" } as Navigator,
    ReaderAppI18n: {
      t: (key: string) => key,
      apply: () => undefined,
    },
    ReaderProblemTraceUI: { capture: async () => null },
  };
  const api = initializeFeedbackUi(runtime, transport);
  assert.ok(api);
  api.open("feature");
  assert.equal(view.elements["feedback-modal"]?.classList.contains("show"), true);
  assert.equal(view.elements["feedback-problem-trace-note"]?.hidden, true);
  assert.equal(view.traceControls.every(({ hidden }) => hidden), true);
  await api.submit();
  assert.deepEqual(calls.map(({ command }) => command), ["app_version", "submit_feedback"]);
  assert.deepEqual(calls[1]?.args?.request, {
    kind: "feature",
    text: "闪退问题",
    appVersion: "1.2.3",
    platform: "typed-test",
    images: [],
    attachments: [],
  });
  assert.equal(view.elements["feedback-status"]?.textContent, "feedbackSubmitted");
  assert.equal(view.elements["feedback-submit"]?.disabled, false);
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: priorAnimationFrame,
  });
});

test("installer fails closed without runtime transport or required DOM", () => {
  assert.equal(
    installFeedbackUi({ document: { getElementById: () => null } as unknown as Document }),
    null,
  );
  const transport: TauriTransport = {
    invoke: async <TResult,>() => undefined as TResult,
  };
  assert.equal(
    installFeedbackUi(
      { document: { getElementById: () => null } as unknown as Document },
      transport,
    ),
    null,
  );
});
