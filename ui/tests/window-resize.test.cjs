const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ui, "window-resize.js"), "utf8");
const css = fs.readFileSync(path.join(ui, "window-resize.css"), "utf8");
const mainHtml = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const readerHtml = fs.readFileSync(path.join(ui, "reader.html"), "utf8");

function linuxHarness() {
  const calls = [];
  const elements = new Map();
  const makeElement = () => ({
    id: "",
    className: "",
    dataset: {},
    children: [],
    handlers: {},
    setAttribute() {},
    addEventListener(type, handler) { this.handlers[type] = handler; },
    appendChild(child) { this.children.push(child); },
  });
  const body = makeElement();
  body.appendChild = (child) => {
    body.children.push(child);
    if (child.id) elements.set(child.id, child);
  };
  const document = {
    body,
    createElement: makeElement,
    getElementById: (id) => elements.get(id) || null,
    addEventListener() {},
  };
  const window = {
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit" },
    __TAURI__: { core: { invoke: (command, payload) => {
      calls.push({ command, payload });
      return Promise.resolve();
    } } },
  };
  vm.runInNewContext(source, { window, document });
  return { body, calls };
}

test("main and reader windows load the shared Linux resize layer", () => {
  for (const html of [mainHtml, readerHtml]) {
    assert.match(html, /href="window-resize\.css"/);
    assert.match(html, /src="window-resize\.js"/);
  }
});

test("Linux installs all eight native resize directions", () => {
  const { body } = linuxHarness();
  const container = body.children[0];
  assert.equal(container.id, "window-resize-handles");
  assert.deepEqual(
    Array.from(container.children, (handle) => handle.dataset.resizeDirection),
    ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"],
  );
  for (const cursor of ["n", "ne", "e", "se", "s", "sw", "w", "nw"]) {
    assert.match(css, new RegExp(`cursor:\\s*${cursor}-resize`));
  }
});

test("a primary pointer press starts native resize dragging", () => {
  const { body, calls } = linuxHarness();
  const handle = body.children[0].children[3];
  let prevented = false;
  let stopped = false;
  handle.handlers.pointerdown({
    button: 0,
    isPrimary: true,
    currentTarget: handle,
    preventDefault() { prevented = true; },
    stopPropagation() { stopped = true; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "main_window_start_resize_dragging");
  assert.equal(calls[0].payload.direction, "south-east");
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test("non-Linux webviews do not add custom resize handles", () => {
  const body = { children: [], appendChild(child) { this.children.push(child); } };
  vm.runInNewContext(source, {
    window: {
      navigator: { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      __TAURI__: { core: { invoke: () => Promise.resolve() } },
    },
    document: { body },
  });
  assert.equal(body.children.length, 0);
});