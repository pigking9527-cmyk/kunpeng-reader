/**
 * The intelligence workspace keeps the visual page in ui/index.html. This
 * controller exposes only sanitised process metadata: never article bodies,
 * URLs, local model settings, or credentials.
 *
 * Audit snapshots can be sizeable. The UI therefore renders the six-stage
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
  readonly unit?: "articles" | "pairs" | "events";
  readonly inputCount?: number;
  readonly outputCount?: number;
  readonly pendingCount?: number;
  readonly reusedCount?: number;
  readonly items?: readonly IntelligenceAuditItem[];
}

export type IntelligenceAuditStageId =
  | "collected"
  | "exact-dedupe"
  | "candidate-recall"
  | "small-model"
  | "qwen-review"
  | "final-events";

/** Narrow, in-memory hand-off from the collection/model pipeline to audit UI. */
export interface IntelligenceAuditSnapshot {
  readonly runId?: string;
  readonly generatedAt?: string | number;
  readonly summary?: string;
  readonly stages?: readonly IntelligenceAuditStage[];
}

export interface IntelligenceAuditController {
  readonly open: () => void;
  readonly close: (options?: { readonly focus?: boolean }) => void;
  readonly setSnapshot: (snapshot: IntelligenceAuditSnapshot | null) => void;
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
  { id: "candidate-recall", label: "关系候选", caption: "规则与 RAG 只找可能相关对", purpose: "这一层只召回文章关系对，不表示合并或最终事件数。" },
  { id: "small-model", label: "本机判定", caption: "先逐篇筛选，再核验关系", purpose: "逐篇判断重要性，再判断候选对是同一事件、后续进展还是无关。" },
  { id: "qwen-review", label: "Qwen 抽样复核", caption: "抽检小模型并编辑全文证据", purpose: "Qwen 对低置信和分层样本复核；通过后才编辑最终事件。" },
  { id: "final-events", label: "最终事件", caption: "可进入简报的综合报道", purpose: "这里是最终保留、排除和复用结果的出口。" },
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
  const unit = value.unit === "pairs" || value.unit === "events" ? value.unit : "articles";
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
  return stage?.unit === "pairs" ? "关系对" : stage?.unit === "events" ? "事件" : "篇文章";
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
        { label: "待核验", stageId: "small-model", hint: "小模型" },
        { label: "简报事件", stageId: "final-events", hint: "最终" },
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
      const items = stage?.items ?? [];
      const visibleItems = items.slice(0, detailLimit);
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
      const count = createText(root, "span", "intelligence-audit-detail-count", `${visibleItems.length} / ${stageCount(stage)} ${unitLabel(stage)}`);
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
        frame.append(createText(root, "p", "intelligence-audit-detail-empty", stage ? "这一阶段没有需要展开的条目。" : "等待上游处理后显示。"));
      }

      if (items.length > visibleItems.length) {
        const more = root.createElement("button");
        more.type = "button";
        more.className = "btn-plain intelligence-audit-more";
        more.textContent = `再显示 ${Math.min(DETAIL_PAGE_SIZE, items.length - visibleItems.length)} 条`;
        more.addEventListener("click", () => {
          detailLimit += DETAIL_PAGE_SIZE;
          renderDetail();
        });
        frame.append(more);
      }
      detail.replaceChildren(frame);
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
      currentSnapshot = normaliseIntelligenceAuditSnapshot(snapshot);
      if (!audit.hidden && !queuedRender) {
        queuedRender = true;
        const flush = (): void => { queuedRender = false; render(); };
        if (runtime.requestAnimationFrame) runtime.requestAnimationFrame(() => flush());
        else flush();
      }
    };

    trigger.addEventListener("click", open);
    closeButton.addEventListener("click", () => close());
    runtime.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !audit.hidden) close();
    });
    controller = Object.freeze({ open, close, setSnapshot, snapshot: () => currentSnapshot });
    return controller;
  };

  const global: IntelligenceAuditGlobal = { init };
  runtime.ReaderIntelligenceAudit = global;
  global.instance = init();
  return global;
}
