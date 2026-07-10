(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;

  function toggleCurrentWindowMaximize() {
    return invoke("main_window_toggle_maximize").catch(() => {});
  }

  function initCustomTitlebar() {
    const minBtn = document.getElementById("win-min");
    const maxBtn = document.getElementById("win-max");
    const closeBtn = document.getElementById("win-close");

    minBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      invoke("main_window_minimize").catch(() => {});
    });
    maxBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      invoke("main_window_toggle_maximize").catch(() => {});
    });
    closeBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      invoke("main_window_close").catch(() => {});
    });
  }

  initCustomTitlebar();
})();
