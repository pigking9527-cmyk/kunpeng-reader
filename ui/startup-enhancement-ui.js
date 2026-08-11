(function (global) {
  const invoke = global.__TAURI__?.core?.invoke;
  const tauriEvent = global.__TAURI__?.event;
  const master = document.getElementById("set-startup-enhancement");
  const gear = document.getElementById("startup-enhancement-gear");
  const modal = document.getElementById("startup-enhancement-modal");
  const close = document.getElementById("startup-enhancement-close");
  const launchAtLoginRow = document.getElementById(
    "startup-enhancement-autostart-row",
  );
  const launchAtLogin = document.getElementById(
    "startup-enhancement-autostart",
  );
  const launchAtLoginBackgroundRow = document.getElementById(
    "startup-enhancement-autostart-background-row",
  );
  const launchAtLoginBackground = document.getElementById(
    "startup-enhancement-autostart-background",
  );
  const processAfterClose = document.getElementById(
    "startup-enhancement-process",
  );
  const continueHighCost = document.getElementById(
    "startup-enhancement-high-cost",
  );
  let config = {
    enabled: false,
    continueHighCost: false,
    launchAtLogin: false,
    launchAtLoginAvailable: false,
    launchAtLoginBackground: false,
    launchAtLoginBackgroundAvailable: false,
  };
  let backgrounded = false;
  let highCostResumeAtMs = 0;

  function normalize(loaded) {
    return {
      enabled: !!loaded?.enabled,
      continueHighCost: !!loaded?.continueHighCost,
      launchAtLogin: !!loaded?.launchAtLogin,
      launchAtLoginAvailable: !!loaded?.launchAtLoginAvailable,
      launchAtLoginBackground: !!loaded?.launchAtLoginBackground,
      launchAtLoginBackgroundAvailable:
        !!loaded?.launchAtLoginBackgroundAvailable,
    };
  }

  function render() {
    if (master) master.checked = config.enabled;
    if (launchAtLoginRow)
      launchAtLoginRow.hidden = !config.launchAtLoginAvailable;
    if (launchAtLogin) {
      launchAtLogin.checked = config.launchAtLogin;
      launchAtLogin.disabled = !config.launchAtLoginAvailable;
    }
    if (launchAtLoginBackgroundRow)
      launchAtLoginBackgroundRow.hidden =
        !config.launchAtLoginBackgroundAvailable;
    if (launchAtLoginBackground) {
      launchAtLoginBackground.checked = config.launchAtLoginBackground;
      launchAtLoginBackground.disabled =
        !config.launchAtLogin || !config.launchAtLoginBackgroundAvailable;
    }
    if (processAfterClose) processAfterClose.checked = config.enabled;
    if (continueHighCost) {
      continueHighCost.checked = config.continueHighCost;
      continueHighCost.disabled = !config.enabled;
    }
  }

  function save(next) {
    const previous = config;
    config = normalize({ ...config, ...next });
    render();
    return invoke("set_startup_enhancement_config", { request: config })
      .then((saved) => {
        config = normalize(saved || config);
        render();
        return config;
      })
      .catch((error) => {
        config = previous;
        render();
        global.AppNotice?.show?.(String(error), {
          variant: "text",
          duration: 1800,
        });
        throw error;
      });
  }

  invoke("startup_enhancement_config")
    .then((loaded) => {
      config = normalize(loaded);
      render();
      return config;
    })
    .catch(() => {
      render();
      return config;
    });

  master?.addEventListener("change", () =>
    save({ ...config, enabled: master.checked }).catch(() => {}),
  );
  launchAtLogin?.addEventListener("change", () =>
    save({ ...config, launchAtLogin: launchAtLogin.checked }).catch(() => {}),
  );
  launchAtLoginBackground?.addEventListener("change", () =>
    save({
      ...config,
      launchAtLoginBackground: launchAtLoginBackground.checked,
    }).catch(() => {}),
  );
  processAfterClose?.addEventListener("change", () =>
    save({ ...config, enabled: processAfterClose.checked }).catch(() => {}),
  );
  continueHighCost?.addEventListener("change", () =>
    save({ ...config, continueHighCost: continueHighCost.checked }).catch(
      () => {},
    ),
  );
  gear?.addEventListener("click", () => modal?.classList.add("show"));
  close?.addEventListener("click", () => modal?.classList.remove("show"));
  modal?.addEventListener("click", (event) => {
    if (event.target === modal) modal.classList.remove("show");
  });
  tauriEvent?.listen("startup-enhancement-state", (event) => {
    backgrounded = !!event?.payload?.backgrounded;
    config.continueHighCost = !!event?.payload?.continueHighCost;
    highCostResumeAtMs = Number(event?.payload?.highCostResumeAtMs) || 0;
  });

  global.ReaderStartupEnhancement = {
    backgroundWorkAllowed: () =>
      (!backgrounded || config.continueHighCost) &&
      Date.now() >= highCostResumeAtMs,
    highCostRetryDelay: () =>
      backgrounded ? 0 : Math.max(0, highCostResumeAtMs - Date.now()),
    snapshot: () => ({
      enabled: config.enabled,
      continueHighCost: config.continueHighCost,
      launchAtLogin: config.launchAtLogin,
      launchAtLoginBackground: config.launchAtLoginBackground,
    }),
  };
})(window);
