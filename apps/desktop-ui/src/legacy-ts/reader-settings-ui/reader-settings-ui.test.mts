import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type { TauriTransport } from "../../../../../packages/tauri-api/src/index.ts";
import { installReaderSettingsUi } from "./reader-settings-ui.ts";

const repositoryRoot = new URL("../../../../../", import.meta.url);
const viteCli = fileURLToPath(
  new URL("../../../../../node_modules/vite/bin/vite.js", import.meta.url),
);

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
  public readonly dataset: Record<string, string> = {};
  public readonly children: FakeElement[] = [];
  public readonly options: FakeElement[] = [];
  public contentWindow: {
    postMessage(value: unknown, target: string): void;
  } | null = null;
  public parentNode: FakeElement | null = null;
  public selectedIndex = 0;
  public value = "";
  public min = "";
  public max = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public textContent = "";
  public className = "";
  public innerHTML = "";
  public title = "";
  public offsetWidth = 100;
  public toggleAttribute(): void {}
  public addEventListener(): void {}
  public dispatchEvent(): boolean {
    return true;
  }
  public click(): void {}
  public closest(): FakeElement | null {
    return null;
  }
  public querySelector(): FakeElement | null {
    return null;
  }
  public querySelectorAll(): FakeElement[] {
    return [];
  }
  public insertBefore(): void {}
  public setAttribute(): void {}
}

interface CapturedCall {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function fixture(initialSettings: Record<string, unknown> = {}) {
  const storageValues = new Map<string, string>([
    ["readerSettings", JSON.stringify(initialSettings)],
  ]);
  const writes: Array<{ key: string; value: string }> = [];
  const listeners = new Map<string, EventListenerOrEventListenerObject[]>();
  const timers: Array<() => void> = [];
  const messages: unknown[] = [];
  const calls: CapturedCall[] = [];
  let syncedHandler: (() => void) | null = null;
  const body = new FakeElement();
  const frame = new FakeElement();
  frame.contentWindow = { postMessage: (value) => messages.push(value) };
  const elements = new Map<string, FakeElement>([
    ["prev-btn", new FakeElement()],
    ["next-btn", new FakeElement()],
    ["vocab-btn", new FakeElement()],
    ["frame", frame],
  ]);
  const document = {
    body,
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => new FakeElement(),
    addEventListener: () => undefined,
  } as unknown as Document;
  const runtime: Record<string, unknown> = {
    document,
    localStorage: {
      getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storageValues.set(key, value);
        writes.push({ key, value });
      },
    },
    navigator: { userAgent: "test" },
    frame,
    isPdf: false,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    },
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
    addEventListener: (
      type: string,
      listener: EventListenerOrEventListenerObject,
    ) => {
      const values = listeners.get(type) ?? [];
      values.push(listener);
      listeners.set(type, values);
    },
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      }
      return true;
    },
  };
  const transport: TauriTransport = {
    invoke: async <TResult,>(
      command: string,
      args?: Record<string, unknown>,
    ) => {
      calls.push(args ? { command, args } : { command });
      if (command === "app_settings_sync_get")
        return { exists: false } as TResult;
      if (command === "app_settings_sync_save")
        return { exists: true } as TResult;
      if (command === "reader_font_status") return [] as TResult;
      return null as TResult;
    },
    listen: async (_event, handler) => {
      syncedHandler = () =>
        (
          handler as (event: {
            event: string;
            id: number;
            payload: unknown;
          }) => void
        )({
          event: "app-settings-synced",
          id: 1,
          payload: null,
        });
      return () => undefined;
    },
  };
  const fire = (type: string, event: Event = new Event(type)) => {
    for (const listener of listeners.get(type) ?? []) {
      if (typeof listener === "function") listener(event);
      else listener.handleEvent(event);
    }
  };
  return {
    runtime,
    transport,
    storageValues,
    writes,
    timers,
    messages,
    calls,
    fire,
    syncedHandler: () => syncedHandler,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("installer freezes the original public globals and sanitizes legacy storage", async () => {
  const view = fixture({
    theme: "dark",
    customBackgroundImage: "data:image/png;base64," + "a".repeat(170000),
  });
  const installed = installReaderSettingsUi(view.runtime, {
    transport: view.transport,
  });
  assert.ok(installed);
  assert.deepEqual(Object.keys(installed).sort(), [
    "ReaderSettings",
    "applyShellTheme",
    "initSettingsUI",
    "settings",
  ]);
  assert.deepEqual(Object.keys(installed.ReaderSettings).sort(), [
    "applyDeferredSettings",
    "applyToolbarVisibility",
    "clearBookAppearance",
    "clickActionAt",
    "get",
    "getAppearance",
    "hasBookAppearance",
    "setBookContext",
    "update",
    "updateAppearance",
  ]);
  assert.equal(Object.isFrozen(installed), true);
  assert.equal(Object.isFrozen(installed.ReaderSettings), true);
  assert.equal(installed.settings.customBackgroundImage, "");
  assert.equal(installed.settings.backgroundPreset, "dark");
  await flushPromises();
  assert.deepEqual(view.calls[0], { command: "app_settings_sync_get" });
  assert.equal(typeof view.syncedHandler(), "function");

  const legacyJumpBack = fixture({ readerJumpBackSizeLevel: 8 });
  installReaderSettingsUi(legacyJumpBack.runtime, {
    transport: legacyJumpBack.transport,
  });
  const migrated = JSON.parse(
    legacyJumpBack.storageValues.get("readerSettings") ?? "null",
  ) as Record<string, unknown>;
  assert.equal(migrated.readerJumpBackSizeLevel, undefined);
});

test("settings API preserves click zones, book appearance, storage, iframe and native envelopes", async () => {
  const view = fixture();
  const installed = installReaderSettingsUi(view.runtime, {
    transport: view.transport,
  });
  assert.ok(installed);
  await flushPromises();
  installed.ReaderSettings.update({
    clickZones: [
      { id: "only", action: "next", x: 0, y: 0, width: 1000, height: 1000 },
    ],
    flowMode: "paged",
    fontSize: 21,
    epubLayoutEngine: "modern",
  });
  assert.equal(
    installed.ReaderSettings.clickActionAt(50, 50, 100, 100),
    "next",
  );
  assert.equal(installed.ReaderSettings.clickActionAt(0, 0, 0, 0), "next");
  assert.equal(
    (view.messages.at(-1) as { settings: { fontSize: number } }).settings
      .fontSize,
    21,
  );
  assert.equal(
    (view.messages.at(-1) as { settings: { epubLayoutEngine: string } }).settings
      .epubLayoutEngine,
    "modern",
  );
  assert.deepEqual(view.calls.at(-1), {
    command: "set_reader_paged_wheel_momentum_filter",
    args: { enabled: true },
  });
  installed.ReaderSettings.setBookContext("book-1");
  installed.ReaderSettings.updateAppearance(
    { textColor: "#123456", showTocButton: false },
    "book",
  );
  assert.equal(installed.ReaderSettings.hasBookAppearance(), true);
  assert.equal(
    installed.ReaderSettings.getAppearance("book").textColor,
    "#123456",
  );
  assert.equal(
    installed.ReaderSettings.getAppearance("book").showTocButton,
    true,
  );
  installed.ReaderSettings.clearBookAppearance();
  assert.equal(installed.ReaderSettings.hasBookAppearance(), false);
  view.fire("pagehide");
  assert.deepEqual(view.calls.at(-1), {
    command: "set_reader_paged_wheel_momentum_filter",
    args: { enabled: false },
  });
  view.fire("reader-settings-changed");
  for (const timer of view.timers.splice(0)) timer();
  await flushPromises();
  const save = [...view.calls]
    .reverse()
    .find((call) => call.command === "app_settings_sync_save");
  assert.equal(save?.args?.request && typeof save.args.request, "object");
  assert.equal(
    (save?.args?.request as { readerJumpBackIconSizePx: number })
      .readerJumpBackIconSizePx,
    32,
  );
  assert.equal(
    (save?.args?.request as { readerLayoutSettings: { fontSize: number } })
      .readerLayoutSettings.fontSize,
    21,
  );
  assert.equal(
    (save?.args?.request as { epubLayoutEngine: string }).epubLayoutEngine,
    "modern",
  );
});

test("controller source is strict, single-UI and emits a standalone classic installer", () => {
  const source = readFileSync(
    new URL("./reader-settings-ui.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /\bany\b|@ts-|eval\(|React|\.tsx|__TAURI__/u);
  assert.match(source, /global\.ReaderSettings = ReaderSettings/u);
  assert.match(source, /global\.applyShellTheme = applyShellTheme/u);
  assert.match(source, /global\.initSettingsUI = initSettingsUI/u);
  const output = execFileSync(
    process.execPath,
    [viteCli, "build", "--config", "apps/desktop-ui/vite.legacy-ts.config.ts"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        KUNPENG_LEGACY_TS_SOURCE: fileURLToPath(
          new URL("./reader-settings-ui.ts", import.meta.url),
        ),
        KUNPENG_LEGACY_TS_OUTPUT_DIRECTORY:
          "/tmp/kunpeng-reader-settings-ui-test",
        KUNPENG_LEGACY_TS_OUTPUT: "reader-settings-ui.js",
        KUNPENG_LEGACY_TS_GLOBAL_NAME: "KunpengReaderSettingsUi",
        KUNPENG_LEGACY_TS_INSTALL_EXPORT: "installReaderSettingsUi",
      },
    },
  );
  assert.match(output, /built in/u);
});
