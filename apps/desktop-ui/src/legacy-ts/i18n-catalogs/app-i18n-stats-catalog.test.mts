import assert from "node:assert/strict";
import test from "node:test";

import { installStatsCatalog, STATS_CATALOG } from "./app-i18n-stats-catalog.ts";

test("statistics catalog preserves classic fallback and locale merge rules", () => {
  const copy: Record<string, Record<string, string>> = { en: {}, ja: {}, ko: {}, fr: {}, "zh-CN": {} };
  STATS_CATALOG.applyChart(copy);
  STATS_CATALOG.applyDetail(copy);
  STATS_CATALOG.applyHeatmap(copy);
  assert.equal(copy.ja?.lineChartData, "折れ線グラフで表示");
  assert.equal(copy.ja?.statsBookNotes, undefined);
  assert.equal(copy.fr?.statsBookNotes, "Highlights {highlights} · Notes {notes}");
  assert.equal(copy["zh-CN"]?.statsQualityFast, "本时段平均阅读速度偏高，可能包含快速翻页或重复计数。");
  assert.equal(copy.ko?.heatmapColor, "히트맵 색상");
});

test("statistics catalog installer exposes the frozen original API", () => {
  const target: Record<string, unknown> = {};
  assert.equal(installStatsCatalog(target), STATS_CATALOG);
  assert.equal(target.ReaderAppI18nStatsCatalog, STATS_CATALOG);
  assert.equal(Object.isFrozen(STATS_CATALOG), true);
});
