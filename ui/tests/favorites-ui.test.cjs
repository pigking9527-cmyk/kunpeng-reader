const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const controller = fs.readFileSync(path.join(ui, "generated-ts", "favorites-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(ui, "favorites.css"), "utf8");

test("toolbar favorites is mounted as the single menu-bar collection surface", () => {
  assert.match(html, /<script src="generated-ts\/favorites-ui\.js"><\/script>/);
  assert.match(controller, /favorites-toolbar-btn/);
  assert.match(controller, /data-toolbar-item/);
  assert.match(controller, /收藏夹/);
  assert.match(controller, /书单/);
  assert.match(controller, /收藏新闻/);
  assert.match(controller, /transportFromTauriGlobal/);
  assert.match(controller, /invoke\("list_booklists"\)/);
  assert.match(styles, /\.favorites-modal \.favorites-shell/);
  assert.equal((html.match(/generated-ts\/favorites-ui\.js/g) || []).length, 1);
});
