(function initFeedbackUi(global) {
  "use strict";

  const invoke = global.__TAURI__?.core?.invoke;
  const modal = document.getElementById("feedback-modal");
  const editor = document.getElementById("feedback-editor");
  if (!invoke || !modal || !editor) return;

  const title = document.getElementById("feedback-title");
  const close = document.getElementById("feedback-close");
  const imageInput = document.getElementById("feedback-image-input");
  const insertImage = document.getElementById("feedback-insert-image");
  const imageStatus = document.getElementById("feedback-image-status");
  const submit = document.getElementById("feedback-submit");
  const status = document.getElementById("feedback-status");
  const MAX_IMAGES = 3;
  const MAX_IMAGE_BYTES = 1024 * 1024;
  let kind = "bug";
  let images = [];

  function setStatus(message, tone = "") {
    status.textContent = message || "";
    status.className = "ai-status" + (tone ? " " + tone : "");
  }

  function open(nextKind) {
    kind = nextKind === "feature" ? "feature" : "bug";
    title.textContent = kind === "bug" ? "提交 Bug" : "功能提议";
    submit.textContent = kind === "bug" ? "提交问题" : "提交建议";
    setStatus("");
    modal.classList.add("show");
    requestAnimationFrame(() => editor.focus());
  }

  function hide() {
    modal.classList.remove("show");
  }

  function updateImageStatus() {
    imageStatus.textContent = images.length + "/" + MAX_IMAGES + " 张";
    insertImage.disabled = images.length >= MAX_IMAGES;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("读取图片失败"));
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
        reject(new Error("无法解析图片"));
      };
      image.src = url;
    });
  }

  function canvasBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片压缩失败")), "image/jpeg", quality);
    });
  }

  async function compressImage(file) {
    if (!String(file.type || "").startsWith("image/")) throw new Error("只能插入图片文件");
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
    throw new Error("图片过大，无法压缩到 1 MB 以内");
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
    remove.title = "删除图片";
    remove.addEventListener("click", () => removeImage(item.id));
    figure.append(image, remove);
    editor.append(figure, document.createElement("br"));
  }

  async function addFiles(files) {
    const candidates = Array.from(files || []).filter((file) => String(file.type || "").startsWith("image/"));
    if (!candidates.length) return;
    const available = Math.max(0, MAX_IMAGES - images.length);
    if (!available) {
      setStatus("最多只能插入 " + MAX_IMAGES + " 张图片。", "error");
      return;
    }
    setStatus("正在压缩图片…");
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
    if (!status.classList.contains("error")) setStatus("图片已压缩并插入。", "success");
  }

  function feedbackText() {
    const clone = editor.cloneNode(true);
    clone.querySelectorAll(".feedback-inline-image").forEach((node) => node.remove());
    return String(clone.innerText || clone.textContent || "").trim();
  }

  async function submitFeedback() {
    const text = feedbackText();
    if (!text && !images.length) {
      setStatus("请输入反馈内容，或至少插入一张图片。", "error");
      return;
    }
    submit.disabled = true;
    insertImage.disabled = true;
    setStatus("正在提交…");
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
        },
      });
      setStatus(result?.message || "反馈已提交，谢谢。", "success");
      editor.replaceChildren();
      images = [];
      updateImageStatus();
    } catch (error) {
      setStatus("提交失败：" + (error?.message || error), "error");
    } finally {
      submit.disabled = false;
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
  updateImageStatus();
})(window);
