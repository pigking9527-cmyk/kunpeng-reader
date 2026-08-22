import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";
import {
  DAILY_DIGEST_DEFAULT_ENTRY_COUNT,
  localDailyDigestDay,
  sortDailyDigestHistory,
} from "./intelligence-digest-history-rules.ts";
import {
  buildIntelligenceEventPairCandidates,
  groupIntelligenceEventsByCompleteLinks,
  vetoImpossibleIntelligenceEventMerge,
  type IntelligenceEventPairDecision,
} from "./intelligence-event-decision-rules.ts";

type UnknownRecord = Record<string, unknown>;
type IntelligenceLayout = "briefing" | "monitor" | "research" | "interstellar";

// The native collector maintains its own 12-route upstream limit. Keeping the
// workspace batch at the same size yields visible, incremental briefings
// without creating a second burst of hundreds of outbound requests.
const INTELLIGENCE_SOURCE_BATCH_SIZE = 12;
const INTELLIGENCE_SNAPSHOT_STORAGE_KEY = "kunpeng.reader.intelligence.snapshot.v1";
// v2 deliberately invalidates the earlier RSS/excerpt-only editor output.
// It stores a finished event article only after the full source text has gone
// through the source-evidence pass below.
const INTELLIGENCE_EDITORIAL_CACHE_STORAGE_KEY = "kunpeng.reader.intelligence.editorial-cache.v2";
const INTELLIGENCE_SOURCE_EVIDENCE_CACHE_STORAGE_KEY = "kunpeng.reader.intelligence.source-evidence-cache.v1";
// Pair decisions are separate from editorial prose.  Reopening an unchanged
// local snapshot must not spend GPU time deciding the same event relation.
const INTELLIGENCE_EVENT_DECISION_CACHE_STORAGE_KEY = "kunpeng.reader.intelligence.event-decision-cache.v1";
// Article triage is independent from pair decisions and editorial prose. It
// lets newly arriving items be judged once by the configured local judge
// before they can consume Qwen's full-source editing budget.
const INTELLIGENCE_ARTICLE_TRIAGE_CACHE_STORAGE_KEY = "kunpeng.reader.intelligence.article-triage-cache.v1";
const INTELLIGENCE_EVENT_JUDGE_SETTINGS_STORAGE_KEY = "kunpeng.reader.intelligence.event-judge-settings.v1";
const INTELLIGENCE_SNAPSHOT_VERSION = 1;
const INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS = 700;
// The native cache accepts up to 24 MiB. Keep a deliberately lower client
// budget so a growing public catalogue never turns a successful incremental
// collection into an invisible save failure and a later full re-fetch.
const INTELLIGENCE_SNAPSHOT_MAX_ITEMS = 12_000;
const INTELLIGENCE_SNAPSHOT_MAX_ITEMS_PER_SOURCE = 18;
const INTELLIGENCE_SNAPSHOT_MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
const INTELLIGENCE_COMPLETED_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
// Keep the UI input identical to the bounded source set supplied by Rust to
// the local editor. This makes every visible source-difference entry traceable
// to the evidence the model actually received.
const INTELLIGENCE_EDITORIAL_SOURCES_PER_CANDIDATE = 8;
// 2,000 UTF-16 code units still fit under Rust's 7 KiB UTF-8 request bound
// for Chinese text (the densest common case), while avoiding the local
// model's 8K context limit after system instructions and completion room.
const INTELLIGENCE_SOURCE_EVIDENCE_CHUNK_CHARS = 2_000;
const INTELLIGENCE_SOURCE_EVIDENCE_MAX_CHARS = 600;
// The pair judge is intentionally serial and bounded.  A relationship that
// was not explicitly judged never becomes an automatic event merge.
const INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE = 4;
const INTELLIGENCE_EVENT_JUDGE_MAX_PAIRS = 24;
const INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE = 12;

interface IntelligenceNewsItem extends UnknownRecord {
  readonly title?: unknown;
  readonly source?: unknown;
  readonly category?: unknown;
  readonly url?: unknown;
  readonly summary?: unknown;
}

interface IntelligenceCatalogSource extends UnknownRecord {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly category?: unknown;
  readonly provider?: unknown;
  readonly kind?: unknown;
  readonly defaultEnabled?: unknown;
}

interface IntelligenceBriefingEntry {
  readonly item: IntelligenceNewsItem;
  readonly sourceNames: readonly string[];
  readonly sourceKeys: readonly string[];
  readonly evidenceItems: readonly IntelligenceNewsItem[];
  readonly mergedCount: number;
  readonly importance: number;
}

interface IntelligenceBriefCandidate {
  readonly id: string;
  readonly entry: IntelligenceBriefingEntry;
  readonly title: string;
  readonly summary: string;
  readonly publishedAt: string;
  readonly sources: readonly {
    readonly name: string;
    readonly title: string;
    readonly url: string;
    /** Cleaned source excerpt used only for the bounded local editorial pass. */
    readonly summary: string;
    readonly body?: string;
    /** Evidence made from every chunk of body by the local editor. */
    readonly modelEvidence?: string;
    readonly leadImageDataUrl?: string;
    readonly imageUrls?: readonly string[];
    readonly videoUrls?: readonly string[];
  }[];
}

interface IntelligenceModelBrief {
  readonly id: string;
  readonly importance: number;
  readonly confidence: number;
  readonly priority: "P0" | "P1" | "P2";
  readonly headline: string;
  readonly summary: string;
  readonly article: string;
  /** One evidence-bounded delta for every source fed to the local editor. */
  readonly sourceDifferences: readonly IntelligenceSourceDifference[];
  readonly whyItMatters: string;
  readonly reasons: readonly string[];
  readonly notify: boolean;
}

interface IntelligenceSourceDifference {
  readonly source: string;
  readonly detail: string;
}

interface IntelligenceCachedEventDecision {
  readonly sameEvent: boolean;
  readonly confidence: number;
  readonly reason: string;
}

interface IntelligenceDailyDigestEntry {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly article: string;
  readonly whyItMatters: string;
  readonly importance: number;
  readonly confidence: number;
  readonly priority: IntelligenceModelBrief["priority"];
  readonly category: string;
  readonly sourceCount: number;
  readonly reasons: readonly string[];
  readonly notify: boolean;
  readonly sourceDifferences: readonly IntelligenceSourceDifference[];
  readonly evidence: readonly IntelligenceBriefCandidate["sources"][number][];
}

interface IntelligenceDailyDigestSummary {
  readonly day: string;
  readonly generatedAt: number;
  readonly count: number;
  readonly overview: string;
  readonly model: string;
}

interface IntelligenceDailyDigestSnapshot extends IntelligenceDailyDigestSummary {
  readonly entries: readonly IntelligenceDailyDigestEntry[];
}

interface IntelligenceBriefingTopic {
  readonly name: string;
  readonly entries: readonly IntelligenceBriefingEntry[];
}

interface IntelligenceBriefing {
  readonly entries: readonly IntelligenceBriefingEntry[];
  readonly visibleEntries: readonly IntelligenceBriefingEntry[];
  readonly topics: readonly IntelligenceBriefingTopic[];
  readonly inputCount: number;
  readonly uniqueCount: number;
  readonly mergedCount: number;
  readonly hiddenCount: number;
}

interface IntelligenceSnapshot {
  readonly sourceIds: readonly string[];
  readonly items: readonly IntelligenceNewsItem[];
  readonly attemptedSources: number;
  readonly failedSources: number;
  readonly nextBatch: number;
  readonly completed: boolean;
  readonly updatedAt: number;
}

interface IntelligenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface InterstellarSignalCandidate {
  readonly item: IntelligenceNewsItem;
  readonly score: number;
  readonly domains: readonly string[];
}

interface InterstellarSourceCoverageGroup {
  readonly label: string;
  readonly description: string;
  readonly sources: readonly IntelligenceCatalogSource[];
}

const INTERSTELLAR_DOMAIN_RULES: ReadonlyArray<{
  readonly label: string;
  readonly terms: ReadonlyArray<readonly [string, number]>;
}> = [
  {
    label: "任务与深空",
    terms: [
      ["恒星际", 12], ["星际", 10], ["比邻星", 12], ["interstellar", 12], ["proxima", 12],
      ["深空", 6], ["deep space", 7], ["航天", 4], ["spacecraft", 5], ["太空", 3], ["space probe", 6],
    ],
  },
  {
    label: "推进",
    terms: [
      ["光帆", 10], ["lightsail", 10], ["solar sail", 7], ["推进", 2], ["propulsion", 8],
      ["核聚变", 7], ["fusion", 7], ["反物质", 10], ["antimatter", 10], ["离子发动机", 6],
    ],
  },
  {
    label: "能源与散热",
    terms: [
      ["聚变", 7], ["fusion", 7], ["反应堆", 5], ["reactor", 5], ["核能", 4],
      ["能源", 2], ["energy", 2], ["散热", 5], ["thermal", 3],
    ],
  },
  {
    label: "材料与防护",
    terms: [
      ["辐射", 5], ["radiation", 5], ["屏蔽", 5], ["shielding", 6], ["超材料", 4],
      ["材料", 2], ["materials", 2], ["尘埃", 4], ["dust impact", 5],
    ],
  },
  {
    label: "自主系统",
    terms: [
      ["自主导航", 6], ["autonomous navigation", 7], ["自主系统", 5], ["autonomous", 4],
      ["人工智能", 2], [" ai ", 2], ["机器人", 3], ["robot", 3], ["深空通信", 6],
    ],
  },
  {
    label: "太空工业",
    terms: [
      ["在轨制造", 7], ["space manufacturing", 7], ["太空采矿", 7], ["space mining", 7],
      ["发射成本", 5], ["launch cost", 5], ["nasa", 3], ["esa", 3], ["spacex", 3],
    ],
  },
];

const INTERSTELLAR_GATE_TERMS = Object.freeze([
  "恒星际", "星际", "比邻星", "interstellar", "proxima", "深空", "deep space",
  "航天", "太空", "spacecraft", "space probe", "orbital", "轨道", "nasa", "esa", "spacex",
  "光帆", "lightsail", "solar sail", "propulsion", "核聚变", "fusion", "反物质", "antimatter",
  "离子发动机", "ion engine", "在轨制造", "space manufacturing", "太空采矿", "space mining",
]);

const INTERSTELLAR_SOURCE_RULES: ReadonlyArray<{
  readonly label: string;
  readonly description: string;
  readonly terms: readonly string[];
}> = [
  {
    label: "深空与航天",
    description: "任务、发射、卫星、深空探测与空间基础设施",
    terms: ["nasa", "esa", "spacex", "space", "astronomy", "satellite", "launch", "航天", "太空", "空间", "卫星", "火箭", "宇宙"],
  },
  {
    label: "研究与论文",
    description: "基础科学、物理、工程研究与公开论文",
    terms: ["arxiv", "research", "science", "nature", "physics", "论文", "科研", "科学", "物理", "大学"],
  },
  {
    label: "能源与材料",
    description: "聚变、核能、能源系统、材料与制造",
    terms: ["fusion", "nuclear", "energy", "material", "battery", "聚变", "核能", "能源", "材料", "制造"],
  },
  {
    label: "自主系统",
    description: "AI、机器人、计算与自主导航相关能力",
    terms: ["artificial intelligence", " ai ", "robot", "autonomous", "comput", "人工智能", "机器人", "算法", "计算", "自主"],
  },
  {
    label: "制度与产业",
    description: "太空产业、政策、投资与国际协作",
    terms: ["policy", "industry", "investment", "economy", "regulation", "政策", "产业", "投资", "经济", "法规"],
  },
];

function searchableItemText(item: IntelligenceNewsItem): string {
  return ` ${[item.title, item.source, item.category, item.summary].map(text).join(" ").toLocaleLowerCase()} `;
}

function normalizedItemTitle(item: IntelligenceNewsItem): string {
  return itemTitle(item)
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .slice(0, 180);
}

function itemPublishedAt(item: IntelligenceNewsItem): number {
  const source = item as UnknownRecord;
  const candidate = source.publishedAt ?? source.published_at ?? source.pubDate ?? source.date;
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate > 10_000_000_000 ? candidate : candidate * 1_000;
  }
  if (typeof candidate === "string") {
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

const EVENT_TERM_STOP_WORDS = new Set([
  "about", "after", "amid", "and", "are", "but", "for", "from", "has", "into", "its", "new",
  "news", "over", "the", "this", "that", "their", "they", "was", "with", "中国", "国际", "市场",
  "今日", "最新", "消息", "报道", "回应", "发布", "相关", "事件", "公司", "方面",
]);
const MAX_EVENT_TEXT_CHARS = 360;
const MAX_EVENT_CLUSTER_KEY_DOCUMENT_FREQUENCY = 24;
const MAX_EVENT_CLUSTER_KEYS = 12;
const MIN_VISIBLE_IMPORTANCE = 10;

function canonicalItemUrl(item: IntelligenceNewsItem): string {
  const raw = text(item.url);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    [...url.searchParams.keys()].forEach((key) => {
      const normalized = key.toLocaleLowerCase();
      if (normalized.startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(normalized)) {
        url.searchParams.delete(key);
      }
    });
    return url.toString();
  } catch {
    return raw.toLocaleLowerCase();
  }
}

/** Returns a reader-safe public article URL, never a raw RSS/HTML fragment. */
function openableHttpsUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function openableNewsItem(item: IntelligenceNewsItem): IntelligenceNewsItem | null {
  const url = openableHttpsUrl(item.url);
  return url ? { ...item, url } : null;
}

function sourceEvidenceKey(item: IntelligenceNewsItem): string {
  const fields = item as UnknownRecord;
  return text(fields.sourceId ?? fields.source_id ?? item.source) || "unknown";
}

function sourceEvidenceLabels(items: readonly IntelligenceNewsItem[]): {
  readonly sourceKeys: readonly string[];
  readonly sourceNames: readonly string[];
} {
  const labels = new Map<string, string>();
  items.forEach((item) => {
    const key = sourceEvidenceKey(item);
    if (!labels.has(key)) labels.set(key, text(item.source) || key);
  });
  return { sourceKeys: [...labels.keys()], sourceNames: [...labels.values()] };
}

function eventTerms(item: IntelligenceNewsItem): readonly string[] {
  const value = `${itemTitle(item)} ${text(item.summary)}`
    .toLocaleLowerCase()
    .slice(0, MAX_EVENT_TEXT_CHARS);
  const latin = value.match(/[a-z][a-z0-9-]{2,}/gu) ?? [];
  const han = value.replace(/[^\p{Script=Han}]/gu, "");
  const hanBigrams = Array.from({ length: Math.max(0, han.length - 1) }, (_unused, index) => han.slice(index, index + 2));
  const numeric = value.match(/\d{2,}/gu) ?? [];
  return [...new Set([...latin, ...hanBigrams, ...numeric]
    .filter((term) => term.length >= 2 && !EVENT_TERM_STOP_WORDS.has(term)))];
}

function overlapCount(left: readonly string[], right: readonly string[]): number {
  const rightSet = new Set(right);
  return left.reduce((total, term) => total + Number(rightSet.has(term)), 0);
}

function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const shared = overlapCount(left, right);
  return shared / (left.length + right.length - shared);
}

function compatibleEventTime(left: IntelligenceNewsItem, right: IntelligenceNewsItem): boolean {
  const leftAt = itemPublishedAt(left);
  const rightAt = itemPublishedAt(right);
  return leftAt === 0 || rightAt === 0 || Math.abs(leftAt - rightAt) <= 96 * 3_600_000;
}

function likelySameEvent(left: IntelligenceNewsItem, right: IntelligenceNewsItem): boolean {
  const leftUrl = canonicalItemUrl(left);
  if (leftUrl && leftUrl === canonicalItemUrl(right)) return true;
  if (!compatibleEventTime(left, right)) return false;
  const leftTitleTerms = eventTerms({ title: itemTitle(left) });
  const rightTitleTerms = eventTerms({ title: itemTitle(right) });
  const leftTerms = eventTerms(left);
  const rightTerms = eventTerms(right);
  const sharedTitleTerms = overlapCount(leftTitleTerms, rightTitleTerms);
  const sharedTerms = overlapCount(leftTerms, rightTerms);
  const titleSimilarity = jaccardSimilarity(leftTitleTerms, rightTitleTerms);
  const contextSimilarity = jaccardSimilarity(leftTerms, rightTerms);
  const sameCategory = briefingTopicName(left) === briefingTopicName(right);
  // Categories such as "市场" or "国际" are broad buckets, not event IDs.
  // Requiring title-level agreement prevents unrelated articles that merely
  // share generic market words from being presented as one synthesized event.
  return (sharedTitleTerms >= 2 && titleSimilarity >= 0.34)
    || (sharedTitleTerms >= 1 && titleSimilarity >= 0.52)
    || (sameCategory && sharedTitleTerms >= 2 && sharedTerms >= 4
      && contextSimilarity >= 0.35 && titleSimilarity >= 0.22)
    || (!sameCategory && sharedTitleTerms >= 2 && sharedTerms >= 5
      && contextSimilarity >= 0.36 && titleSimilarity >= 0.32);
}

function selectRepresentative(entries: readonly IntelligenceBriefingEntry[]): IntelligenceNewsItem {
  return entries.slice().sort((left, right) => (
    right.sourceKeys.length - left.sourceKeys.length
    || text(right.item.summary).length - text(left.item.summary).length
    || itemPublishedAt(right.item) - itemPublishedAt(left.item)
    || normalizedItemTitle(left.item).localeCompare(normalizedItemTitle(right.item), "zh-CN")
    || canonicalItemUrl(left.item).localeCompare(canonicalItemUrl(right.item), "zh-CN")
  ))[0]!.item;
}

function mergeEventSummary(entries: readonly IntelligenceBriefingEntry[], representative: IntelligenceNewsItem): string {
  const selected: string[] = [];
  const selectedTerms: Array<readonly string[]> = [];
  const summaries = entries
    .flatMap((entry) => entry.evidenceItems.map((item) => readableSummary(item.summary)))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, "zh-CN"));
  for (const summary of summaries) {
    const terms = eventTerms({ summary });
    if (selectedTerms.some((previous) => jaccardSimilarity(previous, terms) >= 0.72)) continue;
    const candidate = [...selected, summary].join(" ");
    if (candidate.length > INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS) continue;
    selected.push(summary);
    selectedTerms.push(terms);
    if (selected.length >= 3) break;
  }
  return selected.join(" ") || text(representative.summary);
}

function mergeRelatedEventEntries(entries: readonly IntelligenceBriefingEntry[]): IntelligenceBriefingEntry[] {
  const stableEntries = entries.slice().sort((left, right) => (
    itemPublishedAt(right.item) - itemPublishedAt(left.item)
    || normalizedItemTitle(left.item).localeCompare(normalizedItemTitle(right.item), "zh-CN")
    || canonicalItemUrl(left.item).localeCompare(canonicalItemUrl(right.item), "zh-CN")
  ));
  const documentFrequency = new Map<string, number>();
  const termsByEntry = stableEntries.map((entry) => eventTerms(entry.item));
  termsByEntry.forEach((terms) => terms.forEach((term) => {
    documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }));
  const clusterKeysByEntry = termsByEntry.map((terms) => terms
    .filter((term) => (documentFrequency.get(term) ?? 0) <= MAX_EVENT_CLUSTER_KEY_DOCUMENT_FREQUENCY)
    .sort((left, right) => right.length - left.length || left.localeCompare(right, "zh-CN"))
    .slice(0, MAX_EVENT_CLUSTER_KEYS));
  const clusters: IntelligenceBriefingEntry[][] = [];
  const clustersByKey = new Map<string, number[]>();
  stableEntries.forEach((entry, entryIndex) => {
    const candidateIndexes = new Set<number>();
    clusterKeysByEntry[entryIndex]!.forEach((key) => {
      clustersByKey.get(key)?.forEach((index) => candidateIndexes.add(index));
    });
    const matchingCluster = [...candidateIndexes].find((index) => (
      clusters[index]?.some((candidate) => likelySameEvent(candidate.item, entry.item))
    ));
    const clusterIndex = matchingCluster ?? clusters.length;
    if (matchingCluster === undefined) clusters.push([]);
    clusters[clusterIndex]!.push(entry);
    clusterKeysByEntry[entryIndex]!.forEach((key) => {
      const indexed = clustersByKey.get(key) ?? [];
      if (indexed[indexed.length - 1] !== clusterIndex) indexed.push(clusterIndex);
      clustersByKey.set(key, indexed);
    });
  });
  return clusters.map((members) => {
    const sourceKeys = [...new Set(members.flatMap((entry) => entry.sourceKeys))];
    const sourceNames = [...new Set(members.flatMap((entry) => entry.sourceNames))];
    const evidenceItems = mergeEvidenceItems([], members.flatMap((entry) => entry.evidenceItems));
    const representative = selectRepresentative(members);
    const summary = mergeEventSummary(members, representative);
    const item = summary === text(representative.summary) ? representative : { ...representative, summary };
    return {
      item,
      sourceNames,
      sourceKeys,
      evidenceItems,
      mergedCount: members.reduce((total, entry) => total + entry.mergedCount, 0),
      importance: briefingImportance(item, sourceKeys.length),
    };
  });
}

function briefingImportance(item: IntelligenceNewsItem, sourceCount: number): number {
  const searchable = searchableItemText(item);
  const sourceWeight = Math.min(sourceCount - 1, 4) * 7;
  const priorityTerms = [
    "突发", "灾害", "地震", "预警", "战争", "制裁", "政策", "法规", "选举", "停火",
    "论文", "研究", "实验", "突破", "工程", "发射", "召回", "收购", "融资", "裁员",
  ];
  const topicWeight = priorityTerms.reduce(
    (total, term) => total + (searchable.includes(term) ? 5 : 0),
    0,
  );
  const publishedAt = itemPublishedAt(item);
  const ageHours = publishedAt > 0 ? Math.max(0, (Date.now() - publishedAt) / 3_600_000) : Number.POSITIVE_INFINITY;
  const recencyWeight = ageHours <= 12 ? 8 : ageHours <= 48 ? 5 : ageHours <= 168 ? 2 : 0;
  const contextWeight = text(item.summary).length >= 100 ? 2 : 0;
  return sourceWeight + topicWeight + recencyWeight + contextWeight;
}

function isVisibleBriefingEntry(entry: IntelligenceBriefingEntry): boolean {
  return entry.sourceKeys.length >= 2 || entry.importance >= MIN_VISIBLE_IMPORTANCE;
}

function briefingTopicName(item: IntelligenceNewsItem): string {
  return text(item.category) || "综合";
}

/**
 * The first briefing pass is intentionally local and inspectable: it merges
 * identical headlines across sources, favors independently repeated signals,
 * and groups the surviving evidence by the catalogue's topic.  It must not
 * infer that merely similar headlines are one event: those pairs first go
 * through RAG/rule recall and an explicit model judgement in the live flow.
 */
export function buildIntelligenceBriefing(
  items: readonly IntelligenceNewsItem[],
): IntelligenceBriefing {
  const displayItems = items.map(sanitizeIntelligenceItem);
  const byEvidence = new Map<string, IntelligenceNewsItem[]>();
  displayItems.forEach((item) => {
    const url = canonicalItemUrl(item);
    const title = normalizedItemTitle(item);
    const key = url ? `url:${url}` : title ? `source:${sourceEvidenceKey(item)}|title:${title}` : "";
    if (!key) return;
    const existing = byEvidence.get(key) ?? [];
    existing.push(item);
    byEvidence.set(key, existing);
  });
  const headlineEntries = [...byEvidence.values()].map((duplicates) => {
    const { sourceKeys, sourceNames } = sourceEvidenceLabels(duplicates);
    const representative = duplicates.slice().sort((left, right) => (
      text(right.summary).length - text(left.summary).length
      || itemPublishedAt(right) - itemPublishedAt(left)
    ))[0]!;
    return {
      item: representative,
      sourceNames,
      sourceKeys,
      evidenceItems: mergeEvidenceItems([], duplicates),
      mergedCount: duplicates.length,
      importance: briefingImportance(representative, sourceKeys.length),
    };
  });
  // This is exact-evidence de-duplication only.  In particular, do not use
  // title-keyword similarity here: "company A half-year results" and
  // "company B half-year results" are a common false-positive pair.
  const entries = headlineEntries.sort((left, right) => (
    right.importance - left.importance
    || itemPublishedAt(right.item) - itemPublishedAt(left.item)
    || itemTitle(left.item).localeCompare(itemTitle(right.item), "zh-CN")
  ));
  const visibleEntries = entries.filter(isVisibleBriefingEntry);
  const groups = new Map<string, IntelligenceBriefingEntry[]>();
  visibleEntries.forEach((entry) => {
    const topic = briefingTopicName(entry.item);
    groups.set(topic, [...(groups.get(topic) ?? []), entry]);
  });
  const topics = [...groups.entries()]
    .map(([name, topicEntries]) => ({
      name,
      entries: topicEntries,
    }))
    .sort((left, right) => (
      right.entries[0]!.importance - left.entries[0]!.importance
      || right.entries.length - left.entries.length
      || left.name.localeCompare(right.name, "zh-CN")
    ));
  return {
    entries,
    visibleEntries,
    topics,
    inputCount: displayItems.length,
    uniqueCount: entries.length,
    mergedCount: Math.max(0, displayItems.length - entries.length),
    hiddenCount: entries.length - visibleEntries.length,
  };
}

function stableEventHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function eventCandidateId(entry: IntelligenceBriefingEntry): string {
  const sourcePart = entry.sourceKeys.slice().sort().join(",");
  const urlPart = canonicalItemUrl(entry.item);
  const fingerprint = `${normalizedItemTitle(entry.item)}|${sourcePart}|${urlPart}`;
  return `event-${stableEventHash(fingerprint)}-${stableEventHash([...fingerprint].reverse().join(""))}`;
}

function editorialCandidateSources(
  entry: IntelligenceBriefingEntry,
): IntelligenceBriefCandidate["sources"] {
  const bySource = new Map<string, IntelligenceNewsItem>();
  entry.evidenceItems.forEach((item) => {
    const key = sourceEvidenceKey(item);
    const existing = bySource.get(key);
    // One representative per independent source prevents asking the model for
    // two different "differences" from the same publisher.
    if (!existing || readableSummary(item.summary).length > readableSummary(existing.summary).length) {
      bySource.set(key, item);
    }
  });
  return [...bySource.values()].slice(0, INTELLIGENCE_EDITORIAL_SOURCES_PER_CANDIDATE).map((item) => ({
    name: (text(item.source) || sourceEvidenceKey(item)).slice(0, 120),
    title: itemTitle(item).slice(0, 280),
    url: canonicalItemUrl(item).slice(0, 1_000),
    summary: readableSummary(item.summary).slice(0, 700),
  }));
}

function publishedAtText(item: IntelligenceNewsItem): string {
  const fields = item as UnknownRecord;
  return text(fields.publishedAt ?? fields.published_at ?? fields.pubDate ?? fields.date);
}

/** A bounded, evidence-only projection for the local 27B model. */
export function selectIntelligenceBriefCandidates(
  briefing: IntelligenceBriefing,
  limit = DAILY_DIGEST_DEFAULT_ENTRY_COUNT,
): IntelligenceBriefCandidate[] {
  return briefing.visibleEntries.slice(0, Math.max(0, limit)).map((entry) => ({
    id: eventCandidateId(entry),
    entry,
    title: itemTitle(entry.item).slice(0, 280),
    summary: text(entry.item.summary).slice(0, INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS),
    publishedAt: publishedAtText(entry.item).slice(0, 80),
    sources: editorialCandidateSources(entry),
  }));
}

function numberInRange(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum
    ? value
    : null;
}

/**
 * Qwen occasionally follows a familiar 10-point editorial scale despite the
 * requested 0–100 range. Normalize that bounded presentation instead of
 * dropping an otherwise evidence-grounded brief.
 */
function modelImportance(value: unknown): number | null {
  const importance = numberInRange(value, 0, 100);
  return importance !== null && importance > 0 && importance <= 10
    ? Math.round(importance * 10)
    : importance;
}

/** Accept decimal, 10-point, and percent confidence representations. */
function modelConfidence(value: unknown): number | null {
  const confidence = numberInRange(value, 0, 100);
  if (confidence === null || confidence < 0) return null;
  if (confidence <= 1) return confidence;
  return confidence <= 10 ? confidence / 10 : confidence / 100;
}

function parseModelJson(value: string): UnknownRecord | null {
  const trimmed = value.trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
  return record(JSON.parse(trimmed));
}

/** Rejects invented events and malformed scores before they reach the page. */
export function parseIntelligenceModelBriefs(
  content: string,
  candidates: readonly IntelligenceBriefCandidate[],
): IntelligenceModelBrief[] {
  try {
    const response = parseModelJson(content);
    const values = Array.isArray(response?.briefs) ? response.briefs : [];
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const seen = new Set<string>();
    return values.flatMap((value) => {
      const brief = record(value);
      const id = text(brief?.id);
      const importance = modelImportance(brief?.importance);
      const confidence = modelConfidence(brief?.confidence);
      const priority = text(brief?.priority);
      const headline = text(brief?.headline).slice(0, 240);
      const summary = text(brief?.summary).slice(0, 700);
      // A card is readable only when the model produced the promised
      // event-level article. Never turn a rule summary or raw RSS excerpt
      // into a fake "comprehensive report".
      const article = text(brief?.article).slice(0, 4_800);
      const whyItMatters = text(brief?.whyItMatters).slice(0, 420);
      const sourceDifferenceByName = new Map<string, IntelligenceSourceDifference>();
      if (Array.isArray(brief?.sourceDifferences)) {
        brief.sourceDifferences.forEach((difference) => {
          const item = record(difference);
          const source = text(item?.source).slice(0, 160);
          const detail = text(item?.detail).slice(0, 600);
          if (source && detail && !sourceDifferenceByName.has(source)) {
            sourceDifferenceByName.set(source, { source, detail });
          }
        });
      }
      const sourceDifferences = candidateForId(candidates, id)?.sources
        .flatMap((source) => {
          const difference = sourceDifferenceByName.get(source.name);
          return difference ? [difference] : [];
        }) ?? [];
      const reasons = Array.isArray(brief?.reasons)
        ? brief.reasons.map((reason) => text(reason).slice(0, 160)).filter(Boolean).slice(0, 4)
        : [];
      if (
        !candidateIds.has(id) || seen.has(id) || importance === null || confidence === null
        || !["P0", "P1", "P2"].includes(priority) || !headline || !summary || !article || !whyItMatters
        || sourceDifferences.length !== (candidateForId(candidates, id)?.sources.length ?? 0)
      ) return [];
      seen.add(id);
      return [{
        id,
        importance,
        confidence,
        priority: priority as IntelligenceModelBrief["priority"],
        headline,
        summary,
        article,
        sourceDifferences,
        whyItMatters,
        reasons,
        notify: brief?.notify === true,
      }];
    }).sort((left, right) => right.importance - left.importance || right.confidence - left.confidence);
  } catch {
    return [];
  }
}

function intelligenceDigestDay(value: unknown): string {
  const day = text(value);
  return /^\d{4}-\d{2}-\d{2}$/u.test(day) ? day : "";
}

function candidateForId(
  candidates: readonly IntelligenceBriefCandidate[],
  id: string,
): IntelligenceBriefCandidate | null {
  return candidates.find((candidate) => candidate.id === id) ?? null;
}

function parseIntelligenceDailyDigestEntry(value: unknown): IntelligenceDailyDigestEntry | null {
  const entry = record(value);
  const id = text(entry?.id).slice(0, 160);
  const title = text(entry?.title).slice(0, 240);
  const summary = text(entry?.summary).slice(0, 1_800);
  const article = text(entry?.article).slice(0, 6_000);
  const importance = numberInRange(entry?.importance, 0, 100);
  const confidence = numberInRange(entry?.confidence, 0, 1);
  const priority = text(entry?.priority);
  if (!id || !title || !summary || importance === null || confidence === null || !["P0", "P1", "P2"].includes(priority)) return null;
  const evidence = Array.isArray(entry?.evidence)
    ? entry.evidence.flatMap((source) => {
      const item = record(source);
      const name = text(item?.source).slice(0, 120);
      const evidenceTitle = text(item?.title).slice(0, 280);
      const url = canonicalItemUrl({ url: item?.url }).slice(0, 1_000);
      return name && evidenceTitle ? [{ name, title: evidenceTitle, url, summary: "" }] : [];
    }).slice(0, 6)
    : [];
  if (evidence.length === 0) return null;
  const sourceDifferences = Array.isArray(entry?.sourceDifferences)
    ? entry.sourceDifferences.flatMap((difference) => {
      const item = record(difference);
      const source = text(item?.source).slice(0, 160);
      const detail = text(item?.detail).slice(0, 600);
      return source && detail ? [{ source, detail }] : [];
    }).slice(0, 6)
    : [];
  return {
    id,
    title,
    summary,
    article,
    whyItMatters: text(entry?.whyItMatters).slice(0, 900),
    importance,
    confidence,
    priority: priority as IntelligenceModelBrief["priority"],
    category: text(entry?.category).slice(0, 80) || "综合",
    sourceCount: Math.max(1, Math.min(99, Number(entry?.sourceCount) || evidence.length)),
    reasons: Array.isArray(entry?.reasons)
      ? entry.reasons.map((reason) => text(reason).slice(0, 240)).filter(Boolean).slice(0, 3)
      : [],
    notify: entry?.notify === true,
    sourceDifferences,
    evidence,
  };
}

function parseIntelligenceDailyDigestSnapshot(value: unknown): IntelligenceDailyDigestSnapshot | null {
  const snapshot = record(value);
  const day = intelligenceDigestDay(snapshot?.day);
  const generatedAt = typeof snapshot?.generatedAt === "number" && Number.isFinite(snapshot.generatedAt)
    ? snapshot.generatedAt
    : 0;
  const entries = Array.isArray(snapshot?.entries)
    ? snapshot.entries.map(parseIntelligenceDailyDigestEntry).filter((entry): entry is IntelligenceDailyDigestEntry => entry !== null).slice(0, 30)
    : [];
  if (!day || generatedAt <= 0 || entries.length === 0) return null;
  return {
    day,
    generatedAt,
    count: entries.length,
    overview: text(snapshot?.overview).slice(0, 900),
    model: text(snapshot?.model).slice(0, 200),
    entries,
  };
}

function parseIntelligenceDailyDigestSummaries(value: unknown): IntelligenceDailyDigestSummary[] {
  const summaries = Array.isArray(value) ? value.flatMap((candidate) => {
    const summary = record(candidate);
    const day = intelligenceDigestDay(summary?.day);
    const generatedAt = typeof summary?.generatedAt === "number" && Number.isFinite(summary.generatedAt)
      ? summary.generatedAt
      : 0;
    const count = Math.max(0, Math.min(30, Number(summary?.count) || 0));
    return day && generatedAt > 0 && count > 0 ? [{
      day,
      generatedAt,
      count,
      overview: text(summary?.overview).slice(0, 900),
      model: text(summary?.model).slice(0, 200),
    }] : [];
  }) : [];
  const byDay = new Map(summaries.map((summary) => [summary.day, summary]));
  return sortDailyDigestHistory(summaries.map((summary) => ({
    day: summary.day,
    createdAtMs: summary.generatedAt,
    entries: [],
  }))).flatMap((snapshot) => {
    const summary = byDay.get(snapshot.day);
    return summary ? [summary] : [];
  });
}

export function classifyInterstellarSignals(
  items: readonly IntelligenceNewsItem[],
): InterstellarSignalCandidate[] {
  return items
    .map((item) => {
      const searchable = searchableItemText(item);
      const passesInterstellarGate = INTERSTELLAR_GATE_TERMS.some((term) => searchable.includes(term));
      const matches = INTERSTELLAR_DOMAIN_RULES.map((domain) => {
        const score = domain.terms.reduce(
          (total, [term, weight]) => total + (searchable.includes(term) ? weight : 0),
          0,
        );
        return { label: domain.label, score: Math.min(score, 12) };
      }).filter((match) => match.score > 0);
      return {
        item,
        score: passesInterstellarGate
          ? matches.reduce((total, match) => total + match.score, 0)
          : 0,
        domains: matches.map((match) => match.label),
      };
    })
    .filter((candidate) => candidate.score >= 6)
    .sort((left, right) => right.score - left.score || itemTitle(left.item).localeCompare(itemTitle(right.item), "zh-CN"))
    .slice(0, 8);
}

interface IntelligenceWorkspaceController {
  readonly open: () => Promise<void>;
  readonly close: (options?: { readonly focus?: boolean }) => void;
  readonly refresh: () => Promise<void>;
  readonly layout: () => IntelligenceLayout;
}

export interface IntelligenceWorkspaceGlobal {
  readonly init: () => IntelligenceWorkspaceController | null;
  instance?: IntelligenceWorkspaceController | null;
}

type IntelligenceAuditStatus = "pending" | "running" | "accepted" | "rejected" | "warning" | "cached";

interface IntelligenceAuditStageProjection {
  readonly id: "collected" | "exact-dedupe" | "candidate-recall" | "small-model" | "qwen-review" | "final-events";
  readonly status: IntelligenceAuditStatus;
  readonly summary: string;
  readonly count?: number;
  readonly unit?: "articles" | "pairs" | "events";
  readonly inputCount?: number;
  readonly outputCount?: number;
  readonly pendingCount?: number;
  readonly reusedCount?: number;
  readonly items?: readonly {
    readonly id?: string;
    readonly title: string;
    readonly meta?: string;
    readonly reason?: string;
    readonly status?: IntelligenceAuditStatus;
    readonly badge?: string;
    readonly confidence?: number;
    readonly sourceCount?: number;
  }[];
}

interface IntelligenceAuditControllerProjection {
  readonly setSnapshot: (snapshot: {
    readonly runId: string;
    readonly generatedAt: number;
    readonly summary: string;
    readonly stages: readonly IntelligenceAuditStageProjection[];
  }) => void;
}

interface IntelligenceCachedArticleTriage {
  readonly importance: number;
  readonly keep: boolean;
  readonly confidence: number;
  readonly topic: string;
  readonly primaryEntities: readonly string[];
  readonly reason: string;
}

interface IntelligenceWorkspaceRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly localStorage?: IntelligenceStorage;
  readonly ReaderNewsUI?: {
    readonly instance?: {
      readonly close?: (options?: { readonly focus?: boolean }) => void;
      readonly open?: () => Promise<void> | void;
      readonly openItem?: (
        item: IntelligenceNewsItem,
        options?: { readonly returnToIntelligence?: boolean },
      ) => Promise<void> | void;
      readonly openPreparedArticle?: (
        article: {
          readonly title: string;
          readonly source: string;
          readonly publishedAt?: string;
          readonly contentHtml: string;
        },
        options?: { readonly returnToIntelligence?: boolean },
      ) => void;
      readonly openSources?: () => Promise<void> | void;
      readonly sourceRequest?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    };
  };
  readonly ReaderLibraryAiEntry?: { readonly close?: () => void };
  readonly ReaderIntelligenceAudit?: {
    readonly init?: () => IntelligenceAuditControllerProjection | null;
    readonly instance?: IntelligenceAuditControllerProjection | null;
  };
  ReaderIntelligenceWorkspace?: IntelligenceWorkspaceGlobal;
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
}

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? value as UnknownRecord
    : null;
}

function runtimeFrom(value: unknown): IntelligenceWorkspaceRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || typeof runtime.addEventListener !== "function") {
    return null;
  }
  return runtime as unknown as IntelligenceWorkspaceRuntime;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeBriefHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[character] ?? character));
}

function safePreparedImageDataUrl(value: unknown): string {
  const image = text(value);
  return image.length <= 900_000 && /^data:image\/(?:jpeg|png|gif|webp);base64,[a-z0-9+/=]+$/iu.test(image)
    ? image
    : "";
}

function isVideoNewsUrl(value: unknown): boolean {
  const url = openableHttpsUrl(value).toLocaleLowerCase();
  return /(?:youtube\.com|youtu\.be|bilibili\.com|vimeo\.com|tiktok\.com|douyin\.com|\.mp4(?:[?#]|$)|\.webm(?:[?#]|$))/u.test(url);
}

/**
 * Old native/WebView snapshots may predate the RSS HTML cleanup.  Do not let
 * an orphaned anchor attribute (`a href="…"`) become visible copy, and do not
 * use a bare URL as a substitute for a missing summary.  The original URL is
 * still retained for the explicit "查看代表原文" action.
 */
function readableSummary(value: unknown): string {
  const decoded = text(value)
    .replace(/&nbsp;|&#0*160;|&#x0*a0;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#(?:0*39|x0*27);/giu, "'")
    .replace(/&amp;/giu, "&");
  const visible = decoded
    .replace(/<\/?a\b[^>]*>/giu, " ")
    // Some RSS providers already lose the angle brackets before we see the
    // description, leaving fragments such as `target="_blank"` and
    // `/font`. Treat those as markup too, rather than model evidence.
    .replace(/(?:^|\s)(?:a|font)\s+(?=(?:href|target|src|rel|color|style)\s*=)/giu, " ")
    .replace(/(?:^|\s)\/?(?:a|font)\b/giu, " ")
    .replace(/(?:^|\s)(?:href|target|src|rel|color|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, " ")
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return /[\p{L}\p{N}]/u.test(visible) ? visible : "";
}

function sanitizeIntelligenceItem(item: IntelligenceNewsItem): IntelligenceNewsItem {
  const summary = readableSummary(item.summary);
  return summary === text(item.summary) ? item : { ...item, summary };
}

function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function clippedText(value: unknown, limit = INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS): string {
  return text(value).slice(0, limit);
}

function compactSnapshotItem(item: IntelligenceNewsItem): IntelligenceNewsItem {
  const sanitized = sanitizeIntelligenceItem(item);
  const compact: UnknownRecord = {};
  [
    "id", "title", "url", "source", "sourceId", "source_id", "sourceColor", "source_color",
    "summary", "publishedAt", "published_at", "imageUrl", "image_url", "category",
  ].forEach((key) => {
    const value = clippedText(sanitized[key]);
    if (value) compact[key] = value;
  });
  return compact as IntelligenceNewsItem;
}

function compactSnapshotItems(items: readonly IntelligenceNewsItem[]): IntelligenceNewsItem[] {
  const bySource = new Map<string, IntelligenceNewsItem[]>();
  mergeEvidenceItems([], items).forEach((item) => {
    const key = sourceEvidenceKey(item);
    const group = bySource.get(key) ?? [];
    if (group.length < INTELLIGENCE_SNAPSHOT_MAX_ITEMS_PER_SOURCE) group.push(compactSnapshotItem(item));
    bySource.set(key, group);
  });
  const selected: IntelligenceNewsItem[] = [];
  const groups = [...bySource.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "zh-CN"))
    .map(([, group]) => group.sort((left, right) => itemPublishedAt(right) - itemPublishedAt(left)));
  for (let index = 0; selected.length < INTELLIGENCE_SNAPSHOT_MAX_ITEMS; index += 1) {
    let added = false;
    groups.forEach((group) => {
      const item = group[index];
      if (item && selected.length < INTELLIGENCE_SNAPSHOT_MAX_ITEMS) {
        selected.push(item);
        added = true;
      }
    });
    if (!added) break;
  }
  return selected;
}

function sameSourceDirectory(left: readonly string[], right: readonly string[]): boolean {
  // Source providers may reorder their catalogue without changing which
  // sources are enabled. That is not a reason to discard a completed local
  // collection and fetch every source again.
  if (left.length !== right.length) return false;
  const leftSet = new Set(left);
  return leftSet.size === left.length && right.every((sourceId) => leftSet.has(sourceId));
}

function sameSourceOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((sourceId, index) => sourceId === right[index]);
}

function snapshotFromValue(value: unknown, sourceIds: readonly string[]): IntelligenceSnapshot | null {
  try {
    const saved = record(value);
    if (!saved || count(saved.version) !== INTELLIGENCE_SNAPSHOT_VERSION) return null;
    const savedSourceIds = Array.isArray(saved.sourceIds) ? saved.sourceIds.map(text).filter(Boolean) : [];
    if (!sameSourceDirectory(savedSourceIds, sourceIds)) return null;
    const sameOrder = sameSourceOrder(savedSourceIds, sourceIds);
    return {
      sourceIds: sourceIds.slice(),
      items: compactSnapshotItems(newsItems(saved.items)),
      attemptedSources: Math.min(count(saved.attemptedSources), sourceIds.length),
      failedSources: Math.min(count(saved.failedSources), sourceIds.length),
      // `nextBatch` is an index into the source order. A cosmetic reorder
      // restarts one harmless rotating batch from zero, not the full cache.
      nextBatch: sameOrder ? count(saved.nextBatch) : 0,
      completed: saved.completed === true,
      updatedAt: count(saved.updatedAt),
    };
  } catch {
    return null;
  }
}

export function hasFreshCompletedSnapshot(snapshot: IntelligenceSnapshot, now = Date.now()): boolean {
  const age = now - snapshot.updatedAt;
  return snapshot.completed
    && snapshot.updatedAt > 0
    && age >= 0
    && age <= INTELLIGENCE_COMPLETED_SNAPSHOT_MAX_AGE_MS
    // A snapshot from last night must not be reused as today's live briefing
    // merely because it is less than six hours old. The next open performs the
    // normal bounded refresh, then creates today's separate daily record.
    && localDailyDigestDay(new Date(snapshot.updatedAt)) === localDailyDigestDay(new Date(now));
}

function readSnapshot(storage: IntelligenceStorage | undefined, sourceIds: readonly string[]): IntelligenceSnapshot | null {
  if (!storage) return null;
  try {
    return snapshotFromValue(JSON.parse(storage.getItem(INTELLIGENCE_SNAPSHOT_STORAGE_KEY) ?? "null"), sourceIds);
  } catch {
    return null;
  }
}

function preferredSnapshot(
  first: IntelligenceSnapshot | null,
  second: IntelligenceSnapshot | null,
): IntelligenceSnapshot | null {
  if (!first) return second;
  if (!second) return first;
  if (first.completed !== second.completed) return first.completed ? first : second;
  if (first.attemptedSources !== second.attemptedSources) {
    return first.attemptedSources > second.attemptedSources ? first : second;
  }
  if (first.updatedAt !== second.updatedAt) return first.updatedAt > second.updatedAt ? first : second;
  return first;
}

async function readPersistentSnapshot(
  transport: TauriTransport,
  storage: IntelligenceStorage | undefined,
  sourceIds: readonly string[],
): Promise<IntelligenceSnapshot | null> {
  const local = readSnapshot(storage, sourceIds);
  try {
    const native = snapshotFromValue(
      await transport.invoke<unknown>("newsnow_intelligence_snapshot_get"),
      sourceIds,
    );
    return preferredSnapshot(local, native);
  } catch {
    return local;
  }
}

async function saveSnapshot(
  storage: IntelligenceStorage | undefined,
  transport: TauriTransport,
  snapshot: IntelligenceSnapshot,
): Promise<boolean> {
  const base = {
    version: INTELLIGENCE_SNAPSHOT_VERSION,
    sourceIds: snapshot.sourceIds,
    attemptedSources: snapshot.attemptedSources,
    failedSources: snapshot.failedSources,
    nextBatch: snapshot.nextBatch,
    completed: snapshot.completed,
    updatedAt: snapshot.updatedAt,
  };
  const compactItems = compactSnapshotItems(snapshot.items);
  // UTF-8 is what reaches the native JSON validator. Trim by a lower soft
  // limit before invoking it, preserving the newest entry from every source
  // first (the compact helper is round-robin by source).
  const encodedLength = (items: readonly IntelligenceNewsItem[]): number => {
    const json = JSON.stringify({ ...base, items });
    return new TextEncoder().encode(json).byteLength;
  };
  let retainedCount = compactItems.length;
  if (encodedLength(compactItems) > INTELLIGENCE_SNAPSHOT_MAX_SERIALIZED_BYTES) {
    let lower = 0;
    let upper = compactItems.length;
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2);
      if (encodedLength(compactItems.slice(0, middle)) <= INTELLIGENCE_SNAPSHOT_MAX_SERIALIZED_BYTES) lower = middle;
      else upper = middle - 1;
    }
    retainedCount = lower;
  }
  const value = { ...base, items: compactItems.slice(0, retainedCount) };
  let saved = false;
  if (storage) {
    try {
      storage.setItem(INTELLIGENCE_SNAPSHOT_STORAGE_KEY, JSON.stringify(value));
      saved = true;
    } catch {
      // The native cache below keeps the complete snapshot when WebView local
      // storage has a smaller quota than the full public source directory.
    }
  }
  try {
    await transport.invoke("newsnow_intelligence_snapshot_save", { snapshot: value });
    saved = true;
  } catch {
    // Keep the current session useful, but let the caller tell the user that a
    // later reopen may need to resume collection instead of pretending the
    // increment is durable.
  }
  return saved;
}

function newsItems(result: unknown): IntelligenceNewsItem[] {
  const resultRecord = record(result);
  const items = Array.isArray(result)
    ? result
    : (Array.isArray(resultRecord?.items) ? resultRecord.items : []);
  return items
    .map(record)
    .filter((item): item is IntelligenceNewsItem => item !== null)
    .map(sanitizeIntelligenceItem);
}

function evidenceKey(item: IntelligenceNewsItem): string {
  const url = canonicalItemUrl(item);
  const title = normalizedItemTitle(item);
  const source = sourceEvidenceKey(item);
  return url ? `source:${source}|url:${url}` : `source:${source}|title:${title}`;
}

function mergeEvidenceItems(
  current: readonly IntelligenceNewsItem[],
  incoming: readonly IntelligenceNewsItem[],
): IntelligenceNewsItem[] {
  const byEvidence = new Map<string, IntelligenceNewsItem>();
  [...current, ...incoming].forEach((item) => {
    const key = evidenceKey(item);
    if (!key || key === "title:") return;
    const previous = byEvidence.get(key);
    if (!previous || text(item.summary).length > text(previous.summary).length) {
      byEvidence.set(key, item);
    }
  });
  return [...byEvidence.values()];
}

function sourceBatches(sourceIds: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let index = 0; index < sourceIds.length; index += INTELLIGENCE_SOURCE_BATCH_SIZE) {
    batches.push(sourceIds.slice(index, index + INTELLIGENCE_SOURCE_BATCH_SIZE));
  }
  return batches;
}

function catalogSources(result: unknown): IntelligenceCatalogSource[] {
  const items = Array.isArray(result) ? result : [];
  return items.map(record).filter((item): item is IntelligenceCatalogSource => item !== null);
}

function sourceId(source: IntelligenceCatalogSource): string {
  return text(source.id);
}

function sourceSearchableText(source: IntelligenceCatalogSource): string {
  return ` ${[source.id, source.name, source.category, source.provider, source.kind]
    .map(text)
    .join(" ")
    .toLocaleLowerCase()} `;
}

function sourceIdsFromRequest(request: UnknownRecord): string[] {
  return Array.isArray(request.sourceIds)
    ? request.sourceIds.map(text).filter(Boolean)
    : [];
}

function catalogWithCustomSources(
  builtin: readonly IntelligenceCatalogSource[],
  request: UnknownRecord,
): IntelligenceCatalogSource[] {
  const all = [...builtin];
  const knownIds = new Set(all.map(sourceId).filter(Boolean));
  const customSources = Array.isArray(request.customSources) ? request.customSources : [];
  customSources.map(record).filter((source): source is IntelligenceCatalogSource => source !== null)
    .forEach((source) => {
      const id = sourceId(source);
      if (id && !knownIds.has(id)) {
        knownIds.add(id);
        all.push(source);
      }
    });
  return all;
}

function interstellarSourceCoverage(
  catalogue: readonly IntelligenceCatalogSource[],
  request: UnknownRecord,
  items: readonly IntelligenceNewsItem[],
): {
  readonly activeCount: number;
  readonly totalCount: number;
  readonly candidateCount: number;
  readonly groups: readonly InterstellarSourceCoverageGroup[];
} {
  const requestedIds = new Set(sourceIdsFromRequest(request));
  const active = catalogue.filter((source) => requestedIds.size > 0
    ? requestedIds.has(sourceId(source))
    : source.defaultEnabled === true);
  const currentSignalSourceNames = new Set(
    classifyInterstellarSignals(items).map((candidate) => text(candidate.item.source).toLocaleLowerCase()).filter(Boolean),
  );
  const groups = INTERSTELLAR_SOURCE_RULES.map((rule) => ({
    label: rule.label,
    description: rule.description,
    sources: active.filter((source) => {
      const searchable = sourceSearchableText(source);
      return rule.terms.some((term) => searchable.includes(term));
    }),
  }));
  const currentSignalSources = active.filter((source) => currentSignalSourceNames.has(text(source.name).toLocaleLowerCase()));
  if (currentSignalSources.length > 0) {
    groups.unshift({
      label: "当前相关信号",
      description: "已加载资讯中出现星际候选内容的来源",
      sources: currentSignalSources,
    });
  }
  const candidateIds = new Set(groups.flatMap((group) => group.sources.map(sourceId).filter(Boolean)));
  return {
    activeCount: active.length,
    totalCount: catalogue.length,
    candidateCount: candidateIds.size,
    groups: groups.filter((group) => group.sources.length > 0),
  };
}

function requiredElement<TElement extends HTMLElement>(root: Document, id: string): TElement | null {
  return root.getElementById(id) as TElement | null;
}

function hiddenElement(value: Element | null): HTMLElement | null {
  const candidate = record(value);
  return candidate && "hidden" in candidate ? value as HTMLElement : null;
}

function itemTitle(item: IntelligenceNewsItem): string {
  return text(item.title) || "未命名资讯";
}

function itemContext(item: IntelligenceNewsItem): string {
  const summary = readableSummary(item.summary);
  if (summary) return summary;
  const source = text(item.source) || "未知来源";
  const category = text(item.category) || "综合";
  return `${source} · ${category}\n该条资讯未提供可显示摘要，可查看代表原文。`;
}

/**
 * A small controller for a single test section in the existing main window.
 * It reuses the news feed selection and its local source catalogue; source
 * coverage is intentionally separate from future evidence and progress scoring.
 */
export function installIntelligenceWorkspaceUi(
  target: unknown,
  injectedTransport?: TauriTransport,
): IntelligenceWorkspaceGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const activeRuntime = runtime;

  let transport = injectedTransport;
  if (!transport) {
    try {
      transport = transportFromTauriGlobal(target);
    } catch {
      transport = undefined;
    }
  }

  const init = (): IntelligenceWorkspaceController | null => {
    const root = runtime.document;
    const toolbarButton = requiredElement<HTMLButtonElement>(root, "intelligence-lab-toolbar-btn");
    const page = requiredElement<HTMLElement>(root, "intelligence-workspace-page");
    const back = requiredElement<HTMLButtonElement>(root, "intelligence-workspace-back");
    const briefing = requiredElement<HTMLButtonElement>(root, "intelligence-layout-briefing");
    const monitor = requiredElement<HTMLButtonElement>(root, "intelligence-layout-monitor");
    const research = requiredElement<HTMLButtonElement>(root, "intelligence-layout-research");
    const interstellar = requiredElement<HTMLButtonElement>(root, "intelligence-layout-interstellar");
    const refreshButton = requiredElement<HTMLButtonElement>(root, "intelligence-refresh");
    const sourcesButton = requiredElement<HTMLButtonElement>(root, "intelligence-open-sources");
    const sourceDirectory = requiredElement<HTMLElement>(root, "intelligence-source-directory");
    const sourceDirectoryBack = requiredElement<HTMLButtonElement>(root, "intelligence-source-directory-back");
    const sourceDirectorySummary = requiredElement<HTMLElement>(root, "intelligence-source-directory-summary");
    const sourceDirectorySearch = requiredElement<HTMLInputElement>(root, "intelligence-source-directory-search");
    const sourceDirectoryList = requiredElement<HTMLElement>(root, "intelligence-source-directory-list");
    const status = requiredElement<HTMLElement>(root, "intelligence-workspace-status");
    const digestHistory = requiredElement<HTMLElement>(root, "intelligence-digest-history");
    const digestHistorySummary = requiredElement<HTMLElement>(root, "intelligence-digest-history-summary");
    const digestHistoryDate = requiredElement<HTMLSelectElement>(root, "intelligence-digest-history-date");
    const digestHistoryPrevious = requiredElement<HTMLButtonElement>(root, "intelligence-digest-history-previous");
    const digestHistoryNext = requiredElement<HTMLButtonElement>(root, "intelligence-digest-history-next");
    const digestHistoryReadonly = requiredElement<HTMLElement>(root, "intelligence-digest-history-readonly");
    const processingSummary = requiredElement<HTMLElement>(root, "intelligence-processing-summary");
    const modelStatus = requiredElement<HTMLElement>(root, "intelligence-briefing-model-status");
    const modelBaseUrl = requiredElement<HTMLInputElement>(root, "intelligence-local-model-base-url");
    const modelName = requiredElement<HTMLInputElement>(root, "intelligence-local-model-name");
    const eventJudgeBaseUrl = requiredElement<HTMLInputElement>(root, "intelligence-event-judge-base-url");
    const eventJudgeModel = requiredElement<HTMLInputElement>(root, "intelligence-event-judge-model");
    const modelKey = requiredElement<HTMLInputElement>(root, "intelligence-local-model-key");
    const modelSave = requiredElement<HTMLButtonElement>(root, "intelligence-local-model-save");
    const briefingCount = requiredElement<HTMLElement>(root, "intelligence-briefing-count");
    const digestList = requiredElement<HTMLElement>(root, "intelligence-digest-list");
    const signalList = requiredElement<HTMLElement>(root, "intelligence-signal-list");
    const contextTitle = requiredElement<HTMLElement>(root, "intelligence-context-title");
    const contextBody = requiredElement<HTMLElement>(root, "intelligence-context-body");
    const contextMeta = requiredElement<HTMLElement>(root, "intelligence-context-meta");
    const contextReasons = requiredElement<HTMLElement>(root, "intelligence-context-reasons");
    const contextEvidence = requiredElement<HTMLElement>(root, "intelligence-context-evidence");
    const openNews = requiredElement<HTMLButtonElement>(root, "intelligence-open-news");
    const standardView = requiredElement<HTMLElement>(root, "intelligence-standard-view");
    const interstellarView = requiredElement<HTMLElement>(root, "interstellar-progress-view");
    const interstellarSignalCount = requiredElement<HTMLElement>(root, "interstellar-signal-count");
    const interstellarSignalList = requiredElement<HTMLElement>(root, "interstellar-signal-list");
    const interstellarContextTitle = requiredElement<HTMLElement>(root, "interstellar-context-title");
    const interstellarContextBody = requiredElement<HTMLElement>(root, "interstellar-context-body");
    const interstellarOpenNews = requiredElement<HTMLButtonElement>(root, "interstellar-open-news");
    const interstellarSourceSummary = requiredElement<HTMLElement>(root, "interstellar-source-summary");
    const interstellarSourceNote = requiredElement<HTMLElement>(root, "interstellar-source-note");
    const interstellarSourceGroups = requiredElement<HTMLElement>(root, "interstellar-source-groups");
    const interstellarManageSources = requiredElement<HTMLButtonElement>(root, "interstellar-manage-sources");
    const contentShell = typeof root.querySelector === "function"
      ? hiddenElement(root.querySelector(".content-shell"))
      : null;
    if (!toolbarButton || !page || !back || !briefing || !monitor || !research || !interstellar
      || !refreshButton || !sourcesButton || !sourceDirectory || !sourceDirectoryBack || !sourceDirectorySummary || !sourceDirectorySearch || !sourceDirectoryList
      || !status || !digestHistory || !digestHistorySummary || !digestHistoryDate || !digestHistoryPrevious || !digestHistoryNext || !digestHistoryReadonly
      || !processingSummary || !modelStatus || !modelBaseUrl || !modelName || !modelKey || !modelSave || !briefingCount || !digestList || !signalList || !contextTitle
      || !contextBody || !contextMeta || !contextReasons || !contextEvidence || !openNews || !standardView || !interstellarView || !interstellarSignalCount
      || !interstellarSignalList || !interstellarContextTitle || !interstellarContextBody || !interstellarOpenNews
      || !interstellarSourceSummary || !interstellarSourceNote || !interstellarSourceGroups || !interstellarManageSources) {
      return null;
    }

    let currentLayout: IntelligenceLayout = "briefing";
    let loading = false;
    // Returning from an article keeps this controller and its already-rendered
    // evidence snapshot alive. Re-running `load` here used to deserialize the
    // cache and synchronously rebuild the briefing on every return, which made
    // hover feedback and the next link click wait behind that work.
    let workspaceHydrated = false;
    let loadGeneration = 0;
    let cancelledLoadPending = false;
    let reloadAfterCancelledLoad = false;
    let selectedItem: IntelligenceNewsItem | null = null;
    let currentCandidates: IntelligenceBriefCandidate[] = [];
    let currentModelBriefs: IntelligenceModelBrief[] = [];
    let dailyDigestHistory: IntelligenceDailyDigestSnapshot[] = [];
    let selectedDigestDay = "current";
    let briefingGeneration = 0;
    let modelConfigured = false;
    let activeModelName = "";
    let lastGeneratedCandidateKey = "";
    const editorialCache = new Map<string, unknown>();
    const sourceEvidenceCache = new Map<string, string>();
    const eventDecisionCache = new Map<string, IntelligenceCachedEventDecision>();
    const articleTriageCache = new Map<string, IntelligenceCachedArticleTriage>();
    const editorialStorage = runtime.localStorage;
    try {
      const saved = JSON.parse(editorialStorage?.getItem(INTELLIGENCE_EDITORIAL_CACHE_STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(saved)) saved.forEach((value) => {
        const item = record(value); const key = text(item?.key); const brief = item?.brief;
        if (key && brief) editorialCache.set(key, brief);
      });
    } catch { /* a corrupt local editorial cache is disposable */ }
    try {
      const saved = JSON.parse(editorialStorage?.getItem(INTELLIGENCE_SOURCE_EVIDENCE_CACHE_STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(saved)) saved.forEach((value) => {
        const item = record(value); const key = text(item?.key); const evidence = text(item?.evidence);
        if (key && evidence) sourceEvidenceCache.set(key, evidence);
      });
    } catch { /* source evidence is an opportunistic local cache */ }
    try {
      const saved = JSON.parse(editorialStorage?.getItem(INTELLIGENCE_EVENT_DECISION_CACHE_STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(saved)) saved.forEach((value) => {
        const item = record(value);
        const key = text(item?.key);
        const sameEvent = item?.sameEvent === true;
        const confidence = typeof item?.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : null;
        const reason = text(item?.reason).slice(0, 320);
        if (key && confidence !== null) eventDecisionCache.set(key, { sameEvent, confidence, reason });
      });
    } catch { /* pair decisions are an optional, disposable local cache */ }
    try {
      const saved = JSON.parse(editorialStorage?.getItem(INTELLIGENCE_ARTICLE_TRIAGE_CACHE_STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(saved)) saved.forEach((value) => {
        const item = record(value); const key = text(item?.key);
        const importance = typeof item?.importance === "number" && item.importance >= 0 && item.importance <= 100 ? Math.floor(item.importance) : null;
        const confidence = typeof item?.confidence === "number" && item.confidence >= 0 && item.confidence <= 1 ? item.confidence : null;
        const topic = text(item?.topic).slice(0, 80); const reason = text(item?.reason).slice(0, 320);
        const primaryEntities = Array.isArray(item?.primaryEntities) ? item!.primaryEntities.map(text).filter(Boolean).slice(0, 8) : [];
        if (key && importance !== null && confidence !== null && topic && reason) articleTriageCache.set(key, { importance, keep: item?.keep === true, confidence, topic, primaryEntities, reason });
      });
    } catch { /* triage cache is disposable; a malformed entry is never trusted */ }
    try {
      const settings = record(JSON.parse(editorialStorage?.getItem(INTELLIGENCE_EVENT_JUDGE_SETTINGS_STORAGE_KEY) ?? "null"));
      if (eventJudgeBaseUrl) eventJudgeBaseUrl.value = text(settings?.baseUrl).slice(0, 500);
      if (eventJudgeModel) eventJudgeModel.value = text(settings?.model).slice(0, 160);
    } catch { /* optional judge endpoint settings can safely reset to fallback */ }
    // A direct card click is allowed to prioritize one event while the daily
    // batch continues. Coalescing by candidate keeps repeated clicks from
    // starting duplicate GPU generations.
    const directBriefRequests = new Map<string, Promise<IntelligenceModelBrief | null>>();
    const preparedBriefImages = new Map<string, string>();
    const preparedBriefImageInFlight = new Set<string>();
    let selectedInterstellarItem: IntelligenceNewsItem | null = null;
    let standardStatus = "";
    let interstellarStatus = "首版人工基线已建立；候选资讯尚未自动计分。";
    let sourceDirectoryOpen = false;
    let sourceDirectoryQuery = "";
    let sourceDirectoryCatalogue: IntelligenceCatalogSource[] = [];
    let auditStages: IntelligenceAuditStageProjection[] = [];

    const auditController = (): IntelligenceAuditControllerProjection | null => (
      activeRuntime.ReaderIntelligenceAudit?.instance
      ?? activeRuntime.ReaderIntelligenceAudit?.init?.()
      ?? null
    );

    const publishAudit = (summary: string): void => {
      auditController()?.setSnapshot({
        runId: `run-${loadGeneration}-${briefingGeneration}`,
        generatedAt: Date.now(),
        summary,
        stages: auditStages,
      });
    };

    const setAuditStage = (stage: IntelligenceAuditStageProjection): void => {
      auditStages = [...auditStages.filter((candidate) => candidate.id !== stage.id), stage];
    };

    const persistEventDecisionCache = (): void => {
      try {
        const entries = [...eventDecisionCache.entries()].slice(-480).map(([key, value]) => ({ key, ...value }));
        editorialStorage?.setItem(INTELLIGENCE_EVENT_DECISION_CACHE_STORAGE_KEY, JSON.stringify(entries));
      } catch { /* the next run can safely judge an uncached pair again */ }
    };

    const persistArticleTriageCache = (): void => {
      try {
        const entries = [...articleTriageCache.entries()].slice(-4_000).map(([key, value]) => ({ key, ...value }));
        editorialStorage?.setItem(INTELLIGENCE_ARTICLE_TRIAGE_CACHE_STORAGE_KEY, JSON.stringify(entries));
      } catch { /* a later batch can safely re-triage an evicted public item */ }
    };

    const persistEventJudgeSettings = (): void => {
      try {
        editorialStorage?.setItem(INTELLIGENCE_EVENT_JUDGE_SETTINGS_STORAGE_KEY, JSON.stringify({
          baseUrl: text(eventJudgeBaseUrl?.value).slice(0, 500),
          model: text(eventJudgeModel?.value).slice(0, 160),
        }));
      } catch { /* an unavailable WebView storage simply uses the Qwen fallback */ }
    };

    const setStatus = (value: string): void => {
      status.textContent = value;
    };

    const setStandardStatus = (value: string): void => {
      standardStatus = value;
      if (currentLayout !== "interstellar") setStatus(value);
    };

    const setInterstellarStatus = (value: string): void => {
      interstellarStatus = value;
      if (currentLayout === "interstellar") setStatus(value);
    };

    const preparedImageRequest = (candidate: IntelligenceBriefCandidate): UnknownRecord | null => {
      const item = candidate.entry.evidenceItems.find((evidence) => openableHttpsUrl(evidence.url));
      if (!item) return null;
      const fields = item as UnknownRecord;
      const url = openableHttpsUrl(fields.url);
      if (!url) return null;
      return {
        url,
        imageUrl: openableHttpsUrl(fields.imageUrl ?? fields.image_url),
        sourceId: text(fields.sourceId ?? fields.source_id),
        itemId: text(fields.id),
      };
    };

    const preloadPreparedBriefImage = async (candidate: IntelligenceBriefCandidate): Promise<void> => {
      if (!transport || preparedBriefImages.has(candidate.id) || preparedBriefImageInFlight.has(candidate.id)) return;
      const request = preparedImageRequest(candidate);
      if (!request) return;
      preparedBriefImageInFlight.add(candidate.id);
      try {
        const response = record(await transport.invoke<unknown>("newsnow_preview_image", { request }));
        const image = safePreparedImageDataUrl(response?.imageDataUrl ?? response?.image_data_url);
        if (image) preparedBriefImages.set(candidate.id, image);
      } catch {
        // A cover is optional. The prepared text article remains immediately readable.
      } finally {
        preparedBriefImageInFlight.delete(candidate.id);
      }
    };

    const preloadPreparedBriefImages = (candidates: readonly IntelligenceBriefCandidate[]): void => {
      const queue = candidates.filter((candidate) => !preparedBriefImages.has(candidate.id));
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const candidate = queue.shift();
          if (candidate) await preloadPreparedBriefImage(candidate);
        }
      });
      void Promise.all(workers);
    };

    const enrichCurrentCandidates = async (): Promise<void> => {
      if (!transport || currentCandidates.length === 0) return;
      // Every selected source is collected. The native fetcher itself retains
      // a bounded worker pool and an on-disk cache; batching here merely keeps
      // the UI responsive instead of silently dropping all but the first 12.
      const articles = currentCandidates.flatMap((candidate) => candidate.sources.map((source) => ({
        url: source.url, source: source.name, title: source.title, summary: source.summary,
        publishedAt: candidate.publishedAt,
      }))).filter((article) => openableHttpsUrl(article.url)).filter((article, index, all) => (
        all.findIndex((candidate) => candidate.url === article.url) === index
      ));
      if (articles.length === 0) return;
      try {
        const byUrl = new Map<string, UnknownRecord>();
        for (let start = 0; start < articles.length; start += INTELLIGENCE_SOURCE_BATCH_SIZE) {
          const batch = articles.slice(start, start + INTELLIGENCE_SOURCE_BATCH_SIZE);
          const enrichments = await transport.invoke<unknown>("newsnow_intelligence_enrich_articles", { request: { articles: batch } });
          (Array.isArray(enrichments) ? enrichments : []).forEach((value) => {
          const item = record(value); const url = openableHttpsUrl(item?.url);
            if (url && item) byUrl.set(url, item);
          });
        }
        currentCandidates = currentCandidates.map((candidate) => ({ ...candidate, sources: candidate.sources.map((source) => {
          const item = byUrl.get(source.url);
          const body = text(item?.body).slice(0, 14_000);
          const leadImageDataUrl = safePreparedImageDataUrl(item?.leadImageDataUrl ?? item?.lead_image_data_url);
          if (leadImageDataUrl && !preparedBriefImages.has(candidate.id)) preparedBriefImages.set(candidate.id, leadImageDataUrl);
          return { ...source, body, leadImageDataUrl,
            imageUrls: Array.isArray(item?.imageUrls) ? item.imageUrls.map(openableHttpsUrl).filter(Boolean) : [],
            videoUrls: Array.isArray(item?.videoUrls) ? item.videoUrls.map(openableHttpsUrl).filter(Boolean) : [] };
        }) }));
      } catch {
        // The editor still receives the safe RSS fallback when a site blocks extraction.
      }
    };

    // A final event prompt cannot safely contain several complete articles on
    // an 8K local context. Instead Qwen reads every full page in bounded
    // chunks first, then receives the combined evidence from every chunk for
    // the event-level edit. The per-source result is fingerprint-cached, so
    // reopening an unchanged briefing costs no model calls.
    const stableTextFingerprint = (value: string): string => {
      let first = 0x811c9dc5; let second = 0x9e3779b9;
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ (code + index), 0x85ebca6b);
      }
      return `${value.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
    };
    const sourceEvidenceKey = (source: IntelligenceBriefCandidate["sources"][number]): string => (
      `v1:${stableTextFingerprint(`${openableHttpsUrl(source.url)}\u001f${source.title}\u001f${source.body || source.summary}`)}`
    );
    const splitSourceEvidenceChunks = (body: string): string[] => {
      const normalized = body.trim();
      if (!normalized) return [];
      const chunks: string[] = [];
      for (let start = 0; start < normalized.length; start += INTELLIGENCE_SOURCE_EVIDENCE_CHUNK_CHARS) {
        chunks.push(normalized.slice(start, start + INTELLIGENCE_SOURCE_EVIDENCE_CHUNK_CHARS));
      }
      return chunks;
    };
    const persistSourceEvidenceCache = (): void => {
      try {
        const entries = [...sourceEvidenceCache.entries()].slice(-900).map(([key, evidence]) => ({ key, evidence }));
        editorialStorage?.setItem(INTELLIGENCE_SOURCE_EVIDENCE_CACHE_STORAGE_KEY, JSON.stringify(entries));
      } catch { /* cache eviction never blocks a finished briefing */ }
    };
    const extractSourceEvidence = async (source: IntelligenceBriefCandidate["sources"][number]): Promise<string> => {
      const key = sourceEvidenceKey(source);
      const cached = sourceEvidenceCache.get(key);
      if (cached) return cached;
      const chunks = splitSourceEvidenceChunks(source.body || "");
      if (chunks.length === 0 || !transport) return source.summary;
      const evidence: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const response = record(await transport.invoke<unknown>("intelligence_extract_source_evidence", {
          request: { source: source.name, title: source.title, chunk, chunkIndex: index + 1, chunkCount: chunks.length },
        }));
        const item = text(response?.evidence).trim();
        if (item) evidence.push(item);
      }
      // Do not cache a partial model pass: retry it next time rather than
      // presenting a cached article as though every source section was read.
      if (evidence.length !== chunks.length) throw new Error("incomplete source evidence");
      // Preserve an evidence trace from every body chunk instead of keeping
      // only the beginning of a long article. This compact map-reduce output
      // is what the final event pass sees for every selected source.
      const budget = Math.max(80, Math.floor(INTELLIGENCE_SOURCE_EVIDENCE_MAX_CHARS / evidence.length));
      const combined = evidence.map((item) => item.slice(0, budget)).join("\n").slice(0, INTELLIGENCE_SOURCE_EVIDENCE_MAX_CHARS);
      sourceEvidenceCache.set(key, combined);
      persistSourceEvidenceCache();
      return combined;
    };
    const extractEvidenceForCurrentCandidates = async (): Promise<void> => {
      if (!transport || currentCandidates.length === 0) return;
      const allSources = currentCandidates.flatMap((candidate) => candidate.sources)
        .filter((source, index, sources) => sources.findIndex((candidate) => sourceEvidenceKey(candidate) === sourceEvidenceKey(source)) === index);
      let completed = 0;
      const evidenceByKey = new Map<string, string>();
      for (const source of allSources) {
        try {
          evidenceByKey.set(sourceEvidenceKey(source), await extractSourceEvidence(source));
        } catch {
          // A blocked page retains its RSS summary and remains eligible for a
          // later full-text retry; it is never put into the completed cache.
          evidenceByKey.set(sourceEvidenceKey(source), source.summary);
        }
        completed += 1;
        modelStatus.textContent = `正在读取全文并提炼证据 ${completed} / ${allSources.length} 篇…`;
      }
      currentCandidates = currentCandidates.map((candidate) => ({ ...candidate, sources: candidate.sources.map((source) => ({
        ...source, modelEvidence: evidenceByKey.get(sourceEvidenceKey(source)) || source.summary,
      })) }));
    };

    const articleTriageKey = (candidate: IntelligenceBriefCandidate): string => stableEventHash([
      candidate.title, candidate.summary, candidate.publishedAt,
      ...candidate.sources.map((source) => `${source.name}|${source.title}|${source.summary}`),
    ].join("\u001f"));

    const triageCurrentCandidates = async (): Promise<void> => {
      if (!transport || currentCandidates.length === 0) return;
      const before = [...currentCandidates];
      const uncached = before.filter((candidate) => !articleTriageCache.has(articleTriageKey(candidate)));
      const decisions = new Map<string, IntelligenceCachedArticleTriage>();
      before.forEach((candidate) => {
        const cached = articleTriageCache.get(articleTriageKey(candidate));
        if (cached) decisions.set(candidate.id, cached);
      });
      setAuditStage({
        id: "small-model", status: uncached.length > 0 ? "running" : "cached", unit: "articles",
        inputCount: before.length, outputCount: before.length, pendingCount: uncached.length, reusedCount: before.length - uncached.length,
        summary: uncached.length > 0
          ? `本机判定模型正在逐篇初筛 ${uncached.length} 篇新候选；${before.length - uncached.length} 篇复用本地缓存。`
          : `逐篇初筛结果已全部从本地缓存复用（${before.length} 篇）。`,
      });
      publishAudit("先逐篇判断重要性，再召回可能相关的文章对；未初筛通过的文章不会进入合并。");
      for (let start = 0; start < uncached.length; start += INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE) {
        const batch = uncached.slice(start, start + INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE);
        const articles = batch.map((candidate) => ({
          id: candidate.id, title: candidate.title, summary: candidate.summary, publishedAt: candidate.publishedAt,
          sourceNames: candidate.entry.sourceNames.slice(0, 4),
        }));
        try {
          const response = record(await transport.invoke<unknown>("intelligence_triage_articles", {
            request: { articles, baseUrl: text(eventJudgeBaseUrl?.value) || undefined, model: text(eventJudgeModel?.value) || undefined },
          }));
          const rawDecisions = Array.isArray(response?.decisions) ? response.decisions.map(record) : [];
          batch.forEach((candidate) => {
            const raw = rawDecisions.find((value) => text(value?.id) === candidate.id);
            const importance = typeof raw?.importance === "number" && raw.importance >= 0 && raw.importance <= 100 ? Math.floor(raw.importance) : 0;
            const confidence = typeof raw?.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0;
            const topic = text(raw?.topic).slice(0, 80); const reason = text(raw?.reason).slice(0, 320);
            if (!raw || !topic || !reason) return;
            const decision: IntelligenceCachedArticleTriage = { importance, keep: raw.keep === true, confidence, topic, reason,
              primaryEntities: Array.isArray(raw.primaryEntities) ? raw.primaryEntities.map(text).filter(Boolean).slice(0, 8) : [] };
            articleTriageCache.set(articleTriageKey(candidate), decision); decisions.set(candidate.id, decision);
          });
        } catch { /* lack of a judge never becomes a silent rule-based acceptance */ }
      }
      if (uncached.length > 0) persistArticleTriageCache();
      // A missing local triage endpoint during an upgrade must not blank an
      // otherwise usable daily digest. Keep the conservative rule candidates
      // and make the degraded state explicit in the audit instead.
      const triageUnavailable = decisions.size === 0;
      const accepted = (triageUnavailable ? before : before.filter((candidate) => decisions.get(candidate.id)?.keep === true))
        .sort((left, right) => (decisions.get(right.id)?.importance ?? 0) - (decisions.get(left.id)?.importance ?? 0));
      const auditItems = before.slice(0, 40).map((candidate) => {
        const decision = decisions.get(candidate.id);
        return { title: candidate.title, meta: decision ? `${decision.topic} · 重要性 ${decision.importance}` : "本机模型未返回有效结果",
          reason: decision?.reason || "为避免误入简报，未返回有效初筛结果的文章不会进入关系召回。",
          ...(decision?.confidence === undefined ? {} : { confidence: decision.confidence }), status: triageUnavailable ? "warning" as const : decision?.keep ? "accepted" as const : "rejected" as const,
          badge: triageUnavailable ? "等待本机初筛" : decision?.keep ? "进入关系召回" : "不进入简报" };
      });
      setAuditStage({ id: "small-model", status: triageUnavailable ? "warning" : "accepted", unit: "articles",
        inputCount: before.length, outputCount: accepted.length, pendingCount: before.length - decisions.size, reusedCount: before.length - uncached.length,
        summary: triageUnavailable
          ? `本机逐篇初筛暂不可用；为保持原有简报可读性，${before.length} 篇规则候选暂不作文章级排除，等待下次重试。`
          : `逐篇初筛已确认 ${accepted.length} / ${before.length} 篇进入关系召回；未返回有效判断的文章不会自动保留。`, items: auditItems });
      currentCandidates = accepted;
      publishAudit("文章级本机判定完成；下一步只为已保留文章召回关系对。");
    };

    const refineCandidatesWithEventJudge = async (): Promise<void> => {
      if (!transport || currentCandidates.length < 2 || currentCandidates.length > 120) return;
      const before = [...currentCandidates];
      const byId = new Map(before.map((candidate) => [candidate.id, candidate]));
      const decisionCandidateKey = (candidate: IntelligenceBriefCandidate): string => stableEventHash([
        candidate.title,
        candidate.summary,
        ...candidate.sources.map((source) => `${openableHttpsUrl(source.url)}|${source.title}|${source.summary}`),
      ].sort().join("\u001f"));
      const decisionPairKey = (leftId: string, rightId: string): string => {
        const values = [decisionCandidateKey(byId.get(leftId)!), decisionCandidateKey(byId.get(rightId)!)].sort();
        return `pair:${values.join("\u001f")}`;
      };
      const documents = before.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        summary: candidate.summary,
        publishedAt: candidate.publishedAt,
      }));
      const pairKeys = new Map<string, { leftId: string; rightId: string; reason: string }>();
      const keyFor = (leftId: string, rightId: string): string => (
        leftId.localeCompare(rightId, "zh-CN") < 0 ? `${leftId}\u001f${rightId}` : `${rightId}\u001f${leftId}`
      );
      const addPair = (leftId: string, rightId: string, reason: string): void => {
        if (!byId.has(leftId) || !byId.has(rightId) || leftId === rightId) return;
        const key = keyFor(leftId, rightId);
        const existing = pairKeys.get(key);
        pairKeys.set(key, existing ? { ...existing, reason: `${existing.reason} + ${reason}` } : { leftId, rightId, reason });
      };
      buildIntelligenceEventPairCandidates(documents).forEach((pair) => {
        addPair(pair.leftId, pair.rightId, `规则：${pair.reasons.join("、")}`);
      });

      // RAG is retrieval only. Its clusters contribute pair candidates; they
      // never become a merged event until the explicit model response below.
      try {
        const rag = record(await transport.invoke<unknown>("intelligence_cluster_news_semantically", { candidates: documents }));
        const clusters = Array.isArray(rag?.clusters) ? rag.clusters : [];
        clusters.forEach((value) => {
          const ids = Array.isArray(record(value)?.memberIds)
            ? (record(value)?.memberIds as unknown[]).map(text).filter((id) => byId.has(id))
            : [];
          for (let left = 0; left < ids.length; left += 1) {
            for (let right = left + 1; right < ids.length; right += 1) addPair(ids[left]!, ids[right]!, "RAG 相似候选");
          }
        });
      } catch {
        // Retrieval is optional.  Rules can still propose a bounded set, and
        // no retrieval failure is allowed to turn into a heuristic merge.
      }

      const rejected = [] as Array<{ title: string; meta: string; reason: string }>;
      const eligible = [...pairKeys.values()].filter((pair) => {
        const left = byId.get(pair.leftId)!;
        const right = byId.get(pair.rightId)!;
        const veto = vetoImpossibleIntelligenceEventMerge(left, right);
        if (!veto.veto) return true;
        rejected.push({
          title: `${left.title} ↔ ${right.title}`,
          meta: pair.reason,
          reason: `硬冲突：${veto.reason === "distinct-high-signal-entities" ? "主体明确不同" : veto.reason === "conflicting-tickers" ? "股票代码明确不同" : "财报期明确不同"}`,
        });
        return false;
      }).slice(0, INTELLIGENCE_EVENT_JUDGE_MAX_PAIRS);
      setAuditStage({
        id: "candidate-recall", status: "accepted", unit: "pairs", inputCount: before.length, outputCount: eligible.length + rejected.length, pendingCount: eligible.length,
        summary: `规则与 RAG 仅召回 ${eligible.length} 对待核候选；${rejected.length} 对因明确冲突被拦截。`,
        items: [...eligible.map((pair) => ({
          title: `${byId.get(pair.leftId)!.title} ↔ ${byId.get(pair.rightId)!.title}`,
          meta: pair.reason, status: "pending" as const, badge: "待模型核验",
        })), ...rejected.map((item) => ({ ...item, status: "rejected" as const, badge: "硬冲突" }))],
      });
      if (eligible.length === 0) {
        setAuditStage({ id: "small-model", status: "cached", unit: "pairs", inputCount: 0, outputCount: 0, summary: "没有可安全送审的相似候选；保留已通过逐篇初筛的独立事件。" });
        publishAudit("采集、去重与候选召回已完成；没有未经模型确认的自动合并。");
        return;
      }

      const accepted: IntelligenceEventPairDecision[] = [];
      const judgedItems: NonNullable<IntelligenceAuditStageProjection["items"]>[number][] = [];
      const pendingEligible = eligible.filter((pair) => {
        const cached = eventDecisionCache.get(decisionPairKey(pair.leftId, pair.rightId));
        if (!cached) return true;
        const confirmed = cached.sameEvent && cached.confidence >= 0.82;
        judgedItems.push({
          title: `${byId.get(pair.leftId)!.title} ↔ ${byId.get(pair.rightId)!.title}`,
          meta: pair.reason, reason: cached.reason || "已复用本机事件判定缓存。", confidence: cached.confidence,
          status: confirmed ? "accepted" : "cached", badge: confirmed ? "已确认同一事件" : "已复用不同事件",
        });
        if (confirmed) accepted.push({ leftId: pair.leftId, rightId: pair.rightId, sameEvent: true });
        return false;
      });
      setAuditStage({
        id: "small-model", status: pendingEligible.length > 0 ? "running" : "cached", unit: "pairs", inputCount: eligible.length, outputCount: 0, pendingCount: pendingEligible.length, reusedCount: eligible.length - pendingEligible.length,
        summary: pendingEligible.length > 0
          ? `正在由本机事件判定模型核验 ${pendingEligible.length} 对新候选；另有 ${eligible.length - pendingEligible.length} 对复用缓存。`
          : `已复用 ${eligible.length} 对未变化候选的本机事件判定缓存。`,
        items: judgedItems,
      });
      publishAudit("规则/RAG 已召回候选；正在进行严格事件关系判定或复用本机缓存。");
      for (let start = 0; start < pendingEligible.length; start += INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE) {
        const batch = pendingEligible.slice(start, start + INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE);
        const requestPairs = batch.map((pair, index) => {
          const left = byId.get(pair.leftId)!;
          const right = byId.get(pair.rightId)!;
          return {
            id: `pair-${start + index + 1}`,
            left: { id: left.id, title: left.title, summary: left.summary, publishedAt: left.publishedAt, sourceNames: left.entry.sourceNames.slice(0, 4) },
            right: { id: right.id, title: right.title, summary: right.summary, publishedAt: right.publishedAt, sourceNames: right.entry.sourceNames.slice(0, 4) },
          };
        });
        try {
          const response = record(await transport.invoke<unknown>("intelligence_judge_event_pairs", {
            request: {
              pairs: requestPairs,
              baseUrl: text(eventJudgeBaseUrl?.value) || undefined,
              model: text(eventJudgeModel?.value) || undefined,
            },
          }));
          const decisions = Array.isArray(response?.decisions) ? response.decisions.map(record) : [];
          requestPairs.forEach((pair, index) => {
            const raw = decisions.find((item) => text(item?.id) === pair.id);
            const sourcePair = batch[index]!;
            const sameEvent = raw?.sameEvent === true;
            const confidence = typeof raw?.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0;
            const confirmed = sameEvent && confidence >= 0.82;
            const reason = text(raw?.reason) || (raw ? "模型未给出可显示理由" : "模型返回不完整；未合并");
            eventDecisionCache.set(decisionPairKey(sourcePair.leftId, sourcePair.rightId), { sameEvent, confidence, reason });
            judgedItems.push({
              title: `${byId.get(sourcePair.leftId)!.title} ↔ ${byId.get(sourcePair.rightId)!.title}`,
              meta: sourcePair.reason, reason, confidence,
              status: confirmed ? "accepted" : "rejected",
              badge: confirmed ? "同一事件" : sameEvent ? "置信度不足" : "不同事件",
            });
            if (confirmed) accepted.push({ leftId: sourcePair.leftId, rightId: sourcePair.rightId, sameEvent: true });
          });
        } catch {
          batch.forEach((pair) => judgedItems.push({
            title: `${byId.get(pair.leftId)!.title} ↔ ${byId.get(pair.rightId)!.title}`,
            meta: pair.reason, reason: "本机判定模型不可用；为避免误合并，保留为独立事件。",
            status: "warning", badge: "未合并",
          }));
        }
      }
      if (pendingEligible.length > 0) persistEventDecisionCache();
      setAuditStage({
        id: "small-model", status: accepted.length > 0 ? "accepted" : "warning", unit: "pairs", inputCount: eligible.length, outputCount: accepted.length, reusedCount: eligible.length - pendingEligible.length,
        summary: `已核验 ${eligible.length} 对候选，确认 ${accepted.length} 对同一事件；其余全部保留独立。`,
        items: judgedItems,
      });
      const order = new Map(before.map((candidate, index) => [candidate.id, index]));
      const groups = groupIntelligenceEventsByCompleteLinks(before.map((candidate) => candidate.id), accepted);
      const groupedCandidates = groups.map((group) => {
        const members = group.ids.map((id) => byId.get(id)).filter((candidate): candidate is IntelligenceBriefCandidate => Boolean(candidate));
        const position = Math.min(...members.map((member) => order.get(member.id) ?? Number.MAX_SAFE_INTEGER));
        if (members.length === 1) return { position, candidate: members[0]! };
        const representative = members.slice().sort((left, right) => (order.get(left.id)! - order.get(right.id)!))[0]!;
        const sources = members.flatMap((member) => member.sources).filter((source, index, all) => (
          all.findIndex((candidate) => canonicalItemUrl({ url: candidate.url }) === canonicalItemUrl({ url: source.url }) && candidate.name === source.name) === index
        )).slice(0, INTELLIGENCE_EDITORIAL_SOURCES_PER_CANDIDATE);
        const entry: IntelligenceBriefingEntry = {
          ...representative.entry,
          sourceKeys: [...new Set(members.flatMap((member) => member.entry.sourceKeys))],
          sourceNames: [...new Set(members.flatMap((member) => member.entry.sourceNames))],
          evidenceItems: mergeEvidenceItems([], members.flatMap((member) => member.entry.evidenceItems)),
          mergedCount: members.reduce((total, member) => total + member.entry.mergedCount, 0),
        };
        return { position, candidate: { ...representative, id: eventCandidateId(entry), entry, sources } };
      });
      currentCandidates = groupedCandidates
        .sort((left, right) => left.position - right.position)
        .map((group) => group.candidate);
      publishAudit("事件关系判定已完成；只有明确通过的完整关联组进入同一份待编辑报道。");
    };

    const editorialCacheKey = (candidate: IntelligenceBriefCandidate): string => (
      // Candidate ids are generated from each incoming snapshot and cannot be
      // part of persistence. A stable URL + complete-body fingerprint makes
      // unchanged events reusable after later incremental collection.
      `v2:${stableTextFingerprint(candidate.sources.map((source) => `${openableHttpsUrl(source.url)}|${source.title}|${source.body || source.summary}`).sort().join("\u001f"))}`
    );
    const modelCandidateKey = (): string => currentCandidates.map(editorialCacheKey).sort().join("\n");
    const restoreEditorialCache = (): void => {
      const restored = currentCandidates.flatMap((candidate) => {
        const cached = editorialCache.get(editorialCacheKey(candidate));
        // Event ids are only a live-snapshot transport handle. The persisted
        // article is keyed by source URL/body fingerprint, so map its old
        // transient id to this snapshot before the strict renderer validates
        // it. Without this step a true cache hit was silently discarded.
        const cachedBrief = record(cached);
        return cachedBrief
          ? parseIntelligenceModelBriefs(JSON.stringify({ briefs: [{ ...cachedBrief, id: candidate.id }] }), [candidate])
          : [];
      });
      if (restored.length > 0) currentModelBriefs = restored;
    };
    const saveEditorialCache = (candidate: IntelligenceBriefCandidate, brief: IntelligenceModelBrief): void => {
      editorialCache.set(editorialCacheKey(candidate), brief);
      try {
        const entries = [...editorialCache.entries()].slice(-160).map(([key, value]) => ({ key, brief: value }));
        editorialStorage?.setItem(INTELLIGENCE_EDITORIAL_CACHE_STORAGE_KEY, JSON.stringify(entries));
      } catch { /* cache persistence is optional; the daily digest remains intact */ }
    };

    const historicalDigestSummaries = (): IntelligenceDailyDigestSummary[] => (
      dailyDigestHistory.filter((snapshot) => snapshot.day !== localDailyDigestDay())
    );

    const renderDigestHistoryControls = (): void => {
      const summaries = historicalDigestSummaries();
      const values = ["current", ...summaries.map((snapshot) => snapshot.day)];
      if (!values.includes(selectedDigestDay)) selectedDigestDay = "current";
      const options = values.map((value) => {
        const option = root.createElement("option");
        option.value = value;
        const summary = summaries.find((candidate) => candidate.day === value);
        option.textContent = value === "current"
          ? "今天 · 实时简报"
          : `${value} · ${summary?.count ?? 0} 条`;
        return option;
      });
      digestHistoryDate.replaceChildren(...options);
      digestHistoryDate.value = selectedDigestDay;
      const index = values.indexOf(selectedDigestDay);
      digestHistoryPrevious.disabled = index < 0 || index >= values.length - 1;
      digestHistoryNext.disabled = index <= 0;
      const historical = selectedDigestDay !== "current";
      digestHistory.dataset.mode = historical ? "historical" : "live";
      digestHistoryReadonly.hidden = !historical;
      const selected = summaries.find((snapshot) => snapshot.day === selectedDigestDay);
      digestHistorySummary.textContent = historical
        ? `${selected?.day ?? selectedDigestDay} 的 ${selected?.count ?? 0} 条简报已固化；不会随着今天的资讯刷新而变化。`
        : "今天的简报会实时更新；每天结束后会固化为可回顾的只读历史快照。";
    };

    const historyCandidate = (entry: IntelligenceDailyDigestEntry): IntelligenceBriefCandidate => {
      const evidenceItems = entry.evidence.map((source) => ({
        source: source.name,
        title: source.title,
        url: source.url,
        category: entry.category,
        summary: "",
      }));
      const item = evidenceItems[0] ?? {
        source: "本机历史简报",
        title: entry.title,
        url: "",
        category: entry.category,
        summary: entry.summary,
      };
      return {
        id: entry.id,
        entry: {
          item: { ...item, title: entry.title, summary: entry.summary },
          sourceNames: entry.evidence.map((source) => source.name),
          sourceKeys: entry.evidence.map((source) => source.name),
          evidenceItems,
          mergedCount: entry.evidence.length,
          importance: entry.importance,
        },
        title: entry.title,
        summary: entry.summary,
        publishedAt: "",
        sources: entry.evidence,
      };
    };

    const historyModelBrief = (entry: IntelligenceDailyDigestEntry): IntelligenceModelBrief => ({
      id: entry.id,
      importance: entry.importance,
      confidence: entry.confidence,
      priority: entry.priority,
      headline: entry.title,
      summary: entry.summary,
      article: entry.article || [entry.summary, entry.whyItMatters].filter(Boolean).join("\n\n"),
      sourceDifferences: entry.sourceDifferences,
      whyItMatters: entry.whyItMatters,
      reasons: entry.reasons,
      notify: entry.notify,
    });

    const renderHistoricalDigest = (snapshot: IntelligenceDailyDigestSnapshot): void => {
      const candidates = snapshot.entries.map(historyCandidate);
      const briefsById = new Map(snapshot.entries.map((entry) => [entry.id, historyModelBrief(entry)]));
      briefingCount.textContent = `${snapshot.day} · 已固化 ${candidates.length} 条重要资讯${snapshot.model ? ` · ${snapshot.model}` : ""}`;
      const cards = candidates.map((candidate, index) => makeBriefingCard(candidate, briefsById.get(candidate.id) ?? null, index));
      digestList.replaceChildren(...cards);
      signalList.replaceChildren(...candidates.slice(0, 12).map((candidate, index) => makeItemButton(candidate.entry.item, "signal", index)));
      if (candidates.length > 0) selectBriefCandidate(candidates[0]!, briefsById.get(candidates[0]!.id) ?? null, cards[0]);
      if (snapshot.overview) setStandardStatus(`${snapshot.day} 历史简报：${snapshot.overview}`);
    };

    const loadDailyDigestHistory = async (): Promise<void> => {
      if (!transport) return;
      try {
        const summaries = parseIntelligenceDailyDigestSummaries(
          await transport.invoke<unknown>("intelligence_daily_digest_list"),
        );
        dailyDigestHistory = summaries.map((summary) => ({ ...summary, entries: [] }));
      } catch {
        dailyDigestHistory = [];
      }
      renderDigestHistoryControls();
    };

    const restoreCurrentDailyDigest = async (): Promise<boolean> => {
      if (!transport || !modelConfigured || currentCandidates.length === 0) return false;
      try {
        const snapshot = parseIntelligenceDailyDigestSnapshot(await transport.invoke<unknown>(
          "intelligence_daily_digest_get",
          { day: localDailyDigestDay() },
        ));
        // A persisted editorial pass is only reusable for the same active
        // model and the exact current candidate set. This avoids making the
        // 27B repeat 20–30 edits every time a fresh news snapshot is opened,
        // while ensuring an incremental source update always gets re-edited.
        if (!snapshot || !snapshot.model || snapshot.model !== activeModelName) return false;
        const entries = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
        const restored = currentCandidates.map((candidate) => {
          const entry = entries.get(candidate.id);
          if (!entry) return null;
          return {
            id: entry.id,
            importance: entry.importance,
            confidence: entry.confidence,
            priority: entry.priority,
            headline: entry.title,
            summary: entry.summary,
            article: entry.article,
            sourceDifferences: entry.sourceDifferences,
            whyItMatters: entry.whyItMatters,
            reasons: entry.reasons,
            notify: entry.notify,
          } satisfies IntelligenceModelBrief;
        });
        // History written before the current editorial format lacks either a
        // local article or the required per-source difference record. Re-edit
        // today's matching candidates once instead of making an old short
        // form permanent.
        if (
          restored.some((entry) => entry === null || !entry.article)
          || currentCandidates.some((candidate) => (
            entries.get(candidate.id)?.sourceDifferences.length !== candidate.sources.length
          ))
        ) return false;
        currentModelBriefs = restored.filter((entry): entry is IntelligenceModelBrief => entry !== null);
        lastGeneratedCandidateKey = modelCandidateKey();
        modelStatus.textContent = `已复用今日简报 · ${activeModelName}`;
        renderBriefCards();
        return true;
      } catch {
        return false;
      }
    };

    const saveCurrentDailyDigest = async (): Promise<void> => {
      if (!transport || selectedDigestDay !== "current" || currentCandidates.length === 0) return;
      const briefsById = new Map(currentModelBriefs.map((brief) => [brief.id, brief]));
      // A daily history entry is a finished editorial artifact. Persisting
      // rule fallbacks makes an unfinished first pass look permanent on every
      // later open and was the direct source of the raw RSS page shown here.
      if (currentCandidates.some((candidate) => !briefsById.get(candidate.id)?.article)) return;
      const entries = currentCandidates.slice(0, DAILY_DIGEST_DEFAULT_ENTRY_COUNT).map((candidate) => {
        const modelBrief = briefsById.get(candidate.id);
        const importance = modelBrief?.importance ?? Math.min(100, Math.max(0, candidate.entry.importance));
        const priority = modelBrief?.priority ?? (importance >= 85 ? "P0" : importance >= 60 ? "P1" : "P2");
        return {
          id: candidate.id,
          title: modelBrief?.headline || candidate.title,
          summary: modelBrief?.summary || candidate.summary,
          article: modelBrief?.article || [modelBrief?.summary || candidate.summary, modelBrief?.whyItMatters || ""].filter(Boolean).join("\n\n"),
          whyItMatters: modelBrief?.whyItMatters || "由本机规则基于来源覆盖、时效和主题信号保留。",
          importance,
          confidence: modelBrief?.confidence ?? Math.min(0.95, 0.45 + candidate.entry.sourceKeys.length * 0.12),
          priority,
          category: briefingTopicName(candidate.entry.item),
          sourceCount: Math.max(1, candidate.entry.sourceKeys.length),
          reasons: modelBrief?.reasons ?? ["本机规则候选，保留原始证据链接。"],
          notify: modelBrief?.notify === true,
          sourceDifferences: modelBrief?.sourceDifferences ?? [],
          evidence: candidate.sources.map((source) => ({
            source: source.name,
            title: source.title,
            url: source.url,
            publishedAt: candidate.publishedAt,
          })),
        };
      });
      if (entries.length === 0) return;
      try {
        const saved = record(await transport.invoke<unknown>("intelligence_daily_digest_save", {
          request: {
            day: localDailyDigestDay(),
            generatedAt: Date.now(),
            overview: `从 ${currentCandidates.length} 个规则候选中选出 ${entries.length} 条重要资讯。`,
            model: activeModelName,
            entries,
          },
        }));
        const day = intelligenceDigestDay(saved?.day);
        if (day) {
          const summary: IntelligenceDailyDigestSummary = {
            day,
            generatedAt: typeof saved?.generatedAt === "number" ? saved.generatedAt : Date.now(),
            count: typeof saved?.count === "number" ? saved.count : entries.length,
            overview: text(saved?.overview),
            model: text(saved?.model),
          };
          dailyDigestHistory = [
            { ...summary, entries: [] },
            ...dailyDigestHistory.filter((candidate) => candidate.day !== day),
          ];
        }
        renderDigestHistoryControls();
      } catch {
        // The live briefing remains useful even when the optional local archive is unavailable.
      }
    };

    const selectDigestHistoryDay = async (day: string): Promise<void> => {
      if (day === "current") {
        selectedDigestDay = "current";
        renderDigestHistoryControls();
        renderBriefCards();
        return;
      }
      if (!transport) return;
      try {
        const snapshot = parseIntelligenceDailyDigestSnapshot(await transport.invoke<unknown>(
          "intelligence_daily_digest_get",
          { day },
        ));
        if (!snapshot) throw new Error("intelligence-digest-not-found");
        selectedDigestDay = snapshot.day;
        const summaryIndex = dailyDigestHistory.findIndex((candidate) => candidate.day === snapshot.day);
        if (summaryIndex >= 0) dailyDigestHistory[summaryIndex] = snapshot;
        else dailyDigestHistory = [{ ...snapshot }, ...dailyDigestHistory];
        renderDigestHistoryControls();
        renderHistoricalDigest(snapshot);
      } catch {
        setStandardStatus("历史简报暂时无法读取；请稍后重试。");
      }
    };

    const renderBriefCards = (): void => {
      const briefsById = new Map(currentModelBriefs.map((brief) => [brief.id, brief]));
      const hasModelBrief = briefsById.size > 0;
      const visible = currentCandidates.slice(0, DAILY_DIGEST_DEFAULT_ENTRY_COUNT);
      briefingCount.textContent = hasModelBrief
        ? `本机模型已编辑 ${briefsById.size} / ${visible.length} 条重要资讯；其余保留规则摘要。`
        : `规则已筛出 ${visible.length} 条重要资讯；等待本机模型复核。`;
      if (visible.length === 0) {
        const empty = root.createElement("p");
        empty.className = "intelligence-briefing-empty";
        empty.textContent = hasModelBrief
          ? "本机模型未确认达到热点门槛的事件；原始候选仍可在右侧查看。"
          : "当前没有达到规则门槛的候选事件。";
        digestList.replaceChildren(empty);
        return;
      }
      const cards = visible.map((candidate, index) => makeBriefingCard(candidate, briefsById.get(candidate.id) ?? null, index));
      digestList.replaceChildren(...cards);
      selectBriefCandidate(visible[0]!, briefsById.get(visible[0]!.id) ?? null, cards[0]);
      // Covers are fetched after the text cards paint and never block the
      // model pass or an interaction. Once complete, opening a brief needs no
      // upstream network request at all.
      preloadPreparedBriefImages(visible);
    };

    const refreshLocalModelStatus = async (): Promise<void> => {
      if (!transport) return;
      try {
        const value = record(await transport.invoke<unknown>("intelligence_local_model_status"));
        modelConfigured = value?.configured === true;
        activeModelName = text(value?.model);
        if (text(value?.baseUrl)) modelBaseUrl.value = text(value?.baseUrl);
        if (activeModelName) modelName.value = activeModelName;
        modelStatus.textContent = modelConfigured
          ? `已就绪 · ${activeModelName}`
          : "尚未配置本机 Qwen 27B Q3";
      } catch {
        modelConfigured = false;
        modelStatus.textContent = "本机模型状态暂不可用";
      }
    };

    const generateCurrentBrief = async (loadToken: number): Promise<void> => {
      if (!transport || !modelConfigured || selectedDigestDay !== "current" || currentCandidates.length === 0) return;
      await triageCurrentCandidates();
      if (loadToken !== loadGeneration || currentCandidates.length === 0) return;
      await refineCandidatesWithEventJudge();
      await enrichCurrentCandidates();
      await extractEvidenceForCurrentCandidates();
      const candidateKey = modelCandidateKey();
      // A daily snapshot may have the same event ids but older RSS-only
      // evidence. Rebuild from the per-event content fingerprint cache so an
      // updated article is re-edited while unchanged events stay free.
      currentModelBriefs = [];
      restoreEditorialCache();
      if (candidateKey === lastGeneratedCandidateKey) return;
      const pendingCandidates = currentCandidates.filter((candidate) => !currentModelBriefs.some((brief) => brief.id === candidate.id && Boolean(brief.article)));
      if (pendingCandidates.length === 0) {
        lastGeneratedCandidateKey = candidateKey;
        modelStatus.textContent = `已复用本机编辑缓存 · ${activeModelName || "本机 Qwen 27B Q3"}`;
        setAuditStage({ id: "qwen-review", status: "cached", unit: "events", inputCount: currentCandidates.length, outputCount: currentModelBriefs.length, reusedCount: currentModelBriefs.length, summary: "已复用未变化来源的本地 Qwen 综合报道缓存。" });
        setAuditStage({ id: "final-events", status: "accepted", unit: "events", inputCount: currentCandidates.length, outputCount: currentCandidates.length, reusedCount: currentCandidates.length, summary: "已复用已验证的简报事件；新资讯到来前不会再次编辑。" });
        publishAudit("简报已从本地缓存复用；只有新增或正文变化的来源才会重新交给 Qwen。" );
        renderBriefCards();
        return;
      }
      const generation = ++briefingGeneration;
      modelStatus.textContent = `正在由 ${activeModelName || "本机 Qwen 27B Q3"} 编辑 ${pendingCandidates.length} 条新增/更新资讯…`;
      setAuditStage({ id: "qwen-review", status: "running", unit: "events", inputCount: currentCandidates.length, outputCount: 0, pendingCount: pendingCandidates.length, reusedCount: currentCandidates.length - pendingCandidates.length, summary: `Qwen 正在抽检关系判定并基于全文证据编辑 ${pendingCandidates.length} 个新事件。` });
      publishAudit("事件关系已核验；Qwen 正在读取已提炼的全文证据并生成可读报道。" );
      let failedBatches = 0;
      // One event per final pass leaves the 8K local context enough room for
      // the evidence assembled from every full source and a real article.
      for (let start = 0; start < pendingCandidates.length; start += 1) {
        const batch = pendingCandidates.slice(start, start + 1);
        try {
          const response = record(await transport.invoke<unknown>("intelligence_generate_brief", {
            request: {
              candidates: batch.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              summary: candidate.summary,
              publishedAt: candidate.publishedAt,
              sources: candidate.sources.map((source) => ({ ...source, body: source.modelEvidence || source.summary })),
              })),
            },
          }));
          if (generation !== briefingGeneration || loadToken !== loadGeneration || page.hidden || selectedDigestDay !== "current") return;
          const merged = new Map(currentModelBriefs.map((brief) => [brief.id, brief]));
          parseIntelligenceModelBriefs(text(response?.content), batch)
            .forEach((brief) => {
              merged.set(brief.id, brief);
              const candidate = batch.find((item) => item.id === brief.id);
              if (candidate) saveEditorialCache(candidate, brief);
            });
          currentModelBriefs = [...merged.values()];
          modelStatus.textContent = `正在编辑 ${Math.min(start + batch.length, pendingCandidates.length)} / ${pendingCandidates.length} 条新增/更新资讯…`;
          renderBriefCards();
        } catch {
          failedBatches += 1;
        }
      }
      if (generation !== briefingGeneration || loadToken !== loadGeneration || page.hidden || selectedDigestDay !== "current") return;
      const completedCount = currentCandidates.filter((candidate) => (
        currentModelBriefs.some((brief) => brief.id === candidate.id && Boolean(brief.article))
      )).length;
      const completed = completedCount === currentCandidates.length;
      lastGeneratedCandidateKey = completed ? candidateKey : "";
      setAuditStage({
        id: "qwen-review", status: completedCount > 0 ? (completed ? "accepted" : "warning") : "warning", unit: "events", inputCount: currentCandidates.length, outputCount: completedCount, reusedCount: currentCandidates.length - pendingCandidates.length,
        summary: completed ? `Qwen 已完成 ${completedCount} 篇事件级综合报道。` : "Qwen 没有返回可用的综合报道；当前仅保留可核查候选。",
      });
      setAuditStage({
        id: "final-events", status: completed ? "accepted" : "warning", unit: "events", inputCount: currentCandidates.length, outputCount: completedCount,
        summary: completed ? `${currentCandidates.length} 个事件已进入本地每日简报。` : `${completedCount} 个事件已生成；未完成事件仍保留为独立候选。`,
        items: currentCandidates.slice(0, DAILY_DIGEST_DEFAULT_ENTRY_COUNT).map((candidate) => ({
          id: candidate.id, title: candidate.title, sourceCount: candidate.sources.length,
          status: currentModelBriefs.some((brief) => brief.id === candidate.id && Boolean(brief.article)) ? "accepted" : "warning",
          badge: "事件级报道",
        })),
      });
      publishAudit(completed ? "采集、去重、关系判定与 Qwen 复核已完成；可逐阶段人工核查。" : "本轮处理部分完成；未完成项不会被伪装为已整合报道。" );
      modelStatus.textContent = completedCount > 0
        ? `${completed ? "已生成每日简报" : "已生成部分简报"} · ${text(activeModelName) || "本机 Qwen 27B Q3"}${failedBatches > 0 ? `；${failedBatches} 批待重试` : ""}`
        : "本机模型未响应；正在展示规则候选";
      renderBriefCards();
    };

    const setLayout = (layout: IntelligenceLayout): void => {
      currentLayout = layout;
      page.dataset.layout = layout;
      const buttons: ReadonlyArray<readonly [IntelligenceLayout, HTMLButtonElement]> = [
        ["briefing", briefing],
        ["monitor", monitor],
        ["research", research],
        ["interstellar", interstellar],
      ];
      buttons.forEach(([candidate, button]) => {
        button.setAttribute("aria-pressed", String(candidate === layout));
      });
      const showingInterstellar = layout === "interstellar";
      standardView.hidden = sourceDirectoryOpen || showingInterstellar;
      interstellarView.hidden = sourceDirectoryOpen || !showingInterstellar;
      setStatus(showingInterstellar ? interstellarStatus : standardStatus);
    };

    const selectItem = (item: IntelligenceNewsItem): void => {
      selectedItem = item;
      contextTitle.textContent = itemTitle(item);
      contextBody.textContent = itemContext(item);
      contextMeta.textContent = `${text(item.source) || "未知来源"} · ${text(item.category) || "综合"}`;
      contextReasons.replaceChildren();
      contextEvidence.replaceChildren();
      openNews.hidden = false;
      openNews.disabled = openableNewsItem(item) === null;
    };

    const selectBriefCandidate = (
      candidate: IntelligenceBriefCandidate,
      modelBrief: IntelligenceModelBrief | null,
      button?: HTMLButtonElement,
    ): void => {
      selectedItem = null;
      contextTitle.textContent = modelBrief?.headline || candidate.title;
      contextBody.textContent = modelBrief
        ? `${modelBrief.summary}\n${modelBrief.whyItMatters}`
        : candidate.summary || itemContext(candidate.entry.item);
      contextMeta.textContent = modelBrief
        ? `${modelBrief.priority} · 重要性 ${modelBrief.importance} · 可信度 ${Math.round(modelBrief.confidence * 100)}% · ${candidate.entry.sourceKeys.length} 个独立来源`
        : `规则候选 · ${candidate.entry.sourceKeys.length} 个独立来源 · ${candidate.entry.mergedCount} 条原始证据`;
      const reasons = modelBrief?.reasons ?? ["本机模型不可用或未返回有效 JSON；当前只展示规则候选。"];
      contextReasons.replaceChildren(...reasons.map((reason) => {
        const item = root.createElement("li");
        item.textContent = reason;
        return item;
      }));
      const evidence = candidate.sources.map((source) => {
        const url = openableHttpsUrl(source.url);
        if (!url) {
          const item = root.createElement("span");
          item.className = "intelligence-evidence-item";
          item.textContent = `${source.name} · ${source.title}`;
          return item;
        }
        const item = root.createElement("button");
        item.type = "button";
        item.className = "intelligence-evidence-item intelligence-evidence-link";
        item.textContent = `${source.name} · ${source.title}`;
        item.title = "在阅读器中打开此来源";
        item.addEventListener("click", () => {
          openNewsItem({
            source: source.name,
            title: source.title,
            url,
            summary: source.summary,
          }, "打开来源资讯失败，请稍后重试。");
        });
        return item;
      });
      contextEvidence.replaceChildren(...evidence);
      openNews.hidden = true;
      openNews.disabled = true;
      digestList.querySelectorAll(".intelligence-digest-item[aria-current='true']")
        .forEach((current) => current.removeAttribute("aria-current"));
      button?.setAttribute("aria-current", "true");
    };

    function openNewsItem(item: IntelligenceNewsItem, failureMessage: string): void {
      const openable = openableNewsItem(item);
      if (!openable) {
        setStatus("这条来源没有可打开的 HTTPS 原文链接。请改选其它来源证据。");
        return;
      }
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!news?.openItem) {
        setStatus(failureMessage);
        return;
      }
      close({ focus: false });
      void Promise.resolve(news.openItem(openable, { returnToIntelligence: true })).catch(() => {
        void open().then(() => setStatus(failureMessage));
      });
    }

    async function requestDirectBrief(candidate: IntelligenceBriefCandidate): Promise<IntelligenceModelBrief | null> {
      const existingBrief = currentModelBriefs.find((brief) => brief.id === candidate.id && Boolean(brief.article));
      if (existingBrief) return existingBrief;
      const existingRequest = directBriefRequests.get(candidate.id);
      if (existingRequest) return existingRequest;
      if (!transport || !modelConfigured || selectedDigestDay !== "current") {
        setStandardStatus("本机模型当前不可用，无法生成这条综合报道。未展示原始 RSS 片段。");
        return null;
      }
      const request = (async (): Promise<IntelligenceModelBrief | null> => {
        setStandardStatus("正在优先整合这条资讯的多来源报道…");
        if (modelStatus) {
          modelStatus.textContent = `正在优先编辑 1 条资讯 · ${activeModelName || "本机 Qwen 27B Q3"}`;
        }
        try {
          await extractEvidenceForCurrentCandidates();
          const preparedCandidate = currentCandidates.find((item) => item.id === candidate.id) ?? candidate;
          const response = record(await transport.invoke<unknown>("intelligence_generate_brief", {
            request: {
              candidates: [{
                id: preparedCandidate.id,
                title: preparedCandidate.title,
                summary: preparedCandidate.summary,
                publishedAt: preparedCandidate.publishedAt,
                sources: preparedCandidate.sources.map((source) => ({ ...source, body: source.modelEvidence || source.summary })),
              }],
            },
          }));
          const brief = parseIntelligenceModelBriefs(text(response?.content), [candidate])
            .find((result) => result.id === candidate.id) ?? null;
          if (!brief?.article) {
            setStandardStatus("本机模型没有返回可用的中文综合报道；请稍后再试。未展示原始 RSS 片段。");
            return null;
          }
          const merged = new Map(currentModelBriefs.map((result) => [result.id, result]));
          merged.set(brief.id, brief);
          currentModelBriefs = [...merged.values()];
          renderBriefCards();
          return brief;
        } catch {
          setStandardStatus("本机模型整合失败；请稍后再点此简报重试。未展示原始 RSS 片段。");
          return null;
        } finally {
          directBriefRequests.delete(candidate.id);
        }
      })();
      directBriefRequests.set(candidate.id, request);
      return request;
    }

    async function openPreparedBrief(candidate: IntelligenceBriefCandidate, modelBrief: IntelligenceModelBrief | null): Promise<void> {
      const video = candidate.entry.evidenceItems.find((source) => isVideoNewsUrl(source.url));
      if (video) {
        // Videos stay on the existing native-WebView path: the local brief
        // never downloads, transcodes or embeds upstream media.
        openNewsItem(video, "打开视频来源失败，请稍后重试。");
        return;
      }
      const editorialBrief = modelBrief?.article ? modelBrief : await requestDirectBrief(candidate);
      if (!editorialBrief?.article) return;
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!news?.openPreparedArticle) {
        setStatus("本机简报阅读器暂不可用，请稍后重试。");
        return;
      }
      const article = editorialBrief.article;
      const evidence = candidate.sources.map((source) => {
        const title = escapeBriefHtml(source.title);
        const url = openableHttpsUrl(source.url);
        // Prepared briefs stay local until the reader explicitly handles this
        // marker. Do not use a browser target: ReaderNewsUI turns the click
        // into its existing in-app article path.
        const linkedTitle = url
          ? `<a href="${escapeBriefHtml(url)}" data-newsnow-prepared-source-url="${escapeBriefHtml(url)}">${title}</a>`
          : title;
        return `<li><strong>${escapeBriefHtml(source.name)}</strong> · ${linkedTitle}</li>`;
      }).join("");
      const sourceDifferences = editorialBrief.sourceDifferences.map((difference) => (
        `<li><strong>${escapeBriefHtml(difference.source)}</strong><p>${escapeBriefHtml(difference.detail)}</p></li>`
      )).join("");
      const image = preparedBriefImages.get(candidate.id) ?? "";
      const imageHtml = image
        ? `<figure><img src="${image}" alt="${escapeBriefHtml(editorialBrief.headline || candidate.title)}"></figure>`
        : "";
      const paragraphs = article.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean)
        .map((paragraph) => `<p>${escapeBriefHtml(paragraph)}</p>`).join("");
      close({ focus: false });
      news.openPreparedArticle({
        title: editorialBrief.headline || candidate.title,
        source: `本机综合 · ${candidate.entry.sourceKeys.length} 个独立来源`,
        publishedAt: candidate.publishedAt,
        contentHtml: `${imageHtml}<section><h2>综合报道</h2>${paragraphs}${sourceDifferences ? `<h2>各来源的独有信息与差异</h2><ul>${sourceDifferences}</ul>` : ""}<h2>引用来源</h2><ul>${evidence}</ul></section>`,
      }, { returnToIntelligence: true });
    }

    const makeBriefingCard = (
      candidate: IntelligenceBriefCandidate,
      modelBrief: IntelligenceModelBrief | null,
      index: number,
    ): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "intelligence-digest-item intelligence-digest-brief";
      const order = root.createElement("span");
      order.className = "intelligence-digest-index";
      order.textContent = String(index + 1).padStart(2, "0");
      const copy = root.createElement("span");
      copy.className = "intelligence-digest-copy";
      const title = root.createElement("strong");
      title.textContent = modelBrief?.headline || candidate.title;
      const summary = root.createElement("span");
      summary.className = "intelligence-digest-summary";
      summary.textContent = modelBrief?.summary || "正在由本机模型整合多来源报道…";
      const meta = root.createElement("span");
      meta.textContent = modelBrief
        ? `${modelBrief.priority} · 重要性 ${modelBrief.importance} · ${candidate.entry.sourceKeys.length} 个独立来源`
        : `规则候选 · ${candidate.entry.sourceKeys.length} 个独立来源 · ${candidate.entry.mergedCount} 条证据`;
      copy.append(title, summary, meta);
      const type = root.createElement("span");
      type.className = "intelligence-digest-kind";
      type.textContent = briefingTopicName(candidate.entry.item);
      button.append(order, copy, type);
      button.addEventListener("click", () => {
        selectBriefCandidate(candidate, modelBrief, button);
        void openPreparedBrief(candidate, modelBrief);
      });
      return button;
    };

    const makeItemButton = (
      item: IntelligenceNewsItem,
      kind: "digest" | "signal",
      index: number,
      sourceLabel = "",
    ): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = kind === "digest" ? "intelligence-digest-item" : "intelligence-signal";
      const source = text(item.source) || "未知来源";
      const category = text(item.category) || "综合";
      if (kind === "digest") {
        const order = root.createElement("span");
        order.className = "intelligence-digest-index";
        order.textContent = String(index + 1).padStart(2, "0");
        const copy = root.createElement("span");
        copy.className = "intelligence-digest-copy";
        const title = root.createElement("strong");
        title.textContent = itemTitle(item);
        const meta = root.createElement("span");
        meta.textContent = sourceLabel || source;
        copy.append(title, meta);
        const type = root.createElement("span");
        type.className = "intelligence-digest-kind";
        type.textContent = category;
        button.append(order, copy, type);
      } else {
        button.textContent = `${source} · ${category} · ${itemTitle(item)}`;
      }
      button.addEventListener("click", () => {
        selectItem(item);
        digestList.querySelectorAll(".intelligence-digest-item[aria-current='true']")
          .forEach((candidate) => candidate.removeAttribute("aria-current"));
        if (kind === "digest") button.setAttribute("aria-current", "true");
      });
      return button;
    };

    const selectInterstellarCandidate = (
      candidate: InterstellarSignalCandidate,
      button?: HTMLButtonElement,
    ): void => {
      selectedInterstellarItem = candidate.item;
      interstellarContextTitle.textContent = itemTitle(candidate.item);
      const domains = candidate.domains.join("、");
      interstellarContextBody.textContent = `${itemContext(candidate.item)}\n候选领域：${domains}。相关性仅用于进入审核队列，尚未改变进度。`;
      interstellarOpenNews.disabled = false;
      interstellarSignalList.querySelectorAll(".interstellar-candidate[aria-current='true']")
        .forEach((current) => current.removeAttribute("aria-current"));
      button?.setAttribute("aria-current", "true");
    };

    const makeInterstellarCandidateButton = (
      candidate: InterstellarSignalCandidate,
    ): HTMLButtonElement => {
      const button = root.createElement("button");
      button.type = "button";
      button.className = "interstellar-candidate";

      const domain = root.createElement("span");
      domain.className = "interstellar-candidate-domain";
      domain.textContent = candidate.domains[0] ?? "综合";

      const copy = root.createElement("span");
      copy.className = "interstellar-candidate-copy";
      const title = root.createElement("strong");
      title.textContent = itemTitle(candidate.item);
      const meta = root.createElement("span");
      meta.textContent = `${text(candidate.item.source) || "未知来源"} · ${candidate.domains.join(" / ")}`;
      copy.append(title, meta);

      const score = root.createElement("span");
      score.className = "interstellar-candidate-score";
      score.textContent = `相关性 ${candidate.score}`;
      button.append(domain, copy, score);
      button.addEventListener("click", () => {
        selectInterstellarCandidate(candidate, button);
        openNewsItem(candidate.item, "候选资讯详情暂时无法打开。");
      });
      return button;
    };

    const renderInterstellarSignals = (items: IntelligenceNewsItem[]): void => {
      const candidates = classifyInterstellarSignals(items);
      interstellarSignalCount.textContent = `${candidates.length} 条候选信号`;
      setInterstellarStatus(`已从 ${items.length} 条资讯筛出 ${candidates.length} 条候选信号；尚未自动计分。`);
      if (candidates.length === 0) {
        const empty = root.createElement("div");
        empty.className = "interstellar-candidate-empty";
        empty.textContent = "当前已选来源中没有达到相关性门槛的资讯。可在“信息来源”中增加航天、能源、材料与科研来源。";
        interstellarSignalList.replaceChildren(empty);
        selectedInterstellarItem = null;
        interstellarContextTitle.textContent = "尚未发现候选信号";
        interstellarContextBody.textContent = "当前进度仍保留人工基线；没有候选新闻不会降低进度。";
        interstellarOpenNews.disabled = true;
        return;
      }
      const buttons = candidates.map(makeInterstellarCandidateButton);
      interstellarSignalList.replaceChildren(...buttons);
      selectInterstellarCandidate(candidates[0]!, buttons[0]);
    };

    const renderInterstellarSources = (
      result: unknown,
      request: UnknownRecord,
      items: readonly IntelligenceNewsItem[],
    ): void => {
      const catalogue = catalogWithCustomSources(catalogSources(result), request);
      if (catalogue.length === 0) {
        interstellarSourceSummary.textContent = "来源目录暂不可用";
        interstellarSourceNote.textContent = "资讯仍会按当前已选来源加载；恢复目录后会显示来源覆盖。来源本身不会改变进度。";
        interstellarSourceGroups.replaceChildren();
        return;
      }
      const coverage = interstellarSourceCoverage(catalogue, request, items);
      interstellarSourceSummary.textContent = `情报中心已纳入 ${coverage.activeCount} / ${coverage.totalCount} 个来源；${coverage.candidateCount} 个进入星际候选覆盖`;
      interstellarSourceNote.textContent = "情报中心按全目录抓取；候选覆盖只按来源名称、分类、提供方和当前已加载资讯的公开关键词标注，不判断可信度，也不计分。后续本地模型将在此范围内筛选证据、过滤噪声并给出进度建议。";
      const cards = coverage.groups.map((group) => {
        const card = root.createElement("article");
        card.className = "interstellar-source-group";
        const heading = root.createElement("strong");
        heading.textContent = `${group.label} · ${group.sources.length}`;
        const description = root.createElement("span");
        description.textContent = group.description;
        const examples = root.createElement("small");
        examples.textContent = group.sources.slice(0, 3).map((source) => text(source.name) || sourceId(source)).filter(Boolean).join("、");
        card.append(heading, description, examples);
        return card;
      });
      if (cards.length === 0) {
        const empty = root.createElement("div");
        empty.className = "interstellar-source-empty";
        empty.textContent = "当前目录中尚未识别出星际候选覆盖。可在来源管理中增加航天、科研、能源、材料或自主系统来源。";
        interstellarSourceGroups.replaceChildren(empty);
        return;
      }
      interstellarSourceGroups.replaceChildren(...cards);
    };

    const renderSourceDirectory = (): void => {
      const normalizedQuery = sourceDirectoryQuery.trim().toLocaleLowerCase();
      const sources = sourceDirectoryCatalogue.filter((source) => (
        !normalizedQuery || sourceSearchableText(source).includes(normalizedQuery)
      ));
      sourceDirectorySummary.textContent = normalizedQuery
        ? `“${sourceDirectoryQuery.trim()}”匹配 ${sources.length} / ${sourceDirectoryCatalogue.length} 个情报来源。`
        : `情报中心将尝试抓取目录中的 ${sourceDirectoryCatalogue.length} 个公开来源；这里不读取资讯页的个人启用设置。`;
      if (sources.length === 0) {
        const empty = root.createElement("p");
        empty.className = "intelligence-source-directory-empty";
        empty.textContent = "没有匹配的情报来源。可按名称、分类、提供方或类型搜索。";
        sourceDirectoryList.replaceChildren(empty);
        return;
      }
      const cards = sources.map((source) => {
        const card = root.createElement("article");
        card.className = "intelligence-source-directory-item";
        const title = root.createElement("strong");
        title.textContent = text(source.name) || sourceId(source) || "未命名来源";
        const meta = root.createElement("span");
        meta.textContent = [text(source.category) || "综合", text(source.provider), text(source.kind)]
          .filter(Boolean)
          .join(" · ");
        card.append(title, meta);
        return card;
      });
      sourceDirectoryList.replaceChildren(...cards);
    };

    const openSourceDirectory = (): void => {
      sourceDirectoryOpen = true;
      sourceDirectory.hidden = false;
      setLayout(currentLayout);
      renderSourceDirectory();
      setStatus("正在查看情报中心的全目录来源；资讯页的个人来源管理保持独立。");
      sourceDirectorySearch.focus({ preventScroll: true });
    };

    const closeSourceDirectory = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
      sourceDirectoryOpen = false;
      sourceDirectory.hidden = true;
      setLayout(currentLayout);
      if (focus) sourcesButton.focus({ preventScroll: true });
    };

    const render = (
      items: IntelligenceNewsItem[],
      catalogueCount: number,
      attemptedSources: number,
      failedSources: number,
      collectionComplete: boolean,
    ): void => {
      const failedSummary = failedSources > 0 ? `；${failedSources} 个来源暂时不可用` : "";
      renderInterstellarSignals(items);
      const briefingResult = buildIntelligenceBriefing(items);
      auditStages = [];
      setAuditStage({
        id: "collected", status: collectionComplete ? "accepted" : "running", unit: "articles", inputCount: items.length, outputCount: items.length,
        summary: collectionComplete
          ? `已从 ${attemptedSources} 个公开来源写入本机资料快照。`
          : `已从 ${attemptedSources} 个公开来源增量采集，资料库仍在建立。`,
        items: items.slice(0, 20).map((item) => ({
          title: itemTitle(item), meta: `${text(item.source) || "未知来源"} · ${text(item.category) || "综合"}`,
          status: "accepted", badge: "已采集",
        })),
      });
      setAuditStage({
        id: "exact-dedupe", status: "accepted", unit: "articles", inputCount: items.length, outputCount: briefingResult.uniqueCount,
        summary: `按规范 URL 或同一来源同标题精确去重：${items.length} 条变为 ${briefingResult.uniqueCount} 条；不按关键词自动合并。`,
      });
      setAuditStage({
        id: "candidate-recall", status: "pending", unit: "pairs", inputCount: 0, outputCount: 0, pendingCount: briefingResult.visibleEntries.length,
        summary: `等待逐篇初筛后再召回关系对；当前仅标记 ${briefingResult.visibleEntries.length} 篇规则可见文章，尚未代表关系对。`,
      });
      setAuditStage({ id: "small-model", status: "pending", unit: "articles", inputCount: briefingResult.visibleEntries.length, outputCount: 0, pendingCount: briefingResult.visibleEntries.length, summary: "等待本机模型逐篇判断重要性；未通过的文章不会进入关系召回。" });
      setAuditStage({ id: "qwen-review", status: "pending", unit: "events", inputCount: 0, outputCount: 0, summary: "等待关系判定完成后，对边界样本复核并编辑全文证据。" });
      setAuditStage({ id: "final-events", status: "pending", unit: "events", inputCount: 0, outputCount: 0, summary: "等待关系判定与 Qwen 复核完成；不会预先显示未处理事件。" });
      publishAudit("本轮公开资讯已进入可人工核查的本机处理链路。");
      processingSummary.textContent = `已处理 ${items.length} 条 → ${briefingResult.uniqueCount} 个事件 → ${briefingResult.visibleEntries.length} 个候选`;
      const nextCandidates = selectIntelligenceBriefCandidates(briefingResult);
      const nextCandidateKey = nextCandidates.map((candidate) => `${candidate.id}:${candidate.sources.map((source) => `${source.url}|${source.body || source.summary}`).join("\u001f")}`).join("\n");
      if (nextCandidateKey !== modelCandidateKey()) {
        currentModelBriefs = [];
        lastGeneratedCandidateKey = "";
      }
      currentCandidates = nextCandidates;
      if (selectedDigestDay !== "current") return;
      if (items.length === 0 || briefingResult.visibleEntries.length === 0) {
        digestList.replaceChildren();
        signalList.replaceChildren();
        briefingCount.textContent = "当前没有达到规则门槛的候选事件。";
        contextTitle.textContent = items.length === 0 ? "暂无资讯" : "当前没有重要资讯";
        contextBody.textContent = items.length === 0
          ? "请稍后刷新，或前往旧资讯页检查来源设置。"
          : "已收集的资讯均暂未达到默认展示门槛；它们仍保留在本地资料库中，不会被删除。";
        setStandardStatus(items.length === 0
          ? `全量来源本次未返回可展示的资讯${failedSummary}。可稍后刷新查看各来源恢复情况。`
          : `已收集 ${items.length} 条资讯，默认隐藏 ${briefingResult.hiddenCount} 条低优先级资讯；原始证据仍保留${failedSummary}。`);
        return;
      }
      renderBriefCards();
      signalList.replaceChildren(...briefingResult.visibleEntries.slice(0, 12).map((entry, index) => makeItemButton(entry.item, "signal", index)));
      setStandardStatus(collectionComplete
        ? `全目录资料库已完成：覆盖 ${attemptedSources} 个来源，${items.length} 条资讯归并为 ${briefingResult.uniqueCount} 个事件；默认隐藏 ${briefingResult.hiddenCount} 条低优先级资讯${failedSummary}。`
        : `资料库建立中：已覆盖 ${attemptedSources} / ${catalogueCount} 个来源，当前 ${items.length} 条资讯归并为 ${briefingResult.uniqueCount} 个事件${failedSummary}。`);
    };

    const load = async ({ forceRefresh = false }: { readonly forceRefresh?: boolean } = {}): Promise<void> => {
      if (loading) {
        if (cancelledLoadPending && !page.hidden) reloadAfterCancelledLoad = true;
        return;
      }
      if (!transport) {
        setStandardStatus("资讯服务暂不可用，请稍后重试。");
        setInterstellarStatus("候选信号服务暂不可用；首版人工基线仍可查看。");
        return;
      }
      loading = true;
      const generation = ++loadGeneration;
      const isCurrentLoad = (): boolean => generation === loadGeneration && !page.hidden;
      refreshButton.disabled = true;
      try {
        await loadDailyDigestHistory();
        if (!isCurrentLoad()) return;
        await refreshLocalModelStatus();
        if (!isCurrentLoad()) return;
        const persistedRequest = await runtime.ReaderNewsUI?.instance?.sourceRequest?.() ?? {};
        if (!isCurrentLoad()) return;
        const sourceResult = await transport.invoke<unknown>("newsnow_sources");
        if (!isCurrentLoad()) return;
        const catalogue = catalogWithCustomSources(catalogSources(sourceResult), persistedRequest);
        sourceDirectoryCatalogue = catalogue;
        renderSourceDirectory();
        const allSourceIds = catalogue.map(sourceId).filter(Boolean);
        if (allSourceIds.length === 0) throw new Error("intelligence-source-catalog-empty");
        // Intelligence is not the manually curated reading feed. It asks the
        // existing collector to ingest the whole local public catalogue; the
        // ordinary news page keeps its own persisted, smaller selection.
        const request = { ...persistedRequest, sourceIds: allSourceIds, preserveEvidence: true };
        const batches = sourceBatches(allSourceIds);
        const savedSnapshot = await readPersistentSnapshot(transport, runtime.localStorage, allSourceIds);
        if (!isCurrentLoad()) return;
        let collectedItems = savedSnapshot ? [...savedSnapshot.items] : [];
        let attemptedSources = savedSnapshot?.completed
          ? allSourceIds.length
          : (savedSnapshot?.attemptedSources ?? 0);
        let failedSources = savedSnapshot?.failedSources ?? 0;
        const resumingInitialCollection = !savedSnapshot || !savedSnapshot.completed;
        const refreshingCompletedCollection = savedSnapshot?.completed === true
          && (forceRefresh || !hasFreshCompletedSnapshot(savedSnapshot));
        const firstBatch = resumingInitialCollection
          ? Math.min(savedSnapshot?.nextBatch ?? 0, batches.length)
          : (savedSnapshot.nextBatch % batches.length);
        const finalBatchExclusive = resumingInitialCollection
          ? batches.length
          : refreshingCompletedCollection ? firstBatch + 1 : firstBatch;
        const useRefreshCommand = forceRefresh || refreshingCompletedCollection;
        const savedFailureSummary = failedSources > 0 ? `；${failedSources} 个来源暂时不可用` : "";

        if (savedSnapshot) {
          renderInterstellarSources(sourceResult, request, collectedItems);
          render(collectedItems, catalogue.length, attemptedSources, failedSources, savedSnapshot.completed);
          workspaceHydrated = savedSnapshot.completed;
          setStandardStatus(savedSnapshot.completed
            ? refreshingCompletedCollection
              ? `已加载本地资料库（${collectedItems.length} 条资讯${savedFailureSummary}）；正在更新第 ${firstBatch + 1} / ${batches.length} 批来源${forceRefresh ? "" : "（快照已过期）"}…`
              : `已加载完整资料库（${collectedItems.length} 条资讯${savedFailureSummary}）；不会重新抓取，点击“刷新”可更新下一批来源。`
            : `已加载未完成资料库${savedFailureSummary}；将从第 ${firstBatch + 1} / ${batches.length} 批继续采集。`);
          if (savedSnapshot.completed && !refreshingCompletedCollection) {
            await restoreCurrentDailyDigest();
            if (!isCurrentLoad()) return;
            await generateCurrentBrief(generation);
            if (!isCurrentLoad()) return;
            await saveCurrentDailyDigest();
            if (!isCurrentLoad()) return;
          }
        }

        if (refreshingCompletedCollection) failedSources = 0;

        for (let index = firstBatch; index < finalBatchExclusive; index += 1) {
          if (!isCurrentLoad()) return;
          const batchSourceIds = batches[index];
          if (!batchSourceIds) continue;
          setStatus(`正在抓取第 ${index + 1} / ${batches.length} 批（${attemptedSources} / ${allSourceIds.length} 个来源）…`);
          const result = await transport.invoke<unknown>(
            useRefreshCommand ? "newsnow_refresh" : "newsnow_list",
            { request: { ...request, sourceIds: batchSourceIds } },
          );
          if (!isCurrentLoad()) return;
          collectedItems = mergeEvidenceItems(collectedItems, newsItems(result));
          const resultRecord = record(result);
          attemptedSources = resumingInitialCollection
            ? Math.min(allSourceIds.length, attemptedSources + batchSourceIds.length)
            : allSourceIds.length;
          const failedSourceList = resultRecord?.failedSources ?? resultRecord?.failed_sources;
          failedSources += Array.isArray(failedSourceList) ? failedSourceList.length : 0;
          const completed = resumingInitialCollection && index + 1 >= batches.length;
          const snapshot: IntelligenceSnapshot = {
            sourceIds: allSourceIds,
            items: collectedItems,
            attemptedSources: completed ? allSourceIds.length : attemptedSources,
            failedSources,
            nextBatch: index + 1 >= batches.length ? 0 : index + 1,
            completed: savedSnapshot?.completed === true || completed,
            updatedAt: Date.now(),
          };
          const snapshotSaved = await saveSnapshot(runtime.localStorage, transport, snapshot);
          if (!isCurrentLoad()) return;
          renderInterstellarSources(sourceResult, request, collectedItems);
          render(collectedItems, catalogue.length, snapshot.attemptedSources, snapshot.failedSources, snapshot.completed);
          workspaceHydrated = snapshot.completed;
          const failureSummary = snapshot.failedSources > 0
            ? `；${snapshot.failedSources} 个来源暂时不可用`
            : "";
          const persistenceSummary = snapshotSaved
            ? ""
            : "；本机快照未能保存，关闭后会从此批继续采集";
          setStandardStatus(snapshot.completed
            ? `全量资料库已完成：${collectedItems.length} 条去重后资讯已形成综合简报；后续将轮换来源做增量更新${failureSummary}${persistenceSummary}。`
            : snapshotSaved
              ? `已持久化 ${snapshot.attemptedSources} / ${allSourceIds.length} 个来源${failureSummary}：下次会从第 ${snapshot.nextBatch + 1} 批继续。`
              : `本次已处理 ${snapshot.attemptedSources} / ${allSourceIds.length} 个来源${failureSummary}${persistenceSummary}。`);
          if (snapshot.completed) {
            await generateCurrentBrief(generation);
            if (!isCurrentLoad()) return;
            await saveCurrentDailyDigest();
            if (!isCurrentLoad()) return;
          }
        }
      } catch {
        if (isCurrentLoad()) {
          setStandardStatus("全量来源抓取失败，请检查网络后重试。");
          setInterstellarStatus("候选信号加载失败；首版人工基线仍可查看。");
        }
      } finally {
        loading = false;
        refreshButton.disabled = false;
        if (generation !== loadGeneration) {
          const restart = cancelledLoadPending && reloadAfterCancelledLoad && !page.hidden;
          cancelledLoadPending = false;
          reloadAfterCancelledLoad = false;
          if (restart) void load();
        }
      }
    };

    const open = async (): Promise<void> => {
      const newsPage = hiddenElement(root.getElementById("newsnow-page"));
      const newsReader = hiddenElement(root.getElementById("newsnow-reader"));
      if ((newsPage && !newsPage.hidden) || (newsReader && !newsReader.hidden)) {
        runtime.ReaderNewsUI?.instance?.close?.({ focus: false });
      }
      if (!hiddenElement(root.getElementById("library-ai-page"))?.hidden) {
        runtime.ReaderLibraryAiEntry?.close?.();
      }
      if (contentShell) contentShell.hidden = true;
      closeSourceDirectory({ focus: false });
      page.hidden = false;
      root.body.classList.add("intelligence-workspace-active");
      toolbarButton.setAttribute("aria-pressed", "true");
      if (workspaceHydrated && !loading) return;
      await load();
    };

    const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
      if (loading) {
        loadGeneration += 1;
        cancelledLoadPending = true;
      }
      closeSourceDirectory({ focus: false });
      page.hidden = true;
      if (contentShell) contentShell.hidden = false;
      root.body.classList.remove("intelligence-workspace-active");
      toolbarButton.setAttribute("aria-pressed", "false");
      if (focus) toolbarButton.focus({ preventScroll: true });
    };

    toolbarButton.addEventListener("click", () => { void open(); });
    back.addEventListener("click", () => close());
    briefing.addEventListener("click", () => setLayout("briefing"));
    monitor.addEventListener("click", () => setLayout("monitor"));
    research.addEventListener("click", () => setLayout("research"));
    interstellar.addEventListener("click", () => setLayout("interstellar"));
    refreshButton.addEventListener("click", () => { void load({ forceRefresh: true }); });
    digestHistoryDate.addEventListener("change", () => { void selectDigestHistoryDay(digestHistoryDate.value); });
    const moveDigestHistory = (offset: number): void => {
      const values = ["current", ...historicalDigestSummaries().map((snapshot) => snapshot.day)];
      const index = values.indexOf(selectedDigestDay);
      const next = values[index + offset];
      if (next) void selectDigestHistoryDay(next);
    };
    digestHistoryPrevious.addEventListener("click", () => moveDigestHistory(1));
    digestHistoryNext.addEventListener("click", () => moveDigestHistory(-1));
    eventJudgeBaseUrl?.addEventListener("change", persistEventJudgeSettings);
    eventJudgeModel?.addEventListener("change", persistEventJudgeSettings);
    modelSave.addEventListener("click", () => {
      if (!transport) {
        modelStatus.textContent = "本机模型服务暂不可用";
        return;
      }
      void (async () => {
        modelSave.disabled = true;
        try {
          const result = record(await transport!.invoke<unknown>("intelligence_local_model_save", {
            request: {
              baseUrl: modelBaseUrl.value,
              model: modelName.value,
              apiKey: modelKey.value,
            },
          }));
          modelConfigured = result?.configured === true;
          activeModelName = text(result?.model);
          modelKey.value = "";
          lastGeneratedCandidateKey = "";
          currentModelBriefs = [];
          modelStatus.textContent = modelConfigured
            ? `已保存 · ${activeModelName}`
            : "本机模型配置不完整";
          renderBriefCards();
          await generateCurrentBrief(loadGeneration);
          await saveCurrentDailyDigest();
        } catch (error: unknown) {
          modelConfigured = false;
          modelStatus.textContent = `保存失败：${String(error)}`;
        } finally {
          modelSave.disabled = false;
        }
      })();
    });
    sourcesButton.addEventListener("click", openSourceDirectory);
    interstellarManageSources.addEventListener("click", openSourceDirectory);
    sourceDirectoryBack.addEventListener("click", () => closeSourceDirectory());
    sourceDirectorySearch.addEventListener("input", () => {
      sourceDirectoryQuery = sourceDirectorySearch.value;
      renderSourceDirectory();
    });
    openNews.addEventListener("click", () => {
      const item = selectedItem;
      if (item) {
        openNewsItem(item, "旧资讯页暂时无法打开。");
        return;
      }
      const opening = runtime.ReaderNewsUI?.instance?.open;
      if (!opening) {
        setStatus("旧资讯页暂时无法打开。");
        return;
      }
      close({ focus: false });
      void Promise.resolve(opening()).catch(() => {
        void open().then(() => setStatus("旧资讯页暂时无法打开。"));
      });
    });
    interstellarOpenNews.addEventListener("click", () => {
      const item = selectedInterstellarItem;
      if (!item) return;
      openNewsItem(item, "候选资讯详情暂时无法打开。");
    });
    runtime.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || page.hidden) return;
      if (sourceDirectoryOpen) closeSourceDirectory();
      else close();
    });
    setLayout(currentLayout);
    return Object.freeze({ open, close, refresh: load, layout: () => currentLayout });
  };

  const global: IntelligenceWorkspaceGlobal = { init };
  runtime.ReaderIntelligenceWorkspace = global;
  global.instance = init();
  return global;
}
