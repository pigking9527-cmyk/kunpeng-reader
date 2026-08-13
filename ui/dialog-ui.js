// 应用内 Web 对话框：用于需要用户确认或阅读完整错误信息的操作。
(function exposeAppDialog(global) {
  "use strict";

  let backdrop = null;
  let card = null;
  let icon = null;
  let title = null;
  let message = null;
  let cancelButton = null;
  let confirmButton = null;
  let activeResolve = null;
  let previousFocus = null;
  let hideTimer = 0;

  function finish(result) {
    if (!backdrop?.classList.contains("show")) return;
    backdrop.classList.remove("show");
    backdrop.setAttribute("aria-hidden", "true");
    const resolve = activeResolve;
    activeResolve = null;
    global.clearTimeout(hideTimer);
    hideTimer = global.setTimeout(() => { backdrop.hidden = true; }, 170);
    previousFocus?.focus?.();
    previousFocus = null;
    resolve?.(result);
  }

  function ensureDialog() {
    if (backdrop) return;
    backdrop = global.document.createElement("div");
    backdrop.className = "app-dialog-backdrop";
    backdrop.dataset.overlaySurface = "dialog";
    backdrop.dataset.overlayRole = "critical";
    backdrop.hidden = true;
    backdrop.setAttribute("aria-hidden", "true");

    card = global.document.createElement("section");
    card.className = "app-dialog";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "app-dialog-title");
    card.setAttribute("aria-describedby", "app-dialog-message");

    const heading = global.document.createElement("header");
    heading.className = "app-dialog-heading";
    icon = global.document.createElement("span");
    icon.className = "app-dialog-icon";
    icon.setAttribute("aria-hidden", "true");
    title = global.document.createElement("h2");
    title.id = "app-dialog-title";
    heading.append(icon, title);

    message = global.document.createElement("div");
    message.id = "app-dialog-message";
    message.className = "app-dialog-message";

    const actions = global.document.createElement("footer");
    actions.className = "app-dialog-actions";
    cancelButton = global.document.createElement("button");
    cancelButton.className = "app-dialog-button app-dialog-cancel";
    cancelButton.type = "button";
    confirmButton = global.document.createElement("button");
    confirmButton.className = "app-dialog-button app-dialog-confirm";
    confirmButton.type = "button";
    actions.append(cancelButton, confirmButton);
    card.append(heading, message, actions);
    backdrop.append(card);
    global.document.body.appendChild(backdrop);

    cancelButton.addEventListener("click", () => finish(false));
    confirmButton.addEventListener("click", () => finish(true));
    backdrop.addEventListener("click", (event) => { if (event.target === backdrop) finish(false); });
    global.addEventListener("keydown", (event) => {
      if (!backdrop?.classList.contains("show")) return;
      if (event.key === "Escape") { event.preventDefault(); finish(false); }
    });
  }

  function open(options = {}) {
    ensureDialog();
    if (activeResolve) finish(false);
    global.clearTimeout(hideTimer);
    hideTimer = 0;
    previousFocus = global.document.activeElement;
    const tone = ["info", "success", "warning", "error"].includes(options.tone) ? options.tone : "info";
    card.dataset.tone = tone;
    icon.textContent = { info: "i", success: "✓", warning: "!", error: "!" }[tone];
    title.textContent = String(options.title || "提示");
    message.textContent = String(options.message || "");
    cancelButton.textContent = String(options.cancelLabel || "取消");
    confirmButton.textContent = String(options.confirmLabel || "确定");
    cancelButton.hidden = options.cancelLabel === null;
    backdrop.hidden = false;
    backdrop.setAttribute("aria-hidden", "false");
    void backdrop.offsetWidth;
    backdrop.classList.add("show");
    global.requestAnimationFrame(() => confirmButton.focus());
    return new Promise((resolve) => { activeResolve = resolve; });
  }

  function alert(messageText, options = {}) {
    return open({ ...options, message: messageText, cancelLabel: null });
  }

  function confirm(messageText, options = {}) {
    return open({ ...options, message: messageText });
  }

  global.AppDialog = Object.freeze({ alert, confirm });
})(window);
