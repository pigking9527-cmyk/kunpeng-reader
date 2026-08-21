import type {
  TauriEvent,
  TauriTransport,
  TauriUnlisten,
} from "../../tauri-api/src/index.js";
import { createDeferred, type Deferred } from "./deferred.js";

export interface TauriInvokeCall {
  readonly command: string;
  readonly args: Record<string, unknown> | undefined;
}

export interface TauriEmitCall {
  readonly event: string;
  readonly payload: unknown;
}

type InvokeResponder = (call: TauriInvokeCall) => unknown | PromiseLike<unknown>;
type EventHandler = (event: TauriEvent<unknown>) => void;

/**
 * In-memory Tauri transport for feature tests.
 *
 * Queue a success, failure, or deferred result before invoking a feature. All
 * calls remain inspectable, so tests can assert a command was sent with the
 * expected arguments without opening a Tauri WebView.
 */
export class FakeTauriTransport implements TauriTransport {
  private readonly invokeResponders = new Map<string, InvokeResponder[]>();
  private readonly eventHandlers = new Map<string, Set<EventHandler>>();
  private eventSequence = 0;

  public readonly invokeCalls: TauriInvokeCall[] = [];
  public readonly emitCalls: TauriEmitCall[] = [];

  public queueInvokeResult<TResult>(command: string, result: TResult): void {
    this.queueResponder(command, () => result);
  }

  public queueInvokeFailure(command: string, reason: unknown): void {
    this.queueResponder(command, () => Promise.reject(reason));
  }

  public queueDeferred<TResult>(command: string): Deferred<TResult> {
    const deferred = createDeferred<TResult>();
    this.queueResponder(command, () => deferred.promise);
    return deferred;
  }

  public queueResponder(command: string, responder: InvokeResponder): void {
    const responders = this.invokeResponders.get(command) ?? [];
    responders.push(responder);
    this.invokeResponders.set(command, responders);
  }

  public invoke<TResult>(command: string, args?: Record<string, unknown>): Promise<TResult> {
    const call: TauriInvokeCall = { command, args };
    this.invokeCalls.push(call);

    const responder = this.invokeResponders.get(command)?.shift();
    if (!responder) {
      return Promise.reject(
        new Error(`No fake response was queued for the Tauri command: ${command}`),
      );
    }
    return Promise.resolve().then(() => responder(call) as TResult);
  }

  public async listen<TPayload>(
    event: string,
    handler: (event: TauriEvent<TPayload>) => void,
  ): Promise<TauriUnlisten> {
    const handlers = this.eventHandlers.get(event) ?? new Set<EventHandler>();
    const erasedHandler = handler as EventHandler;
    handlers.add(erasedHandler);
    this.eventHandlers.set(event, handlers);

    return (): void => {
      handlers.delete(erasedHandler);
      if (handlers.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }

  public async emit<TPayload>(event: string, payload?: TPayload): Promise<void> {
    this.emitCalls.push({ event, payload });
    this.dispatch(event, payload);
  }

  public dispatch<TPayload>(event: string, payload: TPayload): void {
    const listeners = this.eventHandlers.get(event);
    if (!listeners) {
      return;
    }

    const message: TauriEvent<TPayload> = {
      event,
      id: this.eventSequence,
      payload,
    };
    this.eventSequence += 1;
    for (const listener of [...listeners]) {
      listener(message as TauriEvent<unknown>);
    }
  }

  public listenerCount(event: string): number {
    return this.eventHandlers.get(event)?.size ?? 0;
  }
}
