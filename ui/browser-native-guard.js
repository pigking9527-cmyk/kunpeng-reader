(function () {
  "use strict";

  const EDITABLE_SELECTOR = 'input, textarea, [contenteditable="true"], [data-native-selection]';

  function elementFor(target) {
    if (target instanceof Element) return target;
    return target && target.parentElement ? target.parentElement : null;
  }

  // Application drag interactions use Pointer Events. Do not let Chromium
  // start a separate native text/image/link drag session over an app surface.
  document.addEventListener("dragstart", (event) => event.preventDefault(), true);

  // UI copy selection is accidental noise. Editable controls and documents
  // that explicitly opt in keep their functional text selection.
  document.addEventListener("selectstart", (event) => {
    if (elementFor(event.target)?.closest(EDITABLE_SELECTOR)) return;
    event.preventDefault();
  }, true);
}());
