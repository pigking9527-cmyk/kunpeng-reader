const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "debug-ui.js"), "utf8");

test("debug export includes the bounded backend runtime diagnostics snapshot", () => {
  assert.match(source, /await invoke\("runtime_diagnostics"\)/);
  assert.match(source, /runtime_diagnostics:\s*runtimeDiagnostics/);
  assert.match(source, /runtimeDiagnostics = \{ unavailable: true \}/);
  assert.doesNotMatch(source, /runtimeDiagnostics = String\(/);
});
