import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const sourceUrl = new URL("./reader-preferences-ui.ts", import.meta.url);
const readerHtmlUrl = new URL("../../../../../ui/reader.html", import.meta.url);
const readerPreferencesCssUrl = new URL("../../../../../ui/reader-preferences.css", import.meta.url);

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

test("advanced preferences expose context visual density and chapter summaries", async () => {
  const [source, html, css] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(readerHtmlUrl, "utf8"),
    readFile(readerPreferencesCssUrl, "utf8"),
  ]);

  assert.match(html, /data-reader-i18n="readerContextMedia">伴读/);
  assert.match(html, /id="pref-reader-media-image-density"[^>]+data-pref-media-density="readerMediaImageDensity"/);
  assert.match(html, /id="pref-reader-media-video-density"[^>]+data-pref-media-density="readerMediaVideoDensity"/);
  assert.match(html, /id="pref-reader-media-mode"[^>]+data-pref-media-policy/);
  for (const key of [
    "showReaderMediaImageSummaryAtChapterStart",
    "showReaderMediaImageSummaryAtChapterEnd",
    "showReaderMediaVideoSummaryAtChapterStart",
    "showReaderMediaVideoSummaryAtChapterEnd",
  ]) {
    assert.match(html, new RegExp(`data-pref-bool="${key}"`));
  }
  assert.match(source, /querySelectorAll<HTMLSelectElement>\("\[data-pref-media-density\]"\)/);
  assert.match(source, /\[data-pref-media-policy\]/);
  assert.match(source, /ReaderSettings\.update\(\{ \[key\]: value \}\)/);
  assert.match(css, /\.reader-context-media-group select/);
  assert.match(css, /\.reader-context-media-summary-heading/);
});

test("page progress options open from a settings popover and close the master on the last item", async () => {
  const [source, html] = await Promise.all([
    readFile(sourceUrl, "utf8"),
    readFile(readerHtmlUrl, "utf8"),
  ]);

  assert.match(html, /id="pref-reader-page-info-settings"[^>]+aria-controls="reader-page-info-popover"/);
  assert.match(html, /id="reader-page-info-popover"[^>]+role="dialog"[^>]+hidden/);
  assert.match(source, /function setReaderPageInfoConfigExpanded\(expanded: boolean\): void/);
  assert.match(source, /function updatePageInfoVisibilitySetting\(input: HTMLInputElement, key: string\): void/);
  assert.match(source, /enabledCount === 0[\s\S]*?patch\.showPageInfo = false/);
  assert.match(source, /input\.checked[\s\S]*?patch\.showPageInfo = true/);
  assert.doesNotMatch(source, /reader-page-info-options"\)\?\.toggleAttribute\("hidden", !pageInfoVisible\)/);
});
