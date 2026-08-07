(function (global) {
  const invoke = global.__TAURI__?.core?.invoke;
  const tauriEvent = global.__TAURI__?.event;
  const master = document.getElementById("set-startup-enhancement");
  const gear = document.getElementById("startup-enhancement-gear");
  const modal = document.getElementById("startup-enhancement-modal");
  const close = document.getElementById("startup-enhancement-close");
  const processAfterClose = document.getElementById("startup-enhancement-process");
  const continueHighCost = document.getElementById("startup-enhancement-high-cost");
  let config = { enabled: false, continueHighCost: false };
  let backgrounded = false;

  function render() {
    if (master) master.checked = config.enabled;
    if (processAfterClose) processAfterClose.checked = config.enabled;
    if (continueHighCost) {
      continueHighCost.checked = config.continueHighCost;
      continueHighCost.disabled = !config.enabled;
    }
  }

  function save(next) {
    const previous = config;
    config = { enabled: !!next.enabled, continueHighCost: !!next.continueHighCost };
    render();
    return invoke("set_startup_enhancement_config", { request: config }).catch((error) => {
      config = previous;
      render();
      global.AppNotice?.show?.(String(error), { variant: "text", duration: 1800 });
      throw error;
    });
  }

  invoke("startup_enhancement_config")
    .then((loaded) => {
      config = { enabled: !!loaded?.enabled, continueHighCost: !!loaded?.continueHighCost };
      render();
      return config;
    })
    .catch(() => {
      render();
      return config;
    });

  master?.addEventListener("change", () => save({ ...config, enabled: master.checked }).catch(() => {}));
  processAfterClose?.addEventListener("change", () => save({ ...config, enabled: processAfterClose.checked }).catch(() => {}));
  continueHighCost?.addEventListener("change", () => save({ ...config, continueHighCost: continueHighCost.checked }).catch(() => {}));
  gear?.addEventListener("click", () => modal?.classList.add("show"));
  close?.addEventListener("click", () => modal?.classList.remove("show"));
  modal?.addEventListener("click", (event) => { if (event.target === modal) modal.classList.remove("show"); });
  tauriEvent?.listen("startup-enhancement-state", (event) => {
    backgrounded = !!event?.payload?.backgrounded;
    config.continueHighCost = !!event?.payload?.continueHighCost;
  });

  global.ReaderStartupEnhancement = {
    backgroundWorkAllowed: () => !backgrounded || config.continueHighCost,
  };
})(window);