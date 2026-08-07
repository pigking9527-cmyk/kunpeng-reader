(function initFeedbackUi(global) {
  "use strict";

  const invoke = global.__TAURI__?.core?.invoke;
  const modal = document.getElementById("feedback-modal");
  const editor = document.getElementById("feedback-editor");
  if (!invoke || !modal || !editor) return;

  const title = document.getElementById("feedback-title");
  const note = modal.querySelector(".feedback-note");
  const close = document.getElementById("feedback-close");
  const imageInput = document.getElementById("feedback-image-input");
  const insertImage = document.getElementById("feedback-insert-image");
  const imageStatus = document.getElementById("feedback-image-status");
  const jsonRow = document.getElementById("feedback-json-row");
  const problemTraceNote = document.getElementById("feedback-problem-trace-note");
  const problemTraceStatus = document.getElementById("feedback-trace-status");
  const problemTraceControls = document.querySelectorAll(".feedback-problem-trace-control");
  const attachProblemTraceButton = document.getElementById("feedback-attach-problem-trace");
  const saveProblemTraceButton = document.getElementById("feedback-save-problem-trace");
  const clearJson = document.getElementById("feedback-clear-json");
  const jsonStatus = document.getElementById("feedback-json-status");
  const submit = document.getElementById("feedback-submit");
  const status = document.getElementById("feedback-status");
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 1024 * 1024;
  const MAX_JSON_BYTES = 256 * 1024;
  let kind = "bug";
  let images = [];
  let jsonAttachment = null;
  let frozenProblemTrace = null;
  let problemTraceCapture = null;

  function feedbackTextFor(key, values = {}) {
    let text = global.ReaderAppI18n?.t?.(key) || key;
    for (const [name, value] of Object.entries(values)) text = text.replaceAll(`{${name}}`, String(value));
    return text;
  }

  function renderLanguage() {
    global.ReaderAppI18n?.apply?.(modal);
    title.textContent = feedbackTextFor(kind === "bug" ? "feedbackBugTitle" : "feedbackFeatureTitle");
    note.textContent = feedbackTextFor(kind === "bug" ? "feedbackBugNote" : "feedbackFeatureNote");
    editor.dataset.placeholder = feedbackTextFor(kind === "bug" ? "feedbackBugPlaceholder" : "feedbackFeaturePlaceholder");
    submit.textContent = feedbackTextFor(kind === "bug" ? "submitProblem" : "submitSuggestion");
    updateImageStatus();
    updateJsonStatus();
  }

  function setStatus(message, tone = "") {
    status.textContent = message || "";
    status.className = "ai-status" + (tone ? " " + tone : "");
  }

  function open(nextKind) {
    kind = nextKind === "feature" ? "feature" : "bug";
    renderLanguage();
    problemTraceNote.hidden = kind !== "bug";
    problemTraceStatus.hidden = kind !== "bug";
    problemTraceControls.forEach((control) => { control.hidden = kind !== "bug"; });
    jsonRow.hidden = false;
    if (kind !== "bug") clearJsonAttachment();
    frozenProblemTrace = null;
    problemTraceCapture = kind === "bug" ? freezeProblemTrace() : null;
    setStatus("");
    modal.classList.add("show");
    requestAnimationFrame(() => editor.focus());
  }

  function freezeProblemTrace() {
    if (!global.ReaderProblemTraceUI?.capture) return Promise.resolve(null);
    const request = global.ReaderProblemTraceUI.capture().then((snapshot) => {
      frozenProblemTrace = snapshot;
      return snapshot;
    }).catch(() => null);
    problemTraceCapture = request;
    request.finally(() => {
      if (problemTraceCapture === request) problemTraceCapture = null;
    });
    return request;
  }

  function hide() {
    modal.classList.remove("show");
  }

  function updateImageStatus() {
    imageStatus.textContent = feedbackTextFor("imageCount", { count: images.length, max: MAX_IMAGES });
    insertImage.disabled = images.length >= MAX_IMAGES;
  }

  function updateJsonStatus() {
    jsonStatus.textContent = jsonAttachment
      ? "✓ " + jsonAttachment.name + " · " + Math.ceil(jsonAttachment.bytes / 1024) + " KB"
      : feedbackTextFor("traceNotAttached");
    clearJson.hidden = !jsonAttachment;
  }

  function clearJsonAttachment() {
    jsonAttachment = null;
    updateJsonStatus();
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function attachProblemTrace(snapshot) {
    const contents = JSON.stringify(snapshot, null, 2);
    const bytes = new TextEncoder().encode(contents);
    if (!bytes.length || bytes.length > MAX_JSON_BYTES) throw new Error(feedbackTextFor("traceAttachmentTooLarge"));
    return {
      name: "kunpeng-reader-problem-trace-" + String(snapshot?.captured_at || new Date().toISOString()).replace(/[:.]/g, "-") + ".json",
      mime: "application/json",
      bytes: bytes.length,
      data: bytesToBase64(bytes),
    };
  }

  async function captureProblemTraceAttachment() {
    if (!global.ReaderProblemTraceUI?.capture) {
      setStatus(feedbackTextFor("traceUnavailable"), "error");
      return null;
    }
    let snapshot = frozenProblemTrace || await (problemTraceCapture || freezeProblemTrace());
    if (!snapshot) snapshot = await freezeProblemTrace();
    if (!snapshot) throw new Error(feedbackTextFor("traceUnavailable"));
    return attachProblemTrace(snapshot);
  }

  async function attachProblemTraceToFeedback() {
    attachProblemTraceButton.disabled = true;
    setStatus(feedbackTextFor("traceReading"));
    try {
      jsonAttachment = await captureProblemTraceAttachment();
      if (!jsonAttachment) return;
      updateJsonStatus();
      setStatus(feedbackTextFor("traceAttached"), "success");
    } catch (error) {
      setStatus(error?.message || String(error || feedbackTextFor("traceReadFailed")), "error");
    } finally {
      attachProblemTraceButton.disabled = false;
    }
  }

  async function saveProblemTraceToDesktop() {
    saveProblemTraceButton.disabled = true;
    setStatus(feedbackTextFor("traceSaving"));
    try {
      const attachment = await captureProblemTraceAttachment();
      if (!attachment) return;
      const path = await invoke("save_problem_trace_to_desktop", {
        name: attachment.name,
        data: attachment.data,
      });
      setStatus(feedbackTextFor("traceSaved", { path }), "success");
    } catch (error) {
      setStatus(feedbackTextFor("feedbackOperationFailed", { error: error?.message || error }), "error");
    } finally {
      saveProblemTraceButton.disabled = false;
    }
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error(feedbackTextFor("readImageFailed")));
      reader.readAsDataURL(blob);
    });
  }

  function loadImage(file) {
    if (global.createImageBitmap) return global.createImageBitmap(file);
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
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error(feedbackTextFor("compressImageFailed"))), "image/jpeg", quality);
    });
  }

  async function compressImage(file) {
    if (!String(file.type || "").startsWith("image/")) throw new Error(feedbackTextFor("imageOnly"));
    const source = await loadImage(file);
    const sourceWidth = Number(source.width || source.naturalWidth || 1);
    const sourceHeight = Number(source.height || source.naturalHeight || 1);
    let scale = Math.min(1, 2400 / Math.max(sourceWidth, sourceHeight));
    let quality = 0.9;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext("2d", { alpha: false });
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      const blob = await canvasBlob(canvas, quality);
      if (blob.size <= MAX_IMAGE_BYTES) {
        if (typeof source.close === "function") source.close();
        return blob;
      }
      if (quality > 0.5) quality = Math.max(0.5, quality - 0.1);
      else scale *= 0.78;
    }
    if (typeof source.close === "function") source.close();
    throw new Error(feedbackTextFor("imageTooLarge"));
  }

  function removeImage(id) {
    images = images.filter((item) => item.id !== id);
    editor.querySelector('[data-feedback-image="' + CSS.escape(id) + '"]')?.remove();
    updateImageStatus();
  }

  function appendImagePreview(item) {
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
  }

  async function addFiles(files) {
    const candidates = Array.from(files || []).filter((file) => String(file.type || "").startsWith("image/"));
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
        const item = {
          id: global.crypto?.randomUUID?.() || String(Date.now()) + Math.random(),
          name: String(file.name || "feedback-image").replace(/\.[^.]+$/, "") + ".jpg",
          mime: "image/jpeg",
          bytes: blob.size,
          dataUrl,
        };
        images.push(item);
        appendImagePreview(item);
      } catch (error) {
        setStatus(error?.message || String(error), "error");
      }
    }
    updateImageStatus();
    if (!status.classList.contains("error")) setStatus(feedbackTextFor("imageInserted"), "success");
  }

  function feedbackText() {
    const clone = editor.cloneNode(true);
    clone.querySelectorAll(".feedback-inline-image").forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || "").trim();
  }

  async function submitFeedback() {
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
      const appVersion = await invoke("app_version").catch(() => "");
      const result = await invoke("submit_feedback", {
        request: {
          kind,
          text,
          appVersion,
          platform: navigator.userAgent || "",
          images: images.map((item) => ({
            name: item.name,
            mime: item.mime,
            data: item.dataUrl.slice(item.dataUrl.indexOf(",") + 1),
          })),
          attachments: jsonAttachment ? [{
            name: jsonAttachment.name,
            mime: jsonAttachment.mime,
            data: jsonAttachment.data,
          }] : [],
        },
      });
      setStatus(feedbackTextFor("feedbackSubmitted"), "success");
      editor.replaceChildren();
      images = [];
      clearJsonAttachment();
      updateImageStatus();
    } catch (error) {
      setStatus(feedbackTextFor("feedbackSubmitFailed", { error: error?.message || error }), "error");
    } finally {
      submit.disabled = false;
      if (attachProblemTraceButton) attachProblemTraceButton.disabled = false;
      if (saveProblemTraceButton) saveProblemTraceButton.disabled = false;
      updateImageStatus();
    }
  }

  document.getElementById("about-feedback-bug")?.addEventListener("click", () => open("bug"));
  document.getElementById("about-feedback-feature")?.addEventListener("click", () => open("feature"));
  close?.addEventListener("click", hide);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) hide();
  });
  insertImage?.addEventListener("click", () => imageInput?.click());
  attachProblemTraceButton?.addEventListener("click", attachProblemTraceToFeedback);
  saveProblemTraceButton?.addEventListener("click", saveProblemTraceToDesktop);
  clearJson?.addEventListener("click", clearJsonAttachment);
  imageInput?.addEventListener("change", async () => {
    await addFiles(imageInput.files);
    imageInput.value = "";
  });
  editor.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => String(file.type || "").startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });
  editor.addEventListener("dragover", (event) => event.preventDefault());
  editor.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files || []).filter((file) => String(file.type || "").startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    addFiles(files);
  });
  submit?.addEventListener("click", submitFeedback);
  global.addEventListener?.("app-language-changed", renderLanguage);
  updateImageStatus();
  updateJsonStatus();
})(window);
