/**
 * View-free state and projections for the local intelligence pipeline.
 *
 * The native store is authoritative.  This module deliberately contains no
 * DOM, localStorage or Tauri global access so a reload can reconstruct the
 * same state from SQLite and resume an expired lease without replaying every
 * model call.
 */

export const INTELLIGENCE_PIPELINE_STAGE_IDS = Object.freeze([
  "collected",
  "exact-dedupe",
  "article-triage",
  "relation-recall",
  "relation-judge",
  "historical-recall",
  "qwen-review",
  "final-events",
  "series-timeline",
] as const);

export type IntelligencePipelineStageId = typeof INTELLIGENCE_PIPELINE_STAGE_IDS[number];

export type IntelligenceRelation =
  | "exact_duplicate"
  | "syndicated_copy"
  | "same_event"
  | "event_update"
  | "same_series"
  | "background"
  | "correction"
  | "unrelated";

export const INTELLIGENCE_RELATIONS = Object.freeze([
  "exact_duplicate",
  "syndicated_copy",
  "same_event",
  "event_update",
  "same_series",
  "background",
  "correction",
  "unrelated",
] as const satisfies readonly IntelligenceRelation[]);

export type IntelligencePipelinePhase =
  | "idle"
  | "upserting"
  | "triaging"
  | "paused"
  | "completed"
  | "failed";

export interface IntelligencePipelineArticle {
  readonly articleId: string;
  readonly fingerprint: string;
  readonly url?: string;
  readonly sourceKey?: string;
  readonly sourceName?: string;
  readonly title: string;
  readonly summary?: string;
  readonly body?: string;
  readonly publishedAt?: string;
  readonly language?: string;
  readonly mediaJson?: string;
}

export interface IntelligenceStoredTriageDecision {
  readonly articleId: string;
  readonly fingerprint: string;
  readonly status: "keep" | "filter" | "failed";
  readonly importance?: number;
  readonly confidence?: number;
  readonly reason?: string;
  readonly decisionJson?: string;
}

export interface IntelligenceClaimedTriageBatch {
  readonly leaseOwner: string;
  readonly articles: readonly IntelligencePipelineArticle[];
  readonly remaining: number;
}

export interface IntelligenceTriageModelDecision {
  readonly articleId: string;
  readonly fingerprint: string;
  readonly status: "keep" | "filter" | "failed";
  readonly importance?: number;
  readonly confidence?: number;
  readonly reason?: string;
  readonly decisionJson?: string;
}

export interface IntelligencePipelineCounts {
  readonly received: number;
  readonly unique: number;
  readonly queued: number;
  readonly claimed: number;
  readonly kept: number;
  readonly filtered: number;
  readonly failed: number;
  readonly reused: number;
  readonly remaining: number;
}

export interface IntelligencePipelineState extends IntelligencePipelineCounts {
  readonly phase: IntelligencePipelinePhase;
  readonly message: string;
  readonly updatedAt: number;
}

export type IntelligencePipelineEvent =
  | { readonly type: "upsert-started"; readonly received: number; readonly unique: number }
  | { readonly type: "upsert-finished"; readonly queued: number; readonly reused: number }
  | { readonly type: "triage-claimed"; readonly claimed: number; readonly remaining: number }
  | { readonly type: "triage-applied"; readonly decisions: readonly IntelligenceTriageModelDecision[]; readonly remaining: number }
  | { readonly type: "paused"; readonly message: string }
  | { readonly type: "completed" }
  | { readonly type: "failed"; readonly message: string };

export function emptyIntelligencePipelineState(now = Date.now()): IntelligencePipelineState {
  return {
    phase: "idle",
    received: 0,
    unique: 0,
    queued: 0,
    claimed: 0,
    kept: 0,
    filtered: 0,
    failed: 0,
    reused: 0,
    remaining: 0,
    message: "等待新增资讯。",
    updatedAt: now,
  };
}

function boundedCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function reduceIntelligencePipelineState(
  state: IntelligencePipelineState,
  event: IntelligencePipelineEvent,
  now = Date.now(),
): IntelligencePipelineState {
  switch (event.type) {
    case "upsert-started":
      return {
        ...state,
        phase: "upserting",
        received: boundedCount(event.received),
        unique: boundedCount(event.unique),
        message: `正在把 ${boundedCount(event.unique)} 篇唯一文章写入本机增量队列。`,
        updatedAt: now,
      };
    case "upsert-finished":
      return {
        ...state,
        phase: event.queued > 0 ? "triaging" : "completed",
        queued: state.queued + boundedCount(event.queued),
        reused: state.reused + boundedCount(event.reused),
        remaining: boundedCount(event.queued),
        message: event.queued > 0
          ? `已有 ${boundedCount(event.queued)} 篇新增或变化文章等待 7B/8B 模型处理。`
          : "全部文章均命中持久缓存。",
        updatedAt: now,
      };
    case "triage-claimed":
      return {
        ...state,
        phase: "triaging",
        claimed: state.claimed + boundedCount(event.claimed),
        remaining: boundedCount(event.remaining),
        message: `7B/8B 模型正在逐篇处理；队列剩余 ${boundedCount(event.remaining)} 篇。`,
        updatedAt: now,
      };
    case "triage-applied": {
      const kept = event.decisions.filter((decision) => decision.status === "keep").length;
      const filtered = event.decisions.filter((decision) => decision.status === "filter").length;
      const failed = event.decisions.filter((decision) => decision.status === "failed").length;
      return {
        ...state,
        phase: event.remaining > 0 ? "triaging" : "completed",
        kept: state.kept + kept,
        filtered: state.filtered + filtered,
        failed: state.failed + failed,
        remaining: boundedCount(event.remaining),
        message: event.remaining > 0
          ? `已判定 ${state.kept + kept + state.filtered + filtered + state.failed + failed} 篇；队列剩余 ${boundedCount(event.remaining)} 篇。`
          : "逐篇初筛队列已处理完成。",
        updatedAt: now,
      };
    }
    case "paused":
      return { ...state, phase: "paused", message: event.message, updatedAt: now };
    case "completed":
      return { ...state, phase: "completed", remaining: 0, message: "本轮增量处理完成。", updatedAt: now };
    case "failed":
      return { ...state, phase: "failed", message: event.message, updatedAt: now };
  }
}

/** Deterministic non-cryptographic content key; native storage revalidates it. */
export function intelligencePipelineFingerprint(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${value.length.toString(36)}-${(first >>> 0).toString(36)}-${(second >>> 0).toString(36)}`;
}

export function intelligencePipelineArticleId(
  canonicalUrl: string,
  sourceKey: string,
  normalizedTitle: string,
): string {
  const identity = canonicalUrl || `${sourceKey}\u001f${normalizedTitle}`;
  return `article-${intelligencePipelineFingerprint(identity)}`;
}

export function chunkIntelligencePipelineArticles(
  articles: readonly IntelligencePipelineArticle[],
  size = 256,
): IntelligencePipelineArticle[][] {
  const safeSize = Math.max(1, Math.floor(size));
  const result: IntelligencePipelineArticle[][] = [];
  for (let start = 0; start < articles.length; start += safeSize) {
    result.push(articles.slice(start, start + safeSize));
  }
  return result;
}

export interface IntelligencePipelinePort {
  readonly upsertArticles: (articles: readonly IntelligencePipelineArticle[]) => Promise<{
    readonly received: number;
    readonly inserted: number;
    readonly updated: number;
    readonly unchanged: number;
    readonly queued: number;
  }>;
  readonly claimTriage: (request: {
    readonly limit: number;
    readonly leaseOwner?: string;
    readonly leaseSeconds?: number;
  }) => Promise<IntelligenceClaimedTriageBatch>;
  readonly classifyArticles: (
    articles: readonly IntelligencePipelineArticle[],
  ) => Promise<readonly IntelligenceTriageModelDecision[]>;
  readonly applyTriage: (request: {
    readonly leaseOwner: string;
    readonly modelId: string;
    readonly modelSha?: string;
    readonly promptVersion: string;
    readonly decisions: readonly IntelligenceTriageModelDecision[];
  }) => Promise<void>;
}

export interface IntelligencePipelineRunOptions {
  readonly modelId: string;
  readonly modelSha?: string;
  readonly promptVersion: string;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  readonly shouldContinue?: () => boolean;
  readonly yieldControl?: () => Promise<void>;
  readonly onState?: (state: IntelligencePipelineState) => void;
}

function modelDecisionForArticle(
  article: IntelligencePipelineArticle,
  decisions: readonly IntelligenceTriageModelDecision[],
): IntelligenceTriageModelDecision {
  const decision = decisions.find((candidate) => (
    candidate.articleId === article.articleId && candidate.fingerprint === article.fingerprint
  ));
  return decision ?? {
    articleId: article.articleId,
    fingerprint: article.fingerprint,
    status: "failed",
    reason: "模型没有返回与文章指纹匹配的判定。",
  };
}

/**
 * Drains only native leases.  A transport/model exception pauses immediately
 * and deliberately leaves the current lease unapplied; SQLite can recover it
 * after expiry instead of silently turning an offline model into thousands of
 * terminal filter decisions.
 */
export async function runIntelligenceArticleTriageQueue(
  port: IntelligencePipelinePort,
  initialState: IntelligencePipelineState,
  options: IntelligencePipelineRunOptions,
): Promise<IntelligencePipelineState> {
  const batchSize = Math.max(1, Math.min(64, Math.floor(options.batchSize ?? 12)));
  let state = initialState;
  let leaseOwner: string | undefined;
  const publish = (event: IntelligencePipelineEvent): void => {
    state = reduceIntelligencePipelineState(state, event);
    options.onState?.(state);
  };
  while (options.shouldContinue?.() !== false) {
    let claimed: IntelligenceClaimedTriageBatch;
    try {
      claimed = await port.claimTriage({
        limit: batchSize,
        ...(leaseOwner ? { leaseOwner } : {}),
        leaseSeconds: Math.max(30, Math.floor(options.leaseSeconds ?? 180)),
      });
    } catch (error: unknown) {
      publish({ type: "paused", message: `本机队列暂不可用：${String(error)}` });
      return state;
    }
    leaseOwner = claimed.leaseOwner || leaseOwner;
    if (claimed.articles.length === 0) {
      if (claimed.remaining === 0) publish({ type: "completed" });
      else publish({ type: "paused", message: `还有 ${claimed.remaining} 篇由其它工作进程处理或等待租约恢复。` });
      return state;
    }
    publish({ type: "triage-claimed", claimed: claimed.articles.length, remaining: claimed.remaining });
    try {
      const modelDecisions = await port.classifyArticles(claimed.articles);
      const decisions = claimed.articles.map((article) => modelDecisionForArticle(article, modelDecisions));
      await port.applyTriage({
        leaseOwner: claimed.leaseOwner,
        modelId: options.modelId,
        ...(options.modelSha ? { modelSha: options.modelSha } : {}),
        promptVersion: options.promptVersion,
        decisions,
      });
      publish({ type: "triage-applied", decisions, remaining: claimed.remaining });
    } catch (error: unknown) {
      publish({ type: "paused", message: `7B/8B 本机模型暂不可用；租约到期后可断点续跑：${String(error)}` });
      return state;
    }
    await (options.yieldControl?.() ?? Promise.resolve());
  }
  publish({ type: "paused", message: "处理已暂停；已完成结果保留在本机。" });
  return state;
}

export interface IntelligencePipelineRelationDecision {
  readonly leftArticleId: string;
  readonly rightArticleId: string;
  readonly relation: IntelligenceRelation;
  readonly confidence: number;
  readonly reason?: string;
}

export function parseIntelligenceRelation(value: unknown): IntelligenceRelation | null {
  return typeof value === "string" && (INTELLIGENCE_RELATIONS as readonly string[]).includes(value)
    ? value as IntelligenceRelation
    : null;
}

export interface IntelligenceProjectedEvent {
  readonly eventId: string;
  readonly seriesId?: string;
  readonly articleIds: readonly string[];
  readonly relations: readonly IntelligencePipelineRelationDecision[];
}

export interface IntelligenceExistingEventAssignment {
  readonly articleId: string;
  readonly eventId: string;
  readonly seriesId?: string;
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  public add(value: string): void {
    if (!this.parent.has(value)) this.parent.set(value, value);
  }

  public find(value: string): string {
    this.add(value);
    const current = this.parent.get(value)!;
    if (current === value) return value;
    const root = this.find(current);
    this.parent.set(value, root);
    return root;
  }

  public union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    const [first, second] = [leftRoot, rightRoot].sort();
    this.parent.set(second!, first!);
  }
}

/**
 * Only duplicate/copy/same-event edges collapse an event.  Updates,
 * corrections, background and same-series links remain separate revisions or
 * events and merely share a stable series projection.
 */
export function projectStableIntelligenceEvents(
  articleIds: readonly string[],
  relations: readonly IntelligencePipelineRelationDecision[],
  existingAssignments: readonly IntelligenceExistingEventAssignment[] = [],
): IntelligenceProjectedEvent[] {
  const eventSet = new DisjointSet();
  articleIds.forEach((id) => eventSet.add(id));
  relations.forEach((relation) => {
    // Exact duplicates are a byte/canonical-identity decision made before the
    // model stage. A model-only exact_duplicate edge between two distinct ids
    // is never allowed to erase an independent or bilingual source.
    if (["syndicated_copy", "same_event"].includes(relation.relation)
      || (relation.relation === "exact_duplicate" && relation.leftArticleId === relation.rightArticleId)) {
      eventSet.union(relation.leftArticleId, relation.rightArticleId);
    }
  });
  const membersByRoot = new Map<string, string[]>();
  articleIds.forEach((id) => {
    const root = eventSet.find(id);
    membersByRoot.set(root, [...(membersByRoot.get(root) ?? []), id]);
  });
  const existingByArticle = new Map(existingAssignments.map((assignment) => [assignment.articleId, assignment]));
  const eventIdByArticle = new Map<string, string>();
  const projected = [...membersByRoot.values()].map((members) => {
    const sorted = members.slice().sort();
    // Once any member has been projected, its native event id is the stable
    // identity.  Adding a second-day source creates a revision on that event
    // instead of deriving a new id from the expanded member set.
    const existingEventIds = [...new Set(sorted.map((id) => existingByArticle.get(id)?.eventId).filter((id): id is string => Boolean(id)))].sort();
    const eventId = existingEventIds[0] ?? `event-${intelligencePipelineFingerprint(sorted.join("\u001f"))}`;
    sorted.forEach((id) => eventIdByArticle.set(id, eventId));
    return { eventId, articleIds: sorted };
  });
  const seriesSet = new DisjointSet();
  projected.forEach((event) => seriesSet.add(event.eventId));
  relations.forEach((relation) => {
    if (!["event_update", "same_series", "background", "correction"].includes(relation.relation)) return;
    const leftEvent = eventIdByArticle.get(relation.leftArticleId);
    const rightEvent = eventIdByArticle.get(relation.rightArticleId);
    if (leftEvent && rightEvent && leftEvent !== rightEvent) seriesSet.union(leftEvent, rightEvent);
  });
  const seriesMembers = new Map<string, string[]>();
  projected.forEach((event) => {
    const root = seriesSet.find(event.eventId);
    seriesMembers.set(root, [...(seriesMembers.get(root) ?? []), event.eventId]);
  });
  const seriesIdByEvent = new Map<string, string>();
  projected.forEach((event) => {
    const existingSeriesIds = [...new Set(event.articleIds
      .map((articleId) => existingByArticle.get(articleId)?.seriesId)
      .filter((id): id is string => Boolean(id)))].sort();
    if (existingSeriesIds[0]) seriesIdByEvent.set(event.eventId, existingSeriesIds[0]);
  });
  [...seriesMembers.values()].filter((members) => members.length > 1).forEach((members) => {
    const existingSeriesIds = [...new Set(existingAssignments
      .filter((assignment) => members.includes(eventIdByArticle.get(assignment.articleId) ?? assignment.eventId))
      .map((assignment) => assignment.seriesId)
      .filter((id): id is string => Boolean(id)))].sort();
    const seriesId = existingSeriesIds[0] ?? `series-${intelligencePipelineFingerprint(members.slice().sort().join("\u001f"))}`;
    members.forEach((eventId) => seriesIdByEvent.set(eventId, seriesIdByEvent.get(eventId) ?? seriesId));
  });
  return projected.map((event) => ({
    ...event,
    ...(seriesIdByEvent.has(event.eventId) ? { seriesId: seriesIdByEvent.get(event.eventId)! } : {}),
    relations: relations.filter((relation) => (
      event.articleIds.includes(relation.leftArticleId) || event.articleIds.includes(relation.rightArticleId)
    )),
  })).sort((left, right) => left.eventId.localeCompare(right.eventId));
}

export interface IntelligenceReviewMetrics {
  readonly reviewed: number;
  readonly importantRecall: number;
  readonly mergePrecision: number;
  readonly falseMergeRate: number;
  readonly jsonCompliance: number;
}

export interface IntelligenceReviewGate {
  readonly passed: boolean;
  readonly qwenReviewRate: number;
  readonly reasons: readonly string[];
}

/** Qwen review remains high until a meaningful, high-quality sample exists. */
export function intelligenceQwenReviewGate(metrics: IntelligenceReviewMetrics): IntelligenceReviewGate {
  const reasons: string[] = [];
  if (metrics.reviewed < 50) reasons.push("复核样本不足 50 条");
  if (metrics.importantRecall < 0.98) reasons.push("重要新闻召回率低于 98%");
  if (metrics.mergePrecision < 0.98) reasons.push("事件合并精确率低于 98%");
  if (metrics.falseMergeRate > 0.01) reasons.push("错误合并率高于 1%");
  if (metrics.jsonCompliance < 1) reasons.push("重试后 JSON 合规率未达到 100%");
  return {
    passed: reasons.length === 0,
    qwenReviewRate: reasons.length === 0 ? 0.05 : 1,
    reasons,
  };
}
