(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderMessageGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTIONS = new Set([
    "layoutBusy", "progress", "ttsState", "ttsSynth", "dictPrefetch", "dictSpeak",
    "ttsErr", "ttsNoZh", "outline", "pdfState", "searchResults", "uiClick", "userNav",
    "centerTap", "readerPerf", "ready", "measured", "downloadImage", "webSearch", "crossSearch",
    "semanticSearch", "translateText", "dict", "vocabAdd", "addHighlight",
    "addHighlightCorrect", "addHighlightCorrectDraft", "addHighlightNote", "openAnnotations",
    "removeHighlight", "setHighlightNote", "setHighlightText", "addBookmark", "tocResolved",
    "getTranslationCredentialStatus", "saveTranslationCredential",
  ]);
  const MAX_MESSAGE_CHARS = 12 * 1024 * 1024;
  const MAX_TEXT_CHARS = 20_000;
  const MAX_IMAGE_CHARS = 10 * 1024 * 1024;

  function isRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function serializedLength(value) {
    try {
      const json = JSON.stringify(value);
      return typeof json === "string" ? json.length : Number.POSITIVE_INFINITY;
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }

  function textWithin(value, limit) {
    return value === undefined || (typeof value === "string" && value.length <= limit);
  }

  function validActionPayload(action, data) {
    if (action === "readerPerf") return textWithin(data[action], 1000);
    if (["webSearch", "crossSearch", "semanticSearch", "dict", "dictPrefetch", "dictSpeak"].includes(action)) {
      return textWithin(data[action], MAX_TEXT_CHARS);
    }
    if (action === "translateText") {
      const request = data.translateText;
      return isRecord(request)
        && textWithin(request.text, MAX_TEXT_CHARS)
        && textWithin(request.source, 32)
        && textWithin(request.target, 32)
        && textWithin(request.provider, 32)
        && textWithin(request.credentialConfigId, 128);
    }
    if (action === "getTranslationCredentialStatus") {
      return textWithin(data[action], 32);
    }
    if (action === "saveTranslationCredential") {
      const request = data[action];
      return isRecord(request)
        && textWithin(request.provider, 32)
        && textWithin(request.apiId, 4096)
        && textWithin(request.apiKey, 4096);
    }
    if (action === "downloadImage") {
      const image = data.downloadImage;
      return isRecord(image)
        && textWithin(image.name, 256)
        && typeof image.dataUrl === "string"
        && image.dataUrl.length <= MAX_IMAGE_CHARS
        && /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(image.dataUrl);
    }
    return true;
  }

  function validateData(data) {
    if (!isRecord(data)) return false;
    const keys = Object.keys(data);
    if (!keys.length || keys.length > 32) return false;
    const actions = keys.filter((key) => ACTIONS.has(key));
    if (actions.length !== 1) return false;
    if (serializedLength(data) > MAX_MESSAGE_CHARS) return false;
    return validActionPayload(actions[0], data);
  }

  function expectedFrameOrigin(frame, hostLocation) {
    try {
      return new URL(frame.src, hostLocation.href).origin;
    } catch (_) {
      return "";
    }
  }

  function validateEvent(event, frame, hostLocation) {
    if (!event || !frame || !frame.contentWindow || event.source !== frame.contentWindow) return false;
    const expected = expectedFrameOrigin(frame, hostLocation || window.location);
    if (event.origin && event.origin !== "null" && expected && event.origin !== expected) return false;
    return validateData(event.data);
  }

  return Object.freeze({ ACTIONS, validateData, validateEvent });
});
