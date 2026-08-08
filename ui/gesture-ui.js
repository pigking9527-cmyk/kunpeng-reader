// Shared gesture settings and main-window return routing.
(function (global) {
  "use strict";
  const root = global.document;
  const api = global.ReaderNewsGesture;
  if (!root || !api) return;

  const modal = root.getElementById("gesture-settings-modal");
  const closeButton = root.getElementById("gesture-settings-close");
  const gear = root.getElementById("gesture-gear");
  const enabledInputs = [root.getElementById("set-gesture-enabled"), root.getElementById("gesture-settings-enabled")].filter(Boolean);
  const precision = root.getElementById("gesture-precision");
  const precisionValue = root.getElementById("gesture-precision-value");
  const pad = root.getElementById("gesture-pad");
  const save = root.getElementById("gesture-save");
  const clear = root.getElementById("gesture-clear");
  const status = root.getElementById("gesture-status");
  const trail = root.getElementById("newsnow-gesture-trail");
  if (!modal || !closeButton || !gear || !enabledInputs.length || !precision || !precisionValue || !pad || !save || !clear || !status || !trail) return;

  let saved = api.load(global.localStorage);
  let enabled = api.loadEnabled(global.localStorage);
  let level = api.loadPrecision(global.localStorage);
  let training = [];
  let trainingPointerId = null;
  let active = null;
  let suppressContextMenuUntil = 0;

  function levelLabel(value) { return String(value); }
  function syncControls() {
    enabledInputs.forEach((input) => { input.checked = enabled; });
    precision.value = level;
    precisionValue.textContent = levelLabel(level);
    if (!training.length) api.draw(pad, saved, { normalized: true, color: saved.length ? "#3478d4" : "#a4afbd", lineWidth: 5 });
  }
  function publish() {
    global.dispatchEvent(new CustomEvent("reader-gesture-settings-changed", { detail: { enabled, precision: level, hasPath: saved.length > 0 } }));
  }
  function setEnabled(next) {
    enabled = api.saveEnabled(!!next, global.localStorage);
    if (!enabled) clearTrail();
    syncControls(); publish();
  }
  function setPrecision(next) {
    level = api.savePrecision(next, global.localStorage);
    syncControls(); publish();
  }
  function clearTrail() {
    active = null; trail.hidden = true; api.draw(trail, []); trail.classList.remove("matched", "rejected");
  }
  function paintTrail(points) { trail.hidden = false; api.draw(trail, points, { color: "#3478d4", lineWidth: 5 }); }
  function activeTarget(target) {
    if (!enabled || !saved.length || target?.closest?.(".modal")) return null;
    const news = global.ReaderNewsUI?.instance;
    const newsSurface = news?.gestureSurface?.();
    if (newsSurface?.contains(target)) return () => news.gestureBack?.();
    const library = root.getElementById("library-ai-page");
    if (library && !library.hidden && library.contains(target)) return () => global.ReaderLibraryAiEntry?.close?.({ focus: false });
    return null;
  }
  function begin(event) {
    if (event.button !== 2) return;
    const onMatch = activeTarget(event.target);
    if (!onMatch) return;
    event.preventDefault();
    active = { points: [{ x: event.clientX, y: event.clientY }], onMatch };
    paintTrail(active.points);
  }
  function move(event) {
    if (!active) return;
    event.preventDefault();
    const previous = active.points[active.points.length - 1];
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 4) return;
    active.points.push({ x: event.clientX, y: event.clientY });
    if (active.points.length > 160) active.points.splice(1, 1);
    paintTrail(active.points);
  }
  function finish(event, cancelled = false) {
    if (!active) return;
    const gesture = active; active = null;
    const matched = !cancelled && api.similarity(saved, gesture.points) >= api.matchThreshold(level);
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clearTrail();
    if (matched) gesture.onMatch();
  }
  function padPoint(event) { const rect = pad.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function beginTraining(event) {
    if (event.button !== 0) return;
    event.preventDefault(); trainingPointerId = event.pointerId; training = [padPoint(event)];
    try { pad.setPointerCapture(event.pointerId); } catch (_) { /* best effort */ }
    status.textContent = "正在记录轨迹…"; api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
  }
  function moveTraining(event) {
    if (trainingPointerId !== event.pointerId) return;
    event.preventDefault(); const point = padPoint(event), previous = training[training.length - 1];
    if (Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return;
    training.push(point); api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
  }
  function finishTraining(event) {
    if (trainingPointerId !== event.pointerId) return;
    trainingPointerId = null;
    try { pad.releasePointerCapture(event.pointerId); } catch (_) { /* best effort */ }
    status.textContent = api.pathLength(training) >= api.MIN_PATH_LENGTH ? "轨迹已画好，点击“保存轨迹”生效。" : "轨迹太短，请重新画。";
  }
  function openSettings() { training = []; status.textContent = ""; modal.classList.add("show"); syncControls(); global.requestAnimationFrame(syncControls); }
  function closeSettings() { modal.classList.remove("show"); }

  gear.addEventListener("click", openSettings);
  closeButton.addEventListener("click", closeSettings);
  modal.addEventListener("click", (event) => { if (event.target === modal) closeSettings(); });
  enabledInputs.forEach((input) => input.addEventListener("change", () => setEnabled(input.checked)));
  precision.addEventListener("input", () => setPrecision(precision.value));
  pad.addEventListener("pointerdown", beginTraining);
  pad.addEventListener("pointermove", moveTraining);
  pad.addEventListener("pointerup", finishTraining);
  pad.addEventListener("pointercancel", finishTraining);
  save.addEventListener("click", () => {
    const next = api.save(training, global.localStorage);
    if (!next.length) { status.textContent = "轨迹太短，请重新画。"; return; }
    saved = next; training = []; setEnabled(true); status.textContent = "手势已保存并启用。"; syncControls();
  });
  clear.addEventListener("click", () => { api.clear(global.localStorage); saved = []; training = []; setEnabled(false); status.textContent = "手势已清除并关闭。"; syncControls(); });
  global.addEventListener("mousedown", begin, true);
  global.addEventListener("mousemove", move, { capture: true, passive: false });
  global.addEventListener("mouseup", (event) => finish(event), true);
  global.addEventListener("blur", () => finish(null, true));
  global.addEventListener("contextmenu", (event) => { if (active || Date.now() < suppressContextMenuUntil) event.preventDefault(); }, true);
  global.addEventListener("keydown", (event) => { if (event.key === "Escape" && modal.classList.contains("show")) closeSettings(); });
  syncControls();
  global.ReaderGestureUI = { openSettings, closeSettings };
})(window);
