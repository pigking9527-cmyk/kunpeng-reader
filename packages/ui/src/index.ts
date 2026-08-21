/**
 * Small, framework-independent UI contracts. This package intentionally has
 * no browser runtime dependency.
 */

export const UI_TONES = ["neutral", "accent", "success", "warning", "danger"] as const;

export type UiTone = (typeof UI_TONES)[number];

export const INTERACTIVE_STATES = ["idle", "hover", "active", "disabled", "loading"] as const;

export type InteractiveState = (typeof INTERACTIVE_STATES)[number];

/**
 * The common semantic contract for a future visual component.
 *
 * `ariaLabel` is required when an icon-only control has no visible label.
 * Native buttons/inputs should use their real `disabled` attribute; custom
 * controls expose `aria-disabled` and must suppress their own action handler.
 */
export interface UiControlContract {
  readonly tone?: UiTone;
  readonly state?: InteractiveState;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
}

export type UiTheme = "light" | "dark";

export const UI_ROOT_CLASS = "kp-ui";
export const UI_THEME_ATTRIBUTE = "data-kp-theme";
export const UI_INTERACTIVE_ATTRIBUTE = "data-kp-interactive";

/** Returns the root attributes expected by tokens.css without depending on a UI framework. */
export function uiRootAttributes(theme: UiTheme): Readonly<Record<string, string>> {
  return {
    class: UI_ROOT_CLASS,
    [UI_THEME_ATTRIBUTE]: theme,
  };
}

/** Returns the data attribute used by token styles for a pointer/keyboard control. */
export function interactiveAttributes(): Readonly<Record<string, "true">> {
  return { [UI_INTERACTIVE_ATTRIBUTE]: "true" };
}
