import assert from "node:assert/strict";
import test from "node:test";

import {
  readerPreferenceColorRulesApi,
  readerPreferenceContrastRatio,
  readerPreferenceHexToHsl,
  readerPreferenceHslToHex,
} from "./reader-preference-color-rules.ts";

test("continuous HSL color controls cover the complete RGB spectrum", () => {
  const samples = [
    [0, 100, 50, "#ff0000"],
    [60, 100, 50, "#ffff00"],
    [120, 100, 50, "#00ff00"],
    [180, 100, 50, "#00ffff"],
    [240, 100, 50, "#0000ff"],
    [300, 100, 50, "#ff00ff"],
    [25, 67, 42, "#b35f23"],
  ] as const;
  for (const [hue, saturation, lightness, expected] of samples) {
    assert.equal(readerPreferenceHslToHex(hue, saturation, lightness), expected);
  }
  assert.deepEqual(readerPreferenceHexToHsl("#00ffff"), { h: 180, s: 100, l: 50 });
});

test("WCAG contrast ratio uses relative luminance for the actual color pair", () => {
  assert.equal(readerPreferenceContrastRatio("#000000", "#ffffff"), 21);
  assert.equal(readerPreferenceContrastRatio("#ffffff", "#ffffff"), 1);
  assert.equal(
    readerPreferenceContrastRatio("#767676", "#ffffff") >= 4.5,
    true,
  );
  assert.equal(
    readerPreferenceContrastRatio("#777777", "#ffffff") < 4.5,
    true,
  );
  assert.equal(
    readerPreferenceContrastRatio("#ffffff", "#123456"),
    readerPreferenceContrastRatio("#123456", "#ffffff"),
  );
});

test("the frozen browser API exposes contrast alongside color conversion", () => {
  assert.equal(Object.isFrozen(readerPreferenceColorRulesApi), true);
  assert.equal(readerPreferenceColorRulesApi.contrastRatio, readerPreferenceContrastRatio);
});
