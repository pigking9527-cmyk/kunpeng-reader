import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installLibraryAi } from "./library-ai.ts";

type Handler = (event: Record<string, unknown>) => unknown;

class FakeElement {
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly handlers = new Map<string, Handler>();
  public readonly style = {
    cssText: "",
    left: "",
    top: "",
    setProperty: (name: string, value: string) => { void name; void value; },
  };
  public value = "";
  public textContent = "";
  public className = "";
  public title = "";
  public placeholder = "";
  public innerHTML = "";
  public disabled = false;
  public hidden = false;
  public checked = false;
  public type = "";
  public selectionStart: number | null = 0;
  public selectionEnd: number | null = 0;
  private readonly classes = new Set<string>();

  public readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    contains: (name: string) => this.classes.has(name),
    toggle: (name: string, force?: boolean) => {
      if (force ?? !this.classes.has(name)) this.classes.add(name);
      else this.classes.delete(name);
      return this.classes.has(name);
    },
  };

  public get options(): FakeElement[] {
    return this.children;
  }

  public addEventListener(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }
  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }
  public closest(): null { return null; }
  public contains(): boolean { return false; }
  public dispatchEvent(): boolean { return true; }
  public focus(): void {}
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public getBoundingClientRect(): DOMRect {
    return { bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0, x: 0, y: 0, toJSON: () => ({}) };
  }
  public querySelector(selector: string): FakeElement | null {
    return selector === "i" ? this.children[0] ?? null : null;
  }
  public querySelectorAll(): FakeElement[] { return []; }
  public remove(): void {}
  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }
  public select(): void {}
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public setRangeText(replacement: string, start: number, end: number): void {
    this.value = this.value.slice(0, start) + replacement + this.value.slice(end);
  }
}

interface RecordedCall {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function harness() {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    const current = elements.get(id);
    if (current) return current;
    const created = new FakeElement();
    elements.set(id, created);
    return created;
  };
  const root = {
    activeElement: null,
    body: new FakeElement(),
    createElement: () => new FakeElement(),
    createTextNode: (text: string) => Object.assign(new FakeElement(), { textContent: text }),
    execCommand: () => true,
    getElementById: element,
    querySelectorAll: () => [],
  } as unknown as Document;
  const calls: RecordedCall[] = [];
  const transport: TauriTransport = {
    async invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
      calls.push(args ? { command, args } : { command });
      const responses: Record<string, unknown> = {
        ai_reader_status: { configured: true },
        ai_reader_profiles: {
          activeId: "profile-1",
          assignments: { libraryId: "profile-1" },
          profiles: [{ configured: true, id: "profile-1", name: "本机模型" }],
        },
        app_settings_sync_get: { hasLibraryAnswerSettings: false },
        ask_library_assistant: { content: "回答", singleBook: false, sources: [] },
        library_answer_settings: {
          answerLength: "short",
          recommendationCandidateLimit: 20,
          recommendationResultLimit: 12,
        },
        library_model_tags_settings: { enabled: true },
        list_books: [
          { author: "甲", id: "book-1", title: "第一本" },
          { author: "乙", id: "book-2", title: "第二本" },
        ],
        private_sync_library_history_list: { entries: [], syncEnabled: false, syncMode: "off" },
        private_sync_library_history_merge: { entries: [], syncEnabled: false, syncMode: "off" },
        semantic_tasks: { progress: { model_id: "bge-m3", model_ready: true, semantic_done: 2, semantic_ready: true } },
      };
      return responses[command] as TResult;
    },
  };
  const runtimeHandlers = new Map<string, Handler>();
  const storage = new Map<string, string>();
  const runtime = {
    addEventListener: (name: string, handler: Handler) => { runtimeHandlers.set(name, handler); },
    clearTimeout: () => undefined,
    document: root,
    innerHeight: 800,
    innerWidth: 1200,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      removeItem: (key: string) => { storage.delete(key); },
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    navigator: {},
    setTimeout: () => 1,
  };
  return { calls, element, runtime, transport };
}

test("library AI freezes the original DOM, storage, events and native command contract", async () => {
  const source = await readFile(new URL("./library-ai.ts", import.meta.url), "utf8");
  const commands = Array.from(source.matchAll(/api\.invoke\("([^"]+)"/gu), ([, command]) => command).sort();
  assert.deepEqual(Array.from(new Set(commands)), [
    "ai_reader_profiles",
    "ai_reader_status",
    "app_settings_sync_get",
    "app_settings_sync_save",
    "ask_library_assistant",
    "assign_ai_reader_profile",
    "library_answer_settings",
    "library_history_source_preview",
    "library_model_tags_settings",
    "list_books",
    "open_book_at",
    "private_sync_library_history_delete",
    "private_sync_library_history_list",
    "private_sync_library_history_merge",
    "private_sync_set_library_history_cloud_saved",
    "private_sync_set_library_history_mode",
    "save_recommended_booklist",
    "semantic_status",
    "semantic_tasks",
    "set_library_answer_length",
    "set_library_recommendation_candidate_limit",
    "set_library_recommendation_result_limit",
    "set_semantic_m3_long_context",
  ]);
  for (const key of ["libraryAiAnswerFontSizeV1", "libraryAiHistoryLayoutV1", "libraryAiHistorySourcesV1"]) {
    assert.ok(source.includes(`"${key}"`), `missing original storage key ${key}`);
  }
  for (const id of [
    "library-ai-page", "books", "state", "answer", "sources", "source-list", "source-preview",
    "mode-question", "mode-compare", "mode-recommend", "library-ai-book-search", "library-ai-history",
    "library-ai-answer-settings", "library-ai-long-context", "library-ai-model-profile", "run", "question",
  ]) {
    assert.ok(source.includes(`$("${id}")`), `missing original DOM id ${id}`);
  }
  for (const eventName of [
    "library-model-tags-setting-changed", "ai-reader-profiles-changed", "app-settings-synced",
    "app-language-changed", "pointerdown", "keydown",
  ]) {
    assert.ok(source.includes(`global.addEventListener("${eventName}"`), `missing original event ${eventName}`);
  }
  assert.match(source, /runtime\.ReaderLibraryAiUI = ui/);
  assert.match(source, /Object\.freeze\(\{ init, MAX_QUESTION_SOURCES, MAX_COMPARE_BOOKS \}\)/);
  assert.doesNotMatch(source, /__TAURI__|\bany\b|@ts-ignore|@ts-expect-error|eval\s*\(/u);
});

test("typed transport preserves bootstrap and question request envelopes", async () => {
  const view = harness();
  const api = installLibraryAi(view.runtime, view.transport);
  assert.ok(api);
  assert.equal(
    (view.runtime as unknown as Record<string, unknown>)["ReaderLibraryAiUI"],
    api,
  );
  assert.equal(api.MAX_QUESTION_SOURCES, 20);
  assert.equal(api.MAX_COMPARE_BOOKS, 8);

  const assistant = api.init({ root: view.runtime.document as Document });
  assert.ok(assistant);
  await assistant.load();
  assert.deepEqual(view.calls.slice(0, 7), [
    { command: "ai_reader_status" },
    { command: "ai_reader_profiles" },
    { command: "semantic_tasks", args: { reconcile: true } },
    { command: "list_books" },
    { command: "library_model_tags_settings" },
    { command: "library_answer_settings" },
    { command: "private_sync_library_history_list" },
  ]);
  assert.deepEqual(view.calls[7], { command: "app_settings_sync_get" });

  view.element("question").value = "两本书怎样讨论财政问题？";
  await assistant.run();
  const ask = view.calls.find(({ command }) => command === "ask_library_assistant");
  assert.deepEqual(ask, {
    command: "ask_library_assistant",
    args: {
      request: {
        question: "两本书怎样讨论财政问题？",
        selectedBookIds: [],
        task: "question",
      },
    },
  });
  const merge = view.calls.find(({ command }) => command === "private_sync_library_history_merge");
  assert.equal(Array.isArray(merge?.args?.request && (merge.args.request as { entries?: unknown }).entries), true);
});

test("installer fails closed when the required original DOM is unavailable", () => {
  const transport: TauriTransport = { invoke: async <TResult,>() => undefined as TResult };
  const runtime = {
    document: { getElementById: () => null },
  };
  const ui = installLibraryAi(runtime, transport);
  assert.ok(ui);
  assert.equal(ui.init(), null);
});
