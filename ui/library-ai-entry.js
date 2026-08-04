// Main-shelf entry for the local-library RAG workspace. It stays inside the
// already-running main WebView so opening it cannot create a second window.
(function (global) {
  "use strict";
  const root = global.document;
  const button = root?.getElementById("library-ai-toolbar-btn");
  const page = root?.getElementById("library-ai-page");
  const back = root?.getElementById("library-ai-back");
  const shell = root?.querySelector(".content-shell");
  if (!button || !page || !back || !shell || !global.ReaderLibraryAiUI) return;

  const assistant = global.ReaderLibraryAiUI.init({ root });
  if (!assistant) return;
  let loaded = false;

  async function open() {
    root.getElementById("menu")?.classList.remove("show");
    root.getElementById("filter-panel")?.classList.remove("show");
    root.getElementById("account-panel")?.classList.remove("show");
    if (!root.getElementById("newsnow-page")?.hidden) global.ReaderNewsUI?.instance?.close();
    shell.hidden = true;
    page.hidden = false;
    root.body.classList.add("library-ai-active");
    button.setAttribute("aria-pressed", "true");
    if (!loaded) {
      loaded = true;
      await assistant.load();
    }
  }

  function close() {
    page.hidden = true;
    shell.hidden = false;
    root.body.classList.remove("library-ai-active");
    button.setAttribute("aria-pressed", "false");
    button.focus({ preventScroll: true });
  }

  function toggle() {
    if (page.hidden) {
      void open();
    } else {
      close();
    }
  }

  button.addEventListener("click", toggle);
  back.addEventListener("click", close);
  global.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !page.hidden) close();
  });
  global.ReaderLibraryAiEntry = { open, close, toggle, assistant };
})(window);
