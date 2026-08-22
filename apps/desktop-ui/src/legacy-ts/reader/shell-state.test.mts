import assert from "node:assert/strict";
import test from "node:test";
import {
  createLegacyReaderShellState,
  nextImmersiveStorageValue,
  projectLegacyReaderShell,
  reduceLegacyReaderShell,
} from "./shell-state.ts";

test("classic shell starts from the existing immersive storage key", () => {
  assert.equal(createLegacyReaderShellState(null).toolbar, "normal");
  assert.equal(createLegacyReaderShellState("1").toolbar, "immersive-hidden");
  assert.equal(createLegacyReaderShellState("true").toolbar, "normal");
});

test("search pins an immersive toolbar through an IME pointer leave", () => {
  let state = createLegacyReaderShellState("1");
  const previous = state;
  state = reduceLegacyReaderShell(state, { type: "SET_OVERLAY", overlay: "search" });
  assert.equal(state.toolbar, "immersive-pinned");
  state = reduceLegacyReaderShell(state, { type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(state.toolbar, "immersive-pinned");
  assert.equal(state.overlay, "search");
  assert.equal(nextImmersiveStorageValue(previous, state), null);
});

test("settings close only after the pointer leaves and re-enters", () => {
  let state = createLegacyReaderShellState(null);
  state = reduceLegacyReaderShell(state, { type: "SET_OVERLAY", overlay: "settings" });
  state = reduceLegacyReaderShell(state, { type: "TOOLBAR_POINTER_LEAVE" });
  assert.equal(state.settingsPointerExited, true);
  state = reduceLegacyReaderShell(state, { type: "TOOLBAR_POINTER_ENTER" });
  assert.equal(state.overlay, "none");
  assert.equal(state.settingsPointerExited, false);
});

test("normal toolbar cannot accidentally enter immersive mode", () => {
  const state = createLegacyReaderShellState(null);
  assert.equal(reduceLegacyReaderShell(state, { type: "TOGGLE_TOOLBAR" }), state);
  const immersive = reduceLegacyReaderShell(state, { type: "SET_IMMERSIVE", on: true });
  assert.equal(nextImmersiveStorageValue(state, immersive), "1");
  assert.equal(projectLegacyReaderShell(immersive).controlsVisible, false);
  const shown = reduceLegacyReaderShell(immersive, { type: "SHOW_TOOLBAR" });
  assert.equal(projectLegacyReaderShell(shown).controlsVisible, true);
  assert.equal(projectLegacyReaderShell(shown).showBarPinned, true);
});

test("unknown overlay and side panel inputs safely close classic surfaces", () => {
  let state = createLegacyReaderShellState(null);
  state = reduceLegacyReaderShell(state, { type: "SET_OVERLAY", overlay: "unknown" });
  state = reduceLegacyReaderShell(state, { type: "SET_SIDE_PANEL", sidePanel: { bad: true } });
  assert.equal(state.overlay, "none");
  assert.equal(state.sidePanel, "none");
});
