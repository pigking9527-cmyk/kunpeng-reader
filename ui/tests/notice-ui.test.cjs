const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const html = fs.readFileSync(path.join(root, "ui", "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "ui", "generated-ts", "app.js"), "utf8");
const shelf = fs.readFileSync(path.join(root, "ui", "generated-ts", "shelf-ui.js"), "utf8");
const notice = fs.readFileSync(
  path.join(root, "ui", "generated-ts", "notice-ui.js"),
  "utf8",
);
const dialog = fs.readFileSync(
  path.join(root, "ui", "generated-ts", "dialog-ui.js"),
  "utf8",
);
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

test("recovery uses an accessible Web dialog instead of native message boxes", () => {
  assert.ok(html.indexOf("dialog-ui.js") < html.indexOf("app.js"));
  assert.match(dialog, /setAttribute\("role", "dialog"\)/);
  assert.match(dialog, /setAttribute\("aria-modal", "true"\)/);
  assert.match(dialog, /return Object\.freeze\(\{ alert, confirm \}\)/);
  assert.match(dialog, /runtime\.AppDialog = api/);
  const recoveryFlow = app.slice(app.indexOf("recoveryBackupButton?.addEventListener"), app.indexOf("window.addEventListener(\"app-language-changed\""));
  assert.match(recoveryFlow, /await window\.AppDialog\?\.confirm/);
  assert.match(recoveryFlow, /await window\.AppDialog\?\.alert/);
  assert.doesNotMatch(recoveryFlow, /\b(?:alert|confirm)\(/);
  assert.match(css, /\.app-dialog-backdrop\s*\{[^}]*backdrop-filter:\s*blur/s);
  assert.match(css, /\.app-dialog\s*\{[^}]*border-radius:\s*18px[^}]*box-shadow:/s);
});
