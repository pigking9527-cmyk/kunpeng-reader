import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import {
  installApiSettingsUi,
  type ApiSettingsGlobalApi,
} from "./api-settings-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);

class FakeClassList {
  public readonly values = new Set<string>();

  public add(...values: string[]): void {
    values.forEach((value) => this.values.add(value));
  }

  public remove(...values: string[]): void {
    values.forEach((value) => this.values.delete(value));
  }

  public toggle(value: string, enabled?: boolean): boolean {
    const next = enabled ?? !this.values.has(value);
    if (next) this.values.add(value);
    else this.values.delete(value);
    return next;
  }
}

type FakeListener = (event: Event) => void;

class FakeElement {
  public value = "";
  public textContent = "";
  public placeholder = "";
  public disabled = false;
  public focused = false;
  public readonly style = { color: "" };
  public readonly dataset: Record<string, string> = {};
  public readonly classList = new FakeClassList();
  public readonly children: FakeElement[] = [];
  public readonly listeners = new Map<string, FakeListener[]>();
  private readonly attributes = new Map<string, string>();

  public addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as FakeListener);
    this.listeners.set(type, listeners);
  }

  public fire(type: string, target: FakeElement = this): void {
    const event = { target } as unknown as Event;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  public appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  public replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  public querySelectorAll(selector: string): FakeElement[] {
    return selector === "[data-ai-purpose]"
      ? this.children.filter((child) => Boolean(child.dataset.aiPurpose))
      : [];
  }

  public closest(selector: string): FakeElement | null {
    return selector === "[data-ai-purpose]" && this.dataset.aiPurpose
      ? this
      : null;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public focus(): void {
    this.focused = true;
  }
}

function classicSource(): string {
  return readFileSync(
    new URL("ui/generated-ts/api-settings-ui.js", repositoryRoot),
    "utf8",
  );
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function fixture() {
  const ids = [
    "api-settings-modal",
    "api-ai-profile",
    "api-ai-preset",
    "api-ai-name",
    "api-ai-provider",
    "api-ai-base-url",
    "api-ai-model",
    "api-ai-key",
    "api-ai-status",
    "api-ai-purpose-picker",
    "api-translation-provider",
    "api-translation-id",
    "api-translation-key",
    "api-translation-summary",
    "api-translation-status",
    "api-settings-open",
    "api-settings-close",
    "api-ai-save",
    "api-translation-save",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new FakeElement()]));
  const purposes = ["reading", "library", "other"].map((purpose) => {
    const button = new FakeElement();
    button.dataset.aiPurpose = purpose;
    return button;
  });
  elements["api-ai-purpose-picker"]?.replaceChildren(...purposes);
  const events: string[] = [];
  const runtime = {
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      createElement: () => new FakeElement(),
    } as unknown as Document,
    dispatchEvent: (event: Event) => {
      events.push(event.type);
      return true;
    },
  };
  return { elements, purposes, events, runtime };
}

const aiStatus = {
  activeId: "profile-1",
  assignments: {
    readingId: "profile-1",
    libraryId: "",
    otherId: "",
  },
  profiles: [
    {
      id: "profile-1",
      name: "主力模型",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-v4-flash",
      configured: true,
    },
  ],
};

const translationStatus = {
  activeProvider: "baidu",
  profiles: [
    { provider: "baidu", configured: true },
    { provider: "deepl", configured: false },
  ],
};

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function exercise(legacy: boolean) {
  const view = fixture();
  const calls: Array<{
    readonly command: string;
    readonly args?: Record<string, unknown>;
  }> = [];
  const invoke = async <TResult,>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<TResult> => {
    calls.push(args ? { command, args } : { command });
    if (
      command === "ai_reader_profiles" ||
      command === "assign_ai_reader_profile" ||
      command === "save_ai_reader_profile"
    ) {
      return aiStatus as TResult;
    }
    if (
      command === "translation_credentials_status" ||
      command === "set_translation_active_provider"
    ) {
      return translationStatus as TResult;
    }
    return {} as TResult;
  };
  const target: Record<string, unknown> = {
    ...view.runtime,
    CustomEvent,
  };
  target.window = target;
  let api: ApiSettingsGlobalApi;
  if (legacy) {
    vm.runInNewContext(classicSource(), target);
    api = target.ReaderApiSettingsUI as ApiSettingsGlobalApi;
  } else {
    const transport: TauriTransport = { invoke };
    api = installApiSettingsUi(target, transport) as ApiSettingsGlobalApi;
  }
  api.init({ invoke });
  view.elements["api-settings-open"]?.fire("click");
  await settle();

  const library = view.purposes[1];
  if (library) view.elements["api-ai-purpose-picker"]?.fire("click", library);
  await settle();

  const name = view.elements["api-ai-name"];
  const provider = view.elements["api-ai-provider"];
  const baseUrl = view.elements["api-ai-base-url"];
  const model = view.elements["api-ai-model"];
  const key = view.elements["api-ai-key"];
  if (name) name.value = "新配置";
  if (provider) provider.value = "openai";
  if (baseUrl) baseUrl.value = "https://api.openai.com/v1";
  if (model) model.value = "gpt-next";
  if (key) key.value = "secret";
  view.elements["api-ai-save"]?.fire("click");
  await settle();

  const translationProvider = view.elements["api-translation-provider"];
  const translationId = view.elements["api-translation-id"];
  const translationKey = view.elements["api-translation-key"];
  if (translationProvider) translationProvider.value = "baidu";
  if (translationId) translationId.value = "app-id";
  if (translationKey) translationKey.value = "app-key";
  view.elements["api-translation-save"]?.fire("click");
  await settle();

  return {
    calls: plain(calls),
    events: view.events,
    apiKeys: Object.keys(api).sort(),
    modal: [...(view.elements["api-settings-modal"]?.classList.values ?? [])],
    profileOptions: view.elements["api-ai-profile"]?.children.map((option) => ({
      value: option.value,
      text: option.textContent,
    })),
    assignment: view.purposes.map((button) => ({
      purpose: button.dataset.aiPurpose,
      selected: button.classList.values.has("is-selected"),
      pressed: button.getAttribute("aria-pressed"),
      disabled: button.disabled,
    })),
    aiStatus: view.elements["api-ai-status"]?.textContent,
    translationSummary:
      view.elements["api-translation-summary"]?.textContent,
    translationStatus:
      view.elements["api-translation-status"]?.textContent,
    keyPlaceholder: view.elements["api-ai-key"]?.placeholder,
  };
}

test("strict installer remains behavior-equivalent to the classic VM", async () => {
  assert.deepEqual(await exercise(false), await exercise(true));
});

test("typed transport receives exact credential commands and request envelopes", async () => {
  const state = await exercise(false);
  const calls = state.calls as Array<{
    readonly command: string;
    readonly args?: Record<string, unknown>;
  }>;
  assert.deepEqual(calls.map(({ command }) => command), [
    "ai_reader_profiles",
    "translation_credentials_status",
    "assign_ai_reader_profile",
    "save_ai_reader_profile",
    "save_translation_credential",
    "set_translation_active_provider",
  ]);
  assert.deepEqual(calls[2]?.args, {
    request: { purpose: "library", id: "profile-1" },
  });
  assert.deepEqual(calls[3]?.args, {
    request: {
      id: "profile-1",
      name: "新配置",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-next",
      apiKey: "secret",
    },
  });
  assert.deepEqual(calls[4]?.args, {
    request: { provider: "baidu", apiId: "app-id", apiKey: "app-key" },
  });
  assert.deepEqual(calls[5]?.args, { provider: "baidu" });
});

test("public compatibility API is frozen and keeps the single init entry", () => {
  const api = installApiSettingsUi(fixture().runtime);
  assert.ok(api);
  assert.deepEqual(Object.keys(api), ["init"]);
  assert.equal(Object.isFrozen(api), true);
});
