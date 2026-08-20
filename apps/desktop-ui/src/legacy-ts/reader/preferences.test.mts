import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS,
  isReaderDictionaryEnhancementAvailable,
  parseReaderDictionaryEnhancementSettings,
  parseReaderHighlightMenuPreferences,
  toggleReaderDictionaryEnhancement,
} from "./preferences.ts";

test("highlight menu outer-shell snapshot accepts only a plain parsed object", () => {
  assert.deepEqual(parseReaderHighlightMenuPreferences('{"layout":"grid"}'), { layout: "grid" });
  assert.equal(parseReaderHighlightMenuPreferences("[]"), null);
  assert.equal(parseReaderHighlightMenuPreferences("invalid"), null);
  assert.equal(parseReaderHighlightMenuPreferences(null), null);
});

test("all six dictionary enhancements default off and restore only explicit opt-ins", () => {
  assert.deepEqual(parseReaderDictionaryEnhancementSettings(null), {
    plain: false,
    sense: false,
    context: false,
    hypernyms: false,
    synonyms: false,
    antonyms: false,
  });
  assert.deepEqual(
    parseReaderDictionaryEnhancementSettings(
      '{"plain":true,"sense":1,"context":"true","hypernyms":true,"synonyms":false,"antonyms":null}',
    ),
    {
      plain: true,
      sense: false,
      context: false,
      hypernyms: true,
      synonyms: false,
      antonyms: false,
    },
  );
});

test("dictionary availability maps context to example_note and rejects empty data", () => {
  const result = {
    hownet: {
      plain: "meaning",
      sense: "  ",
      example_note: "in this sentence",
      hypernyms: ["term"],
      synonyms: [],
      antonyms: null,
    },
  };
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "plain"), true);
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "sense"), false);
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "context"), true);
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "hypernyms"), true);
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "synonyms"), false);
  assert.equal(isReaderDictionaryEnhancementAvailable(result, "antonyms"), false);
});

test("unavailable dictionary options remain off instead of preserving a stale prior word", () => {
  const enabled = toggleReaderDictionaryEnhancement(
    DEFAULT_READER_DICTIONARY_ENHANCEMENT_SETTINGS,
    "synonyms",
    true,
    { hownet: { synonyms: ["near"] } },
  );
  assert.equal(enabled.enabled, true);
  const nextWord = toggleReaderDictionaryEnhancement(
    enabled.settings,
    "synonyms",
    true,
    { hownet: { synonyms: [] } },
  );
  assert.equal(nextWord.enabled, false);
  assert.equal(nextWord.settings.synonyms, false);
  assert.equal(nextWord.unavailable, true);
});
