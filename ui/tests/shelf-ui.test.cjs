const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "shelf-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8");

test("common settings dialog stays compact on desktop", () => {
  assert.match(styles, /#fp-settings-modal \.modal-card\s*\{[^}]*width:\s*min\(600px,\s*calc\(100vw - 48px\)\);/s);
});

test("book card clicks explicitly close main-window floaters", () => {
  const helper = source.match(/function closeShelfCardFloaters\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(helper, "shelf floater closer must remain explicit");
  assert.match(helper[1], /menuEl\.classList\.remove\("show"\)/);
  assert.match(helper[1], /filterPanel\.classList\.remove\("show"\)/);
  assert.match(helper[1], /closeAccountPanel\(\)/);
  assert.match(helper[1], /closeSearch\(false\)/);

  const card = source.slice(source.indexOf("function bookCard"), source.indexOf("// 更换封面"));
  assert.match(card, /addEventListener\("click",[\s\S]*?closeShelfCardFloaters\(\)/);
  assert.match(card, /addEventListener\("dblclick",[\s\S]*?closeShelfCardFloaters\(\)/);
});
