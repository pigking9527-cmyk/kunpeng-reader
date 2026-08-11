import assert from "node:assert/strict";
import test from "node:test";
import type { ReadingStatsRange } from "./reading-stats-port.ts";
import {
  barsForRange,
  canNavigate,
  createReadingStatsState,
  rangeForScope,
  readingStatsReducer,
  readingStreak,
} from "./reading-stats-state.ts";

const emptyRange: ReadingStatsRange = {
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

test("week ranges are local Monday-to-Sunday calendar periods", () => {
  const range = rangeForScope("week", new Date(2026, 7, 13)); // Thursday
  assert.deepEqual(range, { from: 20260810, to: 20260816 });
});

test("month range ends at the real last calendar day", () => {
  assert.deepEqual(rangeForScope("month", new Date(2024, 1, 18)), { from: 20240201, to: 20240229 });
});

test("day and week bars retain empty local time buckets", () => {
  const range: ReadingStatsRange = {
    ...emptyRange,
    hours: [60, ...new Array<number>(23).fill(0)],
    days: [{ day: 20260810, seconds: 30, words: 50 }],
  };
  const dayBars = barsForRange("day", new Date(2026, 7, 10), range, "time");
  const weekBars = barsForRange("week", new Date(2026, 7, 10), range, "words");
  assert.equal(dayBars.length, 24);
  assert.equal(dayBars[0]?.value, 60);
  assert.equal(weekBars.length, 7);
  assert.equal(weekBars[0]?.value, 50);
  assert.equal(weekBars[6]?.value, 0);
});

test("stale or cancelled requests cannot overwrite newer statistics", () => {
  let state = createReadingStatsState(new Date(2026, 7, 10));
  state = readingStatsReducer(state, { type: "load-started", requestId: 2 });
  state = readingStatsReducer(state, { type: "load-cancelled", requestId: 2 });
  const stale = readingStatsReducer(state, { type: "load-succeeded", requestId: 1, range: emptyRange, all: emptyRange });
  assert.equal(stale, state);
  assert.equal(stale.phase, "cancelled");
});

test("current streak and navigation use data boundaries rather than arbitrary dates", () => {
  const now = new Date(2026, 7, 10);
  const streak = readingStreak([
    { day: 20260808, seconds: 10, words: 1 },
    { day: 20260809, seconds: 10, words: 1 },
    { day: 20260810, seconds: 10, words: 1 },
  ], now);
  assert.deepEqual(streak, { current: 3, longest: 3 });
  assert.equal(canNavigate("day", now, -1, new Date(2026, 7, 8), now), true);
  assert.equal(canNavigate("day", now, 1, new Date(2026, 7, 8), now), false);
});
