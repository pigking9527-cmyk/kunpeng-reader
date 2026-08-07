const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "reader.html"), "utf8");
const runtime = fs.readFileSync(path.join(root, "reader-page-runtime.js"), "utf8");
const settings = fs.readFileSync(path.join(root, "reader-settings-ui.js"), "utf8");
const core = fs.readFileSync(path.join(root, "..", "src", "tts_core.rs"), "utf8");

test("read aloud automatically selects Microsoft Neural voices for all supported UI languages", () => {
  [
    "zh-CN-XiaoxiaoNeural", "zh-TW-HsiaoChenNeural", "en-US-JennyNeural", "ja-JP-NanamiNeural",
    "ko-KR-SunHiNeural", "fr-FR-DeniseNeural", "de-DE-KatjaNeural", "es-ES-ElviraNeural",
    "ru-RU-SvetlanaNeural", "pt-BR-FranciscaNeural",
  ].forEach((voice) => assert.match(runtime, new RegExp(voice)));
  assert.match(runtime, /function ttsLanguageForText/);
  assert.match(runtime, /function ttsVoiceForText/);
  assert.match(runtime, /voice:ttsVoiceForText\(ttsSents\[i\]\.text\)/);
  assert.match(core, /edge_ssml_uses_the_selected_voice_locale/);
});

test("TTS settings keep source and speed but do not expose a manual voice picker", () => {
  const sourceRow = html.slice(html.indexOf('id="set-ttssrc"'), html.indexOf('id="set-ttsrate"'));
  assert.match(html, /id="set-ttssrc"/);
  assert.doesNotMatch(html, /id="set-ttsvoice"/);
  assert.match(sourceRow, /data-reader-i18n="ttsMicrosoftAuto"/);
  assert.doesNotMatch(sourceRow, /按正文语言自动朗读/);
  assert.doesNotMatch(sourceRow, /按正文语言匹配/);
  assert.doesNotMatch(settings, /bindSel\("set-ttsvoice"/);
});
