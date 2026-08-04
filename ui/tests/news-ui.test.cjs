const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ui = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(ui, "index.html"), "utf8");
const script = fs.readFileSync(path.join(ui, "news-ui.js"), "utf8");
const styles = fs.readFileSync(path.join(ui, "styles.css"), "utf8");

test("NewsNow has a shelf toolbar entry and an independently mounted news page", () => {
  assert.match(html, /id="newsnow-toolbar-btn"/);
  assert.match(html, /id="newsnow-page"/);
  assert.match(html, /id="newsnow-back"/);
  assert.match(html, /id="newsnow-feed"/);
  assert.match(html, /<script src="news-ui\.js"><\/script>/);
});

test("NewsNow feed keeps news loading separate from startup and only opens safe original links", () => {
  assert.match(script, /function safeHttpUrl/);
  assert.match(script, /url\.protocol === "https:" \? url\.href : ""/);
  assert.match(script, /"newsnow_list"/);
  assert.match(script, /"newsnow_refresh"/);
  assert.match(script, /function withTimeout/);
  assert.match(script, /资讯请求超时/);
  assert.match(script, /invoke\("newsnow_open", \{ url \}\)/);
  assert.match(script, /shell\.hidden = true/);
  assert.match(script, /page\.hidden = false/);
  assert.match(script, /ReaderLibraryAiEntry\?\.close\(\)/);
  assert.match(script, /function close\(\)/);
  assert.match(script, /page\.hidden = true/);
});

test("NewsNow uses the existing desktop visual language and stays usable on narrow windows", () => {
  assert.match(styles, /\.newsnow-page\s*\{/);
  assert.match(styles, /\.newsnow-feed\s*\{[^}]*grid-template-columns/s);
  assert.match(styles, /\.newsnow-card:hover, \.newsnow-card:focus-visible/);
  assert.match(styles, /@media \(max-width: 620px\)/);
});
