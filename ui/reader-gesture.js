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
  const undoHistory = [];
  const hint = createHint();

  function trace(event) {
    const invoke = global.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") void Promise.resolve(invoke("reader_perf_log", { event: "gesture " + String(event).slice(0, 480) })).catch(() => {});
  }

  const DEFAULT_HINT_SETTINGS = Object.freeze({ fontSize: 20, backgroundEnabled: true, background: "#173b6b", opacity: 60, positionX: 0.96, positionY: 0.04, frameWidth: 200, frameHeight: 60, frameShape: "rect", framePath: [] });
  function hintHex(value) { return /^#[0-9a-f]{6}$/i.test(String(value || "")) ? String(value).toLowerCase() : DEFAULT_HINT_SETTINGS.background; }
  function hintPosition(value, fallback) { return Math.max(0, Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback)); }
  function hintFrameSize(value, fallback, minimum, maximum) { return Math.max(minimum, Math.min(maximum, Number.isFinite(Number(value)) ? Number(value) : fallback)); }
  function hintFrameShape(value) { return value === "freeform" ? "freeform" : "rect"; }
  function hintFramePath(value) { return Array.isArray(value) ? value.map((point) => ({ x: Number(point?.x), y: Number(point?.y) })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 100 && point.y >= 0 && point.y <= 100).slice(0, 48) : []; }
  function hintClipPath(settings) { return settings.frameShape === "freeform" && settings.framePath.length >= 3 ? "polygon(" + settings.framePath.map((point) => point.x + "% " + point.y + "%").join(",") + ")" : "none"; }
  function hintSettings() {
    if (sharedSettings?.hintSettings) return sharedSettings.hintSettings;
    try {
      const saved = JSON.parse(global.localStorage?.getItem?.(HINT_SETTINGS_KEY) || "{}");
    return { enabled: saved.enabled === true, fontSize: Math.max(12, Math.min(28, Number(saved.fontSize) || DEFAULT_HINT_SETTINGS.fontSize)), backgroundEnabled: saved.backgroundEnabled !== false, background: hintHex(saved.background), opacity: Math.max(20, Math.min(100, Number(saved.opacity) || DEFAULT_HINT_SETTINGS.opacity)), positionX: hintPosition(saved.positionX, DEFAULT_HINT_SETTINGS.positionX), positionY: hintPosition(saved.positionY, DEFAULT_HINT_SETTINGS.positionY), frameWidth: hintFrameSize(saved.frameWidth, DEFAULT_HINT_SETTINGS.frameWidth, 96, 520), frameHeight: hintFrameSize(saved.frameHeight, DEFAULT_HINT_SETTINGS.frameHeight, 40, 240), frameShape: hintFrameShape(saved.frameShape), framePath: hintFramePath(saved.framePath) };
    } catch (_) { return { enabled: false, ...DEFAULT_HINT_SETTINGS }; }
  }
  function hintColor(settings) {
    if (!settings.backgroundEnabled) return "transparent";
    const hex = settings.background.slice(1);
    const rgb = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
    return "rgba(" + rgb.join(",") + "," + (settings.opacity / 100) + ")";
  }
  function createHint() {
    const node = root.createElement("div");
    node.className = "reader-gesture-hint";
    node.dataset.overlaySurface = "gesture-hint";
    node.dataset.overlayRole = "feedback";
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
  function hideHint() {
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = 0;
    hint.hidden = true;
    hint.removeAttribute("data-overlay-active");
  }
  function showHint(name) {
    // Settings are loaded for each match so changes made in the main window apply immediately.
    const settings = hintSettings();
    if (!settings.enabled) return;
    hint.textContent = name || "手势已匹配";
    hint.style.fontSize = settings.fontSize + "px";
    hint.style.background = hintColor(settings);
    hint.style.width = Math.round(settings.frameWidth) + "px";
    hint.style.minHeight = Math.round(settings.frameHeight) + "px";
    hint.style.clipPath = hintClipPath(settings);
    hint.dataset.overlayActive = "true";
    hint.hidden = false;
    placeHint(settings);
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = global.setTimeout(hideHint, HINT_DURATION_MS);
  }
  function normalizeAction(value) {
    if (value === "book_info") return "book_info";
    if (value === "undo_last" || value === "reopen_last" || value === "restore_jump") return "undo_last";
    return "back";
  }
  function actionLabel(action) { return ({ back: "返回／关闭当前页", book_info: "信息提取／说明", undo_last: "撤销上一步" })[action] || "返回／关闭当前页"; }
  function normalizeScope(_action, value) {
    return value === "main" || value === "reader" ? value : "auto";
  }
  function profileName(profile, action) {
    const savedName = String(profile?.name || "").trim().slice(0, 24);
    return action === "undo_last" && ["重新打开上一个页面", "恢复跳转前位置"].includes(savedName)
      ? actionLabel(action)
      : savedName || actionLabel(action);
  }
  function normalizeSharedSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    const profiles = Array.isArray(source.profiles) ? source.profiles : [];
    return {
      enabled: source.enabled === true,
      globalPrecision: api.normalizePrecision(source.globalPrecision),
      profiles: profiles.map((profile) => {
        const action = normalizeAction(profile?.action);
        return {
        name: profileName(profile, action),
        scope: normalizeScope(action, profile?.scope),
        action,
        enabled: profile?.enabled !== false,
        points: api.cleanPoints(profile?.points),
        precision: profile?.precisionMode === "global" ? api.normalizePrecision(source.globalPrecision) : api.normalizePrecision(profile?.precision),
      };
      }).filter((profile) => profile.enabled && profile.scope !== "main" && ["back", "book_info", "undo_last"].includes(profile.action) && profile.points.length === api.SAMPLE_COUNT),
      hintSettings: {
        enabled: source?.hintSettings?.enabled === true,
        fontSize: Math.max(12, Math.min(28, Number(source?.hintSettings?.fontSize) || DEFAULT_HINT_SETTINGS.fontSize)),
        backgroundEnabled: source?.hintSettings?.backgroundEnabled !== false,
        background: hintHex(source?.hintSettings?.background),
        opacity: Math.max(20, Math.min(100, Number(source?.hintSettings?.opacity) || DEFAULT_HINT_SETTINGS.opacity)),
        positionX: hintPosition(source?.hintSettings?.positionX, DEFAULT_HINT_SETTINGS.positionX),
        positionY: hintPosition(source?.hintSettings?.positionY, DEFAULT_HINT_SETTINGS.positionY),
        frameWidth: hintFrameSize(source?.hintSettings?.frameWidth, DEFAULT_HINT_SETTINGS.frameWidth, 96, 520),
        frameHeight: hintFrameSize(source?.hintSettings?.frameHeight, DEFAULT_HINT_SETTINGS.frameHeight, 40, 240),
        frameShape: hintFrameShape(source?.hintSettings?.frameShape),
        framePath: hintFramePath(source?.hintSettings?.framePath),
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
      const usable = list.map((profile) => {
        const action = normalizeAction(profile?.action);
        return {
          name: profileName(profile, action),
          scope: normalizeScope(action, profile?.scope),
          action,
          enabled: profile?.enabled !== false,
          points: api.cleanPoints(profile?.points),
          precision: profile?.precisionMode === "global" ? api.normalizePrecision(saved.globalPrecision) : api.normalizePrecision(profile?.precision),
        };
      }).filter((profile) => profile.enabled && profile.scope !== "main" && ["back", "book_info", "undo_last"].includes(profile.action) && profile.points.length === api.SAMPLE_COUNT);
      if (enabled && usable.length) return usable;
    } catch (_) { /* fall back to legacy reader gesture */ }
    const path = api.load(global.localStorage);
    return api.loadEnabled(global.localStorage) && path.length ? [{ name: "返回／关闭当前页", action: "back", points: path, precision: api.loadPrecision(global.localStorage) }] : [];
  }
  function clear() {
    active = null;
    trail.hidden = true;
    trail.removeAttribute("data-overlay-active");
    api.draw(trail, []);
  }
  function paint(points) {
    trail.dataset.overlayActive = "true";
    trail.hidden = false;
    api.draw(trail, points, { color: "#3478d4", lineWidth: 5 });
  }
  function start(x, y, source = "host") {

    const currentProfiles = profiles();
    if (!currentProfiles.length) return;
    hideHint();
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
  function previewMatchFor(gesture) {
    let best = null;
    gesture.profiles.forEach((profile) => {
      if (!canApplyAction(profile.action)) return;
      const score = api.prefixSimilarity(profile.points, gesture.points);
      if (score >= Math.max(0.70, api.matchThreshold(profile.precision)) && (!best || score > best.score)) best = { profile, score };
    });
    return best;
  }
  function rememberUndoEntry(entry) {
    undoHistory.push({ ...entry, at: Date.now() });
    if (undoHistory.length > 16) undoHistory.splice(0, undoHistory.length - 16);
  }
  function rememberClosedSurface(name, reopen) {
    if (typeof reopen !== "function") return;
    rememberUndoEntry({ kind: "surface", name: String(name || "上一个页面").slice(0, 48), reopen });
  }
  function listenForUndoCheckpoints() {
    global.addEventListener("reader-undo-checkpoint", () => rememberUndoEntry({ kind: "jump" }));
  }
  function listenForClosedSurfaces() {
    global.addEventListener("reader-shell-statechange", (event) => {
      const previous = event.detail?.previous || {};
      const next = event.detail?.next || {};
      const none = global.ReaderShell?.OVERLAY?.NONE || "none";
      const noSidePanel = global.ReaderShell?.SIDE_PANEL?.NONE || "none";
      if (previous.sidePanel && previous.sidePanel !== noSidePanel && next.sidePanel === noSidePanel) {
        const name = previous.sidePanel === "ai-reader" ? "智读" : previous.sidePanel;
        rememberClosedSurface(name, () => global.ReaderShell?.setSidePanel?.(previous.sidePanel, true));
        return;
      }
      if (!previous.overlay || previous.overlay === none || next.overlay !== none) return;
      rememberClosedSurface(previous.overlay, () => global.ReaderShell?.setOverlay?.(previous.overlay, true));
    });
  }
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
    const shell = global.ReaderShell;
    if (shell?.closeSurface?.()) return;
    if (source === "frame" && await requestFrameSurfaceClose()) return;
    global.closeReaderWindow?.();
  }
  function canUndoLastReaderAction() {
    while (undoHistory.length) {
      const previous = undoHistory[undoHistory.length - 1];
      if (previous.kind !== "jump" || global.hasReaderJumpHistory?.() === true) return true;
      undoHistory.pop();
    }
    return false;
  }
  function undoLastReaderAction() {
    while (canUndoLastReaderAction()) {
      const previous = undoHistory.pop();
      if (previous?.kind === "surface") {
        previous.reopen?.();
        return true;
      }
      if (global.restoreReaderJumpPosition?.()) return true;
    }
    return false;
  }
  function canApplyAction(action) {
    return action === "back"
      || action === "undo_last" && canUndoLastReaderAction()
      || action === "book_info" && typeof global.openReaderBookInfo === "function";
  }
  function previewMatch(gesture) {
    const matched = previewMatchFor(gesture);
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
    if (match.profile.action === "undo_last") {
      undoLastReaderAction();
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
    hideHint();
    if (matched && canApplyAction(matched.profile.action)) execute(matched, gesture);
  }
  function cancelKeepHint() {
    if (!active) { hideHint(); return; }
    const gesture = active; active = null;
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    hideHint();
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
  function startMouseGesture(event) {
    if (event.button === 0) { cancelKeepHint(); return; }
    if (event.button !== 2) return;
    start(event.clientX, event.clientY);
    if (active) event.preventDefault();
  }
  // Keep mouse gestures on one event family. macOS WebKit can advertise mouse
  // PointerEvents while omitting their move phase, which leaves a gesture at
  // its first point and prevents matching.
  global.addEventListener("mousedown", startMouseGesture, true);
  global.addEventListener("mousemove", (event) => { if (active) { event.preventDefault(); move(event.clientX, event.clientY); } }, { capture: true, passive: false });
  global.addEventListener("mouseup", () => finish(), true);
  global.addEventListener("blur", () => { finish(true); hideHint(); });
  root.addEventListener("visibilitychange", () => { if (root.hidden) hideHint(); });
  global.addEventListener("contextmenu", (event) => { if (active || Date.now() < suppressContextMenuUntil) event.preventDefault(); }, true);
  listenForClosedSurfaces();
  listenForUndoCheckpoints();
  void connectSharedSettings();
  global.ReaderGestureClose = { fromFrame, frameSurfaceClosed };
})(window);
