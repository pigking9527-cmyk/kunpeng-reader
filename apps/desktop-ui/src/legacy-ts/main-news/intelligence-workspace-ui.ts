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
import {
  chunkIntelligencePipelineArticles,
  emptyIntelligencePipelineState,
  intelligencePipelineArticleId,
  intelligencePipelineFingerprint,
  parseIntelligenceRelation,
  projectStableIntelligenceEvents,
  reduceIntelligencePipelineState,
  runIntelligenceArticleTriageQueue,
  type IntelligencePipelineArticle,
  type IntelligencePipelinePort,
  type IntelligencePipelineStageId,
  type IntelligencePipelineState,
  type IntelligencePipelineRelationDecision,
  type IntelligenceStoredTriageDecision,
} from "./intelligence-pipeline-state.ts";
import {
  isFavorite,
  listFavorites,
  toggleFavorite,
  type FavoriteRecordInput,
  type NewsFavoriteRecord,
} from "../main-favorites/favorites-store.ts";

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
// Scores are a disposable display-order cache.  They contain only opaque
// local IDs and bounded integer scores, never source URLs, account data, or
// formal-publication text.
const INTELLIGENCE_NEWS_PREFERENCE_SCORE_CACHE_STORAGE_KEY = "kunpeng.reader.intelligence.news-preference-scores.v1";
const INTELLIGENCE_EVENT_JUDGE_SETTINGS_STORAGE_KEY = "kunpeng.reader.intelligence.event-judge-settings.v1";
const INTELLIGENCE_EVENT_JUDGE_DEFAULT_BASE_URL = "http://127.0.0.1:8081/v1";
const INTELLIGENCE_EVENT_JUDGE_DEFAULT_MODEL = "Qwen3-8B-Q4_K_M";
const INTELLIGENCE_QWEN_27B_16GB_MODEL_ID = "Qwen3.8-27B-UD-Q3_K_XL";
const INTELLIGENCE_SNAPSHOT_VERSION = 1;
const INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS = 700;
// The native cache accepts up to 24 MiB. Keep a deliberately lower client
// budget so a growing public catalogue never turns a successful incremental
// collection into an invisible save failure and a later full re-fetch.
const INTELLIGENCE_SNAPSHOT_MAX_ITEMS = 12_000;
const INTELLIGENCE_SNAPSHOT_MAX_SERIALIZED_BYTES = 20 * 1024 * 1024;
const INTELLIGENCE_COMPLETED_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1_000;
// 2,000 UTF-16 code units still fit under Rust's 7 KiB UTF-8 request bound
// for Chinese text (the densest common case), while avoiding the local
// model's 8K context limit after system instructions and completion room.
const INTELLIGENCE_SOURCE_EVIDENCE_CHUNK_CHARS = 2_000;
const INTELLIGENCE_SOURCE_EVIDENCE_MIN_CHARS = 240;
const INTELLIGENCE_SOURCE_EVIDENCE_MAX_CHARS = 1_200;
// The pair judge is intentionally serial and bounded.  A relationship that
// was not explicitly judged never becomes an automatic event merge.
const INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE = 4;
const INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE = 12;
const INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE = 256;
// Keep relation requests far below the native 2,000-pair safety ceiling. This
// also gives the renderer and the persistent audit store a chance to advance
// between batches when a catalogue contains thousands of near neighbours.
const INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE = 48;
const INTELLIGENCE_QWEN_REVIEW_SAMPLE_MODULUS = 20;
const INTELLIGENCE_QWEN_REVIEW_MAX_PER_LAYER = 50;
const INTELLIGENCE_PREPARED_IMAGE_LIMIT = 12;
const INTELLIGENCE_DEGRADED_EVIDENCE_RETRY_MS = 30 * 60 * 1_000;
const INTELLIGENCE_AUDIT_LIVE_REFRESH_MS = 3_000;
const INTELLIGENCE_TRIAGE_LEASE_SECONDS = 180;
const INTELLIGENCE_PIPELINE_RETRY_DELAYS_MS = Object.freeze([
  (INTELLIGENCE_TRIAGE_LEASE_SECONDS * 1_000) + 5_000,
  5 * 60 * 1_000,
  15 * 60 * 1_000,
] as const);
const INTELLIGENCE_PIPELINE_PROMPT_VERSION = "article-triage-v2";
const INTELLIGENCE_RELATION_PROMPT_VERSION = "relation-judge-v2-eight-class";
const INTELLIGENCE_EDITORIAL_PROMPT_VERSION = "event-editor-v3-full-source-map-reduce";
const INTELLIGENCE_NEWS_PREFERENCE_MAX_FAVORITES = 24;
const INTELLIGENCE_NEWS_PREFERENCE_MAX_EVENTS = 24;

/**
 * The SQLite quality gate is the authority for relation-review coverage.  Do
 * not reintroduce a UI-only 20%/5% policy here: a missing or malformed gate
 * projection deliberately fails closed to full review.
 */
export interface IntelligenceRelationReviewCandidate {
  readonly id: string;
  readonly sampleKey?: string;
  readonly important: boolean;
  readonly conflicting: boolean;
  readonly lowConfidence: boolean;
}

function deterministicReviewSampleRank(sampleKey: string): string {
  return intelligencePipelineFingerprint(sampleKey);
}

/**
 * Selects the 27B relation-review queue without mutating it. During initial
 * calibration and every quality fallback, *every* pair goes to 27B. Once the
 * persisted gate has entered sampled mode, all important/conflicting/low-
 * confidence pairs still go, plus a stable >=10% ordinary sample.
 */
export function selectIntelligenceRelationReviewIds(
  candidates: readonly IntelligenceRelationReviewCandidate[],
  reviewMode: unknown,
): readonly string[] {
  const sampledMode = reviewMode === "sample";
  const selected = new Set<string>();
  const uniqueCandidates: IntelligenceRelationReviewCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.id || uniqueCandidates.some((value) => value.id === candidate.id)) continue;
    uniqueCandidates.push(candidate);
  }
  if (!sampledMode) return uniqueCandidates.map((candidate) => candidate.id);

  const ordinary: IntelligenceRelationReviewCandidate[] = [];
  for (const candidate of uniqueCandidates) {
    const mustReview = !sampledMode
      || candidate.important
      || candidate.conflicting
      || candidate.lowConfidence;
    if (mustReview) selected.add(candidate.id);
    else ordinary.push(candidate);
  }
  // Ranking, rather than a simple `hash % 10`, makes the lower bound true for
  // every finite batch. The selected ordinary records are still stable across
  // reloads/retries and cannot be influenced by UI ordering.
  const requiredSampleCount = Math.min(ordinary.length, Math.ceil(uniqueCandidates.length * 0.10));
  ordinary
    .slice()
    .sort((left, right) => deterministicReviewSampleRank(left.sampleKey || left.id)
      .localeCompare(deterministicReviewSampleRank(right.sampleKey || right.id))
      || left.id.localeCompare(right.id))
    .slice(0, requiredSampleCount)
    .forEach((candidate) => selected.add(candidate.id));
  return [...selected];
}

export function intelligencePipelineRetryDelayMs(attempt: number): number | null {
  const index = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  return INTELLIGENCE_PIPELINE_RETRY_DELAYS_MS[index] ?? null;
}

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
  readonly eventId?: string;
  readonly seriesId?: string;
  readonly revision?: number;
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
    readonly evidenceFingerprint?: string;
    readonly evidenceDegraded?: boolean;
    readonly retryAfter?: number;
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

/** Native V1 cache projection. It deliberately has no endpoint, credential,
 * cache path, delivery acknowledgement or unverified bundle JSON. */
interface IntelligenceClientCacheStatus {
  readonly cachePresent: boolean;
  readonly publicationCount: number;
  readonly unacknowledgedCount: number;
  readonly deliveryState: "not_refreshed" | "refreshing" | "server_empty" | "ready" | "login_required" | "permission_required" | "delivery_failed";
  readonly lastAttemptAt: number;
  readonly lastSuccessAt: number;
  readonly lastRefreshAt: number;
  readonly lastFetched: number;
  readonly lastPersisted: number;
  readonly lastAcknowledged: number;
  readonly sseState: "not_started" | "connecting" | "connected" | "reconnecting" | "login_required" | "permission_required";
  readonly lastSseAt: number;
}

interface IntelligenceClientCachedSource {
  readonly noteId: string;
  readonly publisher: string;
  readonly title: string;
  readonly originalUrl: string;
  readonly publishedAt: string;
  readonly fallbackExcerpt: string;
}

interface IntelligenceClientCachedSegment {
  readonly text: string;
  readonly noteIds: readonly string[];
}

interface IntelligenceClientCachedMedia {
  readonly assetId: string;
  readonly sha256: string;
  readonly mime: "image/jpeg" | "image/png" | "image/webp";
  readonly bytes: number;
  readonly cached: boolean;
  readonly videoUrl?: string;
}

interface IntelligenceClientCachedEvent {
  readonly eventId: string;
  readonly revisionNo: number;
  readonly seriesId?: string;
  readonly title: string;
  readonly occurredAt?: string;
  readonly body: string;
  readonly segments: readonly IntelligenceClientCachedSegment[];
  readonly media: readonly IntelligenceClientCachedMedia[];
  readonly sources: readonly IntelligenceClientCachedSource[];
}

interface IntelligenceClientCachedPublication {
  readonly publicationId: string;
  readonly kind: "event" | "daily";
  readonly publishedAt: string;
  readonly expiresAt: string;
  readonly importance: number;
  readonly events: readonly IntelligenceClientCachedEvent[];
}

interface FormalPublicationEvent {
  readonly publication: IntelligenceClientCachedPublication;
  readonly event: IntelligenceClientCachedEvent;
}

interface NewsPreferenceFavoriteInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
}

interface NewsPreferenceEventInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly sourceNames: readonly string[];
}

interface NewsPreferenceScoreResult {
  readonly id: string;
  readonly score: number;
}

interface NewsPreferenceScoreCache {
  readonly version: 1;
  readonly key: string;
  readonly scores: readonly NewsPreferenceScoreResult[];
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
  return [...bySource.values()].map((item) => ({
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
  return briefingCandidatesForEntries(briefing.visibleEntries, limit);
}

function briefingCandidatesForEntries(
  entries: readonly IntelligenceBriefingEntry[],
  limit = Number.MAX_SAFE_INTEGER,
): IntelligenceBriefCandidate[] {
  return entries.slice(0, Math.max(0, limit)).map((entry) => ({
    id: eventCandidateId(entry),
    entry,
    title: itemTitle(entry.item).slice(0, 280),
    summary: text(entry.item.summary).slice(0, INTELLIGENCE_SNAPSHOT_MAX_TEXT_CHARS),
    publishedAt: publishedAtText(entry.item).slice(0, 80),
    sources: editorialCandidateSources(entry),
  }));
}

function pipelineArticleForEntry(entry: IntelligenceBriefingEntry): IntelligencePipelineArticle {
  const candidate = briefingCandidatesForEntries([entry], 1)[0]!;
  const item = entry.item as UnknownRecord;
  const url = canonicalItemUrl(entry.item);
  const sourceKey = sourceEvidenceKey(entry.item);
  const title = candidate.title;
  const summary = candidate.summary;
  const publishedAt = candidate.publishedAt;
  const media = {
    imageUrl: openableHttpsUrl(item.imageUrl ?? item.image_url),
    videoUrl: openableHttpsUrl(item.videoUrl ?? item.video_url),
  };
  const fingerprintSource = [
    url,
    sourceKey,
    normalizedItemTitle(entry.item),
    title,
    summary,
    publishedAt,
  ].join("\u001f");
  return {
    articleId: intelligencePipelineArticleId(url, sourceKey, normalizedItemTitle(entry.item)),
    fingerprint: intelligencePipelineFingerprint(fingerprintSource),
    ...(url ? { url } : {}),
    ...(sourceKey ? { sourceKey } : {}),
    sourceName: text(entry.item.source) || sourceKey || "未知来源",
    title,
    ...(summary ? { summary } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    language: /\p{Script=Han}/u.test(`${title}${summary}`) ? "zh" : "en",
    ...(media.imageUrl || media.videoUrl ? { mediaJson: JSON.stringify(media) } : {}),
  };
}

/** Reconstructs the exact queue identity/fingerprint for one raw evidence item. */
function pipelineArticleForEvidenceItem(item: IntelligenceNewsItem): IntelligencePipelineArticle {
  const sourceKey = sourceEvidenceKey(item);
  const computed = pipelineArticleForEntry({
    item,
    sourceNames: [text(item.source) || sourceKey || "未知来源"],
    sourceKeys: [sourceKey],
    evidenceItems: [item],
    mergedCount: 1,
    importance: briefingImportance(item, 1),
  });
  // Event-source hydration comes from SQLite and carries the exact identity
  // originally used by the persistent queue. Prefer it over reconstructing a
  // source key that may no longer be present in today's RSS projection.
  const fields = item as UnknownRecord;
  return {
    ...computed,
    ...(text(fields.articleId ?? fields.article_id) ? { articleId: text(fields.articleId ?? fields.article_id) } : {}),
    ...(text(fields.recordFingerprint ?? fields.record_fingerprint)
      ? { fingerprint: text(fields.recordFingerprint ?? fields.record_fingerprint) }
      : {}),
  };
}

function pipelineArticlesForBriefing(briefing: IntelligenceBriefing): IntelligencePipelineArticle[] {
  return briefing.entries.map(pipelineArticleForEntry);
}

function pipelineCandidatesByArticleId(
  briefing: IntelligenceBriefing,
): ReadonlyMap<string, IntelligenceBriefCandidate> {
  const candidates = briefingCandidatesForEntries(briefing.entries);
  return new Map(briefing.entries.map((entry, index) => [
    pipelineArticleForEntry(entry).articleId,
    candidates[index]!,
  ]));
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
  readonly openStoredEvent: (eventId: string, revision?: string) => Promise<boolean>;
  readonly openFavorite: (favorite: NewsFavoriteRecord) => Promise<boolean>;
}

export interface IntelligenceWorkspaceGlobal {
  readonly init: () => IntelligenceWorkspaceController | null;
  instance?: IntelligenceWorkspaceController | null;
}

type IntelligenceAuditStatus = "pending" | "running" | "accepted" | "rejected" | "warning" | "cached";

interface IntelligenceAuditStageProjection {
  readonly id: IntelligencePipelineStageId;
  readonly status: IntelligenceAuditStatus;
  readonly summary: string;
  readonly count?: number;
  readonly unit?: "articles" | "pairs" | "events" | "series";
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
  readonly setDetailLoader?: (loader: (request: {
    readonly runId: string;
    readonly stageId: IntelligencePipelineStageId;
    readonly offset: number;
    readonly limit: number;
  }) => Promise<{
    readonly total: number;
    readonly items: NonNullable<IntelligenceAuditStageProjection["items"]>;
  }>) => void;
}

interface IntelligenceCachedArticleTriage {
  readonly importance: number;
  readonly keep: boolean;
  readonly confidence: number;
  readonly topic: string;
  readonly primaryEntities: readonly string[];
  readonly reason: string;
}

interface IntelligenceStoredEventProjection {
  readonly articleId: string;
  readonly eventId: string;
  readonly seriesId?: string;
  readonly revision: number;
  readonly title?: string;
  readonly summary?: string;
  readonly occurredAt?: string;
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
          readonly eventId?: string;
          readonly revision?: number;
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
  dispatchEvent?(event: Event): boolean;
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

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}


function clientCacheStatus(value: unknown): IntelligenceClientCacheStatus | null {
  const source = record(value);
  const cachePresent = source?.cachePresent;
  const publicationCount = source?.publicationCount;
  const unacknowledgedCount = source?.unacknowledgedCount;
  const lastRefreshAt = source?.lastRefreshAt;
  if (typeof cachePresent !== "boolean"
    || typeof publicationCount !== "number" || !Number.isInteger(publicationCount) || publicationCount < 0
    || typeof unacknowledgedCount !== "number" || !Number.isInteger(unacknowledgedCount) || unacknowledgedCount < 0
    || typeof lastRefreshAt !== "number" || !Number.isFinite(lastRefreshAt) || lastRefreshAt < 0) return null;
  const deliveryState = text(source?.deliveryState);
  const sseState = text(source?.sseState);
  const integerAt = (key: string): number => {
    const candidate = source?.[key];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
  };
  const delivery = ["not_refreshed", "refreshing", "server_empty", "ready", "login_required", "permission_required", "delivery_failed"].includes(deliveryState)
    ? deliveryState as IntelligenceClientCacheStatus["deliveryState"]
    : lastRefreshAt > 0 ? (cachePresent ? "ready" : "server_empty") : "not_refreshed";
  const sse = ["not_started", "connecting", "connected", "reconnecting", "login_required", "permission_required"].includes(sseState)
    ? sseState as IntelligenceClientCacheStatus["sseState"]
    : "not_started";
  return {
    cachePresent,
    publicationCount,
    unacknowledgedCount,
    deliveryState: delivery,
    lastAttemptAt: integerAt("lastAttemptAt"),
    lastSuccessAt: integerAt("lastSuccessAt") || lastRefreshAt,
    lastRefreshAt,
    lastFetched: integerAt("lastFetched"),
    lastPersisted: integerAt("lastPersisted"),
    lastAcknowledged: integerAt("lastAcknowledged"),
    sseState: sse,
    lastSseAt: integerAt("lastSseAt"),
  };
}

function clientCachedPublications(value: unknown): IntelligenceClientCachedPublication[] | null {
  if (!Array.isArray(value)) return null;
  const publications: IntelligenceClientCachedPublication[] = [];
  for (const rawPublication of value) {
    const publication = record(rawPublication);
    const publicationId = text(publication?.publicationId);
    const kind = text(publication?.kind);
    const publishedAt = text(publication?.publishedAt);
    const expiresAt = text(publication?.expiresAt);
    const importance = publication?.importance;
    const rawEvents = Array.isArray(publication?.events) ? publication?.events : null;
    if (!publicationId || !publishedAt || !expiresAt || typeof importance !== "number" || !Number.isInteger(importance) || importance < 0 || importance > 100 || !rawEvents
      || (kind !== "event" && kind !== "daily")) return null;
    const events: IntelligenceClientCachedEvent[] = [];
    for (const rawEvent of rawEvents) {
      const event = record(rawEvent);
      const eventId = text(event?.eventId);
      const revisionNo = event?.revisionNo;
      const title = text(event?.title);
      const body = text(event?.body);
      const rawSegments = Array.isArray(event?.segments) ? event?.segments : null;
      const rawMedia = Array.isArray(event?.media) ? event?.media : null;
      const rawSources = Array.isArray(event?.sources) ? event?.sources : null;
      if (!eventId || typeof revisionNo !== "number" || !Number.isInteger(revisionNo) || revisionNo < 1 || !title || !body || !rawSegments || !rawMedia || !rawSources) return null;
      const sources: IntelligenceClientCachedSource[] = [];
      for (const rawSource of rawSources) {
        const source = record(rawSource);
        const noteId = text(source?.noteId);
        const publisher = text(source?.publisher);
        const sourceTitle = text(source?.title);
        const originalUrl = openableHttpsUrl(source?.originalUrl);
        const sourcePublishedAt = text(source?.publishedAt);
        const fallbackExcerpt = text(source?.fallbackExcerpt);
        if (!noteId || !publisher || !sourceTitle || !originalUrl || !sourcePublishedAt || !fallbackExcerpt) return null;
        sources.push({
          noteId,
          publisher,
          title: sourceTitle,
          originalUrl,
          publishedAt: sourcePublishedAt,
          fallbackExcerpt,
        });
      }
      if (sources.length === 0 || new Set(sources.map((source) => source.noteId)).size !== sources.length) return null;
      const sourceNoteIds = new Set(sources.map((source) => source.noteId));
      const segments: IntelligenceClientCachedSegment[] = [];
      for (const rawSegment of rawSegments) {
        const segment = record(rawSegment);
        const segmentText = text(segment?.text);
        const noteIds = Array.isArray(segment?.noteIds) ? segment?.noteIds.map(text) : [];
        if (!segmentText || noteIds.length === 0 || noteIds.some((noteId) => !noteId || !sourceNoteIds.has(noteId))) return null;
        segments.push({ text: segmentText, noteIds });
      }
      if (segments.length === 0 || segments.map((segment) => segment.text).join("\n\n") !== body) return null;
      const media: IntelligenceClientCachedMedia[] = [];
      for (const rawMediaItem of rawMedia) {
        const item = record(rawMediaItem);
        const assetId = text(item?.assetId);
        const sha256 = text(item?.sha256);
        const mime = text(item?.mime);
        const bytes = item?.bytes;
        const cached = item?.cached;
        const videoUrl = openableHttpsUrl(item?.videoUrl);
        if (!assetId || !/^[a-z0-9._:-]{1,128}$/iu.test(assetId)
          || !/^[a-f0-9]{64}$/u.test(sha256)
          || !(mime === "image/jpeg" || mime === "image/png" || mime === "image/webp")
          || typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 1
          || typeof cached !== "boolean") return null;
        media.push({ assetId, sha256, mime, bytes, cached, ...(videoUrl ? { videoUrl } : {}) });
      }
      events.push({
        eventId,
        revisionNo,
        ...(text(event?.seriesId) ? { seriesId: text(event?.seriesId) } : {}),
        title,
        ...(text(event?.occurredAt) ? { occurredAt: text(event?.occurredAt) } : {}),
        body,
        segments,
        media,
        sources,
      });
    }
    publications.push({ publicationId, kind, publishedAt, expiresAt, importance, events });
  }
  return publications;
}

/** Keep model input under the native byte limit without splitting a character. */
function utf8Prefix(value: unknown, maximumBytes: number): string {
  const source = text(value);
  if (!source || maximumBytes <= 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(source).byteLength <= maximumBytes) return source;
  let output = "";
  for (const character of source) {
    const candidate = output + character;
    if (encoder.encode(candidate).byteLength > maximumBytes) break;
    output = candidate;
  }
  return output;
}

/** Native preference IDs intentionally reveal neither event IDs nor URLs. */
function opaquePreferenceId(prefix: string, value: string): string {
  const hash = (seed: number): string => {
    let current = seed;
    for (let index = 0; index < value.length; index += 1) {
      current = Math.imul(current ^ value.charCodeAt(index), 16_777_619);
    }
    return (current >>> 0).toString(16).padStart(8, "0");
  };
  return `${prefix}-${hash(2_166_136_261)}${hash(2_167_136_261)}`;
}

function preferenceEventsForPublications(
  publications: readonly IntelligenceClientCachedPublication[],
): Array<FormalPublicationEvent & { readonly preference: NewsPreferenceEventInput }> {
  return publications
    .flatMap((publication) => publication.events.map((event) => {
      const identity = `${publication.publicationId}\u001f${event.eventId}\u001f${event.revisionNo}`;
      return {
        publication,
        event,
        preference: {
          id: opaquePreferenceId("event", identity),
          title: utf8Prefix(event.title, 420),
          // The full formal text remains in the validated local cache.  The
          // ranking model receives only a bounded display summary.
          summary: utf8Prefix(event.body, 1_080),
          sourceNames: event.sources
            .map((source) => utf8Prefix(source.publisher, 100))
            .filter(Boolean)
            .slice(0, 8),
        },
      };
    }))
    .slice(0, INTELLIGENCE_NEWS_PREFERENCE_MAX_EVENTS);
}

function preferenceFavorites(storage: IntelligenceStorage | undefined): NewsPreferenceFavoriteInput[] {
  return listFavorites("news", { storage: storage ?? null, eventTarget: null })
    .slice(0, INTELLIGENCE_NEWS_PREFERENCE_MAX_FAVORITES)
    .flatMap((favorite) => {
      const title = utf8Prefix(favorite.title, 420);
      if (!title) return [];
      return [{
        id: opaquePreferenceId("favorite", favorite.id),
        title,
        summary: utf8Prefix(favorite.summary, 1_080),
        category: utf8Prefix(favorite.category, 100),
      }];
    });
}

function preferenceRouteAllowsLocalScoring(value: unknown): boolean {
  const payload = record(value);
  const routes = Array.isArray(payload?.routes) ? payload.routes.map(record) : [];
  const route = routes.find((candidate) => text(candidate?.capability) === "news_preference");
  // Fail closed for an absent/malformed route. Cloud/host routing is not
  // implemented here: this cache viewer must never turn a local preference
  // into an upload or remote inference request.
  return text(route?.mode) === "auto" || text(route?.mode) === "local";
}

function preferenceScoreCacheKey(
  favorites: readonly NewsPreferenceFavoriteInput[],
  events: readonly NewsPreferenceEventInput[],
): string {
  const input = JSON.stringify({ favorites, events });
  return opaquePreferenceId("cache", input);
}

function readPreferenceScoreCache(
  storage: IntelligenceStorage | undefined,
  key: string,
): NewsPreferenceScoreResult[] | null {
  try {
    const cache = record(JSON.parse(storage?.getItem(INTELLIGENCE_NEWS_PREFERENCE_SCORE_CACHE_STORAGE_KEY) ?? "null")) as UnknownRecord | null;
    const scores = Array.isArray(cache?.scores) ? cache.scores.map(record) : null;
    if (cache?.version !== 1 || text(cache?.key) !== key || !scores) return null;
    const parsed = scores.flatMap((score) => {
      const id = text(score?.id);
      const value = score?.score;
      return id && typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
        ? [{ id, score: value }]
        : [];
    });
    return parsed.length === scores.length ? parsed : null;
  } catch {
    return null;
  }
}

function savePreferenceScoreCache(
  storage: IntelligenceStorage | undefined,
  key: string,
  scores: readonly NewsPreferenceScoreResult[],
): void {
  try {
    const payload: NewsPreferenceScoreCache = { version: 1, key, scores };
    storage?.setItem(INTELLIGENCE_NEWS_PREFERENCE_SCORE_CACHE_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Scores are optional presentation cache; a later visit may safely score again.
  }
}

function parsePreferenceScores(
  value: unknown,
  events: readonly NewsPreferenceEventInput[],
): NewsPreferenceScoreResult[] | null {
  const payload = record(value);
  const scores = Array.isArray(payload?.scores) ? payload.scores.map(record) : null;
  if (!scores || scores.length !== events.length) return null;
  const requested = new Set(events.map((event) => event.id));
  const seen = new Set<string>();
  const parsed = scores.flatMap((score) => {
    const id = text(score?.id);
    const value = score?.score;
    if (!requested.has(id) || seen.has(id) || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) return [];
    seen.add(id);
    return [{ id, score: value }];
  });
  return parsed.length === events.length && seen.size === requested.size ? parsed : null;
}

function orderFormalPublicationEvents(
  original: readonly FormalPublicationEvent[],
  scored: readonly (FormalPublicationEvent & { readonly preference: NewsPreferenceEventInput })[],
  scores: readonly NewsPreferenceScoreResult[],
): FormalPublicationEvent[] {
  if (scored.length === 0 || scores.length !== scored.length) return [...original];
  const scoreById = new Map(scores.map((score) => [score.id, score.score]));
  if (scoreById.size !== scored.length || scored.some((item) => !scoreById.has(item.preference.id))) return [...original];
  const ranked = scored
    .map((item, index) => ({ item, index, score: scoreById.get(item.preference.id) ?? 0 }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ item }) => ({ publication: item.publication, event: item.event }));
  return [...ranked, ...original.slice(scored.length)];
}

function intelligenceClientErrorMessage(error: unknown): string {
  const message = String(error ?? "");
  if (message.includes("未登录")) return "尚未登录，无法读取账户情报缓存。登录后可手动刷新。";
  if (message.includes("未启用") || message.includes("ACCESS_DENIED") || message.includes("403")) {
    return "当前账户没有情报中心访问权限；本地已缓存内容不会被删除。";
  }
  return "情报缓存暂时无法读取；不会因此启动网络采集或模型任务。";
}

function intelligenceDeliveryStateCopy(cache: IntelligenceClientCacheStatus): string {
  const time = (value: number): string => value > 0
    ? new Date(value).toLocaleString("zh-CN")
    : "暂无";
  const sse = ({
    not_started: "未启动",
    connecting: "连接中",
    connected: "已连接",
    reconnecting: "重连中",
    login_required: "等待登录",
    permission_required: "权限未就绪",
  } as const)[cache.sseState];
  const metrics = `最近成功：获取 ${cache.lastFetched}、保存 ${cache.lastPersisted}、确认 ${cache.lastAcknowledged}；SSE ${sse}`;
  switch (cache.deliveryState) {
    case "not_refreshed":
      return "尚未手动刷新。点击“刷新”后才会向服务端登记设备、拉取并校验正式发布包；本机草稿或未配对内容不属于账号资讯。";
    case "refreshing":
      return `正在刷新正式资讯；最近尝试：${time(cache.lastAttemptAt)}。`;
    case "server_empty":
      return `最近刷新成功：${time(cache.lastSuccessAt)}；服务端当前没有可投递的正式包。${metrics}`;
    case "ready":
      return `正式资讯已同步；最近成功：${time(cache.lastSuccessAt)}。${metrics}`;
    case "login_required":
      return "登录状态未就绪，尚未请求服务端正式资讯；本机草稿或未配对内容不会显示在账号资讯中。";
    case "permission_required":
      return `当前账号尚无情报中心权限；最近尝试：${time(cache.lastAttemptAt)}。已保存的正式缓存不会被删除。`;
    case "delivery_failed":
      return `最近刷新未完成（传输或完整性校验失败）；最近尝试：${time(cache.lastAttemptAt)}。已保存的正式缓存不受影响。`;
  }
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

function safePreparedImageSource(value: unknown): string {
  return safePreparedImageDataUrl(value) || openableHttpsUrl(value);
}

function evidenceRetryAfter(value: unknown, now = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now + INTELLIGENCE_DEGRADED_EVIDENCE_RETRY_MS;
}

function pipelineSourceEvidenceFingerprint(source: IntelligenceBriefCandidate["sources"][number]): string {
  return intelligencePipelineFingerprint([
    openableHttpsUrl(source.url), source.name, source.title, source.body || source.summary,
    JSON.stringify((source.imageUrls ?? []).map(openableHttpsUrl).filter(Boolean)),
    JSON.stringify((source.videoUrls ?? []).map(openableHttpsUrl).filter(Boolean)),
  ].join("\u001f"));
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

type NewsFavoriteInput = Extract<FavoriteRecordInput, { readonly kind: "news" }>;

function newsFavoriteForItem(item: IntelligenceNewsItem): NewsFavoriteInput {
  const articleId = pipelineArticleForEvidenceItem(item).articleId;
  return {
    kind: "news",
    id: `article:${articleId}`,
    title: itemTitle(item),
    summary: readableSummary(item.summary),
    source: text(item.source) || "未知来源",
    publishedAt: publishedAtText(item),
    category: text(item.category) || "综合",
    url: openableHttpsUrl(item.url),
  };
}

function newsFavoriteForCandidate(
  candidate: IntelligenceBriefCandidate,
  modelBrief: IntelligenceModelBrief | null,
): NewsFavoriteInput {
  const url = candidate.sources.map((source) => openableHttpsUrl(source.url)).find(Boolean) ?? "";
  return {
    kind: "news",
    id: `event:${candidate.eventId || candidate.id}`,
    title: modelBrief?.headline || candidate.title,
    summary: modelBrief?.summary || readableSummary(candidate.summary),
    source: `本机综合 · ${candidate.entry.sourceKeys.length} 个独立来源`,
    publishedAt: candidate.publishedAt,
    category: briefingTopicName(candidate.entry.item),
    url,
    ...(candidate.eventId ? { eventId: candidate.eventId } : {}),
    ...(candidate.revision === undefined ? {} : { revision: candidate.revision }),
  };
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
    // Do not silently discard the 19th+ article of a busy source. The global
    // 12k / 20 MiB snapshot limits remain the only bounds, and round-robin
    // selection below still prevents one provider from starving the others.
    if (group.length < INTELLIGENCE_SNAPSHOT_MAX_ITEMS) group.push(compactSnapshotItem(item));
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

// 以下 helpers 保留给旧的本机快照兼容路径；正式账号资讯页不调用它们，避免
// 将旧抓取/推理流程重新带回客户端消费链。显式保留引用使编译期审计可区分
// “兼容边界仍存在”与“已被主流程调用”。
void mergeRelatedEventEntries;
void nonNegativeCount;
void saveSnapshot;
void sourceBatches;

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
    const toolbarAction = typeof toolbarButton?.closest === "function"
      ? toolbarButton.closest<HTMLElement>("[data-toolbar-item='intelligence-lab']")
      : null;
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
    const kindFilter = requiredElement<HTMLSelectElement>(root, "intelligence-filter-kind");
    const importanceFilter = requiredElement<HTMLSelectElement>(root, "intelligence-filter-importance");
    const scopeFilter = requiredElement<HTMLSelectElement>(root, "intelligence-filter-scope");
    const archiveDay = requiredElement<HTMLSelectElement>(root, "intelligence-archive-day");
    const archiveRequest = requiredElement<HTMLButtonElement>(root, "intelligence-archive-request");
    const archiveRetry = requiredElement<HTMLButtonElement>(root, "intelligence-archive-retry");
    const archiveStatus = requiredElement<HTMLElement>(root, "intelligence-archive-status");
    const digestHistory = requiredElement<HTMLElement>(root, "intelligence-digest-history");
    const digestHistorySummary = requiredElement<HTMLElement>(root, "intelligence-digest-history-summary");
    const digestHistoryDate = requiredElement<HTMLSelectElement>(root, "intelligence-digest-history-date");
    const digestHistoryPrevious = requiredElement<HTMLButtonElement>(root, "intelligence-digest-history-previous");
    const digestHistoryNext = requiredElement<HTMLButtonElement>(root, "intelligence-digest-history-next");
    const digestHistoryReadonly = requiredElement<HTMLElement>(root, "intelligence-digest-history-readonly");
    const processingSummary = requiredElement<HTMLElement>(root, "intelligence-processing-summary");
    const deliveryState = requiredElement<HTMLElement>(root, "intelligence-delivery-state");
    const modelStatus = requiredElement<HTMLElement>(root, "intelligence-briefing-model-status");
    const modelBaseUrl = requiredElement<HTMLInputElement>(root, "intelligence-local-model-base-url");
    const modelName = requiredElement<HTMLSelectElement>(root, "intelligence-local-model-name");
    const modelQwen27b = requiredElement<HTMLOptionElement>(root, "intelligence-local-model-qwen27b");
    const modelRequirement = requiredElement<HTMLElement>(root, "intelligence-local-model-requirement");
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
    const auditTrigger = requiredElement<HTMLButtonElement>(root, "intelligence-open-audit");
    const auditView = requiredElement<HTMLElement>(root, "intelligence-audit-view");
    const auditBack = requiredElement<HTMLButtonElement>(root, "intelligence-audit-back");
    const contentShell = typeof root.querySelector === "function"
      ? hiddenElement(root.querySelector(".content-shell"))
      : null;
    if (!toolbarButton || !page || !back || !briefing || !monitor || !research || !interstellar
      || !refreshButton || !sourcesButton || !sourceDirectory || !sourceDirectoryBack || !sourceDirectorySummary || !sourceDirectorySearch || !sourceDirectoryList
      || !status || !digestHistory || !digestHistorySummary || !digestHistoryDate || !digestHistoryPrevious || !digestHistoryNext || !digestHistoryReadonly
      || !processingSummary || !modelStatus || !modelBaseUrl || !modelName || !modelQwen27b || !modelRequirement || !modelKey || !modelSave || !briefingCount || !digestList || !signalList || !contextTitle
      || !contextBody || !contextMeta || !contextReasons || !contextEvidence || !openNews || !standardView || !interstellarView || !interstellarSignalCount
      || !interstellarSignalList || !interstellarContextTitle || !interstellarContextBody || !interstellarOpenNews
      || !interstellarSourceSummary || !interstellarSourceNote || !interstellarSourceGroups || !interstellarManageSources) {
      return null;
    }

    let currentLayout: IntelligenceLayout = "briefing";
    let loading = false;
    // A native SSE wake-up only means that the protected Rust cache changed.
    // Keep one pending marker while a read is in flight so the page never
    // paints an older cache projection after the background refresh commits.
    let deliveryCacheReloadPending = false;
    let loadGeneration = 0;
    let cancelledLoadPending = false;
    let reloadAfterCancelledLoad = false;
    let selectedItem: IntelligenceNewsItem | null = null;
    let selectedFormalPublication: {
      readonly publication: IntelligenceClientCachedPublication;
      readonly event: IntelligenceClientCachedEvent;
    } | null = null;
    let formalPublicationCache: {
      readonly cache: IntelligenceClientCacheStatus;
      readonly publications: readonly IntelligenceClientCachedPublication[];
      readonly events: readonly FormalPublicationEvent[];
      readonly personalized: boolean;
    } | null = null;
    let activeArchiveRequestId = "";
    let selectedStandardFavorite: NewsFavoriteInput | null = null;
    let selectedInterstellarFavorite: NewsFavoriteInput | null = null;
    let currentCandidates: IntelligenceBriefCandidate[] = [];
    let currentModelBriefs: IntelligenceModelBrief[] = [];
    let dailyDigestHistory: IntelligenceDailyDigestSnapshot[] = [];
    let selectedDigestDay = "current";
    let briefingGeneration = 0;
    let modelConfigured = false;
    let qwen27bSelectable = false;
    let activeModelName = "";
    let activeModelSha = "";
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
      if (eventJudgeBaseUrl) eventJudgeBaseUrl.value = text(settings?.baseUrl).slice(0, 500) || INTELLIGENCE_EVENT_JUDGE_DEFAULT_BASE_URL;
      if (eventJudgeModel) eventJudgeModel.value = text(settings?.model).slice(0, 160) || INTELLIGENCE_EVENT_JUDGE_DEFAULT_MODEL;
    } catch {
      if (eventJudgeBaseUrl) eventJudgeBaseUrl.value = INTELLIGENCE_EVENT_JUDGE_DEFAULT_BASE_URL;
      if (eventJudgeModel) eventJudgeModel.value = INTELLIGENCE_EVENT_JUDGE_DEFAULT_MODEL;
    }
    // A direct card click is allowed to prioritize one event while the daily
    // batch continues. Coalescing by candidate keeps repeated clicks from
    // starting duplicate GPU generations.
    const directBriefRequests = new Map<string, Promise<IntelligenceModelBrief | null>>();
    const preparedBriefImages = new Map<string, string[]>();
    const preparedBriefImageInFlight = new Set<string>();
    const preparedTimelineCache = new Map<string, string>();
    const preparedTimelineInFlight = new Set<string>();
    let selectedInterstellarItem: IntelligenceNewsItem | null = null;
    let standardStatus = "";
    let interstellarStatus = "首版人工基线已建立；候选资讯尚未自动计分。";
    let sourceDirectoryOpen = false;
    let sourceDirectoryQuery = "";
    let sourceDirectoryCatalogue: IntelligenceCatalogSource[] = [];
    let auditStages: IntelligenceAuditStageProjection[] = [];
    let pipelineState: IntelligencePipelineState = emptyIntelligencePipelineState();
    let nativePipelineActive = false;
    let pipelineWorkerActive = false;
    let pendingPipelineBriefing: IntelligenceBriefing | null = null;
    let pipelineWorkerPromise: Promise<void> | null = null;
    let pipelineRetryTimer: ReturnType<typeof setTimeout> | null = null;
    let pipelineRetryAttempt = 0;
    let retryPipelineBriefing: IntelligenceBriefing | null = null;
    let pendingNativeIngestion: IntelligenceBriefing | null = null;
    let nativeIngestionActive = false;
    let nativeIngestionFailed = false;
    const nativeIngestedFingerprints = new Map<string, string>();
    let nativePipelineCapability: boolean | null = null;
    let runtimeSwitchCapability: boolean | null = null;
    const pipelineCapabilityWaiters: Array<(available: boolean) => void> = [];
    let auditDetailLoaderInstalled = false;
    let nativeReviewGate: UnknownRecord | null = null;
    let activeNativeRunId = "";
    let auditLiveRefreshTimer: ReturnType<typeof setInterval> | null = null;
    let auditLiveRefreshInFlight = false;
    const favoritesOptions = {
      storage: runtime.localStorage ?? null,
      eventTarget: typeof runtime.dispatchEvent === "function"
        ? { dispatchEvent: (event: Event) => runtime.dispatchEvent!(event) }
        : null,
    };
    const favoriteAction = root.createElement("button");
    favoriteAction.type = "button";
    favoriteAction.className = "intelligence-evidence-item intelligence-evidence-link intelligence-favorite-action";
    const interstellarFavoriteAction = root.createElement("button");
    interstellarFavoriteAction.type = "button";
    interstellarFavoriteAction.className = "intelligence-evidence-item intelligence-evidence-link intelligence-favorite-action";

    const refreshFavoriteAction = (
      button: HTMLButtonElement,
      favorite: NewsFavoriteInput | null,
    ): void => {
      const active = favorite ? isFavorite("news", favorite.id, favoritesOptions) : false;
      button.hidden = favorite === null;
      button.disabled = favorite === null;
      button.textContent = active ? "已收藏" : "添加收藏";
      button.title = active ? "从收藏夹移除" : "添加到收藏夹";
      button.setAttribute("aria-pressed", String(active));
    };

    favoriteAction.addEventListener("click", () => {
      if (!selectedStandardFavorite) return;
      toggleFavorite(selectedStandardFavorite, favoritesOptions);
      refreshFavoriteAction(favoriteAction, selectedStandardFavorite);
    });
    interstellarFavoriteAction.addEventListener("click", () => {
      if (!selectedInterstellarFavorite) return;
      toggleFavorite(selectedInterstellarFavorite, favoritesOptions);
      refreshFavoriteAction(interstellarFavoriteAction, selectedInterstellarFavorite);
    });
    refreshFavoriteAction(favoriteAction, null);
    refreshFavoriteAction(interstellarFavoriteAction, null);

    const auditController = (): IntelligenceAuditControllerProjection | null => (
      activeRuntime.ReaderIntelligenceAudit?.instance
      ?? activeRuntime.ReaderIntelligenceAudit?.init?.()
      ?? null
    );

    const installAuditDetailLoader = (): void => {
      if (auditDetailLoaderInstalled) return;
      const controller = auditController();
      if (!controller?.setDetailLoader) return;
      controller.setDetailLoader(async (request) => {
        if (transport) {
          try {
            const response = record(await transport.invoke<unknown>("intelligence_store_audit_page", {
              runId: request.runId,
              stage: request.stageId,
              cursor: String(Math.max(0, request.offset)),
              limit: Math.max(1, Math.min(50, request.limit)),
            }));
            const rawItems = Array.isArray(response?.items) ? response.items.map(record) : [];
            const items = rawItems.flatMap((value) => {
              let detail: UnknownRecord | null = null;
              try {
                detail = record(typeof value?.detailJson === "string"
                  ? JSON.parse(value.detailJson)
                  : value?.detailJson ?? value?.detail_json);
              } catch {
                detail = null;
              }
              // Audit detail is deliberately allow-listed. Never surface a
              // stored article body, model prompt, local path, URL credential,
              // or arbitrary JSON field in the human review page.
              const title = text(detail?.title) || text(value?.title ?? value?.itemId ?? value?.item_id);
              if (!title) return [];
              const status = text(value?.status) as IntelligenceAuditStatus;
              const id = text(value?.id ?? value?.itemId ?? value?.item_id);
              const meta = text(detail?.meta) || text(value?.meta ?? value?.unitKind ?? value?.unit_kind);
              const reason = text(detail?.reason) || text(value?.reason);
              const badge = text(detail?.badge) || text(value?.badge);
              const confidence = typeof detail?.confidence === "number" ? detail.confidence : value?.confidence;
              const sourceCount = typeof detail?.sourceCount === "number" ? detail.sourceCount : value?.sourceCount;
              return [{
                ...(id ? { id } : {}),
                title,
                ...(meta ? { meta } : {}),
                ...(reason ? { reason } : {}),
                ...(["pending", "running", "accepted", "rejected", "warning", "cached"].includes(status) ? { status } : {}),
                ...(badge ? { badge } : {}),
                ...(typeof confidence === "number" ? { confidence } : {}),
                ...(typeof sourceCount === "number" ? { sourceCount } : {}),
              }];
            });
            const total = typeof response?.total === "number" ? Math.max(0, Math.floor(response.total)) : items.length;
            return { total, items };
          } catch {
            // Older binaries have no paged store command. Fall through to the
            // bounded in-memory audit projection instead of blocking opening.
          }
        }
        const stageItems = auditStages.find((stage) => stage.id === request.stageId)?.items ?? [];
        return {
          total: stageItems.length,
          items: stageItems.slice(request.offset, request.offset + request.limit),
        };
      });
      auditDetailLoaderInstalled = true;
    };

    const publishAudit = (summary: string): void => {
      installAuditDetailLoader();
      auditController()?.setSnapshot({
        runId: activeNativeRunId || `run-${loadGeneration}-${briefingGeneration}`,
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

    const pipelineJudgeBaseUrl = (): string => text(eventJudgeBaseUrl?.value) || INTELLIGENCE_EVENT_JUDGE_DEFAULT_BASE_URL;
    const pipelineModelId = (): string => text(eventJudgeModel?.value) || INTELLIGENCE_EVENT_JUDGE_DEFAULT_MODEL;

    const isRuntimeConnectionFailure = (error: unknown): boolean => (
      /ECONNREFUSED|connection refused|unable to connect|failed to fetch|network error|server is running|10061|timed?\s*out/iu.test(String(error))
    );

    const ensureNativeRuntimePhase = async (
      phase: "triage" | "editorial" | "core",
      message: string,
    ): Promise<boolean> => {
      if (!transport || runtimeSwitchCapability === false) return false;
      const switchOnce = async (): Promise<boolean> => {
        const response = record(await transport.invoke<unknown>("intelligence_runtime_switch", { phase }));
        runtimeSwitchCapability = true;
        const established = text(response?.phase) || phase;
        modelStatus.textContent = `${message} · ${established}`;
        return true;
      };
      try {
        // The native switch command is idempotent and doubles as a health
        // probe. Do not trust a remembered phase after the local process has
        // exited between two batches.
        return await switchOnce();
      } catch (error: unknown) {
        const detail = String(error);
        // Older installed builds and deterministic UI mocks do not expose the
        // fixed native runtime controller. They may still use an externally
        // managed loopback service, so only command absence is a soft fallback.
        if (/unknown command|command .* not found|unhandled command|unsupported intelligence runtime/i.test(detail)) {
          runtimeSwitchCapability = false;
          return false;
        }
        if (isRuntimeConnectionFailure(error)) {
          // A stale process/phase gets exactly one restart attempt. A second
          // failure propagates and leaves the persistent batch pending.
          return switchOnce();
        }
        throw error;
      }
    };

    const invokeWithRuntimeRecovery = async <T>(
      command: string,
      args: UnknownRecord,
      phase: "triage" | "editorial" | "core",
      message: string,
    ): Promise<T> => {
      if (!transport) throw new Error("runtime transport unavailable");
      try {
        return await transport.invoke<T>(command, args);
      } catch (error: unknown) {
        if (!isRuntimeConnectionFailure(error) || runtimeSwitchCapability === false) throw error;
        await ensureNativeRuntimePhase(phase, message);
        // Retry the failed model operation once only. If it still fails the
        // caller preserves the checkpoint/lease for a later run.
        return transport.invoke<T>(command, args);
      }
    };

    const nativePipelinePort = (): IntelligencePipelinePort | null => {
      if (!transport) return null;
      return {
        upsertArticles: async (articles) => {
          const value = record(await transport!.invoke<unknown>("intelligence_store_upsert_articles", { articles }));
          if (!value || typeof value.received !== "number" || typeof value.queued !== "number") {
            throw new Error("native-intelligence-store-unavailable");
          }
          return {
            received: value.received,
            inserted: typeof value.inserted === "number" ? value.inserted : 0,
            updated: typeof value.updated === "number" ? value.updated : 0,
            unchanged: typeof value.unchanged === "number" ? value.unchanged : 0,
            queued: value.queued,
          };
        },
        claimTriage: async (request) => {
          const value = record(await transport!.invoke<unknown>("intelligence_store_claim_triage", request));
          const leaseOwner = text(value?.leaseOwner);
          if (!value || !leaseOwner || !Array.isArray(value.articles)) throw new Error("native-triage-claim-invalid");
          const articles = value.articles.flatMap((raw) => {
            const item = record(raw);
            const articleId = text(item?.articleId);
            const fingerprint = text(item?.fingerprint);
            const title = text(item?.title);
            if (!articleId || !fingerprint || !title) return [];
            return [{
              articleId,
              fingerprint,
              title,
              ...(text(item?.url) ? { url: text(item?.url) } : {}),
              ...(text(item?.sourceKey) ? { sourceKey: text(item?.sourceKey) } : {}),
              ...(text(item?.sourceName) ? { sourceName: text(item?.sourceName) } : {}),
              ...(text(item?.summary) ? { summary: text(item?.summary) } : {}),
              ...(text(item?.body) ? { body: text(item?.body) } : {}),
              ...(text(item?.publishedAt) ? { publishedAt: text(item?.publishedAt) } : {}),
              ...(text(item?.language) ? { language: text(item?.language) } : {}),
              ...(text(item?.mediaJson) ? { mediaJson: text(item?.mediaJson) } : {}),
            } satisfies IntelligencePipelineArticle];
          });
          return {
            leaseOwner,
            articles,
            remaining: typeof value.remaining === "number" ? Math.max(0, Math.floor(value.remaining)) : 0,
          };
        },
        classifyArticles: async (articles) => {
          const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_triage_articles", {
            request: {
              articles: articles.map((article) => ({
                id: article.articleId,
                title: article.title,
                summary: article.body || article.summary || "",
                publishedAt: article.publishedAt || "",
                sourceNames: article.sourceName ? [article.sourceName] : [],
              })),
              baseUrl: pipelineJudgeBaseUrl(),
              model: pipelineModelId(),
            },
          }, "triage", "8B 初筛连接已恢复，正在重试当前批次"));
          const rawDecisions = Array.isArray(response?.decisions) ? response.decisions.map(record) : [];
          return articles.flatMap((article) => {
            const raw = rawDecisions.find((decision) => text(decision?.id ?? decision?.articleId) === article.articleId);
            if (!raw) return [];
            const importance = typeof raw.importance === "number" ? Math.max(0, Math.min(100, Math.floor(raw.importance))) : undefined;
            const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : undefined;
            const reason = text(raw.reason).slice(0, 600);
            return [{
              articleId: article.articleId,
              fingerprint: article.fingerprint,
              status: raw.keep === true ? "keep" as const : "filter" as const,
              ...(importance === undefined ? {} : { importance }),
              ...(confidence === undefined ? {} : { confidence }),
              ...(reason ? { reason } : {}),
              decisionJson: JSON.stringify({
                topic: text(raw.topic),
                primaryEntities: Array.isArray(raw.primaryEntities) ? raw.primaryEntities.map(text).filter(Boolean).slice(0, 12) : [],
                inputFingerprint: article.fingerprint,
                modelId: pipelineModelId(),
                promptVersion: INTELLIGENCE_PIPELINE_PROMPT_VERSION,
                reviewStatus: "awaiting_27b",
              }),
            }];
          });
        },
        applyTriage: async (request) => {
          await transport!.invoke<unknown>("intelligence_store_apply_triage", request);
        },
      };
    };

    const readStoredTriageDecisions = async (
      articleIds: readonly string[],
    ): Promise<IntelligenceStoredTriageDecision[]> => {
      if (!transport || articleIds.length === 0) return [];
      const decisions: IntelligenceStoredTriageDecision[] = [];
      for (let start = 0; start < articleIds.length; start += INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE) {
        const response = record(await transport.invoke<unknown>("intelligence_store_triage_decisions", {
          articleIds: articleIds.slice(start, start + INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE),
        }));
        if (!response || !Array.isArray(response.decisions)) throw new Error("native-triage-decisions-unavailable");
        response.decisions.map(record).forEach((value) => {
          const articleId = text(value?.articleId);
          const fingerprint = text(value?.fingerprint);
          const status = text(value?.status);
          if (!articleId || !fingerprint || !["keep", "filter", "failed"].includes(status)) return;
          decisions.push({
            articleId,
            fingerprint,
            status: status as IntelligenceStoredTriageDecision["status"],
            ...(typeof value?.importance === "number" ? { importance: value.importance } : {}),
            ...(typeof value?.confidence === "number" ? { confidence: value.confidence } : {}),
            ...(text(value?.reason) ? { reason: text(value?.reason) } : {}),
            ...(text(value?.decisionJson) ? { decisionJson: text(value?.decisionJson) } : {}),
          });
        });
      }
      return decisions;
    };

    const readStoredEventProjections = async (
      articleIds: readonly string[],
    ): Promise<IntelligenceStoredEventProjection[]> => {
      if (!transport || articleIds.length === 0) return [];
      const projections: IntelligenceStoredEventProjection[] = [];
      for (let start = 0; start < articleIds.length; start += INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE) {
        const response = record(await transport.invoke<unknown>("intelligence_store_events_by_articles", {
          articleIds: articleIds.slice(start, start + INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE),
        }));
        if (!response || !Array.isArray(response.projections)) throw new Error("native-event-projections-unavailable");
        response.projections.map(record).forEach((value) => {
          const articleId = text(value?.articleId);
          const eventId = text(value?.eventId);
          const revision = Number(value?.revision ?? value?.currentRevision);
          if (!articleId || !eventId || !Number.isFinite(revision)) return;
          projections.push({
            articleId,
            eventId,
            revision,
            ...(text(value?.seriesId) ? { seriesId: text(value?.seriesId) } : {}),
            ...(text(value?.title) ? { title: text(value?.title) } : {}),
            ...(text(value?.summary) ? { summary: text(value?.summary) } : {}),
            ...(text(value?.occurredAt) ? { occurredAt: text(value?.occurredAt) } : {}),
          });
        });
      }
      return projections;
    };

    const candidateFromEventMembers = (
      eventId: string,
      members: readonly IntelligenceBriefCandidate[],
      importance: number,
      stored?: IntelligenceStoredEventProjection,
      seriesId?: string,
    ): IntelligenceBriefCandidate | null => {
      const representative = members[0];
      if (!representative) return null;
      const sources = members.flatMap((member) => member.sources).filter((source, index, values) => (
        values.findIndex((candidate) => candidate.url === source.url && candidate.name === source.name) === index
      ));
      const entry: IntelligenceBriefingEntry = {
        ...representative.entry,
        importance,
        sourceKeys: [...new Set(members.flatMap((member) => member.entry.sourceKeys))],
        sourceNames: [...new Set(members.flatMap((member) => member.entry.sourceNames))],
        evidenceItems: mergeEvidenceItems([], members.flatMap((member) => member.entry.evidenceItems)),
        mergedCount: members.reduce((total, member) => total + member.entry.mergedCount, 0),
      };
      const stableSeriesId = stored?.seriesId || seriesId;
      return {
        ...representative,
        id: eventId,
        eventId,
        ...(stableSeriesId ? { seriesId: stableSeriesId } : {}),
        ...(stored ? { revision: stored.revision } : {}),
        title: stored?.title || representative.title,
        summary: stored?.summary || representative.summary,
        publishedAt: stored?.occurredAt || representative.publishedAt,
        entry,
        sources,
      };
    };

    const candidatesFromStoredEventProjections = (
      projections: readonly IntelligenceStoredEventProjection[],
      candidateByArticleId: ReadonlyMap<string, IntelligenceBriefCandidate>,
      triageByArticleId: ReadonlyMap<string, IntelligenceStoredTriageDecision>,
    ): IntelligenceBriefCandidate[] => {
      const byEvent = new Map<string, IntelligenceStoredEventProjection[]>();
      projections.forEach((projection) => {
        byEvent.set(projection.eventId, [...(byEvent.get(projection.eventId) ?? []), projection]);
      });
      return [...byEvent.entries()].flatMap(([eventId, eventProjections]) => {
        const members = eventProjections.map((projection) => candidateByArticleId.get(projection.articleId))
          .filter((candidate): candidate is IntelligenceBriefCandidate => Boolean(candidate));
        const importance = Math.max(0, ...eventProjections.map((projection) => triageByArticleId.get(projection.articleId)?.importance ?? 0));
        const latest = eventProjections.slice().sort((left, right) => right.revision - left.revision)[0];
        const candidate = candidateFromEventMembers(eventId, members, importance, latest);
        return candidate ? [candidate] : [];
      });
    };

    const refreshNativePipelineSnapshot = async (summary: string): Promise<void> => {
      // Audit is a read-only view over the durable native store. It must stay
      // live after the worker has failed/stopped and also when this WebView did
      // not start the run itself; tying reads to `nativePipelineActive` leaves
      // the page frozen on its last in-memory count.
      if (!transport) return;
      try {
        const response = record(await transport.invoke<unknown>("intelligence_store_snapshot"));
        if (!response) return;
        const retrieval = record(response.retrievalProfile);
        const retrievalEngines = [
          text(retrieval?.embeddingModel),
          text(retrieval?.rerankerModel),
          text(retrieval?.calibrationEmbeddingModel),
        ].filter(Boolean).join(" + ");
        const reviewGate = record(response.reviewGate);
        nativeReviewGate = reviewGate;
        const queue = record(response.queue);
        const snapshotRunId = text(response.activeRunId ?? response.active_run_id ?? response.runId ?? response.run_id);
        if (snapshotRunId) activeNativeRunId = snapshotRunId;
        const runStatus = text(response.runStatus ?? response.run_status);
        const queuedArticles = Math.max(0, Number(queue?.queued) || 0);
        const processingArticles = Math.max(0, Number(queue?.processing) || 0);
        const pendingArticles = queuedArticles + processingArticles;
        const totalArticles = Math.max(0, Number(queue?.total) || 0);
        const stages = Array.isArray(response.stages) ? response.stages.map(record) : [];
        stages.forEach((value) => {
          const id = text(value?.id) as IntelligencePipelineStageId;
          if (!id || !auditStages.some((stage) => stage.id === id)) return;
          const existing = auditStages.find((stage) => stage.id === id)!;
          const unit = existing.unit ?? "articles";
          const countField = unit === "articles" ? value?.articles : unit === "pairs" ? value?.pairs : unit === "series" ? value?.series : value?.events;
          let outputCount = typeof countField === "number" ? Math.max(0, Math.floor(countField)) : existing.outputCount;
          let inputCount = existing.inputCount;
          let pendingCount = existing.pendingCount;
          const rawStatus = text(value?.status);
          let status: IntelligenceAuditStatus = rawStatus === "completed" ? "accepted"
            : rawStatus === "failed" ? "warning"
              : ["pending", "running", "accepted", "rejected", "warning", "cached"].includes(rawStatus)
                ? rawStatus as IntelligenceAuditStatus
                : existing.status;
          if (id === "collected" || id === "exact-dedupe") {
            // Collection and exact-dedupe describe the complete catalogue
            // currently shown in this WebView. Native stage rows are scoped
            // to one worker run and arrive in chunks, so using their count
            // here made a finished 7,413 -> 7,398 catalogue appear to shrink
            // to an arbitrary in-flight batch (for example 5,632 -> 5,632).
            // Keep the catalogue projection stable; native rows remain
            // available only through the lazy detail pager.
            inputCount = existing.inputCount;
            outputCount = existing.outputCount;
            pendingCount = 0;
            status = existing.status;
          } else if (id === "article-triage" && outputCount !== undefined) {
            // `stage.articles` counts only run-scoped audit rows already
            // materialised for detail paging; it is not the triage
            // denominator. The durable article-state partition is complete
            // across worker failures, leases and incremental runs.
            inputCount = totalArticles;
            outputCount = Math.max(0, Number(queue?.kept) || 0)
              + Math.max(0, Number(queue?.filtered) || 0)
              + Math.max(0, Number(queue?.failed) || 0);
            pendingCount = pendingArticles;
            // A failed checkpoint may still have queued work. Pending work is
            // not evidence that the failed run is currently running.
            status = rawStatus === "failed" || runStatus === "failed"
              ? "warning"
              : pendingCount > 0 ? "running" : inputCount > 0 ? "accepted" : status;
          }
          const { reusedCount: ignoredTriageReuse, ...existingWithoutTriageReuse } = existing;
          void ignoredTriageReuse;
          setAuditStage({
            ...(id === "article-triage" ? existingWithoutTriageReuse : existing),
            status,
            ...(inputCount === undefined ? {} : { inputCount }),
            ...(outputCount === undefined ? {} : { outputCount }),
            ...(pendingCount === undefined ? {} : { pendingCount }),
            summary: id === "relation-recall" && retrievalEngines
              ? `${existing.summary} 当前引擎：${retrievalEngines}${response.retrievalDegraded === true ? "（降级）" : ""}。`
              : id === "article-triage" && inputCount !== undefined && outputCount !== undefined
                ? `本机持久文章共 ${inputCount} 篇：已完成 ${outputCount} 篇，处理中 ${processingArticles} 篇，持久队列等待 ${queuedArticles} 篇。计数来自 SQLite 文章状态；阶段审计行仅用于分页详情，不作为进度分母。`
              : id === "qwen-review" && reviewGate
                ? `${existing.summary} 近 30 天实际抽检 ${Math.max(0, Number(reviewGate.sampled) || 0)} 条：正确 ${Math.max(0, Number(reviewGate.correct) || 0)}、错误 ${Math.max(0, Number(reviewGate.incorrect) || 0)}、不确定 ${Math.max(0, Number(reviewGate.uncertain) || 0)}${typeof reviewGate.accuracy === "number" ? `，总体 ${(reviewGate.accuracy * 100).toFixed(2)}%` : ""}${typeof reviewGate.importantRecall === "number" ? `，重大召回 ${(reviewGate.importantRecall * 100).toFixed(2)}%` : ""}${typeof reviewGate.mergePrecision === "number" ? `，合并精度 ${(reviewGate.mergePrecision * 100).toFixed(2)}%` : ""}${typeof reviewGate.falseMergeRate === "number" ? `，误合并 ${(reviewGate.falseMergeRate * 100).toFixed(2)}%` : ""}${typeof reviewGate.jsonCompliance === "number" ? `，JSON 合规 ${(reviewGate.jsonCompliance * 100).toFixed(2)}%` : ""}；${reviewGate.eligibleForReducedReview === true ? "质量门已允许降低普通样本抽检率" : text(reviewGate.reason) || `仍在校准（至少 ${Math.max(0, Number(reviewGate.minimumSamples) || 50)} 个分层样本）`}。`
                : existing.summary,
          });
        });
        if (queue) {
          const total = Math.max(0, Number(queue.total) || 0);
          const completed = Math.max(0, Number(queue.kept) || 0) + Math.max(0, Number(queue.filtered) || 0) + Math.max(0, Number(queue.failed) || 0);
          processingSummary.textContent = `本机队列 ${completed} / ${total} 篇 · 待处理 ${Math.max(0, Number(queue.queued) || 0)} · 处理中 ${Math.max(0, Number(queue.processing) || 0)}`;
        }
        publishAudit(runStatus === "failed"
          ? `本机批次 ${activeNativeRunId || "当前批次"} 已失败；已完成判断和持久队列均已保留，模型/租约恢复后将从断点续跑。`
          : runStatus === "cancelled"
            ? `本机批次 ${activeNativeRunId || "当前批次"} 已取消；已完成判断仍保留在 SQLite。`
            : summary);
      } catch {
        // The live controller projection remains available on older builds.
      }
    };

    const stopAuditLiveRefresh = (): void => {
      if (auditLiveRefreshTimer !== null) clearInterval(auditLiveRefreshTimer);
      auditLiveRefreshTimer = null;
    };

    const refreshAuditLiveSnapshot = async (): Promise<void> => {
      if (auditLiveRefreshInFlight) return;
      auditLiveRefreshInFlight = true;
      try {
        await refreshNativePipelineSnapshot("正在实时读取本机持久队列；详情仍按需分页，不会随计数刷新重复加载。");
      } finally {
        auditLiveRefreshInFlight = false;
      }
    };

    const startAuditLiveRefresh = (): void => {
      stopAuditLiveRefresh();
      void refreshAuditLiveSnapshot();
      auditLiveRefreshTimer = setInterval(() => {
        if (auditView?.hidden !== false) {
          stopAuditLiveRefresh();
          return;
        }
        void refreshAuditLiveSnapshot();
      }, INTELLIGENCE_AUDIT_LIVE_REFRESH_MS);
      // Node's deterministic DOM tests expose a Timeout object; browsers
      // return a number. Do not let an optional audit poll keep test shutdown
      // or app teardown alive.
      (auditLiveRefreshTimer as unknown as { unref?: () => void }).unref?.();
    };

    const projectStoredTriage = (
      briefingResult: IntelligenceBriefing,
      decisions: readonly IntelligenceStoredTriageDecision[],
    ): void => {
      const candidates = pipelineCandidatesByArticleId(briefingResult);
      const accepted = decisions
        .filter((decision) => decision.status === "keep" && candidates.has(decision.articleId))
        .sort((left, right) => (
          (right.importance ?? 0) - (left.importance ?? 0)
          || (right.confidence ?? 0) - (left.confidence ?? 0)
          || left.articleId.localeCompare(right.articleId)
        ));
      currentCandidates = accepted.map((decision) => candidates.get(decision.articleId)!);
      const pending = Math.max(0, briefingResult.uniqueCount - decisions.length);
      const filtered = decisions.filter((decision) => decision.status === "filter").length;
      const failed = decisions.filter((decision) => decision.status === "failed").length;
      setAuditStage({
        id: "article-triage",
        status: pending > 0 ? "running" : failed > 0 ? "warning" : "accepted",
        unit: "articles",
        inputCount: briefingResult.uniqueCount,
        outputCount: accepted.length,
        pendingCount: pending,
        reusedCount: pipelineState.reused,
        summary: pending > 0
          ? `7B/8B 本机模型已判定 ${decisions.length} / ${briefingResult.uniqueCount} 篇；仍有 ${pending} 篇在持久队列中。`
          : `逐篇初筛完成：保留 ${accepted.length} 篇，过滤 ${filtered} 篇，失败 ${failed} 篇；未变化文章复用持久结果。`,
        items: decisions.slice(0, 40).map((decision) => ({
          id: decision.articleId,
          title: candidates.get(decision.articleId)?.title || decision.articleId,
          meta: `${pipelineModelId()} · 重要性 ${Math.round(decision.importance ?? 0)}`,
          reason: decision.reason || "本机模型已返回结构化判定。",
          status: decision.status === "keep" ? "accepted" : decision.status === "filter" ? "rejected" : "warning",
          badge: decision.status === "keep" ? "进入关系召回" : decision.status === "filter" ? "已过滤" : "待重试",
          ...(typeof decision.confidence === "number" ? { confidence: decision.confidence } : {}),
        })),
      });
      setAuditStage({
        id: "relation-recall",
        status: pending > 0 ? "pending" : "running",
        unit: "pairs",
        inputCount: accepted.length,
        outputCount: 0,
        pendingCount: accepted.length,
        summary: pending > 0
          ? "等待逐篇初筛完成后，由当前配置的向量召回与重排引擎检索关系候选。"
          : "逐篇初筛已完成；语义引擎只负责召回候选关系，不会直接合并事件。",
      });
      setAuditStage({
        id: "relation-judge",
        status: "pending",
        unit: "pairs",
        inputCount: 0,
        outputCount: 0,
        summary: "等待 7B/8B 模型按八类关系逐对判定。",
      });
      setAuditStage({
        id: "historical-recall",
        status: "pending",
        unit: "events",
        inputCount: accepted.length,
        outputCount: 0,
        summary: "等待从历史事件索引召回前情、后续与同系列候选。",
      });
      processingSummary.textContent = `采集 ${briefingResult.inputCount} 篇 → 精确去重 ${briefingResult.uniqueCount} 篇 → 初筛保留 ${accepted.length} 篇`;
      renderBriefCards();
    };

    const deterministicQualitySample = (targetId: string): boolean => {
      const sample = Number.parseInt(stableTextFingerprint(targetId).split("-").at(-1) ?? "0", 36);
      // Store is the single authority for the quality gate. Before it passes,
      // calibrate on 20% of ordinary items; afterwards reduce only ordinary
      // samples to 5%. Major/low-confidence/conflicting items are always added
      // separately and remain subject to the per-layer safety cap.
      const modulus = nativeReviewGate?.eligibleForReducedReview === true
        ? INTELLIGENCE_QWEN_REVIEW_SAMPLE_MODULUS
        : 5;
      return Number.isFinite(sample) && sample % modulus === 0;
    };

    const persistQualityReviews = async (reviews: readonly UnknownRecord[]): Promise<boolean> => {
      if (!transport || reviews.length === 0) return true;
      try {
        for (let start = 0; start < reviews.length; start += INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE) {
          const response = record(await transport.invoke<unknown>("intelligence_store_record_reviews", {
            reviews: reviews.slice(start, start + INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE),
          }));
          if (response) nativeReviewGate = response;
        }
        return true;
      } catch {
        return false;
      }
    };

    const runQwenTriageQualityReview = async (
      briefingResult: IntelligenceBriefing,
      decisions: readonly IntelligenceStoredTriageDecision[],
    ): Promise<void> => {
      if (!transport || decisions.length === 0) return;
      const candidates = pipelineCandidatesByArticleId(briefingResult);
      const reviewCandidates = decisions.flatMap((decision) => {
        const highRisk = (decision.importance ?? 0) >= 80 || (decision.confidence ?? 0) < 0.9 || decision.status === "failed";
        const sampled = deterministicQualitySample(`triage:${decision.articleId}:${decision.fingerprint}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`);
        return highRisk || sampled ? [{ decision, highRisk }] : [];
      }).sort((left, right) => Number(right.highRisk) - Number(left.highRisk)
        || (right.decision.importance ?? 0) - (left.decision.importance ?? 0)
        || left.decision.articleId.localeCompare(right.decision.articleId));
      const selected = reviewCandidates.slice(0, INTELLIGENCE_QWEN_REVIEW_MAX_PER_LAYER).map((item) => item.decision);
      const deferredByCap = Math.max(0, reviewCandidates.length - selected.length);
      if (selected.length === 0) return;
      await ensureNativeRuntimePhase("editorial", "已切换到 27B 复核/编辑阶段");
      let reviewed = 0;
      let pending = deferredByCap;
      for (let start = 0; start < selected.length; start += INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE) {
        const batch = selected.slice(start, start + INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE);
        try {
          // Omitting baseUrl/model is intentional: this invokes the configured
          // 27B reviewer, not the dedicated 8B worker used by the main queue.
          const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_triage_articles", {
            request: {
              articles: batch.map((decision) => {
                const candidate = candidates.get(decision.articleId);
                return {
                  id: decision.articleId,
                  title: candidate?.title || decision.articleId,
                  summary: candidate?.summary || "",
                  publishedAt: candidate?.publishedAt || "",
                  sourceNames: candidate?.entry.sourceNames ?? [],
                };
              }),
            },
          }, "editorial", "27B 文章复核服务断开，正在恢复编辑阶段"));
          const qwenDecisions = Array.isArray(response?.decisions) ? response.decisions.map(record) : [];
          const reviews = batch.map((small) => {
            const qwen = qwenDecisions.find((value) => text(value?.id) === small.articleId);
            const qwenConfidence = typeof qwen?.confidence === "number" ? qwen.confidence : 0;
            const qwenImportance = typeof qwen?.importance === "number" ? qwen.importance : null;
            const qwenImportant = qwenImportance !== null && qwenImportance >= 80;
            const importantCaptured = !qwenImportant || small.status === "keep";
            const verdict = !qwen || qwenConfidence < 0.55 ? "uncertain"
              : importantCaptured ? "correct" : "incorrect";
            return {
              targetKind: "important_recall",
              targetId: `triage:${small.articleId}:${small.fingerprint}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`,
              sampled: true,
              verdict,
              confidence: qwenConfidence,
              modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
              detailJson: {
                title: candidates.get(small.articleId)?.title || small.articleId,
                meta: `${pipelineModelId()} ↔ ${text(response?.model) || activeModelName || "Qwen reviewer"}`,
                reason: `8B=${small.status}/${Math.round(small.importance ?? 0)}；Qwen=${qwen?.keep === true ? "keep" : qwen?.keep === false ? "filter" : "unknown"}/${qwenImportance ?? "?"}；重大新闻召回=${importantCaptured ? "命中" : "漏筛"}`,
                badge: verdict === "correct" ? "判定一致" : verdict === "incorrect" ? "判定冲突" : "复核不确定",
                confidence: qwenConfidence,
                reviewType: "triage",
              },
            };
          });
          reviews.push({
            targetKind: "json_compliance",
            targetId: `json:triage:${batch.map((decision) => `${decision.articleId}:${decision.fingerprint}`).join("|")}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`.slice(0, 500),
            sampled: true, verdict: "compliant", confidence: 1,
            modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
            detailJson: { title: `文章初筛 JSON · ${batch.length} 篇`, meta: "Qwen reviewer", reason: "结构化响应已由原生命令完整校验。", badge: "JSON 合规", confidence: 1, reviewType: "json_compliance" },
          });
          if (await persistQualityReviews(reviews)) reviewed += batch.length;
          else pending += batch.length;
        } catch {
          pending += batch.length;
          await persistQualityReviews([{
            targetKind: "json_compliance",
            targetId: `json:triage-failed:${batch.map((decision) => `${decision.articleId}:${decision.fingerprint}`).join("|")}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`.slice(0, 500),
            sampled: true, verdict: "noncompliant", confidence: 0,
            modelId: activeModelName || "configured-qwen-reviewer",
            detailJson: { title: `文章初筛 JSON · ${batch.length} 篇`, meta: "Qwen reviewer", reason: "本轮未取得可校验的结构化响应。", badge: "JSON 未通过", confidence: 0, reviewType: "json_compliance" },
          }]);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      setAuditStage({
        id: "qwen-review",
        status: pending > 0 ? "warning" : "running",
        unit: "articles",
        inputCount: reviewCandidates.length,
        outputCount: reviewed,
        pendingCount: pending,
        summary: pending > 0
          ? `Qwen 已完成 ${reviewed} / ${reviewCandidates.length} 篇分层抽检，${pending} 篇因每层 ${INTELLIGENCE_QWEN_REVIEW_MAX_PER_LAYER} 条上限或服务暂不可用保持待复核；失败不会放宽合并条件。`
          : `Qwen 已真实抽检 ${reviewed} 篇重大、低置信或确定性 ${nativeReviewGate?.eligibleForReducedReview === true ? "5%" : "20% 校准"} 样本；结果已写入质量门，不把最终写稿冒充正确率复核。`,
      });
    };

    const runNativeRelationPipeline = async (
      briefingResult: IntelligenceBriefing,
      triageDecisions: readonly IntelligenceStoredTriageDecision[],
    ): Promise<boolean> => {
      if (!transport) return false;
      const candidateByArticleId = pipelineCandidatesByArticleId(briefingResult);
      const kept = triageDecisions.filter((decision) => decision.status === "keep" && candidateByArticleId.has(decision.articleId));
      const triageByArticleId = new Map(kept.map((decision) => [decision.articleId, decision]));
      if (kept.length === 0) {
        currentCandidates = [];
        setAuditStage({ id: "relation-recall", status: "accepted", unit: "pairs", inputCount: 0, outputCount: 0, summary: "本轮没有通过逐篇初筛的文章，无需召回关系。" });
        setAuditStage({ id: "relation-judge", status: "accepted", unit: "pairs", inputCount: 0, outputCount: 0, summary: "本轮没有待判定关系。" });
        setAuditStage({ id: "historical-recall", status: "accepted", unit: "events", inputCount: 0, outputCount: 0, summary: "本轮没有待关联的历史事件。" });
        return true;
      }
      const storedProjections = await readStoredEventProjections(kept.map((decision) => decision.articleId));
      const projectedArticleIds = new Set(storedProjections.map((projection) => projection.articleId));
      const storedCandidates = candidatesFromStoredEventProjections(storedProjections, candidateByArticleId, triageByArticleId);
      const unresolved = kept.filter((decision) => !projectedArticleIds.has(decision.articleId));
      const selectEditorialEvents = (candidates: readonly IntelligenceBriefCandidate[]): IntelligenceBriefCandidate[] => (
        candidates.slice().sort((left, right) => (
          right.entry.importance - left.entry.importance
          || right.publishedAt.localeCompare(left.publishedAt)
          || left.eventId!.localeCompare(right.eventId!)
        )).slice(0, DAILY_DIGEST_DEFAULT_ENTRY_COUNT)
      );
      if (unresolved.length === 0) {
        currentCandidates = selectEditorialEvents(storedCandidates);
        setAuditStage({ id: "relation-recall", status: "cached", unit: "pairs", inputCount: kept.length, outputCount: 0, reusedCount: kept.length, summary: "全部保留文章均已有稳定事件投影；本轮未再次调用语义召回或关系模型。" });
        setAuditStage({ id: "relation-judge", status: "cached", unit: "pairs", inputCount: 0, outputCount: 0, reusedCount: kept.length, summary: "已复用持久化八类关系判定；只有新增或正文指纹变化的文章才会重新判定。" });
        setAuditStage({ id: "historical-recall", status: "cached", unit: "events", inputCount: currentCandidates.length, outputCount: currentCandidates.filter((candidate) => candidate.seriesId).length, summary: "已复用稳定事件与历史系列关联。" });
        setAuditStage({ id: "series-timeline", status: "cached", unit: "series", inputCount: currentCandidates.length, outputCount: new Set(currentCandidates.map((candidate) => candidate.seriesId).filter(Boolean)).size, reusedCount: currentCandidates.length, summary: "事件时间线命中本机持久缓存；打开简报不会重复运行模型。" });
        renderBriefCards();
        return true;
      }
      const articles = unresolved.map((decision) => {
        const candidate = candidateByArticleId.get(decision.articleId)!;
        return {
          articleId: decision.articleId,
          title: candidate.title,
          summary: candidate.summary,
          publishedAt: candidate.publishedAt,
        };
      });
      let recall: UnknownRecord;
      try {
        const pairByKey = new Map<string, unknown>();
        const historicalByKey = new Map<string, unknown>();
        const engines = new Set<string>();
        for (const batch of chunkIntelligencePipelineArticles(articles.map((article) => ({
          ...article,
          fingerprint: "relation-recall",
        })), INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE)) {
          const response = record(await transport.invoke<unknown>("intelligence_pipeline_recall_relations", {
            articles: batch.map(({ fingerprint, ...article }) => {
              void fingerprint;
              return article;
            }),
            includeHistory: true,
          }));
          if (!response || !Array.isArray(response.pairs)) throw new Error("relation-recall-response-invalid");
          if (text(response.engine)) engines.add(text(response.engine));
          response.pairs.map(record).forEach((pair) => {
            const left = text(pair?.leftArticleId);
            const right = text(pair?.rightArticleId);
            const key = text(pair?.id) || [left, right].sort().join("\u001f");
            if (key) pairByKey.set(key, pair);
          });
          if (Array.isArray(response.historicalCandidates)) response.historicalCandidates.map(record).forEach((candidate) => {
            const key = text(candidate?.id) || `${text(candidate?.newArticleId)}\u001f${text(candidate?.eventId)}`;
            if (key) historicalByKey.set(key, candidate);
          });
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        recall = {
          pairs: [...pairByKey.values()],
          historicalCandidates: [...historicalByKey.values()],
          engine: [...engines].join(" + "),
        };
      } catch {
        setAuditStage({
          id: "relation-recall", status: "warning", unit: "pairs", inputCount: kept.length, outputCount: 0,
          summary: "语义召回与重排服务尚未就绪；为避免错误聚合，本轮不会把未核验文章交给 Qwen 生成综合报道。",
        });
        publishAudit("逐篇初筛已保存；关系召回尚未就绪，稍后可从此断点继续。");
        return false;
      }
      const rawRecalledPairs = Array.isArray(recall.pairs) ? recall.pairs.map(record) : [];
      const recalledPairs = rawRecalledPairs.flatMap((pair, index) => {
        const leftArticleId = text(pair?.leftArticleId);
        const rightArticleId = text(pair?.rightArticleId);
        if (!candidateByArticleId.has(leftArticleId) || !candidateByArticleId.has(rightArticleId) || leftArticleId === rightArticleId) return [];
        return [{
          id: text(pair?.id) || `relation-${index + 1}`,
          leftArticleId,
          rightArticleId,
          score: typeof pair?.score === "number" ? pair.score : 0,
          reason: text(pair?.reason),
        }];
      });
      const rawHistoricalCandidates = Array.isArray(recall.historicalCandidates)
        ? recall.historicalCandidates.map(record)
        : [];
      const historicalCandidates = rawHistoricalCandidates.flatMap((value, index) => {
        const newArticleId = text(value?.newArticleId);
        const eventId = text(value?.eventId);
        if (!newArticleId || !eventId || !unresolved.some((decision) => decision.articleId === newArticleId)) return [];
        return [{
          id: text(value?.id) || `historical-${index + 1}`,
          newArticleId,
          eventId,
          syntheticArticleId: `stored-event:${eventId}`,
          seriesId: text(value?.seriesId),
          latestRevision: typeof value?.latestRevision === "number" ? value.latestRevision : undefined,
          title: text(value?.title) || "历史事件",
          summary: text(value?.summary),
          occurredAt: text(value?.occurredAt),
          score: typeof value?.score === "number" ? value.score : 0,
          reason: text(value?.reason),
        }];
      });
      const retrievalEngine = text(recall.engine) || "当前语义召回与重排配置";
      setAuditStage({
        id: "relation-recall", status: "accepted", unit: "pairs", inputCount: unresolved.length, outputCount: recalledPairs.length + historicalCandidates.length, pendingCount: recalledPairs.length + historicalCandidates.length,
        summary: `${retrievalEngine} 只为 ${unresolved.length} 篇新增/变化文章召回 ${recalledPairs.length} 对当前候选和 ${historicalCandidates.length} 个历史候选；召回结果本身不触发合并。`,
        items: [...recalledPairs.map((pair) => ({
          id: pair.id,
          title: `${candidateByArticleId.get(pair.leftArticleId)!.title} ↔ ${candidateByArticleId.get(pair.rightArticleId)!.title}`,
          meta: `${retrievalEngine} · ${(pair.score * 100).toFixed(1)}%`,
          reason: pair.reason,
          status: "pending" as const,
          badge: "待八类关系判定",
        })), ...historicalCandidates.map((candidate) => ({
          id: candidate.id,
          title: `${candidateByArticleId.get(candidate.newArticleId)!.title} ↔ ${candidate.title}`,
          meta: `${retrievalEngine} · 历史事件 · ${(candidate.score * 100).toFixed(1)}%`,
          reason: candidate.reason,
          status: "pending" as const,
          badge: "待历史关系判定",
        }))].slice(0, 40),
      });
      const relationDecisions: IntelligencePipelineRelationDecision[] = [];
      const relationAuditDecisions: IntelligencePipelineRelationDecision[] = [];
      let forcedExactDuplicateReviews = 0;
      const judgePairs = [
        ...recalledPairs.map((pair) => {
          const left = candidateByArticleId.get(pair.leftArticleId)!;
          const right = candidateByArticleId.get(pair.rightArticleId)!;
          return {
            id: pair.id,
            leftArticleId: pair.leftArticleId,
            rightArticleId: pair.rightArticleId,
            left: { articleId: pair.leftArticleId, title: left.title, summary: left.summary, publishedAt: left.publishedAt },
            right: { articleId: pair.rightArticleId, title: right.title, summary: right.summary, publishedAt: right.publishedAt },
            retrievalScore: pair.score,
            retrievalReason: pair.reason,
            historical: false,
          };
        }),
        ...historicalCandidates.map((candidate) => {
          const left = candidateByArticleId.get(candidate.newArticleId)!;
          return {
            id: candidate.id,
            leftArticleId: candidate.newArticleId,
            rightArticleId: candidate.syntheticArticleId,
            left: { articleId: candidate.newArticleId, title: left.title, summary: left.summary, publishedAt: left.publishedAt },
            right: { articleId: candidate.syntheticArticleId, eventId: candidate.eventId, seriesId: candidate.seriesId, title: candidate.title, summary: candidate.summary, publishedAt: candidate.occurredAt },
            retrievalScore: candidate.score,
            retrievalReason: candidate.reason,
            historical: true,
          };
        }),
      ];
      const relationInputFingerprint = (pair: (typeof judgePairs)[number]): string => (
        intelligencePipelineFingerprint(JSON.stringify({
          left: pair.left,
          right: pair.right,
          retrievalScore: pair.retrievalScore,
          retrievalReason: pair.retrievalReason,
        }))
      );
      const rawDecisionByPairId = new Map<string, UnknownRecord>();
      if (judgePairs.length > 0) {
        await ensureNativeRuntimePhase("triage", "已切换到 8B 全量判断阶段");
        try {
          for (let start = 0; start < judgePairs.length; start += INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE) {
            const batch = judgePairs.slice(start, start + INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE);
            const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_pipeline_judge_relations", {
              pairs: batch.map(({ leftArticleId, rightArticleId, historical, ...pair }) => {
                void leftArticleId;
                void rightArticleId;
                void historical;
                return pair;
              }),
              baseUrl: pipelineJudgeBaseUrl(),
              model: pipelineModelId(),
            }, "triage", "8B 关系判断连接已恢复，正在重试当前批次"));
            if (!response || !Array.isArray(response.decisions)) throw new Error("relation-judge-response-invalid");
            response.decisions.map(record).forEach((decision) => {
              const id = text(decision?.id);
              if (id) rawDecisionByPairId.set(id, decision!);
            });
            const checkpoints = batch.flatMap((pair) => {
              if (pair.historical) return [];
              const raw = rawDecisionByPairId.get(pair.id);
              const reportedRelation = parseIntelligenceRelation(raw?.relation);
              if (!raw || !reportedRelation) return [];
              const relation = reportedRelation === "exact_duplicate" ? "same_event" : reportedRelation;
              const inputFingerprint = relationInputFingerprint(pair);
              return [{
                leftArticleId: pair.leftArticleId,
                rightArticleId: pair.rightArticleId,
                relation,
                confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
                reason: text(raw.reason),
                stage: "relation-judge",
                modelId: pipelineModelId(),
                evidenceJson: JSON.stringify({
                  inputFingerprint,
                  modelId: pipelineModelId(),
                  promptVersion: INTELLIGENCE_RELATION_PROMPT_VERSION,
                  reviewStatus: "awaiting_27b",
                  reportedRelation,
                }),
              }];
            });
            if (checkpoints.length > 0) {
              await transport.invoke<unknown>("intelligence_store_upsert_relations", { relations: checkpoints });
            }
            setAuditStage({
              id: "relation-judge", status: "running", unit: "pairs", inputCount: judgePairs.length,
              outputCount: rawDecisionByPairId.size, pendingCount: Math.max(0, judgePairs.length - rawDecisionByPairId.size),
              summary: `${pipelineModelId()} 正在分批执行八类关系判定；已持久推进 ${rawDecisionByPairId.size} / ${judgePairs.length} 对。`,
            });
            publishAudit("关系判定按小批次持续推进；已完成批次不会因后续批次失败而丢失。");
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        } catch {
          if (rawDecisionByPairId.size > 0) {
            const partialPersist = judgePairs.flatMap((pair) => {
              const raw = rawDecisionByPairId.get(pair.id);
              const relation = parseIntelligenceRelation(raw?.relation);
              if (!raw || !relation || pair.historical) return [];
              return [{
                leftArticleId: pair.leftArticleId,
                rightArticleId: pair.rightArticleId,
                relation,
                confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
                reason: text(raw.reason), stage: "relation-judge", modelId: pipelineModelId(),
                evidenceJson: JSON.stringify({
                  inputFingerprint: relationInputFingerprint(pair),
                  modelId: pipelineModelId(),
                  promptVersion: INTELLIGENCE_RELATION_PROMPT_VERSION,
                  reviewStatus: "awaiting_27b",
                  reportedRelation: relation,
                }),
              }];
            });
            if (partialPersist.length > 0) await transport.invoke<unknown>("intelligence_store_upsert_relations", { relations: partialPersist });
          }
          setAuditStage({
            id: "relation-judge", status: "warning", unit: "pairs", inputCount: judgePairs.length, outputCount: rawDecisionByPairId.size,
            pendingCount: Math.max(0, judgePairs.length - rawDecisionByPairId.size),
            summary: `7B/8B 已完成 ${rawDecisionByPairId.size} / ${judgePairs.length} 对；剩余批次保持待判定，所有未完整核验候选保持独立。`,
          });
          publishAudit("关系候选已保存；本机关系模型尚未完成判定，稍后可继续。");
          return false;
        }
        judgePairs.forEach((pair) => {
          const raw = rawDecisionByPairId.get(pair.id);
          const reportedRelation = parseIntelligenceRelation(raw?.relation) ?? "unrelated";
          // Canonical URL/content duplicates were already removed before the
          // model stage.  A later exact_duplicate label therefore cannot erase
          // a bilingual or independently reported source: keep both as
          // same_event evidence and force the 27B event review.
          const relation = reportedRelation === "exact_duplicate" ? "same_event" : reportedRelation;
          if (reportedRelation === "exact_duplicate") forcedExactDuplicateReviews += 1;
          const confidence = typeof raw?.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0;
          const audited: IntelligencePipelineRelationDecision = {
            leftArticleId: pair.leftArticleId,
            rightArticleId: pair.rightArticleId,
            relation,
            confidence,
            ...(text(raw?.reason) ? { reason: text(raw?.reason) } : {}),
          };
          relationAuditDecisions.push(audited);
        });
      }

      // `reviewMode` is persisted by the native quality gate.  A page reload
      // must never downgrade its full-review/fallback requirement to the old
      // UI sampling policy.  Unknown snapshots intentionally stay in `full`.
      const relationReviewMode = text(nativeReviewGate?.reviewMode) === "sample" ? "sample" : "full";
      const qwenReviewPairIds = new Set(selectIntelligenceRelationReviewIds(
        judgePairs.map((pair) => {
          const raw = rawDecisionByPairId.get(pair.id);
          const confidence = typeof raw?.confidence === "number" ? raw.confidence : 0;
          const proposedRelation = text(raw?.proposedRelation);
          const reportedRelation = text(raw?.relation);
          const importance = Math.max(
            triageByArticleId.get(pair.leftArticleId)?.importance ?? 0,
            triageByArticleId.get(pair.rightArticleId)?.importance ?? 0,
          );
          return {
            id: pair.id,
            sampleKey: `pair:${pair.leftArticleId}:${pair.rightArticleId}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`,
            important: importance >= 80,
            conflicting: raw?.requiresQwenReview === true
              || (proposedRelation !== "" && proposedRelation !== reportedRelation)
              || reportedRelation === "exact_duplicate",
            lowConfidence: confidence < 0.9,
          } satisfies IntelligenceRelationReviewCandidate;
        }),
        relationReviewMode,
      ));
      const qwenRequiredPairs = judgePairs.filter((pair) => qwenReviewPairIds.has(pair.id)).map((pair) => {
        const raw = rawDecisionByPairId.get(pair.id);
        const confidence = typeof raw?.confidence === "number" ? raw.confidence : 0;
        const highRisk = confidence < 0.9
          || raw?.requiresQwenReview === true
          || text(raw?.proposedRelation) !== "" && text(raw?.proposedRelation) !== text(raw?.relation)
          || text(raw?.relation) === "exact_duplicate";
        return { pair, highRisk };
      }).sort((left, right) => Number(right.highRisk) - Number(left.highRisk)
        || (Number(rawDecisionByPairId.get(left.pair.id)?.confidence) || 0) - (Number(rawDecisionByPairId.get(right.pair.id)?.confidence) || 0)
        || left.pair.id.localeCompare(right.pair.id));
      const qwenRequiredPairIds = new Set(qwenRequiredPairs.map((item) => item.pair.id));
      const qwenReviewByPairId = new Map<string, UnknownRecord>();
      let qwenRelationReviewPending = 0;
      if (qwenReviewPairIds.size > 0) {
        await ensureNativeRuntimePhase("editorial", "8B 判定已持久化，正在切换 27B 抽检阶段");
      }
      for (let start = 0; start < judgePairs.length; start += INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE) {
        const batch = judgePairs.slice(start, start + INTELLIGENCE_EVENT_JUDGE_BATCH_SIZE)
          .filter((pair) => qwenReviewPairIds.has(pair.id));
        if (batch.length === 0) continue;
        try {
          const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_judge_event_pairs", {
            request: {
              pairs: batch.map((pair) => ({
                id: pair.id,
                left: {
                  id: pair.leftArticleId,
                  title: pair.left.title,
                  summary: pair.left.summary,
                  publishedAt: pair.left.publishedAt,
                  sourceNames: [],
                },
                right: {
                  id: pair.historical ? `history-${stableEventHash(pair.rightArticleId)}` : pair.rightArticleId,
                  title: pair.right.title,
                  summary: pair.right.summary,
                  publishedAt: pair.right.publishedAt,
                  sourceNames: [],
                },
              })),
            },
          }, "editorial", "27B 关系复核服务断开，正在恢复编辑阶段"));
          const decisions = Array.isArray(response?.decisions) ? response.decisions.map(record) : [];
          const reviews = batch.map((pair) => {
            const small = rawDecisionByPairId.get(pair.id);
            const qwen = decisions.find((decision) => text(decision?.id) === pair.id);
            if (qwen) qwenReviewByPairId.set(pair.id, qwen);
            const smallRelation = parseIntelligenceRelation(small?.relation) ?? "unrelated";
            const qwenReported = parseIntelligenceRelation(qwen?.relation)
              ?? (qwen?.sameEvent === true ? "same_event" : "unrelated");
            const qwenRelation = qwenReported === "exact_duplicate" ? "same_event" : qwenReported;
            const normalizedSmall = smallRelation === "exact_duplicate" ? "same_event" : smallRelation;
            const qwenConfidence = typeof qwen?.confidence === "number" ? qwen.confidence : 0;
            const verdict = !qwen || qwenConfidence < 0.55 ? "uncertain"
              : qwenRelation === normalizedSmall ? "correct" : "incorrect";
            return {
              // Broad agreement is useful audit data, but it must not inflate
              // positive merge precision with thousands of matching
              // `unrelated` decisions.
              targetKind: "relation_accuracy", targetId: `relation:${pair.leftArticleId}:${pair.rightArticleId}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`,
              sampled: true, verdict, confidence: qwenConfidence,
              modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
              detailJson: {
                title: `${pair.left.title} ↔ ${pair.right.title}`,
                meta: `${pipelineModelId()} ↔ ${text(response?.model) || activeModelName || "Qwen reviewer"}`,
                reason: `8B=${normalizedSmall}；Qwen=${qwenRelation}`,
                badge: verdict === "correct" ? "关系一致" : verdict === "incorrect" ? "关系冲突，保持独立" : "复核不确定",
                confidence: qwenConfidence, reviewType: "relation",
              },
            };
          });
          batch.forEach((pair) => {
            const small = rawDecisionByPairId.get(pair.id);
            const smallRelation = parseIntelligenceRelation(small?.relation) ?? "unrelated";
            if (!["exact_duplicate", "syndicated_copy", "same_event"].includes(smallRelation)) return;
            const qwen = qwenReviewByPairId.get(pair.id);
            const qwenReported = parseIntelligenceRelation(qwen?.relation)
              ?? (qwen?.sameEvent === true ? "same_event" : "unrelated");
            const confirmed = ["exact_duplicate", "syndicated_copy", "same_event"].includes(qwenReported);
            const qwenConfidence = typeof qwen?.confidence === "number" ? qwen.confidence : 0;
            reviews.push({
              targetKind: "merge_precision", targetId: `pair:${pair.leftArticleId}:${pair.rightArticleId}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`,
              sampled: true, verdict: !qwen || qwenConfidence < 0.55 ? "uncertain" : confirmed ? "correct" : "incorrect",
              confidence: qwenConfidence,
              modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
              detailJson: { title: `${pair.left.title} ↔ ${pair.right.title}`, meta: "正向合并精确率", reason: confirmed ? "Qwen 确认属于可合并的同一事件/稿件。" : "Qwen 未确认合并，投影保持独立。", badge: confirmed ? "合并确认" : "阻止合并", confidence: qwenConfidence, reviewType: "merge_precision" },
            });
            reviews.push({
              targetKind: "false_merge", targetId: `false-merge:${pair.leftArticleId}:${pair.rightArticleId}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`,
              sampled: true, verdict: confirmed ? "no_false_merge" : "false_merge",
              confidence: qwenConfidence,
              modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
              detailJson: { title: `${pair.left.title} ↔ ${pair.right.title}`, meta: "误合并率复核", reason: confirmed ? "Qwen 确认属于可合并的同一事件/稿件。" : "Qwen 未确认合并，投影保持独立。", badge: confirmed ? "未误合并" : "阻止误合并", confidence: qwenConfidence, reviewType: "false_merge" },
            });
          });
          reviews.push({
            targetKind: "json_compliance", targetId: `json:relation:${batch.map((pair) => pair.id).join("|")}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`.slice(0, 500),
            sampled: true, verdict: "compliant", confidence: 1,
            modelId: text(response?.model) || activeModelName || "configured-qwen-reviewer",
            detailJson: { title: `关系判定 JSON · ${batch.length} 对`, meta: "Qwen reviewer", reason: "结构化响应已由原生命令完整校验。", badge: "JSON 合规", confidence: 1, reviewType: "json_compliance" },
          });
          if (!(await persistQualityReviews(reviews))) qwenRelationReviewPending += batch.length;
        } catch {
          qwenRelationReviewPending += batch.length;
          await persistQualityReviews([{
            targetKind: "json_compliance", targetId: `json:relation-failed:${batch.map((pair) => pair.id).join("|")}:${INTELLIGENCE_PIPELINE_PROMPT_VERSION}`.slice(0, 500),
            sampled: true, verdict: "noncompliant", confidence: 0,
            modelId: activeModelName || "configured-qwen-reviewer",
            detailJson: { title: `关系判定 JSON · ${batch.length} 对`, meta: "Qwen reviewer", reason: "本轮未取得可校验的结构化响应。", badge: "JSON 未通过", confidence: 0, reviewType: "json_compliance" },
          }]);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      judgePairs.forEach((pair) => {
        const raw = rawDecisionByPairId.get(pair.id);
        const audited = relationAuditDecisions.find((decision) => (
          decision.leftArticleId === pair.leftArticleId && decision.rightArticleId === pair.rightArticleId
        ));
        if (!audited) return;
        const qwen = qwenReviewByPairId.get(pair.id);
        const requiresReview = qwenRequiredPairIds.has(pair.id);
        const qwenReported = parseIntelligenceRelation(qwen?.relation)
          ?? (qwen?.sameEvent === true ? "same_event" : "unrelated");
        const qwenRelation = qwenReported === "exact_duplicate" ? "same_event" : qwenReported;
        const smallRelation = audited.relation === "exact_duplicate" ? "same_event" : audited.relation;
        const qwenConfidence = typeof qwen?.confidence === "number" ? qwen.confidence : 0;
        const confirmedByQwen = qwen && qwenConfidence >= 0.8 && qwenRelation === smallRelation;
        // Before the persisted four-metric quality gate passes, an unreviewed
        // positive relation cannot merge events even at high 8B confidence.
        // Temporary under-merging is safer than creating a false event cluster.
        const safeWithoutReview = relationReviewMode === "sample"
          && !requiresReview && audited.confidence >= 0.9;
        relationDecisions.push(confirmedByQwen || safeWithoutReview
          ? audited
          : { ...audited, relation: "unrelated", reason: `${audited.reason || text(raw?.reason)}；Qwen 复核未确认，保守保持独立` });
      });
      if (qwenRequiredPairIds.size > 0) setAuditStage({
        id: "qwen-review",
        status: qwenRelationReviewPending > 0 ? "warning" : "running",
        unit: "pairs",
        inputCount: qwenRequiredPairIds.size,
        outputCount: qwenReviewByPairId.size,
        pendingCount: qwenRelationReviewPending,
        summary: qwenRelationReviewPending > 0
          ? `Qwen 已实际复核 ${qwenReviewByPairId.size} / ${qwenRequiredPairIds.size} 对关系，${qwenRelationReviewPending} 对因服务暂不可用保持待复核；未确认关系保持独立。`
          : relationReviewMode === "full"
            ? `质量门处于全量复核期：Qwen 已实际复核本批全部 ${qwenReviewByPairId.size} 对关系，未套用旧的 20%/5% 或 50 条上限。`
            : `质量门处于抽样期：Qwen 已实际复核 ${qwenReviewByPairId.size} 对重大、冲突、低置信关系及至少 10% 的确定性随机样本。`,
      });
      const historicalSyntheticIds = new Set(historicalCandidates.map((candidate) => candidate.syntheticArticleId));
      const persistableRelations = relationDecisions.filter((decision) => !historicalSyntheticIds.has(decision.rightArticleId));
      for (let start = 0; start < persistableRelations.length; start += INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE) {
        await transport.invoke<unknown>("intelligence_store_upsert_relations", {
          relations: persistableRelations.slice(start, start + INTELLIGENCE_RELATION_JUDGE_BATCH_SIZE).map((decision) => {
            const pair = judgePairs.find((candidate) => (
              candidate.leftArticleId === decision.leftArticleId && candidate.rightArticleId === decision.rightArticleId
            ));
            const qwen = pair ? qwenReviewByPairId.get(pair.id) : undefined;
            const qwenConfidence = typeof qwen?.confidence === "number" ? qwen.confidence : 0;
            return {
              ...decision,
              stage: "relation-judge",
              modelId: pipelineModelId(),
              evidenceJson: JSON.stringify({
                inputFingerprint: pair ? relationInputFingerprint(pair) : "",
                modelId: pipelineModelId(),
                promptVersion: INTELLIGENCE_RELATION_PROMPT_VERSION,
                reviewStatus: qwen && qwenConfidence >= 0.8
                  ? "confirmed_27b"
                  : relationReviewMode === "sample" && !qwenReviewPairIds.has(pair?.id ?? "") && decision.relation !== "unrelated"
                    ? "quality_gate_accepted"
                    : "awaiting_27b",
                reviewerModel: qwen ? activeModelName || "configured-qwen-reviewer" : "",
              }),
            };
          }),
        });
      }
      setAuditStage({
        id: "relation-judge", status: relationAuditDecisions.some((decision) => decision.confidence < 0.9) || forcedExactDuplicateReviews > 0 ? "warning" : "accepted", unit: "pairs", inputCount: judgePairs.length, outputCount: relationAuditDecisions.length,
        pendingCount: relationAuditDecisions.filter((decision) => decision.confidence < 0.9).length + forcedExactDuplicateReviews,
        summary: `${pipelineModelId()} 已按八类关系判定 ${relationAuditDecisions.length} 对候选；低于 90% 置信度的关系只进待复核。${forcedExactDuplicateReviews > 0 ? ` ${forcedExactDuplicateReviews} 个非精确阶段的 exact_duplicate 已降级为 same_event，保留全部来源并强制 Qwen 复核。` : ""}`,
        items: relationAuditDecisions.slice(0, 40).map((decision) => ({
          title: `${candidateByArticleId.get(decision.leftArticleId)?.title || decision.leftArticleId} ↔ ${candidateByArticleId.get(decision.rightArticleId)?.title || historicalCandidates.find((candidate) => candidate.syntheticArticleId === decision.rightArticleId)?.title || decision.rightArticleId}`,
          meta: pipelineModelId(), reason: decision.reason || "结构化关系判定", confidence: decision.confidence,
          status: decision.confidence < 0.9 ? "warning" : decision.relation === "unrelated" ? "rejected" : "accepted", badge: decision.relation,
        })),
      });
      const existingAssignments = [
        ...storedProjections.map(({ articleId, eventId, seriesId }) => ({ articleId, eventId, ...(seriesId ? { seriesId } : {}) })),
        ...historicalCandidates.map((candidate) => ({
          articleId: candidate.syntheticArticleId,
          eventId: candidate.eventId,
          ...(candidate.seriesId ? { seriesId: candidate.seriesId } : {}),
        })),
      ];
      const linkedStoredArticleIds = relationDecisions.flatMap((decision) => [decision.leftArticleId, decision.rightArticleId])
        .filter((articleId, index, values) => projectedArticleIds.has(articleId) && values.indexOf(articleId) === index);
      const projectionArticleIds = [
        ...unresolved.map((decision) => decision.articleId),
        ...linkedStoredArticleIds,
        ...historicalCandidates.map((candidate) => candidate.syntheticArticleId),
      ];
      const projections = projectStableIntelligenceEvents(projectionArticleIds, relationDecisions, existingAssignments);
      const eventCandidates: IntelligenceBriefCandidate[] = [];
      for (const projection of projections) {
        const currentArticleIds = projection.articleIds.filter((articleId) => !historicalSyntheticIds.has(articleId));
        const members = currentArticleIds.map((articleId) => candidateByArticleId.get(articleId)).filter((candidate): candidate is IntelligenceBriefCandidate => Boolean(candidate));
        if (members.length === 0) continue;
        const representative = members[0]!;
        const importance = Math.max(...currentArticleIds.map((articleId) => triageByArticleId.get(articleId)?.importance ?? 0));
        const stored = record(await transport.invoke<unknown>("intelligence_store_upsert_event", {
          eventId: projection.eventId,
          ...(projection.seriesId ? { seriesId: projection.seriesId } : {}),
          title: representative.title,
          summary: representative.summary,
          importance,
          occurredAt: representative.publishedAt,
          articleIds: currentArticleIds,
          // Membership projection is metadata, not a published article
          // revision. Supplying revisionJson here would create a new empty
          // latest revision on every run and hide the reusable 27B body.
        }));
        const eventId = text(stored?.eventId) || projection.eventId;
        const revision = Number(stored?.revision ?? stored?.currentRevision);
        const candidate = candidateFromEventMembers(eventId, members, importance, Number.isFinite(revision) ? {
          articleId: currentArticleIds[0]!, eventId, revision,
          ...(text(stored?.seriesId) || projection.seriesId ? { seriesId: text(stored?.seriesId) || projection.seriesId! } : {}),
        } : undefined, text(stored?.seriesId) || projection.seriesId);
        if (candidate) eventCandidates.push(candidate);
      }
      const allCandidatesByEvent = new Map<string, IntelligenceBriefCandidate[]>();
      [...storedCandidates, ...eventCandidates].forEach((candidate) => {
        allCandidatesByEvent.set(candidate.eventId!, [...(allCandidatesByEvent.get(candidate.eventId!) ?? []), candidate]);
      });
      const mergedCandidates = [...allCandidatesByEvent.entries()].flatMap(([eventId, candidates]) => {
        const importance = Math.max(...candidates.map((candidate) => candidate.entry.importance));
        const latest = candidates.slice().sort((left, right) => (right.revision ?? 0) - (left.revision ?? 0))[0]!;
        const merged = candidateFromEventMembers(eventId, candidates, importance, latest.revision === undefined ? undefined : {
          articleId: "", eventId, revision: latest.revision, ...(latest.seriesId ? { seriesId: latest.seriesId } : {}),
          title: latest.title, summary: latest.summary, occurredAt: latest.publishedAt,
        }, latest.seriesId);
        return merged ? [merged] : [];
      });
      const seriesEventIds = new Map<string, Set<string>>();
      projections.forEach((projection) => {
        if (projection.seriesId) seriesEventIds.set(projection.seriesId, new Set([
          ...(seriesEventIds.get(projection.seriesId) ?? []),
          projection.eventId,
        ]));
      });
      mergedCandidates.forEach((candidate) => {
        if (candidate.seriesId) seriesEventIds.set(candidate.seriesId, new Set([
          ...(seriesEventIds.get(candidate.seriesId) ?? []),
          candidate.eventId!,
        ]));
      });
      for (const [seriesId, eventIds] of seriesEventIds) {
        const representative = mergedCandidates.find((candidate) => candidate.seriesId === seriesId);
        await transport.invoke<unknown>("intelligence_store_upsert_series", {
          seriesId,
          title: representative?.title || "新闻系列",
          summary: representative?.summary || "",
          eventIds: [...eventIds],
        });
      }
      currentCandidates = selectEditorialEvents(mergedCandidates);
      const historicalCount = historicalCandidates.length;
      setAuditStage({
        id: "historical-recall", status: rawHistoricalCandidates.length > historicalCount ? "warning" : "accepted", unit: "events", inputCount: unresolved.length, outputCount: historicalCount,
        summary: `历史事件索引为 ${unresolved.length} 篇新增/变化文章召回 ${historicalCount} 个带稳定 eventId 的候选；缺少稳定 ID 的结果只留审计、不自动挂接。`,
      });
      setAuditStage({
        id: "series-timeline", status: "accepted", unit: "series", inputCount: mergedCandidates.length, outputCount: seriesEventIds.size,
        summary: `已保留/写入 ${mergedCandidates.length} 个稳定事件和 ${seriesEventIds.size} 个新闻系列；新增来源只创建修订，不改变既有 eventId。`,
      });
      renderBriefCards();
      return true;
    };

    const scheduleNativeIngestion = (briefingResult: IntelligenceBriefing): void => {
      pendingNativeIngestion = briefingResult;
      if (nativeIngestionActive) return;
      nativeIngestionActive = true;
      nativeIngestionFailed = false;
      void (async () => {
        if (nativePipelineCapability === null) {
          const available = await new Promise<boolean>((resolve) => pipelineCapabilityWaiters.push(resolve));
          if (!available) return;
        }
        if (nativePipelineCapability === false) return;
        const port = nativePipelinePort();
        if (!port) return;
        while (pendingNativeIngestion) {
          const next = pendingNativeIngestion;
          pendingNativeIngestion = null;
          const changed = pipelineArticlesForBriefing(next).filter((article) => (
            nativeIngestedFingerprints.get(article.articleId) !== article.fingerprint
          ));
          if (changed.length === 0) continue;
          let queuedDelta = 0; let unchanged = 0;
          try {
            for (const batch of chunkIntelligencePipelineArticles(changed, INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE)) {
              const result = await port.upsertArticles(batch);
              queuedDelta += result.inserted + result.updated;
              unchanged += result.unchanged;
              batch.forEach((article) => nativeIngestedFingerprints.set(article.articleId, article.fingerprint));
            }
          } catch (error: unknown) {
            // Preserve the newest cumulative snapshot for the next source
            // render or explicit refresh; never spin on a broken store.
            if (!pendingNativeIngestion) pendingNativeIngestion = next;
            throw error;
          }
          await refreshNativePipelineSnapshot(
            queuedDelta > 0
              ? `增量来源批次已立即写入本机持久队列：新增或变化 ${queuedDelta} 篇；${unchanged} 篇复用既有判断。`
              : `增量来源批次已核对；${unchanged} 篇未变化文章继续复用既有判断。`,
          );
        }
      })().catch((error: unknown) => {
        // The in-memory catalogue remains available, but never claim that a
        // failed incremental write reached SQLite. The latest full snapshot
        // stays pending and a later render/refresh can safely retry it.
        nativeIngestionFailed = true;
        modelStatus.textContent = `增量来源尚未全部写入持久队列，稍后重试：${String(error)}`;
      }).finally(() => {
        nativeIngestionActive = false;
        if (pendingNativeIngestion && !nativeIngestionFailed) scheduleNativeIngestion(pendingNativeIngestion);
      });
    };

    const clearPipelineRetry = (resetAttempt = true): void => {
      if (pipelineRetryTimer !== null) clearTimeout(pipelineRetryTimer);
      pipelineRetryTimer = null;
      retryPipelineBriefing = null;
      if (resetAttempt) pipelineRetryAttempt = 0;
    };

    const schedulePipelineRetry = (briefingResult: IntelligenceBriefing, reason: string): void => {
      retryPipelineBriefing = pendingPipelineBriefing ?? briefingResult;
      pendingPipelineBriefing = null;
      if (pipelineRetryTimer !== null) return;
      const delay = intelligencePipelineRetryDelayMs(pipelineRetryAttempt);
      if (delay === null) {
        const message = `${reason} 自动续跑已达到本轮上限；持久队列与已完成判断均已保留，下次打开或手动刷新时继续。`;
        modelStatus.textContent = message;
        publishAudit(message);
        return;
      }
      pipelineRetryAttempt += 1;
      const retryAt = Date.now() + delay;
      const retryTime = new Date(retryAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      const message = `${reason} 已保留断点；等待当前租约到期，预计 ${retryTime} 自动续跑（第 ${pipelineRetryAttempt} / ${INTELLIGENCE_PIPELINE_RETRY_DELAYS_MS.length} 次）。`;
      modelStatus.textContent = message;
      publishAudit(message);
      pipelineRetryTimer = setTimeout(() => {
        pipelineRetryTimer = null;
        const next = retryPipelineBriefing;
        retryPipelineBriefing = null;
        if (next) scheduleNativePipeline(next);
      }, delay);
      (pipelineRetryTimer as unknown as { unref?: () => void }).unref?.();
    };

    const runNativePipelineBriefing = async (briefingResult: IntelligenceBriefing): Promise<boolean> => {
      const port = nativePipelinePort();
      if (!port) return true;
      activeNativeRunId = "";
      try {
        const run = record(await transport?.invoke<unknown>("intelligence_store_start_run", {}));
        if (text(run?.runId)) activeNativeRunId = text(run?.runId);
      } catch {
        // Older binaries use the controller-local run id; pipeline capability
        // detection below still decides whether the native path is available.
      }
      const finishNativeRun = async (status: "completed" | "failed" | "cancelled"): Promise<void> => {
        if (!transport || !activeNativeRunId) return;
        try {
          await transport.invoke<unknown>("intelligence_store_finish_run", { runId: activeNativeRunId, status });
        } catch { /* run lifecycle is audit metadata, never an article-loss path */ }
      };
      if (nativePipelineCapability === false) {
        nativePipelineActive = false;
        await generateCurrentBrief(loadGeneration);
        await saveCurrentDailyDigest();
        await finishNativeRun("cancelled");
        return true;
      }
      const articles = pipelineArticlesForBriefing(briefingResult);
      pipelineState = reduceIntelligencePipelineState(pipelineState, {
        type: "upsert-started",
        received: briefingResult.inputCount,
        unique: articles.length,
      });
      let queued = 0;
      let reused = 0;
      try {
        for (const batch of chunkIntelligencePipelineArticles(articles, INTELLIGENCE_PIPELINE_UPSERT_BATCH_SIZE)) {
          const result = await port.upsertArticles(batch);
          // `queued` is the store-wide queue depth on current native builds,
          // not this batch's delta. Only inserted/changed records were newly
          // enqueued by this invocation.
          queued += result.inserted + result.updated;
          reused += result.unchanged;
          batch.forEach((article) => nativeIngestedFingerprints.set(article.articleId, article.fingerprint));
        }
        nativePipelineCapability = true;
        pipelineCapabilityWaiters.splice(0).forEach((resolve) => resolve(true));
      } catch {
        // Compatibility with an installed binary from before the SQLite
        // intelligence store: keep the previous bounded flow, but never claim
        // that it is the persistent all-article pipeline.
        nativePipelineActive = false;
        nativePipelineCapability = false;
        pipelineCapabilityWaiters.splice(0).forEach((resolve) => resolve(false));
        pipelineState = reduceIntelligencePipelineState(pipelineState, {
          type: "paused",
          message: "当前安装版尚未提供本机持久情报队列，暂时使用兼容流程。",
        });
        await generateCurrentBrief(loadGeneration);
        await saveCurrentDailyDigest();
        await finishNativeRun("cancelled");
        return true;
      }
      nativePipelineActive = true;
      pipelineState = reduceIntelligencePipelineState(pipelineState, { type: "upsert-finished", queued, reused });
      await refreshNativePipelineSnapshot("唯一文章已进入本机持久队列；审计详情按需分页读取。");
      try {
        if (queued > 0) await ensureNativeRuntimePhase("triage", "新增文章正在交给 8B 全量判断");
        const before = await readStoredTriageDecisions(articles.map((article) => article.articleId));
        projectStoredTriage(briefingResult, before);
        pipelineState = await runIntelligenceArticleTriageQueue(port, pipelineState, {
          modelId: pipelineModelId(),
          promptVersion: INTELLIGENCE_PIPELINE_PROMPT_VERSION,
          batchSize: INTELLIGENCE_ARTICLE_TRIAGE_BATCH_SIZE,
          leaseSeconds: INTELLIGENCE_TRIAGE_LEASE_SECONDS,
          shouldContinue: () => Boolean(transport),
          yieldControl: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
          onState: (state) => {
            pipelineState = state;
            modelStatus.textContent = state.message;
          },
        });
        const after = await readStoredTriageDecisions(articles.map((article) => article.articleId));
        projectStoredTriage(briefingResult, after);
        const previouslyReviewedInputs = new Set(before.map((decision) => `${decision.articleId}\u001f${decision.fingerprint}`));
        const changedTriageDecisions = after.filter((decision) => !previouslyReviewedInputs.has(`${decision.articleId}\u001f${decision.fingerprint}`));
        await refreshNativePipelineSnapshot(pipelineState.phase === "completed"
          ? "全量文章初筛已完成；正在召回当前与历史事件关系。"
          : pipelineState.message);
        const relationsReady = pipelineState.phase === "completed"
          ? await runNativeRelationPipeline(briefingResult, after)
          : false;
        await refreshNativePipelineSnapshot(relationsReady
          ? "新增关系已判定并投影为稳定事件；正在复用或生成事件级综合报道。"
          : pipelineState.message);
        if (pipelineState.phase === "completed" && relationsReady) {
          // Quality review is incremental and intentionally waits until every
          // 8B relation batch is persisted. That gives the runtime one clean
          // GPU hand-off to 27B for both auditing and final editorial work.
          await runQwenTriageQualityReview(briefingResult, changedTriageDecisions);
          await generateCurrentBrief(loadGeneration);
          await saveCurrentDailyDigest();
        }
        const completed = pipelineState.phase === "completed" && relationsReady;
        await finishNativeRun(completed ? "completed" : "failed");
        if (!completed) {
          schedulePipelineRetry(briefingResult, pipelineState.message);
          return false;
        }
        clearPipelineRetry();
        return true;
      } catch (error: unknown) {
        await finishNativeRun("failed");
        pipelineState = reduceIntelligencePipelineState(pipelineState, {
          type: "paused",
          message: `本机增量队列已保留进度，下次从断点继续：${String(error)}`,
        });
        modelStatus.textContent = pipelineState.message;
        publishAudit(pipelineState.message);
        schedulePipelineRetry(briefingResult, pipelineState.message);
        return false;
      }
    };

    const scheduleNativePipeline = (briefingResult: IntelligenceBriefing): void => {
      pendingPipelineBriefing = briefingResult;
      if (pipelineRetryTimer !== null) {
        retryPipelineBriefing = briefingResult;
        scheduleNativeIngestion(briefingResult);
        return;
      }
      if (pipelineWorkerActive) {
        // Model/relation processing may take minutes, but ingestion must not
        // wait behind it. Every cumulative source-batch render schedules an
        // idempotent SQLite delta; the final full snapshot therefore cannot
        // remain stranded only in the WebView.
        scheduleNativeIngestion(briefingResult);
        return;
      }
      pipelineWorkerActive = true;
      pipelineWorkerPromise = (async () => {
        while (pendingPipelineBriefing) {
          const next = pendingPipelineBriefing;
          pendingPipelineBriefing = null;
          const completed = await runNativePipelineBriefing(next);
          if (!completed) break;
        }
      })().finally(() => { pipelineWorkerActive = false; pipelineWorkerPromise = null; });
    };

    const waitForPipelineCompatibility = async (): Promise<void> => {
      const available = nativePipelineCapability ?? await new Promise<boolean>((resolve) => {
        pipelineCapabilityWaiters.push(resolve);
      });
      // Compatibility generation is part of the historical synchronous load
      // contract. The real native pipeline is deliberately left in the
      // background so opening never waits on thousands of model calls.
      if (!available) await pipelineWorkerPromise;
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

    const preparedImageRequests = (candidate: IntelligenceBriefCandidate): UnknownRecord[] => (
      candidate.entry.evidenceItems.flatMap((item) => {
        const fields = item as UnknownRecord;
        const url = openableHttpsUrl(fields.url);
        if (!url) return [];
        return [{
          url,
          imageUrl: openableHttpsUrl(fields.imageUrl ?? fields.image_url),
          sourceId: text(fields.sourceId ?? fields.source_id),
          itemId: text(fields.id),
        }];
      }).filter((request, index, requests) => requests.findIndex((candidateRequest) => candidateRequest.url === request.url) === index)
        .slice(0, INTELLIGENCE_PREPARED_IMAGE_LIMIT)
    );

    const preloadPreparedBriefImage = async (candidate: IntelligenceBriefCandidate): Promise<void> => {
      if (!transport || (preparedBriefImages.get(candidate.id)?.length ?? 0) >= INTELLIGENCE_PREPARED_IMAGE_LIMIT || preparedBriefImageInFlight.has(candidate.id)) return;
      const requests = preparedImageRequests(candidate);
      if (requests.length === 0) return;
      preparedBriefImageInFlight.add(candidate.id);
      try {
        const images = [...(preparedBriefImages.get(candidate.id) ?? [])];
        for (const request of requests) {
          const response = record(await transport.invoke<unknown>("newsnow_preview_image", { request }));
          const image = safePreparedImageDataUrl(response?.imageDataUrl ?? response?.image_data_url);
          if (image && !images.includes(image)) images.push(image);
          if (images.length >= INTELLIGENCE_PREPARED_IMAGE_LIMIT) break;
        }
        if (images.length > 0) preparedBriefImages.set(candidate.id, images);
      } catch {
        // A cover is optional. The prepared text article remains immediately readable.
      } finally {
        preparedBriefImageInFlight.delete(candidate.id);
      }
    };

    const preloadPreparedBriefImages = (candidates: readonly IntelligenceBriefCandidate[]): void => {
      const queue = candidates.filter((candidate) => (preparedBriefImages.get(candidate.id)?.length ?? 0) < INTELLIGENCE_PREPARED_IMAGE_LIMIT);
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const candidate = queue.shift();
          if (candidate) await preloadPreparedBriefImage(candidate);
        }
      });
      void Promise.all(workers);
    };

    const enrichCurrentCandidates = async (onlyCandidateIds?: ReadonlySet<string>): Promise<void> => {
      if (!transport || currentCandidates.length === 0) return;
      // Every selected source is collected. The native fetcher itself retains
      // a bounded worker pool and an on-disk cache; batching here merely keeps
      // the UI responsive instead of silently dropping all but the first 12.
      const articles = currentCandidates.filter((candidate) => !onlyCandidateIds || onlyCandidateIds.has(candidate.id))
        .flatMap((candidate) => candidate.sources.map((source) => ({
        url: source.url, source: source.name, title: source.title, summary: source.summary,
        publishedAt: candidate.publishedAt,
      }))).filter((article) => openableHttpsUrl(article.url)).filter((article, index, all) => (
        all.findIndex((candidate) => candidate.url === article.url) === index
      ));
      if (articles.length === 0) return;
      const byUrl = new Map<string, UnknownRecord>();
      const failedUrls = new Set<string>();
      for (let start = 0; start < articles.length; start += INTELLIGENCE_SOURCE_BATCH_SIZE) {
        const batch = articles.slice(start, start + INTELLIGENCE_SOURCE_BATCH_SIZE);
        try {
          const enrichments = await transport.invoke<unknown>("newsnow_intelligence_enrich_articles", { request: { articles: batch } });
          (Array.isArray(enrichments) ? enrichments : []).forEach((value) => {
            const item = record(value); const url = openableHttpsUrl(item?.url);
            if (url && item) byUrl.set(url, item);
          });
          batch.forEach((article) => {
            const url = openableHttpsUrl(article.url);
            if (url && !byUrl.has(url)) failedUrls.add(url);
          });
        } catch {
          batch.forEach((article) => {
            const url = openableHttpsUrl(article.url);
            if (url) failedUrls.add(url);
          });
        }
      }
      currentCandidates = currentCandidates.map((candidate) => !onlyCandidateIds || onlyCandidateIds.has(candidate.id)
        ? ({ ...candidate, sources: candidate.sources.map((source) => {
        const sourceUrl = openableHttpsUrl(source.url);
        const item = byUrl.get(sourceUrl);
        // The map pass below must see the complete extracted page. The final
        // 27B request receives bounded per-chunk evidence, not a silently
        // truncated first-page prefix. A blocked source retains its last
        // usable body but is marked retryable instead of becoming a permanent
        // RSS-only editorial revision.
        const fetchedBody = text(item?.body);
        const body = fetchedBody || source.body || "";
        const explicitlyDegraded = item?.degraded === true
          || item?.fetchFailed === true || item?.fetch_failed === true
          || item?.complete === false;
        const degraded = Boolean(sourceUrl) && (failedUrls.has(sourceUrl) || explicitlyDegraded || !fetchedBody);
        const leadImageDataUrl = safePreparedImageDataUrl(item?.leadImageDataUrl ?? item?.lead_image_data_url)
          || source.leadImageDataUrl || "";
        if (leadImageDataUrl) {
          const images = preparedBriefImages.get(candidate.id) ?? [];
          if (!images.includes(leadImageDataUrl) && images.length < INTELLIGENCE_PREPARED_IMAGE_LIMIT) {
            preparedBriefImages.set(candidate.id, [...images, leadImageDataUrl]);
          }
        }
        const enrichedSource: IntelligenceBriefCandidate["sources"][number] = {
          ...source,
          ...(body ? { body } : {}),
          ...(leadImageDataUrl ? { leadImageDataUrl } : {}),
          imageUrls: Array.isArray(item?.imageUrls)
            ? item.imageUrls.map(openableHttpsUrl).filter(Boolean)
            : source.imageUrls ?? [],
          videoUrls: Array.isArray(item?.videoUrls)
            ? item.videoUrls.map(openableHttpsUrl).filter(Boolean)
            : source.videoUrls ?? [],
          ...(degraded ? {
            evidenceDegraded: true,
            retryAfter: evidenceRetryAfter(item?.retryAfter ?? item?.retry_after ?? source.retryAfter),
          } : {
            evidenceDegraded: false,
          }),
        };
        return {
          ...enrichedSource,
          evidenceFingerprint: text(item?.evidenceFingerprint ?? item?.evidence_fingerprint)
            || pipelineSourceEvidenceFingerprint(enrichedSource),
        };
      }) })
        : candidate);
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
    const modelSourceEvidenceKey = (source: IntelligenceBriefCandidate["sources"][number]): string => (
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
      const key = modelSourceEvidenceKey(source);
      const cached = sourceEvidenceCache.get(key);
      if (cached) return cached;
      const chunks = splitSourceEvidenceChunks(source.body || "");
      if (chunks.length === 0 || !transport) return source.summary;
      const evidence: string[] = [];
      for (const [index, chunk] of chunks.entries()) {
        const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_extract_source_evidence", {
          request: { source: source.name, title: source.title, chunk, chunkIndex: index + 1, chunkCount: chunks.length },
        }, "editorial", "全文证据服务断开，正在恢复 27B 编辑阶段"));
        const item = text(response?.evidence).trim();
        if (item) evidence.push(item);
      }
      // Do not cache a partial model pass: retry it next time rather than
      // presenting a cached article as though every source section was read.
      if (evidence.length !== chunks.length) throw new Error("incomplete source evidence");
      // Preserve an evidence trace from every body chunk instead of keeping
      // only the beginning of a long article. This compact map-reduce output
      // is what the final event pass sees for every selected source.
      const target = Math.min(
        INTELLIGENCE_SOURCE_EVIDENCE_MAX_CHARS,
        Math.max(INTELLIGENCE_SOURCE_EVIDENCE_MIN_CHARS, Math.ceil((source.body || source.summary).length * 0.12)),
      );
      const budget = Math.max(80, Math.floor(target / evidence.length));
      const combined = evidence.map((item) => item.slice(0, budget)).join("\n").slice(0, target);
      sourceEvidenceCache.set(key, combined);
      persistSourceEvidenceCache();
      return combined;
    };
    const extractEvidenceForCurrentCandidates = async (onlyCandidateIds?: ReadonlySet<string>): Promise<void> => {
      if (!transport || currentCandidates.length === 0) return;
      const allSources = currentCandidates.filter((candidate) => !onlyCandidateIds || onlyCandidateIds.has(candidate.id))
        .flatMap((candidate) => candidate.sources)
        .filter((source, index, sources) => sources.findIndex((candidate) => modelSourceEvidenceKey(candidate) === modelSourceEvidenceKey(source)) === index);
      let completed = 0;
      const evidenceByKey = new Map<string, string>();
      const failedKeys = new Set<string>();
      for (const source of allSources) {
        const sourceKey = modelSourceEvidenceKey(source);
        try {
          const evidence = await extractSourceEvidence(source);
          evidenceByKey.set(sourceKey, evidence);
          // A HTTPS source with no extracted body is a fetch degradation even
          // though its safe RSS summary can still be shown to the editor.
          if (openableHttpsUrl(source.url) && !source.body) failedKeys.add(sourceKey);
        } catch {
          // A blocked page retains its RSS summary and remains eligible for a
          // later full-text retry; it is never put into the completed cache.
          evidenceByKey.set(sourceKey, source.summary);
          failedKeys.add(sourceKey);
        }
        completed += 1;
        modelStatus.textContent = `正在读取全文并提炼证据 ${completed} / ${allSources.length} 篇…`;
      }
      currentCandidates = currentCandidates.map((candidate) => !onlyCandidateIds || onlyCandidateIds.has(candidate.id)
        ? ({ ...candidate, sources: candidate.sources.map((source) => {
          const sourceKey = modelSourceEvidenceKey(source);
          const degraded = source.evidenceDegraded === true || failedKeys.has(sourceKey);
          return {
            ...source,
            modelEvidence: evidenceByKey.get(sourceKey) || source.summary,
            evidenceFingerprint: source.evidenceFingerprint || pipelineSourceEvidenceFingerprint(source),
            ...(degraded ? {
              evidenceDegraded: true,
              retryAfter: evidenceRetryAfter(source.retryAfter),
            } : {
              evidenceDegraded: false,
            }),
          };
        }) })
        : candidate);
    };

    const persistEnrichedArticleEvidence = async (onlyCandidateIds?: ReadonlySet<string>): Promise<void> => {
      if (!transport || !nativePipelineActive) return;
      const updates = currentCandidates.filter((candidate) => !onlyCandidateIds || onlyCandidateIds.has(candidate.id))
        .flatMap((candidate) => candidate.sources.flatMap((source) => {
        const evidenceItem = candidate.entry.evidenceItems.find((item) => (
          canonicalItemUrl(item) === canonicalItemUrl({ url: source.url })
          && (text(item.source) || sourceEvidenceKey(item)) === source.name
        ));
        if (!evidenceItem) return [];
        const queuedArticle = pipelineArticleForEvidenceItem(evidenceItem);
        const mediaJson = {
          // Base64 previews remain in the current WebView only. Persisting a
          // 480 KiB JPEG as base64 can exceed the native 512 KiB JSON guard
          // and would reject the article body together with its media.
          imageUrls: (source.imageUrls ?? []).map(openableHttpsUrl).filter(Boolean),
          videoUrls: (source.videoUrls ?? []).map(openableHttpsUrl).filter(Boolean),
          evidenceDegraded: source.evidenceDegraded === true,
          ...(source.evidenceDegraded === true ? { retryAfter: evidenceRetryAfter(source.retryAfter) } : {}),
        };
        return [{
          articleId: queuedArticle.articleId,
          // The evidence-only native UPDATE uses the original queue record
          // fingerprint in its WHERE clause. A body/media hash here updates
          // zero rows and makes every restart miss the durable revision cache.
          recordFingerprint: queuedArticle.fingerprint,
          evidenceFingerprint: source.evidenceFingerprint || pipelineSourceEvidenceFingerprint(source),
          ...(source.body ? { body: source.body } : {}),
          mediaJson,
        }];
      }));
      if (updates.length === 0) return;
      try {
        for (let start = 0; start < updates.length; start += 16) {
          const batch = updates.slice(start, start + 16);
          const response = record(await transport.invoke<unknown>("intelligence_store_update_article_evidence", {
            articles: batch,
          }));
          const updated = typeof response?.updated === "number" ? response.updated : batch.length;
          const missing = typeof response?.missing === "number" ? response.missing : 0;
          const mismatched = typeof response?.mismatched === "number" ? response.mismatched : 0;
          if (updated !== batch.length || missing > 0 || mismatched > 0) {
            throw new Error(`article-evidence-stale:${updated}/${batch.length};missing=${missing};mismatched=${mismatched}`);
          }
        }
      } catch (error: unknown) {
        if (String(error).includes("article-evidence-stale:")) throw error;
        // Compatibility binaries have no evidence-only command. Never call
        // article upsert here: that would invalidate a just-created event and
        // put the same article back into triage. Real persistence failures
        // remain visible and stop publication instead of silently producing
        // an RSS-only revision.
        if (/unknown command|command .* not found|not registered|does not exist/iu.test(String(error))) return;
        throw error;
      }
    };

    const editorialSourcesForModel = (candidate: IntelligenceBriefCandidate): UnknownRecord[] => {
      // Every source remains represented.  Only its already map-reduced
      // evidence is proportionally bounded so a many-source event cannot
      // overflow the final editor context and silently drop later sources.
      const evidenceBudget = Math.max(80, Math.floor(7_000 / Math.max(1, candidate.sources.length)));
      return candidate.sources.map((source) => ({
        ...source,
        body: (source.modelEvidence || source.summary).slice(0, evidenceBudget),
      }));
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
        id: "article-triage", status: uncached.length > 0 ? "running" : "cached", unit: "articles",
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
            request: { articles, baseUrl: pipelineJudgeBaseUrl(), model: pipelineModelId() },
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
      setAuditStage({ id: "article-triage", status: triageUnavailable ? "warning" : "accepted", unit: "articles",
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
      });
      setAuditStage({
        id: "relation-recall", status: "accepted", unit: "pairs", inputCount: before.length, outputCount: eligible.length + rejected.length, pendingCount: eligible.length,
        summary: `规则与 RAG 仅召回 ${eligible.length} 对待核候选；${rejected.length} 对因明确冲突被拦截。`,
        items: [...eligible.map((pair) => ({
          title: `${byId.get(pair.leftId)!.title} ↔ ${byId.get(pair.rightId)!.title}`,
          meta: pair.reason, status: "pending" as const, badge: "待模型核验",
        })), ...rejected.map((item) => ({ ...item, status: "rejected" as const, badge: "硬冲突" }))],
      });
      if (eligible.length === 0) {
        setAuditStage({ id: "relation-judge", status: "cached", unit: "pairs", inputCount: 0, outputCount: 0, summary: "没有可安全送审的相似候选；保留已通过逐篇初筛的独立事件。" });
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
        id: "relation-judge", status: pendingEligible.length > 0 ? "running" : "cached", unit: "pairs", inputCount: eligible.length, outputCount: 0, pendingCount: pendingEligible.length, reusedCount: eligible.length - pendingEligible.length,
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
              baseUrl: pipelineJudgeBaseUrl(),
              model: pipelineModelId(),
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
        id: "relation-judge", status: accepted.length > 0 ? "accepted" : "warning", unit: "pairs", inputCount: eligible.length, outputCount: accepted.length, reusedCount: eligible.length - pendingEligible.length,
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
        ));
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

    const nativeEditorialInputFingerprint = (candidate: IntelligenceBriefCandidate): string => (
      `v5:${stableTextFingerprint([
        INTELLIGENCE_EDITORIAL_PROMPT_VERSION,
        activeModelSha || activeModelName,
        ...candidate.entry.evidenceItems.map((item) => {
          const article = pipelineArticleForEvidenceItem(item);
          return `${article.articleId}:${article.fingerprint}`;
        }).sort(),
        ...candidate.sources.map((source) => (
          `${openableHttpsUrl(source.url)}:${source.evidenceFingerprint || pipelineSourceEvidenceFingerprint(source)}`
        )).sort(),
      ].join("\u001f"))}`
    );

    const nativeEditorialEvidenceFingerprint = (candidate: IntelligenceBriefCandidate): string => (
      `e1:${stableTextFingerprint(candidate.sources.map((source) => JSON.stringify({
        url: openableHttpsUrl(source.url), title: source.title,
        body: source.body || source.summary,
        imageUrls: source.imageUrls ?? [], videoUrls: source.videoUrls ?? [],
      })).sort().join("\u001f"))}`
    );

    const parseStoredRevisionJson = (value: unknown): UnknownRecord | null => {
      try {
        return record(typeof value === "string" ? JSON.parse(value) : value);
      } catch {
        return null;
      }
    };

    const hydrateNativeEventSources = async (onlyCandidateIds?: ReadonlySet<string>): Promise<void> => {
      if (!transport || !nativePipelineActive) return;
      const sourcesByEvent = new Map<string, UnknownRecord[]>();
      for (const candidate of currentCandidates) {
        if (!candidate.eventId || onlyCandidateIds && !onlyCandidateIds.has(candidate.id) || sourcesByEvent.has(candidate.eventId)) continue;
        const sources: UnknownRecord[] = [];
        let cursor: number | undefined;
        try {
          do {
            const response = record(await transport.invoke<unknown>("intelligence_store_event_sources", {
              eventId: candidate.eventId,
              ...(cursor === undefined ? {} : { cursor }),
              limit: 64,
            }));
            if (!response || !Array.isArray(response.sources)) break;
            response.sources.map(record).forEach((source) => { if (source) sources.push(source); });
            const rawNextCursor = response.nextCursor ?? response.next_cursor;
            const nextCursor = Number(rawNextCursor);
            if (rawNextCursor === null || rawNextCursor === undefined || !Number.isFinite(nextCursor) || nextCursor === cursor) break;
            cursor = nextCursor;
          } while (sources.length < 20_000);
        } catch {
          // Compatibility builds do not expose event-source paging. Keep the
          // already materialized candidate instead of abandoning the edit.
          continue;
        }
        if (sources.length > 0) sourcesByEvent.set(candidate.eventId, sources);
      }
      if (sourcesByEvent.size === 0) return;
      currentCandidates = currentCandidates.map((candidate) => {
        const storedSources = candidate.eventId ? sourcesByEvent.get(candidate.eventId) : undefined;
        if (!storedSources) return candidate;
        const hydratedItems = storedSources.flatMap((stored) => {
          const title = text(stored.title);
          const articleId = text(stored.articleId ?? stored.article_id);
          const recordFingerprint = text(stored.recordFingerprint ?? stored.record_fingerprint);
          if (!title || !articleId || !recordFingerprint) return [];
          return [{
            articleId,
            recordFingerprint,
            ...(text(stored.evidenceFingerprint ?? stored.evidence_fingerprint)
              ? { evidenceFingerprint: text(stored.evidenceFingerprint ?? stored.evidence_fingerprint) }
              : {}),
            title,
            source: text(stored.sourceName ?? stored.source_name) || "历史来源",
            url: openableHttpsUrl(stored.url),
            summary: readableSummary(stored.summary),
            ...(text(stored.body) ? { body: text(stored.body) } : {}),
            publishedAt: text(stored.publishedAt ?? stored.published_at),
            language: text(stored.language),
          } satisfies IntelligenceNewsItem];
        });
        const storedItemsByKey = new Map(hydratedItems.map((item) => [evidenceKey(item), item]));
        const evidenceItems = mergeEvidenceItems(candidate.entry.evidenceItems, hydratedItems).map((item) => {
          const stored = storedItemsByKey.get(evidenceKey(item));
          return stored ? { ...item, ...stored, summary: text(item.summary).length > text(stored.summary).length ? item.summary : stored.summary } : item;
        });
        const labels = sourceEvidenceLabels(evidenceItems);
        const sourceMap = new Map(candidate.sources.map((source) => [`${source.name}\u001f${openableHttpsUrl(source.url)}`, source]));
        storedSources.forEach((stored) => {
          const name = text(stored.sourceName ?? stored.source_name) || "历史来源";
          const url = openableHttpsUrl(stored.url);
          const key = `${name}\u001f${url}`;
          const previous = sourceMap.get(key);
          const media = parseStoredRevisionJson(stored.mediaJson ?? stored.media_json);
          const body = text(stored.body) || previous?.body || "";
          const evidenceFingerprint = text(stored.evidenceFingerprint ?? stored.evidence_fingerprint)
            || previous?.evidenceFingerprint || "";
          const evidenceDegraded = media?.evidenceDegraded === true || media?.evidence_degraded === true;
          const rawRetryAfter = media?.retryAfter ?? media?.retry_after;
          const leadImageDataUrl = safePreparedImageDataUrl(media?.leadImageDataUrl ?? media?.lead_image_data_url)
            || previous?.leadImageDataUrl || "";
          sourceMap.set(key, {
            name,
            title: text(stored.title) || previous?.title || candidate.title,
            url,
            summary: readableSummary(stored.summary) || previous?.summary || candidate.summary,
            ...(body ? { body } : {}),
            ...(previous?.modelEvidence ? { modelEvidence: previous.modelEvidence } : {}),
            ...(leadImageDataUrl ? { leadImageDataUrl } : {}),
            imageUrls: Array.isArray(media?.imageUrls) ? media!.imageUrls.map(openableHttpsUrl).filter(Boolean) : previous?.imageUrls ?? [],
            videoUrls: Array.isArray(media?.videoUrls) ? media!.videoUrls.map(openableHttpsUrl).filter(Boolean) : previous?.videoUrls ?? [],
            ...(evidenceFingerprint ? { evidenceFingerprint } : {}),
            ...(evidenceDegraded ? {
              evidenceDegraded: true,
              retryAfter: evidenceRetryAfter(rawRetryAfter ?? previous?.retryAfter),
            } : {
              evidenceDegraded: false,
            }),
          });
        });
        return {
          ...candidate,
          entry: {
            ...candidate.entry,
            sourceKeys: labels.sourceKeys,
            sourceNames: labels.sourceNames,
            evidenceItems,
            mergedCount: evidenceItems.length,
          },
          sources: [...sourceMap.values()],
        };
      });
    };

    const restoreNativeEditorialCache = async (): Promise<void> => {
      if (!transport || !nativePipelineActive) return;
      const restored: IntelligenceModelBrief[] = [];
      const revisionsByEvent = new Map<string, number>();
      const mediaByEvent = new Map<string, UnknownRecord[]>();
      for (const candidate of currentCandidates) {
        if (!candidate.eventId) continue;
        try {
          const response = record(await transport.invoke<unknown>("intelligence_store_event_get", { eventId: candidate.eventId }));
          const latest = record(response?.latestRevision ?? response?.latest_revision) ?? response;
          const meta = parseStoredRevisionJson(latest?.revisionJson ?? latest?.revision_json ?? response?.revisionJson);
          const body = text(latest?.revisionBody ?? latest?.revision_body ?? response?.revisionBody);
          const evidenceState = record(meta?.evidenceState);
          const degradedSourceCount = count(evidenceState?.degradedSourceCount);
          const retryAfter = Number(evidenceState?.retryAfter);
          if (!meta || !body
            || text(meta.inputFingerprint) !== nativeEditorialInputFingerprint(candidate)
            || text(meta.promptVersion) !== INTELLIGENCE_EDITORIAL_PROMPT_VERSION
            // A degraded revision is a temporary displayable fallback, never
            // a permanent cache hit. Once its retry window opens the source is
            // fetched/map-reduced again before another revision is published.
            || degradedSourceCount > 0 && (!Number.isFinite(retryAfter) || retryAfter <= Date.now())) continue;
          const storedBrief = record(meta.brief);
          if (!storedBrief) continue;
          const parsed = parseIntelligenceModelBriefs(JSON.stringify({
            briefs: [{ ...storedBrief, id: candidate.id, article: body }],
          }), [candidate]);
          if (parsed[0]) restored.push(parsed[0]);
          if (Array.isArray(meta.media)) mediaByEvent.set(candidate.eventId, meta.media.map(record).filter((item): item is UnknownRecord => Boolean(item)));
          const revision = Number(latest?.revision ?? latest?.revisionId ?? response?.revision ?? response?.currentRevision);
          if (Number.isFinite(revision)) revisionsByEvent.set(candidate.eventId, revision);
        } catch {
          // A missing/corrupt event revision is a cache miss. The editor will
          // create a new persistent revision from the current full evidence.
        }
      }
      if (revisionsByEvent.size > 0) currentCandidates = currentCandidates.map((candidate) => {
        const revision = candidate.eventId ? revisionsByEvent.get(candidate.eventId) : undefined;
        if (revision === undefined) return candidate;
        const media = candidate.eventId ? mediaByEvent.get(candidate.eventId) ?? [] : [];
        const sources = candidate.sources.map((source) => {
          const stored = media.find((item) => text(item.source) === source.name);
          return !stored ? source : {
            ...source,
            ...(safePreparedImageDataUrl(stored.leadImageDataUrl) ? { leadImageDataUrl: safePreparedImageDataUrl(stored.leadImageDataUrl) } : {}),
            ...(Array.isArray(stored.imageUrls) ? { imageUrls: stored.imageUrls.map(openableHttpsUrl).filter(Boolean) } : {}),
            ...(Array.isArray(stored.videoUrls) ? { videoUrls: stored.videoUrls.map(openableHttpsUrl).filter(Boolean) } : {}),
          };
        });
        const images = sources.flatMap((source) => [
          safePreparedImageDataUrl(source.leadImageDataUrl),
          ...(source.imageUrls ?? []).map(safePreparedImageSource),
        ]).filter((image, index, values) => image && values.indexOf(image) === index).slice(0, INTELLIGENCE_PREPARED_IMAGE_LIMIT);
        if (images.length > 0) preparedBriefImages.set(candidate.id, images);
        return { ...candidate, revision, sources };
      });
      currentModelBriefs = restored;
    };

    const persistNativeEditorialRevision = async (
      candidate: IntelligenceBriefCandidate,
      brief: IntelligenceModelBrief,
    ): Promise<void> => {
      if (!transport || !nativePipelineActive || !candidate.eventId) return;
      const articleIds = [...new Set(candidate.entry.evidenceItems.map((item) => (
        pipelineArticleForEvidenceItem(item).articleId
      )))];
      const media = candidate.sources.map((source) => ({
        source: source.name,
        // Never embed base64 image payloads in revision JSON: a single source
        // preview can approach the native 512 KiB JSON ceiling and prevent the
        // durable editorial revision from being written. The current session
        // retains its local data URL; restarts reuse safe media references.
        imageUrls: (source.imageUrls ?? []).map(openableHttpsUrl).filter(Boolean),
        videoUrls: (source.videoUrls ?? []).map(openableHttpsUrl).filter(Boolean),
      }));
      const degradedSources = candidate.sources.filter((source) => source.evidenceDegraded === true);
      const retryAfterValues = degradedSources.map((source) => evidenceRetryAfter(source.retryAfter))
        .filter((value) => Number.isFinite(value));
      const stored = record(await transport.invoke<unknown>("intelligence_store_upsert_event", {
        eventId: candidate.eventId,
        ...(candidate.seriesId ? { seriesId: candidate.seriesId } : {}),
        title: brief.headline,
        summary: brief.summary,
        importance: brief.importance,
        occurredAt: candidate.publishedAt,
        articleIds,
        revisionBody: brief.article,
        revisionJson: JSON.stringify({
          inputFingerprint: nativeEditorialInputFingerprint(candidate),
          evidenceFingerprint: nativeEditorialEvidenceFingerprint(candidate),
          promptVersion: INTELLIGENCE_EDITORIAL_PROMPT_VERSION,
          modelId: activeModelName,
          modelSha: activeModelSha,
          media,
          evidenceState: {
            degradedSourceCount: degradedSources.length,
            ...(retryAfterValues.length > 0 ? { retryAfter: Math.min(...retryAfterValues) } : {}),
          },
          // revisionBody is authoritative; duplicating a long article here
          // wastes the native JSON budget and can prevent durable caching.
          brief: { ...brief, article: "" },
        }),
      }));
      const revision = Number(stored?.revision ?? stored?.currentRevision);
      if (Number.isFinite(revision)) currentCandidates = currentCandidates.map((current) => (
        current.eventId === candidate.eventId ? { ...current, revision } : current
      ));
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
        if (!page.hidden && selectedDigestDay === "current") renderBriefCards();
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
      // Do not prefetch remote cover assets when the workspace opens.  This
      // surface is intentionally a durable-state viewer; the background
      // worker owns collection and enrichment.
      visible.forEach((candidate) => {
        const key = candidate.eventId || candidate.id;
        if (preparedTimelineCache.has(key) || preparedTimelineInFlight.has(key)) return;
        preparedTimelineInFlight.add(key);
        void preparedTimelineHtml(candidate).then((html) => {
          if (html) preparedTimelineCache.set(key, html);
        }).finally(() => preparedTimelineInFlight.delete(key));
      });
    };

    const refreshLocalModelStatus = async (): Promise<void> => {
      if (!transport) return;
      qwen27bSelectable = false;
      modelName.disabled = true;
      modelQwen27b.disabled = true;
      modelSave.disabled = true;
      modelRequirement.textContent = "正在检测 NVIDIA 显卡与物理总显存…";
      try {
        const capabilities = record(await transport.invoke<unknown>("intelligence_local_model_capabilities"));
        const models = Array.isArray(capabilities?.models) ? capabilities.models : [];
        const option = models.map(record).find((candidate) => (
          text(candidate?.id) === INTELLIGENCE_QWEN_27B_16GB_MODEL_ID
        ));
        qwen27bSelectable = option?.selectable === true;
        modelQwen27b.disabled = !qwen27bSelectable;
        modelName.disabled = !qwen27bSelectable;
        modelSave.disabled = !qwen27bSelectable;
        modelQwen27b.textContent = qwen27bSelectable
          ? "千问 27B（16GB 显存版）"
          : "千问 27B（16GB 显存版）· 显存不足或未检测到显卡";
        const gpu = record(capabilities?.gpu);
        const total = typeof gpu?.totalVramMib === "number" ? `${gpu.totalVramMib} MiB` : "未知";
        const free = typeof gpu?.freeVramMib === "number" ? `${gpu.freeVramMib} MiB` : "未知";
        const reason = text(option?.reason) || text(gpu?.message) || "无法确认显卡容量";
        modelRequirement.textContent = `显卡：${text(gpu?.name) || "未检测到 NVIDIA GPU"}；总显存 ${total}，当前空闲 ${free}。${reason}。`;
      } catch (error: unknown) {
        modelQwen27b.textContent = "千问 27B（16GB 显存版）· 显卡检测失败";
        modelRequirement.textContent = `显卡检测失败，已禁止选择大参数模型：${String(error)}`;
      }
      try {
        const value = record(await transport.invoke<unknown>("intelligence_local_model_status"));
        modelConfigured = value?.configured === true;
        activeModelName = text(value?.model);
        activeModelSha = text(value?.modelSha ?? value?.model_sha ?? value?.sha256);
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
      if (!nativePipelineActive) {
        await triageCurrentCandidates();
        if (loadToken !== loadGeneration || currentCandidates.length === 0) return;
        await refineCandidatesWithEventJudge();
      }
      currentModelBriefs = [];
      // Hydrate every historical + newly appended event member from SQLite
      // before computing the lightweight cache key. This is local I/O only;
      // a cache hit still performs no web extraction or model call.
      if (nativePipelineActive) await hydrateNativeEventSources();
      // SQLite revisions are keyed by stable article ids + original record
      // fingerprints + prompt/model revision, so this cache check is possible
      // before any network fetch or source-evidence model call.
      if (nativePipelineActive) await restoreNativeEditorialCache();
      else restoreEditorialCache();
      let pendingCandidates = currentCandidates.filter((candidate) => !currentModelBriefs.some((brief) => brief.id === candidate.id && Boolean(brief.article)));
      if (pendingCandidates.length === 0) {
        modelStatus.textContent = `已复用本机编辑缓存 · ${activeModelName || "本机 Qwen 27B Q3"}`;
        setAuditStage({ id: "qwen-review", status: "cached", unit: "events", inputCount: currentCandidates.length, outputCount: currentModelBriefs.length, reusedCount: currentModelBriefs.length, summary: "已复用未变化来源的本地 Qwen 综合报道缓存。" });
        setAuditStage({ id: "final-events", status: "accepted", unit: "events", inputCount: currentCandidates.length, outputCount: currentCandidates.length, reusedCount: currentCandidates.length, summary: "已复用已验证的简报事件；新资讯到来前不会再次编辑。" });
        publishAudit("简报已从本地缓存复用；只有新增或正文变化的来源才会重新交给 Qwen。" );
        if (!page.hidden && selectedDigestDay === "current") renderBriefCards();
        return;
      }
      await ensureNativeRuntimePhase("editorial", "正在启动 27B 全文证据与综合报道阶段");
      const pendingIds = new Set(pendingCandidates.map((candidate) => candidate.id));
      await enrichCurrentCandidates(pendingIds);
      await extractEvidenceForCurrentCandidates(pendingIds);
      // Persist only after map-reduce, so a fetch/extraction fallback carries
      // its retry window and cannot be mistaken for final source evidence.
      await persistEnrichedArticleEvidence(pendingIds);
      pendingCandidates = currentCandidates.filter((candidate) => pendingIds.has(candidate.id));
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
          const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_generate_brief", {
            request: {
              candidates: batch.map((candidate) => ({
              id: candidate.id,
              title: candidate.title,
              summary: candidate.summary,
              publishedAt: candidate.publishedAt,
              sources: editorialSourcesForModel(candidate),
              })),
            },
          }, "editorial", "27B 综合报道服务断开，正在恢复编辑阶段"));
          if (generation !== briefingGeneration || loadToken !== loadGeneration) return;
          const merged = new Map(currentModelBriefs.map((brief) => [brief.id, brief]));
          for (const brief of parseIntelligenceModelBriefs(text(response?.content), batch)) {
            merged.set(brief.id, brief);
            const candidate = batch.find((item) => item.id === brief.id);
            if (candidate) {
              if (nativePipelineActive) await persistNativeEditorialRevision(candidate, brief);
              saveEditorialCache(candidate, brief);
            }
          }
          currentModelBriefs = [...merged.values()];
          modelStatus.textContent = `正在编辑 ${Math.min(start + batch.length, pendingCandidates.length)} / ${pendingCandidates.length} 条新增/更新资讯…`;
          if (!page.hidden && selectedDigestDay === "current") renderBriefCards();
        } catch {
          failedBatches += 1;
        }
      }
      if (generation !== briefingGeneration || loadToken !== loadGeneration) return;
      const completedCount = currentCandidates.filter((candidate) => (
        currentModelBriefs.some((brief) => brief.id === candidate.id && Boolean(brief.article))
      )).length;
      const completed = completedCount === currentCandidates.length;
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
      if (!page.hidden && selectedDigestDay === "current") renderBriefCards();
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
      selectedStandardFavorite = newsFavoriteForItem(item);
      contextTitle.textContent = itemTitle(item);
      contextBody.textContent = itemContext(item);
      contextMeta.textContent = `${text(item.source) || "未知来源"} · ${text(item.category) || "综合"}`;
      contextReasons.replaceChildren();
      refreshFavoriteAction(favoriteAction, selectedStandardFavorite);
      contextMeta.append(favoriteAction);
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
      selectedStandardFavorite = newsFavoriteForCandidate(candidate, modelBrief);
      contextTitle.textContent = modelBrief?.headline || candidate.title;
      contextBody.textContent = modelBrief
        ? `${modelBrief.summary}\n${modelBrief.whyItMatters}`
        : candidate.summary || itemContext(candidate.entry.item);
      contextMeta.textContent = modelBrief
        ? `${modelBrief.priority} · 重要性 ${modelBrief.importance} · 可信度 ${Math.round(modelBrief.confidence * 100)}% · ${candidate.entry.sourceKeys.length} 个独立来源`
        : `规则候选 · ${candidate.entry.sourceKeys.length} 个独立来源 · ${candidate.entry.mergedCount} 条原始证据`;
      refreshFavoriteAction(favoriteAction, selectedStandardFavorite);
      contextMeta.append(favoriteAction);
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
          if (nativePipelineActive) {
            await hydrateNativeEventSources(new Set([candidate.id]));
            await restoreNativeEditorialCache();
            const restored = currentModelBriefs.find((brief) => brief.id === candidate.id && Boolean(brief.article));
            if (restored) return restored;
          }
          await ensureNativeRuntimePhase("editorial", "正在启动 27B 优先编辑阶段");
          const onlyCandidate = new Set([candidate.id]);
          await enrichCurrentCandidates(onlyCandidate);
          await extractEvidenceForCurrentCandidates(onlyCandidate);
          await persistEnrichedArticleEvidence(onlyCandidate);
          const preparedCandidate = currentCandidates.find((item) => item.id === candidate.id) ?? candidate;
          const response = record(await invokeWithRuntimeRecovery<unknown>("intelligence_generate_brief", {
            request: {
              candidates: [{
                id: preparedCandidate.id,
                title: preparedCandidate.title,
                summary: preparedCandidate.summary,
                publishedAt: preparedCandidate.publishedAt,
                sources: editorialSourcesForModel(preparedCandidate),
              }],
            },
          }, "editorial", "27B 优先编辑服务断开，正在恢复编辑阶段"));
          const brief = parseIntelligenceModelBriefs(text(response?.content), [preparedCandidate])
            .find((result) => result.id === candidate.id) ?? null;
          if (!brief?.article) {
            setStandardStatus("本机模型没有返回可用的中文综合报道；请稍后再试。未展示原始 RSS 片段。");
            return null;
          }
          const merged = new Map(currentModelBriefs.map((result) => [result.id, result]));
          merged.set(brief.id, brief);
          currentModelBriefs = [...merged.values()];
          if (nativePipelineActive) await persistNativeEditorialRevision(preparedCandidate, brief);
          saveEditorialCache(preparedCandidate, brief);
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

    const storedEventLink = (event: UnknownRecord): string => {
      const eventId = text(event.eventId ?? event.id);
      const rawRevision = event.revision ?? event.revisionId ?? event.revision_id;
      const revision = typeof rawRevision === "number" && Number.isFinite(rawRevision)
        ? String(rawRevision)
        : text(rawRevision);
      const title = text(event.title) || "历史综合报道";
      if (!eventId) return escapeBriefHtml(title);
      return `<a href="#" data-intelligence-event-id="${escapeBriefHtml(eventId)}"${revision ? ` data-intelligence-event-revision="${escapeBriefHtml(revision)}"` : ""}>${escapeBriefHtml(title)}</a>`;
    };

    const preparedTimelineHtml = async (candidate: IntelligenceBriefCandidate): Promise<string> => {
      if (!transport) return "";
      const eventId = candidate.eventId || candidate.id;
      try {
        const response = record(await transport.invoke<unknown>("intelligence_store_series_timeline", { eventId }));
        const events = Array.isArray(response?.events) ? response.events.map(record).filter((event): event is UnknownRecord => Boolean(event)) : [];
        if (events.length === 0) return "";
        const currentEventId = text(response?.currentEventId) || eventId;
        const background = (Array.isArray(response?.background) ? response.background.map(record) : events
          .filter((event) => text(event?.eventId ?? event?.id) !== currentEventId))
          .filter((event): event is UnknownRecord => Boolean(event))
          .slice(-5);
        const backgroundHtml = background.length > 0
          ? `<section><h2>前情提要</h2><ul>${background.map((event) => {
            const summary = text(event.summary ?? event.revisionSummary ?? event.revision_summary).slice(0, 500);
            return `<li>${storedEventLink(event)}${summary ? `<p>${escapeBriefHtml(summary)}</p>` : ""}</li>`;
          }).join("")}</ul></section>`
          : "";
        const timelineHtml = `<section><h2>事件时间线</h2><ol>${events.map((event) => {
          const candidateEventId = text(event.eventId ?? event.id);
          const occurredAt = text(event.occurredAt ?? event.occurred_at ?? event.publishedAt);
          const relation = text(event.relationLabel ?? event.relation_label ?? event.relation);
          const current = candidateEventId === currentEventId;
          return `<li${current ? ` data-intelligence-current-event="true"` : ""}><time>${escapeBriefHtml(occurredAt || "时间待核")}</time> · ${storedEventLink(event)}${relation ? ` <span>${escapeBriefHtml(relation)}</span>` : ""}${current ? " <strong>当前事件</strong>" : ""}</li>`;
        }).join("")}</ol></section>`;
        return `${backgroundHtml}${timelineHtml}`;
      } catch {
        return "";
      }
    };

    const openStoredEvent = async (eventId: string, revision?: string): Promise<boolean> => {
      const stableEventId = text(eventId);
      if (!transport || !stableEventId) return false;
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!news?.openPreparedArticle) return false;
      try {
        const requestedRevisionNumber = Number(revision);
        const response = record(await transport.invoke<unknown>("intelligence_store_event_get", {
          eventId: stableEventId,
          ...(Number.isFinite(requestedRevisionNumber) ? { revision: requestedRevisionNumber } : {}),
        }));
        if (!response) return false;
        const revisions = Array.isArray(response.revisions) ? response.revisions.map(record).filter((item): item is UnknownRecord => Boolean(item)) : [];
        const latestRevision = record(response.latestRevision ?? response.latest_revision);
        const selected = Number.isFinite(requestedRevisionNumber)
          ? revisions.find((item) => Number(item.revision ?? item.revisionId ?? item.id) === requestedRevisionNumber) ?? latestRevision ?? response
          : latestRevision ?? revisions.at(-1) ?? response;
        const body = text(selected.revisionBody ?? selected.revision_body ?? selected.body ?? response.revisionBody ?? response.summary);
        const title = text(selected.title ?? response.title) || "历史综合报道";
        if (!body) return false;
        const meta = parseStoredRevisionJson(selected.revisionJson ?? selected.revision_json ?? response.revisionJson);
        const media = Array.isArray(meta?.media) ? meta!.media.map(record).filter((item): item is UnknownRecord => Boolean(item)) : [];
        const images = media.flatMap((item) => [
          safePreparedImageDataUrl(item.leadImageDataUrl),
          ...(Array.isArray(item.imageUrls) ? item.imageUrls.map(safePreparedImageSource) : []),
        ]).filter((image, index, values) => image && values.indexOf(image) === index).slice(0, INTELLIGENCE_PREPARED_IMAGE_LIMIT);
        const imageHtml = images.map((image, index) => `<figure><img src="${escapeBriefHtml(image)}" alt="${escapeBriefHtml(title)} · 图片 ${index + 1}"></figure>`).join("");
        const videos = media.flatMap((item) => (Array.isArray(item.videoUrls) ? item.videoUrls : []).map(openableHttpsUrl)
          .filter(Boolean).map((url) => ({ source: text(item.source) || "视频来源", url })))
          .filter((item, index, values) => values.findIndex((candidate) => candidate.url === item.url) === index);
        const videoHtml = videos.length > 0 ? `<section><h2>视频来源</h2><ul>${videos.map((video) => `<li><strong>${escapeBriefHtml(video.source)}</strong> · <a href="${escapeBriefHtml(video.url)}" data-newsnow-prepared-source-url="${escapeBriefHtml(video.url)}">在阅读器中打开视频</a></li>`).join("")}</ul></section>` : "";
        const selectedRevision = Number(Number.isFinite(requestedRevisionNumber)
          ? requestedRevisionNumber
          : selected.revision ?? selected.revisionId ?? response.revision ?? response.currentRevision);
        const paragraphs = body.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean)
          .map((paragraph) => `<p>${escapeBriefHtml(paragraph)}</p>`).join("");
        const timeline = await preparedTimelineHtml({
          id: stableEventId,
          eventId: stableEventId,
          ...(text(response.seriesId ?? response.series_id) ? { seriesId: text(response.seriesId ?? response.series_id) } : {}),
          title,
          summary: text(response.summary),
          publishedAt: text(response.occurredAt ?? response.occurred_at),
          entry: {
            item: { title, summary: text(response.summary) },
            sourceNames: [], sourceKeys: [], evidenceItems: [], mergedCount: 0, importance: 0,
          },
          sources: [],
        });
        close({ focus: false });
        news.openPreparedArticle({
          title,
          source: "本机历史综合报道",
          publishedAt: text(response.occurredAt ?? response.occurred_at),
          contentHtml: `${imageHtml}<section><h2>综合报道</h2>${paragraphs}</section>${videoHtml}${timeline}`,
          eventId: stableEventId,
          ...(Number.isFinite(selectedRevision)
            ? { revision: selectedRevision }
            : {}),
        }, { returnToIntelligence: true });
        return true;
      } catch {
        return false;
      }
    };

    const openFavorite = async (favorite: NewsFavoriteRecord): Promise<boolean> => {
      if (favorite.eventId) {
        const opened = await openStoredEvent(
          favorite.eventId,
          favorite.revision === undefined ? undefined : String(favorite.revision),
        );
        if (opened) return true;
      }
      const item = openableNewsItem({
        title: favorite.title,
        summary: favorite.summary,
        source: favorite.source,
        publishedAt: favorite.publishedAt,
        category: favorite.category,
        url: favorite.url,
      });
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!item || !news?.openItem) return false;
      try {
        close({ focus: false });
        await Promise.resolve(news.openItem(item, { returnToIntelligence: true }));
        return true;
      } catch {
        return false;
      }
    };

    async function openPreparedBrief(candidate: IntelligenceBriefCandidate, modelBrief: IntelligenceModelBrief | null): Promise<void> {
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
      const images = [
        ...(preparedBriefImages.get(candidate.id) ?? []),
        ...candidate.sources.map((source) => safePreparedImageDataUrl(source.leadImageDataUrl)).filter(Boolean),
        ...candidate.sources.flatMap((source) => (source.imageUrls ?? []).map(safePreparedImageSource)).filter(Boolean),
      ].filter((image, index, values) => values.indexOf(image) === index).slice(0, INTELLIGENCE_PREPARED_IMAGE_LIMIT);
      const imageHtml = images.map((image, index) => (
        `<figure><img src="${escapeBriefHtml(image)}" alt="${escapeBriefHtml(editorialBrief.headline || candidate.title)} · 图片 ${index + 1}"></figure>`
      )).join("");
      const videoSources = candidate.sources.flatMap((source) => (
        (source.videoUrls ?? []).map((url) => ({ source: source.name, url }))
      )).concat(candidate.entry.evidenceItems.flatMap((item) => (
        isVideoNewsUrl(item.url) ? [{ source: text(item.source) || "视频来源", url: openableHttpsUrl(item.url) }] : []
      ))).filter((item, index, values) => item.url && values.findIndex((candidateItem) => candidateItem.url === item.url) === index);
      const videoHtml = videoSources.length > 0
        ? `<h2>视频来源</h2><ul>${videoSources.map((video) => `<li><strong>${escapeBriefHtml(video.source)}</strong> · <a href="${escapeBriefHtml(video.url)}" data-newsnow-prepared-source-url="${escapeBriefHtml(video.url)}">在阅读器中打开视频</a></li>`).join("")}</ul>`
        : "";
      const paragraphs = article.split(/\n{2,}/u).map((paragraph) => paragraph.trim()).filter(Boolean)
        .map((paragraph) => `<p>${escapeBriefHtml(paragraph)}</p>`).join("");
      // The optional local timeline is prefetched when the card paints, so a
      // click never waits on SQLite before the prepared article opens.
      const timeline = preparedTimelineCache.get(candidate.eventId || candidate.id) ?? "";
      close({ focus: false });
      news.openPreparedArticle({
        title: editorialBrief.headline || candidate.title,
        source: `本机综合 · ${candidate.entry.sourceKeys.length} 个独立来源`,
        publishedAt: candidate.publishedAt,
        contentHtml: `${imageHtml}<section><h2>综合报道</h2>${paragraphs}${sourceDifferences ? `<h2>各来源的独有信息与差异</h2><ul>${sourceDifferences}</ul>` : ""}${videoHtml}<h2>引用来源</h2><ul>${evidence}</ul></section>${timeline}`,
        ...(candidate.eventId ? { eventId: candidate.eventId } : {}),
        ...(candidate.revision === undefined ? {} : { revision: candidate.revision }),
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

    const selectFormalPublicationEvent = (
      publication: IntelligenceClientCachedPublication,
      event: IntelligenceClientCachedEvent,
      button?: HTMLButtonElement,
    ): void => {
      selectedItem = null;
      selectedFormalPublication = { publication, event };
      selectedStandardFavorite = null;
      contextTitle.textContent = event.title;
      contextBody.textContent = event.body;
      contextMeta.textContent = `正式${publication.kind === "daily" ? "日报" : "事件快报"} · 修订 ${event.revisionNo} · ${event.sources.length} 个公开来源`;
      contextReasons.replaceChildren(...[
        `发布时间：${publication.publishedAt}`,
        `本地缓存有效至：${publication.expiresAt}`,
      ].map((value) => {
        const reason = root.createElement("li");
        reason.textContent = value;
        return reason;
      }));
      const sources = event.sources.map((source) => {
        const sourceButton = root.createElement("button");
        sourceButton.type = "button";
        sourceButton.className = "intelligence-evidence-item intelligence-evidence-link";
        sourceButton.textContent = `${source.publisher} · ${source.title}`;
        sourceButton.title = "在阅读器中打开此公开来源";
        sourceButton.addEventListener("click", () => {
          openNewsItem({
            source: source.publisher,
            title: source.title,
            url: source.originalUrl,
            summary: source.fallbackExcerpt,
          }, "打开来源资讯失败，请稍后重试。");
        });
        return sourceButton;
      });
      contextEvidence.replaceChildren(...sources);
      openNews.hidden = false;
      openNews.disabled = false;
      openNews.textContent = "打开正式报道";
      digestList.querySelectorAll(".intelligence-digest-item[aria-current='true']")
        .forEach((current) => current.removeAttribute("aria-current"));
      button?.setAttribute("aria-current", "true");
    };

    const openFormalPublicationEvent = async (): Promise<void> => {
      const selected = selectedFormalPublication;
      if (!selected) return;
      const news = activeRuntime.ReaderNewsUI?.instance;
      if (!news?.openPreparedArticle) {
        setStatus("正式报道阅读器暂不可用，请稍后重试。");
        return;
      }
      const notes = new Map(selected.event.sources.map((source, index) => [source.noteId, {
        source,
        ordinal: index + 1,
      }]));
      const paragraphs = selected.event.segments.map((segment) => {
        const inlineNotes = segment.noteIds.map((noteId) => {
          const note = notes.get(noteId);
          if (!note) return "";
          // The URL and fallback excerpt originate in the Rust projection of
          // a validated formal bundle.  The existing reader intercepts this
          // marker and keeps source navigation inside its own article shell.
          return ` <a href="${escapeBriefHtml(note.source.originalUrl)}" data-newsnow-prepared-source-url="${escapeBriefHtml(note.source.originalUrl)}" data-intelligence-note-id="${escapeBriefHtml(noteId)}" title="${escapeBriefHtml(`${note.source.publisher} · ${note.source.fallbackExcerpt}`)}">注${note.ordinal}</a>`;
        }).join("");
        return `<p>${escapeBriefHtml(segment.text)}${inlineNotes}</p>`;
      }).join("");
      const citations = selected.event.sources.map((source) => (
        `<li><strong>注${notes.get(source.noteId)?.ordinal ?? ""} · ${escapeBriefHtml(source.publisher)}</strong> · <a href="${escapeBriefHtml(source.originalUrl)}" data-newsnow-prepared-source-url="${escapeBriefHtml(source.originalUrl)}" data-intelligence-note-id="${escapeBriefHtml(source.noteId)}">${escapeBriefHtml(source.title)}</a><p>${escapeBriefHtml(source.fallbackExcerpt)}</p></li>`
      )).join("");
      // Assets are fetched only from the account-isolated, already SHA-256
      // verified native cache.  No service URL or cache path crosses the
      // WebView boundary, and a corrupt/missing optional image cannot block
      // reading the fully persisted editorial text.
      const uniqueImages = new Map(selected.event.media
        .filter((media) => media.cached)
        .map((media) => [media.sha256, media]));
      const imageUrls = transport ? await Promise.all([...uniqueImages.values()].map(async (media) => {
        try {
          const value = await transport!.invoke<unknown>("intelligence_client_asset_data_url", { sha256: media.sha256 });
          const image = text(value);
          return /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/iu.test(image)
            ? `<img src="${escapeBriefHtml(image)}" alt="正式资讯配图" loading="lazy">`
            : "";
        } catch {
          return "";
        }
      })) : [];
      const images = imageUrls.filter(Boolean).join("");
      const videos = [...new Set(selected.event.media.map((media) => openableHttpsUrl(media.videoUrl)).filter(Boolean))]
        .map((url) => `<p><a href="${escapeBriefHtml(url)}" data-newsnow-prepared-source-url="${escapeBriefHtml(url)}">打开关联视频</a></p>`)
        .join("");
      close({ focus: false });
      news.openPreparedArticle({
        title: selected.event.title,
        source: `正式${selected.publication.kind === "daily" ? "日报" : "事件快报"} · ${selected.event.sources.length} 个公开来源`,
        publishedAt: selected.event.occurredAt || selected.publication.publishedAt,
        contentHtml: `<section><h2>正式报道</h2>${paragraphs}${images ? `<section class="newsnow-prepared-media">${images}</section>` : ""}${videos}<h2>引用来源</h2><ul>${citations}</ul></section>`,
        eventId: selected.event.eventId,
        revision: selected.event.revisionNo,
      }, { returnToIntelligence: true });
    };

    const orderFormalPublicationCacheByPreference = async (
      cache: IntelligenceClientCacheStatus,
      publications: readonly IntelligenceClientCachedPublication[],
    ): Promise<{ readonly events: readonly FormalPublicationEvent[]; readonly personalized: boolean }> => {
      const original = publications.flatMap((publication) => publication.events.map((event) => ({ publication, event })));
      // `clientCachedPublications` is the account-authenticated, native
      // validated formal projection. Never score raw RSS/snapshot items here.
      if (!cache.cachePresent || !transport || original.length === 0) return { events: original, personalized: false };
      const favorites = preferenceFavorites(runtime.localStorage);
      if (favorites.length === 0) return { events: original, personalized: false };
      try {
        const routes = await transport.invoke<unknown>("ai_capability_routes_status");
        // An explicit off, unknown route, cloud, or host route must not cause
        // an inference request from this client-side cache reader.
        if (!preferenceRouteAllowsLocalScoring(routes)) return { events: original, personalized: false };
        const scored = preferenceEventsForPublications(publications);
        if (scored.length === 0) return { events: original, personalized: false };
        const key = preferenceScoreCacheKey(favorites, scored.map((item) => item.preference));
        const cachedScores = readPreferenceScoreCache(runtime.localStorage, key);
        if (cachedScores) {
          return {
            events: orderFormalPublicationEvents(original, scored, cachedScores),
            personalized: true,
          };
        }
        const response = await transport.invoke<unknown>("score_news_preferences", {
          request: {
            favorites,
            events: scored.map((item) => item.preference),
          },
        });
        const scores = parsePreferenceScores(response, scored.map((item) => item.preference));
        // Invalid JSON/model output never changes the account's formal feed.
        if (!scores) return { events: original, personalized: false };
        savePreferenceScoreCache(runtime.localStorage, key, scores);
        return {
          events: orderFormalPublicationEvents(original, scored, scores),
          personalized: true,
        };
      } catch {
        // Preference ranking is optional. Preserve the server's formal order
        // when the local route/model is unavailable or malformed.
        return { events: original, personalized: false };
      }
    };

    const visibleFormalPublicationEvents = (events: readonly FormalPublicationEvent[]): FormalPublicationEvent[] => {
      const kind = kindFilter?.value || "all";
      const minimumImportance = Number(importanceFilter?.value ?? 0);
      const scope = scopeFilter?.value || "all";
      return events.filter(({ publication }) => {
        if (kind !== "all" && publication.kind !== kind) return false;
        if (Number.isFinite(minimumImportance) && publication.importance < minimumImportance) return false;
        if (scope === "daily" && publication.kind !== "daily") return false;
        if (scope === "important" && publication.importance < Math.max(80, minimumImportance || 0)) return false;
        return true;
      });
    };

    const renderFormalPublicationCache = (
      cache: IntelligenceClientCacheStatus,
      publications: readonly IntelligenceClientCachedPublication[],
      orderedEvents?: readonly FormalPublicationEvent[],
      personalized = false,
    ): void => {
      const allEvents = orderedEvents ?? publications.flatMap((publication) => publication.events.map((event) => ({ publication, event })));
      const events = visibleFormalPublicationEvents(allEvents);
      formalPublicationCache = { cache, publications, events: allEvents, personalized };
      selectedFormalPublication = null;
      selectedItem = null;
      selectedStandardFavorite = null;
      currentCandidates = [];
      currentModelBriefs = [];
      processingSummary.textContent = cache.cachePresent
        ? `正式分发缓存 · ${publications.length} 个发布包 / 显示 ${events.length}/${allEvents.length} 个事件${personalized ? " · 已按本机收藏偏好排序" : ""}`
        : "尚无正式分发缓存";
      if (deliveryState) deliveryState.textContent = intelligenceDeliveryStateCopy(cache);
      modelStatus.textContent = "本机缓存阅读模式 · 不会自动调用模型";
      digestHistorySummary.textContent = "此处只显示服务端正式发布后、当前账户已校验的发布包；打开页面不联网，点击“刷新”才会同步。本机草稿和未配对内容不会进入账号资讯。";
      if (events.length === 0) {
        digestList.replaceChildren();
        signalList.replaceChildren();
        briefingCount.textContent = cache.deliveryState === "server_empty" ? "服务端暂无正式资讯" : "暂无正式资讯";
        contextTitle.textContent = cache.deliveryState === "permission_required" ? "账号尚无情报权限" : "暂无已同步正式情报";
        contextBody.textContent = "账号资讯只展示服务端正式发布、完成校验并保存到当前账号缓存的内容；本机草稿、未配对发布或处理中的资讯不会显示在这里。";
        contextMeta.textContent = "";
        contextReasons.replaceChildren();
        contextEvidence.replaceChildren();
        openNews.hidden = true;
        openNews.disabled = true;
        return;
      }
      briefingCount.textContent = `已缓存 ${publications.length} 个正式发布包，当前显示 ${events.length}/${allEvents.length} 个事件`;
      const buttons = events.map(({ publication, event }, index) => {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "intelligence-digest-item intelligence-digest-brief";
        const order = root.createElement("span");
        order.className = "intelligence-digest-index";
        order.textContent = String(index + 1).padStart(2, "0");
        const copy = root.createElement("span");
        copy.className = "intelligence-digest-copy";
        const title = root.createElement("strong");
        title.textContent = event.title;
        const meta = root.createElement("span");
        meta.textContent = `重要性 ${publication.importance} · ${event.sources.length} 个公开来源 · 修订 ${event.revisionNo}`;
        copy.append(title, meta);
        const type = root.createElement("span");
        type.className = "intelligence-digest-kind";
        type.textContent = publication.kind === "daily" ? "日报" : "事件";
        button.append(order, copy, type);
        button.addEventListener("click", () => selectFormalPublicationEvent(publication, event, button));
        return button;
      });
      digestList.replaceChildren(...buttons);
      signalList.replaceChildren(...events.slice(0, 12).map(({ publication, event }) => {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "intelligence-signal";
        button.textContent = `${publication.kind === "daily" ? "日报" : "事件"} · ${event.title}`;
        button.addEventListener("click", () => selectFormalPublicationEvent(publication, event));
        return button;
      }));
      selectFormalPublicationEvent(events[0]!.publication, events[0]!.event, buttons[0]);
    };

    const rerenderFormalPublicationFilters = (): void => {
      if (!formalPublicationCache) return;
      renderFormalPublicationCache(
        formalPublicationCache.cache,
        formalPublicationCache.publications,
        formalPublicationCache.events,
        formalPublicationCache.personalized,
      );
    };

    const updateArchiveStatus = async (requestId: string, { retry = false }: { readonly retry?: boolean } = {}): Promise<void> => {
      if (!transport || !archiveStatus || !archiveRetry) return;
      activeArchiveRequestId = requestId;
      archiveRetry.hidden = true;
      archiveStatus.textContent = retry ? "正在重试下载历史内容…" : "正在查询历史回源状态…";
      try {
        const response = record(await transport.invoke<unknown>("intelligence_archive_request_status", { requestId }));
        const state = text(response?.state);
        const ready = response?.contentReady === true || state === "READY" || state === "DOWNLOADED";
        if (ready) {
          archiveStatus.textContent = "历史内容已就绪，正在下载、校验并保存…";
          const completed = record(await transport.invoke<unknown>("intelligence_archive_download", { requestId }));
          if (text(completed?.state) === "ACKED") {
            archiveStatus.textContent = "历史内容已校验、保存并确认。刷新后可在已保存资讯中查看。";
            activeArchiveRequestId = "";
            void load();
            return;
          }
          archiveStatus.textContent = "历史内容尚未完成确认；可稍后重试。";
          archiveRetry.hidden = false;
          return;
        }
        if (state === "FAILED" || state === "EXPIRED") {
          archiveStatus.textContent = state === "EXPIRED" ? "历史回源请求已过期，请重新创建请求。" : "历史回源失败，可重试下载。";
          archiveRetry.hidden = false;
          return;
        }
        archiveStatus.textContent = "历史回源正在准备；将在内容就绪后下载并校验。";
        if (!page.hidden && activeArchiveRequestId === requestId) {
          setTimeout(() => { void updateArchiveStatus(requestId); }, 4_000);
        }
      } catch (error: unknown) {
        archiveStatus.textContent = intelligenceClientErrorMessage(error);
        archiveRetry.hidden = false;
      }
    };

    const loadArchiveCalendar = async (): Promise<void> => {
      if (!transport || !archiveDay || !archiveStatus) return;
      if (archiveDay.children.length > 1) return;
      archiveStatus.textContent = "正在读取可申请的历史日期…";
      try {
        const response = record(await transport.invoke<unknown>("intelligence_archive_calendar"));
        const days = Array.isArray(response?.days) ? response.days : [];
        const options = days.flatMap((value) => {
          const entry = record(value);
          const day = text(entry?.day);
          const count = entry?.entryCount;
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof count !== "number" || !Number.isInteger(count) || count < 0) return [];
          const option = root.createElement("option");
          option.value = day;
          option.textContent = `${day} · ${count} 条`;
          return [option];
        });
        archiveDay.replaceChildren(Object.assign(root.createElement("option"), { value: "", textContent: "选择 30 天前日期" }), ...options);
        archiveStatus.textContent = options.length > 0
          ? "请选择日期后请求历史回源。"
          : "当前账户没有可申请的历史日期。";
      } catch (error: unknown) {
        archiveStatus.textContent = intelligenceClientErrorMessage(error);
      }
    };

    const selectInterstellarCandidate = (
      candidate: InterstellarSignalCandidate,
      button?: HTMLButtonElement,
    ): void => {
      selectedInterstellarItem = candidate.item;
      selectedInterstellarFavorite = newsFavoriteForItem(candidate.item);
      interstellarContextTitle.textContent = itemTitle(candidate.item);
      const domains = candidate.domains.join("、");
      interstellarContextBody.textContent = `${itemContext(candidate.item)}\n候选领域：${domains}。相关性仅用于进入审核队列，尚未改变进度。`;
      refreshFavoriteAction(interstellarFavoriteAction, selectedInterstellarFavorite);
      interstellarContextBody.append(interstellarFavoriteAction);
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
        selectedInterstellarFavorite = null;
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
        id: "article-triage", status: "pending", unit: "articles", inputCount: briefingResult.uniqueCount, outputCount: 0, pendingCount: briefingResult.uniqueCount,
        summary: `全部 ${briefingResult.uniqueCount} 篇唯一文章进入本机持久队列；不会先按规则裁成每日 25 条。`,
      });
      setAuditStage({ id: "relation-recall", status: "pending", unit: "pairs", inputCount: 0, outputCount: 0, summary: "等待逐篇初筛；语义召回和重排只产生候选对，不直接合并。" });
      setAuditStage({ id: "relation-judge", status: "pending", unit: "pairs", inputCount: 0, outputCount: 0, summary: "等待 7B/8B 模型按八类关系核验候选对。" });
      setAuditStage({ id: "historical-recall", status: "pending", unit: "events", inputCount: 0, outputCount: 0, summary: "等待检索历史事件，识别前情、更新、更正和同系列新闻。" });
      setAuditStage({ id: "qwen-review", status: "pending", unit: "events", inputCount: 0, outputCount: 0, summary: "校准期由 Qwen 复核全部重大、低置信和冲突样本；达标后才降低抽检率。" });
      setAuditStage({ id: "final-events", status: "pending", unit: "events", inputCount: 0, outputCount: 0, summary: "等待关系判定与 Qwen 复核完成；不会预先显示未处理事件。" });
      setAuditStage({ id: "series-timeline", status: "pending", unit: "series", inputCount: 0, outputCount: 0, summary: "等待稳定事件写入系列，并生成前情提要与修订时间线。" });
      publishAudit("本轮公开资讯已进入可人工核查的本机处理链路。");
      processingSummary.textContent = `采集 ${items.length} 篇 → 精确去重 ${briefingResult.uniqueCount} 篇 → 等待逐篇初筛`;
      const nextCandidates = selectIntelligenceBriefCandidates(briefingResult);
      const nextCandidateKey = nextCandidates.map((candidate) => `${candidate.id}:${candidate.sources.map((source) => `${source.url}|${source.body || source.summary}`).join("\u001f")}`).join("\n");
      if (nextCandidateKey !== modelCandidateKey()) {
        currentModelBriefs = [];
      }
      currentCandidates = nextCandidates;
      // The workspace is a reader of the durable archive, not the worker.
      // In particular, rendering a saved snapshot must never enqueue article
      // ingestion, triage, relationship judgement, or a local-model request.
      // Those jobs belong to the separately scheduled intelligence worker.
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
        ? `全目录资料库已完成：覆盖 ${attemptedSources} 个来源，${items.length} 条资讯精确去重为 ${briefingResult.uniqueCount} 篇；逐篇判定和事件关系在本机增量队列继续运行${failedSummary}。`
        : `资料库建立中：已覆盖 ${attemptedSources} / ${catalogueCount} 个来源，当前 ${items.length} 条资讯精确去重为 ${briefingResult.uniqueCount} 篇${failedSummary}。`);
    };

    // Retained only for opening historical local snapshots from existing
    // actions. The workspace's primary open/refresh path below never invokes
    // it: official V1 distribution renders only the native account cache.
    const loadLegacyLocalSnapshot = async ({ forceRefresh = false }: { readonly forceRefresh?: boolean } = {}): Promise<void> => {
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
        // Opening and refreshing this page are deliberately read-only.  The
        // source catalogue is display state; only the external background
        // worker may collect from it or submit work to a model.
        const request = { ...persistedRequest, sourceIds: allSourceIds, preserveEvidence: true };
        const savedSnapshot = await readPersistentSnapshot(transport, runtime.localStorage, allSourceIds);
        if (!isCurrentLoad()) return;
        if (!savedSnapshot) {
          renderInterstellarSources(sourceResult, request, []);
          render([], catalogue.length, 0, 0, false);
          setStandardStatus("尚无可读取的本机情报快照；后台情报工作节点负责采集和模型处理，本页不会自行启动任务。");
          return;
        }

        const failureSummary = savedSnapshot.failedSources > 0
          ? `；${savedSnapshot.failedSources} 个来源暂时不可用`
          : "";
        renderInterstellarSources(sourceResult, request, savedSnapshot.items);
        render(
          [...savedSnapshot.items],
          catalogue.length,
          savedSnapshot.attemptedSources,
          savedSnapshot.failedSources,
          savedSnapshot.completed,
        );
        setStandardStatus(
          `${forceRefresh ? "已重新读取" : "已读取"}本机${savedSnapshot.completed ? "完整" : "进行中"}资料快照（${savedSnapshot.items.length} 条资讯${failureSummary}）；后台情报工作节点负责后续采集与模型处理，本页不会启动任务。`,
        );
        if (savedSnapshot.completed) {
          await restoreCurrentDailyDigest();
          if (!isCurrentLoad()) return;
        }
      } catch {
        if (isCurrentLoad()) {
          setStandardStatus("本机情报状态暂时无法读取；后台工作节点状态不会被本页改写。");
          setInterstellarStatus("候选信号状态暂时无法读取；首版人工基线仍可查看。");
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

    // 正式资讯页只读取账号隔离的原生缓存；保留旧路径供已保存的历史本机动作
    // 兼容，不在打开或刷新页面时执行。
    void waitForPipelineCompatibility;
    void preloadPreparedBriefImages;
    void loadLegacyLocalSnapshot;

    const load = async ({ forceRefresh = false }: { readonly forceRefresh?: boolean } = {}): Promise<void> => {
      if (loading) return;
      if (!transport) {
        setStandardStatus("情报服务暂不可用；无法读取本地正式缓存。");
        return;
      }
      loading = true;
      const generation = ++loadGeneration;
      const isCurrentLoad = (): boolean => generation === loadGeneration && !page.hidden;
      refreshButton.disabled = true;
      try {
        let refreshFailed = false;
        if (forceRefresh) {
          try {
            await transport.invoke("intelligence_client_refresh");
          } catch {
            // The native cache records a fixed, content-free failure state.
            // Continue with cache reads so the page can distinguish an empty
            // server response from login, permission, or validation failure.
            refreshFailed = true;
          }
          if (!isCurrentLoad()) return;
        }
        // Both commands are native cache reads.  They do not receive a URL or
        // token, and neither opens a network connection on page open.
        const statusValue = clientCacheStatus(await transport.invoke<unknown>("intelligence_client_cache_status"));
        if (!isCurrentLoad()) return;
        const publications = statusValue?.deliveryState === "login_required"
          ? []
          : clientCachedPublications(
            await transport.invoke<unknown>("intelligence_client_cached_publications"),
          );
        if (!isCurrentLoad()) return;
        if (!statusValue || !publications) throw new Error("invalid cache projection");
        const ordered = await orderFormalPublicationCacheByPreference(statusValue, publications);
        if (!isCurrentLoad()) return;
        renderFormalPublicationCache(statusValue, publications, ordered.events, ordered.personalized);
        const refreshed = forceRefresh
          ? (refreshFailed ? "手动刷新未完成；" : "已完成手动刷新；")
          : "已读取本地正式缓存；";
        setStandardStatus(`${refreshed}${intelligenceDeliveryStateCopy(statusValue)}`);
      } catch (error: unknown) {
        if (isCurrentLoad()) setStandardStatus(intelligenceClientErrorMessage(error));
      } finally {
        loading = false;
        refreshButton.disabled = false;
        if (deliveryCacheReloadPending && !page.hidden) {
          deliveryCacheReloadPending = false;
          void load();
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
      await load();
    };

    const refreshToolbarVisibility = async (): Promise<void> => {
      // The toolbar item starts hidden in HTML.  A remembered display choice
      // must never reveal the account-scoped delivery surface before a local
      // signed-in account has been configured.  This reads only the existing
      // local sync settings; it does not unlock a token or contact a server.
      if (!toolbarAction || !transport) return;
      try {
        const settings = record(await transport.invoke<unknown>("sync_get_settings"));
        toolbarAction.hidden = !(text(settings?.userId) && text(settings?.url));
      } catch {
        toolbarAction.hidden = true;
      }
    };

    const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
      if (loading) {
        loadGeneration += 1;
        cancelledLoadPending = true;
      }
      closeSourceDirectory({ focus: false });
      stopAuditLiveRefresh();
      page.hidden = true;
      if (contentShell) contentShell.hidden = false;
      root.body.classList.remove("intelligence-workspace-active");
      toolbarButton.setAttribute("aria-pressed", "false");
      if (focus) toolbarButton.focus({ preventScroll: true });
    };

    toolbarButton.addEventListener("click", () => { void open(); });
    // Rust emits this only after an SSE wake-up has completed the normal
    // authenticated download, validation and ACK path.  The payload is unit;
    // the UI learns no server URL, token, delivery ID, or editorial content
    // from the event and simply re-reads the existing local formal cache.
    if (transport?.listen) {
      void transport.listen("intelligence-delivery-updated", () => {
        if (page.hidden) return;
        if (loading) {
          deliveryCacheReloadPending = true;
          return;
        }
        void load();
      }).catch(() => undefined);
    }
    void refreshToolbarVisibility();
    runtime.addEventListener("focus", () => { void refreshToolbarVisibility(); });
    back.addEventListener("click", () => close());
    auditTrigger?.addEventListener("click", startAuditLiveRefresh);
    auditBack?.addEventListener("click", stopAuditLiveRefresh);
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
      if (!qwen27bSelectable) {
        modelStatus.textContent = "显卡总显存不足或检测失败，不能选择千问 27B（16GB 显存版）";
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
          modelSave.disabled = !qwen27bSelectable;
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
      if (selectedFormalPublication) {
        void openFormalPublicationEvent();
        return;
      }
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
    [kindFilter, importanceFilter, scopeFilter].forEach((filter) => {
      filter?.addEventListener("change", rerenderFormalPublicationFilters);
    });
    archiveDay?.addEventListener("focus", () => { void loadArchiveCalendar(); });
    archiveRequest?.addEventListener("click", () => {
      void (async () => {
        if (!transport || !archiveDay || !archiveStatus) return;
        if (!archiveDay.value) {
          await loadArchiveCalendar();
          if (!archiveDay.value) return;
        }
        archiveRequest.disabled = true;
        archiveStatus.textContent = "正在创建历史回源请求…";
        try {
          const request = record(await transport.invoke<unknown>("intelligence_archive_request", { request: { day: archiveDay.value } }));
          const requestId = text(request?.requestId);
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId)) throw new Error("历史回源请求响应无效");
          await updateArchiveStatus(requestId);
        } catch (error: unknown) {
          archiveStatus.textContent = intelligenceClientErrorMessage(error);
        } finally {
          archiveRequest.disabled = false;
        }
      })();
    });
    archiveRetry?.addEventListener("click", () => {
      if (activeArchiveRequestId) void updateArchiveStatus(activeArchiveRequestId, { retry: true });
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
    return Object.freeze({ open, close, refresh: load, layout: () => currentLayout, openStoredEvent, openFavorite });
  };

  const global: IntelligenceWorkspaceGlobal = { init };
  runtime.ReaderIntelligenceWorkspace = global;
  global.instance = init();
  return global;
}
