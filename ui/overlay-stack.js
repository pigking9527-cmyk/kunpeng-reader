(function (root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root?.document) {
    root.ReaderOverlayStack = api;
    api.mount(root);
  }
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";

  const ROLE_BASE = Object.freeze({
    operation: 100000,
    information: 100000,
    critical: 300000,
    feedback: 400000,
  });

  const ROLE_BAND = Object.freeze({
    operation: "interactive",
    information: "interactive",
    critical: "critical",
    feedback: "feedback",
  });

  function normalizeRole(value) {
    return Object.hasOwn(ROLE_BASE, value) ? value : "operation";
  }

  function computeLevels(entries) {
    const levels = new Array(entries.length);
    ["interactive", "critical", "feedback"].forEach((band) => {
      entries
        .map((entry, index) => ({
          index,
          order: Number(entry?.order) || 0,
          role: normalizeRole(entry?.role),
        }))
        .filter((entry) => ROLE_BAND[entry.role] === band)
        .sort((left, right) => left.order - right.order)
        .forEach((entry, bandIndex) => {
          levels[entry.index] = ROLE_BASE[entry.role] + bandIndex;
        });
    });
    return levels;
  }

  function mount(global) {
    const document = global?.document;
    if (
      !document?.documentElement ||
      typeof global.MutationObserver !== "function"
    )
      return null;

    let nextOrder = 1;
    const openOrder = new WeakMap();

    function visibleSurfaces() {
      return Array.from(
        document.querySelectorAll(
          ".modal.show, [data-overlay-surface].show, [data-overlay-surface][data-overlay-active=\"true\"]",
        ),
      ).filter((surface) => !surface.hidden);
    }

    function sync() {
      const visible = visibleSurfaces();
      const visibleSet = new Set(visible);
      document
        .querySelectorAll('[data-overlay-managed="true"]')
        .forEach((surface) => {
          if (visibleSet.has(surface)) return;
          openOrder.delete(surface);
          surface.removeAttribute("data-overlay-managed");
          surface.style.removeProperty("--overlay-z-index");
        });

      const entries = visible.map((surface) => {
        if (!openOrder.has(surface)) openOrder.set(surface, nextOrder++);
        return {
          order: openOrder.get(surface),
          role: surface.dataset.overlayRole,
        };
      });
      const levels = computeLevels(entries);
      visible.forEach((surface, index) => {
        surface.dataset.overlayManaged = "true";
        surface.style.setProperty("--overlay-z-index", String(levels[index]));
      });
    }

    const observer = new global.MutationObserver(sync);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        "class",
        "hidden",
        "data-overlay-role",
        "data-overlay-active",
      ],
    });
    sync();
    return Object.freeze({ sync, disconnect: () => observer.disconnect() });
  }

  return Object.freeze({ ROLE_BASE, normalizeRole, computeLevels, mount });
});
