(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  const userAgent = String(window.navigator?.userAgent || "");
  if (!invoke || !/Linux/i.test(userAgent)) return;

  const directions = [
    "north",
    "north-east",
    "east",
    "south-east",
    "south",
    "south-west",
    "west",
    "north-west",
  ];

  function beginResize(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.stopPropagation();
    invoke("main_window_start_resize_dragging", {
      direction: event.currentTarget.dataset.resizeDirection,
    }).catch(() => {});
  }

  function installResizeHandles() {
    if (!document.body || document.getElementById("window-resize-handles")) return;
    const container = document.createElement("div");
    container.id = "window-resize-handles";
    container.setAttribute("aria-hidden", "true");
    for (const direction of directions) {
      const handle = document.createElement("div");
      handle.className = "window-resize-handle";
      handle.dataset.resizeDirection = direction;
      handle.addEventListener("pointerdown", beginResize);
      container.appendChild(handle);
    }
    document.body.appendChild(container);
  }

  if (document.body) installResizeHandles();
  else document.addEventListener("DOMContentLoaded", installResizeHandles, { once: true });
})();