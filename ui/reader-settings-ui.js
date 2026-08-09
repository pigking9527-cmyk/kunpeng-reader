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
  applyToolbarVisibility() {
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
      });
      lastAppSettingsSyncPayload = JSON.stringify(normalizedAppSettingsSyncPayload());
      appSettingsSyncReady = true;
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
    // 这里的文字描述“按一下将切换到什么”，与简/繁开关保持同一交互语义。
    if (dualModeLabel) dualModeLabel.textContent = dualModeToggle?.checked
      ? readerSettingsT("singlePage", "单页")
      : readerSettingsT("twoPages", "双页");
    if (scrollModeLabel) scrollModeLabel.textContent = scrollModeToggle?.checked
      ? readerSettingsT("pagedMode", "整屏")
      : readerSettingsT("scrollMode", "滚动");
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
  applyReaderSettingsVisibility();
}
