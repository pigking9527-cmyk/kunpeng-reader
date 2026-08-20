import assert from "node:assert/strict";
import test from "node:test";

import {
  SyncRequestController,
  type SyncTimerPort,
} from "./sync-request-controller.ts";

class FakeTimer implements SyncTimerPort {
  public nowMs = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, { at: number; callback: () => void }>();

  public clear(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  public now(): number {
    return this.nowMs;
  }

  public schedule(callback: () => void, delayMs: number): unknown {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, { at: this.nowMs + delayMs, callback });
    return handle;
  }

  public advance(delayMs: number): void {
    this.nowMs += delayMs;
    for (;;) {
      const next = [...this.callbacks.entries()]
        .filter(([, scheduled]) => scheduled.at <= this.nowMs)
        .sort(([left], [right]) => left - right)[0];
      if (!next) return;
      this.callbacks.delete(next[0]);
      next[1].callback();
    }
  }
}

test("immediate requests coalesce onto one in-flight sync", async () => {
  const controller = new SyncRequestController<number>();
  let calls = 0;
  let release!: () => void;
  const execution = new Promise<number>((resolve) => { release = () => resolve(++calls); });
  const run = () => execution;

  const first = controller.request("immediate", run);
  const second = controller.request("immediate", run);
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 1);
});

test("deferred local changes debounce and coalesce without an upload per edit", async () => {
  const timer = new FakeTimer();
  const controller = new SyncRequestController<number>({ debounceMs: 60, timer });
  let calls = 0;
  const run = async () => ++calls;

  const first = controller.request("deferred", run);
  const second = controller.request("deferred", run);
  timer.advance(59);
  assert.equal(calls, 0);
  timer.advance(1);
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 1);
});

test("failure is reported now and delays only a later deferred retry", async () => {
  const timer = new FakeTimer();
  const controller = new SyncRequestController<number>({
    debounceMs: 10,
    initialRetryMs: 40,
    timer,
  });
  await assert.rejects(
    controller.request("immediate", async () => { throw new Error("offline"); }),
    /offline/,
  );
  assert.equal(controller.nextDeferredDelayMs(), 40);

  let calls = 0;
  const retry = controller.request("deferred", async () => ++calls);
  timer.advance(39);
  assert.equal(calls, 0);
  timer.advance(1);
  assert.equal(await retry, 1);
  assert.equal(controller.nextDeferredDelayMs(), 0);
});
