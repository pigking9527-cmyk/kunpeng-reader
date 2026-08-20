import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type FeedbackCommands = {
  app_version: { readonly result: unknown };
  submit_feedback: {
    readonly args: { readonly request: FeedbackRequest };
    readonly result: unknown;
  };
  save_problem_trace_to_desktop: {
    readonly args: { readonly name: string; readonly data: string };
    readonly result: unknown;
  };
};

type VerifiedFeedbackCommands = FeedbackCommands extends TauriCommandMap
  ? FeedbackCommands
  : never;

interface FeedbackRequest {
  readonly kind: "bug" | "feature";
  readonly text: string;
  readonly appVersion: unknown;
  readonly platform: string;
  readonly images: readonly AttachmentPayload[];
  readonly attachments: readonly AttachmentPayload[];
}

interface AttachmentPayload {
  readonly name: string;
  readonly mime: string;
  readonly data: string;
}

interface ImageItem {
  readonly id: string;
  readonly name: string;
  readonly mime: "image/jpeg";
  readonly bytes: number;
  readonly dataUrl: string;
}

interface JsonAttachment extends AttachmentPayload {
  readonly bytes: number;
}

interface ProblemTraceUi {
  capture?(): Promise<unknown>;
}

interface FeedbackI18n {
  t?(key: string): string;
  apply?(root: Element): void;
}

interface FeedbackRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly navigator?: Navigator;
  readonly ReaderAppI18n?: FeedbackI18n;
  readonly ReaderProblemTraceUI?: ProblemTraceUi;
  readonly crypto?: Crypto;
  readonly createImageBitmap?: (image: ImageBitmapSource) => Promise<ImageBitmap>;
  addEventListener?(type: string, listener: () => void): void;
}

export interface FeedbackUiApi {
  open(kind: "bug" | "feature" | string): void;
  hide(): void;
  submit(): Promise<void>;
}

const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 1_024 * 1_024;
const MAX_JSON_BYTES = 4 * 1_024 * 1_024;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): FeedbackRuntime | null {
  const target = record(value);
  if (!target || !record(target.document)) return null;
  return target as unknown as FeedbackRuntime;
}

function errorText(error: unknown, fallback = ""): string {
  const value = record(error);
  return value?.message ? String(value.message) : String(error || fallback);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function initializeFeedbackUi(
  runtime: FeedbackRuntime,
  transport: TauriTransport,
): FeedbackUiApi | null {
  const api = createTauriApi<VerifiedFeedbackCommands>(transport);
  const document = runtime.document;
  const modal = document.getElementById("feedback-modal") as HTMLElement | null;
  const editor = document.getElementById("feedback-editor") as HTMLElement | null;
  if (!modal || !editor) return null;

  const title = document.getElementById("feedback-title") as HTMLElement;
  const note = modal.querySelector(".feedback-note") as HTMLElement;
  const close = document.getElementById("feedback-close") as HTMLElement | null;
  const imageInput = document.getElementById("feedback-image-input") as HTMLInputElement;
  const insertImage = document.getElementById("feedback-insert-image") as HTMLButtonElement;
  const imageStatus = document.getElementById("feedback-image-status") as HTMLElement;
  const jsonRow = document.getElementById("feedback-json-row") as HTMLElement;
  const problemTraceNote = document.getElementById("feedback-problem-trace-note") as HTMLElement;
  const problemTraceStatus = document.getElementById("feedback-trace-status") as HTMLElement;
  const problemTraceControls = document.querySelectorAll<HTMLElement>(
    ".feedback-problem-trace-control",
  );
  const attachProblemTraceButton = document.getElementById(
    "feedback-attach-problem-trace",
  ) as HTMLButtonElement | null;
  const saveProblemTraceButton = document.getElementById(
    "feedback-save-problem-trace",
  ) as HTMLButtonElement | null;
  const clearJson = document.getElementById("feedback-clear-json") as HTMLElement;
  const jsonStatus = document.getElementById("feedback-json-status") as HTMLElement;
  const submit = document.getElementById("feedback-submit") as HTMLButtonElement;
  const status = document.getElementById("feedback-status") as HTMLElement;
  let kind: "bug" | "feature" = "bug";
  let images: ImageItem[] = [];
  let jsonAttachment: JsonAttachment | null = null;
  let frozenProblemTrace: unknown = null;
  let problemTraceCapture: Promise<unknown> | null = null;

  const feedbackTextFor = (
    key: string,
    values: Readonly<Record<string, unknown>> = {},
  ): string => {
    let text = runtime.ReaderAppI18n?.t?.(key) || key;
    for (const [name, value] of Object.entries(values)) {
      text = text.replaceAll(`{${name}}`, String(value));
    }
    return text;
  };

  const setStatus = (message: unknown, tone = ""): void => {
    status.textContent = message ? String(message) : "";
    status.className = `ai-status${tone ? ` ${tone}` : ""}`;
  };
  const updateImageStatus = (): void => {
    imageStatus.textContent = feedbackTextFor("imageCount", {
      count: images.length,
      max: MAX_IMAGES,
    });
    insertImage.disabled = images.length >= MAX_IMAGES;
  };
  const updateJsonStatus = (): void => {
    jsonStatus.textContent = jsonAttachment
      ? `✓ ${jsonAttachment.name} · ${Math.ceil(jsonAttachment.bytes / 1024)} KB`
      : feedbackTextFor("traceNotAttached");
    clearJson.hidden = !jsonAttachment;
  };
  const clearJsonAttachment = (): void => {
    jsonAttachment = null;
    updateJsonStatus();
  };
  const renderLanguage = (): void => {
    runtime.ReaderAppI18n?.apply?.(modal);
    title.textContent = feedbackTextFor(
      kind === "bug" ? "feedbackBugTitle" : "feedbackFeatureTitle",
    );
    note.textContent = feedbackTextFor(
      kind === "bug" ? "feedbackBugNote" : "feedbackFeatureNote",
    );
    editor.dataset.placeholder = feedbackTextFor(
      kind === "bug" ? "feedbackBugPlaceholder" : "feedbackFeaturePlaceholder",
    );
    submit.textContent = feedbackTextFor(
      kind === "bug" ? "submitProblem" : "submitSuggestion",
    );
    updateImageStatus();
    updateJsonStatus();
  };

  const freezeProblemTrace = (): Promise<unknown> => {
    if (!runtime.ReaderProblemTraceUI?.capture) return Promise.resolve(null);
    const request = runtime.ReaderProblemTraceUI
      .capture()
      .then((snapshot) => {
        frozenProblemTrace = snapshot;
        return snapshot;
      })
      .catch(() => null);
    problemTraceCapture = request;
    void request.finally(() => {
      if (problemTraceCapture === request) problemTraceCapture = null;
    });
    return request;
  };

  const open = (nextKind: string): void => {
    kind = nextKind === "feature" ? "feature" : "bug";
    renderLanguage();
    problemTraceNote.hidden = kind !== "bug";
    problemTraceStatus.hidden = kind !== "bug";
    problemTraceControls.forEach((control) => {
      control.hidden = kind !== "bug";
    });
    jsonRow.hidden = false;
    if (kind !== "bug") clearJsonAttachment();
    frozenProblemTrace = null;
    problemTraceCapture = kind === "bug" ? freezeProblemTrace() : null;
    setStatus("");
    modal.classList.add("show");
    requestAnimationFrame(() => editor.focus());
  };
  const hide = (): void => modal.classList.remove("show");

  const attachProblemTrace = (snapshot: unknown): JsonAttachment => {
    const contents = JSON.stringify(snapshot, null, 2);
    const bytes = new TextEncoder().encode(contents);
    if (!bytes.length || bytes.length > MAX_JSON_BYTES) {
      throw new Error(feedbackTextFor("traceAttachmentTooLarge"));
    }
    const capturedAt = record(snapshot)?.captured_at || new Date().toISOString();
    return {
      name: `kunpeng-reader-problem-trace-${String(capturedAt).replace(/[:.]/g, "-")}.json`,
      mime: "application/json",
      bytes: bytes.length,
      data: bytesToBase64(bytes),
    };
  };
  const captureProblemTraceAttachment = async (): Promise<JsonAttachment | null> => {
    if (!runtime.ReaderProblemTraceUI?.capture) {
      setStatus(feedbackTextFor("traceUnavailable"), "error");
      return null;
    }
    let snapshot = frozenProblemTrace || (await (problemTraceCapture || freezeProblemTrace()));
    if (!snapshot) snapshot = await freezeProblemTrace();
    if (!snapshot) throw new Error(feedbackTextFor("traceUnavailable"));
    return attachProblemTrace(snapshot);
  };
  const attachProblemTraceToFeedback = async (): Promise<void> => {
    if (!attachProblemTraceButton) return;
    attachProblemTraceButton.disabled = true;
    setStatus(feedbackTextFor("traceReading"));
    try {
      jsonAttachment = await captureProblemTraceAttachment();
      if (!jsonAttachment) return;
      updateJsonStatus();
      setStatus(feedbackTextFor("traceAttached"), "success");
    } catch (error: unknown) {
      setStatus(errorText(error, feedbackTextFor("traceReadFailed")), "error");
    } finally {
      attachProblemTraceButton.disabled = false;
    }
  };
  const saveProblemTraceToDesktop = async (): Promise<void> => {
    if (!saveProblemTraceButton) return;
    saveProblemTraceButton.disabled = true;
    setStatus(feedbackTextFor("traceSaving"));
    try {
      const attachment = await captureProblemTraceAttachment();
      if (!attachment) return;
      const path = await api.invoke("save_problem_trace_to_desktop", {
        name: attachment.name,
        data: attachment.data,
      });
      setStatus(feedbackTextFor("traceSaved", { path }), "success");
    } catch (error: unknown) {
      setStatus(
        feedbackTextFor("feedbackOperationFailed", { error: errorText(error) }),
        "error",
      );
    } finally {
      saveProblemTraceButton.disabled = false;
    }
  };

  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(feedbackTextFor("readImageFailed")));
      reader.readAsDataURL(blob);
    });
  const loadImage = (file: File): Promise<ImageBitmap | HTMLImageElement> => {
    if (runtime.createImageBitmap) return runtime.createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(feedbackTextFor("parseImageFailed")));
      };
      image.src = url;
    });
  };
  const canvasBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
    new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob
            ? resolve(blob)
            : reject(new Error(feedbackTextFor("compressImageFailed"))),
        "image/jpeg",
        quality,
      );
    });
  const compressImage = async (file: File): Promise<Blob> => {
    if (!String(file.type || "").startsWith("image/")) {
      throw new Error(feedbackTextFor("imageOnly"));
    }
    const source = await loadImage(file);
    const sourceWidth = Number(source.width || (source as HTMLImageElement).naturalWidth || 1);
    const sourceHeight = Number(source.height || (source as HTMLImageElement).naturalHeight || 1);
    let scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    let quality = 0.9;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error(feedbackTextFor("compressImageFailed"));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, quality);
      if (blob.size <= MAX_IMAGE_BYTES) {
        if ("close" in source && typeof source.close === "function") source.close();
        return blob;
      }
      if (quality > 0.5) quality = Math.max(0.5, quality - 0.1);
      else scale *= 0.78;
    }
    if ("close" in source && typeof source.close === "function") source.close();
    throw new Error(feedbackTextFor("imageTooLarge"));
  };

  const removeImage = (id: string): void => {
    images = images.filter((item) => item.id !== id);
    editor.querySelector(`[data-feedback-image="${CSS.escape(id)}"]`)?.remove();
    updateImageStatus();
  };
  const appendImagePreview = (item: ImageItem): void => {
    const figure = document.createElement("span");
    figure.className = "feedback-inline-image";
    figure.dataset.feedbackImage = item.id;
    figure.contentEditable = "false";
    const image = document.createElement("img");
    image.src = item.dataUrl;
    image.alt = item.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.title = feedbackTextFor("removeImage");
    remove.addEventListener("click", () => removeImage(item.id));
    figure.append(image, remove);
    editor.append(figure, document.createElement("br"));
  };
  const addFiles = async (files: ArrayLike<File> | null): Promise<void> => {
    const candidates = Array.from(files || []).filter((file) =>
      String(file.type || "").startsWith("image/"),
    );
    if (!candidates.length) return;
    const available = Math.max(0, MAX_IMAGES - images.length);
    if (!available) {
      setStatus(feedbackTextFor("maxImages", { max: MAX_IMAGES }), "error");
      return;
    }
    setStatus(feedbackTextFor("compressingImages"));
    for (const file of candidates.slice(0, available)) {
      try {
        const blob = await compressImage(file);
        const dataUrl = await blobToDataUrl(blob);
        const item: ImageItem = {
          id: runtime.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`,
          name: `${String(file.name || "feedback-image").replace(/\.[^.]+$/, "")}.jpg`,
          mime: "image/jpeg",
          bytes: blob.size,
          dataUrl,
        };
        images.push(item);
        appendImagePreview(item);
      } catch (error: unknown) {
        setStatus(errorText(error), "error");
      }
    }
    updateImageStatus();
    if (!status.classList.contains("error")) {
      setStatus(feedbackTextFor("imageInserted"), "success");
    }
  };

  const feedbackText = (): string => {
    const clone = editor.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".feedback-inline-image").forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || "").trim();
  };
  const submitFeedback = async (): Promise<void> => {
    const text = feedbackText();
    if (!text && !images.length && !jsonAttachment) {
      setStatus(feedbackTextFor("feedbackRequired"), "error");
      return;
    }
    submit.disabled = true;
    insertImage.disabled = true;
    if (attachProblemTraceButton) attachProblemTraceButton.disabled = true;
    if (saveProblemTraceButton) saveProblemTraceButton.disabled = true;
    setStatus(feedbackTextFor("feedbackSubmitting"));
    try {
      let appVersion: unknown = "";
      try {
        appVersion = await api.invoke("app_version");
      } catch {
        appVersion = "";
      }
      await api.invoke("submit_feedback", {
        request: {
          kind,
          text,
          appVersion,
          platform: runtime.navigator?.userAgent || "",
          images: images.map((item) => ({
            name: item.name,
            mime: item.mime,
            data: item.dataUrl.slice(item.dataUrl.indexOf(",") + 1),
          })),
          attachments: jsonAttachment
            ? [
                {
                  name: jsonAttachment.name,
                  mime: jsonAttachment.mime,
                  data: jsonAttachment.data,
                },
              ]
            : [],
        },
      });
      setStatus(feedbackTextFor("feedbackSubmitted"), "success");
      editor.replaceChildren();
      images = [];
      clearJsonAttachment();
      updateImageStatus();
    } catch (error: unknown) {
      setStatus(
        feedbackTextFor("feedbackSubmitFailed", { error: errorText(error) }),
        "error",
      );
    } finally {
      submit.disabled = false;
      if (attachProblemTraceButton) attachProblemTraceButton.disabled = false;
      if (saveProblemTraceButton) saveProblemTraceButton.disabled = false;
      updateImageStatus();
    }
  };

  document.getElementById("about-feedback-bug")?.addEventListener("click", () => open("bug"));
  document.getElementById("about-feedback-feature")?.addEventListener("click", () =>
    open("feature"),
  );
  close?.addEventListener("click", hide);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) hide();
  });
  insertImage?.addEventListener("click", () => imageInput?.click());
  attachProblemTraceButton?.addEventListener("click", () => {
    void attachProblemTraceToFeedback();
  });
  saveProblemTraceButton?.addEventListener("click", () => {
    void saveProblemTraceToDesktop();
  });
  clearJson?.addEventListener("click", clearJsonAttachment);
  imageInput?.addEventListener("change", async () => {
    await addFiles(imageInput.files);
    imageInput.value = "";
  });
  editor.addEventListener("paste", (event: ClipboardEvent) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) =>
      String(file.type || "").startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });
  editor.addEventListener("dragover", (event) => event.preventDefault());
  editor.addEventListener("drop", (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files || []).filter((file) =>
      String(file.type || "").startsWith("image/"),
    );
    if (!files.length) return;
    event.preventDefault();
    void addFiles(files);
  });
  submit?.addEventListener("click", () => {
    void submitFeedback();
  });
  runtime.addEventListener?.("app-language-changed", renderLanguage);
  updateImageStatus();
  updateJsonStatus();
  return { open, hide, submit: submitFeedback };
}

/** Classic installer replacing `ui/feedback-ui.js`. */
export function installFeedbackUi(
  target: unknown,
  transport?: TauriTransport,
): FeedbackUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      return null;
    }
  }
  return initializeFeedbackUi(runtime, resolvedTransport);
}
