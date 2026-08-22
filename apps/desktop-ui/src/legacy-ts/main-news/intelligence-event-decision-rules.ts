/**
 * Conservative, pure event-retrieval rules for Intelligence Center.
 *
 * This module deliberately does not decide that two reports are the same
 * event. It only (1) vetoes combinations contradicted by high-signal public
 * facts and (2) produces a small, deterministic candidate set for a model
 * judge. Unknown or weakly extracted data never becomes a veto.
 */

export interface IntelligenceEventDocument {
  readonly id: string;
  readonly title?: string;
  readonly summary?: string;
  readonly publishedAt?: string | number;
}

export type IntelligenceEventAction =
  | "financial-report"
  | "acquisition"
  | "crash"
  | "election"
  | "sanction"
  | "court-decision"
  | "product-release";

export interface IntelligenceEventFingerprint {
  /** High-signal named subjects; an empty list means unknown, not none. */
  readonly entities: readonly string[];
  /** Explicit stock / exchange identifiers only, never guessed ticker words. */
  readonly tickers: readonly string[];
  readonly actions: readonly IntelligenceEventAction[];
  /** Canonical reporting periods such as 2026-h1 or fy2026-q2. */
  readonly financePeriods: readonly string[];
  /** Only explicit report figures, preserved as a tie-break/retrieval signal. */
  readonly financeNumbers: readonly string[];
  /** Bounded, non-generic keys for candidate retrieval, not merge approval. */
  readonly retrievalKeys: readonly string[];
}

export interface IntelligenceEventMergeVeto {
  readonly veto: boolean;
  readonly reason: "distinct-high-signal-entities" | "conflicting-finance-period" | "conflicting-tickers" | null;
  readonly left: IntelligenceEventFingerprint;
  readonly right: IntelligenceEventFingerprint;
}

export interface IntelligenceEventPairCandidate {
  readonly leftId: string;
  readonly rightId: string;
  readonly score: number;
  readonly reasons: readonly ("shared-entity" | "shared-ticker" | "shared-action-period" | "shared-specific-term")[];
  readonly left: IntelligenceEventFingerprint;
  readonly right: IntelligenceEventFingerprint;
}

export interface IntelligenceEventPairDecision {
  readonly leftId: string;
  readonly rightId: string;
  /** Usually produced by the small local event-judge model. */
  readonly sameEvent: boolean;
}

export interface IntelligenceCompleteLinkGroup {
  readonly ids: readonly string[];
}

const MAX_TEXT_LENGTH = 1_600;
const MAX_ENTITIES = 8;
const MAX_RETRIEVAL_KEYS = 24;

const GENERIC_ENTITY_WORDS = new Set([
  "中国", "美国", "国际", "市场", "公司", "集团", "政府", "官方", "媒体", "财经", "新闻", "今日",
  "今年", "去年", "上半年", "下半年", "半年度", "第一季度", "第二季度", "第三季度", "第四季度",
]);
const GENERIC_RETRIEVAL_WORDS = new Set([
  ...GENERIC_ENTITY_WORDS, "净利润", "营收", "收入", "增长", "同比", "财报", "业绩", "报告", "发布", "回应",
  "宣布", "消息", "最新", "历史", "表示", "相关", "事件", "投资", "经济", "行业", "年度",
]);

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH)
    : "";
}

function uniqueSorted(values: Iterable<string>, limit = Number.POSITIVE_INFINITY): readonly string[] {
  return Object.freeze([...new Set([...values].filter(Boolean))].sort((left, right) => left.localeCompare(right, "zh-CN")).slice(0, limit));
}

function normalizedEntity(value: string): string {
  return value.trim().replace(/[“”"'`·.]/g, "").replace(/\s+/g, " ").toLocaleLowerCase();
}

function normalizedText(document: IntelligenceEventDocument): string {
  return `${text(document.title)} ${text(document.summary)}`.replace(/\s+/g, " ").trim();
}

function isGenericEntity(value: string): boolean {
  return value.length < 2 || GENERIC_ENTITY_WORDS.has(value) || /^(?:\d{4}年?|\d+[季度])$/.test(value);
}

function addEntity(target: Set<string>, value: string): void {
  const normalized = normalizedEntity(value);
  if (!isGenericEntity(normalized)) target.add(normalized);
}

function explicitTickers(value: string): readonly string[] {
  const tickers = new Set<string>();
  for (const match of value.matchAll(/(?:\b(?:sh|sz|hk|nasdaq|nyse)\s*[:：-]?\s*|\$)([A-Za-z]{1,6}|\d{5,6})(?:\.(?:sh|sz|hk))?\b/giu)) {
    const ticker = match[1]?.toUpperCase();
    if (ticker) tickers.add(ticker);
  }
  for (const match of value.matchAll(/\b(\d{6})\s*\.\s*(SH|SZ|HK)\b/giu)) {
    if (match[1] && match[2]) tickers.add(`${match[1]}.${match[2].toUpperCase()}`);
  }
  return uniqueSorted(tickers);
}

function financePeriods(value: string): readonly string[] {
  const periods = new Set<string>();
  const year = "(20\\d{2})";
  for (const match of value.matchAll(new RegExp(`${year}\\s*年?\\s*(?:上半年|半年度|h1|first half)`, "giu"))) {
    if (match[1]) periods.add(`${match[1]}-h1`);
  }
  for (const match of value.matchAll(new RegExp(`${year}\\s*年?\\s*(?:下半年|h2|second half)`, "giu"))) {
    if (match[1]) periods.add(`${match[1]}-h2`);
  }
  for (const match of value.matchAll(new RegExp(`${year}\\s*年?\\s*(?:第?([1-4])季度|q([1-4]))`, "giu"))) {
    const quarter = match[2] ?? match[3];
    if (match[1] && quarter) periods.add(`${match[1]}-q${quarter}`);
  }
  for (const match of value.matchAll(/\b(?:fy\s*)?(20\d{2})\s*(?:q([1-4])|h([12]))\b/giu)) {
    const suffix = match[2] ? `q${match[2]}` : `h${match[3]}`;
    if (match[1]) periods.add(`${match[1]}-${suffix}`);
  }
  return uniqueSorted(periods);
}

function financeNumbers(value: string): readonly string[] {
  if (!/(?:净利润|营收|营业收入|利润|earnings|revenue|net income)/iu.test(value)) return Object.freeze([]);
  const values = new Set<string>();
  for (const match of value.matchAll(/(?:净利润|营收|营业收入|利润|earnings|revenue|net income)[^\d]{0,18}(-?\d+(?:\.\d+)?\s*(?:亿|万|亿元|万元|million|billion|%))/giu)) {
    const number = match[1]?.replace(/\s+/g, "").toLocaleLowerCase();
    if (number) values.add(number);
  }
  return uniqueSorted(values, 6);
}

function actions(value: string): readonly IntelligenceEventAction[] {
  const found = new Set<IntelligenceEventAction>();
  if (/(?:财报|业绩|净利润|营收|营业收入|earnings|revenue|net income|quarterly results)/iu.test(value)) found.add("financial-report");
  if (/(?:收购|并购|acquire[sd]?|acquisition|takeover)/iu.test(value)) found.add("acquisition");
  if (/(?:坠机|失事|crash(?:ed)?|plane crash)/iu.test(value)) found.add("crash");
  if (/(?:选举|当选|election|elected)/iu.test(value)) found.add("election");
  if (/(?:制裁|sanction)/iu.test(value)) found.add("sanction");
  if (/(?:判决|定罪|裁定|court (?:rules|ruling)|convicted)/iu.test(value)) found.add("court-decision");
  if (/(?:发布|推出|launch(?:es|ed)?|release[sd]?|unveil(?:s|ed)?)/iu.test(value)) found.add("product-release");
  return uniqueSorted(found) as readonly IntelligenceEventAction[];
}

function extractEntities(value: string, tickers: readonly string[]): readonly string[] {
  const entities = new Set<string>();
  tickers.forEach((ticker) => addEntity(entities, ticker));

  // Legal-name suffixes are intentionally more reliable than arbitrary CJK
  // word segmentation. Keep them even when they appear away from the title.
  for (const match of value.matchAll(/([\p{Script=Han}]{2,16}(?:集团|公司|股份|科技|矿业|银行|证券|汽车|能源|航空|电力|地产|药业|医院|大学|政府|委员会|法院|军方))/gu)) {
    if (match[1]) addEntity(entities, match[1]);
  }

  // Keep the issuer boundary before 发布 / 半年报 instead of greedily
  // absorbing the verb into a short brand name (for example 科沃斯发布).
  for (const match of value.matchAll(/(?:^|[：:|｜])\s*([\p{Script=Han}]{2,12}?)(?=(?:发布(?=[^。]{0,16}(?:财报|业绩|净利润|营收|营业收入))|(?:半年报|年报|季报)))/gu)) {
    if (match[1]) addEntity(entities, match[1]);
  }

  // Financial headlines commonly start with the reporting issuer, including
  // short brand names such as 科沃斯. Only accept it next to an explicit
  // finance marker or ticker; this avoids treating arbitrary first words as
  // named entities.
  for (const match of value.matchAll(/(?:^|[：:|｜])\s*([\p{Script=Han}]{2,12})\s*(?=(?:\(?\s*\d{5,6}\s*\.\s*(?:SH|SZ|HK)\s*\)?|20\d{2}\s*年|(?:上半年|下半年|半年度|第?[一二三四1-4]季度)|(?:净利润|营收|营业收入|财报|业绩)|发布(?=[^。]{0,16}(?:财报|业绩|净利润|营收|营业收入))))/giu)) {
    if (match[1]) addEntity(entities, match[1]);
  }
  for (const match of value.matchAll(/\b([A-Z][A-Za-z0-9&.'-]*(?:\s+[A-Z][A-Za-z0-9&.'-]*){0,3})\s+(?=(?:reports?|announces?|posts?|earnings|revenue|net income|acquires?|launches?))/gu)) {
    if (match[1]) addEntity(entities, match[1]);
  }
  return uniqueSorted(entities, MAX_ENTITIES);
}

function retrievalTerms(value: string): readonly string[] {
  const keys = new Set<string>();
  const latin = value.toLocaleLowerCase().match(/\b[a-z][a-z0-9-]{3,}\b/gu) ?? [];
  latin.filter((term) => !GENERIC_RETRIEVAL_WORDS.has(term)).forEach((term) => keys.add(term));
  const han = value.replace(/[^\p{Script=Han}]/gu, "");
  for (const segment of han.split(/\s+/u)) {
    for (let index = 0; index + 1 < segment.length; index += 1) {
      const term = segment.slice(index, index + 2);
      if (!GENERIC_RETRIEVAL_WORDS.has(term)) keys.add(term);
    }
  }
  return uniqueSorted(keys, MAX_RETRIEVAL_KEYS);
}

/** Extracts only conservative, inspectable facts from a public title/summary. */
export function extractIntelligenceEventFingerprint(document: IntelligenceEventDocument): IntelligenceEventFingerprint {
  const source = normalizedText(document);
  const tickers = explicitTickers(source);
  const entities = extractEntities(source, tickers);
  const actionValues = actions(source);
  const periodValues = financePeriods(source);
  const numbers = financeNumbers(source);
  const keys = uniqueSorted([
    ...entities.map((entity) => `entity:${entity}`),
    ...tickers.map((ticker) => `ticker:${ticker}`),
    ...actionValues.map((action) => `action:${action}`),
    ...periodValues.map((period) => `period:${period}`),
    ...retrievalTerms(source).map((term) => `term:${term}`),
  ], MAX_RETRIEVAL_KEYS);
  return Object.freeze({
    entities,
    tickers,
    actions: actionValues,
    financePeriods: periodValues,
    financeNumbers: numbers,
    retrievalKeys: keys,
  });
}

function shares(left: readonly string[], right: readonly string[]): boolean {
  const rightValues = new Set(right);
  return left.some((value) => rightValues.has(value));
}

/**
 * Rejects only contradictions we can explain. If either side lacks a usable
 * entity/ticker/period, the result is deliberately non-vetoing and a model
 * judge may still decide the pair.
 */
export function vetoImpossibleIntelligenceEventMerge(
  leftDocument: IntelligenceEventDocument,
  rightDocument: IntelligenceEventDocument,
): IntelligenceEventMergeVeto {
  const left = extractIntelligenceEventFingerprint(leftDocument);
  const right = extractIntelligenceEventFingerprint(rightDocument);
  const conflictingTickers = left.tickers.length > 0 && right.tickers.length > 0 && !shares(left.tickers, right.tickers);
  const distinctEntities = left.entities.length > 0 && right.entities.length > 0 && !shares(left.entities, right.entities);
  const conflictingPeriods = left.actions.includes("financial-report") && right.actions.includes("financial-report")
    && left.financePeriods.length > 0 && right.financePeriods.length > 0 && !shares(left.financePeriods, right.financePeriods);
  const reason = conflictingTickers ? "conflicting-tickers"
    : distinctEntities ? "distinct-high-signal-entities"
      : conflictingPeriods ? "conflicting-finance-period" : null;
  return Object.freeze({ veto: reason !== null, reason, left, right });
}

function stableDocuments(documents: readonly IntelligenceEventDocument[]): readonly IntelligenceEventDocument[] {
  const byId = new Map<string, IntelligenceEventDocument>();
  documents.forEach((document) => {
    const id = text(document.id);
    if (id && !byId.has(id)) byId.set(id, { ...document, id });
  });
  return Object.freeze([...byId.values()].sort((left, right) => left.id.localeCompare(right.id, "zh-CN")));
}

function pairScore(left: IntelligenceEventFingerprint, right: IntelligenceEventFingerprint): {
  readonly score: number;
  readonly reasons: IntelligenceEventPairCandidate["reasons"];
} {
  const reasons: Array<IntelligenceEventPairCandidate["reasons"][number]> = [];
  let score = 0;
  if (shares(left.tickers, right.tickers)) { score += 12; reasons.push("shared-ticker"); }
  if (shares(left.entities, right.entities)) { score += 10; reasons.push("shared-entity"); }
  if (shares(left.actions, right.actions) && shares(left.financePeriods, right.financePeriods)) {
    score += 5; reasons.push("shared-action-period");
  }
  const leftTerms = left.retrievalKeys.filter((key) => key.startsWith("term:"));
  const rightTerms = right.retrievalKeys.filter((key) => key.startsWith("term:"));
  const sharedTerms = leftTerms.filter((key) => rightTerms.includes(key)).length;
  if (sharedTerms >= 2) { score += Math.min(sharedTerms, 4); reasons.push("shared-specific-term"); }
  return { score, reasons: Object.freeze(reasons) };
}

/**
 * Builds a bounded candidate list for a small model. It is deterministic and
 * excludes high-signal contradictions, but never marks a pair as same-event.
 */
export function buildIntelligenceEventPairCandidates(
  documents: readonly IntelligenceEventDocument[],
): readonly IntelligenceEventPairCandidate[] {
  const stable = stableDocuments(documents);
  const fingerprints = new Map(stable.map((document) => [document.id, extractIntelligenceEventFingerprint(document)]));
  const pairs: IntelligenceEventPairCandidate[] = [];
  for (let leftIndex = 0; leftIndex < stable.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < stable.length; rightIndex += 1) {
      const leftDocument = stable[leftIndex]!;
      const rightDocument = stable[rightIndex]!;
      const veto = vetoImpossibleIntelligenceEventMerge(leftDocument, rightDocument);
      if (veto.veto) continue;
      const left = fingerprints.get(leftDocument.id)!;
      const right = fingerprints.get(rightDocument.id)!;
      const scored = pairScore(left, right);
      if (scored.score < 2) continue;
      pairs.push(Object.freeze({ leftId: leftDocument.id, rightId: rightDocument.id, score: scored.score, reasons: scored.reasons, left, right }));
    }
  }
  return Object.freeze(pairs.sort((left, right) => right.score - left.score || left.leftId.localeCompare(right.leftId, "zh-CN") || left.rightId.localeCompare(right.rightId, "zh-CN")));
}

function canonicalPair(leftId: string, rightId: string): string | null {
  const left = text(leftId); const right = text(rightId);
  if (!left || !right || left === right) return null;
  return left.localeCompare(right, "zh-CN") < 0 ? `${left}\u001F${right}` : `${right}\u001F${left}`;
}

/**
 * Forms only complete-link groups from accepted model decisions: A-B and B-C
 * does not merge A/C unless the model also accepted A-C. This blocks the
 * common transitive-chain error of broad-topic news clustering.
 */
export function groupIntelligenceEventsByCompleteLinks(
  ids: readonly string[],
  decisions: readonly IntelligenceEventPairDecision[],
): readonly IntelligenceCompleteLinkGroup[] {
  const stableIds = uniqueSorted(ids.map(text));
  const accepted = new Set<string>();
  decisions.forEach((decision) => {
    if (decision.sameEvent) {
      const key = canonicalPair(decision.leftId, decision.rightId);
      if (key) accepted.add(key);
    }
  });
  const hasLink = (left: string, right: string): boolean => accepted.has(canonicalPair(left, right) ?? "");
  const groups: string[][] = [];
  stableIds.forEach((id) => {
    const candidates = groups.filter((group) => group.every((member) => hasLink(id, member)));
    if (candidates.length === 0) { groups.push([id]); return; }
    candidates.sort((left, right) => right.length - left.length || left.join("\u001F").localeCompare(right.join("\u001F"), "zh-CN"));
    candidates[0]!.push(id);
  });
  // A greedy insertion can leave two complete cliques that can safely merge.
  // Repeatedly fuse only when every cross-edge was explicitly accepted.
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const leftGroup = groups[left]!; const rightGroup = groups[right]!;
        if (leftGroup.every((a) => rightGroup.every((b) => hasLink(a, b)))) {
          leftGroup.push(...rightGroup);
          groups.splice(right, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return Object.freeze(groups
    .map((group) => Object.freeze({ ids: uniqueSorted(group) }))
    .sort((left, right) => left.ids[0]!.localeCompare(right.ids[0]!, "zh-CN")));
}
