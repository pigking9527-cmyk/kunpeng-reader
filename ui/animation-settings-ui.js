(function initAnimationSettingsUI(global) {
  "use strict";

  function init() {
    const commonSettingsModal = document.getElementById("fp-settings-modal");
    const modal = document.getElementById("animation-settings-modal");
    const closeButton = document.getElementById("animation-settings-close");
    const masterInput = document.getElementById("set-animation-master");
    const settingInputs = [...document.querySelectorAll("[data-animation-setting]")];
    const groupInputs = [...document.querySelectorAll("[data-animation-group]")];

    function apply() {
      global.ReaderAnimationSettings?.applyMain(document);
    }

    function render() {
      const settings = global.ReaderAnimationSettings?.read?.() || {};
      const masterEnabled = settings.allAnimations !== false;
      if (masterInput) masterInput.checked = masterEnabled;
      groupInputs.forEach((input) => {
        input.checked = settings[input.dataset.animationGroup] !== false;
        input.disabled = !masterEnabled;
      });
      settingInputs.forEach((input) => {
        input.checked = settings[input.dataset.animationSetting] !== false;
        // 全局开关只暂时停用效果，不改写任何子项记录。
        input.disabled = !masterEnabled;
      });
      document.querySelectorAll("[data-animation-group-section]").forEach((section) => {
        section.classList.toggle("animation-master-disabled", !masterEnabled);
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
      modal?.classList.add("show");
    });
    masterInput?.addEventListener("change", () => {
      global.ReaderAnimationSettings?.set?.("allAnimations", masterInput.checked);
      render();
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
