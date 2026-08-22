import assert from "node:assert/strict";
import test from "node:test";

import {
  buildIntelligenceEventPairCandidates,
  extractIntelligenceEventFingerprint,
  groupIntelligenceEventsByCompleteLinks,
  vetoImpossibleIntelligenceEventMerge,
} from "./intelligence-event-decision-rules.ts";

test("financial issuer fingerprints conservatively veto different companies", () => {
  const ecovacs = {
    id: "ecovacs",
    title: "科沃斯 2026 年半年度归母净利润 12.48 亿元，同比增长 27.4%",
    summary: "公司发布半年报。",
  };
  const zijin = {
    id: "zijin",
    title: "紫金矿业(601899.SH)：上半年净利润391.70亿元，同比增长68%",
  };
  const fingerprint = extractIntelligenceEventFingerprint(ecovacs);
  assert.ok(fingerprint.entities.includes("科沃斯"));
  assert.ok(fingerprint.actions.includes("financial-report"));
  assert.ok(fingerprint.financePeriods.includes("2026-h1"));
  assert.deepEqual(vetoImpossibleIntelligenceEventMerge(ecovacs, zijin).reason, "distinct-high-signal-entities");
  assert.equal(buildIntelligenceEventPairCandidates([ecovacs, zijin]).length, 0);
});

test("unknown headlines do not gain a false veto", () => {
  const decision = vetoImpossibleIntelligenceEventMerge(
    { id: "one", title: "市场迎来最新变化" },
    { id: "two", title: "投资者关注经济数据" },
  );
  assert.equal(decision.veto, false);
  assert.equal(decision.reason, null);
});

test("retrieval candidates are stable and remain candidates rather than merge decisions", () => {
  const first = { id: "b", title: "科沃斯发布2026年半年度业绩报告", summary: "净利润增长" };
  const second = { id: "a", title: "科沃斯半年报：净利润同比增长27.4%", summary: "2026年上半年业绩" };
  const candidates = buildIntelligenceEventPairCandidates([first, second]);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0]?.leftId, candidates[0]?.rightId], ["a", "b"]);
  assert.ok(candidates[0]!.reasons.includes("shared-entity"));
  assert.ok(candidates[0]!.score > 0);
});

test("complete-link grouping refuses transitive A-B-C merges", () => {
  const groups = groupIntelligenceEventsByCompleteLinks(["a", "b", "c"], [
    { leftId: "a", rightId: "b", sameEvent: true },
    { leftId: "b", rightId: "c", sameEvent: true },
  ]);
  assert.deepEqual(groups.map((group) => group.ids), [["a", "b"], ["c"]]);
});

test("complete-link grouping merges only after every cross-edge is accepted", () => {
  const groups = groupIntelligenceEventsByCompleteLinks(["d", "b", "c", "a"], [
    { leftId: "a", rightId: "b", sameEvent: true },
    { leftId: "a", rightId: "c", sameEvent: true },
    { leftId: "b", rightId: "c", sameEvent: true },
    { leftId: "c", rightId: "d", sameEvent: false },
  ]);
  assert.deepEqual(groups.map((group) => group.ids), [["a", "b", "c"], ["d"]]);
});
