import assert from "node:assert/strict";
import test from "node:test";

import {
  DAILY_DIGEST_DEFAULT_ENTRY_COUNT,
  DAILY_DIGEST_MAX_ENTRY_COUNT,
  createDailyDigestSnapshot,
  decideDailyDigestRollover,
  localDailyDigestDay,
  sanitizeIntelligenceDigestEntry,
  selectDailyDigestEntries,
  sortDailyDigestHistory,
} from "./intelligence-digest-history-rules.ts";

function candidate(id: string, importance: number, confidence: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    importance,
    confidence,
    priority: "P1",
    headline: `标题 ${id}`,
    summary: `摘要 ${id}`,
    whyItMatters: `原因 ${id}`,
    ...extra,
  };
}

test("daily digest selects a deterministic default set of 25 by importance, confidence, and stable id", () => {
  const inputs = Array.from({ length: 35 }, (_, index) => candidate(
    `event-${String(35 - index).padStart(2, "0")}`,
    50 + (index % 3),
    (index % 5) / 10,
  ));
  inputs.push(candidate("a-stable", 100, 0.5), candidate("z-stable", 100, 0.5));

  const first = selectDailyDigestEntries(inputs);
  const second = selectDailyDigestEntries([...inputs].reverse());

  assert.equal(DAILY_DIGEST_DEFAULT_ENTRY_COUNT, 25);
  assert.equal(first.length, 25);
  assert.deepEqual(first, second);
  assert.deepEqual(first.slice(0, 2).map((entry) => entry.id), ["a-stable", "z-stable"]);
  assert.equal(first[2]?.importance, 52);
});

test("daily digest keeps every available entry below 20 and clamps requested counts to 20–30", () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => candidate(`small-${index}`, index, 0.5));
  const thirtyFive = Array.from({ length: 35 }, (_, index) => candidate(`large-${index}`, index, 0.5));

  assert.equal(selectDailyDigestEntries(nineteen).length, 19);
  assert.equal(selectDailyDigestEntries(thirtyFive, { targetCount: 1 }).length, 20);
  assert.equal(selectDailyDigestEntries(thirtyFive, { targetCount: 100 }).length, DAILY_DIGEST_MAX_ENTRY_COUNT);
});

test("daily digest sanitizes and bounds untrusted model fields before ranking", () => {
  const sanitized = sanitizeIntelligenceDigestEntry(candidate("  event\u0000-1  ", 400, -1, {
    headline: `\n ${"标题".repeat(200)} `,
    summary: 42,
    reasons: ["  可用原因  ", "", 4, ...Array.from({ length: 12 }, () => "x")],
  }));
  assert.ok(sanitized);
  assert.equal(sanitized.id, "event -1");
  assert.equal(sanitized.importance, 100);
  assert.equal(sanitized.confidence, 0);
  assert.equal(sanitized.headline.length, 240);
  assert.equal(sanitized.summary, "");
  assert.equal(sanitized.reasons.length, 8);
  assert.equal(sanitizeIntelligenceDigestEntry({ id: "\u0000" }), null);

  const entries = selectDailyDigestEntries([
    candidate("same", 60, 0.2),
    candidate("same", 80, 0.1),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.importance, 80);
});

test("snapshot rollover uses the local calendar date instead of UTC serialization", () => {
  const today = new Date(2026, 7, 22, 23, 59, 59);
  const tomorrow = new Date(2026, 7, 23, 0, 0, 1);
  const snapshot = createDailyDigestSnapshot([candidate("event", 80, 0.8)], today);

  assert.equal(snapshot.day, "2026-08-22");
  assert.equal(localDailyDigestDay(today), "2026-08-22");
  assert.deepEqual(decideDailyDigestRollover(snapshot, today), {
    action: "keep",
    day: "2026-08-22",
    archiveSnapshot: null,
  });
  const rollover = decideDailyDigestRollover(snapshot, tomorrow);
  assert.equal(rollover.action, "rollover");
  assert.equal(rollover.day, "2026-08-23");
  assert.equal(rollover.archiveSnapshot?.day, "2026-08-22");
});

test("history keeps one bounded snapshot per day and orders days newest first", () => {
  const newestOldRevision = {
    day: "2026-08-20",
    createdAtMs: 10,
    entries: [candidate("old", 1, 0.1)],
  };
  const newestRevision = {
    day: "2026-08-20",
    createdAtMs: 20,
    entries: Array.from({ length: 35 }, (_, index) => candidate(`new-${index}`, index, 0.5)),
  };
  const history = sortDailyDigestHistory([
    { day: "not-a-day", createdAtMs: 1, entries: [] },
    newestOldRevision,
    { day: "2026-08-21", createdAtMs: 5, entries: [candidate("tomorrow", 90, 0.9)] },
    newestRevision,
  ]);

  assert.deepEqual(history.map((snapshot) => snapshot.day), ["2026-08-21", "2026-08-20"]);
  assert.equal(history[1]?.entries.length, DAILY_DIGEST_DEFAULT_ENTRY_COUNT);
  assert.equal(history[1]?.entries[0]?.id, "new-34");
});
