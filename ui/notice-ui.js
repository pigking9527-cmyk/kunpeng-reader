// 非阻塞式应用内提示：桌面采用浏览器 Snackbar，窄窗口适配移动端安全边距。
(function exposeAppNotice(global) {
"use strict";

let notice = null;
let message = null;
let action = null;
let close = null;
let hideTimer = 0;
let actionHandler = null;

function ensureNotice() {
  if (notice) return;
  notice = global.document.createElement("div");
  notice.className = "app-notice";
  notice.dataset.overlaySurface = "notice";
  notice.dataset.overlayRole = "feedback";
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  message = global.document.createElement("span");
  message.className = "app-notice-message";
  action = global.document.createElement("button");
  action.className = "app-notice-action";
  action.type = "button";
  close = global.document.createElement("button");
  close.className = "app-notice-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  action.addEventListener("click", () => {
    const callback = actionHandler;
    hide();
    if (callback) callback();
  });
  close.addEventListener("click", hide);
  notice.append(message, action, close);
  global.document.body.appendChild(notice);
}

function hide() {
  clearTimeout(hideTimer);
  hideTimer = 0;
  actionHandler = null;
  notice?.classList.remove("show");
}

function show(text, options = {}) {
  ensureNotice();
  clearTimeout(hideTimer);
  const textOnly = options.variant === "text";
  message.textContent = String(text || "");
  actionHandler = typeof options.onAction === "function" ? options.onAction : null;
  action.textContent = actionHandler ? String(options.actionLabel || "查看") : "";
  action.hidden = textOnly || !actionHandler;
  close.hidden = textOnly;
  notice.classList.toggle("text-only", textOnly);
  notice.classList.remove("show");
  const duration = Number(options.duration) || (actionHandler ? 6000 : 3600);
  notice.style.setProperty("--notice-duration", Math.max(300, duration) + "ms");
  global.requestAnimationFrame(() => notice.classList.add("show"));
  hideTimer = setTimeout(hide, Math.max(300, duration));
}

global.AppNotice = Object.freeze({ hide, show });
})(window);
