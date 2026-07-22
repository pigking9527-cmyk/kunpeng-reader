const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const uiRoot = path.join(__dirname, "..");
const pagination = fs.readFileSync(path.join(uiRoot, "reader-page-pagination.js"), "utf8");
const measurement = fs.readFileSync(path.join(uiRoot, "reader-page-measurement.js"), "utf8");

test("reader page modules parse in their compiled injection order", () => {
  const source = [
    "reader-page-layout.js",
    "reader-page-pagination.js",
    "reader-page-measurement.js",
    "reader-page-annotations.js",
    "reader-page-runtime.js",
  ].map((name) => fs.readFileSync(path.join(uiRoot, name), "utf8")).join("");
  assert.doesNotThrow(() => new vm.Script(source));
});

function paginationContext(width = 1200, pageMode = "single") {
  const context = {
    S: {
      styleMode: "local",
      fontSize: 18,
      noteFontSize: 14,
      lineHeight: 1.7,
      paraSpacing: 0.6,
      letterSpacing: 0,
      fontFamily: "",
      marginTop: 18,
      marginBottom: 24,
      marginLeft: 28,
      marginRight: 28,
      pageMode,
      flowMode: "paged",
    },
    window: { innerWidth: width, innerHeight: 800 },
    document: { documentElement: { clientHeight: 800 } },
    pager: null,
    scroller: null,
  };
  vm.runInNewContext(pagination, context);
  return context;
}

test("pagination geometry keeps whole-book signatures independent from dual-page mode", () => {
  const context = paginationContext(1200, "single");
  const singlePageCountSig = context.pageCountSig();
  const singleLayoutSig = context.layoutSig();
  context.S.pageMode = "dual";
  assert.equal(context.pageCountSig(), singlePageCountSig);
  assert.notEqual(context.layoutSig(), singleLayoutSig);
  assert.equal(context.columnsPerView(), 2);
  const dual = context.pageLayout();
  assert.equal(dual.pageStep, dual.colPitch * 2);

  context.window.innerWidth = 899;
  assert.equal(context.isDualPage(), false);
  assert.equal(context.columnsPerView(), 1);
  assert.equal(context.pageLayout().pageStep, 899);
});

test("pagination geometry clamps unsafe margins and keeps dual counts in spreads", () => {
  const context = paginationContext(1200, "dual");
  assert.equal(context.mg(-8), 0);
  assert.equal(context.mg(999), 240);
  const layout = context.pageLayout();
  const sixPhysicalColumns = 6 * layout.colPitch + layout.l - layout.gap;
  assert.equal(context.columnCountFromWidth(sixPhysicalColumns, false), 3);
});

test("incremental page cache resumes incomplete books and accepts complete books", () => {
  const scheduled = [];
  const context = {
    CH: 3,
    pageCountSig: () => "same-layout",
    report: () => {},
    scheduleMeasure: (delay) => scheduled.push(delay),
    clearTimeout: () => {},
    setTimeout: () => 1,
  };
  vm.runInNewContext(measurement, context);
  // Replace the module function so this test observes the resume request directly.
  context.scheduleMeasure = (delay) => scheduled.push(delay);
  context.applyPageCache({ sig: "same-layout", pages: [4, 0, 6], complete: false });
  assert.equal(context.measureDone, false);
  assert.deepEqual(Array.from(context.chapterPages), [4, 0, 6]);
  assert.deepEqual(scheduled, [60]);

  scheduled.length = 0;
  context.applyPageCache({ sig: "same-layout", pages: [4, 5, 6], complete: true });
  assert.equal(context.measureDone, true);
  assert.deepEqual(scheduled, []);
});
