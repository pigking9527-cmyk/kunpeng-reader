(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;

  const currentWindow = window.__TAURI__?.window?.getCurrentWindow?.();

  function toggleCurrentWindowMaximize() {
    const nativeToggle = currentWindow?.toggleMaximize?.bind(currentWindow);
    if (nativeToggle) {
      return nativeToggle().catch(() => invoke("main_window_toggle_maximize").catch(() => {}));
    }
    return invoke("main_window_toggle_maximize").catch(() => {});
  }

  function initCustomTitlebar() {
    const toolbar = document.querySelector(".toolbar");
    const dragSpace = document.getElementById("title-drag-space");
    const minBtn = document.getElementById("win-min");
    const maxBtn = document.getElementById("win-max");
    const closeBtn = document.getElementById("win-close");
    const isInteractiveTitlebarTarget = (target) => !!target.closest(
      "button,input,label,.sbox,.menu,.filter-panel,.account-panel,.saved-accounts,.search-history,.window-controls"
    );

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

    const toggleMaximize = (e) => {
      if (isInteractiveTitlebarTarget(e.target)) return;
      toggleCurrentWindowMaximize();
    };
    toolbar?.addEventListener("dblclick", toggleMaximize);
    dragSpace?.addEventListener("dblclick", () => toggleCurrentWindowMaximize());
  }

  initCustomTitlebar();
})();
