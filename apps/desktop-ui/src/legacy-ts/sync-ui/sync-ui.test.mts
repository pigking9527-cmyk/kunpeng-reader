import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { TauriEvent, TauriTransport } from "../../../../../packages/tauri-api/src/index.js";
import { installSyncUi } from "./sync-ui.ts";

type Handler = (event?: Record<string, unknown>) => unknown;

class FakeElement {
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public value = "";
  public textContent = "";
  public className = "";
  public title = "";
  public placeholder = "";
  public disabled = false;
  public hidden = false;
  public checked = false;
  public open = false;
  public type = "";
  public innerHTML = "";
  public min = "";
  public max = "";
  private readonly classes = new Set<string>();
  private readonly handlers = new Map<string, Handler>();

  public readonly classList = {
    add: (...names: string[]) => names.forEach((name) => this.classes.add(name)),
    contains: (name: string) => this.classes.has(name),
    remove: (...names: string[]) => names.forEach((name) => this.classes.delete(name)),
    toggle: (name: string, force?: boolean) => {
      if (force === undefined) {
        if (this.classes.has(name)) this.classes.delete(name);
        else this.classes.add(name);
      } else if (force) this.classes.add(name);
      else this.classes.delete(name);
      return this.classes.has(name);
    },
  };

  public addEventListener(name: string, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  public emit(name: string): unknown {
    return this.handlers.get(name)?.({
      preventDefault() {},
      stopPropagation() {},
    });
  }

  public append(...children: unknown[]): void { void children; }
  public appendChild(child: unknown): void { void child; }
  public contains(child: unknown): boolean { void child; return true; }
  public focus(): void {}
  public setAttribute(name: string, value: string): void { void name; void value; }
  public querySelectorAll<TElement>(): TElement[] { return []; }
}

interface RecordedCall {
  readonly command: string;
  readonly args?: Record<string, unknown>;
}

function createHarness({
  savedAccounts = [],
}: {
  readonly savedAccounts?: Array<{ readonly username: string; readonly saved_at: number }>;
} = {}) {
  const elements = new Map<string, FakeElement>();
  const element = (id: string): FakeElement => {
    const existing = elements.get(id);
    if (existing) return existing;
    const created = new FakeElement();
    elements.set(id, created);
    return created;
  };
  const storageValues = new Map<string, string>();
  if (savedAccounts.length) {
    storageValues.set("readerSavedAccountsV1", JSON.stringify(savedAccounts));
  }
  const storage = {
    getItem: (key: string) => storageValues.get(key) ?? null,
    removeItem: (key: string) => { storageValues.delete(key); },
    setItem: (key: string, value: string) => { storageValues.set(key, value); },
  };
  const calls: RecordedCall[] = [];
  const eventHandlers = new Map<string, (event: TauriEvent<unknown>) => void>();
  let rejectedSync: "busy" | "offline" | null = null;
  let rejectedLogin = false;
  const transport: TauriTransport = {
    async invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
      calls.push({ command, ...(args ? { args } : {}) });
      if (command === "auth_login") {
        if (rejectedLogin) throw new Error("账号或密码错误");
        return { user: { username: "reader" } } as TResult;
      }
      if (command === "auth_register_confirm") {
        return { user: { username: "reader" }, sync_enabled: true } as TResult;
      }
      if (command === "sync_now") {
        if (rejectedSync === "busy") throw new Error("同步任务正在进行");
        if (rejectedSync === "offline") throw new Error("offline");
        return { message: "ok", server_time: 1, pushed: 1, pulled: 2, accepted: 1, ignored: 0 } as TResult;
      }
      if (command === "shelf_books") return [] as TResult;
      return {} as TResult;
    },
    async listen<TPayload>(event: string, handler: (event: TauriEvent<TPayload>) => void) {
      eventHandlers.set(event, handler as (event: TauriEvent<unknown>) => void);
      return () => { eventHandlers.delete(event); };
    },
  };
  const runtime = {
    localStorage: storage,
    confirm: () => true,
    setInterval: () => 1,
    clearInterval() {},
  };
  const sync = installSyncUi(runtime);
  assert.ok(sync);
  sync.init({
    root: {
      createElement: () => new FakeElement(),
      getElementById: (id: string) => element(id),
    } as unknown as Document,
    transport,
    storage,
    menuElement: new FakeElement() as unknown as HTMLElement,
    filterPanel: new FakeElement() as unknown as HTMLElement,
    renderShelf() {},
  });
  return {
    calls,
    element,
    emitNativeEvent: async (event: string) => {
      eventHandlers.get(event)?.({ event, id: 1, payload: null });
      await Promise.resolve();
      await Promise.resolve();
    },
    rejectBusySync: () => { rejectedSync = "busy"; },
    rejectLogin: () => { rejectedLogin = true; },
    rejectSync: () => { rejectedSync = "offline"; },
  };
}

test("registration remains a two-stage flow and start never receives credentials", async () => {
  const harness = createHarness();
  const secret = "x".repeat(8);
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "";
  await harness.element("sync-register").emit("click");
  assert.equal(harness.element("sync-registration").hidden, false);
  assert.equal(
    harness.element("sync-form").classList.contains("registration-open"),
    true,
  );

  harness.element("sync-register-email").value = "reader@example.invalid";
  await harness.element("sync-register-code-request").emit("click");
  const start = harness.calls.at(-1);
  assert.equal(start?.command, "auth_register_start");
  const startRequest = start?.args?.request as Record<string, unknown>;
  assert.deepEqual(Object.keys(startRequest).sort(), ["email", "url", "username"]);
  assert.equal("password" in startRequest, false);
  assert.equal("code" in startRequest, false);

  harness.element("sync-register-code").value = "123456";
  harness.element("sync-password").value = secret;
  await harness.element("sync-register-confirm").emit("click");
  const confirm = harness.calls.find((call) => call.command === "auth_register_confirm");
  assert.ok(confirm);
  const confirmRequest = confirm.args?.request as Record<string, unknown>;
  assert.equal(confirmRequest.password, secret);
  assert.equal(confirmRequest.code, "123456");
  assert.equal(harness.calls.some((call) => call.command === "auth_register"), false);
});

test("registration accepts eight Unicode characters and rejects more than thirty-two", async () => {
  const harness = createHarness();
  harness.element("sync-username").value = "reader";
  await harness.element("sync-register").emit("click");
  harness.element("sync-register-code").value = "123456";

  harness.element("sync-password").value = "密".repeat(8);
  await harness.element("sync-register-confirm").emit("click");
  assert.equal(
    harness.calls.filter((call) => call.command === "auth_register_confirm").length,
    1,
  );

  harness.element("sync-password").value = "x".repeat(33);
  await harness.element("sync-register-confirm").emit("click");
  assert.equal(
    harness.calls.filter((call) => call.command === "auth_register_confirm").length,
    1,
  );
  assert.match(harness.element("sync-register-status").textContent, /8–32/);
});

test("successful login remains authenticated when its first sync fails", async () => {
  const harness = createHarness();
  harness.rejectSync();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);
  await harness.element("sync-login").emit("click");
  assert.deepEqual(harness.calls.map((call) => call.command), ["auth_login", "sync_now"]);
  assert.equal(harness.element("sync-account").classList.contains("show"), true);
  assert.equal(harness.element("account-panel").dataset.accountTab, "overview");
  assert.equal(harness.element("sync-password").value, "");
  assert.equal(harness.element("sync-now").classList.contains("fail"), true);
});

test("saved account history opens only after a username click", () => {
  const harness = createHarness({
    savedAccounts: [{ username: "reader", saved_at: 1 }],
  });

  harness.element("sync-username").emit("focus");
  assert.equal(harness.element("saved-accounts").classList.contains("show"), false);

  harness.element("sync-username").emit("click");
  assert.equal(harness.element("saved-accounts").classList.contains("show"), true);
});

test("failed login keeps the credential form open and shows its reason", async () => {
  const harness = createHarness();
  harness.rejectLogin();
  harness.element("account-panel").classList.add("logged-out", "auth-entry");
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");

  assert.equal(harness.element("sync-form").classList.contains("hidden"), false);
  assert.match(harness.element("sync-auth-status").textContent, /账号或密码错误/);
  assert.equal(harness.element("sync-auth-status").className, "sync-auth-status error");
});

test("an already-running initial sync remains in progress instead of failing", async () => {
  const harness = createHarness();
  harness.rejectBusySync();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");

  assert.equal(harness.element("sync-now").classList.contains("syncing"), true);
  assert.equal(harness.element("sync-now").classList.contains("fail"), false);
  assert.match(harness.element("sync-last-counts").textContent, /同步任务正在进行/);
});

test("automatic sync terminal events settle an initial busy state", async () => {
  const harness = createHarness();
  harness.rejectBusySync();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");
  await harness.emitNativeEvent("app-settings-synced");

  assert.equal(harness.element("sync-now").classList.contains("syncing"), false);
  assert.equal(harness.element("sync-now").classList.contains("ok"), true);
  assert.equal(harness.element("sync-last-counts").textContent, "");
  assert.equal(harness.element("sync-last-counts").hidden, true);
});

test("automatic sync failure event clears an initial busy state", async () => {
  const harness = createHarness();
  harness.rejectBusySync();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");
  await harness.emitNativeEvent("app-settings-sync-failed");

  assert.equal(harness.element("sync-now").classList.contains("syncing"), false);
  assert.equal(harness.element("sync-now").classList.contains("fail"), true);
});

test("a recovered background sync clears an earlier offline failure", async () => {
  const harness = createHarness();
  harness.rejectBusySync();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");
  await harness.emitNativeEvent("app-settings-sync-failed");
  assert.equal(harness.element("sync-now").classList.contains("fail"), true);

  await harness.emitNativeEvent("app-settings-synced");
  assert.equal(harness.element("sync-now").classList.contains("ok"), true);
  assert.equal(harness.element("sync-now").classList.contains("fail"), false);
});

test("logged-out account opens its original overview before the compact auth subpage", async () => {
  const harness = createHarness();
  harness.element("sync-username").value = "reader";
  harness.element("sync-password").value = "x".repeat(8);

  await harness.element("sync-login").emit("click");
  assert.equal(
    harness.element("account-panel").classList.contains("logged-out"),
    false,
  );

  await harness.element("sync-logout").emit("click");
  assert.equal(
    harness.element("account-panel").classList.contains("logged-out"),
    true,
  );
  assert.equal(
    harness.element("account-panel").classList.contains("auth-entry"),
    false,
  );
  assert.equal(harness.element("sync-account").classList.contains("show"), true);
  assert.equal(harness.element("sync-form").classList.contains("hidden"), true);

  await harness.element("account-auth-open").emit("click");
  assert.equal(
    harness.element("account-panel").classList.contains("auth-entry"),
    true,
  );
  assert.equal(harness.element("sync-account").classList.contains("show"), false);
  assert.equal(harness.element("sync-form").classList.contains("hidden"), false);

  await harness.element("account-btn").emit("click");
  await harness.element("account-btn").emit("click");
  assert.equal(
    harness.element("account-panel").classList.contains("auth-entry"),
    false,
  );
  assert.equal(harness.element("sync-account").classList.contains("show"), true);
  assert.equal(harness.element("sync-last-counts").textContent, "");
  assert.equal(harness.element("sync-last-counts").hidden, true);
});

test("opening a remembered account never requests its protected token", async () => {
  const harness = createHarness();
  harness.element("sync-username").value = "reader";

  await harness.element("account-btn").emit("click");
  await Promise.resolve();

  assert.equal(
    harness.calls.some((call) => call.command === "auth_usage_status"),
    false,
  );
});

test("a reachable quota endpoint cannot repaint a failed sync as healthy", async () => {
  const harness = createHarness();
  harness.rejectSync();
  harness.element("sync-username").value = "reader";
  await harness.element("sync-now").emit("click");
  await Promise.resolve();

  assert.equal(harness.element("sync-now").classList.contains("fail"), true);
  assert.equal(
    harness.element("account-overview-sync-state").classList.contains("offline"),
    true,
  );
  assert.equal(harness.element("account-overview-sync-label").textContent, "syncFailed");
  assert.equal(
    harness.calls.some((call) => call.command === "auth_usage_status"),
    true,
  );
});

test("strict sync shell has no direct Tauri global or credential logging", () => {
  const source = readFileSync(new URL("./sync-ui.ts", import.meta.url), "utf8");
  assert.match(source, /createTauriApi<VerifiedSyncCommands>/);
  assert.doesNotMatch(source, /__TAURI__/);
  assert.doesNotMatch(source, /console\.(?:log|info|warn|error)/);
  assert.doesNotMatch(source, /invoke\("auth_register",/);
});
