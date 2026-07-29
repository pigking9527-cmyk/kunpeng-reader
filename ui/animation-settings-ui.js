(function initAnimationSettingsUI(global) {
  "use strict";

  function init() {
    const commonSettingsModal = document.getElementById("fp-settings-modal");
    const modal = document.getElementById("animation-settings-modal");
    const closeButton = document.getElementById("animation-settings-close");
    const settingInputs = [...document.querySelectorAll("[data-animation-setting]")];
    const groupInputs = [...document.querySelectorAll("[data-animation-group]")];

    function apply() {
      global.ReaderAnimationSettings?.applyMain(document);
    }

    function render() {
      const settings = global.ReaderAnimationSettings?.read?.() || {};
      groupInputs.forEach((input) => {
        input.checked = settings[input.dataset.animationGroup] !== false;
      });
      settingInputs.forEach((input) => {
        input.checked = settings[input.dataset.animationSetting] !== false;
        // 子项始终可操作：从关闭状态单独开启某一项时，会自动开启对应总开关。
        input.disabled = false;
      });
      apply();
    }

    function close(returnToCommon = true) {
      modal?.classList.remove("show");
      if (returnToCommon) commonSettingsModal?.classList.add("show");
    }

    document.getElementById("animation-gear")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      render();
      commonSettingsModal?.classList.remove("show");
      modal?.classList.add("show");
    });
    closeButton?.addEventListener("click", () => close(true));
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) close(true);
    });
    settingInputs.forEach((input) => {
      input.addEventListener("change", () => {
        global.ReaderAnimationSettings?.set?.(input.dataset.animationSetting, input.checked);
        render();
      });
    });
    groupInputs.forEach((input) => {
      input.addEventListener("change", () => {
        global.ReaderAnimationSettings?.set?.(input.dataset.animationGroup, input.checked);
        render();
      });
    });
    global.addEventListener("reader-animation-settings-changed", render);
    global.addEventListener("storage", (event) => {
      if (event.key === global.ReaderAnimationSettings?.STORAGE_KEY) render();
    });
    apply();
  }

  global.ReaderAnimationSettingsUI = Object.freeze({ init });
  init();
})(window);
