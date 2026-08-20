export interface DialogFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

interface FileDialogOptions {
  readonly title?: string;
  readonly defaultPath?: string;
  readonly filters?: readonly DialogFilter[];
}

export interface OpenDialogOptions extends FileDialogOptions {
  readonly directory?: boolean;
  readonly multiple?: boolean;
  readonly recursive?: boolean;
}

export interface SaveDialogOptions extends FileDialogOptions {
  readonly canCreateDirectories?: boolean;
}

export type DialogKind = "info" | "warning" | "error";

export interface MessageDialogOptions {
  readonly title?: string;
  readonly kind?: DialogKind;
  readonly okLabel?: string;
}

export interface ConfirmDialogOptions extends MessageDialogOptions {
  readonly cancelLabel?: string;
}

export interface TauriDialogs {
  open(options?: OpenDialogOptions): Promise<string | string[] | null>;
  save(options?: SaveDialogOptions): Promise<string | null>;
  message(message: string, options?: MessageDialogOptions): Promise<void>;
  ask(message: string, options?: ConfirmDialogOptions): Promise<boolean>;
  confirm(message: string, options?: ConfirmDialogOptions): Promise<boolean>;
}

interface TauriDialogRuntime {
  readonly open?: (options?: OpenDialogOptions) => Promise<unknown>;
  readonly save?: (options?: SaveDialogOptions) => Promise<unknown>;
  readonly message?: (message: string, options?: MessageDialogOptions) => Promise<unknown>;
  readonly ask?: (message: string, options?: ConfirmDialogOptions) => Promise<unknown>;
  readonly confirm?: (message: string, options?: ConfirmDialogOptions) => Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function requireDialogRuntime(runtime: unknown): TauriDialogRuntime {
  if (!isRecord(runtime) || !isRecord(runtime.__TAURI__) || !isRecord(runtime.__TAURI__.dialog)) {
    throw new Error("Tauri dialog runtime is unavailable.");
  }
  return runtime.__TAURI__.dialog;
}

function requireMethod<TKey extends keyof TauriDialogRuntime>(
  dialog: TauriDialogRuntime,
  method: TKey,
): NonNullable<TauriDialogRuntime[TKey]> {
  const candidate = dialog[method];
  if (typeof candidate !== "function") {
    throw new Error(`Tauri dialog.${method} is unavailable.`);
  }
  return candidate as NonNullable<TauriDialogRuntime[TKey]>;
}

function decodeOpenResult(value: unknown): string | string[] | null {
  if (value === null || typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw new Error("Tauri dialog.open returned an invalid path selection.");
}

function decodeSaveResult(value: unknown): string | null {
  if (value === null || typeof value === "string") return value;
  throw new Error("Tauri dialog.save returned an invalid path selection.");
}

function decodeBooleanResult(method: "ask" | "confirm", value: unknown): boolean {
  if (typeof value === "boolean") return value;
  throw new Error(`Tauri dialog.${method} returned an invalid confirmation result.`);
}

/**
 * Creates the dialog capability at a window composition root. Feature code
 * receives this narrow interface and never reads `window.__TAURI__` directly.
 */
export function dialogsFromTauriGlobal(runtime: unknown = globalThis): TauriDialogs {
  const dialog = requireDialogRuntime(runtime);

  return {
    async open(options) {
      return decodeOpenResult(await requireMethod(dialog, "open")(options));
    },
    async save(options) {
      return decodeSaveResult(await requireMethod(dialog, "save")(options));
    },
    async message(message, options) {
      await requireMethod(dialog, "message")(message, options);
    },
    async ask(message, options) {
      return decodeBooleanResult("ask", await requireMethod(dialog, "ask")(message, options));
    },
    async confirm(message, options) {
      return decodeBooleanResult(
        "confirm",
        await requireMethod(dialog, "confirm")(message, options),
      );
    },
  };
}
