import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
  installBookClassificationSettingsUi,
  type BookClassificationSettingsUiApi,
} from "./book-classification-settings-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

function classicSource(): string {
  try {
    return readFileSync(
      new URL("ui/generated-ts/book-classification-settings-ui.js", repositoryRoot),
      "utf8",
    );
  } catch {
    return execFileSync(
      "git",
      ["show", "HEAD:ui/generated-ts/book-classification-settings-ui.js"],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
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
}

interface FakeEvent {
  readonly target: FakeElement;
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();
  public checked = false;
  public disabled = false;
  public textContent = "";
  public title = "";

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
      await listener({ target });
    }
  }
}

type Call = { readonly command: string; readonly args?: Record<string, unknown> };

interface IntervalEntry {
  readonly callback: () => void;
  cleared: boolean;
}

function fixture() {
  const ids = [
    "book-classification-settings-modal",
    "book-classification-settings-open",
    "book-classification-settings-close",
    "book-classification-settings-run",
    "book-classification-settings-status",
    "set-use-model-tags",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const calls: Call[] = [];
  const responses = new Map<string, unknown[]>([
    ["library_profile_status", []],
    ["library_profile_coverage_status", []],
    ["library_model_tags_settings", []],
    ["start_library_auto_classification", []],
    ["set_library_model_tags_enabled", []],
  ]);
  const intervals = new Map<number, IntervalEntry>();
  const dispatched: Array<{ readonly type: string; readonly detail: unknown }> = [];
  const alerts: Array<{ readonly message: unknown; readonly options: unknown }> = [];
  let nextInterval = 1;
  const invoke = async <TResult,>(command: string, args?: Record<string, unknown>) => {
    calls.push(args ? { command, args } : { command });
    const response = responses.get(command)?.shift();
    if (response instanceof Error) throw response;
    return response as TResult;
  };
  const document = {
    getElementById: (id: string) => elements[id] ?? null,
  };
  class FakeCustomEvent {
    public constructor(
      public readonly type: string,
      public readonly init: { readonly detail?: unknown } = {},
    ) {}
    public get detail(): unknown {
      return this.init.detail;
    }
  }
  const target: Record<string, unknown> = {
    document,
    CustomEvent: FakeCustomEvent,
    setInterval: (callback: () => void) => {
      const id = nextInterval;
      nextInterval += 1;
      intervals.set(id, { callback, cleared: false });
      return id;
    },
    clearInterval: (id: number) => {
      const interval = intervals.get(id);
      if (interval) interval.cleared = true;
    },
    dispatchEvent: (event: FakeCustomEvent) => {
      dispatched.push({ type: event.type, detail: event.detail });
      return true;
    },
    AppDialog: {
      alert: (message: unknown, options: unknown) => {
        alerts.push({ message, options });
        return Promise.resolve(true);
      },
    },
  };
  target.window = target;
  target.globalThis = target;
  return {
    target,
    document,
    elements,
    calls,
    responses,
    intervals,
    dispatched,
    alerts,
    invoke,
  };
}

function enqueue(
  responses: Map<string, unknown[]>,
  command: string,
  ...values: unknown[]
): void {
  responses.get(command)?.push(...values);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function state(view: ReturnType<typeof fixture>): unknown {
  const run = view.elements["book-classification-settings-run"];
  const status = view.elements["book-classification-settings-status"];
  const tags = view.elements["set-use-model-tags"];
  return {
    modal: [...(view.elements["book-classification-settings-modal"]?.classList.values ?? [])],
    run: { disabled: run?.disabled, text: run?.textContent },
    status: { text: status?.textContent, title: status?.title },
    tags: { checked: tags?.checked, disabled: tags?.disabled },
    activeIntervals: [...view.intervals.values()].filter(({ cleared }) => !cleared).length,
  };
}

async function exercise(legacy: boolean) {
  const view = fixture();
  if (legacy) vm.runInNewContext(classicSource(), view.target);
  else installBookClassificationSettingsUi(view.target);
  const api = view.target.ReaderBookClassificationSettingsUI as BookClassificationSettingsUiApi;
  api.init({ invoke: view.invoke });

  enqueue(view.responses, "library_profile_status", {
    state: "running",
    current: "",
    progress: { done: 2, total: 8 },
  });
  enqueue(view.responses, "library_profile_coverage_status", {
    totalBooks: 10,
    incompleteBooks: 8,
  });
  enqueue(view.responses, "library_model_tags_settings", { enabled: true });
  await view.elements["book-classification-settings-open"]?.fire("click");
  await settle();
  const running = state(view);

  enqueue(view.responses, "library_profile_status", { state: "paused", current: "已暂停" });
  enqueue(view.responses, "library_profile_coverage_status", {
    totalBooks: 10,
    incompleteBooks: 5,
  });
  enqueue(view.responses, "library_model_tags_settings", { enabled: false });
  const interval = [...view.intervals.values()].find(({ cleared }) => !cleared);
  interval?.callback();
  await settle();
  const paused = state(view);

  enqueue(view.responses, "start_library_auto_classification", {});
  enqueue(view.responses, "library_profile_status", { state: "completed" });
  enqueue(view.responses, "library_profile_coverage_status", {
    totalBooks: 10,
    incompleteBooks: 1,
  });
  enqueue(view.responses, "library_model_tags_settings", { enabled: true });
  await view.elements["book-classification-settings-run"]?.fire("click");
  await settle();
  const completed = state(view);

  const tags = view.elements["set-use-model-tags"];
  if (tags) tags.checked = false;
  enqueue(view.responses, "set_library_model_tags_enabled", { enabled: false });
  await tags?.fire("change");
  const savedTags = state(view);

  if (tags) tags.checked = true;
  enqueue(view.responses, "set_library_model_tags_enabled", new Error("save failed"));
  await tags?.fire("change");
  const failedTags = state(view);

  await view.elements["book-classification-settings-close"]?.fire("click");
  return {
    api: { keys: Object.keys(api).sort(), frozen: Object.isFrozen(api) },
    running,
    paused,
    completed,
    savedTags,
    failedTags,
    closed: state(view),
    calls: view.calls,
    dispatched: view.dispatched,
    alerts: view.alerts,
  };
}

test("book classification strict installer is behavior-equivalent to classic VM", async () => {
  assert.equal(JSON.stringify(await exercise(false)), JSON.stringify(await exercise(true)));
});

test("typed classification transport preserves polling, progress, resume and tag settings", async () => {
  const result = await exercise(false);
  assert.deepEqual(result.api, { keys: ["close", "init", "open"], frozen: false });
  assert.deepEqual(result.running, {
    modal: ["show"],
    run: { disabled: true, text: "正在分类" },
    status: { text: "正在分类（2/8）", title: "正在分类（2/8）" },
    tags: { checked: true, disabled: false },
    activeIntervals: 1,
  });
  assert.deepEqual(result.paused, {
    modal: ["show"],
    run: { disabled: false, text: "继续分类" },
    status: { text: "已暂停；可从已保存的位置继续", title: "已暂停；可从已保存的位置继续" },
    tags: { checked: false, disabled: false },
    activeIntervals: 0,
  });
  assert.equal(
    (result.completed as { readonly status: { readonly text: string } }).status.text,
    "已完成 9 / 10 本图书的分类",
  );
  assert.deepEqual(result.dispatched, [
    { type: "library-model-tags-setting-changed", detail: { enabled: false } },
  ]);
  assert.deepEqual(result.alerts, [
    {
      message: "保存大模型分类标签设置失败：Error: save failed",
      options: { title: "AI 图书标签", confirmLabel: "关闭", tone: "error" },
    },
  ]);
  assert.equal(
    result.calls.some(
      ({ command, args }) =>
        command === "set_library_model_tags_enabled" && args?.enabled === false,
    ),
    true,
  );
});

test("classification installer fails closed without the original browser runtime", () => {
  assert.equal(installBookClassificationSettingsUi({ document: {} }), null);
});
