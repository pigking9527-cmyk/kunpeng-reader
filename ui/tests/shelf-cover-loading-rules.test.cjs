const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "shelf-cover-loading-rules.js"), "utf8");

function rules() {
  const context = { window: null };
  context.window = context;
  vm.runInNewContext(source, context);
  return context.ReaderShelfCoverLoadingRules;
}

test("shelf cover rules reserve a minimum eager window and cap a large grid", () => {
  const loading = rules();
  assert.equal(loading.estimateFirstScreenCoverCount({ width: 0, height: 800 }), 0);
  assert.equal(loading.firstScreenCoverCount({ width: 0, height: 800 }), 24);
  assert.equal(loading.estimateFirstScreenCoverCount({ layout: "list", width: 1280, height: 217 }), 3);
  assert.equal(loading.estimateFirstScreenCoverCount({ gridColumns: 3, width: 600, height: 420 }), 6);
  assert.equal(loading.estimateFirstScreenCoverCount({ width: 100000, height: 100000 }), 160);
});

test("shelf cover rules give only first-screen cards eager decode priority", () => {
  const loading = rules();
  const priority = (index) => JSON.parse(JSON.stringify(loading.coverLoadPriority(index, 24)));
  assert.deepEqual(
    priority(0),
    { decoding: "sync", fetchPriority: "high", loading: "eager" },
  );
  assert.deepEqual(
    priority(23),
    { decoding: "sync", fetchPriority: "high", loading: "eager" },
  );
  assert.deepEqual(
    priority(24),
    { decoding: "async", fetchPriority: "auto", loading: "lazy" },
  );
  assert.deepEqual(
    priority(-1),
    { decoding: "async", fetchPriority: "auto", loading: "lazy" },
  );
});
