/**
 * The intelligence workspace keeps the visual page in ui/index.html. This
 * controller exposes only sanitised process metadata: never article bodies,
 * URLs, local model settings, or credentials.
 *
 * Audit snapshots can be sizeable. The UI therefore renders the nine-stage
 * map immediately but materialises records for only the selected stage and a
 * small page at a time. Opening the audit view remains responsive.
 */

export type IntelligenceAuditStatus =
  | "pending"
  | "running"
  | "accepted"
  | "rejected"
  | "warning"
  | "cached";

export interface IntelligenceAuditItem {
  readonly id?: string;
  /** Public headline or an event label. Do not place article body text here. */
  readonly title: string;
  /** Public source names, entity labels, or other short non-sensitive metadata. */
  readonly meta?: string;
  /** A bounded decision reason, never raw article text or a URL. */
  readonly reason?: string;
  readonly status?: IntelligenceAuditStatus;
  readonly badge?: string;
  readonly confidence?: number;
  readonly sourceCount?: number;
}

export interface IntelligenceAuditStage {
  readonly id: IntelligenceAuditStageId;
  readonly status?: IntelligenceAuditStatus;
  readonly summary?: string;
  readonly count?: number;
  /** What this stage counts. Never assume the pipeline is a linear article count. */
  readonly unit?: "articles" | "pairs" | "events" | "series";
  readonly inputCount?: number;
  readonly outputCount?: number;
  readonly pendingCount?: number;
  readonly reusedCount?: number;
  readonly items?: readonly IntelligenceAuditItem[];
}

export type IntelligenceAuditStageId =
  | "collected"
  | "exact-dedupe"
  | "article-triage"
  | "relation-recall"
  | "relation-judge"
  | "historical-recall"
  | "qwen-review"
  | "final-events"
  | "series-timeline";

/** Narrow, in-memory hand-off from the collection/model pipeline to audit UI. */
export interface IntelligenceAuditSnapshot {
  readonly runId?: string;
  readonly generatedAt?: string | number;
  readonly summary?: string;
  readonly stages?: readonly IntelligenceAuditStage[];
}

export interface IntelligenceAuditDetailPage {
  readonly total: number;
  readonly items: readonly IntelligenceAuditItem[];
}

export type IntelligenceAuditDetailLoader = (request: Readonly<{
  runId: string;
  stageId: IntelligenceAuditStageId;
  offset: number;
  limit: number;
}>) => Promise<IntelligenceAuditDetailPage>;

export interface IntelligenceAuditController {
  readonly open: () => void;
  readonly close: (options?: { readonly focus?: boolean }) => void;
  readonly setSnapshot: (snapshot: IntelligenceAuditSnapshot | null) => void;
  readonly setDetailLoader: (loader: IntelligenceAuditDetailLoader | null) => void;
  readonly snapshot: () => IntelligenceAuditSnapshot | null;
}

export interface IntelligenceAuditGlobal {
  readonly init: () => IntelligenceAuditController | null;
  instance?: IntelligenceAuditController | null;
}

interface IntelligenceAuditRuntime extends Record<string, unknown> {
  readonly document: Document;
  ReaderIntelligenceAudit?: IntelligenceAuditGlobal;
  readonly ReaderProblemTraceUI?: {
    readonly recordIntelligenceAuditTiming?: (action: unknown, phase: unknown, durationMs: unknown, stageId: unknown, itemCount: unknown) => void;
  };
  addEventListener(type: string, listener: (event: KeyboardEvent) => void): void;
  requestAnimationFrame?(callback: FrameRequestCallback): number;
}

const STAGES: ReadonlyArray<Readonly<{
  id: IntelligenceAuditStageId;
  label: string;
  caption: string;
  purpose: string;
}>> = Object.freeze([
  { id: "collected", label: "采集", caption: "公开来源进入本机快照", purpose: "确认本轮输入量与来源覆盖范围。" },
  { id: "exact-dedupe", label: "精确去重", caption: "移除同源重复项", purpose: "同 URL 或完全相同的条目只保留一份。" },
  { id: "article-triage", label: "逐篇初筛", caption: "7B/8B 小模型覆盖全部新增文章", purpose: "逐篇判断重要性、主体、动作和是否保留；规则只负责排队，不提前删除文章。" },
  { id: "relation-recall", label: "关系召回", caption: "Qwen3 Embedding 召回并由 Reranker 重排", purpose: "0.6B 对全部新增文章做近邻召回，8B 只处理低置信样本；这一层不直接合并。" },
  { id: "relation-judge", label: "关系判定", caption: "小模型区分重复、同事件、进展与无关", purpose: "逐对输出结构化关系、置信度和原因，低置信结果进入复核。" },
  { id: "historical-recall", label: "历史关联", caption: "检索旧事件与新闻系列", purpose: "判断是同一事件的新修订、同系列新事件，还是仅作为背景引用。" },
  { id: "qwen-review", label: "Qwen 抽检", caption: "分层复核并校准小模型", purpose: "统计召回率、误过滤和错误合并；冲突、低置信和重大新闻强制复核。" },
  { id: "final-events", label: "综合报道", caption: "全文证据生成可复用事件修订", purpose: "只增量处理变化来源，保留事实、来源差异、媒体和修订版本。" },
  { id: "series-timeline", label: "系列时间线", caption: "生成前情提要与历史内部链接", purpose: "稳定事件和系列 ID 连接历史综合报道；每日简报固定引用当时修订。" },
] as const);

const MAX_TITLE_CHARS = 180;
const MAX_META_CHARS = 200;
const MAX_REASON_CHARS = 320;
const MAX_ITEMS_PER_STAGE = 40;
const DETAIL_PAGE_SIZE = 10;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function runtimeFrom(value: unknown): IntelligenceAuditRuntime | null {
  const runtime = record(value);
  if (!runtime || !record(runtime.document) || typeof runtime.addEventListener !== "function") return null;
  return runtime as unknown as IntelligenceAuditRuntime;
}

function boundedText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > maxChars ? `${normalized.slice(0, Math.max(0, maxChars - 1))}…` : normalized;
}

function auditStatus(value: unknown): IntelligenceAuditStatus {
  return value === "running" || value === "accepted" || value === "rejected" || value === "warning" || value === "cached"
    ? value
    : "pending";
}

function safeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.floor(value), 999_999)
    : undefined;
}

function safeConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function normaliseItem(value: IntelligenceAuditItem): IntelligenceAuditItem | null {
  const title = boundedText(value.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const meta = boundedText(value.meta, MAX_META_CHARS);
  const reason = boundedText(value.reason, MAX_REASON_CHARS);
  const badge = boundedText(value.badge, 36);
  const id = boundedText(value.id, 96);
  const sourceCount = safeCount(value.sourceCount);
  const confidence = safeConfidence(value.confidence);
  return Object.freeze({
    ...(id ? { id } : {}),
    title,
    ...(meta ? { meta } : {}),
    ...(reason ? { reason } : {}),
    ...(badge ? { badge } : {}),
    ...(sourceCount === undefined ? {} : { sourceCount }),
    ...(confidence === undefined ? {} : { confidence }),
    status: auditStatus(value.status),
  });
}

function normaliseStage(value: IntelligenceAuditStage): IntelligenceAuditStage | null {
  if (!STAGES.some((stage) => stage.id === value.id)) return null;
  const items = (Array.isArray(value.items) ? value.items : [])
    .slice(0, MAX_ITEMS_PER_STAGE)
    .map(normaliseItem)
    .filter((item): item is IntelligenceAuditItem => item !== null);
  const summary = boundedText(value.summary, MAX_REASON_CHARS);
  const count = safeCount(value.count);
  const inputCount = safeCount(value.inputCount);
  const outputCount = safeCount(value.outputCount);
  const pendingCount = safeCount(value.pendingCount);
  const reusedCount = safeCount(value.reusedCount);
  const unit = value.unit === "pairs" || value.unit === "events" || value.unit === "series" ? value.unit : "articles";
  return Object.freeze({
    id: value.id,
    status: auditStatus(value.status),
    ...(summary ? { summary } : {}),
    ...(count === undefined ? {} : { count }),
    unit,
    ...(inputCount === undefined ? {} : { inputCount }),
    ...(outputCount === undefined ? {} : { outputCount }),
    ...(pendingCount === undefined ? {} : { pendingCount }),
    ...(reusedCount === undefined ? {} : { reusedCount }),
    ...(items.length > 0 ? { items: Object.freeze(items) } : {}),
  });
}

/** Exported so the pipeline and tests have one privacy/size boundary. */
export function normaliseIntelligenceAuditSnapshot(value: IntelligenceAuditSnapshot | null): IntelligenceAuditSnapshot | null {
  if (!value) return null;
  const stages = (Array.isArray(value.stages) ? value.stages : [])
    .map(normaliseStage)
    .filter((stage): stage is IntelligenceAuditStage => stage !== null);
  const stageMap = new Map(stages.map((stage) => [stage.id, stage]));
  const orderedStages = STAGES
    .map((stage) => stageMap.get(stage.id))
    .filter((stage): stage is IntelligenceAuditStage => stage !== undefined);
  const runId = boundedText(value.runId, 96);
  const summary = boundedText(value.summary, MAX_REASON_CHARS);
  const generatedAt = typeof value.generatedAt === "number" || typeof value.generatedAt === "string"
    ? value.generatedAt
    : undefined;
  return Object.freeze({
    ...(runId ? { runId } : {}),
    ...(summary ? { summary } : {}),
    ...(generatedAt === undefined ? {} : { generatedAt }),
    stages: Object.freeze(orderedStages),
  });
}

function requiredElement<T extends HTMLElement>(root: Document, id: string): T | null {
  return root.getElementById(id) as T | null;
}

function statusLabel(status: IntelligenceAuditStatus): string {
  return ({
    pending: "等待",
    running: "处理中",
    accepted: "通过",
    rejected: "排除",
    warning: "需核查",
    cached: "已复用",
  } as const)[status];
}

function formatSnapshotTime(value: string | number | undefined): string {
  if (typeof value === "string") return boundedText(value, 64);
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(date);
}

function stageCount(stage: IntelligenceAuditStage | undefined): number {
  return stage?.outputCount ?? stage?.count ?? stage?.items?.length ?? 0;
}

function unitLabel(stage: IntelligenceAuditStage | undefined): string {
  return stage?.unit === "pairs"
    ? "关系对"
    : stage?.unit === "events"
      ? "事件"
      : stage?.unit === "series"
        ? "系列"
        : "篇文章";
}

function stageResult(stage: IntelligenceAuditStage | undefined): string {
  const output = stageCount(stage);
  const unit = unitLabel(stage);
  const input = stage?.inputCount;
  const pending = stage?.pendingCount;
  const reused = stage?.reusedCount;
  const parts = [input === undefined ? "" : `${input} → ${output} ${unit}`, input === undefined ? `${output} ${unit}` : "", pending === undefined ? "" : `待处理 ${pending}`, reused === undefined ? "" : `复用 ${reused}`].filter(Boolean);
  return parts.join(" · ");
}

function statusForStage(stage: IntelligenceAuditStage | undefined): IntelligenceAuditStatus {
  return auditStatus(stage?.status);
}

function stageMapFor(snapshot: IntelligenceAuditSnapshot | null): Map<IntelligenceAuditStageId, IntelligenceAuditStage> {
  return new Map((snapshot?.stages ?? []).map((stage) => [stage.id, stage]));
}

function defaultStageId(snapshot: IntelligenceAuditSnapshot | null): IntelligenceAuditStageId {
  const stageMap = stageMapFor(snapshot);
  const running = STAGES.find((definition) => statusForStage(stageMap.get(definition.id)) === "running");
  if (running) return running.id;
  const finalStage = stageMap.get("final-events");
  return stageCount(finalStage) > 0 ? "final-events" : "collected";
}

function createText(root: Document, tag: string, className: string, value: string): HTMLElement {
  const element = root.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function itemFacts(item: IntelligenceAuditItem): string {
  return [
    item.badge,
    item.sourceCount === undefined ? "" : `${item.sourceCount} 个来源`,
    item.confidence === undefined ? "" : `置信 ${Math.round(item.confidence * 100)}%`,
  ].filter(Boolean).join(" · ");
}

export function installIntelligenceAuditUi(target: unknown): IntelligenceAuditGlobal | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  if (runtime.ReaderIntelligenceAudit) return runtime.ReaderIntelligenceAudit;

  let controller: IntelligenceAuditController | null = null;
  const init = (): IntelligenceAuditController | null => {
    if (controller) return controller;
    const root = runtime.document;
    const page = requiredElement<HTMLElement>(root, "intelligence-workspace-page");
    const trigger = requiredElement<HTMLButtonElement>(root, "intelligence-open-audit");
    const audit = requiredElement<HTMLElement>(root, "intelligence-audit-view");
    const closeButton = requiredElement<HTMLButtonElement>(root, "intelligence-audit-back");
    const overview = requiredElement<HTMLElement>(root, "intelligence-audit-overview");
    const flow = requiredElement<HTMLElement>(root, "intelligence-audit-flow");
    const detail = requiredElement<HTMLElement>(root, "intelligence-audit-detail");
    const standardView = requiredElement<HTMLElement>(root, "intelligence-standard-view");
    const digestHistory = requiredElement<HTMLElement>(root, "intelligence-digest-history");
    if (!page || !trigger || !audit || !closeButton || !overview || !flow || !detail || !standardView || !digestHistory) return null;

    let currentSnapshot: IntelligenceAuditSnapshot | null = null;
    let selectedStageId: IntelligenceAuditStageId = "collected";
    let userSelectedStage = false;
    let detailLimit = DETAIL_PAGE_SIZE;
    let queuedRender = false;
    let detailLoader: IntelligenceAuditDetailLoader | null = null;
    const loadedDetails = new Map<IntelligenceAuditStageId, {
      items: IntelligenceAuditItem[];
      total: number;
      loading: boolean;
      error: string;
    }>();
    const timing = (action: string, phase: string, started: number, stageId = selectedStageId, itemCount = 0): void => {
      runtime.ReaderProblemTraceUI?.recordIntelligenceAuditTiming?.(action, phase, Date.now() - started, stageId, itemCount);
    };

    const renderOverview = (): void => {
      const snapshot = currentSnapshot;
      const stageMap = stageMapFor(snapshot);
      const timestamp = formatSnapshotTime(snapshot?.generatedAt);
      const lead = root.createElement("div");
      lead.className = "intelligence-audit-overview-lead";
      const leadTitle = createText(root, "strong", "intelligence-audit-overview-title", snapshot?.summary || "等待下一批处理记录");
      const secondary = [snapshot?.runId ? `批次 ${snapshot.runId}` : "", timestamp ? `更新于 ${timestamp}` : ""]
        .filter(Boolean)
        .join(" · ");
      lead.append(leadTitle, createText(root, "span", "intelligence-audit-overview-meta", secondary || "仅记录可人工复核的流程元数据"));

      const metrics = root.createElement("div");
      metrics.className = "intelligence-audit-metrics";
      const metricDefinitions: ReadonlyArray<Readonly<{ label: string; stageId: IntelligenceAuditStageId; hint: string }>> = [
        { label: "公开输入", stageId: "collected", hint: "采集" },
        { label: "去重后", stageId: "exact-dedupe", hint: "精确去重" },
        { label: "小模型处理", stageId: "article-triage", hint: "逐篇初筛" },
        { label: "简报事件", stageId: "final-events", hint: "最终" },
        { label: "新闻系列", stageId: "series-timeline", hint: "时间线" },
      ];
      metricDefinitions.forEach((metric) => {
        const stage = stageMap.get(metric.stageId);
        const card = root.createElement("div");
        card.className = "intelligence-audit-metric";
        card.dataset.status = statusForStage(stage);
        card.append(
          createText(root, "span", "intelligence-audit-metric-label", metric.label),
          createText(root, "strong", "intelligence-audit-metric-value", String(stageCount(stage))),
          createText(root, "span", "intelligence-audit-metric-hint", `${metric.hint} · ${unitLabel(stage)}`),
        );
        metrics.append(card);
      });
      overview.replaceChildren(lead, metrics);
    };

    const renderDetail = (): void => {
      const stageMap = stageMapFor(currentSnapshot);
      const definition = STAGES.find((stage) => stage.id === selectedStageId) ?? STAGES[0]!;
      const stage = stageMap.get(definition.id);
      const status = statusForStage(stage);
      const loaded = loadedDetails.get(definition.id);
      const items = loaded?.items ?? stage?.items ?? [];
      const total = loaded?.total ?? stageCount(stage);
      const visibleItems = loaded ? items : items.slice(0, detailLimit);
      const frame = root.createElement("div");
      frame.className = "intelligence-audit-detail-frame";
      frame.dataset.status = status;

      const header = root.createElement("header");
      header.className = "intelligence-audit-detail-head";
      const titleGroup = root.createElement("div");
      titleGroup.append(
        createText(root, "span", "intelligence-audit-detail-kicker", `阶段 ${String(STAGES.indexOf(definition) + 1).padStart(2, "0")} · ${statusLabel(status)}`),
        createText(root, "h3", "intelligence-audit-detail-title", definition.label),
        createText(root, "p", "intelligence-audit-detail-purpose", definition.purpose),
      );
      const count = createText(root, "span", "intelligence-audit-detail-count", `${visibleItems.length} / ${total} ${unitLabel(stage)}`);
      header.append(titleGroup, count);
      frame.append(header);

      const summary = createText(
        root,
        "p",
        "intelligence-audit-detail-summary",
        stage?.summary || (stage ? "本阶段已记录结果；可在下方查看有限的可核查条目。" : "本轮尚未走到这个阶段。"),
      );
      frame.append(summary);

      if (visibleItems.length > 0) {
        const list = root.createElement("ol");
        list.className = "intelligence-audit-records";
        visibleItems.forEach((item) => {
          const row = root.createElement("li");
          row.className = "intelligence-audit-record";
          row.dataset.status = auditStatus(item.status);
          const rowHead = root.createElement("div");
          rowHead.className = "intelligence-audit-record-head";
          rowHead.append(createText(root, "strong", "intelligence-audit-record-title", item.title));
          const facts = itemFacts(item);
          if (facts) rowHead.append(createText(root, "span", "intelligence-audit-record-facts", facts));
          row.append(rowHead);
          if (item.meta) row.append(createText(root, "span", "intelligence-audit-record-meta", item.meta));
          if (item.reason) row.append(createText(root, "p", "intelligence-audit-record-reason", item.reason));
          list.append(row);
        });
        frame.append(list);
      } else {
        frame.append(createText(
          root,
          "p",
          "intelligence-audit-detail-empty",
          loaded?.loading ? "正在读取这一阶段的审计记录…" : loaded?.error || (stage ? "这一阶段没有需要展开的条目。" : "等待上游处理后显示。"),
        ));
      }

      if (total > visibleItems.length) {
        const more = root.createElement("button");
        more.type = "button";
        more.className = "btn-plain intelligence-audit-more";
        more.disabled = loaded?.loading === true;
        more.textContent = loaded?.loading
          ? "正在读取…"
          : `再显示 ${Math.min(DETAIL_PAGE_SIZE, total - visibleItems.length)} 条`;
        more.addEventListener("click", () => {
          if (detailLoader && currentSnapshot?.runId) void loadDetailPage(false);
          else {
            detailLimit += DETAIL_PAGE_SIZE;
            renderDetail();
          }
        });
        frame.append(more);
      }
      detail.replaceChildren(frame);
    };

    const loadDetailPage = async (reset: boolean): Promise<void> => {
      const runId = currentSnapshot?.runId;
      if (!detailLoader || !runId) return;
      const existing = loadedDetails.get(selectedStageId);
      if (existing?.loading) return;
      const state = reset || !existing
        ? { items: [] as IntelligenceAuditItem[], total: stageCount(stageMapFor(currentSnapshot).get(selectedStageId)), loading: true, error: "" }
        : { ...existing, loading: true, error: "" };
      loadedDetails.set(selectedStageId, state);
      renderDetail();
      try {
        const page = await detailLoader({ runId, stageId: selectedStageId, offset: state.items.length, limit: DETAIL_PAGE_SIZE });
        const normalisedItems = (Array.isArray(page?.items) ? page.items : [])
          .slice(0, DETAIL_PAGE_SIZE)
          .map(normaliseItem)
          .filter((item): item is IntelligenceAuditItem => item !== null);
        const total = safeCount(page?.total) ?? state.items.length + normalisedItems.length;
        loadedDetails.set(selectedStageId, {
          items: [...state.items, ...normalisedItems],
          total,
          loading: false,
          error: "",
        });
      } catch {
        loadedDetails.set(selectedStageId, { ...state, loading: false, error: "读取审计详情失败；汇总数据仍可查看。" });
      }
      renderDetail();
    };

    const renderFlow = (): void => {
      const stageMap = stageMapFor(currentSnapshot);
      const nodes = STAGES.map((definition, index) => {
        const stage = stageMap.get(definition.id);
        const status = statusForStage(stage);
        const node = root.createElement("button");
        node.type = "button";
        node.className = "intelligence-audit-flow-node";
        node.dataset.stage = definition.id;
        node.dataset.status = status;
        node.setAttribute("aria-current", definition.id === selectedStageId ? "step" : "false");
        node.append(
          createText(root, "span", "intelligence-audit-flow-index", String(index + 1).padStart(2, "0")),
          createText(root, "strong", "intelligence-audit-flow-label", definition.label),
          createText(root, "span", "intelligence-audit-flow-caption", definition.caption),
          createText(root, "span", "intelligence-audit-flow-result", `${stageResult(stage)} · ${statusLabel(status)}`),
        );
        node.addEventListener("click", () => {
          selectedStageId = definition.id;
          userSelectedStage = true;
          detailLimit = DETAIL_PAGE_SIZE;
          const started = Date.now();
          renderFlow();
          renderDetail();
          void loadDetailPage(true);
          timing("stage_select", "render", started, definition.id, stage?.items?.length ?? 0);
        });
        return node;
      });
      flow.replaceChildren(...nodes);
    };

    const render = (): void => {
      const started = Date.now();
      if (!userSelectedStage) selectedStageId = defaultStageId(currentSnapshot);
      renderOverview();
      renderFlow();
      renderDetail();
      timing("snapshot", "render", started, selectedStageId, stageMapFor(currentSnapshot).get(selectedStageId)?.items?.length ?? 0);
    };

    const open = (): void => {
      if (page.hidden) return;
      const started = Date.now();
      standardView.hidden = true;
      digestHistory.hidden = true;
      audit.hidden = false;
      trigger.setAttribute("aria-pressed", "true");
      closeButton.focus({ preventScroll: true });
      timing("audit_open", "visible", started, selectedStageId);
      const renderAfterVisible = (): void => {
        render();
        void loadDetailPage(true);
        timing("audit_open", "first_frame", started, selectedStageId, stageMapFor(currentSnapshot).get(selectedStageId)?.items?.length ?? 0);
      };
      if (runtime.requestAnimationFrame) runtime.requestAnimationFrame(() => renderAfterVisible());
      else renderAfterVisible();
    };

    const close = ({ focus = true }: { readonly focus?: boolean } = {}): void => {
      audit.hidden = true;
      digestHistory.hidden = false;
      standardView.hidden = false;
      trigger.setAttribute("aria-pressed", "false");
      if (focus) trigger.focus({ preventScroll: true });
    };

    const setSnapshot = (snapshot: IntelligenceAuditSnapshot | null): void => {
      const previousRunId = currentSnapshot?.runId;
      currentSnapshot = normaliseIntelligenceAuditSnapshot(snapshot);
      if (previousRunId !== currentSnapshot?.runId) loadedDetails.clear();
      if (!audit.hidden && !queuedRender) {
        queuedRender = true;
        const flush = (): void => { queuedRender = false; render(); };
        if (runtime.requestAnimationFrame) runtime.requestAnimationFrame(() => flush());
        else flush();
      }
    };

    const setDetailLoader = (loader: IntelligenceAuditDetailLoader | null): void => {
      detailLoader = loader;
      loadedDetails.clear();
    };

    trigger.addEventListener("click", open);
    closeButton.addEventListener("click", () => close());
    runtime.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !audit.hidden) close();
    });
    controller = Object.freeze({ open, close, setSnapshot, setDetailLoader, snapshot: () => currentSnapshot });
    return controller;
  };

  const global: IntelligenceAuditGlobal = { init };
  runtime.ReaderIntelligenceAudit = global;
  global.instance = init();
  return global;
}
