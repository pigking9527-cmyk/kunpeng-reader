import assert from "node:assert/strict";
import test from "node:test";
import {
  createSettingsShellState,
  settingsShellReducer,
  type SettingsShellState,
} from "./settings-shell-state.ts";

function startSave(state: SettingsShellState, requestId = 1): SettingsShellState {
  return settingsShellReducer(state, { type: "save-started", requestId });
}

test("settings state saves the current preview and makes it the next reset baseline", () => {
  let state = createSettingsShellState("shelf", { showRating: false });
  state = settingsShellReducer(state, { type: "patch-appearance", patch: { showProgress: false } });
  state = settingsShellReducer(startSave(state), { type: "save-succeeded", requestId: 1 });

  assert.equal(state.phase, "saved");
  assert.equal(state.initialAppearance.showProgress, false);
  state = settingsShellReducer(state, { type: "patch-appearance", patch: { showProgress: true } });
  state = settingsShellReducer(state, { type: "reset-draft" });
  assert.equal(state.draftAppearance.showProgress, false);
  assert.equal(state.draftAppearance.showRating, false);
});

test("a failed save preserves the draft and reports a retryable failure", () => {
  let state = createSettingsShellState();
  state = settingsShellReducer(state, { type: "patch-appearance", patch: { previewTheme: "dark" } });
  state = settingsShellReducer(startSave(state), { type: "save-failed", requestId: 1, message: "磁盘不可用" });

  assert.equal(state.phase, "failed");
  assert.equal(state.draftAppearance.previewTheme, "dark");
  assert.match(state.statusMessage ?? "", /保存失败：磁盘不可用/);
});

test("a cancelled or stale save cannot overwrite the active draft", () => {
  let state = createSettingsShellState();
  state = settingsShellReducer(startSave(state, 2), { type: "save-cancelled", requestId: 2 });
  assert.equal(state.phase, "cancelled");

  const afterStaleSuccess = settingsShellReducer(state, { type: "save-succeeded", requestId: 1 });
  assert.equal(afterStaleSuccess, state);
  assert.equal(afterStaleSuccess.phase, "cancelled");
});

test("a host-selected initial category wins over a stored category after loading", () => {
  const initial = createSettingsShellState("basic");
  const state = settingsShellReducer(initial, {
    type: "load-succeeded",
    fixedInitialSection: "shelf",
    result: { selectedSection: "data", appearance: { showTitle: false } },
  });

  assert.equal(state.activeSection, "shelf");
  assert.equal(state.draftAppearance.showTitle, false);
});
