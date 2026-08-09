(function initSettingsLayout(global) {
  "use strict";
  const modal = document.getElementById("fp-settings-modal");
  if (!modal) return;

  const STORAGE_KEY = "commonSettingsSectionV1";
  const NAV_COLLAPSED_KEY = "commonSettingsNavCollapsedV1";
  const settingsCard = modal.querySelector(".fp-settings-card");
  const navToggle = modal.querySelector("#fp-settings-nav-toggle");
  const sectionButtons = Array.from(modal.querySelectorAll("[data-settings-section]"));
  const panels = Array.from(modal.querySelectorAll("[data-settings-panel]"));
  const sectionIds = sectionButtons.map((button) => button.dataset.settingsSection);
  let navCollapsed = false;
  try { navCollapsed = localStorage.getItem(NAV_COLLAPSED_KEY) === "1"; } catch (_) {}

  function navText(key, fallback) {
    const translated = global.ReaderAppI18n?.t?.(key);
    return translated && translated !== key ? translated : fallback;
  }

  function applyNavState() {
    settingsCard?.classList.toggle("nav-collapsed", navCollapsed);
    if (!navToggle) return;
    const expanded = !navCollapsed;
    const label = navText(expanded ? "settingsCollapseNavigation" : "settingsExpandNavigation", expanded ? "收起分类" : "展开分类");
    navToggle.setAttribute("aria-expanded", String(expanded));
    navToggle.setAttribute("aria-label", label);
    navToggle.title = label;
  }

  function activateSection(id, persist = true) {
    const selected = sectionIds.includes(id) ? id : sectionIds[0];
    sectionButtons.forEach((button) => {
      const active = button.dataset.settingsSection === selected;
      button.setAttribute("aria-selected", String(active));
      button.classList.toggle("active", active);
    });
    panels.forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== selected; });
    if (persist) localStorage.setItem(STORAGE_KEY, selected);
  }

  sectionButtons.forEach((button) => button.addEventListener("click", () => activateSection(button.dataset.settingsSection)));
  navToggle?.addEventListener("click", () => {
    navCollapsed = !navCollapsed;
    try { localStorage.setItem(NAV_COLLAPSED_KEY, navCollapsed ? "1" : "0"); } catch (_) {}
    applyNavState();
  });
  global.addEventListener?.("app-language-changed", applyNavState);
  activateSection(localStorage.getItem(STORAGE_KEY), false);
  applyNavState();

  const previewBindings = [
    { input: "set-cover-title", targets: ["fp-shelf-preview-title"] },
    { input: "set-cover-prog", targets: ["fp-shelf-preview-progress", "fp-shelf-preview-progress-bar"] },
    { input: "set-cover-rating", targets: ["fp-shelf-preview-rating"] },
  ];
  function syncShelfPreview() {
    previewBindings.forEach(({ input, targets }) => {
      const control = document.getElementById(input);
      targets.forEach((id) => {
        const target = document.getElementById(id);
        if (target && control) target.hidden = !control.checked;
      });
    });
  }
  previewBindings.forEach(({ input }) => document.getElementById(input)?.addEventListener("change", syncShelfPreview));
  syncShelfPreview();

  global.ReaderSettingsLayoutUI = Object.freeze({ activateSection, syncShelfPreview, applyNavState });
})(window);
