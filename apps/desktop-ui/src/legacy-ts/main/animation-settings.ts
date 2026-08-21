export const ANIMATION_STORAGE_KEY = "readerAnimationSettingsV1";

export const ANIMATION_DEFAULTS: Readonly<Record<
  | "allAnimations"
  | "mainWindow"
  | "readerPage"
  | "searchPopup"
  | "shelfSearchToggle"
  | "commonSettingsSwitch"
  | "filterButton"
  | "annotationAdd"
  | "readingMode"
  | "pageTurn"
  | "highlightSettings"
  | "booklistSort",
  boolean
>> = Object.freeze({
  allAnimations: true,
  mainWindow: true,
  readerPage: true,
  searchPopup: true,
  shelfSearchToggle: true,
  commonSettingsSwitch: true,
  filterButton: true,
  annotationAdd: true,
  readingMode: true,
  pageTurn: true,
  highlightSettings: true,
  booklistSort: true,
});

export type AnimationKey = keyof typeof ANIMATION_DEFAULTS;
export type AnimationSettings = Record<AnimationKey, boolean>;
type AnimationGroup = "mainWindow" | "readerPage";

export const ANIMATION_GROUPS: Readonly<Record<AnimationGroup, readonly AnimationKey[]>> =
  Object.freeze({
    mainWindow: Object.freeze<AnimationKey[]>([
      "searchPopup",
      "shelfSearchToggle",
      "commonSettingsSwitch",
      "filterButton",
      "booklistSort",
    ]),
    readerPage: Object.freeze<AnimationKey[]>([
      "annotationAdd",
      "readingMode",
      "pageTurn",
      "highlightSettings",
    ]),
  });

const GROUP_BY_KEY = Object.freeze(
  Object.entries(ANIMATION_GROUPS).reduce<Partial<Record<AnimationKey, AnimationGroup>>>(
    (result, [group, keys]) => {
      keys.forEach((key) => {
        result[key] = group as AnimationGroup;
      });
      return result;
    },
    {},
  ),
);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AnimationEnvironment {
  readonly localStorage: StorageLike;
  dispatchEvent(event: Event): boolean;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseObject(value: string | null): Record<string, unknown> {
  return objectValue(JSON.parse(value || "{}") as unknown);
}

function isAnimationKey(key: string): key is AnimationKey {
  return Object.hasOwn(ANIMATION_DEFAULTS, key);
}

export function isAnimationEnabled(
  values: AnimationSettings,
  key: AnimationKey,
): boolean {
  const group = GROUP_BY_KEY[key];
  return (
    values[key] !== false &&
    (key === "allAnimations" || values.allAnimations !== false) &&
    (!group || values[group] !== false)
  );
}

export function normalizeEmptyGroups(values: AnimationSettings): AnimationSettings {
  for (const [group, keys] of Object.entries(ANIMATION_GROUPS) as [
    AnimationGroup,
    readonly AnimationKey[],
  ][]) {
    if (!values[group]) {
      keys.forEach((key) => {
        values[key] = false;
      });
    } else if (!keys.some((key) => values[key])) {
      values[group] = false;
    }
  }
  return values;
}

export function readAnimationSettings(storage: StorageLike): AnimationSettings {
  try {
    const saved = parseObject(storage.getItem(ANIMATION_STORAGE_KEY));
    const settings = { ...ANIMATION_DEFAULTS };
    for (const [key, value] of Object.entries(saved)) {
      if (isAnimationKey(key)) settings[key] = value !== false;
    }
    if (!Object.hasOwn(saved, "pageTurn")) {
      const reader = parseObject(storage.getItem("readerSettings"));
      if (reader.pageTurnEffect === "off") settings.pageTurn = false;
    }
    return normalizeEmptyGroups(settings);
  } catch {
    return { ...ANIMATION_DEFAULTS };
  }
}

export function syncPageTurnEffect(storage: StorageLike, value: boolean): void {
  try {
    const next = parseObject(storage.getItem("readerSettings"));
    const effect = value ? "horizontal" : "off";
    if (next.pageTurnEffect === effect) return;
    next.pageTurnEffect = effect;
    storage.setItem("readerSettings", JSON.stringify(next));
  } catch {
    // The legacy runtime deliberately treats unavailable storage as non-fatal.
  }
}

export function createAnimationSettingsApi(environment: AnimationEnvironment) {
  const read = (): AnimationSettings => readAnimationSettings(environment.localStorage);
  const enabled = (key: AnimationKey): boolean => isAnimationEnabled(read(), key);

  function set(
    key: string,
    value: boolean,
    options: Readonly<{ enableReaderPage?: boolean; onlyPageTurn?: boolean }> = {},
  ): AnimationSettings {
    if (!isAnimationKey(key)) return read();
    const next = read();
    next[key] = value !== false;
    const groupChildren = ANIMATION_GROUPS[key as AnimationGroup];
    if (groupChildren) {
      if (next[key]) {
        if (!groupChildren.some((child) => next[child])) {
          groupChildren.forEach((child) => {
            next[child] = true;
          });
        }
      } else {
        groupChildren.forEach((child) => {
          next[child] = false;
        });
      }
    }
    if (key === "pageTurn" && next.pageTurn && options.enableReaderPage) {
      const readerPageWasDisabled = !next.readerPage;
      next.readerPage = true;
      if (readerPageWasDisabled && options.onlyPageTurn) {
        ANIMATION_GROUPS.readerPage.forEach((effect) => {
          if (effect !== "pageTurn") next[effect] = false;
        });
      }
    }
    const childGroup = GROUP_BY_KEY[key];
    if (childGroup) {
      next[childGroup] = ANIMATION_GROUPS[childGroup].some((child) => next[child]);
    } else {
      normalizeEmptyGroups(next);
    }
    environment.localStorage.setItem(ANIMATION_STORAGE_KEY, JSON.stringify(next));
    if (key === "pageTurn" || key === "readerPage" || key === "allAnimations") {
      syncPageTurnEffect(environment.localStorage, isAnimationEnabled(next, "pageTurn"));
    }
    environment.dispatchEvent(
      new CustomEvent<AnimationSettings>("reader-animation-settings-changed", {
        detail: next,
      }),
    );
    return next;
  }

  function apply(root: Document, reader: boolean): void {
    const body = root.body;
    if (!body) return;
    syncPageTurnEffect(environment.localStorage, enabled("pageTurn"));
    body.classList.toggle("animations-all-off", !enabled("allAnimations"));
    if (reader) {
      body.classList.toggle("anim-annotation-add-off", !enabled("annotationAdd"));
      body.classList.toggle("anim-reading-mode-off", !enabled("readingMode"));
    } else {
      body.classList.toggle("anim-search-popup-off", !enabled("searchPopup"));
      body.classList.toggle("anim-shelf-search-toggle-off", !enabled("shelfSearchToggle"));
      body.classList.toggle(
        "anim-common-settings-switch-off",
        !enabled("commonSettingsSwitch"),
      );
      body.classList.toggle("anim-filter-button-off", !enabled("filterButton"));
      body.classList.toggle("anim-booklist-sort-off", !enabled("booklistSort"));
    }
  }

  return Object.freeze({
    DEFAULTS: ANIMATION_DEFAULTS,
    GROUPS: ANIMATION_GROUPS,
    GROUP_BY_KEY,
    STORAGE_KEY: ANIMATION_STORAGE_KEY,
    applyMain: (root: Document) => apply(root, false),
    applyReader: (root: Document) => apply(root, true),
    enabled,
    isEnabled: isAnimationEnabled,
    read,
    set,
    setPageTurnFromReader: (value: boolean) =>
      set("pageTurn", value, {
        enableReaderPage: value,
        onlyPageTurn: value,
      }),
    syncPageTurnEffect: (value: boolean) =>
      syncPageTurnEffect(environment.localStorage, value),
  });
}

export type AnimationSettingsApi = ReturnType<typeof createAnimationSettingsApi>;

export function installAnimationSettings(
  target: AnimationEnvironment & Record<string, unknown>,
): AnimationSettingsApi {
  const api = createAnimationSettingsApi(target);
  target.ReaderAnimationSettings = api;
  return api;
}
