export const READER_MESSAGE_ACTIONS = new Set([
  "layoutBusy", "progress", "ttsState", "ttsSynth", "dictPrefetch", "dictSpeak",
  "ttsErr", "ttsNoZh", "outline", "pdfState", "searchResults", "uiClick", "userNav", "readerNavigated", "readerJump",
  "centerTap", "readerPerf", "bugTrace", "ready", "readerAnchorReady", "measured", "pageCache", "downloadImage", "webSearch", "crossSearch",
  "semanticSearch", "aiReader", "translateText", "dict", "vocabAdd", "addHighlight",
  "addHighlightCorrect", "addHighlightCorrectDraft", "addHighlightNote", "openAnnotations", "readerGestureSurfaceClosed",
  "removeHighlight", "setHighlightNote", "setHighlightText", "setHighlightColor", "addBookmark", "tocResolved",
  "getTranslationCredentialStatus", "saveTranslationCredential", "bookEnd", "readerGesture", "readerHighlightMenuPreferences", "readerHighlightMenuPreferencesReady", "readerHighlightMenuSettings",
]);

export const READER_MESSAGE_MAX_CHARS = 12 * 1024 * 1024;
export const READER_MESSAGE_MAX_TEXT_CHARS = 20_000;
export const READER_MESSAGE_MAX_IMAGE_CHARS = 10 * 1024 * 1024;
export const READER_MESSAGE_MAX_BUG_TRACE_FIELDS = 64;

interface ReaderMessageFrame {
  readonly src: string;
  readonly contentWindow: unknown;
}

interface ReaderMessageLocation {
  readonly href: string;
}

interface ReaderMessageEvent {
  readonly source?: unknown;
  readonly origin?: unknown;
  readonly data?: unknown;
}

interface ReaderProtocolBridge {
  readonly isReaderFrameProtocolEnvelope?: (value: unknown) => unknown;
  readonly normalizeReaderFrameProtocolEvent?: (
    event: ReaderMessageEvent,
    frame: ReaderMessageFrame,
    location: ReaderMessageLocation,
  ) => unknown;
}

interface ReaderMessageRuntime extends Record<string, unknown> {
  readonly location?: ReaderMessageLocation;
}

type MessageRecord = Record<string, unknown>;

export function isReaderMessageRecord(value: unknown): value is MessageRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function readerMessageSerializedLength(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? json.length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function textWithin(value: unknown, limit: number): boolean {
  return value === undefined || (typeof value === "string" && value.length <= limit);
}

function validHighlightMenuPreferences(value: unknown): boolean {
  if (!isReaderMessageRecord(value)) return false;
  const allowed = new Set(["displayMode", "layout", "size", "webSearchEngine", "colorful", "actions"]);
  const keys = Object.keys(value);
  if (!keys.length || !keys.every((key) => allowed.has(key))) return false;
  if (value.displayMode !== undefined && !["both", "text", "icon"].includes(String(value.displayMode))) return false;
  if (value.layout !== undefined && !["row", "grid"].includes(String(value.layout))) return false;
  if (value.size !== undefined && !["small", "medium", "large"].includes(String(value.size))) return false;
  if (value.webSearchEngine !== undefined && !["baidu", "google"].includes(String(value.webSearchEngine))) return false;
  if (value.colorful !== undefined && typeof value.colorful !== "boolean") return false;
  return value.actions === undefined || (
    Array.isArray(value.actions) &&
    value.actions.length <= 12 &&
    value.actions.every((action) =>
      isReaderMessageRecord(action) &&
      typeof action.key === "string" &&
      action.key.length <= 32 &&
      typeof action.visible === "boolean" &&
      Object.keys(action).every((key) => key === "key" || key === "visible")
    )
  );
}

function validActionPayload(action: string, data: MessageRecord): boolean {
  if (action === "readerJump") {
    const jump = data.readerJump;
    return isReaderMessageRecord(jump) &&
      (jump.kind === "link" || jump.kind === "footnote") &&
      Number.isInteger(jump.chapter) && Number(jump.chapter) >= 0 && Number(jump.chapter) <= 100_000 &&
      typeof jump.chFrac === "number" && Number.isFinite(jump.chFrac) && jump.chFrac >= 0 && jump.chFrac <= 1;
  }
  if (action === "readerGesture") {
    const gesture = data.readerGesture;
    return isReaderMessageRecord(gesture) &&
      ["start", "move", "end", "cancel"].includes(String(gesture.phase)) &&
      Number.isFinite(gesture.x) && Number.isFinite(gesture.y) &&
      Math.abs(Number(gesture.x)) <= 100_000 && Math.abs(Number(gesture.y)) <= 100_000;
  }
  if (action === "readerGestureSurfaceClosed") return typeof data.readerGestureSurfaceClosed === "boolean";
  if (action === "readerPerf") return textWithin(data[action], 1_000);
  if (action === "bugTrace") {
    const trace = data.bugTrace;
    const allowed = new Set([
      "kind", "source", "outcome", "zone", "target", "direction", "key",
      "chapter", "page", "x_pct", "y_pct", "duration_ms", "pages", "turn_id",
      "before_chapter", "before_page", "after_chapter", "after_page", "chapter_pending",
      "chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "flow_mode", "page_mode", "input",
      "wheel_seq", "wheel_delta_x", "wheel_delta_y", "wheel_delta_px", "wheel_delta_mode", "wheel_gap_ms", "wheel_accumulated_px", "wheel_threshold_px", "wheel_quiet_ms", "wheel_gesture_age_ms", "wheel_gesture_active", "wheel_timer_active", "wheel_event_cancelable", "wheel_replay", "wheel_mode_pending",
      "image_mode", "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
      "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text", "image_near_top", "image_text_before", "image_probed",
      "note_marker", "note_virtual", "note_link_present", "note_fragment_present", "note_click_consumed", "note_popup_visible", "note_target_chapter", "note_search_chapters",
      "mac_clip_native_notes", "mac_clip_page_inline_notes", "mac_clip_view_height", "mac_clip_scroll_top", "mac_clip_measured_blank", "mac_clip_virtual_blank", "mac_clip_partial_blank", "mac_clip_applied_blank", "mac_clip_has_extra_virtual", "mac_clip_path_active",
      "media_count", "media_background_count", "media_table_count", "media_positioned_count", "media_visible_count", "media_text_overlap_count", "media_background_text_overlap_count",
      "layout_fast", "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
    ]);
    const stringFields = ["kind", "source", "outcome", "zone", "target", "direction", "key", "input", "flow_mode", "page_mode", "image_mode"];
    const numberFields = [
      "chapter", "page", "x_pct", "y_pct", "duration_ms", "pages", "turn_id",
      "before_chapter", "before_page", "after_chapter", "after_page", "chapter_pending",
      "wheel_seq", "wheel_delta_x", "wheel_delta_y", "wheel_delta_px", "wheel_delta_mode", "wheel_gap_ms", "wheel_accumulated_px", "wheel_threshold_px", "wheel_quiet_ms", "wheel_gesture_age_ms",
      "image_source_page", "image_candidate_page", "image_top", "image_width", "image_height",
      "image_free_height", "image_preview_height", "image_next_count", "image_future_count", "image_skipped_text",
      "note_target_chapter", "note_search_chapters",
      "mac_clip_view_height", "mac_clip_scroll_top", "mac_clip_measured_blank", "mac_clip_virtual_blank", "mac_clip_partial_blank", "mac_clip_applied_blank",
      "media_count", "media_background_count", "media_table_count", "media_positioned_count", "media_visible_count", "media_text_overlap_count", "media_background_text_overlap_count",
      "layout_view_height", "layout_root_height", "layout_root_style_height", "layout_padding_bottom", "layout_line_height", "layout_step", "layout_current_line_count", "layout_last_top", "layout_last_bottom", "layout_last_height", "layout_next_top", "layout_next_bottom", "layout_next_height", "layout_visible_free", "layout_content_free", "layout_tail_cross", "layout_tail_fit", "layout_tail_tightened",
    ];
    const booleanFields = ["chapter_turn_pending", "turn_fx_active", "turn_timer_active", "scroll_paged", "wheel_gesture_active", "wheel_timer_active", "wheel_event_cancelable", "wheel_replay", "wheel_mode_pending", "image_near_top", "image_text_before", "image_probed", "note_marker", "note_virtual", "note_link_present", "note_fragment_present", "note_click_consumed", "note_popup_visible", "mac_clip_native_notes", "mac_clip_page_inline_notes", "mac_clip_has_extra_virtual", "mac_clip_path_active", "layout_fast"];
    return isReaderMessageRecord(trace) &&
      Object.keys(trace).length > 0 &&
      Object.keys(trace).length <= READER_MESSAGE_MAX_BUG_TRACE_FIELDS &&
      Object.keys(trace).every((key) => allowed.has(key)) &&
      stringFields.every((key) => textWithin(trace[key], key === "zone" ? 16 : key === "key" ? 24 : 32)) &&
      numberFields.every((key) => trace[key] === undefined || (typeof trace[key] === "number" && Number.isFinite(trace[key]))) &&
      booleanFields.every((key) => trace[key] === undefined || typeof trace[key] === "boolean");
  }
  if (action === "webSearch") {
    const request = data.webSearch;
    return textWithin(request, READER_MESSAGE_MAX_TEXT_CHARS) || (
      isReaderMessageRecord(request) &&
      typeof request.term === "string" && request.term.length <= READER_MESSAGE_MAX_TEXT_CHARS &&
      (request.engine === "baidu" || request.engine === "google")
    );
  }
  if (["crossSearch", "semanticSearch", "dict", "dictPrefetch", "dictSpeak"].includes(action)) {
    return textWithin(data[action], READER_MESSAGE_MAX_TEXT_CHARS);
  }
  if (action === "aiReader") {
    const request = data.aiReader;
    const hasStart = isReaderMessageRecord(request) && (request.anchorStart === undefined || (Number.isInteger(request.anchorStart) && Number(request.anchorStart) >= 0));
    const hasEnd = isReaderMessageRecord(request) && (request.anchorEnd === undefined || (Number.isInteger(request.anchorEnd) && Number(request.anchorEnd) > 0));
    const ordered = isReaderMessageRecord(request) && (request.anchorStart === undefined || request.anchorEnd === undefined || Number(request.anchorEnd) > Number(request.anchorStart));
    return isReaderMessageRecord(request) && textWithin(request.text, READER_MESSAGE_MAX_TEXT_CHARS) && hasStart && hasEnd && ordered;
  }
  if (action === "setHighlightColor") {
    const request = data.setHighlightColor;
    return isReaderMessageRecord(request) &&
      Number.isInteger(request.index) && Number(request.index) >= 0 &&
      ["y", "g", "b", "p"].includes(String(request.color));
  }
  if (action === "readerHighlightMenuPreferences") return validHighlightMenuPreferences(data.readerHighlightMenuPreferences);
  if (action === "readerHighlightMenuPreferencesReady") return data.readerHighlightMenuPreferencesReady === true;
  if (action === "readerHighlightMenuSettings") {
    const response = data.readerHighlightMenuSettings;
    return isReaderMessageRecord(response) &&
      Number.isInteger(response.requestId) && Number(response.requestId) > 0 && Number(response.requestId) <= 1_000_000 &&
      validHighlightMenuPreferences(response.settings) &&
      Object.keys(response).every((key) => key === "requestId" || key === "settings");
  }
  if (action === "translateText") {
    const request = data.translateText;
    return isReaderMessageRecord(request) &&
      textWithin(request.text, READER_MESSAGE_MAX_TEXT_CHARS) &&
      textWithin(request.source, 32) && textWithin(request.target, 32) &&
      textWithin(request.provider, 32) && textWithin(request.credentialConfigId, 128);
  }
  if (action === "getTranslationCredentialStatus") return textWithin(data[action], 32);
  if (action === "saveTranslationCredential") {
    const request = data[action];
    return isReaderMessageRecord(request) && textWithin(request.provider, 32) &&
      textWithin(request.apiId, 4_096) && textWithin(request.apiKey, 4_096);
  }
  if (action === "downloadImage") {
    const image = data.downloadImage;
    return isReaderMessageRecord(image) && textWithin(image.name, 256) &&
      typeof image.dataUrl === "string" && image.dataUrl.length <= READER_MESSAGE_MAX_IMAGE_CHARS &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(image.dataUrl);
  }
  if (action === "pageCache") {
    const cache = data.pageCache;
    return isReaderMessageRecord(cache) && textWithin(cache.sig, 4_096) &&
      Array.isArray(cache.pages) && cache.pages.length <= 100_000 &&
      cache.pages.every((page) => Number.isInteger(page) && page >= 0 && page <= 10_000_000) &&
      (cache.complete === undefined || typeof cache.complete === "boolean");
  }
  return true;
}

export function validateReaderMessageData(data: unknown): boolean {
  if (!isReaderMessageRecord(data)) return false;
  const keys = Object.keys(data);
  if (!keys.length || keys.length > 32) return false;
  const actions = keys.filter((key) => READER_MESSAGE_ACTIONS.has(key));
  if (actions.length !== 1) return false;
  if (readerMessageSerializedLength(data) > READER_MESSAGE_MAX_CHARS) return false;
  const action = actions[0];
  return action !== undefined && validActionPayload(action, data);
}

function expectedFrameOrigin(frame: ReaderMessageFrame, hostLocation: ReaderMessageLocation): string {
  try {
    const url = new URL(frame.src, hostLocation.href);
    return url.origin !== "null" ? url.origin : url.host ? `${url.protocol}//${url.host}` : "";
  } catch {
    return "";
  }
}

function bridgeFrom(target: ReaderMessageRuntime): ReaderProtocolBridge | null {
  return isReaderMessageRecord(target.KunpengReaderProtocolBridge)
    ? target.KunpengReaderProtocolBridge as ReaderProtocolBridge
    : null;
}

function createReaderMessageApi(target: ReaderMessageRuntime) {
  function normalizeEvent(
    event: ReaderMessageEvent | null | undefined,
    frame: ReaderMessageFrame | null | undefined,
    hostLocation?: ReaderMessageLocation | null,
  ): MessageRecord | null {
    if (!event || !frame || !frame.contentWindow || event.source !== frame.contentWindow) return null;
    const location = hostLocation || target.location;
    if (!location) return null;
    const expected = expectedFrameOrigin(frame, location);
    if (!expected || typeof event.origin !== "string" || event.origin === "null" || event.origin !== expected) return null;
    const bridge = bridgeFrom(target);
    if (bridge?.isReaderFrameProtocolEnvelope?.(event.data)) {
      const normalized = bridge.normalizeReaderFrameProtocolEvent?.(event, frame, location);
      return validateReaderMessageData(normalized) ? normalized as MessageRecord : null;
    }
    return validateReaderMessageData(event.data) ? event.data as MessageRecord : null;
  }

  return Object.freeze({
    ACTIONS: READER_MESSAGE_ACTIONS,
    validateData: validateReaderMessageData,
    validateEvent: (
      event: ReaderMessageEvent | null | undefined,
      frame: ReaderMessageFrame | null | undefined,
      hostLocation?: ReaderMessageLocation | null,
    ): boolean => normalizeEvent(event, frame, hostLocation) !== null,
    normalizeEvent,
  });
}

export type ReaderMessageGuardApi = ReturnType<typeof createReaderMessageApi>;

export function installReaderMessageGuard(
  target: ReaderMessageRuntime,
): ReaderMessageGuardApi {
  const api = createReaderMessageApi(target);
  target.ReaderMessageGuard = api;
  const commonJsModule = (target as ReaderMessageRuntime & {
    readonly module?: { exports?: unknown };
  }).module;
  if (commonJsModule && typeof commonJsModule === "object") {
    commonJsModule.exports = api;
  }
  return api;
}
