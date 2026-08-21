import assert from "node:assert/strict";
import test from "node:test";
import {
  createWindowSettingsState,
  startupEnhancementRequest,
  windowSettingsReducer,
} from "./window-settings-state.ts";

test("background login cannot remain enabled when launch at login is unavailable or off", () => {
  let state = createWindowSettingsState();
  state = windowSettingsReducer(state, {
    type: "load-succeeded",
    settings: {
      enabled: true,
      continueHighCost: true,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      launchAtLoginBackground: true,
      launchAtLoginBackgroundAvailable: true,
    },
  });
  assert.equal(state.draft.launchAtLoginBackground, false);

  state = windowSettingsReducer(state, { type: "patch", patch: { launchAtLogin: true } });
  state = windowSettingsReducer(state, { type: "patch", patch: { launchAtLoginBackground: true } });
  assert.equal(state.draft.launchAtLoginBackground, true);
  assert.deepEqual(startupEnhancementRequest(state.draft), {
    enabled: true,
    continueHighCost: true,
    launchAtLogin: true,
    launchAtLoginBackground: true,
  });
});

test("only the latest save completion can update the persisted startup settings", () => {
  let state = createWindowSettingsState();
  state = windowSettingsReducer(state, {
    type: "load-succeeded",
    settings: {
      enabled: false,
      continueHighCost: false,
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      launchAtLoginBackground: false,
      launchAtLoginBackgroundAvailable: true,
    },
  });
  state = windowSettingsReducer(state, { type: "patch", patch: { enabled: true } });
  state = windowSettingsReducer(state, { type: "save-started", requestId: 2 });
  const stale = windowSettingsReducer(state, {
    type: "save-succeeded",
    requestId: 1,
    settings: { ...state.draft, enabled: false },
  });
  assert.equal(stale, state);

  const saved = windowSettingsReducer(state, {
    type: "save-succeeded",
    requestId: 2,
    settings: { ...state.draft, enabled: true },
  });
  assert.equal(saved.phase, "saved");
  assert.equal(saved.saved.enabled, true);
});
