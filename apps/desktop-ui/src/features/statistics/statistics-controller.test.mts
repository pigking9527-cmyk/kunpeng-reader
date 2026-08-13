import assert from "node:assert/strict";
import test from "node:test";

import { createStatisticsController } from "./statistics-controller.ts";
import type { StatisticsPort, StatisticsRange } from "./statistics-port.ts";

const emptyRange: StatisticsRange = {
  total_seconds: 0,
  total_words: 0,
  book_count: 0,
  finished_count: 0,
  total_highlights: 0,
  total_notes: 0,
  books: [],
  days: [],
  hours: new Array<number>(24).fill(0),
  hours_words: new Array<number>(24).fill(0),
};

interface Pending {
  readonly signal: AbortSignal;
  readonly resolve: (range: StatisticsRange) => void;
  readonly reject: (error: unknown) => void;
}

function deferredPort(): { readonly port: StatisticsPort; readonly pending: Pending[] } {
  const pending: Pending[] = [];
  return {
    pending,
    port: {
      getRange: (_request, signal) => new Promise<StatisticsRange>((resolve, reject) => {
        pending.push({ signal, resolve, reject });
      }),
    },
  };
}

test("a stale load cannot overwrite the later selected statistics scope", async () => {
  const { port, pending } = deferredPort();
  const controller = createStatisticsController(port, new Date(2026, 7, 12));
  const first = controller.load("day");
  const second = controller.load("week");

  assert.equal(pending.length, 4);
  assert.equal(pending[0]?.signal.aborted, true);
  assert.equal(pending[1]?.signal.aborted, true);
  pending[0]?.resolve({ ...emptyRange, total_seconds: 99 });
  pending[1]?.resolve({ ...emptyRange, total_seconds: 99 });
  await first;
  assert.equal(controller.getState().phase, "loading");

  pending[2]?.resolve({ ...emptyRange, total_seconds: 60 });
  pending[3]?.resolve({ ...emptyRange, total_seconds: 60 });
  await second;
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().scope, "week");
  assert.equal(controller.getState().range?.total_seconds, 60);
});

test("close aborts every in-flight port request and ignores a non-cooperative late completion", async () => {
  const { port, pending } = deferredPort();
  const controller = createStatisticsController(port, new Date(2026, 7, 12));
  const loading = controller.load();
  assert.equal(pending.length, 2);

  controller.close();
  assert.equal(pending[0]?.signal.aborted, true);
  assert.equal(pending[1]?.signal.aborted, true);
  assert.equal(controller.getState().phase, "closed");
  pending[0]?.resolve({ ...emptyRange, total_seconds: 90 });
  pending[1]?.resolve({ ...emptyRange, total_seconds: 90 });
  await loading;
  assert.equal(controller.getState().phase, "closed");
  assert.equal(controller.getState().range, null);
});

test("an abort reported by the port leaves an explicit cancelled state while the feature remains open", async () => {
  let call = 0;
  const port: StatisticsPort = {
    getRange: async (_request, signal) => {
      call += 1;
      if (call === 1) {
        signal.dispatchEvent(new Event("abort"));
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return emptyRange;
    },
  };
  const controller = createStatisticsController(port, new Date(2026, 7, 12));
  await controller.load();
  assert.equal(controller.getState().phase, "cancelled");
  assert.equal(controller.getState().message, "已取消加载阅读统计。");
});
