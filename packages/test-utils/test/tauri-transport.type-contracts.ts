import type { TauriTransport } from "../../tauri-api/src/index.js";
import {
  abortable,
  createDeferred,
  FakeTauriTransport,
  isAbortError,
} from "../src/index.js";

async function supportsSuccessFailureAndCancellation(): Promise<void> {
  const fake: TauriTransport = new FakeTauriTransport();
  const concreteFake = fake as FakeTauriTransport;

  concreteFake.queueInvokeResult("save_setting", { saved: true });
  const success = await fake.invoke<{ saved: boolean }>("save_setting", { theme: "night" });
  const didSave: boolean = success.saved;
  void didSave;

  concreteFake.queueInvokeFailure("save_setting", new Error("disk unavailable"));
  try {
    await fake.invoke("save_setting");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown";
    void message;
  }

  const pending = concreteFake.queueDeferred<string>("sync_now");
  const controller = new AbortController();
  const cancelled = abortable(fake.invoke<string>("sync_now"), controller.signal);
  controller.abort();
  try {
    await cancelled;
  } catch (error: unknown) {
    if (!isAbortError(error)) {
      throw error;
    }
  }
  pending.resolve("the background request may finish after UI cancellation");

  const deferred = createDeferred<number>();
  deferred.resolve(1);
  const settledValue: number = await deferred.promise;
  void settledValue;
}

void supportsSuccessFailureAndCancellation;
