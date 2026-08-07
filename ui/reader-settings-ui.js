// 阅读设置状态与设置面板绑定
// 先于 reader.js 加载：提供 settings/applyShellTheme/initSettingsUI 给阅读页启动逻辑使用。

const readerSettingsT = (key, fallback, values) => window.ReaderI18n?.t?.(key, values) || fallback;

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
  pageMode: "single",
  flowMode: "paged",
  pageTurnEffect: "horizontal",
  pageTurnSpeed: 1,
  ttsSource: "edge",
  ttsRate: 1,
};

// Windows WebView2 的原生 switch transition 正常；仅 macOS WKWebView 需要补偿动画。
const READER_SHELL_IS_MAC_WEBKIT = /Macintosh|Mac OS X/.test(navigator.userAgent || "")
  && /AppleWebKit/.test(navigator.userAgent || "")
  && !/(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent || "");

// 外壳（工具栏/目录/设置）的深色应用
function applyShellTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
}

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem("readerSettings") || "{}"));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}
let settings = loadSettings();
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
  if (settings.flowMode === "scroll" && settings.pageMode !== "single") {
    settings.pageMode = "single";
    changed = true;
  }
  return changed;
}

function saveSettings() {
  normalizeModeSettings();
  localStorage.setItem("readerSettings", JSON.stringify(settings));
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
  saveSettings();
  pushSettings();
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
  const textConversionSimple = document.getElementById("set-text-conversion-simple");
  if (textConversionSimple) {
    textConversionSimple.checked = settings.textConversion !== "s2t";
    textConversionSimple.addEventListener("change", () => {
      settings.textConversion = textConversionSimple.checked ? "t2s" : "s2t";
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
  // 朗读设置
  const bindSel = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = settings[key];
    el.addEventListener("change", () => { settings[key] = el.value; onChange(); });
  };
  bindSel("set-ttssrc", "ttsSource");
  bindRange("set-ttsrate", "v-ttsrate", "ttsRate", (v) => v.toFixed(1) + "×");
}
