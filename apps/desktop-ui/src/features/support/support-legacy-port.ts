import type {
  AboutInfo,
  CurrentReleaseNotes,
  DiagnosticsSummary,
  FeedbackDraft,
  FeedbackSubmission,
  PreparedAttachment,
  SupportPort,
  UpdateInfo,
} from "./support-port.js";

interface StoredFeedbackAttachment {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly bytes: number;
  readonly data: string;
}

export interface LegacySupportPortEnvironment {
  readonly invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  readonly captureProblemTrace?: () => Promise<unknown>;
  readonly storage: Pick<Storage, "getItem" | "setItem">;
  readonly userAgent: string;
  readonly createAttachmentId: () => string;
  readonly clickLegacyDiagnosticsExport: () => void;
  readonly enableLegacySafeMode: () => void;
  readonly now?: () => Date;
}

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_DIAGNOSTICS_BYTES = 4 * 1024 * 1024;
const CURRENT_NOTES_STORAGE_PREFIX = "notes_v";
const IGNORED_UPDATE_STORAGE_KEY = "ignoredUpdate";

function abort(): never {
  throw new DOMException("The operation was cancelled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) abort();
}

function supportFailure(): Error {
  // The caller intentionally receives no native path, server response, or
  // attachment details. The caller turns this into user-facing generic copy.
  return new Error("Support operation failed.");
}

async function safeSupportRequest<T>(signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  throwIfAborted(signal);
  try {
    const value = await request();
    throwIfAborted(signal);
    return value;
  } catch (error: unknown) {
    if (signal.aborted || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")) {
      abort();
    }
    throw supportFailure();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function imageMime(file: File): "image/jpeg" | "image/png" | "image/webp" {
  if (file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp") return file.type;
  throw supportFailure();
}

function releaseVersion(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+(?:\.\d+){0,5}(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized) ? normalized : null;
}

function problemTraceName(now: Date): string {
  return `kunpeng-reader-problem-trace-${now.toISOString().replace(/[:.]/g, "-")}.json`;
}

/**
 * Adapter for the existing desktop commands and legacy-only support actions.
 * Attachment bytes stay in this closure; all public methods expose metadata or
 * opaque ids only. It is separately injectable so native failures and cleanup
 * can be tested without a WebView or a live feedback service.
 */
export function createLegacySupportPort(environment: LegacySupportPortEnvironment): SupportPort {
  const attachments = new Map<string, StoredFeedbackAttachment>();
  const now = environment.now ?? (() => new Date());

  const store = (name: string, mime: string, data: string, bytes: number): PreparedAttachment => {
    const id = environment.createAttachmentId();
    attachments.set(id, { id, name, mime, data, bytes });
    return { id, name, mime, bytes };
  };
  const attachmentFor = (id: string): StoredFeedbackAttachment => {
    const attachment = attachments.get(id);
    if (!attachment) throw supportFailure();
    return attachment;
  };
  const captureTrace = async (signal: AbortSignal): Promise<PreparedAttachment | null> => safeSupportRequest(signal, async () => {
    if (typeof environment.captureProblemTrace !== "function") return null;
    const snapshot = await environment.captureProblemTrace();
    if (!snapshot || typeof snapshot !== "object") return null;
    const contents = JSON.stringify(snapshot);
    const data = new TextEncoder().encode(contents);
    if (data.byteLength === 0 || data.byteLength > MAX_DIAGNOSTICS_BYTES) throw supportFailure();
    return store(problemTraceName(now()), "application/json", bytesToBase64(data), data.byteLength);
  });

  return {
    loadAbout: (signal: AbortSignal): Promise<AboutInfo> => safeSupportRequest(signal, async () => {
      const version = asText(await environment.invoke("app_version"));
      return { appVersion: version ?? "未知" };
    }),
    loadCurrentReleaseNotes: (signal: AbortSignal): Promise<CurrentReleaseNotes> => safeSupportRequest(signal, async () => {
      const version = releaseVersion(String(await environment.invoke("app_version"))) ?? "unknown";
      const storageKey = `${CURRENT_NOTES_STORAGE_PREFIX}${version}`;
      let cached = "";
      try {
        cached = environment.storage.getItem(storageKey) ?? "";
      } catch {
        // A read failure must not prevent the native/offline release-note fallback.
      }
      const remoteNotes = asText(await environment.invoke("release_notes", { tag: `v${version}` }).catch(() => ""));
      const markdown = remoteNotes ?? cached;
      if (markdown) {
        try {
          environment.storage.setItem(storageKey, markdown);
        } catch {
          // The release notes remain usable if local cache persistence is denied.
        }
      }
      return { version, markdown };
    }),
    checkForUpdates: (signal: AbortSignal): Promise<UpdateInfo> => safeSupportRequest(signal, async () => {
      const result = asRecord(await environment.invoke("check_update"));
      const latestVersion = asText(result.latest);
      const releaseUrl = asText(result.url);
      const releaseNotes = asText(result.notes);
      return {
        hasUpdate: result.has_update === true,
        ...(latestVersion ? { latestVersion } : {}),
        ...(releaseUrl ? { releaseUrl } : {}),
        ...(releaseNotes ? { releaseNotes } : {}),
      };
    }),
    ignoreUpdate: (version: string, signal: AbortSignal): Promise<void> => safeSupportRequest(signal, async () => {
      const safeVersion = releaseVersion(version);
      if (!safeVersion) throw supportFailure();
      environment.storage.setItem(IGNORED_UPDATE_STORAGE_KEY, safeVersion);
    }),
    openExternal: (url: string, signal: AbortSignal): Promise<void> => safeSupportRequest(signal, async () => {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw supportFailure();
      await environment.invoke("open_url", { url: parsed.href });
    }),
    prepareFeedbackImages: (files: readonly File[], signal: AbortSignal): Promise<readonly PreparedAttachment[]> => safeSupportRequest(signal, async () => {
      const prepared: PreparedAttachment[] = [];
      for (const file of files) {
        throwIfAborted(signal);
        const mime = imageMime(file);
        const data = new Uint8Array(await file.arrayBuffer());
        throwIfAborted(signal);
        if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) throw supportFailure();
        prepared.push(store(file.name || "feedback-image", mime, bytesToBase64(data), data.byteLength));
      }
      return prepared;
    }),
    captureRedactedDiagnostics: captureTrace,
    saveRedactedProblemTraceToDesktop: async (signal: AbortSignal): Promise<void> => {
      const trace = await captureTrace(signal);
      if (!trace) throw supportFailure();
      try {
        await safeSupportRequest(signal, async () => {
          const attachment = attachmentFor(trace.id);
          // Intentionally ignore the absolute desktop path returned by Rust.
          await environment.invoke("save_problem_trace_to_desktop", { name: attachment.name, data: attachment.data });
        });
      } finally {
        attachments.delete(trace.id);
      }
    },
    submitFeedback: (draft: FeedbackDraft, signal: AbortSignal): Promise<FeedbackSubmission> => safeSupportRequest(signal, async () => {
      const selectedIds = [...draft.imageAttachmentIds, ...(draft.diagnosticAttachmentId ? [draft.diagnosticAttachmentId] : [])];
      const images = draft.imageAttachmentIds.map(attachmentFor).map((attachment) => ({ name: attachment.name, mime: attachment.mime, data: attachment.data }));
      const diagnostic = draft.diagnosticAttachmentId ? attachmentFor(draft.diagnosticAttachmentId) : undefined;
      if (diagnostic && (draft.kind !== "bug" || diagnostic.mime !== "application/json")) throw supportFailure();
      const appVersion = String(await environment.invoke("app_version").catch(() => ""));
      const result = asRecord(await environment.invoke("submit_feedback", {
        request: {
          kind: draft.kind,
          text: draft.text,
          appVersion,
          platform: environment.userAgent,
          images,
          attachments: diagnostic ? [{ name: diagnostic.name, mime: diagnostic.mime, data: diagnostic.data }] : [],
        },
      }));
      if (result.ok !== true) throw supportFailure();
      // The server has accepted this submission, so retaining image/base64 data
      // would only keep private material in the renderer unnecessarily.
      selectedIds.forEach((id) => attachments.delete(id));
      return { id: String(result.id ?? "") };
    }),
    releaseFeedbackAttachments(ids: readonly string[]): void {
      ids.forEach((id) => attachments.delete(id));
    },
    loadDiagnostics: (signal: AbortSignal): Promise<DiagnosticsSummary> => safeSupportRequest(signal, async () => {
      const [version, books, diagnostics] = await Promise.all([
        environment.invoke("app_version"),
        environment.invoke("list_books"),
        environment.invoke("runtime_diagnostics").catch(() => ({ unavailable: true })),
      ]);
      let disabledSwitchCount = 0;
      try {
        const settings = asRecord(JSON.parse(environment.storage.getItem("debugSettingsV1") || "{}"));
        disabledSwitchCount = Object.values(settings).filter((value) => value === false).length;
      } catch {
        // Preserve a useful summary when an old debug preference is malformed.
      }
      const runtimeDiagnostics = asRecord(diagnostics);
      return {
        appVersion: asText(version) ?? "未知",
        ...(Array.isArray(books) ? { bookCount: books.length } : {}),
        disabledSwitchCount,
        runtimeStatus: runtimeDiagnostics.unavailable === true ? "unavailable" : "ready",
      };
    }),
    exportRedactedDiagnostics: (signal: AbortSignal): Promise<void> => safeSupportRequest(signal, async () => {
      environment.clickLegacyDiagnosticsExport();
    }),
    enableSafeMode: (signal: AbortSignal): Promise<void> => safeSupportRequest(signal, async () => {
      environment.enableLegacySafeMode();
    }),
  };
}
