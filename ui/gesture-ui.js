// Shared gesture manager and main-window return routing.
(function (global) {
  "use strict";
  const root = global.document;
  const api = global.ReaderNewsGesture;
  const hintRules = global.ReaderGestureHintRules;
  if (!root || !api) return;

  const MANAGER_KEY = "kunpeng.reader.gesture-manager.v1";
  const MANAGER_ENABLED_KEY = "kunpeng.reader.gesture-manager.enabled.v1";
  const HINT_SETTINGS_KEY = "kunpeng.reader.gesture-hint.v1";
  const HINT_DURATION_MS = 1200;
  const DEFAULT_HINT_SETTINGS = Object.freeze({
    fontSize: 20,
    backgroundEnabled: true,
    background: "#173b6b",
    opacity: 60,
    positionX: 0.96,
    positionY: 0.04,
    frameWidth: 200,
    frameHeight: 60,
    frameShape: "rect",
    framePath: [],
  });
  const modal = root.getElementById("gesture-settings-modal");
  const managerCard = modal?.querySelector(".gesture-manager-card");
  const managerLayout = root.getElementById("gesture-manager-layout");
  const settingsToggle = root.getElementById("gesture-settings-toggle");
  const settingsContent = root.getElementById("gesture-settings-content");
  const globalPrecisionToggle = root.getElementById(
    "gesture-global-precision-toggle",
  );
  const globalPrecisionSettings = root.getElementById(
    "gesture-global-precision-settings",
  );
  const gear = root.getElementById("gesture-gear");
  const enabledInput = root.getElementById("set-gesture-enabled");
  const newButton = root.getElementById("gesture-new");
  const search = root.getElementById("gesture-search");

  const list = root.getElementById("gesture-list");
  const editor = root.getElementById("gesture-editor");
  const editorTitle = root.getElementById("gesture-editor-title");
  const editorClose = root.getElementById("gesture-editor-close");
  const editorOptions = root.getElementById("gesture-editor-options");
  const nameInput = root.getElementById("gesture-name");
  const actionChoice = root.getElementById("gesture-action-choice");
  const actionHint = root.getElementById("gesture-action-hint");
  const actionInput = root.getElementById("gesture-action");
  const actionOptions = root.getElementById("gesture-action-options");
  const actionSearch = root.getElementById("gesture-action-search");
  const actionEmpty = root.getElementById("gesture-action-empty");
  const inputInput = root.getElementById("gesture-input");
  const scopeInput = root.getElementById("gesture-scope");
  const scopeHint = root.getElementById("gesture-scope-hint");
  const precision = root.getElementById("gesture-precision");
  const precisionValue = root.getElementById("gesture-precision-value");
  const globalPrecisionInput = root.getElementById("gesture-global-precision");
  const globalPrecisionValue = root.getElementById(
    "gesture-global-precision-value",
  );
  const precisionGlobalMode = root.getElementById("gesture-precision-global");
  const precisionIndependentMode = root.getElementById(
    "gesture-precision-independent",
  );
  const precisionGlobalHint = root.getElementById(
    "gesture-precision-global-hint",
  );
  const hintEnabled = root.getElementById("gesture-hint-enabled");
  const hintSettingsToggle = root.getElementById(
    "gesture-hint-settings-toggle",
  );
  const hintSettingsPanel = root.getElementById("gesture-hint-settings");
  const hintFontSize = root.getElementById("gesture-hint-font-size");
  const hintFontSizeValue = root.getElementById("gesture-hint-font-size-value");
  const hintBackgroundEnabled = root.getElementById(
    "gesture-hint-background-enabled",
  );
  const hintBackground = root.getElementById("gesture-hint-background");
  const hintBackgroundState = root.getElementById(
    "gesture-hint-background-state",
  );
  const hintBackgroundReset = root.getElementById(
    "gesture-hint-background-reset",
  );
  const hintBackgroundPresets = root.getElementById(
    "gesture-hint-background-presets",
  );
  const hintColorPickerToggle = root.getElementById(
    "gesture-hint-color-picker-toggle",
  );
  const hintQuickColorAdd = root.getElementById("gesture-hint-quick-color-add");
  const hintOpacity = root.getElementById("gesture-hint-opacity");
  const hintOpacityValue = root.getElementById("gesture-hint-opacity-value");
  const hintShapeTools = root.getElementById("gesture-hint-shape-tools");
  const hintShapeRect = root.getElementById("gesture-hint-shape-rect");
  const hintShapeFreeform = root.getElementById("gesture-hint-shape-freeform");
  const hintPreviewPath = root.getElementById("gesture-hint-preview-path");
  const hintPreviewPathRect = hintPreviewPath?.querySelector("rect");
  const hintPreviewPathLine = hintPreviewPath?.querySelector("polyline");
  const hintPreview = root.getElementById("gesture-hint-preview-text");
  const hintPreviewArea = hintPreview?.parentElement;
  const pad = root.getElementById("gesture-pad");
  const save = root.getElementById("gesture-save");
  const clear = root.getElementById("gesture-clear");
  const status = root.getElementById("gesture-status");
  const trail = root.getElementById("newsnow-gesture-trail");
  const infoModal = root.getElementById("gesture-info-modal");
  const infoTitle = root.getElementById("gesture-info-title");
  const infoBody = root.getElementById("gesture-info-body");
  const infoClose = root.getElementById("gesture-info-close");
  if (
    !modal ||
    !managerCard ||
    !managerLayout ||
    !settingsToggle ||
    !settingsContent ||
    !globalPrecisionToggle ||
    !globalPrecisionSettings ||
    !gear ||
    !enabledInput ||
    !newButton ||
    !search ||
    !list ||
    !editor ||
    !editorTitle ||
    !editorClose ||
    !editorOptions ||
    !nameInput ||
    !actionChoice ||
    !actionHint ||
    !actionInput ||
    !actionOptions ||
    !actionSearch ||
    !actionEmpty ||
    !inputInput ||
    !scopeInput ||
    !scopeHint ||
    !precision ||
    !precisionValue ||
    !globalPrecisionInput ||
    !globalPrecisionValue ||
    !precisionGlobalMode ||
    !precisionIndependentMode ||
    !precisionGlobalHint ||
    !hintEnabled ||
    !hintSettingsToggle ||
    !hintSettingsPanel ||
    !hintFontSize ||
    !hintFontSizeValue ||
    !hintBackgroundEnabled ||
    !hintBackground ||
    !hintBackgroundState ||
    !hintBackgroundReset ||
    !hintBackgroundPresets ||
    !hintColorPickerToggle ||
    !hintQuickColorAdd ||
    !hintOpacity ||
    !hintOpacityValue ||
    !hintShapeTools ||
    !hintShapeRect ||
    !hintShapeFreeform ||
    !hintPreviewPath ||
    !hintPreviewPathRect ||
    !hintPreviewPathLine ||
    !hintPreview ||
    !hintPreviewArea ||
    !pad ||
    !save ||
    !clear ||
    !status ||
    !trail
  )
    return;

  const storedManager = readStoredManager();
  let enabled = loadManagerEnabled();
  let globalPrecision =
    storedManager.globalPrecision || api.loadPrecision(global.localStorage);
  let hintSettings = loadHintSettings();
  let settingsOpen = false;
  let globalPrecisionSettingsOpen = false;
  let hintSettingsOpen = false;
  let selectedQuickColorId = null;
  let hoveredQuickColorId = null;
  let hintColorPickerOpen = false;
  let profiles = loadProfiles(storedManager.profiles);
  const appSettingsInvoke = global.__TAURI__?.core?.invoke;
  const appSettingsEventApi = global.__TAURI__?.event;
  let appSettingsSyncReady = false;
  let appSettingsSyncTimer = 0;
  let lastAppSettingsSyncPayload = "";

  let editing = null;
  let training = [];
  let trainingPointerId = null;
  let trainingMouseActive = false;
  let active = null;
  let suppressContextMenuUntil = 0;
  let hintTimer = 0;
  let hintPreviewPointerId = null;
  let hintFrameStart = null;
  let hintFrameDraft = null;
  let hintDrawingFrame = false;
  let hintFreeformPoints = [];
  const hint = createHint();

  function makeId() {
    return (
      "gesture-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 8)
    );
  }
  function cleanNormalized(points) {
    const list = api.cleanPoints(points);
    return list.length === api.SAMPLE_COUNT ? list : [];
  }
  function normalizeAction(value) {
    if (value === "book_info") return "book_info";
    // Keep existing synced and local profiles usable after the two former
    // recovery actions became one chronological undo action.
    if (
      value === "undo_last" ||
      value === "reopen_last" ||
      value === "restore_jump"
    )
      return "undo_last";
    return "back";
  }
  function actionSupportedScopes() {
    return ["main", "reader"];
  }
  function normalizeScope(action, value) {
    const scopes = actionSupportedScopes(action);
    if (scopes.length === 1) return scopes[0];
    return value === "main" || value === "reader" || value === "auto"
      ? value
      : "auto";
  }
  function normalizeProfile(value, index) {
    const source = value && typeof value === "object" ? value : {};
    const action = normalizeAction(source.action);
    const savedName =
      typeof source.name === "string" ? source.name.trim().slice(0, 24) : "";
    const legacyUndoName = ["重新打开上一个页面", "恢复跳转前位置"].includes(
      savedName,
    );

    return {
      id:
        typeof source.id === "string" && source.id
          ? source.id
          : "gesture-" + index,
      name:
        savedName && !(action === "undo_last" && legacyUndoName)
          ? savedName
          : actionLabel(action),
      scope: normalizeScope(action, source.scope),
      action,
      input: "mouse-right",
      enabled: source.enabled !== false,
      points: cleanNormalized(source.points),
      precisionMode:
        source.precisionMode === "global" ? "global" : "independent",
      precision: api.normalizePrecision(source.precision),
    };
  }
  function readStoredManager() {
    try {
      const raw = global.localStorage?.getItem?.(MANAGER_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return {
        profiles: Array.isArray(parsed?.profiles)
          ? parsed.profiles.map(normalizeProfile).slice(0, 24)
          : [],
        globalPrecision:
          typeof parsed?.globalPrecision === "string"
            ? api.normalizePrecision(parsed.globalPrecision)
            : null,
      };
    } catch (_) {
      return { profiles: [], globalPrecision: null };
    }
  }
  function loadManagerEnabled() {
    try {
      const stored = global.localStorage?.getItem?.(MANAGER_ENABLED_KEY);
      if (stored === "true" || stored === "1") return true;
      if (stored === "false" || stored === "0") return false;
    } catch (_) {
      /* default remains enabled */
    }
    return true;
  }
  function saveManagerEnabled(value) {
    const next = Boolean(value);
    try {
      global.localStorage?.setItem?.(
        MANAGER_ENABLED_KEY,
        next ? "true" : "false",
      );
    } catch (_) {
      /* local preference */
    }
    return next;
  }
  function loadProfiles(saved) {
    if (saved.length) return saved;
    return [
      {
        id: "legacy-back",
        name: "返回／关闭当前页",
        scope: "auto",
        action: "back",
        input: "mouse-right",
        enabled: true,
        points: api.load(global.localStorage),
        precisionMode: "independent",
        precision: api.loadPrecision(global.localStorage),
      },
    ];
  }
  function saveProfiles() {
    try {
      global.localStorage?.setItem?.(
        MANAGER_KEY,
        JSON.stringify({ version: 4, globalPrecision, profiles }),
      );
    } catch (_) {
      /* local preference */
    }
    syncLegacyGesture();
    publish();
  }
  function effectivePrecision(profile) {
    return profile?.precisionMode === "global"
      ? globalPrecision
      : api.normalizePrecision(profile?.precision);
  }
  function compatibleProfile() {
    const usable = profiles.filter(
      (profile) =>
        profile.enabled &&
        profile.action === "back" &&
        profile.scope !== "main" &&
        profile.points.length,
    );
    return (
      usable.find((profile) => profile.scope === "reader") ||
      usable.find((profile) => profile.scope === "auto") ||
      usable[0] ||
      null
    );
  }
  function syncLegacyGesture() {
    const selected = compatibleProfile();
    try {
      if (selected)
        global.localStorage?.setItem?.(
          api.STORAGE_KEY,
          JSON.stringify({ version: 1, points: selected.points }),
        );
      else api.clear(global.localStorage);
    } catch (_) {
      /* local preference */
    }
    api.saveEnabled(Boolean(enabled && selected), global.localStorage);
    if (selected)
      api.savePrecision(effectivePrecision(selected), global.localStorage);
  }
  function publish() {
    const legacy = compatibleProfile();
    const detail = {
      enabled: Boolean(enabled && legacy),
      precision: legacy ? effectivePrecision(legacy) : globalPrecision,
      hasPath: Boolean(legacy?.points.length),
      profiles: profiles.length,
    };
    global.dispatchEvent(
      new CustomEvent("reader-gesture-settings-changed", { detail }),
    );
    const sharedSettings = {
      ...detail,
      globalPrecision,
      profiles: profiles.map((profile) => ({
        ...profile,
        points: profile.points.slice(),
      })),
      hintSettings: { ...hintSettings },
    };
    const invoke = global.__TAURI__?.core?.invoke;
    if (typeof invoke === "function")
      void Promise.resolve(
        invoke("reader_gesture_settings_save", { settings: sharedSettings }),
      ).catch(() => {});
    // Windows 的主窗口和阅读窗口分别使用 tauri.localhost / reader.localhost，
    // localStorage 不共享。将完整配置通过 Tauri 事件广播给已打开的阅读窗口，
    // 让“信息提取／说明”等非旧版返回手势也能参与匹配。
    const eventApi = global.__TAURI__?.event;
    if (typeof eventApi?.emit === "function") {
      void Promise.resolve(
        eventApi.emit("reader-gesture-settings", sharedSettings),
      ).catch(() => {});
    }
    queueAppSettingsSyncSave();
  }

  function hintHex(value) {
    if (typeof hintRules?.hintHex === "function") return hintRules.hintHex(value);
    return /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : DEFAULT_HINT_SETTINGS.background;
  }
  function normalizeHintQuickColors(value) {
    if (typeof hintRules?.normalizeQuickColors === "function")
      return hintRules.normalizeQuickColors(value, makeId);
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => {
        const color = String(item?.color || "").trim();
        if (!/^#[0-9a-f]{6}$/i.test(color)) return null;
        const name = String(item?.name || "快捷颜色")
          .trim()
          .slice(0, 12);
        return {
          id: String(item?.id || makeId()).slice(0, 80),
          name: name || "快捷颜色",
          color: color.toLowerCase(),
        };
      })
      .filter(Boolean)
      .slice(0, 6);
  }
  function hintPosition(value, fallback) {
    if (typeof hintRules?.hintPosition === "function")
      return hintRules.hintPosition(value, fallback);
    return Math.max(
      0,
      Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback),
    );
  }
  function normalizeHintSettings(value) {
    if (typeof hintRules?.normalizeHintSettings === "function")
      return hintRules.normalizeHintSettings(value, makeId);
    try {
      const saved = value && typeof value === "object" ? value : {};
      return {
        enabled: saved.enabled === true,
        fontSize: Math.max(
          12,
          Math.min(
            28,
            Number(saved.fontSize) || DEFAULT_HINT_SETTINGS.fontSize,
          ),
        ),
        backgroundEnabled:
          saved.backgroundEnabled !== false &&
          DEFAULT_HINT_SETTINGS.backgroundEnabled,
        background: hintHex(saved.background),
        opacity: Math.max(
          20,
          Math.min(100, Number(saved.opacity) || DEFAULT_HINT_SETTINGS.opacity),
        ),
        positionX: hintPosition(
          saved.positionX,
          DEFAULT_HINT_SETTINGS.positionX,
        ),
        positionY: hintPosition(
          saved.positionY,
          DEFAULT_HINT_SETTINGS.positionY,
        ),
        frameWidth: hintFrameSize(
          saved.frameWidth,
          DEFAULT_HINT_SETTINGS.frameWidth,
          96,
          520,
        ),
        frameHeight: hintFrameSize(
          saved.frameHeight,
          DEFAULT_HINT_SETTINGS.frameHeight,
          40,
          240,
        ),
        frameShape: normalizeHintFrameShape(saved.frameShape),
        framePath: normalizeHintFramePath(saved.framePath),
        quickColors: normalizeHintQuickColors(saved.quickColors),
      };
    } catch (_) {
      return {
        enabled: false,
        ...DEFAULT_HINT_SETTINGS,
        quickColors: [],
      };
    }
  }
  function loadHintSettings() {
    try {
      return normalizeHintSettings(
        JSON.parse(global.localStorage?.getItem?.(HINT_SETTINGS_KEY) || "{}"),
      );
    } catch (_) {
      return normalizeHintSettings({});
    }
  }

  function normalizedGestureSettingsSyncPayload() {
    return {
      version: 1,
      enabled: Boolean(enabled),
      globalPrecision: api.normalizePrecision(globalPrecision),
      // Older v1 payloads used an empty array both for "never configured" and
      // "clear all". New writes make an empty list an explicit deletion.
      profilesInitialized: true,
      profiles: profiles
        .map((profile, index) => normalizeProfile(profile, index))
        .filter((profile) => profile.points.length === api.SAMPLE_COUNT)
        .map((profile) => ({
          ...profile,
          points: profile.points.map((point) => ({ x: point.x, y: point.y })),
        })),
      hintSettings: normalizeHintSettings(hintSettings),
    };
  }

  function hasRecordedProfile(items = profiles) {
    return items.some(
      (profile) => profile?.points?.length === api.SAMPLE_COUNT,
    );
  }

  function isLegacyUnconfiguredEmptyGestureSettings(value) {
    return (
      value?.profilesInitialized !== true &&
      Array.isArray(value?.profiles) &&
      value.profiles.length === 0
    );
  }

  function queueAppSettingsSyncSave() {
    if (!appSettingsSyncReady || typeof appSettingsInvoke !== "function")
      return;
    const request = { gestureSettings: normalizedGestureSettingsSyncPayload() };
    const serialized = JSON.stringify(request);
    if (serialized === lastAppSettingsSyncPayload) return;
    if (appSettingsSyncTimer) global.clearTimeout(appSettingsSyncTimer);
    appSettingsSyncTimer = global.setTimeout(async () => {
      appSettingsSyncTimer = 0;
      try {
        await appSettingsInvoke("app_settings_sync_save", { request });
        lastAppSettingsSyncPayload = serialized;
      } catch (_) {
        // 离线时保留本机配置；下次修改或重新打开会重试。
      }
    }, 220);
  }

  function applySyncedGestureSettings(value) {
    const source = value && typeof value === "object" ? value : {};
    enabled = Boolean(source.enabled);
    globalPrecision = api.normalizePrecision(source.globalPrecision);
    profiles = (Array.isArray(source.profiles) ? source.profiles : [])
      .map(normalizeProfile)
      .filter((profile) => profile.points.length === api.SAMPLE_COUNT)
      .slice(0, 24);
    hintSettings = normalizeHintSettings(source.hintSettings);
    try {
      global.localStorage?.setItem?.(
        MANAGER_KEY,
        JSON.stringify({ version: 4, globalPrecision, profiles }),
      );
    } catch (_) {
      /* local preference */
    }
    saveManagerEnabled(enabled);
    try {
      global.localStorage?.setItem?.(
        HINT_SETTINGS_KEY,
        JSON.stringify(hintSettings),
      );
    } catch (_) {
      /* local preference */
    }
    syncLegacyGesture();
    syncControls();
    renderList();
    applyHintSettings();
    publish();
  }

  async function hydrateAppSettingsSync() {
    if (typeof appSettingsInvoke !== "function") {
      appSettingsSyncReady = true;
      return;
    }
    try {
      const remote = await appSettingsInvoke("app_settings_sync_get");
      if (remote?.hasGestureSettings && remote?.gestureSettings) {
        if (
          isLegacyUnconfiguredEmptyGestureSettings(remote.gestureSettings) &&
          hasRecordedProfile()
        ) {
          // A pre-marker empty cloud payload may have been produced by a fresh
          // installation before its first pull. Do not erase a recorded local
          // gesture; write it back with the explicit marker on the next sync.
          lastAppSettingsSyncPayload = "";
          appSettingsSyncReady = true;
          queueAppSettingsSyncSave();
          return;
        }
        appSettingsSyncReady = false;
        applySyncedGestureSettings(remote.gestureSettings);
        lastAppSettingsSyncPayload = JSON.stringify({
          gestureSettings: normalizedGestureSettingsSyncPayload(),
        });
      } else if (remote?.hasGestureSettings) {
        // 目标端已存有当前客户端不认识的手势版本时，只保留云端原值，不能以本机默认值覆盖它。
        appSettingsSyncReady = true;
        return;
      } else {
        lastAppSettingsSyncPayload = "";
      }
    } catch (_) {
      // 本机配置仍可正常使用，连接恢复后由后续修改写回。
    }
    appSettingsSyncReady = true;
    queueAppSettingsSyncSave();
  }
  function hintBackgroundColor() {
    if (!hintSettings.backgroundEnabled) return "transparent";
    const hex = hintSettings.background.slice(1);
    const rgb = [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    );
    return "rgba(" + rgb.join(",") + "," + hintSettings.opacity / 100 + ")";
  }
  function createHint() {
    const node = root.createElement("div");
    node.className = "reader-gesture-hint";
    node.dataset.overlaySurface = "gesture-hint";
    node.dataset.overlayRole = "feedback";
    node.hidden = true;
    root.body?.appendChild(node);
    return node;
  }
  function placeHintInViewport(node, settings) {
    const maxLeft = Math.max(0, global.innerWidth - node.offsetWidth);
    const maxTop = Math.max(0, global.innerHeight - node.offsetHeight);
    node.style.left = Math.round(maxLeft * settings.positionX) + "px";
    node.style.top = Math.round(maxTop * settings.positionY) + "px";
    node.style.right = "auto";
  }
  function placeHintPreview() {
    const maxLeft = Math.max(
      0,
      hintPreviewArea.clientWidth - hintPreview.offsetWidth,
    );
    const maxTop = Math.max(
      0,
      hintPreviewArea.clientHeight - hintPreview.offsetHeight,
    );
    hintPreview.style.left =
      Math.round(maxLeft * hintSettings.positionX) + "px";
    hintPreview.style.top = Math.round(maxTop * hintSettings.positionY) + "px";
  }
  function applySettingsDisclosure() {
    settingsToggle.setAttribute("aria-expanded", String(settingsOpen));
    settingsContent.hidden = !settingsOpen;
    globalPrecisionToggle.setAttribute(
      "aria-expanded",
      String(globalPrecisionSettingsOpen),
    );
    globalPrecisionSettings.hidden = !globalPrecisionSettingsOpen;
  }
  function normalizeHintFrameShape(value) {
    if (typeof hintRules?.normalizeHintFrameShape === "function")
      return hintRules.normalizeHintFrameShape(value);
    return value === "freeform" ? "freeform" : "rect";
  }
  function normalizeHintFramePath(value) {
    if (typeof hintRules?.normalizeHintFramePath === "function")
      return hintRules.normalizeHintFramePath(value);
    if (!Array.isArray(value)) return [];
    return value
      .map((point) => ({ x: Number(point?.x), y: Number(point?.y) }))
      .filter(
        (point) =>
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x >= 0 &&
          point.x <= 100 &&
          point.y >= 0 &&
          point.y <= 100,
      )
      .slice(0, 48);
  }
  function hintFrameClipPath(settings) {
    if (typeof hintRules?.hintFrameClipPath === "function")
      return hintRules.hintFrameClipPath(settings);
    if (settings.frameShape !== "freeform" || settings.framePath.length < 3)
      return "none";
    return `polygon(${settings.framePath.map((point) => `${point.x}% ${point.y}%`).join(",")})`;
  }
  function hintFrameSize(value, fallback, minimum, maximum) {
    if (typeof hintRules?.hintFrameSize === "function")
      return hintRules.hintFrameSize(value, fallback, minimum, maximum);
    return Math.max(
      minimum,
      Math.min(
        maximum,
        Number.isFinite(Number(value)) ? Number(value) : fallback,
      ),
    );
  }
  function renderHintBackgroundPresets() {
    hintBackgroundPresets.replaceChildren();
    const addPreset = (item, removable = false) => {
      const group = root.createElement("span");
      group.className = "gesture-hint-color-chip";
      if (removable) group.dataset.gestureHintQuickColor = item.id;
      const button = root.createElement("button");
      button.className = "gesture-hint-background-preset";
      button.type = "button";
      button.dataset.gestureHintBackground = item.color;
      button.style.setProperty("--gesture-hint-swatch", item.color);
      const selected = item.color === hintSettings.background;
      button.setAttribute(
        "aria-label",
        removable ? "应用快捷背景色" : "应用海蓝背景色",
      );
      button.setAttribute("aria-pressed", String(selected));
      group.append(button);
      if (removable) {
        const bridge = root.createElement("span");
        bridge.className = "gesture-hint-quick-color-bridge";
        bridge.setAttribute("aria-hidden", "true");
        const remove = root.createElement("button");
        remove.className = "gesture-hint-quick-color-remove";
        remove.type = "button";
        remove.dataset.gestureHintQuickColorRemove = item.id;
        remove.setAttribute("aria-label", "删除此快捷背景色");
        remove.textContent = "×";
        remove.hidden =
          selectedQuickColorId !== item.id || hoveredQuickColorId !== item.id;
        group.append(bridge);
        group.append(remove);
      }
      hintBackgroundPresets.append(group);
    };
    addPreset({ color: DEFAULT_HINT_SETTINGS.background });
    hintSettings.quickColors.forEach((item) => addPreset(item, true));
  }
  function applyHintSettings() {
    hintEnabled.checked = Boolean(hintSettings.enabled);
    hintSettingsToggle.setAttribute("aria-expanded", String(hintSettingsOpen));
    hintSettingsPanel.hidden = !hintSettingsOpen;
    hintFontSize.value = String(hintSettings.fontSize);
    hintFontSizeValue.textContent = hintSettings.fontSize + "px";
    hintBackgroundEnabled.setAttribute(
      "aria-checked",
      String(Boolean(hintSettings.backgroundEnabled)),
    );
    hintBackgroundEnabled.classList.toggle(
      "is-on",
      Boolean(hintSettings.backgroundEnabled),
    );
    hintBackgroundState.textContent = "背景";
    hintBackground.value = hintSettings.background;
    hintColorPickerToggle.style.setProperty(
      "--gesture-hint-swatch",
      hintSettings.background,
    );
    hintColorPickerToggle.setAttribute(
      "aria-expanded",
      String(hintColorPickerOpen),
    );
    hintQuickColorAdd.hidden = !hintColorPickerOpen;
    hintShapeTools.hidden = !hintSettings.backgroundEnabled;
    hintShapeRect.setAttribute(
      "aria-pressed",
      String(hintSettings.frameShape === "rect"),
    );
    hintShapeFreeform.setAttribute(
      "aria-pressed",
      String(hintSettings.frameShape === "freeform"),
    );
    renderHintBackgroundPresets();
    hintOpacity.value = String(hintSettings.opacity);
    hintOpacityValue.textContent = hintSettings.opacity + "%";
    const background = hintBackgroundColor();
    [hintPreview, hint].forEach((node) => {
      node.style.fontSize = hintSettings.fontSize + "px";
      node.style.background = background;
      node.style.width = Math.round(hintSettings.frameWidth) + "px";
      node.style.minHeight = Math.round(hintSettings.frameHeight) + "px";
      node.style.clipPath = hintFrameClipPath(hintSettings);
    });
    hintPreview.hidden = !hintSettings.backgroundEnabled || hintDrawingFrame;
    global.requestAnimationFrame(() => {
      if (hintSettings.backgroundEnabled) placeHintPreview();
      placeHintInViewport(hint, hintSettings);
    });
    if (!hintSettings.enabled) {
      hint.hidden = true;
      hint.removeAttribute("data-overlay-active");
    }
  }
  function collapseNewGestureDisclosures() {
    settingsOpen = false;
    globalPrecisionSettingsOpen = false;
    hintSettingsOpen = false;
    globalPrecisionSettings.hidden = true;
    hintSettingsPanel.hidden = true;
    applySettingsDisclosure();
    applyHintSettings();
  }
  function saveHintSettings() {
    try {
      global.localStorage?.setItem?.(
        HINT_SETTINGS_KEY,
        JSON.stringify(hintSettings),
      );
    } catch (_) {
      /* local preference */
    }
    applyHintSettings();
    publish();
  }
  function showHint(name) {
    if (!hintSettings.enabled) return;
    hint.textContent = name || "手势已匹配";
    hint.dataset.overlayActive = "true";
    hint.hidden = false;
    placeHintInViewport(hint, hintSettings);
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = global.setTimeout(() => {
      hint.hidden = true;
      hint.removeAttribute("data-overlay-active");
    }, HINT_DURATION_MS);
  }
  function gestureInfoForTarget(target) {
    const owner = target?.closest?.("[data-gesture-info]");
    const body = String(owner?.dataset?.gestureInfo || "")
      .trim()
      .slice(0, 2000);
    if (!body) return null;
    const title =
      String(
        owner.dataset.gestureInfoTitle ||
          owner.getAttribute("aria-label") ||
          "信息／说明",
      )
        .trim()
        .slice(0, 80) || "信息／说明";
    return { title, body };
  }
  function openGestureInfo(info) {
    if (!infoModal || !infoTitle || !infoBody || !info?.body) return false;
    infoTitle.textContent = info.title || "信息／说明";
    infoBody.textContent = info.body;
    infoModal.classList.add("show");
    return true;
  }
  function closeGestureInfo() {
    infoModal?.classList.remove("show");
  }
  function withGestureInfo(target, surface) {
    if (!surface || surface.allowedActions?.includes("book_info"))
      return surface;
    const info = gestureInfoForTarget(target);
    if (!info) return surface;
    return {
      ...surface,
      allowedActions: surface.allowedActions.concat("book_info"),
      onMatch: (action) => {
        if (action === "book_info") {
          openGestureInfo(info);
          return;
        }
        surface.onMatch(action);
      },
    };
  }
  function actionLabel(value) {
    return (
      {
        back: "返回／关闭当前页",
        book_info: "信息提取／说明",
        undo_last: "撤销上一步",
      }[value] || "返回／关闭当前页"
    );
  }
  function scopeLabel(value) {
    return (
      { auto: "自动适用", main: "仅主窗口", reader: "仅阅读页" }[value] ||
      "自动适用"
    );
  }
  function syncScopeChoices(action) {
    const scopes = actionSupportedScopes(action);
    const current = normalizeScope(action, scopeInput.value);
    scopeInput.textContent = "";
    if (scopes.length > 1) {
      const automatic = root.createElement("option");
      automatic.value = "auto";
      automatic.textContent = "自动适用（推荐）";
      scopeInput.append(automatic);
    }
    scopes.forEach((scope) => {
      const option = root.createElement("option");
      option.value = scope;
      option.textContent = scopeLabel(scope);
      scopeInput.append(option);
    });
    scopeInput.value = current;
    scopeInput.disabled = scopes.length === 1;
    scopeHint.textContent =
      scopes.length === 1
        ? "此操作目前只支持阅读页，不能设为主窗口。"
        : "自动适用会在该操作支持的页面执行；不支持该操作的页面不会触发。";
  }

  function filterActionOptions() {
    const query = actionSearch.value.trim().toLocaleLowerCase();
    let visible = 0;
    actionOptions
      .querySelectorAll("[data-gesture-action]")
      .forEach((button) => {
        const match =
          !query || button.textContent.toLocaleLowerCase().includes(query);
        button.hidden = !match;
        if (match) visible += 1;
      });
    actionEmpty.hidden = visible > 0;
  }
  function syncEditorChoices() {
    const action = ["book_info", "undo_last"].includes(actionInput.value)
      ? actionInput.value
      : "back";
    actionInput.value = action;
    syncScopeChoices(action);
    filterActionOptions();
    actionOptions
      .querySelectorAll("[data-gesture-action]")
      .forEach((button) => {
        const selected = button.dataset.gestureAction === action;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-checked", String(selected));
      });
    actionHint.textContent =
      action === "book_info"
        ? "书架和阅读页打开图书信息；其它页面只在手势起点配置了说明、提示或使用技巧时显示，没有说明时不会执行。"
        : action === "undo_last"
          ? "按发生顺序撤销上一步：恢复最近关闭的窗口或页面；阅读页还会恢复最近跳转前的位置。普通翻页不进入历史。"
          : "手势会在所有页面参与匹配；当前页面支持返回或关闭时才会执行。";
  }
  function levelLabel(value) {
    return String(value);
  }
  function profileHasPath(profile) {
    return profile?.points?.length === api.SAMPLE_COUNT;
  }
  function setEnabled(next) {
    enabled = saveManagerEnabled(next);
    syncLegacyGesture();
    if (!enabled) clearTrail();
    syncControls();
    renderList();
    publish();
  }
  function syncControls() {
    enabledInput.checked = enabled;
    globalPrecisionInput.value = globalPrecision;
    globalPrecisionValue.textContent = levelLabel(globalPrecision);
    precisionGlobalHint.textContent = "（" + levelLabel(globalPrecision) + "）";
    applySettingsDisclosure();
  }
  function drawEditorPath() {
    if (!training.length && editing?.points?.length)
      training = editing.points.slice();
    api.draw(pad, training, {
      normalized:
        training.length === api.SAMPLE_COUNT &&
        training.every(
          (point) => Math.abs(point.x) <= 1.5 && Math.abs(point.y) <= 1.5,
        ),
      color: training.length ? "#3478d4" : "#a4afbd",
      lineWidth: 5,
    });
  }
  function renderList() {
    const query = search.value.trim().toLocaleLowerCase();
    list.textContent = "";
    const visible = profiles.filter((profile) => {
      const haystack = (
        profile.name +
        " " +
        actionLabel(profile.action) +
        " " +
        scopeLabel(profile.scope)
      ).toLocaleLowerCase();
      return !query || haystack.includes(query);
    });
    if (!visible.length) {
      const empty = root.createElement("p");
      empty.className = "gesture-list-empty";
      empty.textContent = "没有符合条件的手势。";
      list.append(empty);
      return;
    }
    visible.forEach((profile) => {
      const row = root.createElement("article");
      row.className =
        "gesture-list-row" + (profile.enabled ? "" : " is-disabled");
      const preview = root.createElement("canvas");
      preview.className = "gesture-list-preview";
      preview.width = 76;
      preview.height = 54;
      preview.setAttribute(
        "aria-label",
        profileHasPath(profile) ? profile.name + " 的轨迹预览" : "尚未录制轨迹",
      );
      const body = root.createElement("div");
      body.className = "gesture-list-body";
      const title = root.createElement("strong");
      title.textContent = profile.name;
      const meta = root.createElement("span");
      meta.textContent =
        scopeLabel(profile.scope) +
        " · " +
        actionLabel(profile.action) +
        " · " +
        (profile.precisionMode === "global"
          ? "全局精度 " + globalPrecision
          : "独立精度 " + profile.precision) +
        (profileHasPath(profile) ? "" : " · 未录制");
      body.append(title, meta);
      const actions = root.createElement("div");
      actions.className = "gesture-list-actions";
      const toggle = root.createElement("button");
      toggle.type = "button";
      toggle.className = "gesture-row-toggle";
      toggle.dataset.gestureToggle = profile.id;
      toggle.textContent = profile.enabled ? "已启用" : "已停用";
      toggle.setAttribute("aria-pressed", String(profile.enabled));
      const editButton = root.createElement("button");
      editButton.type = "button";
      editButton.className = "btn-plain";
      editButton.dataset.gestureEdit = profile.id;
      editButton.textContent = "编辑";
      const menu = root.createElement("button");
      menu.type = "button";
      menu.className = "btn-plain";
      menu.dataset.gestureDelete = profile.id;
      menu.textContent = "删除";
      actions.append(toggle, editButton, menu);
      row.append(preview, body, actions);
      list.append(row);
      api.draw(preview, profile.points, {
        normalized: true,
        color: profile.enabled ? "#3478d4" : "#a4afbd",
        lineWidth: 3,
      });
    });
  }
  function selectedProfile() {
    return profiles.find((profile) => profile.id === editing?.id) || null;
  }
  function openEditor(profile) {
    if (!profile) collapseNewGestureDisclosures();
    const source = profile
      ? { ...profile, points: profile.points.slice() }
      : {
          id: makeId(),
          name: "返回／关闭当前页",
          scope: "auto",
          action: "back",
          input: "mouse-right",
          enabled: true,
          points: [],
          precisionMode: "global",
          precision: globalPrecision,
        };
    editing = source;
    training = source.points.slice();
    editorTitle.textContent = profiles.some((item) => item.id === source.id)
      ? "编辑手势"
      : "新建手势";
    nameInput.value = source.name;

    actionInput.value = source.action;
    scopeInput.value = source.scope;
    actionSearch.value = "";
    syncEditorChoices();
    inputInput.value = source.input;
    precision.value = source.precision;
    precisionGlobalMode.checked = source.precisionMode === "global";
    precisionIndependentMode.checked = source.precisionMode !== "global";
    updateEditorPrecision();
    status.textContent = "";
    editor.hidden = false;
    actionChoice.hidden = false;
    editorOptions.hidden = false;
    managerCard.classList.add("is-editor-open");
    managerLayout.classList.add("is-editor-open");
    global.requestAnimationFrame(drawEditorPath);
  }
  function closeEditor() {
    training = [];
    editing = null;
    status.textContent = "";
    editor.hidden = true;
    actionChoice.hidden = true;
    editorOptions.hidden = true;
    managerCard.classList.remove("is-editor-open");
    managerLayout.classList.remove("is-editor-open");
  }
  function currentNormalizedPath() {
    const isNormalized =
      training.length === api.SAMPLE_COUNT &&
      training.every(
        (point) => Math.abs(point.x) <= 1.5 && Math.abs(point.y) <= 1.5,
      );
    return isNormalized ? cleanNormalized(training) : api.normalize(training);
  }
  function updateEditorPrecision() {
    precision.disabled = precisionGlobalMode.checked;
    precisionValue.textContent = levelLabel(
      precisionGlobalMode.checked ? globalPrecision : precision.value,
    );
  }
  function scopesOverlap(first, second) {
    return (
      first.scope === "auto" ||
      second.scope === "auto" ||
      first.scope === second.scope
    );
  }
  function conflictFor(profile) {
    return profiles.find(
      (other) =>
        other.id !== profile.id &&
        scopesOverlap(other, profile) &&
        profileHasPath(other) &&
        api.similarity(other.points, profile.points) >=
          api.matchThreshold(
            Math.max(
              Number(effectivePrecision(other)),
              Number(effectivePrecision(profile)),
            ),
          ),
    );
  }
  function profileBoundToAction(profile) {
    return profiles.find(
      (other) =>
        other.id !== profile.id &&
        other.action === profile.action &&
        profileHasPath(other),
    );
  }
  function saveEditor() {
    const points = currentNormalizedPath();
    if (!points.length) {
      status.textContent = "轨迹太短，请重新画。";
      return;
    }
    const next = normalizeProfile(
      {
        ...editing,
        name: nameInput.value,
        action: actionInput.value,
        input: inputInput.value,
        scope: scopeInput.value,
        precisionMode: precisionGlobalMode.checked ? "global" : "independent",
        precision: precision.value,
        points,
      },
      profiles.length,
    );
    const actionOwner = profileBoundToAction(next);
    if (actionOwner) {
      status.textContent =
        "功能“" +
        actionLabel(next.action) +
        "”已绑定手势“" +
        actionOwner.name +
        "”。一个功能只能保留一条手势；请编辑或删除原手势。";
      return;
    }
    const conflict = conflictFor(next);
    if (
      conflict &&
      !global.confirm(
        "这条轨迹与“" +
          conflict.name +
          "”相似度较高，可能触发错误功能。仍要保存吗？",
      )
    )
      return;
    const index = profiles.findIndex((profile) => profile.id === next.id);
    if (index >= 0) profiles.splice(index, 1, next);
    else profiles.push(next);
    saveProfiles();
    training = [];
    editing = next;
    api.draw(pad, []);
    renderList();
    status.textContent = conflict
      ? "已保存；画板已清除。请留意相似手势可能产生冲突。"
      : "手势已保存；画板已清除。";
  }
  function deleteProfile(id) {
    const profile = profiles.find((item) => item.id === id);
    if (
      !profile ||
      !global.confirm("删除“" + profile.name + "”吗？此操作不会影响其它手势。")
    )
      return;
    profiles = profiles.filter((item) => item.id !== id);
    if (!profiles.length)
      profiles = [
        {
          id: makeId(),
          name: "返回／关闭当前页",
          scope: "auto",
          action: "back",
          input: "mouse-right",
          enabled: false,
          points: [],
          precisionMode: "global",
          precision: globalPrecision,
        },
      ];
    saveProfiles();
    if (editing?.id === id) closeEditor();
    renderList();
  }
  const closedPages = [];
  function rememberClosedPage(name, reopen, key) {
    if (typeof reopen !== "function") return;
    closedPages.push({
      name: String(name || "上一个页面").slice(0, 48),
      reopen,
      key: String(key || name || "page"),
    });
    if (closedPages.length > 8) closedPages.splice(0, closedPages.length - 8);
  }
  function canUndoLast() {
    return closedPages.length > 0;
  }
  function supportedActions(actions) {
    return canUndoLast() ? actions.concat("undo_last") : actions.slice();
  }
  function runCloseOrUndo(action, name, close, reopen) {
    if (action === "undo_last") {
      const previous = closedPages.pop();
      previous?.reopen?.();
      return;
    }
    close();
  }
  function rememberClosedReader(bookId) {
    const id = String(bookId || "").trim();
    if (!/^\d+$/.test(id)) return;
    rememberClosedPage(
      "阅读页",
      () => {
        const invoke = global.__TAURI__?.core?.invoke;
        if (typeof invoke === "function")
          void Promise.resolve(invoke("open_book", { id })).catch(() => {});
      },
      "reader:" + id,
    );
  }
  function listenForClosedReader() {
    const listen = global.__TAURI__?.event?.listen;
    if (typeof listen !== "function") return;
    Promise.resolve(
      listen("reader-closed-for-reopen", (event) => {
        rememberClosedReader(event?.payload?.bookId);
      }),
    ).catch(() => {});
  }
  function mainSurfaceTitle(node) {
    const titles = {
      "update-bar": "更新说明",
      "library-ai-page": "书库问答",
      "newsnow-page": "资讯",
      "newsnow-reader": "资讯正文",
    };
    return (
      titles[node.id] ||
      node
        .querySelector?.(".modal-head span, .modal-head strong")
        ?.textContent?.trim() ||
      node.getAttribute?.("aria-label") ||
      "上一个页面"
    );
  }
  function reopenMainSurface(node) {
    if (!node?.isConnected) return;
    if (node.id === "update-bar") {
      global.ReaderAboutUI?.reopenUpdateCard?.();
      return;
    }
    if (node.id === "library-ai-page") {
      void global.ReaderLibraryAiEntry?.open?.();
      return;
    }
    if (node.id === "newsnow-page") {
      void global.ReaderNewsUI?.instance?.open?.();
      return;
    }
    node.hidden = false;
    node.classList.add("show");
  }
  function visibleMainSurfaces() {
    const visible = new Map();
    const add = (node) => {
      if (!node) return;
      const key = "main:" + node.id;
      visible.set(key, {
        name: mainSurfaceTitle(node),
        key,
        reopen: () => reopenMainSurface(node),
      });
    };
    root.querySelectorAll(".modal.show").forEach(add);
    const update = root.getElementById("update-bar");
    if (update?.classList.contains("show")) add(update);
    ["library-ai-page", "newsnow-page", "newsnow-reader"].forEach((id) => {
      const page = root.getElementById(id);
      if (page && !page.hidden) add(page);
    });
    return visible;
  }
  let knownMainSurfaces = new Map();
  function syncMainCloseHistory() {
    const next = visibleMainSurfaces();
    knownMainSurfaces.forEach((surface, key) => {
      if (!next.has(key))
        rememberClosedPage(surface.name, surface.reopen, surface.key);
    });
    knownMainSurfaces = next;
  }
  function listenForClosedMainSurfaces() {
    knownMainSurfaces = visibleMainSurfaces();
    const observer = new MutationObserver(() =>
      global.queueMicrotask(syncMainCloseHistory),
    );
    observer.observe(root.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "hidden"],
    });
  }
  function clearTrail() {
    active = null;
    trail.hidden = true;
    trail.removeAttribute("data-overlay-active");
    api.draw(trail, []);
    trail.classList.remove("matched", "rejected");
  }
  function paintTrail(points) {
    trail.dataset.overlayActive = "true";
    trail.hidden = false;
    api.draw(trail, points, { color: "#3478d4", lineWidth: 5 });
  }
  function mainWindowClose() {
    const invoke = global.__TAURI__?.core?.invoke;
    if (typeof invoke === "function")
      void Promise.resolve(invoke("main_window_close")).catch(() => {});
  }
  function fallbackSurface(target) {
    const modal = target?.closest?.(".modal.show");
    if (modal) {
      const title =
        modal.querySelector(".modal-head span")?.textContent?.trim() ||
        "当前窗口";
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            title,
            () => {
              const close = modal.querySelector("button[id$='-close']");
              if (close) close.click();
              else modal.classList.remove("show");
            },
            () => modal.classList.add("show"),
          ),
      };
    }
    return {
      allowedActions: supportedActions(["back"]),
      onMatch: (action) => {
        if (action === "undo_last") {
          runCloseOrUndo(action);
          return;
        }
        mainWindowClose();
      },
    };
  }
  function baseSurface(target) {
    const updateCard = root.getElementById("update-bar");
    if (updateCard?.classList.contains("show") && updateCard.contains(target)) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "更新说明",
            () => global.ReaderAboutUI?.hideUpdateCard?.(),
            () => global.ReaderAboutUI?.reopenUpdateCard?.(),
          ),
      };
    }
    const gestureSettings = root.getElementById("gesture-settings-modal");
    if (
      gestureSettings?.classList.contains("show") &&
      gestureSettings.contains(target)
    ) {
      // The canvas reserves only left-button input for drawing; right-button
      // gestures remain available there and throughout every page. Back keeps
      // navigation inside the gesture settings: the editor returns to its
      // overview, while the overview closes this modal.
      if (!editor.hidden && editor.contains(target)) {
        return {
          allowedActions: supportedActions(["back"]),
          onMatch: (action) => {
            if (action === "undo_last") {
              runCloseOrUndo(action);
              return;
            }
            closeEditor();
          },
        };
      }
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(action, "手势设置", closeSettings, openSettings),
      };
    }
    const commonSettings = root.getElementById("fp-settings-modal");
    if (
      commonSettings?.classList.contains("show") &&
      commonSettings.contains(target)
    ) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "设置",
            () => commonSettings.classList.remove("show"),
            () => commonSettings.classList.add("show"),
          ),
      };
    }
    const statsModal = root.getElementById("stats-modal");
    if (statsModal?.classList.contains("show") && statsModal.contains(target)) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "阅读统计",
            () => global.ReaderStatsUI?.close?.(),
            () => statsModal.classList.add("show"),
          ),
      };
    }
    const bookInfo = root.getElementById("book-info-modal");
    if (bookInfo?.classList.contains("show") && bookInfo.contains(target)) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "图书信息",
            () => bookInfo.classList.remove("show"),
            () => bookInfo.classList.add("show"),
          ),
      };
    }
    const bookOrganization = root.getElementById("book-organization-modal");
    if (
      bookOrganization?.classList.contains("show") &&
      bookOrganization.contains(target)
    ) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "标签与收藏书单",
            () => root.getElementById("book-organization-close")?.click(),
            () => {
              root.getElementById("book-info-modal")?.classList.remove("show");
              bookOrganization.classList.add("show");
            },
          ),
      };
    }
    const booklist = root.getElementById("booklist-modal");
    if (booklist?.classList.contains("show") && booklist.contains(target)) {
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "书单",
            () => root.getElementById("booklist-close")?.click(),
            () => booklist.classList.add("show"),
          ),
      };
    }
    if (target?.closest?.(".modal")) return fallbackSurface(target);
    const news = global.ReaderNewsUI?.instance;
    const newsSurface = news?.gestureSurface?.();
    if (newsSurface?.contains(target))
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "资讯",
            () => news.gestureBack?.(),
            () => {
              void news.open?.();
            },
          ),
      };
    const library = root.getElementById("library-ai-page");
    if (library && !library.hidden && library.contains(target))
      return {
        allowedActions: supportedActions(["back"]),
        onMatch: (action) =>
          runCloseOrUndo(
            action,
            "书库问答",
            () => global.ReaderLibraryAiEntry?.close?.({ focus: false }),
            () => {
              void global.ReaderLibraryAiEntry?.open?.();
            },
          ),
      };
    const shelf = root.querySelector(".content-shell");
    if (shelf && !shelf.hidden && shelf.contains(target)) {
      const cardBookId = String(
        target?.closest?.(".book[data-id]")?.dataset?.id || "",
      ).trim();
      const selectedBookIds = global.ReaderShelfUI?.getSelectedIds?.() || [];
      const selectedBookId =
        selectedBookIds.length === 1
          ? String(selectedBookIds[0] || "").trim()
          : "";
      const bookId = cardBookId || selectedBookId;
      return {
        allowedActions: supportedActions(
          bookId ? ["back", "book_info"] : ["back"],
        ),
        onMatch: (action) => {
          if (action === "undo_last") {
            runCloseOrUndo(action);
            return;
          }
          if (action === "book_info") {
            void global.ReaderBookInfo?.openById?.(bookId);
            return;
          }
          mainWindowClose();
        },
      };
    }
    return fallbackSurface(target);
  }
  function activeSurface(target) {
    if (!enabled) return null;
    return withGestureInfo(target, baseSurface(target));
  }
  function canApplyAction(surface, action) {
    return Boolean(surface?.allowedActions?.includes(action));
  }
  function matchProfile(surface, points) {
    const candidates = profiles.filter(
      (profile) =>
        profile.enabled &&
        profile.scope !== "reader" &&
        profileHasPath(profile) &&
        canApplyAction(surface, profile.action),
    );
    let best = null;
    candidates.forEach((profile) => {
      const score = api.similarity(profile.points, points);
      if (
        score >= api.matchThreshold(effectivePrecision(profile)) &&
        (!best || score > best.score)
      )
        best = { profile, score };
    });
    return best;
  }
  function previewProfile(surface, points) {
    let best = null;
    profiles.forEach((profile) => {
      if (
        !profile.enabled ||
        profile.scope === "reader" ||
        !profileHasPath(profile) ||
        !canApplyAction(surface, profile.action)
      )
        return;
      const score = api.prefixSimilarity(profile.points, points);
      if (
        score >=
          Math.max(0.7, api.matchThreshold(effectivePrecision(profile))) &&
        (!best || score > best.score)
      )
        best = { profile, score };
    });
    return best;
  }
  function begin(event) {
    if (event.button !== 2) return;
    const surface = activeSurface(event.target);
    if (!surface) return;
    // Cancelling pointerdown suppresses the compatibility mouse stream in
    // WebKit, which is precisely the fallback needed when later PointerEvents
    // are missing. The context menu is suppressed separately after the stroke.
    if (!event.type.startsWith("pointer")) event.preventDefault();
    active = {
      points: [{ x: event.clientX, y: event.clientY }],
      surface,
      previewProfileId: null,
    };
    paintTrail(active.points);
  }
  function previewMatch(gesture) {
    const matched = previewProfile(gesture.surface, gesture.points);
    if (!matched) {
      gesture.previewProfileId = null;
      return;
    }
    if (gesture.previewProfileId === matched.profile.id) return;
    gesture.previewProfileId = matched.profile.id;
    if (canApplyAction(gesture.surface, matched.profile.action))
      showHint(matched.profile.name);
  }
  function move(event) {
    if (!active) return;
    if (!event.type.startsWith("pointer")) event.preventDefault();
    const previous = active.points[active.points.length - 1];
    if (Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 4)
      return;
    active.points.push({ x: event.clientX, y: event.clientY });
    if (active.points.length > 160) active.points.splice(1, 1);
    paintTrail(active.points);
    previewMatch(active);
  }
  function finish(event, cancelled = false) {
    if (!active) return;
    const gesture = active;
    active = null;
    const matched = !cancelled && matchProfile(gesture.surface, gesture.points);
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clearTrail();
    if (matched && canApplyAction(gesture.surface, matched.profile.action)) {
      gesture.surface.onMatch(matched.profile.action);
    }
  }
  function cancelGestureKeepHint() {
    if (!active) return;
    const gesture = active;
    active = null;
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clearTrail();
  }
  function padPoint(event) {
    const rect = pad.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function beginTraining(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (trainingMouseActive) return;
    trainingMouseActive = true;
    training = [padPoint(event)];
    status.textContent = "正在记录轨迹（0px）…";
    api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
  }
  function appendTrainingPoints(event) {
    const coalesced = event.getCoalescedEvents?.();
    const samples = coalesced?.length ? [...coalesced, event] : [event];
    let appended = false;
    samples.forEach((sample) => {
      const point = padPoint(sample);
      const previous = training[training.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) < 3) return;
      training.push(point);
      appended = true;
    });
    return appended;
  }
  function moveTraining(event) {
    if (!trainingMouseActive) return;
    event.preventDefault();
    if (!appendTrainingPoints(event)) return;
    api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
    status.textContent =
      "正在记录轨迹（" + Math.round(api.pathLength(training)) + "px）…";
  }
  function finishTraining(event) {
    if (!trainingMouseActive) return;
    appendTrainingPoints(event);
    trainingMouseActive = false;
    // WebKit may deliver a quick stroke almost entirely at mouseup. Always
    // retain the release point before validating the minimum path length.
    const length = Math.round(api.pathLength(training));
    if (length < api.MIN_PATH_LENGTH) {
      training = [];
      api.draw(pad, training);
      status.textContent = "轨迹太短（" + length + "px），已清除，请重新画。";
      return;
    }
    status.textContent = "轨迹已画好（" + length + "px），点击“保存”生效。";
  }
  function cancelTraining(event) {
    if (trainingPointerId !== event.pointerId) return;
    trainingPointerId = null;
    status.textContent = "录制已取消，请重新画。";
  }
  function beginPointerTraining(event) {
    if (event.pointerType === "mouse") return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    trainingPointerId = event.pointerId;
    training = [padPoint(event)];
    try {
      pad.setPointerCapture(event.pointerId);
    } catch (_) {
      /* best effort */
    }
    status.textContent = "正在记录轨迹（0px）…";
    api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
  }
  function movePointerTraining(event) {
    if (event.pointerId !== trainingPointerId) return;
    event.preventDefault();
    if (!appendTrainingPoints(event)) return;
    api.draw(pad, training, { color: "#3478d4", lineWidth: 5 });
    status.textContent =
      "正在记录轨迹（" + Math.round(api.pathLength(training)) + "px）…";
  }
  function finishPointerTraining(event) {
    if (event.pointerId !== trainingPointerId) return;
    appendTrainingPoints(event);
    trainingPointerId = null;
    const length = Math.round(api.pathLength(training));
    status.textContent =
      length >= api.MIN_PATH_LENGTH
        ? "轨迹已画好（" + length + "px），点击“保存”生效。"
        : "轨迹太短（" + length + "px），请重新画。";
  }
  function openSettings() {
    search.value = "";
    closeEditor();
    modal.classList.add("show");
    syncControls();
    renderList();
  }
  function closeSettings() {
    closeEditor();
    modal.classList.remove("show");
  }

  gear.addEventListener("click", openSettings);
  settingsToggle.addEventListener("click", () => {
    settingsOpen = !settingsOpen;
    applySettingsDisclosure();
  });
  globalPrecisionToggle.addEventListener("click", () => {
    globalPrecisionSettingsOpen = !globalPrecisionSettingsOpen;
    applySettingsDisclosure();
  });
  newButton.addEventListener("click", () => {
    collapseNewGestureDisclosures();
    openEditor();
  });
  editorClose.addEventListener("click", () => {
    if (editor.hidden) closeSettings();
    else closeEditor();
  });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) closeSettings();
  });
  enabledInput.addEventListener("change", () =>
    setEnabled(enabledInput.checked),
  );
  globalPrecisionInput.addEventListener("input", () => {
    globalPrecision = api.normalizePrecision(globalPrecisionInput.value);
    syncControls();
    if (!editor.hidden) updateEditorPrecision();
    saveProfiles();
    renderList();
  });
  hintEnabled.addEventListener("change", () => {
    hintSettings.enabled = hintEnabled.checked;
    saveHintSettings();
  });
  hintSettingsToggle.addEventListener("click", () => {
    hintSettingsOpen = !hintSettingsOpen;
    applyHintSettings();
  });
  hintFontSize.addEventListener("input", () => {
    hintSettings.fontSize = Math.max(
      12,
      Math.min(
        28,
        Number(hintFontSize.value) || DEFAULT_HINT_SETTINGS.fontSize,
      ),
    );
    saveHintSettings();
  });
  hintBackgroundEnabled.addEventListener("click", () => {
    hintSettings.backgroundEnabled = !hintSettings.backgroundEnabled;
    saveHintSettings();
  });
  hintColorPickerToggle.addEventListener("click", () => {
    hintColorPickerOpen = true;
    applyHintSettings();
    hintBackground.click();
  });
  hintQuickColorAdd.addEventListener("click", () => {
    const color = hintHex(hintSettings.background);
    const existing = hintSettings.quickColors.find(
      (item) => item.color === color,
    );
    if (existing) {
      selectedQuickColorId = existing.id;
    } else if (hintSettings.quickColors.length < 6) {
      const item = { id: makeId(), name: "", color };
      hintSettings.quickColors = [...hintSettings.quickColors, item];
      selectedQuickColorId = item.id;
    }
    hintColorPickerOpen = false;
    saveHintSettings();
  });
  hintBackground.addEventListener("change", () => {
    const color = hintHex(hintBackground.value);
    hintSettings.background = color;
    hintSettings.backgroundEnabled = true;
    saveHintSettings();
  });
  root.addEventListener("pointerdown", (event) => {
    if (!hintColorPickerOpen) return;
    if (event.target.closest(".gesture-hint-color-picker")) return;
    hintColorPickerOpen = false;
    applyHintSettings();
  });
  hintBackgroundPresets.addEventListener("click", (event) => {
    const remove = event.target.closest(
      "[data-gesture-hint-quick-color-remove]",
    );
    if (remove) {
      hintSettings.quickColors = hintSettings.quickColors.filter(
        (item) => item.id !== remove.dataset.gestureHintQuickColorRemove,
      );
      hintSettings.background = DEFAULT_HINT_SETTINGS.background;
      selectedQuickColorId = null;
      saveHintSettings();
      return;
    }
    const preset = event.target.closest("[data-gesture-hint-background]");
    if (preset) {
      hintSettings.background = hintHex(preset.dataset.gestureHintBackground);
      selectedQuickColorId =
        hintSettings.quickColors.find(
          (item) => item.color === hintSettings.background,
        )?.id || null;
      hintSettings.backgroundEnabled = true;
      saveHintSettings();
    }
  });
  hintBackgroundPresets.addEventListener("pointerover", (event) => {
    const chip = event.target.closest("[data-gesture-hint-quick-color]");
    const id = chip?.dataset.gestureHintQuickColor;
    if (!id || hoveredQuickColorId === id) return;
    hoveredQuickColorId = id;
    const remove = chip.querySelector("[data-gesture-hint-quick-color-remove]");
    if (remove && selectedQuickColorId === id) remove.hidden = false;
  });
  hintBackgroundPresets.addEventListener("pointerout", (event) => {
    const chip = event.target.closest("[data-gesture-hint-quick-color]");
    const id = chip?.dataset.gestureHintQuickColor;
    if (!id || chip.contains(event.relatedTarget) || hoveredQuickColorId !== id)
      return;
    hoveredQuickColorId = null;
    selectedQuickColorId = null;
    const remove = chip.querySelector("[data-gesture-hint-quick-color-remove]");
    if (remove) remove.hidden = true;
  });
  hintBackgroundReset.addEventListener("click", () => {
    hintSettings = {
      ...hintSettings,
      ...DEFAULT_HINT_SETTINGS,
    };
    selectedQuickColorId = null;
    hintColorPickerOpen = false;
    saveHintSettings();
  });
  hintOpacity.addEventListener("input", () => {
    hintSettings.opacity = Math.max(
      20,
      Math.min(100, Number(hintOpacity.value) || DEFAULT_HINT_SETTINGS.opacity),
    );
    saveHintSettings();
  });
  function updateHintPreviewPosition(event) {
    const rect = hintPreviewArea.getBoundingClientRect();
    const maxLeft = Math.max(0, rect.width - hintPreview.offsetWidth);
    const maxTop = Math.max(0, rect.height - hintPreview.offsetHeight);
    const left = Math.max(
      0,
      Math.min(
        maxLeft,
        event.clientX - rect.left - hintPreview.offsetWidth / 2,
      ),
    );
    const top = Math.max(
      0,
      Math.min(maxTop, event.clientY - rect.top - hintPreview.offsetHeight / 2),
    );
    hintSettings.positionX = maxLeft ? left / maxLeft : 0;
    hintSettings.positionY = maxTop ? top / maxTop : 0;
    applyHintSettings();
  }
  function updateHintFrame(event) {
    if (!hintFrameStart) return;
    const rect = hintPreviewArea.getBoundingClientRect();
    const currentX = Math.max(
      0,
      Math.min(rect.width, event.clientX - rect.left),
    );
    const currentY = Math.max(
      0,
      Math.min(rect.height, event.clientY - rect.top),
    );
    hintFrameDraft = {
      left: hintFrameStart.x,
      top: hintFrameStart.y,
      width: Math.max(0, currentX - hintFrameStart.x),
      height: Math.max(0, currentY - hintFrameStart.y),
    };
    renderHintRectPreview();
  }
  function renderHintRectPreview() {
    if (!hintFrameDraft) return;
    const rect = hintPreviewArea.getBoundingClientRect();
    hintPreviewPath.style.removeProperty("display");
    hintPreviewPath.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    hintPreviewPathRect.setAttribute("x", String(hintFrameDraft.left));
    hintPreviewPathRect.setAttribute("y", String(hintFrameDraft.top));
    hintPreviewPathRect.setAttribute("width", String(hintFrameDraft.width));
    hintPreviewPathRect.setAttribute("height", String(hintFrameDraft.height));
    hintPreviewPathRect.hidden = false;
    hintPreviewPathLine.hidden = true;
    hintPreviewPath.hidden = false;
  }
  function commitHintFrame() {
    if (!hintFrameDraft) return;
    const rect = hintPreviewArea.getBoundingClientRect();
    const width = hintFrameSize(
      hintFrameDraft.width,
      DEFAULT_HINT_SETTINGS.frameWidth,
      96,
      Math.max(96, rect.width),
    );
    const height = hintFrameSize(
      hintFrameDraft.height,
      DEFAULT_HINT_SETTINGS.frameHeight,
      40,
      Math.max(40, rect.height),
    );
    const left = Math.max(0, Math.min(rect.width - width, hintFrameDraft.left));
    const top = Math.max(0, Math.min(rect.height - height, hintFrameDraft.top));
    hintSettings.frameWidth = width;
    hintSettings.frameHeight = height;
    hintSettings.positionX =
      rect.width > width ? left / (rect.width - width) : 0;
    hintSettings.positionY =
      rect.height > height ? top / (rect.height - height) : 0;
    hintSettings.frameShape = "rect";
    hintSettings.framePath = [];
  }
  function previewPoint(event) {
    const rect = hintPreviewArea.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
      y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    };
  }
  function renderHintFreeformPreview() {
    if (!hintFreeformPoints.length) {
      hintPreviewPath.hidden = true;
      return;
    }
    const rect = hintPreviewArea.getBoundingClientRect();
    hintPreviewPath.style.removeProperty("display");
    hintPreviewPath.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    hintPreviewPathLine.setAttribute(
      "points",
      hintFreeformPoints.map((point) => `${point.x},${point.y}`).join(" "),
    );
    hintPreviewPathRect.hidden = true;
    hintPreviewPathLine.hidden = false;
    hintPreviewPath.hidden = false;
  }
  function compactHintFreeformPoints(points, maximum) {
    if (typeof hintRules?.compactFreeformPoints === "function")
      return hintRules.compactFreeformPoints(points, maximum);
    if (points.length <= maximum) return points.slice();
    const last = points.length - 1;
    return Array.from(
      { length: maximum },
      (_, index) => points[Math.round((index * last) / (maximum - 1))],
    );
  }
  function updateHintFreeform(event) {
    const point = previewPoint(event);
    const previous = hintFreeformPoints.at(-1);
    if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 3)
      return;
    hintFreeformPoints.push(point);
    if (hintFreeformPoints.length > 320)
      hintFreeformPoints = compactHintFreeformPoints(hintFreeformPoints, 160);
    renderHintFreeformPreview();
  }
  function commitHintFreeform() {
    if (hintFreeformPoints.length < 3) return;
    const points = compactHintFreeformPoints(hintFreeformPoints, 48);
    const rect = hintPreviewArea.getBoundingClientRect();
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const padding = 6;
    const width = Math.min(
      rect.width,
      Math.max(96, Math.max(...xs) - Math.min(...xs) + padding * 2),
    );
    const height = Math.min(
      rect.height,
      Math.max(40, Math.max(...ys) - Math.min(...ys) + padding * 2),
    );
    const left = Math.max(
      0,
      Math.min(rect.width - width, Math.min(...xs) - padding),
    );
    const top = Math.max(
      0,
      Math.min(rect.height - height, Math.min(...ys) - padding),
    );
    hintSettings.frameWidth = width;
    hintSettings.frameHeight = height;
    hintSettings.positionX =
      rect.width > width ? left / (rect.width - width) : 0;
    hintSettings.positionY =
      rect.height > height ? top / (rect.height - height) : 0;
    hintSettings.frameShape = "freeform";
    hintSettings.framePath = points.map((point) => ({
      x: Math.round(((point.x - left) / width) * 1000) / 10,
      y: Math.round(((point.y - top) / height) * 1000) / 10,
    }));
    applyHintSettings();
  }
  function clearHintDraftPreview() {
    hintFrameDraft = null;
    hintPreviewPathLine.setAttribute("points", "");
    hintPreviewPathRect.setAttribute("x", "0");
    hintPreviewPathRect.setAttribute("y", "0");
    hintPreviewPathRect.setAttribute("width", "0");
    hintPreviewPathRect.setAttribute("height", "0");
    hintPreviewPathRect.hidden = true;
    hintPreviewPathLine.hidden = true;
    hintPreviewPath.hidden = true;
    hintPreviewPath.style.display = "none";
  }
  function cancelHintPreviewDrawing() {
    hintPreviewPointerId = null;
    hintDrawingFrame = false;
    hintFrameStart = null;
    hintFreeformPoints = [];
    clearHintDraftPreview();
    applyHintSettings();
  }
  function setHintFrameShape(shape) {
    hintSettings.frameShape = shape;
    if (shape === "rect") hintSettings.framePath = [];
    hintFreeformPoints = [];
    renderHintFreeformPreview();
    saveHintSettings();
  }
  hintShapeTools.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  hintShapeRect.addEventListener("click", () => setHintFrameShape("rect"));
  hintShapeFreeform.addEventListener("click", () =>
    setHintFrameShape("freeform"),
  );
  hintPreviewArea.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (!hintSettings.backgroundEnabled) return;
    hintPreviewPointerId = event.pointerId;
    hintPreviewArea.setPointerCapture?.(event.pointerId);
    if (event.target === hintPreview) {
      updateHintPreviewPosition(event);
    } else if (hintSettings.frameShape === "freeform") {
      hintDrawingFrame = true;
      hintFreeformPoints = [previewPoint(event)];
      applyHintSettings();
      renderHintFreeformPreview();
    } else {
      hintDrawingFrame = true;
      hintFrameStart = previewPoint(event);
      hintFrameDraft = {
        left: hintFrameStart.x,
        top: hintFrameStart.y,
        width: 0,
        height: 0,
      };
      applyHintSettings();
      renderHintRectPreview();
    }
    event.preventDefault();
  });
  hintPreviewArea.addEventListener("pointermove", (event) => {
    if (event.pointerId !== hintPreviewPointerId) return;
    if (hintFreeformPoints.length) updateHintFreeform(event);
    else if (hintFrameStart) updateHintFrame(event);
    else updateHintPreviewPosition(event);
  });
  hintPreviewArea.addEventListener("pointerup", (event) => {
    if (event.pointerId !== hintPreviewPointerId) return;
    const pointerId = event.pointerId;
    hintPreviewPointerId = null;
    hintDrawingFrame = false;
    commitHintFrame();
    commitHintFreeform();
    hintFrameStart = null;
    hintFreeformPoints = [];
    clearHintDraftPreview();
    hintPreviewArea.releasePointerCapture?.(pointerId);
    saveHintSettings();
  });
  hintPreviewArea.addEventListener("pointercancel", () => {
    cancelHintPreviewDrawing();
  });
  hintPreviewArea.addEventListener("pointerleave", () => {
    if (hintDrawingFrame || !hintPreviewPath.hidden) cancelHintPreviewDrawing();
  });
  hintPreviewArea.addEventListener("lostpointercapture", () => {
    if (hintDrawingFrame || !hintPreviewPath.hidden) cancelHintPreviewDrawing();
  });
  search.addEventListener("input", renderList);
  actionSearch.addEventListener("input", filterActionOptions);

  list.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-gesture-edit]");
    const toggle = event.target.closest("[data-gesture-toggle]");
    const remove = event.target.closest("[data-gesture-delete]");
    if (editButton)
      openEditor(
        profiles.find(
          (profile) => profile.id === editButton.dataset.gestureEdit,
        ),
      );
    else if (toggle) {
      const profile = profiles.find(
        (item) => item.id === toggle.dataset.gestureToggle,
      );
      if (!profile) return;
      profile.enabled = !profile.enabled;
      saveProfiles();
      renderList();
    } else if (remove) deleteProfile(remove.dataset.gestureDelete);
  });
  actionOptions.addEventListener("click", (event) => {
    const button = event.target.closest("[data-gesture-action]");
    if (!button) return;
    const previousAction = actionInput.value;
    actionInput.value = button.dataset.gestureAction;
    if (
      !nameInput.value.trim() ||
      nameInput.value === actionLabel(previousAction)
    )
      nameInput.value = actionLabel(actionInput.value);
    syncEditorChoices();
  });

  precision.addEventListener("input", updateEditorPrecision);
  precisionGlobalMode.addEventListener("change", updateEditorPrecision);
  precisionIndependentMode.addEventListener("change", updateEditorPrecision);
  // Mouse recording deliberately uses one event family. macOS WebKit may emit
  // pointerdown for a mouse without a matching pointermove, and pointer capture
  // can then suppress the reliable compatibility mouse stream. Pointer Events
  // remain available only for non-mouse input such as a pen.
  if ("PointerEvent" in global) {
    pad.addEventListener("pointerdown", beginPointerTraining);
    pad.addEventListener("pointermove", movePointerTraining, { passive: false });
    pad.addEventListener("pointerup", finishPointerTraining);
    pad.addEventListener("pointercancel", cancelTraining);
    pad.addEventListener("lostpointercapture", cancelTraining);
  }
  pad.addEventListener("mousedown", beginTraining);
  global.addEventListener("mousemove", moveTraining, {
    capture: true,
    passive: false,
  });
  global.addEventListener("mouseup", finishTraining, true);
  save.addEventListener("click", saveEditor);
  clear.addEventListener("click", () => {
    training = [];
    api.draw(pad, []);
    status.textContent = "轨迹已清除；点击“保存”后生效。";
  });
  function startMouseGesture(event) {
    if (event.button === 0) {
      cancelGestureKeepHint();
      return;
    }
    if (!active) begin(event);
  }
  // Right-button gestures use the same single mouse channel as the editor.
  // This avoids the incomplete mouse PointerEvent sequence in macOS WebKit.
  global.addEventListener("mousedown", startMouseGesture, true);
  global.addEventListener("mousemove", move, {
    capture: true,
    passive: false,
  });
  global.addEventListener("mouseup", (event) => finish(event), true);
  global.addEventListener("blur", () => finish(null, true));
  global.addEventListener(
    "contextmenu",
    (event) => {
      if (active || Date.now() < suppressContextMenuUntil)
        event.preventDefault();
    },
    true,
  );
  infoClose?.addEventListener("click", closeGestureInfo);
  infoModal?.addEventListener("click", (event) => {
    if (event.target === infoModal) closeGestureInfo();
  });
  global.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (infoModal?.classList.contains("show")) closeGestureInfo();
    else if (modal.classList.contains("show")) closeSettings();
  });
  // 阅读窗口启动后会主动请求一次，补上它打开前已经保存的手势配置。
  global.__TAURI__?.event?.listen?.("reader-gesture-settings-request", () =>
    publish(),
  );
  Promise.resolve(
    appSettingsEventApi?.listen?.("app-settings-synced", () => {
      void hydrateAppSettingsSync();
    }),
  ).catch(() => {});
  syncLegacyGesture();
  syncControls();
  applyHintSettings();
  listenForClosedMainSurfaces();
  listenForClosedReader();
  publish();
  void hydrateAppSettingsSync();
  global.ReaderGestureUI = {
    openSettings,
    closeSettings,
    profiles: () =>
      profiles.map((profile) => ({
        ...profile,
        points: profile.points.slice(),
      })),
  };
})(window);
