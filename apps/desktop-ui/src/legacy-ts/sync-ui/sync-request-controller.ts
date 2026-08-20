export type SyncRequestMode = "immediate" | "deferred";

export interface SyncTimerPort {
  clear(handle: unknown): void;
  now(): number;
  schedule(callback: () => void, delayMs: number): unknown;
}

export interface SyncRequestControllerOptions {
  readonly debounceMs?: number;
  readonly initialRetryMs?: number;
  readonly maxRetryMs?: number;
  readonly timer?: SyncTimerPort;
}

interface PendingRequest<T> {
  readonly execute: () => Promise<T>;
  readonly promise: Promise<T>;
  readonly reject: (error: unknown) => void;
  readonly resolve: (value: T) => void;
  readonly timer: unknown;
}

const browserTimer: SyncTimerPort = {
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
};

/**
 * No-DOM/Tauri coordinator for one account's sync operation.
 *
 * Immediate requests (manual sync, successful authentication, explicitly saved
 * secrets) run at once. Deferred requests are for a future, unified local dirty
 * signal: they are coalesced, debounced, and held behind the previous failure's
 * exponential backoff. A failure rejects the originating request immediately;
 * this controller never presents a retry as a successful sync.
 */
export class SyncRequestController<T> {
  private readonly debounceMs: number;
  private readonly initialRetryMs: number;
  private readonly maxRetryMs: number;
  private readonly timer: SyncTimerPort;
  private failures = 0;
  private inFlight: Promise<T> | null = null;
  private pending: PendingRequest<T> | null = null;
  private retryNotBefore = 0;

  public constructor(options: SyncRequestControllerOptions = {}) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 10_000);
    this.initialRetryMs = Math.max(1, options.initialRetryMs ?? 5_000);
    this.maxRetryMs = Math.max(this.initialRetryMs, options.maxRetryMs ?? 300_000);
    this.timer = options.timer ?? browserTimer;
  }

  public request(mode: SyncRequestMode, execute: () => Promise<T>): Promise<T> {
    if (this.inFlight) return this.inFlight;

    if (mode === "immediate") {
      const pending = this.takePending();
      return this.start(pending?.execute ?? execute, pending);
    }

    if (this.pending) return this.pending.promise;
    return this.defer(execute);
  }

  public nextDeferredDelayMs(): number {
    return Math.max(0, this.retryNotBefore - this.timer.now());
  }

  private defer(execute: () => Promise<T>): Promise<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    });
    const delayMs = Math.max(this.debounceMs, this.nextDeferredDelayMs());
    const pending: PendingRequest<T> = {
      execute,
      promise,
      reject,
      resolve,
      timer: this.timer.schedule(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        void this.start(pending.execute, pending);
      }, delayMs),
    };
    this.pending = pending;
    return promise;
  }

  private takePending(): PendingRequest<T> | null {
    const pending = this.pending;
    if (!pending) return null;
    this.timer.clear(pending.timer);
    this.pending = null;
    return pending;
  }

  private start(
    execute: () => Promise<T>,
    pending: PendingRequest<T> | null,
  ): Promise<T> {
    const running = Promise.resolve().then(execute);
    this.inFlight = running;
    void running.then(
      (value) => {
        this.failures = 0;
        this.retryNotBefore = 0;
        pending?.resolve(value);
      },
      (error) => {
        this.failures += 1;
        const retryMs = Math.min(
          this.maxRetryMs,
          this.initialRetryMs * 2 ** (this.failures - 1),
        );
        this.retryNotBefore = this.timer.now() + retryMs;
        pending?.reject(error);
      },
    ).finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    return running;
  }
}
