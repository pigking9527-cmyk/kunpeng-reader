const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "generated-ts", "gesture-hint-rules.js"),
  "utf8",
);
const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function rules() {
  const context = {};
  context.window = context;
  vm.runInNewContext(source, context, { filename: "gesture-hint-rules.js" });
  return context.ReaderGestureHintRules;
}

test("gesture hint rules normalize settings without DOM, storage or IPC", () => {
  const hint = rules();
  let id = 0;
  const normalized = hint.normalizeHintSettings(
    {
      enabled: 1,
      fontSize: 99,
      backgroundEnabled: false,
      background: "#ABCDEF",
      opacity: 1,
      positionX: -2,
      positionY: 2,
      frameWidth: 1,
      frameHeight: 999,
      frameShape: "other",
      quickColors: [
        { color: "#112233", name: "  海蓝  " },
        { color: "not-a-color" },
        { color: "#445566" },
      ],
    },
    () => "generated-" + ++id,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), {
    enabled: false,
    fontSize: 28,
    backgroundEnabled: false,
    background: "#abcdef",
    opacity: 20,
    positionX: 0,
    positionY: 1,
    frameWidth: 96,
    frameHeight: 240,
    frameShape: "rect",
    framePath: [],
    quickColors: [
      { id: "generated-1", name: "海蓝", color: "#112233" },
      { id: "generated-2", name: "快捷颜色", color: "#445566" },
    ],
  });
});

test("gesture hint rules retain only bounded freeform paths and make a clip path", () => {
  const hint = rules();
  const path = hint.normalizeHintFramePath([
    { x: 0, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 0 },
    { x: 101, y: 0 },
    { x: "not-a-number", y: 0 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(path)), [
    { x: 0, y: 0 },
    { x: 50, y: 100 },
    { x: 100, y: 0 },
  ]);
  assert.equal(
    hint.hintFrameClipPath({ frameShape: "freeform", framePath: path }),
    "polygon(0% 0%,50% 100%,100% 0%)",
  );
  assert.equal(hint.hintFrameClipPath({ frameShape: "rect", framePath: path }), "none");
});

test("gesture hint rules compact freeform samples while preserving endpoints", () => {
  const hint = rules();
  const points = Array.from({ length: 7 }, (_, x) => ({ x, y: x * 2 }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(hint.compactFreeformPoints(points, 3))),
    [points[0], points[3], points[6]],
  );
  const unchanged = hint.compactFreeformPoints(points, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(unchanged)), points);
  assert.notEqual(unchanged, points);
});

test("main-window gesture shell preloads the hint rule boundary", () => {
  assert.match(
    indexHtml,
    /<script src="generated-ts\/gesture-hint-rules\.js"><\/script>[\s\S]*?<script src="generated-ts\/gesture-ui\.js"><\/script>/,
  );
  assert.match(source, /ReaderGestureHintRules/);
});
