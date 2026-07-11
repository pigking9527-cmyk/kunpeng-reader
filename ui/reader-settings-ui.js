// 阅读设置状态与设置面板绑定
// 先于 reader.js 加载：提供 settings/applyShellTheme/initSettingsUI 给阅读页启动逻辑使用。

const DEFAULTS = {
  theme: "light",
  fontFamily: "",
  styleMode: "local",
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
  pageTurnEffect: "off",
  pageTurnSpeed: 1,
  ttsSource: "edge",
  ttsVoice: "zh-CN-XiaoxiaoNeural",
  ttsRate: 1,
};

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

function normalizeModeSettings() {
  let changed = false;
  if (!["local", "book"].includes(settings.styleMode)) {
    settings.styleMode = DEFAULTS.styleMode;
    changed = true;
  }
  if (!["off", "google-paper", "curl"].includes(settings.pageTurnEffect)) {
    settings.pageTurnEffect = "off";
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
  if (frame.contentWindow) frame.contentWindow.postMessage({ settings }, "*");
}
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
  row.innerHTML = '<label>注释字号</label><input type="range" id="set-note-size" min="10" max="22" step="1" /><span class="val" id="v-note-size"></span>';
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
  font.value = settings.fontFamily;
  font.addEventListener("change", () => {
    settings.fontFamily = font.value;
    onChange();
  });
  const styleMode = document.getElementById("set-style-mode");
  if (styleMode) {
    styleMode.value = settings.styleMode;
    styleMode.addEventListener("change", () => {
      settings.styleMode = styleMode.value === "book" ? "book" : "local";
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
      onChange();
    });
  }
  const dualModeToggle = document.getElementById("set-dual-mode");
  const scrollModeToggle = document.getElementById("set-scroll-mode");
  function refreshReadingModeToggles() {
    normalizeModeSettings();
    if (dualModeToggle) {
      dualModeToggle.checked = settings.flowMode !== "scroll" && settings.pageMode === "dual";
      dualModeToggle.title = "开启双页";
    }
    if (scrollModeToggle) {
      scrollModeToggle.checked = settings.flowMode === "scroll";
      scrollModeToggle.title = "开启滚动模式";
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
      if (scrollModeToggle.checked) {
        settings.flowMode = "scroll";
        settings.pageMode = "single";
      } else {
        settings.flowMode = "paged";
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
  bindSel("set-ttsvoice", "ttsVoice");
  bindRange("set-ttsrate", "v-ttsrate", "ttsRate", (v) => v.toFixed(1) + "×");
}


