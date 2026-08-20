import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installVocabUi, type VocabUiController } from "./vocab-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  try {
    return readFileSync(new URL("ui/vocab-ui.js", repositoryRoot), "utf8");
  } catch {
    return execFileSync("git", ["show", "HEAD:ui/vocab-ui.js"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    });
  }
}

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
  public toggle(value: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(value);
    if (enabled) this.values.add(value);
    else this.values.delete(value);
    return enabled;
  }
}

interface FakeEvent {
  readonly target: FakeElement;
  stopPropagation(): void;
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();
  public checked = false;
  public disabled = false;
  public hidden = false;
  public max = 0;
  public value: string | number = "";
  public offsetHeight = 0;
  public className = "";
  public textContent = "";
  public title = "";
  private html = "";

  public constructor(public readonly tagName: string, public readonly id = "") {}

  public get innerHTML(): string {
    return this.html;
  }
  public set innerHTML(value: string) {
    this.html = value;
    if (!value) this.children.splice(0);
  }
  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    this.offsetHeight += 10;
    return child;
  }
  public addEventListener(
    type: string,
    listener: (event: FakeEvent) => unknown,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  public async fire(type: string, target: FakeElement = this): Promise<void> {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ target, stopPropagation: () => undefined });
    }
  }
  public closest(selector: string): FakeElement | null {
    const className = selector.startsWith(".") ? selector.slice(1) : "";
    if (className && this.className.split(/\s+/u).includes(className)) return this;
    if (selector.startsWith("#") && this.id === selector.slice(1)) return this;
    return null;
  }
}

class FakeStorage implements Storage {
  public readonly values = new Map<string, string>();
  public get length(): number {
    return this.values.size;
  }
  public clear(): void {
    this.values.clear();
  }
  public getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  public key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  public removeItem(key: string): void {
    this.values.delete(key);
  }
  public setItem(key: string, value: string): void {
    this.values.set(key, String(value));
  }
}

class FakeAudio {
  public static readonly created: FakeAudio[] = [];
  public onerror: (() => void) | null = null;
  public paused = false;
  public played = false;
  public constructor(public readonly src: string) {
    FakeAudio.created.push(this);
  }
  public pause(): void {
    this.paused = true;
  }
  public play(): Promise<void> {
    this.played = true;
    return Promise.resolve();
  }
}

class FakeUtterance {
  public lang = "";
  public rate = 1;
  public voice: SpeechSynthesisVoice | null = null;
  public constructor(public readonly text: string) {}
}

type Call = { readonly command: string; readonly args?: Record<string, unknown> };

function fixture() {
  const ids = [
    "vocab",
    "vocab-pane",
    "vocab-settings",
    "vocab-gear",
    "vocab-count-toggle",
    "vsort-time",
    "vsort-count",
    "dict-auto-speak-toggle",
    "word-audio-cache-toggle",
    "word-audio-cache-info",
    "word-audio-cache-size",
    "word-audio-cache-delete",
    "word-audio-pack",
    "word-pack-count",
    "word-pack-progress",
    "word-pack-meta",
    "word-pack-toggle",
    "word-pack-delete",
    "vtab-zh",
    "vtab-en",
    "vocab-btn",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement("div", id)]));
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
    createElement: (tagName: string) => new FakeElement(tagName),
  };
  const storage = new FakeStorage();
  storage.setItem("wordAudioDiskCache", "1");
  const calls: Call[] = [];
  const responses = new Map<string, unknown[]>([
    ["word_tts_cache_size", []],
    ["word_tts_pack_status", []],
    ["word_tts", []],
    ["vocab_list", []],
    ["vocab_set_level", []],
    ["vocab_remove", []],
    ["pause_word_tts_pack", []],
    ["clear_word_tts_cache", []],
    ["start_word_tts_pack", []],
    ["clear_word_tts_pack", []],
  ]);
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    const result = responses.get(command)?.shift();
    if (result instanceof Error) throw result;
    return result as TResult;
  };
  let overlay = false;
  let overlayHandlers: { readonly onOpen: () => void; readonly onClose: () => void } | null = null;
  const intervals = new Map<number, { readonly callback: () => void; cleared: boolean }>();
  const languageListeners: Array<() => void> = [];
  const alerts: string[] = [];
  const confirms: string[] = [];
  const spoken: string[] = [];
  let nextInterval = 1;
  const speechSynthesis = {
    cancel: () => undefined,
    getVoices: () => [{ lang: "en-US" } as SpeechSynthesisVoice],
    speak: (utterance: FakeUtterance) => spoken.push(utterance.text),
  };
  const ReaderShell = {
    OVERLAY: { VOCAB: "vocab" },
    setOverlay: (_name: unknown, open: boolean) => {
      overlay = open;
      if (open) overlayHandlers?.onOpen();
      else overlayHandlers?.onClose();
    },
    registerOverlay: (
      _name: unknown,
      handlers: { readonly onOpen: () => void; readonly onClose: () => void },
    ) => {
      overlayHandlers = handlers;
    },
    isOverlay: () => overlay,
  };
  const target: Record<string, unknown> = {
    document,
    localStorage: storage,
    ReaderShell,
    ReaderI18n: {
      t: (key: string, values?: Readonly<Record<string, unknown>>) => {
        let result = key;
        for (const [name, value] of Object.entries(values ?? {})) {
          result = result.replaceAll(`{${name}}`, String(value));
        }
        return result;
      },
    },
    Audio: FakeAudio,
    SpeechSynthesisUtterance: FakeUtterance,
    speechSynthesis,
    confirm: (message: string) => {
      confirms.push(message);
      return true;
    },
    alert: (message: unknown) => alerts.push(String(message)),
    pauseReadTracking: () => undefined,
    clearInterval: (id: number) => {
      const interval = intervals.get(id);
      if (interval) interval.cleared = true;
    },
    setInterval: (callback: () => void) => {
      const id = nextInterval++;
      intervals.set(id, { callback, cleared: false });
      return id;
    },
    addEventListener: (type: string, listener: () => void) => {
      if (type === "reader-language-changed") languageListeners.push(listener);
    },
    invoke,
  };
  target.window = target;
  target.globalThis = target;
  return {
    target,
    document,
    storage,
    elements,
    calls,
    responses,
    intervals,
    languageListeners,
    alerts,
    confirms,
    spoken,
    invoke,
  };
}

function enqueue(responses: Map<string, unknown[]>, command: string, ...values: unknown[]): void {
  responses.get(command)?.push(...values);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function paneSnapshot(pane: FakeElement): unknown {
  return pane.children.map((column) => ({
    className: column.className,
    children: column.children.map((row) => ({
      className: row.className,
      title: row.title,
      children: row.children.map((child) => ({
        className: child.className,
        text: child.textContent,
        children: child.children.map((nested) => ({
          className: nested.className,
          text: nested.textContent,
          children: nested.children.map((deep) => ({
            className: deep.className,
            text: deep.textContent,
          })),
        })),
      })),
    })),
  }));
}

async function exercise(legacy: boolean) {
  FakeAudio.created.splice(0);
  const view = fixture();
  enqueue(view.responses, "vocab_list", [
    { word: "alpha", lang: "en", count: 2, last_at: 10, def: "first", phonetic: "ˈælfə", level: 1 },
    { word: "乙", lang: "zh", count: 4, last_at: 20, def: "second", level: 0 },
  ]);
  let controller: VocabUiController | null = null;
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else {
    const transport: TauriTransport = { invoke: view.invoke };
    controller = installVocabUi(view.target, transport);
  }
  await view.elements["vocab-btn"]?.fire("click");
  await settle();
  const initial = {
    pane: paneSnapshot(view.elements["vocab-pane"] as FakeElement),
    settings: {
      showCount: view.elements["vocab-count-toggle"]?.checked,
      autoSpeak: view.elements["dict-auto-speak-toggle"]?.checked,
      diskCache: view.elements["word-audio-cache-toggle"]?.checked,
      cacheInfoHidden: view.elements["word-audio-cache-info"]?.hidden,
    },
  };

  enqueue(view.responses, "vocab_list", []);
  await view.elements["vsort-count"]?.fire("click");
  await settle();
  const empty = paneSnapshot(view.elements["vocab-pane"] as FakeElement);
  const countToggle = view.elements["vocab-count-toggle"];
  if (countToggle) countToggle.checked = false;
  await countToggle?.fire("change");
  const autoSpeak = view.elements["dict-auto-speak-toggle"];
  if (autoSpeak) autoSpeak.checked = false;
  await autoSpeak?.fire("change");

  enqueue(view.responses, "word_tts_cache_size", 2_048);
  enqueue(view.responses, "word_tts_pack_status", {
    total: 100,
    cached: 25,
    bytes: 1_024,
    running: true,
    current: "alpha",
  });
  await view.elements["vocab-gear"]?.fire("click");
  await settle();
  const pack = {
    count: view.elements["word-pack-count"]?.textContent,
    meta: view.elements["word-pack-meta"]?.textContent,
    toggle: view.elements["word-pack-toggle"]?.textContent,
    progress: {
      max: view.elements["word-pack-progress"]?.max,
      value: view.elements["word-pack-progress"]?.value,
    },
    cacheSize: view.elements["word-audio-cache-size"]?.textContent,
    intervals: [...view.intervals.values()].filter(({ cleared }) => !cleared).length,
  };
  await view.elements["word-pack-toggle"]?.fire("click");

  enqueue(view.responses, "pause_word_tts_pack", undefined);
  enqueue(view.responses, "clear_word_tts_cache", undefined);
  enqueue(view.responses, "word_tts_pack_status", { total: 100, cached: 0, bytes: 0, running: false });
  enqueue(view.responses, "word_tts_cache_size", 0);
  await view.elements["word-audio-cache-delete"]?.fire("click");
  await settle();

  if (legacy) {
    vm.runInNewContext('prefetchMicrosoftWord("beta"); speakMicrosoftWord("gamma");', view.target);
  } else {
    controller?.prefetchMicrosoftWord("beta");
    controller?.speakMicrosoftWord("gamma");
  }
  enqueue(view.responses, "word_tts", { audio: "YmV0YQ==" }, { audio: "Z2FtbWE=" });
  await settle();
  return {
    controllerKeys: controller ? Object.keys(controller).sort() : null,
    initial,
    empty,
    storage: Object.fromEntries(view.storage.values),
    pack,
    calls: view.calls,
    confirms: view.confirms,
    alerts: view.alerts,
    audio: FakeAudio.created.map(({ src, played }) => ({ src, played })),
  };
}

test("vocabulary strict installer is behavior-equivalent to the original classic script", async () => {
  const typed = await exercise(false);
  const legacy = await exercise(true);
  assert.equal(
    JSON.stringify({ ...typed, controllerKeys: null }),
    JSON.stringify(legacy),
  );
});

test("typed vocabulary transport preserves settings, pack state and exact command envelopes", async () => {
  const result = await exercise(false);
  assert.deepEqual(result.controllerKeys, [
    "applyVocabSettings",
    "formatCacheSize",
    "prefetchMicrosoftWord",
    "refreshWordAudioCacheSize",
    "refreshWordPackStatus",
    "renderVocab",
    "renderWordPackState",
    "setVocab",
    "setVocabSort",
    "setVocabTab",
    "speakMicrosoftWord",
    "speakSystemWord",
    "speakVocabWord",
  ]);
  assert.equal(result.storage.vocabShowCount, "0");
  assert.equal(result.storage.vocabAutoSpeak, "0");
  assert.equal(result.storage.vocabSort, "count");
  assert.deepEqual(result.pack, {
    count: "25 / 100",
    meta: "生成中：{current} · 25.0%",
    toggle: "暂停",
    progress: { max: 100, value: 25 },
    cacheSize: "缓存：{size}",
    intervals: 1,
  });
  assert.equal(
    result.calls.some(({ command, args }) => command === "vocab_list" && args?.lang === "zh"),
    true,
  );
  assert.equal(result.confirms[0], "删除全部英文单词语音缓存？");
});

test("vocabulary installer fails closed without its original reader runtime", () => {
  const transport: TauriTransport = {
    invoke: async <TResult,>() => undefined as TResult,
  };
  assert.equal(installVocabUi({ document: {} }, transport), null);
});
