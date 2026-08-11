import assert from "node:assert/strict";
import test from "node:test";
import { createLegacySupportPort } from "./support-legacy-port.ts";
import type { LegacySupportPortEnvironment } from "./support-legacy-port.ts";

function storage(): Pick<Storage, "getItem" | "setItem"> & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key: string): string | null { return values.get(key) ?? null; },
    setItem(key: string, value: string): void { values.set(key, value); },
  };
}

function environment(overrides: Partial<LegacySupportPortEnvironment> = {}): LegacySupportPortEnvironment {
  return {
    invoke: async (command: string): Promise<unknown> => command === "app_version" ? "1.15.0" : {},
    storage: storage(),
    userAgent: "test-agent",
    createAttachmentId: () => "attachment-1",
    clickLegacyDiagnosticsExport: () => undefined,
    enableLegacySafeMode: () => undefined,
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    ...overrides,
  };
}

function file(name: string, type: string, bytes: readonly number[]): File {
  return {
    name,
    type,
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  } as unknown as File;
}

test("support port loads and caches current release notes, returns update notes, and stores only a validated ignored version", async () => {
  const local = storage();
  const calls: string[] = [];
  const port = createLegacySupportPort(environment({
    storage: local,
    invoke: async (command: string): Promise<unknown> => {
      calls.push(command);
      if (command === "app_version") return "1.15.0";
      if (command === "release_notes") return "- 修复阅读位置";
      if (command === "check_update") return {
        has_update: true,
        latest: "1.16.0",
        notes: "- 修复同步",
        url: "https://example.test/releases/1.16.0",
      };
      return {};
    },
  }));
  const controller = new AbortController();

  assert.deepEqual(await port.loadCurrentReleaseNotes(controller.signal), {
    version: "1.15.0",
    markdown: "- 修复阅读位置",
  });
  assert.equal(local.values.get("notes_v1.15.0"), "- 修复阅读位置");
  assert.deepEqual(await port.checkForUpdates(controller.signal), {
    hasUpdate: true,
    latestVersion: "1.16.0",
    releaseUrl: "https://example.test/releases/1.16.0",
    releaseNotes: "- 修复同步",
  });
  await port.ignoreUpdate("v1.16.0", controller.signal);
  assert.equal(local.values.get("ignoredUpdate"), "1.16.0");
  await assert.rejects(port.ignoreUpdate("../private", controller.signal), /Support operation failed/);
  assert.deepEqual(calls, ["app_version", "release_notes", "check_update"]);
});

test("cached release notes remain available when the native lookup fails", async () => {
  const local = storage();
  local.values.set("notes_v1.15.0", "- 离线说明");
  const port = createLegacySupportPort(environment({
    storage: local,
    invoke: async (command: string): Promise<unknown> => {
      if (command === "app_version") return "1.15.0";
      throw new Error("network details must not reach the feature layer");
    },
  }));

  assert.deepEqual(await port.loadCurrentReleaseNotes(new AbortController().signal), {
    version: "1.15.0",
    markdown: "- 离线说明",
  });
});

test("problem-record save never returns the desktop path and always releases its opaque bytes", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const port = createLegacySupportPort(environment({
    captureProblemTrace: async () => ({ captured_at: "2026-08-11T00:00:00.000Z", events: [] }),
    invoke: async (command: string, args?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ command, ...(args ? { args } : {}) });
      if (command === "save_problem_trace_to_desktop") return "/Users/test/Desktop/private-trace.json";
      return "1.15.0";
    },
  }));
  const result = await port.saveRedactedProblemTraceToDesktop(new AbortController().signal);

  assert.equal(result, undefined);
  assert.deepEqual(calls.map((entry) => entry.command), ["save_problem_trace_to_desktop"]);
  const request = calls[0]?.args;
  assert.equal(request?.name, "kunpeng-reader-problem-trace-2026-08-11T00-00-00-000Z.json");
  assert.equal(typeof request?.data, "string");
});

test("accepted feedback releases image bytes and native failures are replaced with generic errors", async () => {
  let submitted = false;
  const port = createLegacySupportPort(environment({
    invoke: async (command: string): Promise<unknown> => {
      if (command === "app_version") return "1.15.0";
      if (command === "submit_feedback") { submitted = true; return { ok: true, id: "feedback-1" }; }
      throw new Error("/private/native-detail");
    },
  }));
  const controller = new AbortController();
  const [image] = await port.prepareFeedbackImages([file("screen.png", "image/png", [1, 2, 3])], controller.signal);
  assert.ok(image);
  await port.submitFeedback({ kind: "bug", text: "test", imageAttachmentIds: [image.id] }, controller.signal);
  assert.equal(submitted, true);
  await assert.rejects(
    port.submitFeedback({ kind: "bug", text: "retry", imageAttachmentIds: [image.id] }, controller.signal),
    (error: unknown) => error instanceof Error && error.message === "Support operation failed.",
  );
  await assert.rejects(
    port.openExternal("https://example.test", controller.signal),
    (error: unknown) => error instanceof Error && error.message === "Support operation failed.",
  );
});
