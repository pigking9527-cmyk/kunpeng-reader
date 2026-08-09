(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.ReaderMessageGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTIONS = new Set([
    "layoutBusy", "progress", "ttsState", "ttsSynth", "dictPrefetch", "dictSpeak",
    "ttsErr", "ttsNoZh", "outline", "pdfState", "searchResults", "uiClick", "userNav", "readerNavigated", "readerJump",
    "centerTap", "readerPerf", "bugTrace", "ready", "readerAnchorReady", "measured", "pageCache", "downloadImage", "webSearch", "crossSearch",
    "semanticSearch", "aiReader", "translateText", "dict", "vocabAdd", "addHighlight",
    "addHighlightCorrect", "addHighlightCorrectDraft", "addHighlightNote", "openAnnotations", "readerGestureSurfaceClosed",
    "removeHighlight", "setHighlightNote", "setHighlightText", "setHighlightColor", "addBookmark", "tocResolved",
    "getTranslationCredentialStatus", "saveTranslationCredential", "bookEnd", "readerGesture",
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
    if (action === "readerJump") {
      const jump = data.readerJump;
      return isRecord(jump)
        && (jump.kind === "link" || jump.kind === "footnote")
        && Number.isInteger(jump.chapter) && jump.chapter >= 0 && jump.chapter <= 100000
        && typeof jump.chFrac === "number" && Number.isFinite(jump.chFrac) && jump.chFrac >= 0 && jump.chFrac <= 1;
    }
    if (action === "readerGesture") { const gesture = data.readerGesture; return isRecord(gesture) && ["start", "move", "end", "cancel"].includes(gesture.phase) && Number.isFinite(gesture.x) && Number.isFinite(gesture.y) && Math.abs(gesture.x) <= 100000 && Math.abs(gesture.y) <= 100000; }
    if (action === "readerGestureSurfaceClosed") return typeof data.readerGestureSurfaceClosed === "boolean";
    if (action === "readerPerf") return textWithin(data[action], 1000);
    if (action === "bugTrace") {
      const trace = data.bugTrace;
      const allowed = new Set([
        "kind", "source", "outcome", "zone", "target", "direction", "key",
        "chapter", "page", "x_pct", "y_pct", "duration_ms", "pages", "turn_id",
        "before_chapter", "before_page", "after_chapter", "after_page", "chapter_pending",
        "chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "flow_mode", "page_mode", "input",
        "image_mode", "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
        "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text", "image_near_top", "image_text_before", "image_probed",
        "layout_fast", "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
      ]);
      const stringFields = ["kind", "source", "outcome", "zone", "target", "direction", "key", "input", "flow_mode", "page_mode", "image_mode"];
      const numberFields = [
        "chapter", "page", "x_pct", "y_pct", "duration_ms", "pages", "turn_id",
        "before_chapter", "before_page", "after_chapter", "after_page", "chapter_pending",
        "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
        "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text",
        "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
      ];
      const booleanFields = ["chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "image_near_top", "image_text_before", "image_probed", "layout_fast"];
      return isRecord(trace)
        && Object.keys(trace).length > 0
        && Object.keys(trace).length <= 48
        && Object.keys(trace).every((key) => allowed.has(key))
        && stringFields.every((key) => textWithin(trace[key], key === "zone" ? 16 : (key === "key" ? 24 : 32)))
        && numberFields.every((key) =>
          trace[key] === undefined || (typeof trace[key] === "number" && Number.isFinite(trace[key]))
        )
        && booleanFields.every((key) => trace[key] === undefined || typeof trace[key] === "boolean");
    }
    if (action === "webSearch") {
      const request = data.webSearch;
      return textWithin(request, MAX_TEXT_CHARS)
        || (isRecord(request)
          && typeof request.term === "string"
          && request.term.length <= MAX_TEXT_CHARS
          && (request.engine === "baidu" || request.engine === "google"));
    }
    if (["crossSearch", "semanticSearch", "dict", "dictPrefetch", "dictSpeak"].includes(action)) {
      return textWithin(data[action], MAX_TEXT_CHARS);
    }
    if (action === "aiReader") {
      const request = data.aiReader;
      const hasStart = request && (request.anchorStart === undefined
        || (Number.isInteger(request.anchorStart) && request.anchorStart >= 0));
      const hasEnd = request && (request.anchorEnd === undefined
        || (Number.isInteger(request.anchorEnd) && request.anchorEnd > 0));
      const ordered = request && (request.anchorStart === undefined || request.anchorEnd === undefined
        || request.anchorEnd > request.anchorStart);
      return isRecord(request) && textWithin(request.text, MAX_TEXT_CHARS) && hasStart && hasEnd && ordered;
    }
    if (action === "setHighlightColor") {
      const request = data.setHighlightColor;
      return isRecord(request)
        && Number.isInteger(request.index) && request.index >= 0
        && ["y", "g", "b", "p"].includes(request.color);
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
    if (action === "pageCache") {
      const cache = data.pageCache;
      return isRecord(cache)
        && textWithin(cache.sig, 4096)
        && Array.isArray(cache.pages)
        && cache.pages.length <= 100_000
        && cache.pages.every((page) => Number.isInteger(page) && page >= 0 && page <= 10_000_000)
        && (cache.complete === undefined || typeof cache.complete === "boolean");
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
