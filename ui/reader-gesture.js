(function (global) {
  "use strict";
  const api = global.ReaderNewsGesture;
  const root = global.document;
  const trail = root?.getElementById("reader-gesture-trail");
  if (!api || !trail || !root) return;

  const MANAGER_KEY = "kunpeng.reader.gesture-manager.v1";
  const MANAGER_ENABLED_KEY = "kunpeng.reader.gesture-manager.enabled.v1";
  const HINT_SETTINGS_KEY = "kunpeng.reader.gesture-hint.v1";
  const HINT_DURATION_MS = 1200;
  let active = null;
  let suppressContextMenuUntil = 0;
  let hintTimer = 0;
  let sharedSettings = null;
  let pendingFrameSurfaceClose = null;
  const closedOverlays = [];
  const hint = createHint();

  function trace(event) {
    const invoke = global.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") void Promise.resolve(invoke("reader_perf_log", { event: "gesture " + String(event).slice(0, 480) })).catch(() => {});
  }

  function hintHex(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : "#173b6b"; }
  function hintPosition(value, fallback) { return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback)); }
  function hintSettings() {
    if (sharedSettings?.hintSettings) return sharedSettings.hintSettings;
    try {
      const saved = JSON.parse(global.localStorage?.getItem?.(HINT_SETTINGS_KEY) || "{}");
    return { enabled: saved.enabled === true, fontSize: Math.max(12, Math.min(28, Number(saved.fontSize) || 16)), backgroundEnabled: saved.backgroundEnabled !== false, background: hintHex(saved.background), opacity: Math.max(20, Math.min(100, Number(saved.opacity) || 88)), positionX: hintPosition(saved.positionX, 1), positionY: hintPosition(saved.positionY, 0) };
    } catch (_) { return { enabled: false, fontSize: 16, backgroundEnabled: true, background: "#173b6b", opacity: 88, positionX: 1, positionY: 0 }; }
  }
  function hintColor(settings) {
    if (!settings.backgroundEnabled) return "transparent";
    const hex = settings.background.slice(1);
    const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return "rgba(" + rgb.join(",") + "," + (settings.opacity / 100) + ")";
  }
  function createHint() {
    const node = root.createElement("div");
    node.style.cssText = "position:fixed;z-index:10050;top:16px;right:16px;width:max-content;max-width:calc(100vw - 32px);box-sizing:border-box;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:9px 13px;border-radius:9px;color:#fff;font-weight:700;line-height:1.35;box-shadow:0 8px 22px rgba(32,57,93,.2);pointer-events:none";
    node.hidden = true;
    root.body?.appendChild(node);
    return node;
  }
  function placeHint(settings) {
    const maxLeft = Math.max(0, global.innerWidth - hint.offsetWidth);
    const maxTop = Math.max(0, global.innerHeight - hint.offsetHeight);
    hint.style.left = Math.round(maxLeft * settings.positionX) + "px";
    hint.style.top = Math.round(maxTop * settings.positionY) + "px";
    hint.style.right = "auto";
  }
  function showHint(name) {
    // Settings are loaded for each match so changes made in the main window apply immediately.
    const settings = hintSettings();
    if (!settings.enabled) return;
    hint.textContent = name || "手势已匹配";
    hint.style.fontSize = settings.fontSize + "px";
    hint.style.background = hintColor(settings);
    hint.hidden = false;
    placeHint(settings);
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = global.setTimeout(() => { hint.hidden = true; }, HINT_DURATION_MS);
  }
  function actionLabel(action) { return ({ back: "返回／关闭当前页", book_info: "打开图书信息", reopen_last: "重新打开上一个页面" })[action] || "返回／关闭当前页"; }
  function normalizeSharedSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const profiles = Array.isArray(source.profiles) ? source.profiles : [];
    return {
      enabled: source.enabled === true,
      globalPrecision: api.normalizePrecision(source.globalPrecision),
      profiles: profiles.map((profile) => ({
        name: String(profile?.name || actionLabel(profile?.action)).slice(0, 24),
        action: profile?.action,
        enabled: profile?.enabled !== false,
        points: api.cleanPoints(profile?.points),
        precision: profile?.precisionMode === "global" ? api.normalizePrecision(source.globalPrecision) : api.normalizePrecision(profile?.precision),
      })).filter((profile) => profile.enabled && ["back", "book_info", "reopen_last"].includes(profile.action) && profile.points.length === api.SAMPLE_COUNT),
      hintSettings: {
        enabled: source?.hintSettings?.enabled === true,
        fontSize: Math.max(12, Math.min(28, Number(source?.hintSettings?.fontSize) || 16)),
        backgroundEnabled: source?.hintSettings?.backgroundEnabled !== false,
        background: hintHex(source?.hintSettings?.background),
        opacity: Math.max(20, Math.min(100, Number(source?.hintSettings?.opacity) || 88)),
        positionX: hintPosition(source?.hintSettings?.positionX, 1),
        positionY: hintPosition(source?.hintSettings?.positionY, 0),
      },
    };
  }
  async function connectSharedSettings() {
    const eventApi = global.__TAURI__?.event;
    const invoke = global.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") {
      try {
        const saved = await invoke("reader_gesture_settings_load");
        if (saved) {
          sharedSettings = normalizeSharedSettings(saved);
          trace("config durable enabled=" + sharedSettings.enabled + " actions=" + sharedSettings.profiles.map((profile) => profile.action).join(","));
        } else trace("config durable empty");
      } catch (_) { trace("config durable failed"); /* event bridge below remains a live-update fallback */ }
    }
    if (typeof eventApi?.listen !== "function" || typeof eventApi?.emit !== "function") return;
    try {
      await eventApi.listen("reader-gesture-settings", (event) => {
        sharedSettings = normalizeSharedSettings(event?.payload);
        trace("config event enabled=" + sharedSettings.enabled + " actions=" + sharedSettings.profiles.map((profile) => profile.action).join(","));
      });
      await eventApi.emit("reader-gesture-settings-request", {});
    } catch (_) { /* durable snapshot above is enough for a new reader window */ }
  }
  function profiles() {
    if (sharedSettings?.enabled && sharedSettings.profiles.length) return sharedSettings.profiles;
    try {
      const enabledValue = global.localStorage?.getItem?.(MANAGER_ENABLED_KEY);
      const enabled = enabledValue === "true" || enabledValue === "1";
      const saved = JSON.parse(global.localStorage?.getItem?.(MANAGER_KEY) || "{}");
      const list = Array.isArray(saved?.profiles) ? saved.profiles : [];
      const usable = list.filter((profile) => profile?.enabled !== false && ["back", "book_info", "reopen_last"].includes(profile?.action) && api.cleanPoints(profile.points).length === api.SAMPLE_COUNT)
        .map((profile) => ({ name: String(profile.name || actionLabel(profile.action)).slice(0, 24), action: profile.action, points: api.cleanPoints(profile.points), precision: profile.precisionMode === "global" ? api.normalizePrecision(saved.globalPrecision) : api.normalizePrecision(profile.precision) }));
      if (enabled && usable.length) return usable;
    } catch (_) { /* fall back to legacy reader gesture */ }
    const path = api.load(global.localStorage);
    return api.loadEnabled(global.localStorage) && path.length ? [{ name: "返回／关闭当前页", action: "back", points: path, precision: api.loadPrecision(global.localStorage) }] : [];
  }
  function clear() { active = null; trail.hidden = true; api.draw(trail, []); }
  function paint(points) { trail.hidden = false; api.draw(trail, points, { color: "#3478d4", lineWidth: 5 }); }
  function start(x, y, source = "host") {

    const currentProfiles = profiles();
    if (!currentProfiles.length) return;
    trace("start source=" + (sharedSettings ? "shared" : "local") + " actions=" + currentProfiles.map((profile) => profile.action).join(","));
    active = { points: [{ x, y }], profiles: currentProfiles, previewProfileId: null, source };
    paint(active.points);
  }
  function bestMatch(gesture) {
    let best = null;
    gesture.profiles.forEach((profile) => {
      const score = api.similarity(profile.points, gesture.points);
      if (score >= api.matchThreshold(profile.precision) && (!best || score > best.score)) best = { profile, score };
    });
    return best;
  }
  function canReopenOverlay() { return closedOverlays.length > 0; }
  function requestFrameSurfaceClose() {
    const frame = root.getElementById("frame");
    if (!frame?.contentWindow) return Promise.resolve(false);
    if (pendingFrameSurfaceClose) pendingFrameSurfaceClose(false);
    return new Promise((resolve) => {
      const timer = global.setTimeout(() => finishPendingFrameSurfaceClose(false), 120);
      pendingFrameSurfaceClose = (handled) => {
        global.clearTimeout(timer);
        pendingFrameSurfaceClose = null;
        resolve(handled === true);
      };
      frame.contentWindow.postMessage({ readerGestureAction: "back" }, "*");
    });
  }
  function finishPendingFrameSurfaceClose(handled) {
    if (pendingFrameSurfaceClose) pendingFrameSurfaceClose(handled);
  }
  async function closeReaderSurface(source) {
    if (root.body?.classList.contains("ai-reader-open")) {
      global.closeAiReaderSide?.();
      return;
    }

    const shell = global.ReaderShell;
    const overlay = shell?.getState?.().overlay;
    if (overlay && overlay !== shell.OVERLAY?.NONE) {
      closedOverlays.push(overlay);
      if (closedOverlays.length > 8) closedOverlays.splice(0, closedOverlays.length - 8);
      shell.closeOverlay?.();
      return;
    }
    if (source === "frame" && await requestFrameSurfaceClose()) return;
    global.closeReaderWindow?.();
  }
  function reopenReaderSurface() {
    const overlay = closedOverlays.pop();
    if (overlay) global.ReaderShell?.setOverlay?.(overlay, true);
  }
  function canApplyAction(action) {
    return action === "back" || action === "reopen_last" && canReopenOverlay() || action === "book_info" && typeof global.openReaderBookInfo === "function";
  }
  function previewMatch(gesture) {
    const matched = bestMatch(gesture);
    if (!matched) {
      gesture.previewProfileId = null;
      return;
    }
    if (gesture.previewProfileId === matched.profile.action + "\u0000" + matched.profile.name) return;
    gesture.previewProfileId = matched.profile.action + "\u0000" + matched.profile.name;
    if (canApplyAction(matched.profile.action)) showHint(matched.profile.name);
  }
  function execute(match, gesture) {
    if (match.profile.action === "book_info") {
      trace("execute book_info direct=" + (typeof global.openReaderBookInfo === "function"));
      if (typeof global.openReaderBookInfo === "function") {
        void global.openReaderBookInfo();
      } else {
        root.getElementById("info-btn")?.click();
      }
      return;
    }
    if (match.profile.action === "reopen_last") {
      reopenReaderSurface();
      return;
    }
    void closeReaderSurface(gesture.source);
  }  function finish(cancelled = false) {
    if (!active) return;
    const gesture = active; active = null;
    const matched = !cancelled && bestMatch(gesture);
    trace("finish cancelled=" + Boolean(cancelled) + " action=" + (matched?.profile?.action || "none") + " points=" + gesture.points.length);
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    if (matched && canApplyAction(matched.profile.action)) { showHint(matched.profile.name); execute(matched, gesture); }
  }
  function cancelKeepHint() {
    if (!active) return;
    const gesture = active; active = null;
    const matched = bestMatch(gesture);
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    if (matched && canApplyAction(matched.profile.action)) showHint(matched.profile.name);
  }
  function fromFrame(payload) {
    const frame = root.getElementById("frame");
    if (!frame || !payload) return;
    const rect = frame.getBoundingClientRect();
    const x = rect.left + Number(payload.x), y = rect.top + Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (payload.phase === "start") start(x, y, "frame");
    else if (payload.phase === "move") move(x, y);
    else if (payload.phase === "end") finish();
    else if (payload.phase === "cancel") finish(true);
  }
  function frameSurfaceClosed(handled) { finishPendingFrameSurfaceClose(handled === true); }
  function move(x, y) {
    if (!active) return;
    const previous = active.points[active.points.length - 1];
    if (Math.hypot(x - previous.x, y - previous.y) < 4) return;
    active.points.push({ x, y });
    if (active.points.length > 160) active.points.splice(1, 1);
    paint(active.points);
    previewMatch(active);
  }
  global.addEventListener("mousedown", (event) => {
    if (event.button === 0) { cancelKeepHint(); return; }
    if (event.button !== 2) return;
    start(event.clientX, event.clientY);
    if (active) event.preventDefault();
  }, true);
  global.addEventListener("mousemove", (event) => { if (active) { event.preventDefault(); move(event.clientX, event.clientY); } }, { capture: true, passive: false });
  global.addEventListener("mouseup", () => finish(), true);
  global.addEventListener("blur", () => finish(true));
  global.addEventListener("contextmenu", (event) => { if (active || Date.now() < suppressContextMenuUntil) event.preventDefault(); }, true);
  void connectSharedSettings();
  global.ReaderGestureClose = { fromFrame, frameSurfaceClosed };
})(window);
