/**
 * The narrow front-end boundary for Tauri commands and events.
 *
 * Do not import this module in legacy UI code until the surrounding feature is
 * being migrated. New TypeScript features should receive a `TauriTransport`
 * through their composition root, which makes the feature testable without a
 * WebView.
 */

export type TauriUnlisten = () => void;

export interface TauriEvent<TPayload> {
  readonly event: string;
  readonly id: number;
  readonly payload: TPayload;
}

export interface TauriTransport {
  invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult>;
  listen?<TPayload>(
    event: string,
    handler: (event: TauriEvent<TPayload>) => void,
  ): Promise<TauriUnlisten>;
  emit?<TPayload>(event: string, payload?: TPayload): Promise<void>;
}

/** A command declaration intentionally contains only arguments and result. */
export interface TauriCommand {
  readonly args?: Record<string, unknown>;
  readonly result: unknown;
}

/**
 * A feature owns its own small command map. There is deliberately no global
 * map for the existing application: command signatures must be verified
 * against the Rust command before they are added here.
 */
export type TauriCommandMap = Record<string, TauriCommand>;
export type TauriEventMap = Record<string, unknown>;

type CommandArguments<TCommand extends TauriCommand> = TCommand extends {
  readonly args: infer TArgs;
}
  ? [args: TArgs]
  : [];

export class TauriEventApi<TEvents extends TauriEventMap> {
  public constructor(private readonly transport: TauriTransport) {}

  public listen<TEvent extends keyof TEvents & string>(
    event: TEvent,
    handler: (event: TauriEvent<TEvents[TEvent]>) => void,
  ): Promise<TauriUnlisten> {
    if (!this.transport.listen) {
      return Promise.reject(new Error("Tauri event.listen is unavailable outside the desktop runtime."));
    }
    return this.transport.listen<TEvents[TEvent]>(event, handler);
  }

  public emit<TEvent extends keyof TEvents & string>(
    event: TEvent,
    payload?: TEvents[TEvent],
  ): Promise<void> {
    if (!this.transport.emit) {
      return Promise.reject(new Error("Tauri event.emit is unavailable outside the desktop runtime."));
    }
    return this.transport.emit<TEvents[TEvent]>(event, payload);
  }
}

export class TauriApi<TCommands extends TauriCommandMap> {
  public constructor(private readonly transport: TauriTransport) {}

  public invoke<TCommand extends keyof TCommands & string>(
    command: TCommand,
    ...args: CommandArguments<TCommands[TCommand]>
  ): Promise<TCommands[TCommand]["result"]> {
    const [firstArgument] = args as [Record<string, unknown>?];
    return this.transport.invoke<TCommands[TCommand]["result"]>(command, firstArgument);
  }

  public events<TEvents extends TauriEventMap>(): TauriEventApi<TEvents> {
    return new TauriEventApi<TEvents>(this.transport);
  }
}

export function createTauriApi<TCommands extends TauriCommandMap>(
  transport: TauriTransport,
): TauriApi<TCommands> {
  return new TauriApi<TCommands>(transport);
}

interface TauriRuntimeShape {
  readonly core?: {
    readonly invoke?: TauriTransport["invoke"];
  };
  readonly event?: {
    readonly listen?: NonNullable<TauriTransport["listen"]>;
    readonly emit?: NonNullable<TauriTransport["emit"]>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Creates the transport at a Tauri window boundary. It is the only helper in
 * this package that reads the Tauri global; feature code should be passed the
 * resulting transport instead.
 */
export function transportFromTauriGlobal(runtime: unknown = globalThis): TauriTransport {
  if (!isRecord(runtime) || !isRecord(runtime.__TAURI__)) {
    throw new Error("Tauri runtime is unavailable. Pass a test transport outside the desktop WebView.");
  }

  const tauri = runtime.__TAURI__ as TauriRuntimeShape;
  const invoke = tauri.core?.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Tauri core.invoke is unavailable.");
  }

  const transport: TauriTransport = {
    invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
      return invoke<TResult>(command, args);
    },
  };
  const listen = tauri.event?.listen;
  if (typeof listen === "function") {
    transport.listen = <TPayload>(
      event: string,
      handler: (event: TauriEvent<TPayload>) => void,
    ): Promise<TauriUnlisten> => listen<TPayload>(event, handler);
  }
  const emit = tauri.event?.emit;
  if (typeof emit === "function") {
    transport.emit = <TPayload>(
      event: string,
      payload?: TPayload,
    ): Promise<void> => emit<TPayload>(event, payload);
  }
  return transport;
}

export {
  createWindowControls,
  type WindowControlCommands,
  type WindowControls,
  type WindowResizeDirection,
} from "./window-controls.js";
