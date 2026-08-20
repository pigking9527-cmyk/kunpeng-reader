import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  installSemanticUi,
  type SemanticUiGlobal,
  type SemanticUiOptions,
} from "./semantic-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

class FakeClassList {
  public readonly values = new Set<string>();
  public add(...names: string[]): void {
    names.forEach((name) => this.values.add(name));
  }
  public remove(...names: string[]): void {
    names.forEach((name) => this.values.delete(name));
  }
  public toggle(name: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(name);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  public readonly classList = new FakeClassList();
  public readonly style = { width: "" };
  public readonly parentElement = { classList: new FakeClassList() };
  public readonly handlers = new Map<string, EventListener>();
  public readonly selectedOptions: Array<{ textContent: string }> = [];
  public className = "";
  public disabled = false;
  public hidden = false;
  public textContent = "";
  public title = "";
  public value = "";
  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === "function") this.handlers.set(type, listener);
  }
  public removeEventListener(type: string): void {
    this.handlers.delete(type);
  }
  public async fire(type: string): Promise<void> {
    await this.handlers.get(type)?.({
      target: this,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as Event);
  }
}

function progress(): Parameters<
  ReturnType<SemanticUiGlobal["init"]>["render"]
>[0] {
  return {
    building: false,
    model_downloading: false,
    reranker_loading: false,
    vector_pause_requested: false,
    vector_paused: false,
    status_refreshing: false,
    active_task: "",
    done: 0,
    total: 2,
    shard_done: 0,
    shard_total: 0,
    model_ready: true,
    model_id: "bge-small-zh-v1.5",
    model_label: "Small",
    model_supported: true,
    model_bytes: 1024,
    semantic_done: 1,
    semantic_total: 2,
    semantic_ready: false,
    semantic_bytes: 10,
    accelerator_done: 0,
    accelerator_total: 0,
    accelerator_ready: false,
    accelerator_resumable: false,
    accelerator_bytes: 0,
    multi_profile_done: 0,
    multi_profile_total: 0,
    multi_profile_ready: false,
    multi_profile_bytes: 0,
    retrieval_mode: "standard",
    retrieval_mode_label: "standard",
    reranker_ready: false,
    reranker_downloaded: false,
    reranker_partial: false,
    m3_long_context_enabled: false,
    m3_index_done: 0,
    m3_index_total: 0,
    m3_index_ready: false,
    current: "",
    error: "",
  };
}

function fixture() {
  const elements = new Map<string, FakeElement>();
  const settingsModal = new FakeElement();
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const status = progress();
  if (!status || "tasks" in status)
    throw new Error("semantic progress fixture is invalid");
  const cache = {
    clear: () => undefined,
    get: () => status,
    merge: (value: Record<string, unknown> = {}) => value,
    save: () => undefined,
    update: (patch: Record<string, unknown>) => Object.assign(status, patch),
    use: () => status,
  };
  const runtime: Record<string, unknown> = {
    confirm: () => true,
    setInterval: () => 1,
    clearInterval: () => undefined,
    setTimeout: () => 1,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    __TAURI__: { event: { listen: async () => () => undefined } },
  };
  runtime.window = runtime;
  const transport: TauriTransport = {
    invoke: async <TResult,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(args ? { command, args } : { command });
      if (command === "semantic_tasks")
        return {
          busy: false,
          status_refreshing: false,
          current: "",
          error: "",
          tasks: [],
          progress: status,
        } as TResult;
      if (command === "background_task_status") return [] as TResult;
      if (command === "semantic_gpu_status")
        return {
          runtime_ready: false,
          runtime_install_available: false,
          runtime_download_bytes: 0,
          runtime_downloaded_bytes: 0,
          message: "CPU",
        } as TResult;
      return null as TResult;
    },
    listen: async () => () => undefined,
  };
  const root = {
    getElementById: (id: string) => {
      const existing = elements.get(id);
      if (existing) return existing;
      const element = new FakeElement();
      elements.set(id, element);
      return element;
    },
  } as unknown as Document;
  return { runtime, transport, root, settingsModal, cache, elements, calls };
}

async function exercise() {
  const view = fixture();
  const api = installSemanticUi(view.runtime) as SemanticUiGlobal;
  const options: SemanticUiOptions = {
    root: view.root,
    transport: view.transport,
    settingsModal: view.settingsModal as unknown as HTMLElement,
    cache: view.cache,
    confirmAction: () => true,
  };
  const controller = api.init(options);
  controller.render(progress());
  await controller.refresh();
  return {
    api: Object.keys(api).sort(),
    controller: Object.keys(controller).sort(),
    frozen: Object.isFrozen(api) && Object.isFrozen(controller),
    calls: view.calls,
    status: view.elements.get("sem-status")?.textContent,
    model: view.elements.get("sem-model-meta")?.textContent,
    vector: view.elements.get("sem-vector-meta")?.textContent,
  };
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("strict semantic controller preserves the frozen original public contract", async () => {
  const result = plain(await exercise()) as {
    api: string[];
    controller: string[];
    frozen: boolean;
    calls: Array<{ command: string; args?: Record<string, unknown> }>;
  };
  assert.deepEqual(result.api, ["init"]);
  assert.deepEqual(result.controller, ["close", "destroy", "open", "refresh", "render"]);
  assert.equal(result.frozen, true);
  assert.deepEqual(result.calls.slice(0, 3), [
    { command: "semantic_tasks", args: { reconcile: false } },
    { command: "background_task_status" },
  ]);
});

test("semantic controller source has one typed port and no alternate UI implementation", () => {
  const source = readFileSync(
    new URL("./semantic-ui.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bany\b|@ts-|eval\(|React|\.tsx|innerHTML/u);
  assert.match(source, /createSemanticPort/);
  assert.match(
    source,
    /global\.ReaderSemanticUI = Object\.freeze\(\{ init \}\)/,
  );
});

test("semantic controller emits a standalone classic IIFE", () => {
  const output = execFileSync(
    "npx",
    ["vite", "build", "--config", "apps/desktop-ui/vite.legacy-ts.config.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        KUNPENG_LEGACY_TS_SOURCE: fileURLToPath(
          new URL("./semantic-ui.ts", import.meta.url),
        ),
        KUNPENG_LEGACY_TS_OUTPUT_DIRECTORY: "/tmp/kunpeng-semantic-ui-test",
        KUNPENG_LEGACY_TS_OUTPUT: "semantic-ui.js",
        KUNPENG_LEGACY_TS_GLOBAL_NAME: "KunpengSemanticUi",
        KUNPENG_LEGACY_TS_INSTALL_EXPORT: "installSemanticUi",
      },
    },
  );
  assert.match(output, /built in/u);
});
