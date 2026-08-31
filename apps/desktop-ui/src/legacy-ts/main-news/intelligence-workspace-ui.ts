import {
  transportFromTauriGlobal,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type UnknownRecord = Record<string, unknown>;
type IntelligenceLayout = "briefing" | "monitor" | "research" | "interstellar";

// The native collector maintains its own 12-route upstream limit. Keeping the
// workspace batch at the same size yields visible, incremental briefings
// without creating a second burst of hundreds of outbound requests.
const INTELLIGENCE_SOURCE_BATCH_SIZE = 12;
const INTELLIGENCE_SNAPSHOT_STORAGE_KEY = "kunpeng.reader.intelligence.snapshot.v1";
const INTELLIGENCE_SNAPSHOT_VERSION = 1;
const INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS = 700;

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
  readonly mergedCount: number;
  readonly importance: number;
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
  return (sharedTitleTerms >= (sameCategory ? 2 : 3) && titleSimilarity >= (sameCategory ? 0.28 : 0.42))
    || (sameCategory && sharedTerms >= 3 && contextSimilarity >= 0.24 && titleSimilarity >= 0.12)
    || (!sameCategory && sharedTerms >= 5 && contextSimilarity >= 0.3 && titleSimilarity >= 0.25)
    || (sharedTerms >= (sameCategory ? 5 : 6) && contextSimilarity >= (sameCategory ? 0.18 : 0.28));
}

function selectRepresentative(entries: readonly IntelligenceBriefingEntry[]): IntelligenceNewsItem {
  return entries.slice().sort((left, right) => (
    right.sourceNames.length - left.sourceNames.length
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
    .map((entry) => text(entry.item.summary))
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
    const sourceNames = [...new Set(members.flatMap((entry) => entry.sourceNames))];
    const representative = selectRepresentative(members);
    const summary = mergeEventSummary(members, representative);
    const item = summary === text(representative.summary) ? representative : { ...representative, summary };
    return {
      item,
      sourceNames,
      mergedCount: members.reduce((total, entry) => total + entry.mergedCount, 0),
      importance: briefingImportance(item, sourceNames.length),
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
  return entry.sourceNames.length >= 2 || entry.importance >= MIN_VISIBLE_IMPORTANCE;
}

function briefingTopicName(item: IntelligenceNewsItem): string {
  return text(item.category) || "综合";
}

/**
 * The first briefing pass is intentionally local and inspectable: it merges
 * identical headlines across sources, favors independently repeated signals,
 * and groups the surviving evidence by the catalogue's topic. A local model
 * can later replace the ranking/synthesis step without changing collection or
 * evidence links.
 */
export function buildIntelligenceBriefing(
  items: readonly IntelligenceNewsItem[],
): IntelligenceBriefing {
  const byEvidence = new Map<string, IntelligenceNewsItem[]>();
  items.forEach((item) => {
    const key = canonicalItemUrl(item) || normalizedItemTitle(item);
    if (!key) return;
    const existing = byEvidence.get(key) ?? [];
    existing.push(item);
    byEvidence.set(key, existing);
  });
  const headlineEntries = [...byEvidence.values()].map((duplicates) => {
    const sourceNames = [...new Set(duplicates.map((item) => text(item.source)).filter(Boolean))];
    const representative = duplicates.slice().sort((left, right) => (
      text(right.summary).length - text(left.summary).length
      || itemPublishedAt(right) - itemPublishedAt(left)
    ))[0]!;
    return {
      item: representative,
      sourceNames,
      mergedCount: duplicates.length,
      importance: briefingImportance(representative, sourceNames.length),
    };
  });
  const entries = mergeRelatedEventEntries(headlineEntries).sort((left, right) => (
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
    inputCount: items.length,
    uniqueCount: entries.length,
    mergedCount: Math.max(0, items.length - entries.length),
    hiddenCount: entries.length - visibleEntries.length,
  };
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
      readonly openSources?: () => Promise<void> | void;
      readonly sourceRequest?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    };
  };
  readonly ReaderLibraryAiEntry?: { readonly close?: () => void };
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

function count(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function clippedText(value: unknown, limit = INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS): string {
  return text(value).slice(0, limit);
}

function compactSnapshotItem(item: IntelligenceNewsItem): IntelligenceNewsItem {
  const compact: UnknownRecord = {};
  [
    "id", "title", "url", "source", "sourceId", "source_id", "sourceColor", "source_color",
    "summary", "publishedAt", "published_at", "imageUrl", "image_url", "category",
  ].forEach((key) => {
    const value = clippedText(item[key]);
    if (value) compact[key] = value;
  });
  return compact as IntelligenceNewsItem;
}

function compactSnapshotItems(items: readonly IntelligenceNewsItem[]): IntelligenceNewsItem[] {
  return mergeEvidenceItems([], items)
    .map(compactSnapshotItem);
}

function sameSourceDirectory(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((sourceId, index) => sourceId === right[index]);
}

function snapshotFromValue(value: unknown, sourceIds: readonly string[]): IntelligenceSnapshot | null {
  try {
    const saved = record(value);
    if (!saved || count(saved.version) !== INTELLIGENCE_SNAPSHOT_VERSION) return null;
    const savedSourceIds = Array.isArray(saved.sourceIds) ? saved.sourceIds.map(text).filter(Boolean) : [];
    if (!sameSourceDirectory(savedSourceIds, sourceIds)) return null;
    return {
      sourceIds: savedSourceIds,
      items: compactSnapshotItems(newsItems(saved.items)),
      attemptedSources: Math.min(count(saved.attemptedSources), sourceIds.length),
      failedSources: Math.min(count(saved.failedSources), sourceIds.length),
      nextBatch: count(saved.nextBatch),
      completed: saved.completed === true,
      updatedAt: count(saved.updatedAt),
    };
  } catch {
    return null;
  }
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
): Promise<void> {
  const value = {
    version: INTELLIGENCE_SNAPSHOT_VERSION,
    sourceIds: snapshot.sourceIds,
    items: compactSnapshotItems(snapshot.items),
    attemptedSources: snapshot.attemptedSources,
    failedSources: snapshot.failedSources,
    nextBatch: snapshot.nextBatch,
    completed: snapshot.completed,
    updatedAt: snapshot.updatedAt,
  };
  if (storage) {
    try {
      storage.setItem(INTELLIGENCE_SNAPSHOT_STORAGE_KEY, JSON.stringify(value));
    } catch {
      // The native cache below keeps the complete snapshot when WebView local
      // storage has a smaller quota than the full public source directory.
    }
  }
  try {
    await transport.invoke("newsnow_intelligence_snapshot_save", { snapshot: value });
  } catch {
    // The WebView copy remains available when the transient cache write fails.
  }
}

function newsItems(result: unknown): IntelligenceNewsItem[] {
  const resultRecord = record(result);
  const items = Array.isArray(result)
    ? result
    : (Array.isArray(resultRecord?.items) ? resultRecord.items : []);
  return items.map(record).filter((item): item is IntelligenceNewsItem => item !== null);
}

function evidenceKey(item: IntelligenceNewsItem): string {
  const url = canonicalItemUrl(item);
  return url ? `url:${url}` : `title:${normalizedItemTitle(item)}`;
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
  const summary = text(item.summary);
  if (summary) return summary;
  const source = text(item.source) || "未知来源";
  const category = text(item.category) || "综合";
  const url = text(item.url);
  return url ? `${source} · ${category}\n${url}` : `${source} · ${category}`;
}

function waitForWorkspaceFirstPaint(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(done);
      return;
    }
    globalThis.setTimeout(done, 0);
  });
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
    const digestList = requiredElement<HTMLElement>(root, "intelligence-digest-list");
    const signalList = requiredElement<HTMLElement>(root, "intelligence-signal-list");
    const contextTitle = requiredElement<HTMLElement>(root, "intelligence-context-title");
    const contextBody = requiredElement<HTMLElement>(root, "intelligence-context-body");
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
      || !status || !digestList || !signalList || !contextTitle
      || !contextBody || !openNews || !standardView || !interstellarView || !interstellarSignalCount
      || !interstellarSignalList || !interstellarContextTitle || !interstellarContextBody || !interstellarOpenNews
      || !interstellarSourceSummary || !interstellarSourceNote || !interstellarSourceGroups || !interstellarManageSources) {
      return null;
    }

    let currentLayout: IntelligenceLayout = "briefing";
    let loading = false;
    let opening = false;
    let selectedItem: IntelligenceNewsItem | null = null;
    let selectedInterstellarItem: IntelligenceNewsItem | null = null;
    let standardStatus = "";
    let interstellarStatus = "首版人工基线已建立；候选资讯尚未自动计分。";
    let sourceDirectoryOpen = false;
    let sourceDirectoryQuery = "";
    let sourceDirectoryCatalogue: IntelligenceCatalogSource[] = [];
    let latestInterstellarItems: IntelligenceNewsItem[] = [];
    let latestInterstellarSourceInput: {
      readonly result: unknown;
      readonly request: UnknownRecord;
      readonly items: readonly IntelligenceNewsItem[];
    } | null = null;

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
    };

    function openNewsItem(item: IntelligenceNewsItem, failureMessage: string): void {
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!news?.openItem) {
        setStatus(failureMessage);
        return;
      }
      close({ focus: false });
      void Promise.resolve(news.openItem(item, { returnToIntelligence: true })).catch(() => {
        void open().then(() => setStatus(failureMessage));
      });
    }

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
        openNewsItem(item, "资讯详情暂时无法打开。");
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

    const updateInterstellarSources = (
      result: unknown,
      request: UnknownRecord,
      items: readonly IntelligenceNewsItem[],
    ): void => {
      latestInterstellarSourceInput = { result, request, items };
    };

    const renderDeferredInterstellar = (): void => {
      renderInterstellarSignals(latestInterstellarItems);
      if (latestInterstellarSourceInput) {
        renderInterstellarSources(
          latestInterstellarSourceInput.result,
          latestInterstellarSourceInput.request,
          latestInterstellarSourceInput.items,
        );
      }
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
      latestInterstellarItems = items;
      if (currentLayout === "interstellar") renderDeferredInterstellar();
      const briefingResult = buildIntelligenceBriefing(items);
      if (items.length === 0 || briefingResult.visibleEntries.length === 0) {
        digestList.replaceChildren();
        signalList.replaceChildren();
        contextTitle.textContent = items.length === 0 ? "暂无资讯" : "当前没有重要资讯";
        contextBody.textContent = items.length === 0
          ? "请稍后刷新，或前往旧资讯页检查来源设置。"
          : "已收集的资讯均暂未达到默认展示门槛；它们仍保留在本地资料库中，不会被删除。";
        setStandardStatus(items.length === 0
          ? "全量来源本次未返回可展示的资讯。可稍后刷新查看各来源恢复情况。"
          : `已收集 ${items.length} 条资讯，默认隐藏 ${briefingResult.hiddenCount} 条低优先级资讯；原始证据仍保留。`);
        return;
      }
      const digestButtons = briefingResult.topics.map((topic, index) => {
        const lead = topic.entries[0]!;
        const sourceCount = Math.max(1, lead.sourceNames.length);
        const sourceLabel = `${topic.name} · 1 条信息 · ${sourceCount} 个来源`;
        return makeItemButton(lead.item, "digest", index, sourceLabel);
      });
      digestButtons[0]?.setAttribute("aria-current", "true");
      digestList.replaceChildren(...digestButtons);
      signalList.replaceChildren(...briefingResult.visibleEntries.slice(0, 12).map((entry, index) => makeItemButton(entry.item, "signal", index)));
      selectItem(briefingResult.visibleEntries[0]!.item);
      setStandardStatus(collectionComplete
        ? `全目录资料库已完成：覆盖 ${attemptedSources} 个来源，${items.length} 条资讯归并为 ${briefingResult.uniqueCount} 个事件；默认隐藏 ${briefingResult.hiddenCount} 条低优先级资讯。`
        : `资料库建立中：已覆盖 ${attemptedSources} / ${catalogueCount} 个来源，当前 ${items.length} 条资讯归并为 ${briefingResult.uniqueCount} 个事件。`);
    };

    const load = async ({ forceRefresh = false }: { readonly forceRefresh?: boolean } = {}): Promise<void> => {
      if (loading) return;
      if (!transport) {
        setStandardStatus("资讯服务暂不可用，请稍后重试。");
        setInterstellarStatus("候选信号服务暂不可用；首版人工基线仍可查看。");
        return;
      }
      loading = true;
      refreshButton.disabled = true;
      try {
        const persistedRequest = await runtime.ReaderNewsUI?.instance?.sourceRequest?.() ?? {};
        const sourceResult = await transport.invoke<unknown>("newsnow_sources");
        const catalogue = catalogWithCustomSources(catalogSources(sourceResult), persistedRequest);
        sourceDirectoryCatalogue = catalogue;
        if (sourceDirectoryOpen) renderSourceDirectory();
        const allSourceIds = catalogue.map(sourceId).filter(Boolean);
        if (allSourceIds.length === 0) throw new Error("intelligence-source-catalog-empty");
        // Intelligence is not the manually curated reading feed. It asks the
        // existing collector to ingest the whole local public catalogue; the
        // ordinary news page keeps its own persisted, smaller selection.
        const request = { ...persistedRequest, sourceIds: allSourceIds };
        const batches = sourceBatches(allSourceIds);
        const savedSnapshot = await readPersistentSnapshot(transport, runtime.localStorage, allSourceIds);
        let collectedItems = savedSnapshot ? [...savedSnapshot.items] : [];
        let attemptedSources = savedSnapshot?.completed
          ? allSourceIds.length
          : (savedSnapshot?.attemptedSources ?? 0);
        let failedSources = savedSnapshot?.completed ? 0 : (savedSnapshot?.failedSources ?? 0);
        const resumingInitialCollection = !savedSnapshot || !savedSnapshot.completed;
        const refreshingCompletedCollection = savedSnapshot?.completed === true && forceRefresh;
        const firstBatch = resumingInitialCollection
          ? Math.min(savedSnapshot?.nextBatch ?? 0, batches.length)
          : (savedSnapshot.nextBatch % batches.length);
        const finalBatchExclusive = resumingInitialCollection
          ? batches.length
          : refreshingCompletedCollection ? firstBatch + 1 : firstBatch;

        if (savedSnapshot) {
          updateInterstellarSources(sourceResult, request, collectedItems);
          render(collectedItems, catalogue.length, attemptedSources, failedSources, savedSnapshot.completed);
          setStandardStatus(savedSnapshot.completed
            ? refreshingCompletedCollection
              ? `已加载本地资料库（${collectedItems.length} 条资讯）；正在更新第 ${firstBatch + 1} / ${batches.length} 批来源…`
              : `已加载完整资料库（${collectedItems.length} 条资讯）；不会重新抓取，点击“刷新”可更新下一批来源。`
            : `已加载未完成资料库；将从第 ${firstBatch + 1} / ${batches.length} 批继续采集。`);
        }

        for (let index = firstBatch; index < finalBatchExclusive; index += 1) {
          const batchSourceIds = batches[index];
          if (!batchSourceIds) continue;
          setStatus(`正在抓取第 ${index + 1} / ${batches.length} 批（${attemptedSources} / ${allSourceIds.length} 个来源）…`);
          const result = await transport.invoke<unknown>(
            forceRefresh ? "newsnow_refresh" : "newsnow_list",
            { request: { ...request, sourceIds: batchSourceIds } },
          );
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
          await saveSnapshot(runtime.localStorage, transport, snapshot);
          updateInterstellarSources(sourceResult, request, collectedItems);
          render(collectedItems, catalogue.length, snapshot.attemptedSources, snapshot.failedSources, snapshot.completed);
          setStandardStatus(snapshot.completed
            ? `全量资料库已完成：${collectedItems.length} 条去重后资讯已形成综合简报；后续将轮换来源做增量更新。`
            : `已持久化 ${snapshot.attemptedSources} / ${allSourceIds.length} 个来源：下次会从第 ${snapshot.nextBatch + 1} 批继续。`);
        }
      } catch {
        setStandardStatus("全量来源抓取失败，请检查网络后重试。");
        setInterstellarStatus("候选信号加载失败；首版人工基线仍可查看。");
      } finally {
        loading = false;
        refreshButton.disabled = false;
      }
    };

    const open = async (): Promise<void> => {
      if (opening || !page.hidden) return;
      opening = true;
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
      setStandardStatus("正在打开情报中心…");
      refreshButton.disabled = true;
      try {
        await waitForWorkspaceFirstPaint();
        if (!page.hidden) await load();
      } finally {
        opening = false;
        if (!loading) refreshButton.disabled = false;
      }
    };

    const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
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
    interstellar.addEventListener("click", () => {
      setLayout("interstellar");
      renderDeferredInterstellar();
    });
    refreshButton.addEventListener("click", () => { void load({ forceRefresh: true }); });
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
