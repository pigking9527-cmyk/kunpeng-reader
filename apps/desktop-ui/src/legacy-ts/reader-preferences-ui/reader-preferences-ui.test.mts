import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("./reader-preferences-ui.ts", import.meta.url);

test("reader preferences keeps the frozen original UI compatibility contract", async () => {
  const source = await readFile(sourceUrl, "utf8");

  for (const storageKey of [
    "readerCustomPalettesV1",
    "readerPaletteOrderV1",
    "readerPreferencesNavCollapsed",
  ]) {
    assert.match(source, new RegExp(`\\"${storageKey}\\"`));
  }

  for (const command of [
    "reader_palette_sync_save",
    "reader_palette_sync_get",
    "cache_reader_background_image",
    "reader_background_local_url",
  ]) {
    assert.match(source, new RegExp(`api\\.invoke\\(\\"${command}\\"`));
  }

  for (const id of [
    "reader-preferences-modal",
    "reader-preferences-btn",
    "pref-palette-grid",
    "reader-color-popover",
    "pref-dual-page-gap",
    "pref-reader-jump-back-preview-icon",
    "reader-toolbar-order-list",
  ]) {
    assert.ok(source.includes(id), `missing original DOM id: ${id}`);
  }

  assert.match(source, /data-pref-epub-layout-engine/);
  assert.match(source, /button\.classList\.toggle\("active", selected\)/);
  assert.match(source, /ReaderSettings\.update\(\{ epubLayoutEngine: engine \}\)/);

  assert.match(source, /global\.ReaderPreferences = preferencesApi/);
  assert.match(source, /Object\.freeze\(\{ open\(\)/);
  assert.match(source, /reader-shell-statechange/);
  assert.match(source, /reader-settings-changed/);
  assert.match(source, /reader-language-changed/);
  assert.match(source, /pointermove/);
  assert.match(source, /pointercancel/);
  assert.doesNotMatch(source, /__TAURI__/);
  assert.doesNotMatch(source, /\bany\b|@ts-ignore|@ts-expect-error|eval\s*\(/);
});

test("reader palette sync preserves the native command envelopes", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /reader_palette_sync_save\", \{ request: \{ palettes: syncPalettes, order:/);
  assert.match(source, /cache_reader_background_image\", \{ dataUrl: source \}/);
  assert.match(source, /reader_background_local_url\", \{ assetId: palette\.backgroundAssetId, mime: palette\.backgroundAssetMime \}/);
  assert.match(source, /MAX_BACKGROUND_IMAGE_SOURCE_BYTES = 25 \* 1024 \* 1024/);
  assert.match(source, /超过 5 MiB 会自动压缩/);
  assert.match(source, /asset\.compressed === true/);
  assert.match(source, /customBackgroundAssetId: asset\.assetId/);
  assert.match(source, /customBackgroundAssetBytes: asset\.byteSize/);
});

test("all appearance colors share the continuous spectrum and actual-pair contrast", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /customBackgroundColor: "background"/);
  assert.match(source, /function renderColorEditor\(color: string\): void/);
  assert.match(source, /function renderColorContrast\(selectedColor: string\): void/);
  assert.match(source, /function activeColorContrastPair\(selectedColor: string\)/);
  assert.match(source, /ratio >= 7 \? "clear" : ratio >= 4\.5 \? "readable" : "low"/);
  assert.match(source, /setColorFromSpectrumPoint\(event\.clientX, event\.clientY\)/);
  assert.match(source, /querySelectorAll<HTMLElement>\("\[data-pref-color\]"\)/);
  assert.match(source, /colorSpectrum\?\.addEventListener\("keydown"/);
  assert.match(source, /linear-gradient\(to bottom,#fff 0%,rgba\(255,255,255,0\) 50%,#000 100%\)/);
  assert.match(source, /--reader-spectrum-y", `\$\{100 - hsl\.l\}%`/);
  assert.match(source, /hslToHex\(hue, 100, lightness\)/);
  assert.match(source, /readerPreferenceT\("colorLightness", "明度"\)/);
  assert.match(source, /readerPreferenceT\("fullColorSpectrum", "完整色谱"\)/);
  assert.match(source, /spectrum\.setAttribute\(\s*"aria-label"/);
  assert.doesNotMatch(source, /spectrum\.setAttribute\(\s*"aria-valuetext"/);
  assert.match(source, /activeColorControl\?\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(source, /control\.setAttribute\("aria-expanded", "true"\)/);
  assert.doesNotMatch(source, /--reader-spectrum-y", `\$\{100 - hsl\.s\}%`/);
  assert.doesNotMatch(source, /data-pref-color-swatch/);
});
