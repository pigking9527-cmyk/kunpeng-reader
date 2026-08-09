// A recovery point must not copy the whole WebView profile: that would include
// cookies and credentials.  Persist the application's own non-sensitive
// localStorage entries for each origin instead.
(function (global) {
  "use strict";
  const invoke = global.__TAURI__?.core?.invoke;
  const scope = global.location.pathname.endsWith("reader.html") ? "reader" : "main";
  const sensitive = (key) => /token|password|secret|api_key|apikey|credential/i.test(key);
  let previous = "";

  function capture() {
    const settings = {};
    for (let index = 0; index < global.localStorage.length; index += 1) {
      const key = global.localStorage.key(index);
      if (!key || sensitive(key)) continue;
      const value = global.localStorage.getItem(key);
      if (value !== null) settings[key] = value;
    }
    return settings;
  }

  async function flush(force) {
    if (typeof invoke !== "function") return;
    const settings = capture();
    const serialized = JSON.stringify(settings);
    if (!force && serialized === previous) return;
    await invoke("recovery_web_settings_save", { scope, settings });
    previous = serialized;
  }

  async function applyRestoredSettings() {
    if (typeof invoke !== "function") return false;
    const settings = await invoke("recovery_web_settings_take_restored", { scope });
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return false;
    const currentKeys = [];
    for (let index = 0; index < global.localStorage.length; index += 1) {
      const key = global.localStorage.key(index);
      if (key && !sensitive(key)) currentKeys.push(key);
    }
    currentKeys.forEach((key) => global.localStorage.removeItem(key));
    Object.entries(settings).forEach(([key, value]) => {
      if (!sensitive(key) && typeof value === "string") global.localStorage.setItem(key, value);
    });
    previous = JSON.stringify(capture());
    return true;
  }

  const ready = (async () => {
    try {
      if (await applyRestoredSettings()) {
        global.location.reload();
        return;
      }
      await flush(true);
      global.setInterval(() => { flush(false).catch(() => {}); }, 5000);
      global.addEventListener("pagehide", () => { flush(false).catch(() => {}); }, { capture: true });
    } catch (_) {
      // Preference snapshots are additive: UI storage remains usable offline.
    }
  })();

  global.ReaderRecoverySettings = Object.freeze({ flush, ready });
})(window);
