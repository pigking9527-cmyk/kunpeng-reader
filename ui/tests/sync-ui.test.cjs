const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const uiDir = path.resolve(__dirname, "..");
const syncSource = fs.readFileSync(path.join(uiDir, "sync-ui.js"), "utf8");
const indexSource = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");

test("sync UI only binds elements that exist in the main page", () => {
  const referencedIds = [...syncSource.matchAll(/getElementById\("([^"]+)"\)/g)]
    .map((match) => match[1]);
  const missingIds = [...new Set(referencedIds)]
    .filter((id) => !indexSource.includes(`id="${id}"`));

  assert.deepEqual(missingIds, []);
});

test("manual sync button has a click handler", () => {
  assert.match(syncSource, /syncNowBtn\.addEventListener\("click",\s*async\s*\(\)\s*=>/);
});

test("persisted account is restored and automatically synced on startup", () => {
  const appSource = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  assert.match(syncSource, /async function syncOnStartup\(\)/);
  assert.match(syncSource, /await loadSyncSettingsOnce\(\)/);
  assert.match(syncSource, /await invoke\("sync_now"\)/);
  assert.match(appSource, /await loadSyncSettingsOnce\(\);[\s\S]*await syncOnStartup\(\)/);
});
