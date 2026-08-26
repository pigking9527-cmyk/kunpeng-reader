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
  public readonly attributes = new Map<string, string>();
  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener === "function") this.handlers.set(type, listener);
  }
  public removeEventListener(type: string): void {
    this.handlers.delete(type);
  }
  public click(): void {
    void this.fire("click");
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
    retrieval_mode: "high_precision",
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
  const panels = ["overview", "library", "models", "companion"].map((id) => {
    const panel = new FakeElement();
    panel.setAttribute("data-sem-panel", id);
    return panel;
  });
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
      if (command === "ai_capability_routes_status")
        return {
          routes: [
            {
              capability: "search",
              mode: "local",
              allowAuto: true,
              allowLocal: true,
              allowIntelligenceHost: false,
              allowCloud: false,
              allowOff: true,
            },
          ],
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
    querySelectorAll: () => panels,
  } as unknown as Document;
  return { runtime, transport, root, settingsModal, cache, elements, calls, panels };
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
  controller.render({
    ...progress(),
    model_id: "qwen3-embedding-0.6b",
    retrieval_mode: "standard",
  });
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
  assert.doesNotMatch(source, /semanticCache\.use\(next\)/u);
  assert.match(
    source,
    /global\.ReaderSemanticUI = Object\.freeze\(\{ init \}\)/,
  );
});

test("smart search plans render selected state and use backend model ids", async () => {
  const view = fixture();
  const api = installSemanticUi(view.runtime) as SemanticUiGlobal;
  const controller = api.init({
    root: view.root,
    transport: view.transport,
    settingsModal: view.settingsModal as unknown as HTMLElement,
    cache: view.cache,
    confirmAction: () => true,
  });
  controller.render({
    ...progress(),
    model_id: "qwen3-embedding-0.6b",
    retrieval_mode: "high_precision",
  });
  const standard = view.elements.get("sem-solution-standard");
  const high = view.elements.get("sem-solution-high");
  assert.equal(standard?.classList.values.has("selected"), true);
  assert.equal(standard?.getAttribute("aria-pressed"), "true");
  await high?.fire("click");
  await view.elements.get("sem-solution-apply")?.fire("click");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(view.calls.at(-1), {
    command: "background_task_status",
  });
  assert.ok(
    view.calls.some(
      (call) =>
        call.command === "select_semantic_solution" &&
        call.args?.modelId === "qwen3-embedding-8b" &&
        call.args?.retrievalMode === "high_precision",
    ),
  );
  controller.destroy();
});

test("pending smart-search build keeps the serving plan selected until promotion", () => {
  const view = fixture();
  const api = installSemanticUi(view.runtime) as SemanticUiGlobal;
  const controller = api.init({
    root: view.root,
    transport: view.transport,
    settingsModal: view.settingsModal as unknown as HTMLElement,
    cache: view.cache,
    confirmAction: () => true,
  });
  controller.render({
    ...progress(),
    building: true,
    active_task: "semantic_vectors",
    done: 38,
    total: 100,
    model_id: "qwen3-embedding-0.6b",
    retrieval_mode: "high_precision",
    solution_switching: true,
    pending_model_id: "qwen3-embedding-8b",
    pending_model_label: "Qwen3 Embedding 8B",
    pending_retrieval_mode: "high_precision",
    current: "正在分析候选搜索库",
  });
  const serving = view.elements.get("sem-solution-standard");
  const pending = view.elements.get("sem-solution-high");
  const switchStatus = view.elements.get("sem-solution-switch");
  assert.equal(serving?.classList.values.has("selected"), true);
  assert.equal(pending?.classList.values.has("selected"), false);
  assert.equal(pending?.classList.values.has("pending"), true);
  assert.equal(switchStatus?.hidden, false);
  assert.match(switchStatus?.textContent || "", /38\/100 · 38%/u);
  assert.match(switchStatus?.textContent || "", /当前智能搜索继续可用/u);
  const apply = view.elements.get("sem-solution-apply");
  assert.equal(apply?.disabled, true);
  assert.equal(apply?.textContent, "正在建立新搜索库");
  controller.destroy();
});

test("27B local understanding configuration is not part of a search plan", () => {
  const source = readFileSync(new URL("./semantic-ui.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /qwen27CompositeChoice|qwen27DeepSearch|semanticQwen27DeepSearchV1/u);
  assert.match(source, /saveIntelligenceModel/);
  assert.match(source, /intelligencePreflight\.message/);
  assert.match(source, /hardwareReady && intelligencePreflight\.serviceReady/);
});

test("smart management exposes a real 7B/8B local-understanding readiness check", () => {
  const source = readFileSync(new URL("./semantic-ui.ts", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../../../../ui/index.html", import.meta.url), "utf8");
  assert.match(source, /localUnderstandingPreflight\(\)/);
  assert.match(source, /localUnderstandingPreflight\.local && localUnderstandingPreflight\.serviceReady/);
  assert.match(html, /id="sem-understanding-preflight"/u);
  assert.match(html, /Agent 模型/u);
  assert.match(html, /本机或云端 · 按任务分工/u);
});

test("capability cards keep technical retrieval models behind the automatic route", () => {
  const source = readFileSync(new URL("./semantic-ui.ts", import.meta.url), "utf8");
  assert.match(source, /capabilityTitle/);
  assert.match(source, /当前能力：\$\{activePlanName\}/u);
  assert.match(source, /当前智能搜索继续可用/u);
  assert.doesNotMatch(source, /正在后台建立 .*维/u);
  assert.doesNotMatch(source, /本地理解（7B\/8B）|深度理解（本地 27B/u);
});

test("smart management detects the three model cards without starting any model", async () => {
  const view = fixture();
  const api = installSemanticUi(view.runtime) as SemanticUiGlobal;
  const controller = api.init({
    root: view.root,
    transport: view.transport,
    settingsModal: view.settingsModal as unknown as HTMLElement,
    cache: view.cache,
    confirmAction: () => true,
  });

  controller.open();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(view.calls.some((call) => call.command === "semantic_tasks"));
  assert.ok(view.calls.some((call) => call.command === "semantic_gpu_status"));
  assert.ok(view.calls.some((call) => call.command === "local_understanding_model_preflight"));
  assert.ok(view.calls.some((call) => call.command === "intelligence_local_model_capabilities"));
  assert.ok(view.calls.some((call) => call.command === "reader_media_status"));
  assert.ok(view.calls.some((call) => call.command === "ai_reader_profiles"));
  assert.equal(view.calls.some((call) => /download|start|install/iu.test(call.command)), false);
  controller.destroy();
});

test("recommended setup chooses the single semantic model without touching capability routes", () => {
  const source = readFileSync(new URL("./semantic-ui.ts", import.meta.url), "utf8");
  assert.match(source, /"qwen3-embedding-0\.6b"/u);
  assert.match(source, /Qwen3 Embedding 0\.6B/u);
  assert.doesNotMatch(source, /const searchRoute = routes\.find/u);
  assert.match(source, /已选择推荐语义模型/u);
});

test("Agent card opens the one secure cloud-model editor in Agent-only mode", async () => {
  const view = fixture();
  const api = installSemanticUi(view.runtime) as SemanticUiGlobal;
  const controller = api.init({
    root: view.root,
    transport: view.transport,
    settingsModal: view.settingsModal as unknown as HTMLElement,
    cache: view.cache,
    confirmAction: () => true,
  });
  let opened = 0;
  (view.root.getElementById("api-settings-open") as unknown as FakeElement)
    .addEventListener("click", () => { opened += 1; });
  view.elements.get("semantic-index-modal")?.classList.add("show");
  await view.elements.get("sem-agent-primary")?.fire("click");
  assert.equal(opened, 1);
  assert.equal(view.elements.get("semantic-index-modal")?.classList.values.has("show"), false);
  assert.equal(view.settingsModal.classList.values.has("show"), true);
  assert.equal(view.elements.get("api-settings-modal")?.getAttribute("data-agent-config-mode"), "true");
  controller.destroy();
});

test("semantic controller emits a standalone classic IIFE", () => {
  const output = execFileSync(
    process.execPath,
    [
      fileURLToPath(new URL("node_modules/vite/bin/vite.js", repositoryRoot)),
      "build",
      "--config",
      "apps/desktop-ui/vite.legacy-ts.config.ts",
    ],
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
