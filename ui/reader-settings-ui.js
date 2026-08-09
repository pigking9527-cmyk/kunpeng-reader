// 阅读设置状态与设置面板绑定
// 先于 reader.js 加载：提供 settings/applyShellTheme/initSettingsUI 给阅读页启动逻辑使用。

const readerSettingsT = (key, fallback, values) => window.ReaderI18n?.t?.(key, fallback, values) || fallback;

function normalizeReaderJumpBackIconSizePx(value, fallback = 32) {
  const number = Number(value);
  return Math.max(30, Math.min(160, Math.round(Number.isFinite(number) ? number : fallback)));
}

function readerJumpBackIconSizePxFromLegacyLevel(value) {
  const level = Math.max(1, Math.min(10, Number(value) || 1));
  return Math.round(32 * (1 + ((level - 1) * 4 / 9)));
}

function readerJumpBackLegacySizeLevelFromPx(value) {
  return Math.max(1, Math.min(10, Math.round((normalizeReaderJumpBackIconSizePx(value) / 32 - 1) * 9 / 4 + 1)));
}

// 阅读页设置会经 postMessage 传给章节 iframe，再动态拼入 CSS。将原始 10 MB
// 图片直接作为 data URL 传递会让 WebView2 的消息和样式文本膨胀到十余 MB，甚至
// 使阅读器无法打开。导入端会先压缩；这里仍保留迁移保护，用于清理旧版本留下的值。
const MAX_INLINE_BACKGROUND_IMAGE_CHARS = 160000;
const BACKGROUND_IMAGE_DATA_URL = /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i;

function safeBackgroundImage(value) {
  const image = String(value || "");
  return image.length <= MAX_INLINE_BACKGROUND_IMAGE_CHARS && BACKGROUND_IMAGE_DATA_URL.test(image) ? image : "";
}

function sanitizeBackgroundImage(settingsValue) {
  if (!settingsValue || typeof settingsValue !== "object") return false;
  const safe = safeBackgroundImage(settingsValue.customBackgroundImage);
  if (safe === String(settingsValue.customBackgroundImage || "")) return false;
  settingsValue.customBackgroundImage = safe;
  return true;
}

function applyReaderAnimationSettings() {
  window.ReaderAnimationSettings?.applyReader(document);
}
window.addEventListener("reader-animation-settings-changed", applyReaderAnimationSettings);
window.addEventListener("storage", (event) => {
  if (event.key === window.ReaderAnimationSettings?.STORAGE_KEY) applyReaderAnimationSettings();
});
applyReaderAnimationSettings();

const READER_TOOLBAR_ITEM_IDS = Object.freeze(["toc", "chapters", "tts", "annotations", "vocabulary", "settings"]);
const READER_CLICK_ZONE_ACTIONS = Object.freeze(["prev", "center", "next", "none"]);
const READER_LAYOUT_FONT_FAMILIES = Object.freeze([
  "",
  "'Microsoft YaHei',sans-serif",
  "'SimSun',serif",
  "'SimHei',sans-serif",
  "'KaiTi',serif",
  "'Kunpeng LXGW WenKai Lite','Microsoft YaHei',sans-serif",
  "'Kunpeng Source Han Serif SC','SimSun',serif",
  "'Kunpeng Zhuque Fangsong','FangSong','SimSun',serif",
  "serif",
  "sans-serif",
]);
const MAX_READER_CLICK_ZONES = 12;
const DEFAULT_READER_CLICK_ZONES = Object.freeze([
  Object.freeze({ id: "zone-1", action: "prev", x: 0, y: 0, width: 400, height: 1000 }),
  Object.freeze({ id: "zone-2", action: "center", x: 400, y: 0, width: 200, height: 1000 }),
  Object.freeze({ id: "zone-3", action: "next", x: 600, y: 0, width: 400, height: 1000 }),
]);

function normalizedReaderToolbarOrder(value) {
  const source = Array.isArray(value) ? value : [];
  const seen = new Set();
  const order = [];
  source.forEach((id) => {
    if (READER_TOOLBAR_ITEM_IDS.includes(id) && !seen.has(id)) { seen.add(id); order.push(id); }
  });
  READER_TOOLBAR_ITEM_IDS.forEach((id) => { if (!seen.has(id)) order.push(id); });
  return order;
}

function readerZonesOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function trimReaderZoneAgainst(zone, blocker) {
  if (!readerZonesOverlap(zone, blocker)) return zone;
  const overlapLeft = Math.max(zone.x, blocker.x);
  const overlapTop = Math.max(zone.y, blocker.y);
  const overlapRight = Math.min(zone.x + zone.width, blocker.x + blocker.width);
  const overlapBottom = Math.min(zone.y + zone.height, blocker.y + blocker.height);
  const candidates = [
    Object.assign({}, zone, { width: overlapLeft - zone.x }),
    Object.assign({}, zone, { x: overlapRight, width: zone.x + zone.width - overlapRight }),
    Object.assign({}, zone, { height: overlapTop - zone.y }),
    Object.assign({}, zone, { y: overlapBottom, height: zone.y + zone.height - overlapBottom }),
  ].filter((candidate) => candidate.width >= 20 && candidate.height >= 20);
  candidates.sort((a, b) => b.width * b.height - a.width * a.height);
  return candidates[0] || null;
}

function removeReaderZoneOverlaps(source) {
  const accepted = [];
  source.forEach((zone) => {
    let candidate = zone;
    accepted.forEach((blocker) => { if (candidate) candidate = trimReaderZoneAgainst(candidate, blocker); });
    if (candidate) accepted.push(candidate);
  });
  return accepted;
}

function normalizedReaderClickZones(value) {
  const supplied = Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
  const source = (supplied.length ? supplied : DEFAULT_READER_CLICK_ZONES).slice(0, MAX_READER_CLICK_ZONES);
  const usedIds = new Set();
  const normalized = source.map((raw, index) => {
    const fallback = DEFAULT_READER_CLICK_ZONES[index] || { id: `zone-${index + 1}`, action: "none", x: 350, y: 350, width: 300, height: 300 };
    const x = Math.max(0, Math.min(980, Math.round(Number(raw.x) || 0)));
    const y = Math.max(0, Math.min(980, Math.round(Number(raw.y) || 0)));
    const width = Math.max(20, Math.min(1000 - x, Math.round(Number(raw.width) || fallback.width)));
    const height = Math.max(20, Math.min(1000 - y, Math.round(Number(raw.height) || fallback.height)));
    let id = typeof raw.id === "string" && /^[a-z0-9-]{1,40}$/i.test(raw.id) ? raw.id : fallback.id;
    const baseId = id;
    let suffix = 2;
    while (usedIds.has(id)) { id = `${baseId}-${suffix}`; suffix += 1; }
    usedIds.add(id);
    return {
      id,
      action: READER_CLICK_ZONE_ACTIONS.includes(raw.action) ? raw.action : fallback.action,
      x, y, width, height,
    };
  });
  return removeReaderZoneOverlaps(normalized);
}

function readerClickActionAt(clientX, clientY, width, height) {
  const viewportWidth = Math.max(1, Number(width) || 1);
  const viewportHeight = Math.max(1, Number(height) || 1);
  const x = Math.max(0, Math.min(1000, Number(clientX) / viewportWidth * 1000));
  const y = Math.max(0, Math.min(1000, Number(clientY) / viewportHeight * 1000));
  const match = normalizedReaderClickZones(settings.clickZones).find((zone) => (
    x >= zone.x && x <= zone.x + zone.width && y >= zone.y && y <= zone.y + zone.height
  ));
  return match?.action || "none";
}

function applyReaderToolbarOrder(value) {
  const toolbar = document.querySelector(".toolbar");
  const anchor = toolbar?.querySelector(".search-wrap");
  if (!toolbar || !anchor) return;
  const elements = {
    toc: [document.getElementById("toc-btn")],
    chapters: [document.getElementById("prev-btn"), document.getElementById("next-btn")],
    tts: [document.getElementById("tts-btn")],
    annotations: [document.getElementById("hl-btn")],
    vocabulary: [document.getElementById("vocab-btn")],
    settings: [document.getElementById("reader-settings-toolbar-item")],
  };
  normalizedReaderToolbarOrder(value).forEach((id) => {
    elements[id].filter(Boolean).forEach((element) => toolbar.insertBefore(element, anchor));
  });
}

const DEFAULTS = {
  theme: "light",
  fontFamily: "",
  styleMode: "local",
  textConversion: "t2s",
  fontSize: 18,
  noteFontSize: 14,
  lineHeight: 1.7,
  paraSpacing: 0.6,
  letterSpacing: 0,
  marginTop: 18,
  marginBottom: 24,
  marginLeft: 28,
  marginRight: 28,
  dualPageGap: 40,
  pageMode: "single",
  flowMode: "paged",
  pageTurnEffect: "horizontal",
  pageTurnSpeed: 1,
  ttsSource: "edge",
  ttsRate: 1,
  backgroundPreset: "light",
  customBackgroundColor: "#fffdf8",
  customBackgroundImage: "",
  customPaletteId: "",
  textColor: "",
  linkColor: "",
  selectionColor: "",
  footnoteBackground: "",
  footnoteBorder: "",
  imagePagination: "next-page",
  showTextConversion: true,
  showTocButton: true,
  showChapterButtons: true,
  showVocabularyButton: true,
  showTtsButton: true,
  showAnnotationButton: true,
  toolbarOrder: READER_TOOLBAR_ITEM_IDS.slice(),
  clickZones: DEFAULT_READER_CLICK_ZONES.map((zone) => Object.assign({}, zone)),
  showPageInfo: true,
  showReaderJumpBack: true,
  readerJumpBackDismissMode: "pages",
  readerJumpBackDismissSeconds: 30,
  readerJumpBackDismissPages: 3,
  // 旧端仍读取此字段；新端以 readerJumpBackIconSizePx 为准。
  readerJumpBackSizeLevel: 1,
  readerJumpBackIconSizePx: 32,
  // 坐标以阅读区域宽高的千分比表示，因而在不同屏幕尺寸下仍保持相对位置。
  readerJumpBackPositionX: 950,
  readerJumpBackPositionY: 500,
};

// Windows WebView2 的原生 switch transition 正常；仅 macOS WKWebView 需要补偿动画。
const READER_SHELL_IS_MAC_WEBKIT = /Macintosh|Mac OS X/.test(navigator.userAgent || "")
  && /AppleWebKit/.test(navigator.userAgent || "")
  && !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent || "");

// 外壳（工具栏/目录/设置）的深色应用
function applyShellTheme(theme) {
  const body = document.body;
  body.classList.add("reader-theme-instant");
  body.classList.toggle("theme-dark", theme === "dark");
  requestAnimationFrame(() => requestAnimationFrame(() => {
    body.classList.remove("reader-theme-instant");
  }));
}

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem("readerSettings") || "{}");
    const merged = Object.assign({}, DEFAULTS, stored);
    if (!Object.prototype.hasOwnProperty.call(stored, "readerJumpBackIconSizePx")) {
      merged.readerJumpBackIconSizePx = readerJumpBackIconSizePxFromLegacyLevel(stored.readerJumpBackSizeLevel);
    } else {
      merged.readerJumpBackIconSizePx = normalizeReaderJumpBackIconSizePx(stored.readerJumpBackIconSizePx);
    }
    // Older settings stored the three original backgrounds in theme only.
    if (!stored.backgroundPreset && ["light", "dark", "sepia"].includes(stored.theme)) merged.backgroundPreset = stored.theme;
    if (sanitizeBackgroundImage(merged)) localStorage.setItem("readerSettings", JSON.stringify(merged));
    if (sanitizeBackgroundImage(merged)) localStorage.setItem("readerSettings", JSON.stringify(merged));
    return merged;
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
let settings = loadSettings();
const READER_APPEARANCE_KEYS = new Set(["backgroundPreset", "customBackgroundColor", "customBackgroundImage", "customPaletteId", "textColor", "linkColor", "selectionColor", "footnoteBackground", "footnoteBorder", "theme"]);
const READER_BOOK_APPEARANCE_KEY = "readerBookAppearanceV1";
let defaultAppearanceSettings = Object.assign({}, settings);
let activeReaderBookId = "";
let bookAppearanceSettings = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(READER_BOOK_APPEARANCE_KEY) || "{}");
    if (!stored || typeof stored !== "object") return {};
    let changed = false;
    Object.values(stored).forEach((appearance) => { changed = sanitizeBackgroundImage(appearance) || changed; });
    if (changed) localStorage.setItem(READER_BOOK_APPEARANCE_KEY, JSON.stringify(stored));
    return stored;
  } catch (_) {
    return {};
  }
})();
window.addEventListener("storage", (event) => {
  if (event.key !== "readerSettings") return;
  settings = loadSettings();
  normalizeModeSettings();
  const turnFx = document.getElementById("set-turnfx");
  if (turnFx) turnFx.value = settings.pageTurnEffect;
  pushSettings();
});

function normalizeModeSettings() {
  let changed = false;
  const toolbarOrder = normalizedReaderToolbarOrder(settings.toolbarOrder);
  if (!Array.isArray(settings.toolbarOrder) || toolbarOrder.some((id, index) => settings.toolbarOrder[index] !== id) || settings.toolbarOrder.length !== toolbarOrder.length) {
    settings.toolbarOrder = toolbarOrder;
    changed = true;
  }
  const clickZones = normalizedReaderClickZones(settings.clickZones);
  if (!Array.isArray(settings.clickZones) || JSON.stringify(clickZones) !== JSON.stringify(settings.clickZones)) {
    settings.clickZones = clickZones;
    changed = true;
  }
  if (!["local", "book"].includes(settings.styleMode)) {
    settings.styleMode = DEFAULTS.styleMode;
    changed = true;
  }
  if (["google-paper", "curl"].includes(settings.pageTurnEffect)) {
    // 旧的两种动画统一迁移到新的水平整页翻动。
    settings.pageTurnEffect = "horizontal";
    changed = true;
  } else if (!["off", "horizontal"].includes(settings.pageTurnEffect)) {
    settings.pageTurnEffect = DEFAULTS.pageTurnEffect;
    changed = true;
  }
  // v1.11.2 的“原文”选项迁移为简体，新的开关始终在简/繁之间切换。
  if (settings.textConversion === "original") {
    settings.textConversion = "t2s";
    changed = true;
  } else if (!["t2s", "s2t"].includes(settings.textConversion)) {
    settings.textConversion = DEFAULTS.textConversion;
    changed = true;
  }
  const speed = parseFloat(settings.pageTurnSpeed);
  if (!Number.isFinite(speed)) {
    settings.pageTurnSpeed = DEFAULTS.pageTurnSpeed;
    changed = true;
  } else {
    const next = Math.max(0.5, Math.min(2, speed));
    if (next !== settings.pageTurnSpeed) {
      settings.pageTurnSpeed = next;
      changed = true;
    }
  }
  const dualPageGap = Number(settings.dualPageGap);
  if (!Number.isFinite(dualPageGap)) {
    settings.dualPageGap = DEFAULTS.dualPageGap;
    changed = true;
  } else {
    const nextGap = Math.max(0, Math.min(120, Math.round(dualPageGap)));
    if (nextGap !== settings.dualPageGap) {
      settings.dualPageGap = nextGap;
      changed = true;
    }
  }
  if (settings.flowMode === "scroll" && settings.pageMode !== "single") {
    settings.pageMode = "single";
    changed = true;
  }
  return changed;
}

function saveSettings() {
  normalizeModeSettings();
  sanitizeBackgroundImage(defaultAppearanceSettings);
  localStorage.setItem("readerSettings", JSON.stringify(defaultAppearanceSettings));
}
// 把设置发给合并页（实时注入样式）
function pushSettings() {
  // UI language is window state, not a persisted reading preference.  Pass it
  // through with every layout update so the injected chapter iframe never
  // keeps stale Chinese controls after the user changes language.
  const pageSettings = Object.assign({}, settings, {
    uiLanguage: window.ReaderI18n?.resolvedLanguage?.() || "zh-CN",
  });
  if (frame.contentWindow) frame.contentWindow.postMessage({ settings: pageSettings }, "*");
}
window.addEventListener("reader-language-changed", pushSettings);
function onChange() {
  Object.keys(settings).forEach((key) => { if (!READER_APPEARANCE_KEYS.has(key)) defaultAppearanceSettings[key] = settings[key]; });
  saveSettings();
  pushSettings();
  window.dispatchEvent(new CustomEvent("reader-settings-changed", { detail: Object.assign({}, settings) }));
}

function setReaderSettings(patch) {
  Object.assign(settings, patch || {});
  Object.assign(defaultAppearanceSettings, patch || {});
  sanitizeBackgroundImage(settings);
  sanitizeBackgroundImage(defaultAppearanceSettings);
  sanitizeBackgroundImage(settings);
  sanitizeBackgroundImage(defaultAppearanceSettings);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "backgroundPreset")) {
    settings.theme = patch.theme || settings.backgroundPreset;
    defaultAppearanceSettings.theme = settings.theme;
  }
  normalizeModeSettings();
  applyShellTheme(settings.theme);
  onChange();
}

function applyAppearanceSettings(next) {
  Object.assign(settings, next || {});
  sanitizeBackgroundImage(settings);
  sanitizeBackgroundImage(settings);
  normalizeModeSettings();
  applyShellTheme(settings.theme);
  pushSettings();
  window.dispatchEvent(new CustomEvent("reader-settings-changed", { detail: Object.assign({}, settings) }));
}

function appearanceForScope(scope) {
  if (scope === "book" && activeReaderBookId) {
    // 早期阅读偏好把工具栏开关也误写进了单本外观。单本覆盖只允许
    // 外观字段，避免旧值继续压过总体工具栏设置。
    const bookAppearance = bookAppearanceSettings[activeReaderBookId] || {};
    const appearanceOverrides = Object.fromEntries(
      Object.entries(bookAppearance).filter(([key]) => READER_APPEARANCE_KEYS.has(key)),
    );
    return Object.assign({}, defaultAppearanceSettings, appearanceOverrides);
  }
  return Object.assign({}, defaultAppearanceSettings);
}

function updateAppearance(patch, scope) {
  const targetScope = scope === "book" && activeReaderBookId ? "book" : "default";
  if (targetScope === "book") {
    const current = bookAppearanceSettings[activeReaderBookId] || {};
    const appearancePatch = Object.fromEntries(
      Object.entries(patch || {}).filter(([key]) => READER_APPEARANCE_KEYS.has(key)),
    );
    bookAppearanceSettings[activeReaderBookId] = Object.assign({}, current, appearancePatch);
    sanitizeBackgroundImage(bookAppearanceSettings[activeReaderBookId]);
    sanitizeBackgroundImage(bookAppearanceSettings[activeReaderBookId]);
    localStorage.setItem(READER_BOOK_APPEARANCE_KEY, JSON.stringify(bookAppearanceSettings));
    applyAppearanceSettings(appearanceForScope("book"));
    return;
  }
  Object.assign(defaultAppearanceSettings, patch || {});
  sanitizeBackgroundImage(defaultAppearanceSettings);
  if (patch && Object.prototype.hasOwnProperty.call(patch, "backgroundPreset") && !Object.prototype.hasOwnProperty.call(patch, "theme")) defaultAppearanceSettings.theme = defaultAppearanceSettings.backgroundPreset;
  saveSettings();
  applyAppearanceSettings(activeReaderBookId ? appearanceForScope("book") : appearanceForScope("default"));
}

window.ReaderSettings = Object.freeze({
  get() { return Object.assign({}, settings); },
  update: setReaderSettings,
  getAppearance(scope) { return appearanceForScope(scope); },
  updateAppearance,
  setBookContext(bookId) {
    activeReaderBookId = String(bookId || "");
    if (activeReaderBookId && bookAppearanceSettings[activeReaderBookId]) applyAppearanceSettings(appearanceForScope("book"));
  },
  hasBookAppearance() { return !!(activeReaderBookId && bookAppearanceSettings[activeReaderBookId]); },
  clearBookAppearance() {
    if (!activeReaderBookId || !bookAppearanceSettings[activeReaderBookId]) return;
    delete bookAppearanceSettings[activeReaderBookId];
    localStorage.setItem(READER_BOOK_APPEARANCE_KEY, JSON.stringify(bookAppearanceSettings));
    applyAppearanceSettings(appearanceForScope("default"));
  },
  clickActionAt(clientX, clientY, width, height) { return readerClickActionAt(clientX, clientY, width, height); },
  applyToolbarVisibility() {
    applyReaderToolbarOrder(settings.toolbarOrder);
    document.querySelector(".text-conversion-toggle")?.toggleAttribute("hidden", settings.showTextConversion === false);
    const hideChapterButtons = settings.showChapterButtons === false;
    document.getElementById("prev-btn")?.toggleAttribute("hidden", hideChapterButtons);
    document.getElementById("next-btn")?.toggleAttribute("hidden", hideChapterButtons);
    document.getElementById("vocab-btn")?.toggleAttribute("hidden", settings.showVocabularyButton === false);
  },
});

const readerSettingsInvoke = window.__TAURI__?.core?.invoke;
const readerSettingsEventApi = window.__TAURI__?.event;
let appSettingsSyncReady = false;
let appSettingsSyncTimer = 0;
let lastAppSettingsSyncPayload = "";

function normalizedJumpBackPosition(value, fallback) {
  const number = Number(value);
  return Math.max(0, Math.min(1000, Math.round(Number.isFinite(number) ? number : fallback)));
}

function normalizedReaderLayoutNumber(value, fallback, minimum, maximum, step = 1) {
  const number = Number(value);
  const bounded = Math.max(minimum, Math.min(maximum, Number.isFinite(number) ? number : fallback));
  return Math.round((Math.round(bounded / step) * step) * 10) / 10;
}

function normalizedReaderLayoutSettings(value) {
  if (!value || typeof value !== "object") return null;
  const fontFamily = READER_LAYOUT_FONT_FAMILIES.includes(value.fontFamily) ? value.fontFamily : "";
  const flowMode = value.flowMode === "scroll" ? "scroll" : "paged";
  return {
    version: 1,
    fontFamily,
    styleMode: value.styleMode === "book" ? "book" : "local",
    textConversion: value.textConversion === "s2t" ? "s2t" : "t2s",
    fontSize: normalizedReaderLayoutNumber(value.fontSize, DEFAULTS.fontSize, 12, 40),
    noteFontSize: normalizedReaderLayoutNumber(value.noteFontSize, DEFAULTS.noteFontSize, 10, 22),
    lineHeight: normalizedReaderLayoutNumber(value.lineHeight, DEFAULTS.lineHeight, 1, 2.6, 0.1),
    paraSpacing: normalizedReaderLayoutNumber(value.paraSpacing, DEFAULTS.paraSpacing, 0, 2, 0.1),
    letterSpacing: normalizedReaderLayoutNumber(value.letterSpacing, DEFAULTS.letterSpacing, 0, 5, 0.5),
    marginTop: normalizedReaderLayoutNumber(value.marginTop, DEFAULTS.marginTop, 0, 160),
    marginBottom: normalizedReaderLayoutNumber(value.marginBottom, DEFAULTS.marginBottom, 0, 160),
    marginLeft: normalizedReaderLayoutNumber(value.marginLeft, DEFAULTS.marginLeft, 0, 240),
    marginRight: normalizedReaderLayoutNumber(value.marginRight, DEFAULTS.marginRight, 0, 240),
    dualPageGap: normalizedReaderLayoutNumber(value.dualPageGap, DEFAULTS.dualPageGap, 0, 120),
    pageMode: flowMode === "scroll" ? "single" : (value.pageMode === "dual" ? "dual" : "single"),
    flowMode,
    pageTurnEffect: value.pageTurnEffect === "off" ? "off" : "horizontal",
    pageTurnSpeed: normalizedReaderLayoutNumber(value.pageTurnSpeed, DEFAULTS.pageTurnSpeed, 0.5, 2, 0.1),
    imagePagination: value.imagePagination === "continuous" ? "continuous" : "next-page",
  };
}

function normalizedAppSettingsSyncPayload() {
  return {
    showReaderJumpBack: settings.showReaderJumpBack !== false,
    readerJumpBackDismissMode: settings.readerJumpBackDismissMode === "time" ? "time" : "pages",
    readerJumpBackDismissSeconds: Math.max(1, Math.min(600, Number(settings.readerJumpBackDismissSeconds) || 30)),
    readerJumpBackDismissPages: Math.max(1, Math.min(100, Number(settings.readerJumpBackDismissPages) || 3)),
    // 为仍在使用 1–10 级的旧桌面端保留近似值；新端只读取像素字段。
    readerJumpBackSizeLevel: readerJumpBackLegacySizeLevelFromPx(settings.readerJumpBackIconSizePx),
    readerJumpBackIconSizePx: normalizeReaderJumpBackIconSizePx(settings.readerJumpBackIconSizePx),
    readerJumpBackPositionX: normalizedJumpBackPosition(settings.readerJumpBackPositionX, 950),
    readerJumpBackPositionY: normalizedJumpBackPosition(settings.readerJumpBackPositionY, 500),
    readerLayoutSettings: normalizedReaderLayoutSettings(settings),
  };
}

function queueAppSettingsSyncSave() {
  if (!appSettingsSyncReady || typeof readerSettingsInvoke !== "function") return;
  const request = normalizedAppSettingsSyncPayload();
  const serialized = JSON.stringify(request);
  if (serialized === lastAppSettingsSyncPayload) return;
  if (appSettingsSyncTimer) clearTimeout(appSettingsSyncTimer);
  appSettingsSyncTimer = window.setTimeout(async () => {
    appSettingsSyncTimer = 0;
    try {
      await readerSettingsInvoke("app_settings_sync_save", { request });
      lastAppSettingsSyncPayload = serialized;
    } catch (_) {
      // 离线或数据库暂不可用时保留本机设置；下次修改或打开阅读页会重试。
    }
  }, 180);
}

async function hydrateAppSettingsSync() {
  if (typeof readerSettingsInvoke !== "function") {
    appSettingsSyncReady = true;
    return;
  }
  try {
    const remote = await readerSettingsInvoke("app_settings_sync_get");
    if (remote?.exists) {
      appSettingsSyncReady = false;
      const remoteLayout = remote?.hasReaderLayoutSettings
        ? normalizedReaderLayoutSettings(remote.readerLayoutSettings)
        : null;
      setReaderSettings({
        showReaderJumpBack: remote.showReaderJumpBack !== false,
        readerJumpBackDismissMode: remote.readerJumpBackDismissMode === "time" ? "time" : "pages",
        readerJumpBackDismissSeconds: Math.max(1, Math.min(600, Number(remote.readerJumpBackDismissSeconds) || 30)),
        readerJumpBackDismissPages: Math.max(1, Math.min(100, Number(remote.readerJumpBackDismissPages) || 3)),
        readerJumpBackSizeLevel: Math.max(1, Math.min(10, Number(remote.readerJumpBackSizeLevel) || 1)),
        readerJumpBackIconSizePx: Object.prototype.hasOwnProperty.call(remote, "readerJumpBackIconSizePx")
          ? normalizeReaderJumpBackIconSizePx(remote.readerJumpBackIconSizePx)
          : readerJumpBackIconSizePxFromLegacyLevel(remote.readerJumpBackSizeLevel),
        readerJumpBackPositionX: normalizedJumpBackPosition(remote.readerJumpBackPositionX, 950),
        readerJumpBackPositionY: normalizedJumpBackPosition(remote.readerJumpBackPositionY, 500),
        ...(remoteLayout || {}),
      });
      lastAppSettingsSyncPayload = remoteLayout ? JSON.stringify(normalizedAppSettingsSyncPayload()) : "";
      appSettingsSyncReady = true;
      if (!remoteLayout) queueAppSettingsSyncSave();
      return;
    }
    appSettingsSyncReady = true;
    lastAppSettingsSyncPayload = "";
    queueAppSettingsSyncSave();
  } catch (_) {
    appSettingsSyncReady = true;
  }
}

window.addEventListener("reader-settings-changed", queueAppSettingsSyncSave);
Promise.resolve(readerSettingsEventApi?.listen?.("app-settings-synced", hydrateAppSettingsSync)).catch(() => {});
hydrateAppSettingsSync();

function applyReaderSettingsVisibility() {
  window.ReaderSettings.applyToolbarVisibility();
}

function bindRange(id, vid, key, fmt) {
  const el = document.getElementById(id);
  const vEl = document.getElementById(vid);
  if (!el || !vEl) return;
  el.value = settings[key];
  vEl.textContent = fmt(settings[key]);
  el.addEventListener("input", () => {
    settings[key] = parseFloat(el.value);
    vEl.textContent = fmt(settings[key]);
    onChange();
  });
}
function ensureNoteSizeControl() {
  if (document.getElementById("set-note-size")) return;
  const size = document.getElementById("set-size");
  const sizeRow = size && size.closest ? size.closest(".row") : null;
  if (!sizeRow || !sizeRow.parentNode) return;
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = '<label data-reader-i18n="noteFontSize">' + readerSettingsT("noteFontSize", "注释字号") + '</label><input type="range" id="set-note-size" min="10" max="22" step="1" /><span class="val" id="v-note-size"></span>';
  sizeRow.parentNode.insertBefore(row, sizeRow.nextSibling);
}
function bindNum(id, key) {
  const el = document.getElementById(id);
  const lo = el.min !== "" ? parseInt(el.min, 10) : 0;
  const hi = el.max !== "" ? parseInt(el.max, 10) : 9999;
  const clamp = (v) => Math.max(lo, Math.min(hi, isNaN(v) ? 0 : v));
  el.value = clamp(parseInt(settings[key], 10));
  el.addEventListener("input", () => {
    settings[key] = clamp(parseInt(el.value, 10)); // 用于排版的值始终夹紧（负边距会让页面变形）
    if (String(el.value) !== String(settings[key])) el.value = settings[key];
    onChange();
  });
  el.addEventListener("change", () => {
    el.value = clamp(parseInt(el.value, 10)); // 失焦时把输入框也纠正回合法范围
  });
}

function initSettingsUI() {
  if (normalizeModeSettings()) saveSettings();
  ensureNoteSizeControl();
  // 主题按钮
  function refreshThemeBtns() {
    document
      .querySelectorAll(".theme-btn")
      .forEach((b) => b.classList.toggle("active", b.dataset.theme === settings.theme));
  }
  document.querySelectorAll(".theme-btn").forEach((b) => {
    b.addEventListener("click", () => {
      settings.theme = b.dataset.theme;
      settings.backgroundPreset = settings.theme;
      refreshThemeBtns();
      applyShellTheme(settings.theme);
      onChange();
    });
  });
  refreshThemeBtns();

  const font = document.getElementById("set-font");
  const fontDownloadRow = document.getElementById("reader-font-download-row");
  const fontDownloadStatus = document.getElementById("reader-font-download-status");
  const fontDownloadAction = document.getElementById("reader-font-download-action");
  const readerFontState = new Map();
  let fontDownloadBusy = false;
  const selectedOptionalFont = () => {
    const option = font.options[font.selectedIndex];
    return option?.dataset?.readerFontId ? option : null;
  };
  const fontSizeText = (bytes) => {
    const mb = Number(bytes || 0) / (1024 * 1024);
    return (mb >= 10 ? mb.toFixed(1) : mb.toFixed(2)) + " MB";
  };
  function refreshOptionalFontUI() {
    font.querySelectorAll("option[data-reader-font-id]").forEach((option) => {
      const state = readerFontState.get(option.dataset.readerFontId);
      const label = option.dataset.readerFontLabel || option.textContent;
      option.textContent = state?.installed
        ? label + " (" + readerSettingsT("installed", "已安装") + ")"
        : label + " (" + readerSettingsT("downloadRequired", "需下载") + (state?.download_bytes ? " " + fontSizeText(state.download_bytes) : "") + ")";
    });
    const option = selectedOptionalFont();
    if (!option) {
      if (fontDownloadRow) fontDownloadRow.hidden = true;
      return;
    }
    const state = readerFontState.get(option.dataset.readerFontId);
    if (fontDownloadRow) fontDownloadRow.hidden = false;
    if (fontDownloadStatus) {
      fontDownloadStatus.textContent = fontDownloadBusy
        ? readerSettingsT("fontDownloading", "正在下载并校验字体…")
        : state?.installed
          ? readerSettingsT("fontInstalledOffline", "已安装到本机，断网也可使用。")
          : readerSettingsT("fontDownloadRequired", "首次使用需下载 {size}，下载后自动应用。", { size: fontSizeText(state?.download_bytes) });
    }
    if (fontDownloadAction) {
      fontDownloadAction.hidden = !!state?.installed;
      fontDownloadAction.disabled = fontDownloadBusy;
      fontDownloadAction.textContent = fontDownloadBusy ? readerSettingsT("downloading", "下载中…") : readerSettingsT("download", "下载");
    }
  }
  window.addEventListener("reader-language-changed", refreshOptionalFontUI);
  async function loadReaderFontStatus() {
    try {
      const states = await invoke("reader_font_status");
      states.forEach((state) => readerFontState.set(state.id, state));
    } catch (_) {}
    refreshOptionalFontUI();
  }
  async function installSelectedFont() {
    const option = selectedOptionalFont();
    if (!option || fontDownloadBusy) return;
    const id = option.dataset.readerFontId;
    if (readerFontState.get(id)?.installed) {
      settings.fontFamily = font.value;
      onChange();
      return;
    }
    fontDownloadBusy = true;
    refreshOptionalFontUI();
    try {
      const state = await invoke("download_reader_font", { fontId: id });
      readerFontState.set(id, state);
      settings.fontFamily = font.value;
      onChange();
    } catch (error) {
      if (fontDownloadStatus) fontDownloadStatus.textContent = readerSettingsT("fontDownloadFailed", "字体下载失败：{error}", { error: String(error) });
    } finally {
      fontDownloadBusy = false;
      refreshOptionalFontUI();
    }
  }
  font.value = settings.fontFamily;
  font.addEventListener("change", () => {
    refreshOptionalFontUI();
    const option = selectedOptionalFont();
    if (option && !readerFontState.get(option.dataset.readerFontId)?.installed) {
      installSelectedFont();
      return;
    }
    settings.fontFamily = font.value;
    onChange();
  });
  fontDownloadAction?.addEventListener("click", installSelectedFont);
  loadReaderFontStatus();
  const styleMode = document.getElementById("set-style-mode");
  if (styleMode) {
    styleMode.value = settings.styleMode;
    styleMode.addEventListener("change", () => {
      settings.styleMode = styleMode.value === "book" ? "book" : "local";
      onChange();
    });
  }
  const textConversionToggle = document.getElementById("set-text-conversion-simple");
  const textConversionLabel = document.getElementById("text-conversion-state-label");
  if (textConversionToggle) {
    const renderTextConversionState = () => {
      const traditional = settings.textConversion === "s2t";
      textConversionToggle.checked = traditional;
      if (textConversionLabel) textConversionLabel.textContent = traditional ? "繁" : "简";
    };
    renderTextConversionState();
    textConversionToggle.addEventListener("change", () => {
      settings.textConversion = textConversionToggle.checked ? "s2t" : "t2s";
      renderTextConversionState();
      onChange();
    });
  }
  bindRange("set-size", "v-size", "fontSize", (v) => v + "px");
  bindRange("set-note-size", "v-note-size", "noteFontSize", (v) => v + "px");
  bindRange("set-line", "v-line", "lineHeight", (v) => v.toFixed(1));
  bindRange("set-para", "v-para", "paraSpacing", (v) => v.toFixed(1) + "em");
  bindRange("set-letter", "v-letter", "letterSpacing", (v) => v + "px");
  bindRange("set-turnspeed", "v-turnspeed", "pageTurnSpeed", (v) => parseFloat(v).toFixed(1) + "x");
  bindNum("set-mt", "marginTop");
  bindNum("set-mb", "marginBottom");
  bindNum("set-ml", "marginLeft");
  bindNum("set-mr", "marginRight");
  const turnFx = document.getElementById("set-turnfx");
  if (turnFx) {
    turnFx.value = settings.pageTurnEffect || DEFAULTS.pageTurnEffect;
    turnFx.addEventListener("change", () => {
      settings.pageTurnEffect = turnFx.value;
      window.ReaderAnimationSettings?.setPageTurnFromReader?.(turnFx.value !== "off");
      onChange();
    });
  }
  const dualModeToggle = document.getElementById("set-dual-mode");
  const scrollModeToggle = document.getElementById("set-scroll-mode");
  const dualModeLabel = document.getElementById("set-dual-mode-label");
  const scrollModeLabel = document.getElementById("set-scroll-mode-label");
  function animateToggleOff(input) {
    const shell = input?.closest?.(".settings-switch");
    if (!shell) return;
    shell.classList.remove("auto-off");
    void shell.offsetWidth; // 允许连续切换时重新触发动画
    shell.classList.add("auto-off");
  }
  function refreshReadingModeToggles() {
    normalizeModeSettings();
    if (dualModeToggle) {
      dualModeToggle.checked = settings.flowMode !== "scroll" && settings.pageMode === "dual";
      // auto-off 用 fill-mode 保持关闭终态；重新开启双页时才解除它。
      if (dualModeToggle.checked) dualModeToggle.closest(".settings-switch")?.classList.remove("auto-off");
      dualModeToggle.title = readerSettingsT("enableTwoPages", "开启双页");
    }
    if (scrollModeToggle) {
      scrollModeToggle.checked = settings.flowMode === "scroll";
      scrollModeToggle.title = readerSettingsT("enableScrollMode", "开启滚动模式");
    }
    // 开关左侧始终描述正在生效的阅读模式，避免“开关关闭但文字仍写双页”
    // 这类把操作目标误当成当前状态的歧义。
    if (dualModeLabel) dualModeLabel.textContent = dualModeToggle?.checked
      ? readerSettingsT("twoPages", "双页")
      : readerSettingsT("singlePage", "单页");
    if (scrollModeLabel) scrollModeLabel.textContent = scrollModeToggle?.checked
      ? readerSettingsT("scrollMode", "滚动")
      : readerSettingsT("pagedMode", "整屏");
  }
  if (dualModeToggle) {
    dualModeToggle.addEventListener("change", () => {
      if (dualModeToggle.checked) {
        settings.flowMode = "paged";
        settings.pageMode = "dual";
      } else {
        settings.pageMode = "single";
      }
      refreshReadingModeToggles();
      onChange();
    });
  }
  if (scrollModeToggle) {
    scrollModeToggle.addEventListener("change", () => {
      const dualWasOn = !!dualModeToggle?.checked;
      if (scrollModeToggle.checked) {
        settings.flowMode = "scroll";
        settings.pageMode = "single";
      } else {
        settings.flowMode = "paged";
      }
      // 先占用圆点的 transform，再取消 checked。否则原生 transition 会先滑一次，
      // 随后的 keyframes 又从开启位置滑一次，看起来就像动画播放了两遍。
      if (READER_SHELL_IS_MAC_WEBKIT && scrollModeToggle.checked && dualWasOn) {
        animateToggleOff(dualModeToggle);
      }
      refreshReadingModeToggles();
      onChange();
    });
  }
  refreshReadingModeToggles();
  window.addEventListener("reader-language-changed", refreshReadingModeToggles);
  // 朗读设置
  const bindSel = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = settings[key];
    el.addEventListener("change", () => { settings[key] = el.value; onChange(); });
  };
  bindSel("set-ttssrc", "ttsSource");
  bindRange("set-ttsrate", "v-ttsrate", "ttsRate", (v) => v.toFixed(1) + "×");

  // 精简与经典界面共用同一份真实控件和设置状态。经典面板里的控件只是
  // 可视镜像，所有输入都转发到阅读偏好中的主控件，避免两套数值分叉。
  const quickSettingsPanel = document.getElementById("settings");
  const quickSettingsModeKey = "readerQuickSettingsUiMode";
  const quickMirrorSync = [];
  function connectQuickMirror(proxyId, sourceId, proxyOutputId, sourceOutputId) {
    const proxy = document.getElementById(proxyId);
    const source = document.getElementById(sourceId);
    const proxyOutput = proxyOutputId ? document.getElementById(proxyOutputId) : null;
    const sourceOutput = sourceOutputId ? document.getElementById(sourceOutputId) : null;
    if (!proxy || !source) return;
    const sync = () => {
      proxy.value = source.value;
      if (proxyOutput && sourceOutput) proxyOutput.textContent = sourceOutput.textContent;
    };
    const forward = (event) => {
      source.value = proxy.value;
      source.dispatchEvent(new Event(event.type, { bubbles: true }));
      sync();
    };
    proxy.addEventListener("input", forward);
    proxy.addEventListener("change", forward);
    source.addEventListener("input", sync);
    source.addEventListener("change", sync);
    quickMirrorSync.push(sync);
    sync();
  }
  connectQuickMirror("quick-set-ttsrate", "set-ttsrate", "quick-v-ttsrate", "v-ttsrate");
  connectQuickMirror("quick-set-style-mode", "set-style-mode");
  connectQuickMirror("quick-set-note-size", "set-note-size", "quick-v-note-size", "v-note-size");
  connectQuickMirror("quick-set-para", "set-para", "quick-v-para", "v-para");
  connectQuickMirror("quick-set-letter", "set-letter", "quick-v-letter", "v-letter");
  connectQuickMirror("quick-set-turnfx", "set-turnfx");
  connectQuickMirror("quick-set-turnspeed", "set-turnspeed", "quick-v-turnspeed", "v-turnspeed");
  connectQuickMirror("quick-set-mt", "set-mt");
  connectQuickMirror("quick-set-mb", "set-mb");
  connectQuickMirror("quick-set-ml", "set-ml");
  connectQuickMirror("quick-set-mr", "set-mr");
  const syncQuickMirrors = () => quickMirrorSync.forEach((sync) => sync());
  const quickSettingsPreview = document.getElementById("reader-quick-layout-preview");
  const QUICK_SETTINGS_PREVIEW_DURATION_MS = 1500;
  const QUICK_SETTINGS_PREVIEW_EXTENSION_MS = 1000;
  const QUICK_SETTINGS_PREVIEW_FADE_MS = 160;
  let quickSettingsPreviewDeadline = 0;
  let quickSettingsPreviewFadeTimer = 0;
  let quickSettingsPreviewHideTimer = 0;
  function hideQuickSettingsModePreview() {
    if (quickSettingsPreviewDeadline > Date.now()) return scheduleQuickSettingsModePreviewFade();
    quickSettingsPreview.hidden = true;
    quickSettingsPreview.replaceChildren();
    quickSettingsPreview.classList.remove("is-fading", "is-resetting");
    quickSettingsPreviewDeadline = 0;
    quickSettingsPreviewHideTimer = 0;
  }
  function scheduleQuickSettingsModePreviewFade() {
    globalThis.clearTimeout(quickSettingsPreviewFadeTimer);
    globalThis.clearTimeout(quickSettingsPreviewHideTimer);
    const remaining = Math.max(0, quickSettingsPreviewDeadline - Date.now());
    const fadeDelay = Math.max(0, remaining - QUICK_SETTINGS_PREVIEW_FADE_MS);
    quickSettingsPreviewFadeTimer = globalThis.setTimeout(() => {
      if (quickSettingsPreviewDeadline > Date.now() + QUICK_SETTINGS_PREVIEW_FADE_MS) return scheduleQuickSettingsModePreviewFade();
      quickSettingsPreview.classList.add("is-fading");
    }, fadeDelay);
    quickSettingsPreviewHideTimer = globalThis.setTimeout(hideQuickSettingsModePreview, remaining);
  }
  function extendQuickSettingsModePreview() {
    const now = Date.now();
    if (quickSettingsPreview.hidden || quickSettingsPreviewDeadline <= now) return false;
    quickSettingsPreviewDeadline += QUICK_SETTINGS_PREVIEW_EXTENSION_MS;
    quickSettingsPreview.classList.add("is-resetting");
    quickSettingsPreview.classList.remove("is-fading");
    void quickSettingsPreview.offsetWidth;
    quickSettingsPreview.classList.remove("is-resetting");
    scheduleQuickSettingsModePreviewFade();
    return true;
  }
  function showQuickSettingsModePreview() {
    if (!quickSettingsPreview || !quickSettingsPanel) return;
    const previewPanel = quickSettingsPanel.cloneNode(true);
    previewPanel.removeAttribute("id");
    previewPanel.setAttribute("aria-hidden", "true");
    previewPanel.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"));
    previewPanel.querySelectorAll("[for]").forEach((element) => element.removeAttribute("for"));
    previewPanel.querySelectorAll("input, select, button, textarea").forEach((element) => {
      element.disabled = true;
      element.tabIndex = -1;
    });
    quickSettingsPreview.replaceChildren(previewPanel);
    const now = Date.now();
    const alreadyVisible = !quickSettingsPreview.hidden && quickSettingsPreviewDeadline > now;
    quickSettingsPreviewDeadline = alreadyVisible
      ? quickSettingsPreviewDeadline + QUICK_SETTINGS_PREVIEW_EXTENSION_MS
      : now + QUICK_SETTINGS_PREVIEW_DURATION_MS;
    quickSettingsPreview.hidden = false;
    quickSettingsPreview.classList.add("is-resetting");
    quickSettingsPreview.classList.remove("is-fading");
    void quickSettingsPreview.offsetWidth;
    quickSettingsPreview.classList.remove("is-resetting");
    scheduleQuickSettingsModePreviewFade();
  }
  function setQuickSettingsMode(value, persist = true) {
    const mode = value === "classic" ? "classic" : "compact";
    if (quickSettingsPanel) quickSettingsPanel.dataset.quickUiMode = mode;
    document.querySelectorAll("[data-quick-ui-mode-option]").forEach((button) => {
      const active = button.dataset.quickUiModeOption === mode;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
    syncQuickMirrors();
    if (persist) {
      try { localStorage.setItem(quickSettingsModeKey, mode); } catch (_) {}
    }
  }
  let quickSettingsPreviewLastPointerButton = null;
  let quickSettingsPreviewLastPointerAt = 0;
  function triggerQuickSettingsModePreview(event) {
    const button = event.target?.closest?.("[data-quick-ui-mode-option]");
    if (!button) return;
    const now = Date.now();
    if (event.type === "click" && button === quickSettingsPreviewLastPointerButton && now - quickSettingsPreviewLastPointerAt < 700) return;
    if (event.type === "pointerdown") {
      quickSettingsPreviewLastPointerButton = button;
      quickSettingsPreviewLastPointerAt = now;
    }
    setQuickSettingsMode(button.dataset.quickUiModeOption);
    showQuickSettingsModePreview();
  }
  // 预览本身位于偏好窗口之上。捕获阶段在按下时续时，避免等待 click 的抬起
  // 事件，也让连续点击不会被预览层的重绘打断；click 仍保留给键盘操作。
  document.addEventListener("pointerdown", triggerQuickSettingsModePreview, true);
  document.addEventListener("click", triggerQuickSettingsModePreview, true);
  quickSettingsPreview?.addEventListener("pointerdown", (event) => {
    if (!extendQuickSettingsModePreview()) return;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  let initialQuickSettingsMode = "compact";
  try { initialQuickSettingsMode = localStorage.getItem(quickSettingsModeKey) || "compact"; } catch (_) {}
  setQuickSettingsMode(initialQuickSettingsMode, false);
  window.addEventListener("reader-settings-changed", syncQuickMirrors);
  applyReaderSettingsVisibility();
}
