import type {
  GesturePoint,
  GestureStorage,
  NewsGestureApi,
} from "../main-rules/news-gesture.ts";
import {
  transportFromTauriGlobal,
  type TauriEvent,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.ts";

const MANAGER_KEY = "kunpeng.reader.gesture-manager.v1";
const MANAGER_ENABLED_KEY = "kunpeng.reader.gesture-manager.enabled.v1";
const HINT_SETTINGS_KEY = "kunpeng.reader.gesture-hint.v1";
const HINT_DURATION_MS = 1_200;

interface HintSettings {
  readonly enabled?: boolean;
  readonly fontSize: number;
  readonly backgroundEnabled: boolean;
  readonly background: string;
  readonly opacity: number;
  readonly positionX: number;
  readonly positionY: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameShape: "rect" | "freeform";
  readonly framePath: readonly GesturePoint[];
}

interface GestureProfile {
  readonly name: string;
  readonly scope: "auto" | "main" | "reader";
  readonly action: "back" | "book_info" | "undo_last";
  readonly enabled: boolean;
  readonly points: GesturePoint[];
  readonly precision: string;
}

interface SharedGestureSettings {
  readonly enabled: boolean;
  readonly globalPrecision: string;
  readonly profiles: GestureProfile[];
  readonly hintSettings: HintSettings;
}

interface ActiveGesture {
  readonly points: GesturePoint[];
  readonly profiles: readonly GestureProfile[];
  previewProfileId: string | null;
  readonly source: string;
}

interface UndoEntry {
  readonly kind: "surface" | "jump";
  readonly at?: number;
  readonly name?: string;
  readonly reopen?: () => void;
}

interface ReaderShellApi {
  readonly OVERLAY?: { readonly NONE?: string };
  readonly SIDE_PANEL?: { readonly NONE?: string };
  readonly closeSurface?: () => boolean;
  readonly setSidePanel?: (name: string, open: boolean) => unknown;
  readonly setOverlay?: (name: string, open: boolean) => unknown;
}

interface GestureRuntime extends Record<string, unknown> {
  readonly document?: Document;
  readonly localStorage?: GestureStorage;
  readonly location?: { readonly search?: string };
  readonly innerWidth?: number;
  readonly innerHeight?: number;
  readonly ReaderNewsGesture?: NewsGestureApi;
  readonly ReaderShell?: ReaderShellApi;
  readonly closeReaderWindow?: () => unknown;
  readonly hasReaderJumpHistory?: () => unknown;
  readonly restoreReaderJumpPosition?: () => unknown;
  readonly openReaderBookInfo?: () => unknown;
  readonly setTimeout: typeof globalThis.setTimeout;
  readonly clearTimeout: typeof globalThis.clearTimeout;
  readonly addEventListener: Window["addEventListener"];
}

export interface ReaderGestureCloseApi {
  readonly activate: () => void;
  readonly fromFrame: (payload: unknown) => void;
  readonly frameSurfaceClosed: (handled: unknown) => void;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export function installReaderGesture(
  global: GestureRuntime,
  transport?: TauriTransport | null,
): ReaderGestureCloseApi | null {
  const apiCandidate = global.ReaderNewsGesture;
  const rootCandidate = global.document;
  const trailCandidate = rootCandidate?.getElementById(
    "reader-gesture-trail",
  ) as HTMLCanvasElement | null;
  if (!apiCandidate || !trailCandidate || !rootCandidate) return null;
  const api: NewsGestureApi = apiCandidate;
  const root: Document = rootCandidate;
  const trail: HTMLCanvasElement = trailCandidate;
  let resolvedTransport = transport ?? null;
  if (transport === undefined) {
    try {
      resolvedTransport = transportFromTauriGlobal(global);
    } catch {
      resolvedTransport = null;
    }
  }

  let active: ActiveGesture | null = null;
  let suppressContextMenuUntil = 0;
  let hintTimer: ReturnType<typeof globalThis.setTimeout> | 0 = 0;
  let sharedSettings: SharedGestureSettings | null = null;
  let pendingFrameSurfaceClose: ((handled: boolean) => void) | null = null;
  const undoHistory: UndoEntry[] = [];
  const hint = createHint();

  function trace(event: unknown): void {
    if (!resolvedTransport) return;
    void resolvedTransport
      .invoke("reader_perf_log", {
        event: `gesture ${String(event).slice(0, 480)}`,
      })
      .catch(() => undefined);
  }

  const defaultHintSettings = Object.freeze({
    fontSize: 20,
    backgroundEnabled: true,
    background: "#173b6b",
    opacity: 60,
    positionX: 0.96,
    positionY: 0.04,
    frameWidth: 200,
    frameHeight: 60,
    frameShape: "rect" as const,
    framePath: [] as readonly GesturePoint[],
  });
  const hintHex = (value: unknown): string =>
    /^#[0-9a-f]{6}$/i.test(String(value || ""))
      ? String(value).toLowerCase()
      : defaultHintSettings.background;
  const hintPosition = (value: unknown, fallback: number): number =>
    Math.max(
      0,
      Math.min(1, Number.isFinite(Number(value)) ? Number(value) : fallback),
    );
  const hintFrameSize = (
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number =>
    Math.max(
      minimum,
      Math.min(
        maximum,
        Number.isFinite(Number(value)) ? Number(value) : fallback,
      ),
    );
  const hintFrameShape = (value: unknown): "freeform" | "rect" =>
    value === "freeform" ? "freeform" : "rect";
  const hintFramePath = (value: unknown): GesturePoint[] =>
    (Array.isArray(value) ? value : [])
      .map((point) => ({
        x: Number(record(point).x),
        y: Number(record(point).y),
      }))
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
  const hintClipPath = (settings: HintSettings): string =>
    settings.frameShape === "freeform" && settings.framePath.length >= 3
      ? `polygon(${settings.framePath.map((point) => `${point.x}% ${point.y}%`).join(",")})`
      : "none";

  function normalizedHintSettings(
    sourceValue: unknown,
    includeEnabled: boolean,
  ): HintSettings {
    const source = record(sourceValue);
    return {
      ...(includeEnabled ? { enabled: source.enabled === true } : {}),
      fontSize: Math.max(
        12,
        Math.min(28, Number(source.fontSize) || defaultHintSettings.fontSize),
      ),
      backgroundEnabled: source.backgroundEnabled !== false,
      background: hintHex(source.background),
      opacity: Math.max(
        20,
        Math.min(100, Number(source.opacity) || defaultHintSettings.opacity),
      ),
      positionX: hintPosition(source.positionX, defaultHintSettings.positionX),
      positionY: hintPosition(source.positionY, defaultHintSettings.positionY),
      frameWidth: hintFrameSize(
        source.frameWidth,
        defaultHintSettings.frameWidth,
        96,
        520,
      ),
      frameHeight: hintFrameSize(
        source.frameHeight,
        defaultHintSettings.frameHeight,
        40,
        240,
      ),
      frameShape: hintFrameShape(source.frameShape),
      framePath: hintFramePath(source.framePath),
    };
  }

  function hintSettings(): HintSettings {
    if (sharedSettings?.hintSettings) return sharedSettings.hintSettings;
    try {
      const saved = JSON.parse(
        global.localStorage?.getItem?.(HINT_SETTINGS_KEY) || "{}",
      );
      return normalizedHintSettings(saved, true);
    } catch {
      return { enabled: false, ...defaultHintSettings };
    }
  }
  function hintColor(settings: HintSettings): string {
    if (!settings.backgroundEnabled) return "transparent";
    const hex = settings.background.slice(1);
    const rgb = [0, 2, 4].map((offset) =>
      Number.parseInt(hex.slice(offset, offset + 2), 16),
    );
    return `rgba(${rgb.join(",")},${settings.opacity / 100})`;
  }
  function createHint(): HTMLDivElement {
    const node = root.createElement("div");
    node.className = "reader-gesture-hint";
    node.dataset.overlaySurface = "gesture-hint";
    node.dataset.overlayRole = "feedback";
    node.hidden = true;
    root.body?.appendChild(node);
    return node;
  }
  function placeHint(settings: HintSettings): void {
    const maxLeft = Math.max(0, Number(global.innerWidth) - hint.offsetWidth);
    const maxTop = Math.max(0, Number(global.innerHeight) - hint.offsetHeight);
    hint.style.left = `${Math.round(maxLeft * settings.positionX)}px`;
    hint.style.top = `${Math.round(maxTop * settings.positionY)}px`;
    hint.style.right = "auto";
  }
  function hideHint(): void {
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = 0;
    hint.hidden = true;
    hint.removeAttribute("data-overlay-active");
  }
  function showHint(name: string): void {
    const settings = hintSettings();
    if (!settings.enabled) return;
    hint.textContent = name || "手势已匹配";
    hint.style.fontSize = `${settings.fontSize}px`;
    hint.style.background = hintColor(settings);
    hint.style.width = `${Math.round(settings.frameWidth)}px`;
    hint.style.minHeight = `${Math.round(settings.frameHeight)}px`;
    hint.style.clipPath = hintClipPath(settings);
    hint.dataset.overlayActive = "true";
    hint.hidden = false;
    placeHint(settings);
    if (hintTimer) global.clearTimeout(hintTimer);
    hintTimer = global.setTimeout(hideHint, HINT_DURATION_MS);
  }

  const normalizeAction = (value: unknown): GestureProfile["action"] => {
    if (value === "book_info") return "book_info";
    if (
      value === "undo_last" ||
      value === "reopen_last" ||
      value === "restore_jump"
    )
      return "undo_last";
    return "back";
  };
  const actionLabel = (action: string): string =>
    (
      ({
        back: "关闭",
        book_info: "信息提取／说明",
        undo_last: "撤销上一步",
      }) as Record<string, string>
    )[action] || "关闭";
  const normalizeScope = (
    _action: string,
    value: unknown,
  ): GestureProfile["scope"] =>
    value === "main" || value === "reader" ? value : "auto";
  function profileName(
    profileValue: unknown,
    action: GestureProfile["action"],
  ): string {
    const profile = record(profileValue);
    const savedName = String(profile.name || "")
      .trim()
      .slice(0, 24);
    const legacyCloseName =
      action === "back" &&
      ["返回／关闭当前页", "返回/关闭当前页"].includes(savedName);
    return legacyCloseName ||
      (action === "undo_last" &&
        ["重新打开上一个页面", "恢复跳转前位置"].includes(savedName))
      ? actionLabel(action)
      : savedName || actionLabel(action);
  }
  function mapProfile(
    profileValue: unknown,
    globalPrecision: unknown,
  ): GestureProfile {
    const profile = record(profileValue);
    const action = normalizeAction(profile.action);
    return {
      name: profileName(profile, action),
      scope: normalizeScope(action, profile.scope),
      action,
      enabled: profile.enabled !== false,
      points: api.cleanPoints(profile.points),
      precision:
        profile.precisionMode === "global"
          ? api.normalizePrecision(globalPrecision)
          : api.normalizePrecision(profile.precision),
    };
  }
  function usableProfile(profile: GestureProfile): boolean {
    return (
      profile.enabled &&
      profile.scope !== "main" &&
      ["back", "book_info", "undo_last"].includes(profile.action) &&
      profile.points.length === api.SAMPLE_COUNT
    );
  }
  function normalizeSharedSettings(value: unknown): SharedGestureSettings {
    const source = record(value);
    const profiles = Array.isArray(source.profiles) ? source.profiles : [];
    return {
      enabled: source.enabled === true,
      globalPrecision: api.normalizePrecision(source.globalPrecision),
      profiles: profiles
        .map((profile) => mapProfile(profile, source.globalPrecision))
        .filter(usableProfile),
      hintSettings: normalizedHintSettings(record(source.hintSettings), true),
    };
  }
  async function connectSharedSettings(): Promise<void> {
    if (resolvedTransport) {
      try {
        const saved = await resolvedTransport.invoke<unknown>(
          "reader_gesture_settings_load",
        );
        if (saved) {
          sharedSettings = normalizeSharedSettings(saved);
          trace(
            `config durable enabled=${sharedSettings.enabled} actions=${sharedSettings.profiles.map((profile) => profile.action).join(",")}`,
          );
        } else trace("config durable empty");
      } catch {
        trace("config durable failed");
      }
    }
    if (!resolvedTransport?.listen || !resolvedTransport.emit) return;
    try {
      await resolvedTransport.listen(
        "reader-gesture-settings",
        (event: TauriEvent<unknown>) => {
          sharedSettings = normalizeSharedSettings(event.payload);
          trace(
            `config event enabled=${sharedSettings.enabled} actions=${sharedSettings.profiles.map((profile) => profile.action).join(",")}`,
          );
        },
      );
      await resolvedTransport.emit("reader-gesture-settings-request", {});
    } catch {
      /* durable snapshot is sufficient */
    }
  }
  function profiles(): GestureProfile[] {
    if (sharedSettings?.enabled && sharedSettings.profiles.length)
      return sharedSettings.profiles;
    try {
      const enabledValue = global.localStorage?.getItem?.(MANAGER_ENABLED_KEY);
      const enabled = enabledValue === "true" || enabledValue === "1";
      const saved = record(
        JSON.parse(global.localStorage?.getItem?.(MANAGER_KEY) || "{}"),
      );
      const list = Array.isArray(saved.profiles) ? saved.profiles : [];
      const usable = list
        .map((profile) => mapProfile(profile, saved.globalPrecision))
        .filter(usableProfile);
      if (enabled && usable.length) return usable;
    } catch {
      /* legacy path below */
    }
    const path = api.load(global.localStorage);
    return api.loadEnabled(global.localStorage) && path.length
      ? [
          {
            name: "关闭",
            action: "back",
            scope: "auto",
            enabled: true,
            points: path,
            precision: api.loadPrecision(global.localStorage),
          },
        ]
      : [];
  }
  function clear(): void {
    active = null;
    trail.hidden = true;
    trail.removeAttribute("data-overlay-active");
    api.draw(trail, []);
  }
  function paint(points: readonly GesturePoint[]): void {
    trail.dataset.overlayActive = "true";
    trail.hidden = false;
    api.draw(trail, points, { color: "#3478d4", lineWidth: 5 });
  }
  function start(x: number, y: number, source = "host"): void {
    const currentProfiles = profiles();
    if (!currentProfiles.length) return;
    hideHint();
    trace(
      `start source=${sharedSettings ? "shared" : "local"} actions=${currentProfiles.map((profile) => profile.action).join(",")}`,
    );
    active = {
      points: [{ x, y }],
      profiles: currentProfiles,
      previewProfileId: null,
      source,
    };
    paint(active.points);
  }
  function bestMatch(
    gesture: ActiveGesture,
  ): { readonly profile: GestureProfile; readonly score: number } | null {
    let best: { profile: GestureProfile; score: number } | null = null;
    gesture.profiles.forEach((profile) => {
      const score = api.similarity(profile.points, gesture.points);
      if (
        score >= api.matchThreshold(profile.precision) &&
        (!best || score > best.score)
      )
        best = { profile, score };
    });
    return best;
  }
  function rememberUndoEntry(entry: UndoEntry): void {
    undoHistory.push({ ...entry, at: Date.now() });
    if (undoHistory.length > 16) undoHistory.splice(0, undoHistory.length - 16);
  }
  function rememberClosedSurface(name: unknown, reopen: unknown): void {
    if (typeof reopen !== "function") return;
    rememberUndoEntry({
      kind: "surface",
      name: String(name || "上一个页面").slice(0, 48),
      reopen: reopen as () => void,
    });
  }
  function listenForUndoCheckpoints(): void {
    global.addEventListener("reader-undo-checkpoint", () =>
      rememberUndoEntry({ kind: "jump" }),
    );
  }
  function listenForClosedSurfaces(): void {
    global.addEventListener("reader-shell-statechange", (event: Event) => {
      const detail = record((event as CustomEvent).detail);
      const previous = record(detail.previous),
        next = record(detail.next);
      const none = global.ReaderShell?.OVERLAY?.NONE || "none";
      const noSidePanel = global.ReaderShell?.SIDE_PANEL?.NONE || "none";
      if (
        previous.sidePanel &&
        previous.sidePanel !== noSidePanel &&
        next.sidePanel === noSidePanel
      ) {
        const name =
          previous.sidePanel === "ai-reader" ? "智读" : previous.sidePanel;
        rememberClosedSurface(name, () =>
          global.ReaderShell?.setSidePanel?.(String(previous.sidePanel), true),
        );
        return;
      }
      if (
        !previous.overlay ||
        previous.overlay === none ||
        next.overlay !== none
      )
        return;
      rememberClosedSurface(previous.overlay, () =>
        global.ReaderShell?.setOverlay?.(String(previous.overlay), true),
      );
    });
  }
  function finishPendingFrameSurfaceClose(handled: boolean): void {
    if (pendingFrameSurfaceClose) pendingFrameSurfaceClose(handled);
  }
  function requestFrameSurfaceClose(): Promise<boolean> {
    const frame = root.getElementById("frame") as HTMLIFrameElement | null;
    if (!frame?.contentWindow) return Promise.resolve(false);
    if (pendingFrameSurfaceClose) pendingFrameSurfaceClose(false);
    return new Promise((resolve) => {
      const timer = global.setTimeout(
        () => finishPendingFrameSurfaceClose(false),
        120,
      );
      pendingFrameSurfaceClose = (handled) => {
        global.clearTimeout(timer);
        pendingFrameSurfaceClose = null;
        resolve(handled === true);
      };
      frame.contentWindow?.postMessage({ readerGestureAction: "back" }, "*");
    });
  }
  async function closeReaderSurface(source: string): Promise<void> {
    if (global.ReaderShell?.closeSurface?.()) return;
    if (source === "frame" && (await requestFrameSurfaceClose())) return;
    if (typeof global.closeReaderWindow === "function") {
      await global.closeReaderWindow();
      return;
    }
    root.getElementById("win-close")?.click();
  }
  function canUndoLastReaderAction(): boolean {
    while (undoHistory.length) {
      const previous = undoHistory[undoHistory.length - 1];
      if (previous?.kind !== "jump" || global.hasReaderJumpHistory?.() === true)
        return true;
      undoHistory.pop();
    }
    return false;
  }
  function undoLastReaderAction(): boolean {
    while (canUndoLastReaderAction()) {
      const previous = undoHistory.pop();
      if (previous?.kind === "surface") {
        previous.reopen?.();
        return true;
      }
      if (global.restoreReaderJumpPosition?.()) return true;
    }
    return false;
  }
  const canApplyAction = (action: string): boolean =>
    action === "back" ||
    (action === "undo_last" && canUndoLastReaderAction()) ||
    (action === "book_info" && typeof global.openReaderBookInfo === "function");
  function previewMatch(gesture: ActiveGesture): void {
    let best: { profile: GestureProfile; score: number } | null = null;
    gesture.profiles.forEach((profile) => {
      if (!canApplyAction(profile.action)) return;
      const score = api.prefixSimilarity(profile.points, gesture.points);
      if (
        score >= Math.max(0.7, api.matchThreshold(profile.precision)) &&
        (!best || score > best.score)
      )
        best = { profile, score };
    });
    if (!best) {
      gesture.previewProfileId = null;
      return;
    }
    const matched = best as { profile: GestureProfile; score: number };
    const id = `${matched.profile.action}\0${matched.profile.name}`;
    if (gesture.previewProfileId === id) return;
    gesture.previewProfileId = id;
    if (canApplyAction(matched.profile.action)) showHint(matched.profile.name);
  }
  function execute(
    match: { readonly profile: GestureProfile },
    gesture: ActiveGesture,
  ): void {
    if (match.profile.action === "book_info") {
      trace(
        `execute book_info direct=${typeof global.openReaderBookInfo === "function"}`,
      );
      if (typeof global.openReaderBookInfo === "function")
        void global.openReaderBookInfo();
      else root.getElementById("info-btn")?.click();
      return;
    }
    if (match.profile.action === "undo_last") {
      undoLastReaderAction();
      return;
    }
    void closeReaderSurface(gesture.source);
  }
  function finish(cancelled = false): void {
    if (!active) return;
    const gesture = active;
    active = null;
    const matched = !cancelled ? bestMatch(gesture) : null;
    trace(
      `finish cancelled=${Boolean(cancelled)} action=${matched?.profile.action || "none"} points=${gesture.points.length}`,
    );
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    hideHint();
    if (matched && canApplyAction(matched.profile.action))
      execute(matched, gesture);
  }
  function cancelKeepHint(): void {
    if (!active) {
      hideHint();
      return;
    }
    const gesture = active;
    active = null;
    if (gesture.points.length > 1) suppressContextMenuUntil = Date.now() + 500;
    clear();
    hideHint();
  }
  function move(x: number, y: number): void {
    if (!active) return;
    const previous = active.points[active.points.length - 1];
    if (!previous || Math.hypot(x - previous.x, y - previous.y) < 4) return;
    active.points.push({ x, y });
    if (active.points.length > 160) active.points.splice(1, 1);
    paint(active.points);
    previewMatch(active);
  }
  function fromFrame(payloadValue: unknown): void {
    const frame = root.getElementById("frame") as HTMLIFrameElement | null;
    if (!frame || !payloadValue) return;
    const payload = record(payloadValue),
      rect = frame.getBoundingClientRect();
    const x = rect.left + Number(payload.x),
      y = rect.top + Number(payload.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (payload.phase === "start") start(x, y, "frame");
    else if (payload.phase === "move") move(x, y);
    else if (payload.phase === "end") finish();
    else if (payload.phase === "cancel") finish(true);
  }
  const frameSurfaceClosed = (handled: unknown): void =>
    finishPendingFrameSurfaceClose(handled === true);
  function startMouseGesture(event: MouseEvent): void {
    if (event.button === 0) {
      cancelKeepHint();
      return;
    }
    if (event.button !== 2) return;
    start(event.clientX, event.clientY);
    if (active) event.preventDefault();
  }
  let gestureRuntimeStarted = false;
  function startGestureRuntime(): void {
    if (gestureRuntimeStarted) return;
    gestureRuntimeStarted = true;
    global.addEventListener(
      "mousedown",
      startMouseGesture as EventListener,
      true,
    );
    global.addEventListener(
      "mousemove",
      ((event: MouseEvent) => {
        if (active) {
          event.preventDefault();
          move(event.clientX, event.clientY);
        }
      }) as EventListener,
      { capture: true, passive: false },
    );
    global.addEventListener("mouseup", () => finish(), true);
    global.addEventListener("blur", () => {
      finish(true);
      hideHint();
    });
    root.addEventListener("visibilitychange", () => {
      if (root.hidden) hideHint();
    });
    global.addEventListener(
      "contextmenu",
      ((event: Event) => {
        if (active || Date.now() < suppressContextMenuUntil)
          event.preventDefault();
      }) as EventListener,
      true,
    );
    listenForClosedSurfaces();
    listenForUndoCheckpoints();
    void connectSharedSettings();
  }
  if (new URLSearchParams(global.location?.search || "").get("pool") !== "1")
    startGestureRuntime();
  const publicApi = {
    activate: startGestureRuntime,
    fromFrame,
    frameSurfaceClosed,
  };
  global.ReaderGestureClose = publicApi;
  return publicApi;
}
