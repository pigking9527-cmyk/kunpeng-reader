/** A controllable promise for tests that need to model a pending operation. */
export interface Deferred<TValue> {
  readonly promise: Promise<TValue>;
  readonly settled: boolean;
  resolve(value: TValue | PromiseLike<TValue>): void;
  reject(reason?: unknown): void;
}

/**
 * Creates a promise whose completion is controlled by the test.
 *
 * Use this for in-flight sync or settings requests. A test can resolve it,
 * reject it, or leave it pending while it verifies cancellation behaviour.
 */
export function createDeferred<TValue>(): Deferred<TValue> {
  let resolvePromise: (value: TValue | PromiseLike<TValue>) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  let didSettle = false;

  const promise = new Promise<TValue>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });

  return {
    promise,
    get settled(): boolean {
      return didSettle;
    },
    resolve(value: TValue | PromiseLike<TValue>): void {
      if (didSettle) {
        return;
      }
      didSettle = true;
      resolvePromise(value);
    },
    reject(reason?: unknown): void {
      if (didSettle) {
        return;
      }
      didSettle = true;
      rejectPromise(reason);
    },
  };
}

/** A stable, cross-runtime cancellation error for feature-level tests. */
export class TestAbortError extends Error {
  public constructor(message = "The operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(error: unknown): error is TestAbortError {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Races a promise against an AbortSignal without requiring a WebView or Tauri.
 * It deliberately does not try to stop the underlying work: a feature must
 * still send its own cancel command when its protocol supports one.
 */
export function abortable<TValue>(
  operation: PromiseLike<TValue>,
  signal?: AbortSignal,
): Promise<TValue> {
  if (!signal) {
    return Promise.resolve(operation);
  }
  if (signal.aborted) {
    return Promise.reject(new TestAbortError());
  }

  return new Promise<TValue>((resolve, reject) => {
    const abort = (): void => reject(new TestAbortError());
    signal.addEventListener("abort", abort, { once: true });

    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
