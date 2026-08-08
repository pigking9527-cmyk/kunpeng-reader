// Reader-window adapter for the shared hand-drawn return gesture.
(function (global) {
  "use strict";
  const api = global.ReaderNewsGesture;
  const trail = global.document?.getElementById("reader-gesture-trail");
  if (!api || !trail) return;
  let active = null;
  let suppressContextMenuUntil = 0;

  function settings() {
    return {
      path: api.load(global.localStorage),
      enabled: api.loadEnabled(global.localStorage),
      precision: api.loadPrecision(global.localStorage),
    };
  }
  function clear() { active = null; trail.hidden = true; api.draw(trail, []); }
  function paint(points) { trail.hidden = false; api.draw(trail, points, { color: "#3478d4", lineWidth: 5 }); }
  function start(x, y) {
    const current = settings();
    if (!current.enabled || !current.path.length || global.document.querySelector(".modal.show")) return;
    active = { points: [{ x, y }], path: current.path, precision: current.precision };
    paint(active.points);
  }
  function move(x, y) {
    if (!active) return;
    const previous = active.points[active.points.length - 1];
    if (Math.hypot(x - previous.x, y - previous.y) < 4) return;
    active.points.push({ x, y });
    if (active.points.length > 160) active.points.splice(1, 1);
    paint(active.points);
  }
  function finish(cancelled = false) {
    if (!active) return;
    const gesture = active; active = null;
    const matched = !cancelled && api.similarity(gesture.path, gesture.points) >= api.matchThreshold(gesture.precision);
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    if (matched) global.closeReaderWindow?.();
  }
  function fromFrame(payload) {
    const frame = global.document.getElementById("frame");
    if (!frame || !payload) return;
    const rect = frame.getBoundingClientRect();
    const x = rect.left + Number(payload.x), y = rect.top + Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (payload.phase === "start") start(x, y);
    else if (payload.phase === "move") move(x, y);
    else if (payload.phase === "end") finish();
    else if (payload.phase === "cancel") finish(true);
  }
  global.addEventListener("mousedown", (event) => {
    if (event.button !== 2 || event.target?.closest?.(".modal")) return;
    start(event.clientX, event.clientY);
    if (active) event.preventDefault();
  }, true);
  global.addEventListener("mousemove", (event) => { if (active) { event.preventDefault(); move(event.clientX, event.clientY); } }, { capture: true, passive: false });
  global.addEventListener("mouseup", () => finish(), true);
  global.addEventListener("blur", () => finish(true));
  global.addEventListener("contextmenu", (event) => { if (active || Date.now() < suppressContextMenuUntil) event.preventDefault(); }, true);
  global.ReaderGestureClose = { fromFrame };
})(window);
