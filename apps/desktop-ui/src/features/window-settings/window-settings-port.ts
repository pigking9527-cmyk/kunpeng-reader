/**
 * Typed boundary for startup enhancement and main-window actions.
 *
 * This is intentionally a feature port, not a direct Tauri wrapper. The
 * composition root maps the two startup commands and window commands to this
 * interface; callers receive no runtime global or raw command names.
 */

export interface StartupEnhancementSettings {
  /** Whether closing the main window hides it and preserves the process. */
  readonly enabled: boolean;
  /** Whether expensive indexing/classification work can continue while hidden. */
  readonly continueHighCost: boolean;
  readonly launchAtLogin: boolean;
  readonly launchAtLoginAvailable: boolean;
  readonly launchAtLoginBackground: boolean;
  readonly launchAtLoginBackgroundAvailable: boolean;
}

/** Only these fields are accepted by Rust's persisted configuration command. */
export interface StartupEnhancementSettingsRequest {
  readonly enabled: boolean;
  readonly continueHighCost: boolean;
  readonly launchAtLogin: boolean;
  readonly launchAtLoginBackground: boolean;
}

export interface WindowSettingsPort {
  loadStartupSettings(signal: AbortSignal): Promise<StartupEnhancementSettings>;
  saveStartupSettings(
    request: StartupEnhancementSettingsRequest,
    signal: AbortSignal,
  ): Promise<StartupEnhancementSettings>;

  /** Routes through the native main-window close command. */
  closeMainWindow(signal: AbortSignal): Promise<void>;
  /** A host-owned, explicit application-exit path (normally an app menu action). */
  requestApplicationExit(signal: AbortSignal): Promise<void>;
}
