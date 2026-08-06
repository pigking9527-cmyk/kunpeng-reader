const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "ui", "app.js"), "utf8");
const shelf = fs.readFileSync(path.join(root, "ui", "shelf-ui.js"), "utf8");
const notice = fs.readFileSync(path.join(root, "ui", "notice-ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "ui", "styles.css"), "utf8");

test("empty-shelf feedback uses a 1.5 second text-only fade", () => {
  assert.ok(html.indexOf("notice-ui.js") < html.indexOf("app.js"));
  assert.match(app, /alertAction: \(message, options\) => window\.AppNotice\.show\(message, options\)/);
  assert.match(shelf, /alertAction\("书架还是空的", \{ variant: "text", duration: 1500 \}\)/);
  assert.match(notice, /role", "status"/);
  assert.match(notice, /aria-live", "polite"/);
  assert.match(notice, /options\.variant === "text"/);
  assert.match(notice, /--notice-duration/);
  assert.match(css, /\.app-notice\.text-only\.show[\s\S]*?app-notice-text-life/);
  assert.match(css, /@keyframes app-notice-text-life[\s\S]*?0%[\s\S]*?14%[\s\S]*?72%[\s\S]*?100%/);
});
