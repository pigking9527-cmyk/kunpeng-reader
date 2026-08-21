import assert from "node:assert/strict";
import test from "node:test";

import { createSupportController, legacySupportDomIds, type SupportRenderer } from "./support-controller.ts";
import type { SupportPort } from "./support-port.ts";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

function port(overrides: Partial<SupportPort> = {}): SupportPort {
  return {
    loadAbout: async () => ({ appVersion: "1.0.0" }),
    loadCurrentReleaseNotes: async () => ({ version: "1.0.0", markdown: "- 修复" }),
    checkForUpdates: async () => ({ hasUpdate: false }),
    ignoreUpdate: async () => undefined,
    openExternal: async () => undefined,
    prepareFeedbackImages: async () => [],
    captureRedactedDiagnostics: async () => null,
    saveRedactedProblemTraceToDesktop: async () => undefined,
    submitFeedback: async () => ({ id: "feedback" }),
    releaseFeedbackAttachments: () => undefined,
    loadDiagnostics: async () => ({ appVersion: "1.0.0" }),
    exportRedactedDiagnostics: async () => undefined,
    enableSafeMode: async () => undefined,
    ...overrides,
  };
}

test("support controller uses the existing legacy DOM ids without defining a second surface", () => {
  assert.deepEqual(legacySupportDomIds, {
    aboutModal: "about-modal",
    aboutVersion: "about-ver",
    aboutClose: "about-close",
    aboutUpdate: "about-update",
    aboutNotes: "about-notes",
    updateBar: "update-bar",
    updateCurrentVersion: "ub-current",
    updateLatestVersion: "ub-ver",
    updateNotes: "ub-notes",
    updateView: "ub-view",
    updateIgnore: "ub-ignore",
    updateClose: "ub-close",
  });
});

test("opening loads the typed about and release-note boundaries and renders only state", async () => {
  const rendered: string[] = [];
  const renderer: SupportRenderer = { render: (state) => rendered.push(`${state.about.phase}/${state.releaseNotes.phase}`) };
  const controller = createSupportController(port(), renderer);

  await controller.open();

  assert.equal(controller.getState().visible, true);
  assert.deepEqual(controller.getState().about, { phase: "ready", info: { appVersion: "1.0.0" } });
  assert.deepEqual(controller.getState().releaseNotes, { phase: "ready", value: { version: "1.0.0", markdown: "- 修复" } });
  assert.deepEqual(rendered, ["loading/loading", "ready/loading", "ready/ready"]);
});

test("close aborts both initial loads and rejects late completions", async () => {
  const about = deferred<{ appVersion: string }>();
  const notes = deferred<{ version: string; markdown: string }>();
  let aboutSignal: AbortSignal | undefined;
  let notesSignal: AbortSignal | undefined;
  const controller = createSupportController(port({
    loadAbout: (signal) => { aboutSignal = signal; return about.promise; },
    loadCurrentReleaseNotes: (signal) => { notesSignal = signal; return notes.promise; },
  }));

  const opening = controller.open();
  controller.close();
  assert.equal(aboutSignal?.aborted, true);
  assert.equal(notesSignal?.aborted, true);
  about.resolve({ appVersion: "late" });
  notes.resolve({ version: "late", markdown: "late" });
  await opening;

  assert.equal(controller.getState().visible, false);
  assert.equal(controller.getState().about.phase, "loading");
  assert.equal(controller.getState().releaseNotes.phase, "loading");
});

test("failed load uses fixed fallback copy and never exposes a port error", async () => {
  const controller = createSupportController(port({
    loadAbout: async () => { throw new Error("/private/local/path"); },
    loadCurrentReleaseNotes: async () => { throw new Error("network host detail"); },
  }));

  await controller.open();

  assert.equal(controller.getState().about.phase, "failure");
  assert.equal(controller.getState().releaseNotes.phase, "failure");
  assert.match(controller.getState().notice, /暂无此版本/);
  assert.doesNotMatch(controller.getState().notice, /private|network/i);
});

test("update availability can be opened or ignored and close aborts the request", async () => {
  const opened: string[] = [];
  let ignored = "";
  const pendingUpdate = deferred<{ hasUpdate: boolean; latestVersion?: string; releaseUrl?: string }>();
  let updateSignal: AbortSignal | undefined;
  const controller = createSupportController(port({
    checkForUpdates: (signal) => { updateSignal = signal; return pendingUpdate.promise; },
    ignoreUpdate: async (version) => { ignored = version; },
    openExternal: async (url) => { opened.push(url); },
  }));
  await controller.open();

  const checking = controller.checkForUpdates();
  controller.close();
  assert.equal(updateSignal?.aborted, true);
  pendingUpdate.resolve({ hasUpdate: true, latestVersion: "1.1.0", releaseUrl: "https://example.test/update" });
  await checking;
  assert.equal(controller.getState().update.phase, "checking");

  const available = createSupportController(port({
    checkForUpdates: async () => ({ hasUpdate: true, latestVersion: "1.1.0", releaseUrl: "https://example.test/update" }),
    ignoreUpdate: async (version) => { ignored = version; },
    openExternal: async (url) => { opened.push(url); },
  }));
  await available.open();
  await available.checkForUpdates();
  await available.openAvailableUpdate();
  await available.ignoreAvailableUpdate();
  assert.deepEqual(opened, ["https://example.test/update"]);
  assert.equal(ignored, "1.1.0");
  assert.equal(available.getState().update.phase, "idle");
});

test("dispose clears subscriptions and makes the feature permanently inert", async () => {
  let notifications = 0;
  const controller = createSupportController(port());
  controller.subscribe(() => { notifications += 1; });
  controller.dispose();
  await controller.open();
  await controller.checkForUpdates();

  assert.equal(controller.getState().about.phase, "closed");
  assert.equal(notifications, 0);
});
