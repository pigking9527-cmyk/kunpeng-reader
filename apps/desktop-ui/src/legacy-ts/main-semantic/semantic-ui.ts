import type { SemanticStatusInput } from "../main/semantic-status-cache.js";
import {
  createSemanticPort,
  type AiCapabilityRoute,
  type AiCapabilityRoutesStatus,
  type BackgroundTaskSnapshot,
  type IntelligenceLocalModelCapabilities,
  type IntelligenceLocalModelPreflight,
  type IntelligenceLocalModelStatus,
  type LocalUnderstandingModelPreflight,
  type ReaderMediaStatus,
  type SemanticGpuStatus,
  type SemanticProgress,
  type SemanticRetrievalMode,
  type SemanticTaskCenter,
  type SemanticPort,
  type SemanticTaskItem,
} from "./semantic-port.js";
import {
  formatSemanticBytes,
  legacySemanticIndexCompleted,
  progressPercent,
  restoreLiveSemanticVectorTask,
  SEMANTIC_MODEL_DIMENSIONS,
  SEMANTIC_SEARCH_SOLUTIONS,
} from "./semantic-rules.js";
import {
  dialogsFromTauriGlobal,
  transportFromTauriGlobal,
  type TauriTransport,
  type TauriUnlisten,
} from "../../../../../packages/tauri-api/src/index.js";

type LegacyInvoke = <TResult>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<TResult>;

interface SemanticCache {
  clear(modelId?: string): void;
  get(modelId?: string): SemanticViewProgress | null;
  merge(input?: SemanticStatusInput): SemanticViewProgress;
  save(input?: SemanticStatusInput): void;
  update(patch?: SemanticStatusInput): void;
  use(modelId?: string): SemanticViewProgress | null;
}

type SemanticViewProgress = Partial<SemanticProgress> & SemanticStatusInput;

interface SemanticRuntime extends Record<string, unknown> {
  readonly localStorage?: Pick<Storage, "getItem" | "setItem">;
  readonly ReaderAppI18n?: {
    t?(key: string): string | undefined;
    apply?(root: HTMLElement | null): void;
  };
  ReaderSemanticUI?: SemanticUiGlobal;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  clearInterval(handle: number): void;
  confirm(message: string): boolean;
  setInterval(callback: () => void, milliseconds: number): number;
  setTimeout(callback: () => void, milliseconds: number): number;
}

interface AgentProfileSummary {
  readonly id: string;
  readonly name?: string;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly localLibraryAiEligible?: boolean;
}

interface AgentProfilesStatus {
  readonly assignments?: {
    readonly readingId?: string;
    readonly libraryId?: string;
    readonly otherId?: string;
  };
  readonly profiles?: readonly AgentProfileSummary[];
}

export interface SemanticUiOptions {
  readonly root?: Document;
  readonly invoke?: LegacyInvoke;
  readonly transport?: TauriTransport;
  readonly settingsModal?: HTMLElement | null;
  readonly cache?: SemanticCache;
  readonly confirmAction?: (message: string) => boolean;
}

export interface SemanticUiController {
  close(): void;
  destroy(): void;
  open(): void;
  refresh(reconcile?: boolean): Promise<void>;
  render(payload?: SemanticTaskCenter | SemanticViewProgress): void;
}

export interface SemanticUiGlobal {
  init(options?: SemanticUiOptions): SemanticUiController;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): SemanticRuntime | null {
  const runtime = record(value);
  return runtime &&
    typeof runtime.setTimeout === "function" &&
    typeof runtime.setInterval === "function"
    ? (runtime as unknown as SemanticRuntime)
    : null;
}

function isTaskCenter(
  value: SemanticTaskCenter | SemanticViewProgress,
): value is SemanticTaskCenter {
  return (
    Array.isArray((value as Partial<SemanticTaskCenter>).tasks) &&
    record((value as Partial<SemanticTaskCenter>).progress) !== null
  );
}

function semanticTransport(
  runtime: SemanticRuntime,
  invoke: LegacyInvoke,
): TauriTransport {
  let listen: TauriTransport["listen"];
  try {
    listen = transportFromTauriGlobal(runtime).listen;
  } catch {
    listen = undefined;
  }
  const transport: TauriTransport = {
    invoke: <TResult>(command: string, args?: Record<string, unknown>) =>
      invoke<TResult>(command, args),
  };
  if (listen) transport.listen = listen;
  return transport;
}

export function installSemanticUi(target: unknown): SemanticUiGlobal | null {
  const candidate = runtimeFrom(target);
  if (!candidate) return null;
  const global: SemanticRuntime = candidate;
  let activeController: SemanticUiController | null = null;

  function init(options: SemanticUiOptions = {}) {
    if (activeController) return activeController;

    const root = options.root;
    const invoke = options.invoke;
    const transport =
      options.transport ?? (invoke ? semanticTransport(global, invoke) : null);
    const port = transport ? createSemanticPort(transport) : null;
    if (!port) throw new Error("ReaderSemanticUI.init 缺少 invoke");
    const semanticPort: SemanticPort = port;
    const nativeInvoke = transport!.invoke;
    const settingsModal = options.settingsModal;
    const cache = options.cache;
    const confirmAction =
      options.confirmAction || ((message) => global.confirm(message));
    if (!root || typeof root.getElementById !== "function")
      throw new Error("ReaderSemanticUI.init 缺少 root");
    if (
      !cache ||
      typeof cache.get !== "function" ||
      typeof cache.merge !== "function"
    ) {
      throw new Error("ReaderSemanticUI.init 缺少状态缓存 API");
    }

    const document: Document = root;
    const semanticCache: SemanticCache = cache;
    const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
      document.getElementById(id) as T | null;
    const modal = el("semantic-index-modal");
    const gearButton = el("semantic-gear");
    const closeButton = el("semantic-index-close");
    const modelMeta = el("sem-model-meta");
    const libraryModelSelect = el<HTMLSelectElement>("sem-library-model-select");
    const libraryModelApply = el<HTMLButtonElement>("sem-library-model-apply");
    const modelSetupTitle = el("sem-model-setup-title");
    const modelSetupCopy = el("sem-model-setup-copy");
    const solutionButtons = SEMANTIC_SEARCH_SOLUTIONS.map((solution) => ({
      ...solution,
      element: el<HTMLButtonElement>(solution.buttonId),
    }));
    const solutionSwitch = el("sem-solution-switch");
    const solutionChoiceTitle = el("sem-solution-choice-title");
    const solutionChoiceCopy = el("sem-solution-choice-copy");
    const solutionApply = el<HTMLButtonElement>("sem-solution-apply");
    const capabilitySetup = el<HTMLButtonElement>("sem-capability-setup");
    const overviewSummary = el("sem-overview-summary");
    const deviceSummary = el("sem-device-summary");
    const semanticPrimary = el<HTMLButtonElement>("sem-semantic-primary");
    const agentPrimary = el<HTMLButtonElement>("sem-agent-primary");
    const mediaPrimary = el<HTMLButtonElement>("sem-media-primary");
    const agentAssignmentSummary = el("sem-agent-assignment-summary");
    const capabilityRouteControls = ([
      "search",
      "understanding",
      "news_preference",
      "deep_analysis",
      "companion",
    ] as const).map((capability) => ({
      capability,
      select: el<HTMLSelectElement>(`sem-route-${capability.replace("_", "-")}`),
      state: el(`sem-route-${capability.replace("_", "-")}-state`),
    }));
    const solutionStateElements = new Map(
      SEMANTIC_SEARCH_SOLUTIONS.map((solution) => [
        solution.id,
        el(`sem-solution-${solution.id === "high_precision" ? "high" : solution.id === "bge_m3" ? "m3" : solution.id}-state`),
      ]),
    );
    const vectorMeta = el("sem-vector-meta");
    const vectorGpuMeta = el("sem-vector-gpu-meta");
    const acceleratorMeta = el("sem-accel-meta");
    const multiProfileMeta = el("sem-multi-meta");
    const retrievalSection = el("sem-retrieval-section");
    const retrievalMeta = el("sem-retrieval-meta");
    const retrievalMode = el<HTMLSelectElement>("sem-retrieval-mode");
    const retrievalM3Option = el<HTMLOptionElement>("sem-retrieval-m3-option");
    const gpuMeta = el("sem-gpu-meta");
    const gpuRefreshButton = el<HTMLButtonElement>("sem-gpu-refresh");
    const gpuInstallButton = el<HTMLButtonElement>("sem-gpu-install");
    const devicePolicySelect = el<HTMLSelectElement>("sem-device-policy");
    const rerankerMeta = el("sem-reranker-meta");
    const rerankerDownloadButton = el<HTMLButtonElement>(
      "sem-reranker-download",
    );
    const rerankerDeleteButton = el<HTMLButtonElement>("sem-reranker-delete");
    const m3Meta = el("sem-m3-meta");
    const m3BuildButton = el<HTMLButtonElement>("sem-m3-build");
    const m3DeleteButton = el<HTMLButtonElement>("sem-m3-delete");
    const m3Bar = el("sem-m3-bar");
    const statusElement = el("sem-status");
    const vectorBar = el("sem-vector-bar");
    const vectorProgress = el("sem-vector-progress");
    const modelDownloadProgress = el("sem-model-download-progress");
    const modelDownloadBar = el("sem-model-download-bar");
    const modelDownloadLabel = el("sem-model-download-label");
    const modelDownloadNote = el("sem-model-download-note");
    const semanticTaskActions = el("sem-semantic-task-actions");
    const libraryPlan = el("sem-library-plan");
    const libraryCoverage = el("sem-library-coverage");
    const libraryPending = el("sem-library-pending");
    const acceleratorBar = el("sem-accel-bar");
    const multiProfileBar = el("sem-multi-bar");
    const modelDownloadButton = el<HTMLButtonElement>("sem-model-download");
    const modelDeleteButton = el<HTMLButtonElement>("sem-model-delete");
    const vectorBuildButton = el<HTMLButtonElement>("sem-vector-build");
    const vectorRebuildButton = el<HTMLButtonElement>("sem-vector-rebuild");
    const vectorPauseButton = el<HTMLButtonElement>("sem-vector-pause");
    const vectorDeleteButton = el<HTMLButtonElement>("sem-vector-delete");
    const acceleratorBuildButton = el<HTMLButtonElement>("sem-accel-build");
    const acceleratorDeleteButton = el<HTMLButtonElement>("sem-accel-delete");
    const multiProfileBuildButton = el<HTMLButtonElement>("sem-multi-build");
    const multiProfileDeleteButton = el<HTMLButtonElement>("sem-multi-delete");
    const qwen27Capability = el("sem-qwen27-capability");
    const qwen27Card = el("sem-qwen27-card");
    const qwen27Select = el<HTMLButtonElement>("sem-qwen27-select");
    const qwen27Preflight = el<HTMLButtonElement>("sem-qwen27-preflight");
    const understandingCapability = el("sem-understanding-capability");
    const understandingPreflightButton = el<HTMLButtonElement>("sem-understanding-preflight");
    const mediaStatusElement = el("sem-media-status");
    const mediaPolicy = el<HTMLSelectElement>("sem-media-policy");
    const mediaModelState = el("sem-media-model-state");
    const mediaRuntimeState = el("sem-media-runtime-state");
    const mediaHardwareState = el("sem-media-hardware-state");
    const mediaComfyState = el("sem-media-comfy-state");
    const mediaDownload = el<HTMLButtonElement>("sem-media-download");
    const mediaChooseComfy = el<HTMLButtonElement>("sem-media-choose-comfy");
    const mediaChooseWorkflow = el<HTMLButtonElement>("sem-media-choose-workflow");
    const mediaSaveComfy = el<HTMLButtonElement>("sem-media-save-comfy");
    const mediaStart = el<HTMLButtonElement>("sem-media-start");
    const mediaStop = el<HTMLButtonElement>("sem-media-stop");
    const mediaRefresh = el<HTMLButtonElement>("sem-media-refresh");
    const capabilityTabs = ["overview", "library", "models", "companion"].map((id) => ({
      id,
      button: el<HTMLButtonElement>(`sem-tab-${id}`),
    }));
    const capabilityPanels = typeof document.querySelectorAll === "function"
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-sem-panel]"))
      : [];
    const semText = (
      key: string,
      fallback: string,
      values: Readonly<Record<string, unknown>> = {},
    ) => {
      let value = global.ReaderAppI18n?.t?.(key);
      if (!value || /^⟦.+⟧$/.test(value)) value = fallback;
      return String(value).replace(
        /\{(\w+)\}/g,
        (_match: string, name: string) => String(values[name] ?? ""),
      );
    };
    const solutionPresentation = (id: string) => {
      const solution = SEMANTIC_SEARCH_SOLUTIONS.find((item) => item.id === id);
      return solution
        ? { title: solution.capabilityTitle, copy: solution.capabilityCopy }
        : undefined;
    };

    function stageSolution(id: string, snapshot: SemanticViewProgress | null = semanticCache.get()) {
      const solution = SEMANTIC_SEARCH_SOLUTIONS.find((item) => item.id === id);
      if (!solution) return;
      stagedSolutionId = id;
      const presentation = solutionPresentation(id);
      if (solutionChoiceTitle) solutionChoiceTitle.textContent = presentation?.title || id;
      if (solutionChoiceCopy) solutionChoiceCopy.textContent = presentation?.copy || "";
      solutionButtons.forEach((item) =>
        item.element?.classList.toggle("staged", item.id === id),
      );
      const unchanged =
        snapshot?.model_id === solution.modelId &&
        snapshot?.retrieval_mode === solution.retrievalMode;
      const switching = !!snapshot?.solution_switching;
      if (solutionApply) {
        solutionApply.disabled =
          !!unchanged ||
          switching ||
          solutionSwitchRequestInFlight ||
          !!snapshot?.model_downloading ||
          !!snapshot?.reranker_loading;
        // 即使当前选中的仍是旧的服务方案，也要把后台构建明确展示出来；
        // 否则“当前正在使用”会掩盖已经生效的切换请求，造成按钮无响应的错觉。
        solutionApply.textContent = switching
          ? "正在建立新搜索库"
          : unchanged
            ? "当前正在使用"
            : "应用并切换搜索库";
      }
    }
    // 与 Rust 模型定义的向量维度保持一致；切换提示与模型说明都从这里读取，
    // 让用户能判断不同模型建立索引时的向量规格。
    const MODEL_DIMENSIONS = SEMANTIC_MODEL_DIMENSIONS;

    let pollTimer: number | null = null;
    let statusInFlight = false;
    let visible = false;
    let gpuStatus: Partial<SemanticGpuStatus> | null = null;
    let gpuInstallRunning = false;
    let gpuRefreshInFlight = false;
    let gpuProgressUnlisten: TauriUnlisten | null = null;
    let stagedSolutionId = "";
    // 方案命令只负责排队后台独立建库。用这一小段前端状态覆盖 invoke 返回
    // 与首次状态轮询之间的空窗，避免按钮看上去像没有执行。
    let solutionSwitchRequestInFlight = false;
    let intelligenceCapabilities: IntelligenceLocalModelCapabilities | null = null;
    let intelligenceStatus: IntelligenceLocalModelStatus | null = null;
    let intelligencePreflight: IntelligenceLocalModelPreflight | null = null;
    let localUnderstandingPreflight: LocalUnderstandingModelPreflight | null = null;
    let intelligenceRefreshInFlight = false;
    let localUnderstandingRefreshInFlight = false;
    let readerMediaStatus: ReaderMediaStatus | null = null;
    let mediaRefreshInFlight = false;
    let mediaConfigInFlight = false;
    let mediaInstallStarting = false;
    let mediaInstallPollTimer: number | null = null;
    let selectedComfyUiRoot = "";
    let selectedComfyWorkflow = "";
    let capabilityRoutes: AiCapabilityRoutesStatus | null = null;
    let agentProfiles: AgentProfilesStatus | null = null;
    let capabilityRoutesRefreshing = false;
    const capabilityRouteSaving = new Set<string>();
    const visibleLibraryModelChoices = new Set([
      "qwen3-embedding-0.6b",
      "qwen3-embedding-8b",
      "bge-m3",
    ]);
    const listeners: Array<() => void> = [];

    function selectCapabilityTab() {
      // 智能管理已收敛为单页三模型视图；保留旧变量仅为了兼容已加载的
      // 运行时和测试，不再将任何模型区块按页签隐藏。
      capabilityTabs.forEach(({ button }) => button?.setAttribute("aria-selected", "false"));
      capabilityPanels.forEach((panel) => { panel.hidden = false; });
      if (visible) void refreshWorkspace();
    }

    function on(
      element: HTMLElement | null,
      eventName: string,
      handler: EventListener,
    ) {
      if (!element) return;
      element.addEventListener(eventName, handler);
      listeners.push(() => element.removeEventListener(eventName, handler));
    }

    function setProgressBar(
      bar: HTMLElement | null,
      done: number,
      total: number,
      ready: boolean,
    ) {
      const percent = progressPercent(done, total);
      if (!bar) return;
      bar.style.width = percent + "%";
      bar.parentElement?.classList.toggle("done", !!ready);
    }

    function formatBytes(bytes: number) {
      return formatSemanticBytes(bytes);
    }

    // 老版本已经落盘的加速/画像索引没有当前强校验元数据，不能直接拿来查询，
    // 但在界面上不能伪装成“从未建立”。用满进度明确表示已有完成产物，按钮
    // 则保留“更新”语义，避免把旧数据误认成当前可用索引。
    function legacyCompleted(
      taskItem: SemanticTaskItem | null,
      total: number,
      bytes: number,
    ) {
      return legacySemanticIndexCompleted(taskItem, total, bytes);
    }

    function setStatus(text = "", kind = "") {
      if (!statusElement) return;
      statusElement.textContent = text ? `当前任务：${text}` : "当前任务：暂无后台任务";
      statusElement.className = "ai-status" + (kind ? " " + kind : "");
    }

    function task(center: SemanticTaskCenter | null, id: string) {
      return Array.isArray(center?.tasks)
        ? center.tasks.find((item) => item.id === id)
        : null;
    }

    function updatePolling(shouldPoll: boolean) {
      if (visible && shouldPoll && !pollTimer) {
        // 构建结束时 Rust 会清除旧的状态缓存；轮询必须请求一次后台核对，
        // 否则轻量快照会回退到 0/总数，把刚完成或可续建的索引误显示为“尚未建立”。
        // 后端在任务仍运行时不会启动逐书扫描，因此这里不会与编码争用磁盘。
        pollTimer = global.setInterval(() => {
          void refresh(true);
        }, 1500);
      } else if ((!visible || !shouldPoll) && pollTimer) {
        global.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function routeModeLabel(mode: AiCapabilityRoute["mode"]): string {
      return ({
        auto: "自动",
        local: "本机",
        intelligence_host: "我的情报主机",
        cloud: "云端",
        off: "关闭",
      } as const)[mode];
    }

    function routeCapabilityLabel(capability: AiCapabilityRoute["capability"]): string {
      return ({
        search: "智能搜索",
        understanding: "智读与书库",
        news_preference: "资讯偏好",
        deep_analysis: "深度理解",
        companion: "伴读",
      } as const)[capability];
    }

    function routeModeAllowed(route: AiCapabilityRoute, mode: AiCapabilityRoute["mode"]): boolean {
      return ({
        auto: route.allowAuto,
        local: route.allowLocal,
        intelligence_host: route.allowIntelligenceHost,
        cloud: route.allowCloud,
        off: route.allowOff,
      } as const)[mode];
    }

    function renderCapabilityRoutes() {
      const byCapability = new Map(
        (capabilityRoutes?.routes || []).map((route) => [route.capability, route]),
      );
      capabilityRouteControls.forEach(({ capability, select, state }) => {
        const route = byCapability.get(capability);
        if (!select || !state) return;
        if (!route) {
          select.disabled = true;
          state.textContent = capabilityRoutesRefreshing ? "正在读取…" : "暂时不可用";
          return;
        }
        select.value = route.mode;
        select.disabled = capabilityRouteSaving.has(capability);
        const options = (select as unknown as {
          querySelectorAll?: (selector: string) => Iterable<HTMLOptionElement>;
        }).querySelectorAll?.("option");
        if (options) {
          for (const option of options) {
            option.disabled = !routeModeAllowed(route, option.value as AiCapabilityRoute["mode"]);
          }
        }
        state.textContent = routeModeAllowed(route, route.mode)
          ? `当前：${routeModeLabel(route.mode)}`
          : route.unavailableReason || "当前处理方式不可用";
        state.classList.toggle("error", !routeModeAllowed(route, route.mode));
      });
      if (capabilitySetup) {
        capabilitySetup.disabled = capabilityRoutesRefreshing || capabilityRouteSaving.size > 0;
        capabilitySetup.textContent = capabilityRoutesRefreshing
          ? "正在读取设备状态…"
          : "准备基础智能搜索";
      }
    }

    function profileRunsLocally(profile: AgentProfileSummary): boolean {
      if (profile.localLibraryAiEligible) return true;
      try {
        const hostname = new URL(profile.baseUrl || "").hostname.toLowerCase();
        return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
      } catch {
        return false;
      }
    }

    function profileLabel(id: string | undefined): string {
      if (!id) return "尚未分配";
      const profile = (agentProfiles?.profiles || []).find((item) => item.id === id);
      if (!profile) return "尚未分配";
      const name = profile.name || profile.model || "未命名模型";
      return profileRunsLocally(profile) ? `${name}（本机）` : `${name}（云端）`;
    }

    function renderAgentProfiles() {
      const assignments = agentProfiles?.assignments;
      if (agentAssignmentSummary) {
        agentAssignmentSummary.textContent = agentProfiles
          ? `智读：${profileLabel(assignments?.readingId)}　·　书库问答：${profileLabel(assignments?.libraryId)}　·　其它：${profileLabel(assignments?.otherId)}`
          : "尚未配置 Agent。可添加本机或云端模型，再分别分配给智读、书库问答和其它任务。";
      }
      renderAgentPrimary();
    }

    function renderSmartOverview(progress: SemanticViewProgress | null = semanticCache.get()) {
      const gpu = gpuStatus?.detected
        ? `${gpuStatus.name || "GPU"}${gpuStatus.total_vram_mib ? ` · ${Math.round(gpuStatus.total_vram_mib / 1024)}GB 显存` : ""}`
        : "GPU 正在检测";
      const ram = readerMediaStatus?.totalRamMib
        ? ` · ${Math.round(readerMediaStatus.totalRamMib / 1024)}GB 内存`
        : " · 内存正在检测";
      if (deviceSummary) deviceSummary.textContent = `设备状态：${gpu}${ram}`;
      if (!overviewSummary) return;
      const semantic = progress?.model_ready
        ? "语义模型已就绪"
        : "语义模型待准备";
      const enhanced = intelligenceCapabilities?.models?.some((item) => item.selectable);
      const media = readerMediaStatus?.hardwareSupported ? "H3 可配置" : "H3 已跳过";
      overviewSummary.textContent = `推荐方案：${semantic} · 基础 Agent${enhanced ? " + 增强 Agent 可选" : ""} · ${media}`;
    }

    function renderSemanticPrimary(progress: SemanticViewProgress, refreshing = false) {
      if (!semanticPrimary) return;
      const activeTask = String(progress.active_task || "");
      const vectorActive = !!progress.building && activeTask === "semantic_vectors";
      const vectorDone = Number(progress.semantic_done || 0);
      const vectorTotal = Number(progress.semantic_total || 0);
      if (progress.model_downloading) {
        semanticPrimary.textContent = "正在下载语义模型…";
        semanticPrimary.disabled = true;
      } else if (!progress.model_supported) {
        semanticPrimary.textContent = "此设备无法准备语义模型";
        semanticPrimary.disabled = true;
      } else if (!progress.model_ready) {
        semanticPrimary.textContent = "下载语义模型 · 约 610 MB";
        semanticPrimary.disabled = !!refreshing;
      } else if (vectorActive) {
        semanticPrimary.textContent = progress.vector_pause_requested ? "正在暂停建立…" : "暂停建立";
        semanticPrimary.disabled = !!progress.vector_pause_requested;
      } else {
        semanticPrimary.textContent = vectorDone > 0 && vectorDone < vectorTotal
          ? "继续建立搜索库"
          : progress.semantic_ready
            ? "更新新增内容"
            : "建立语义搜索库";
        semanticPrimary.disabled = !!refreshing || !vectorTotal;
      }
    }

    function renderAgentPrimary() {
      if (!agentPrimary) return;
      const localProfile = (agentProfiles?.profiles || []).some(profileRunsLocally);
      const localNeedsCheck = localProfile &&
        (!localUnderstandingPreflight || !localUnderstandingPreflight.serviceReady);
      agentPrimary.textContent = localNeedsCheck ? "检查 Agent 服务" : "配置 Agent";
      agentPrimary.disabled = localUnderstandingRefreshInFlight;
    }

    function renderMediaPrimary() {
      if (!mediaPrimary) return;
      const status = readerMediaStatus;
      const installing = mediaInstallStarting || status?.installationState === "queued" || status?.installationState === "running";
      const canUse = !mediaRefreshInFlight && status?.hardwareSupported === true;
      mediaPrimary.hidden = !canUse;
      if (!canUse) return;
      mediaPrimary.disabled = installing || !!status?.runtimeReady;
      mediaPrimary.textContent = installing
        ? `正在${status?.installationStep || "配置"}…`
        : status?.modelReady && !status.runtimeReady
          ? "启动本地 H3"
          : status?.runtimeReady
            ? "H3 正在运行"
            : "配置 H3";
    }

    async function refreshAgentProfiles() {
      try {
        agentProfiles = await nativeInvoke<AgentProfilesStatus>("ai_reader_profiles");
        if (agentAssignmentSummary) agentAssignmentSummary.classList.remove("error");
        renderAgentProfiles();
      } catch (error) {
        agentProfiles = null;
        if (agentAssignmentSummary) {
          agentAssignmentSummary.textContent = `读取 Agent 配置失败：${String(error)}`;
          agentAssignmentSummary.classList.add("error");
        }
      }
      renderSmartOverview();
    }

    function openAgentCloudConfiguration() {
      // 使用唯一既有的安全 API 编辑器；密钥字段只在这次编辑中存在，保存后由
      // 原生安全存储保护，智能管理自身不读取或保留 API Key。
      modal?.classList.remove("show");
      visible = false;
      updatePolling(false);
      settingsModal?.classList.add("show");
      el("api-settings-modal")?.setAttribute("data-agent-config-mode", "true");
      el<HTMLButtonElement>("api-settings-open")?.click();
    }

    async function refreshCapabilityRoutes() {
      if (capabilityRoutesRefreshing) return;
      capabilityRoutesRefreshing = true;
      renderCapabilityRoutes();
      try {
        capabilityRoutes = await semanticPort.capabilityRoutes();
      } catch (error) {
        setStatus(`读取智能能力设置失败：${error}`, "error");
      } finally {
        capabilityRoutesRefreshing = false;
        renderCapabilityRoutes();
      }
    }

    // 当前单页三模型界面不再主动请求旧的“能力路由”面板；保留其读写边界，
    // 让已保存的配置和 API 编辑器仍可复用，而不是复制第二套配置实现。
    void refreshCapabilityRoutes;

    async function saveCapabilityRoute(
      capability: AiCapabilityRoute["capability"],
      mode: AiCapabilityRoute["mode"],
    ) {
      const existing = capabilityRoutes?.routes.find((route) => route.capability === capability);
      if (!existing || !routeModeAllowed(existing, mode)) {
        setStatus(existing?.unavailableReason || "该处理方式尚不可用", "error");
        renderCapabilityRoutes();
        return;
      }
      if (existing.mode === mode) return;
      capabilityRouteSaving.add(capability);
      renderCapabilityRoutes();
      try {
        capabilityRoutes = await semanticPort.saveCapabilityRoute({ capability, mode });
        setStatus(`${routeCapabilityLabel(capability)}已改为${routeModeLabel(mode)}。`, "ok");
      } catch (error) {
        setStatus(`保存智能能力设置失败：${error}`, "error");
      } finally {
        capabilityRouteSaving.delete(capability);
        renderCapabilityRoutes();
      }
    }

    async function prepareThisDevice() {
      if (capabilityRouteSaving.size) return;
      if (!confirmAction(
        "将使用推荐的 Qwen3 Embedding 0.6B（首次下载约 610 MB），随后建立本机语义搜索库。不会下载 27B 或 H3，除非设备检测通过且你另行确认。是否开始？",
      )) return;
      capabilityRouteSaving.add("setup");
      setStatus("正在按推荐方案准备语义模型…", "busy");
      try {
        await selectSemanticModel(
          "qwen3-embedding-0.6b",
          "Qwen3 Embedding 0.6B",
          "standard",
        );
        const latest = await semanticPort.tasks(true);
        if (!latest.progress.model_ready) {
          await semanticPort.downloadModel();
          setStatus("已选择推荐语义模型，正在下载；下载完成后可继续建立搜索库。", "busy");
        } else if (latest.progress.semantic_total > 0) {
          await semanticPort.buildVectors();
          setStatus("已按推荐方案开始建立语义搜索库。", "busy");
        } else {
          setStatus("推荐语义模型已就绪；书库中暂时没有可建立索引的内容。", "ok");
        }
        await refresh(true);
      } catch (error) {
        setStatus(`按推荐方案配置未完成：${error}`, "error");
      } finally {
        capabilityRouteSaving.delete("setup");
        render(semanticCache.get() || {});
      }
    }

    function render(payload: SemanticTaskCenter | SemanticViewProgress = {}) {
      const center = isTaskCenter(payload) ? payload : null;
      let progress: SemanticViewProgress = center
        ? { ...center.progress }
        : { ...payload };
      progress = semanticCache.merge(progress);
      const busy = !!(
        progress.building ||
        progress.model_downloading ||
        progress.reranker_loading
      );
      const refreshing = !!progress.status_refreshing;
      // 后端正在后台校验时优先展示同一模型上次确认过的快照；没有可靠快照时
      // 展示保守的 0/总数，绝不根据元数据文件名猜测为全部完成。
      const taskSource = refreshing && semanticCache.get() ? null : center;
      const modelTask = task(taskSource, "semantic_model");
      const vectorTask = task(taskSource, "semantic_vectors");
      const acceleratorTask = task(taskSource, "semantic_accelerator");
      const multiProfileTask = task(taskSource, "semantic_multi_profile");
      const activeTask = progress.active_task || "";
      const vectorLive =
        progress.building &&
        (activeTask === "semantic_vectors" ||
          activeTask === "semantic_full" ||
          (!activeTask && !progress.shard_total));
      // 逐书状态还在核对时，0/总数只代表“尚未读取完成”，不是“尚未建立”。
      // 不显示旧缓存或保守的 0，等核对结果回到后再展示未建立、可续建或完成。
      const vectorStatusChecking = refreshing && !vectorLive;
      const vectorDone = vectorLive
        ? progress.done || 0
        : progress.semantic_done || 0;
      const vectorTotal = vectorLive
        ? progress.total || 0
        : progress.semantic_total || 0;
      const acceleratorDone = progress.accelerator_done || 0;
      const acceleratorTotal = progress.accelerator_total || 0;
      const multiProfileDone = progress.multi_profile_done || 0;
      const multiProfileTotal = progress.multi_profile_total || 0;
      const legacyAccelerator = legacyCompleted(
        acceleratorTask,
        acceleratorTotal,
        Number(progress.accelerator_bytes || 0),
      );
      const legacyMultiProfile = legacyCompleted(
        multiProfileTask,
        multiProfileTotal,
        Number(progress.multi_profile_bytes || 0),
      );
      const activeModel = String(
        progress.model_id || libraryModelSelect?.value || "bge-small-zh-v1.5",
      ) as keyof typeof SEMANTIC_MODEL_DIMENSIONS;
      const modelPresentation = {
        "bge-small-zh-v1.5": {
          title: semText(
            "semSmallTitle",
            "Light semantic search · BGE Small Chinese",
          ),
          copy: semText(
            "semSmallCopy",
            "The default lightweight Chinese semantic model.",
          ),
          dimensions: MODEL_DIMENSIONS["bge-small-zh-v1.5"],
          downloadBytes: 95 * 1024 * 1024,
          downloadEstimate: "95 MB",
        },
        "bge-large-zh-v1.5": {
          title: semText(
            "semLargeTitle",
            "High-precision semantic search · BGE Large Chinese",
          ),
          copy: semText(
            "semLargeCopy",
            "A higher-precision Chinese semantic model.",
          ),
          dimensions: MODEL_DIMENSIONS["bge-large-zh-v1.5"],
          downloadBytes: 1.3 * 1024 * 1024 * 1024,
          downloadEstimate: "1.3 GB",
        },
        "bge-m3": {
          title: semText(
            "semM3Title",
            "BGE-M3 · Multilingual hybrid retrieval",
          ),
          copy: semText(
            "semM3Copy",
            "Supports dense, sparse, and ColBERT representations.",
          ),
          dimensions: MODEL_DIMENSIONS["bge-m3"],
          downloadBytes: 2.8 * 1024 * 1024 * 1024,
          downloadEstimate: "2.8 GB",
        },
        "multilingual-e5-small": {
          title: semText(
            "semE5Title",
            "Multilingual-E5-Small · Lightweight multilingual retrieval",
          ),
          copy: semText(
            "semE5Copy",
            "A lightweight multilingual semantic model.",
          ),
          dimensions: MODEL_DIMENSIONS["multilingual-e5-small"],
          downloadBytes: 450 * 1024 * 1024,
          downloadEstimate: "450 MB",
        },
        "qwen3-embedding-0.6b": {
          title: semText("semQwen06Title", "Qwen3 Embedding 0.6B · Multilingual standard"),
          copy: semText("semQwen06Copy", "Balanced multilingual meaning search for mixed Chinese and English content."),
          dimensions: MODEL_DIMENSIONS["qwen3-embedding-0.6b"],
          downloadBytes: 639_150_592,
          downloadEstimate: "610 MB",
        },
        "qwen3-embedding-8b": {
          title: semText("semQwen8Title", "Qwen3 Embedding 8B · High-precision multilingual"),
          copy: semText("semQwen8Copy", "Higher-precision multilingual meaning search with the installed 0.6B reranker."),
          dimensions: MODEL_DIMENSIONS["qwen3-embedding-8b"],
          downloadBytes: 4_676_804_928,
          downloadEstimate: "4.4 GB",
        },
      }[activeModel];
      const supportsM3Hybrid = activeModel === "bge-m3";
      const activePlan = SEMANTIC_SEARCH_SOLUTIONS.find(
        (solution) =>
          solution.modelId === activeModel && solution.retrievalMode === progress.retrieval_mode,
      );
      const activePlanName = activePlan
        ? activePlan.capabilityTitle
        : semText("semCustomSolution", "自定义");
      if (!stagedSolutionId && activePlan) stagedSolutionId = activePlan.id;
      const pendingModelId = String(progress.pending_model_id || "");
      const pendingRetrievalMode = String(progress.pending_retrieval_mode || "");
      const pendingPlan = SEMANTIC_SEARCH_SOLUTIONS.find(
        (solution) =>
          solution.modelId === pendingModelId &&
          solution.retrievalMode === pendingRetrievalMode,
      );
      const pendingPlanName = pendingPlan
        ? pendingPlan.capabilityTitle
        : progress.pending_model_label || pendingModelId;
      if (libraryPlan)
        libraryPlan.textContent = `当前能力：${activePlanName}`;
      if (libraryCoverage)
        libraryCoverage.textContent = semText(
          "semCoverageBooks",
          "Analyzed: {done}/{total} books",
          { done: vectorDone, total: vectorTotal },
        );
      if (libraryPending)
        libraryPending.textContent = semText(
          "semPendingBooks",
          "Pending: {count} books",
          { count: Math.max(0, vectorTotal - vectorDone) },
        );
      if (solutionSwitch) {
        const switching = !!progress.solution_switching && !!pendingModelId;
        solutionSwitch.hidden = !switching;
        solutionSwitch.classList.remove("error");
        if (switching) {
          const done = Math.max(0, Number(progress.done || 0));
          const total = Math.max(0, Number(progress.total || 0));
          const percent = total ? Math.min(100, Math.round((done * 100) / total)) : 0;
          solutionSwitch.textContent = total
            ? `正在建立：${pendingPlanName} · ${done}/${total} · ${percent}%。当前智能搜索继续可用。`
            : `正在建立：${pendingPlanName}。当前智能搜索继续可用。`;
        }
      }
      const retrievalPresentation: Record<SemanticRetrievalMode, string> = {
        standard: semText(
          "semRetrievalStandardCopy",
          "Faster: combines keyword and semantic results.",
        ),
        high_precision: semText(
          "semRetrievalHighCopy",
          "More accurate: fuses results and reranks the best content.",
        ),
        m3_hybrid: semText(
          "semRetrievalM3Copy",
          "Broader coverage for keywords, meaning, and multilingual terms.",
        ),
      };

      if (modelSetupTitle && modelPresentation) {
        modelSetupTitle.textContent =
          modelPresentation.title +
          " · " +
          semText("semVectorDimensions", "{dimensions} dimensions", {
            dimensions: modelPresentation.dimensions,
          });
      }
      if (modelSetupCopy && modelPresentation)
        modelSetupCopy.textContent = modelPresentation.copy;

      if (libraryModelSelect && progress.model_id) {
        const activeLibraryChoice = visibleLibraryModelChoices.has(progress.model_id)
          ? progress.model_id
          : "qwen3-embedding-0.6b";
        libraryModelSelect.value = activeLibraryChoice;
      }
      solutionButtons.forEach((solution) => {
        const { id, modelId, retrievalMode: solutionMode, element } = solution;
        if (!element) return;
        const selected = modelId === activeModel && solutionMode === progress.retrieval_mode;
        const pending =
          !!progress.solution_switching &&
          modelId === pendingModelId &&
          solutionMode === pendingRetrievalMode;
        element.classList.toggle("selected", selected);
        element.classList.toggle("staged", stagedSolutionId === id);
        element.classList.toggle("pending", pending);
        element.setAttribute("aria-pressed", String(selected));
        element.setAttribute("aria-busy", String(pending));
        // 方案卡只承担“查看并选择”的职责；后台建库不再让全部卡片静默失效。
        // 真正无法运行的硬件能力才会禁用，CPU 可回退的模型仍保持可选。
        element.disabled = false;
        const stateElement = solutionStateElements.get(id);
        if (stateElement) {
          stateElement.classList.remove("warn", "blocked");
          if (selected) stateElement.textContent = "当前使用";
          else if (pending) {
            stateElement.textContent = "正在准备";
            stateElement.classList.add("warn");
          } else if ((id === "high_precision" || id === "bge_m3") && gpuStatus?.runtime_ready) {
            stateElement.textContent = "硬件加速就绪";
          } else if (id === "high_precision" && !gpuStatus?.runtime_ready) {
            stateElement.textContent = "可用 · 软件加速未就绪";
            stateElement.classList.add("warn");
          } else if (id === "bge_m3" && !gpuStatus?.runtime_ready) {
            stateElement.textContent = "可用 · 软件加速未就绪";
            stateElement.classList.add("warn");
          } else if (!progress.model_ready && modelId === activeModel) {
            stateElement.textContent = "首次使用需准备";
            stateElement.classList.add("warn");
          } else stateElement.textContent = "可选择";
        }
      });
      if (stagedSolutionId) stageSolution(stagedSolutionId, progress);

      const modelLabel = progress.model_label
        ? progress.model_label + " · "
        : "";
      const modelDownloadTotal = Number(modelPresentation?.downloadBytes || 0);
      const modelDownloaded = Math.max(0, Number(progress.model_bytes || 0));
      const modelDownloadPercent = modelDownloadTotal
        ? Math.min(99, Math.floor((modelDownloaded * 100) / modelDownloadTotal))
        : 0;
      const modelDownloadText =
        modelDownloaded > 0 && modelDownloadTotal > 0
          ? semText(
              "semModelDownloadProgress",
              "Downloading model: {percent}% ({downloaded}/{total})",
              {
                percent: modelDownloadPercent,
                downloaded: formatBytes(
                  Math.min(modelDownloaded, modelDownloadTotal),
                ),
                total: modelPresentation.downloadEstimate,
              },
            )
          : semText("semModelDownloading", "Downloading/loading model…");
      if (modelMeta) {
        modelMeta.textContent = !progress.model_supported
          ? modelLabel +
            semText(
              "semModelUnsupported",
              "ONNX weights are not available for local use.",
            )
          : progress.model_downloading
            ? modelLabel + modelDownloadText
            : progress.model_ready
              ? modelLabel + semText("semModelReady", "Ready")
              : modelLabel +
                semText(
                  "semModelNotDownloaded",
                  "Not downloaded; first download is about {size}.",
                  { size: modelPresentation?.downloadEstimate || "—" },
                );
      }
      // 模型文件下载和逐书建库是两个独立任务。旧界面用已完成的搜索库进度
      // 覆盖模型下载状态，造成“781/781、100% 但仍在下载”的误导。
      if (modelDownloadProgress) {
        const hasByteProgress = modelDownloaded > 0 && modelDownloadTotal > 0;
        modelDownloadProgress.hidden = !progress.model_downloading;
        if (modelDownloadLabel) {
          modelDownloadLabel.textContent = hasByteProgress
            ? `正在下载语义模型：${modelDownloadPercent}% · ${formatBytes(Math.min(modelDownloaded, modelDownloadTotal))}/${modelPresentation?.downloadEstimate || "—"}`
            : "正在准备语义模型下载…";
        }
        if (modelDownloadNote) {
          modelDownloadNote.textContent = hasByteProgress
            ? modelDownloaded >= modelDownloadTotal
              ? "模型文件已就绪，正在启动并核对本机语义服务。"
              : "下载可续传；完成模型准备后才能开始建立搜索库。"
            : "正在连接下载器；收到文件大小后会显示百分比。";
        }
        setProgressBar(
          modelDownloadBar,
          hasByteProgress ? Math.min(modelDownloaded, modelDownloadTotal) : 0,
          hasByteProgress ? modelDownloadTotal : 0,
          false,
        );
      }
      const hasSemanticIndex =
        vectorLive || vectorDone > 0 || !!progress.semantic_ready;
      if (vectorMeta) {
        vectorMeta.textContent = vectorStatusChecking
          ? semText("semCheckingIndex", "Checking semantic-index progress…")
          : vectorLive && !vectorTotal
            ? semText("semTaskRunning", "Task is running in the background…")
            : !hasSemanticIndex
              ? semText("semNotBuilt", "Not built")
              : vectorTotal
                ? semText("semProgressBooks", "{done}/{total} books", {
                    done: vectorDone,
                    total: vectorTotal,
                  }) +
                  (progress.semantic_ready
                    ? `, ${semText("semCompleted", "completed")}`
                    : "")
                : semText(
                    "semNoBooks",
                    "There are no books available for semantic indexing.",
                  );
      }
      // runtime_ready 是对 CUDA Provider 的实际注册检测；仅在正在向量化时提示，
      // 不把“GPU 硬件存在”误说成当前索引已经由 GPU 加速。
      const gpuIndexing =
        vectorLive && String(gpuStatus?.active_model_device || "").startsWith("cuda");
      if (vectorGpuMeta) {
        vectorGpuMeta.hidden = !gpuIndexing;
        vectorGpuMeta.textContent = gpuIndexing
          ? semText("semGpuIndexing", "GPU-accelerated indexing in progress.")
          : "";
      }
      if (acceleratorMeta) {
        const acceleratorDescription = semText(
          "semAcceleratorDescription",
          "Returns results faster for large libraries with a semantic index.",
        );
        const acceleratorProgress = semText(
          "semProgressParts",
          "{done}/{total} parts",
          { done: acceleratorDone, total: acceleratorTotal },
        );
        acceleratorMeta.textContent = legacyAccelerator
          ? semText(
              "semLegacyIndex",
              "Built with an older index; update it to use the current algorithm.",
            )
          : acceleratorTotal
            ? acceleratorProgress +
              (progress.accelerator_ready
                ? `, ${semText("semCompleted", "completed")}`
                : progress.accelerator_resumable
                  ? `, ${semText("semCanResume", "can resume")}`
                  : "") +
              ` · ${acceleratorDescription}`
            : acceleratorDescription;
      }
      if (multiProfileMeta) {
        const multiProfileDescription = semText(
          "semMultiProfileDescription",
          "Classifies topics in a book for better cross-topic results.",
        );
        const multiProfileProgress = semText(
          "semProgressBooks",
          "{done}/{total} books",
          { done: multiProfileDone, total: multiProfileTotal },
        );
        multiProfileMeta.textContent = legacyMultiProfile
          ? semText(
              "semLegacyIndex",
              "Built with an older index; update it to use the current algorithm.",
            )
          : multiProfileTotal
            ? multiProfileProgress +
              (progress.multi_profile_ready
                ? `, ${semText("semCompleted", "completed")}`
                : multiProfileDone
                  ? `, ${semText("semUpdateNeeded", "needs update")}`
                  : "") +
              ` · ${multiProfileDescription}`
            : multiProfileDescription;
      }
      if (gpuMeta && !gpuInstallRunning) {
        const activeDeviceLabel = String(
          gpuStatus?.active_model_device_label || "",
        ).trim();
        const hardwareMessage = activeDeviceLabel
          ? semText("semActiveDevice", "Current model is actually running on {device}.", {
              device: activeDeviceLabel,
            }) + (gpuStatus?.message ? ` ${gpuStatus.message}` : "")
          : gpuStatus?.message ||
            semText(
              "semGpuInitial",
              "Select Recheck to read the local running device.",
            );
        gpuMeta.textContent = hardwareMessage;
        gpuMeta.title = hardwareMessage;
      }
      renderSmartOverview(progress);
      if (devicePolicySelect && gpuStatus?.device_policy) {
        devicePolicySelect.value = gpuStatus.device_policy;
      }
      if (devicePolicySelect)
        devicePolicySelect.disabled = busy || gpuRefreshInFlight;
      if (gpuInstallButton) {
        gpuInstallButton.hidden =
          !gpuStatus?.runtime_install_available || !!gpuStatus?.runtime_ready;
        gpuInstallButton.disabled = gpuInstallRunning;
        gpuInstallButton.textContent = gpuInstallRunning
          ? semText("semInstallingGpuRuntime", "Installing GPU component…")
          : semText("semInstallGpuRuntime", "Load local CUDA component");
      }
      if (retrievalSection) retrievalSection.hidden = false;
      if (retrievalM3Option) {
        retrievalM3Option.hidden = !supportsM3Hybrid;
        retrievalM3Option.disabled = !supportsM3Hybrid;
      }
      if (retrievalMode && progress.retrieval_mode) {
        retrievalMode.value =
          supportsM3Hybrid || progress.retrieval_mode !== "m3_hybrid"
            ? progress.retrieval_mode
            : "standard";
      }
      const selectedRetrievalMode = String(
        retrievalMode?.value || progress.retrieval_mode || "standard",
      ) as SemanticRetrievalMode;
      if (retrievalMeta)
        retrievalMeta.textContent =
          retrievalPresentation[selectedRetrievalMode] ||
          retrievalPresentation.standard;
      if (rerankerMeta)
        rerankerMeta.textContent = progress.reranker_loading
          ? semText(
              "semRerankerLoading",
              "Preparing the reranker automatically. It reranks candidate content so citations are more accurate.",
            )
          : progress.reranker_ready || progress.reranker_downloaded
            ? semText(
                "semRerankerReady",
                "Ready. It loads automatically when high-precision retrieval calls it, then reranks candidate content for more accurate citations.",
              )
            : progress.reranker_partial
              ? semText(
                  "semRerankerPartial",
                  "Download incomplete. Continue downloading to prepare the reranker for high-precision retrieval.",
                )
              : semText(
                  "semRerankerNotDownloaded",
                  "Not downloaded. Download the reranker before using high-precision retrieval.",
                );
      if (m3Meta)
        m3Meta.textContent = supportsM3Hybrid
          ? progress.m3_index_ready
            ? semText(
                "semM3Ready",
                "Ready. Complex questions are easier to find.",
              )
            : semText(
                "semM3BuildHint",
                "Build it to balance keywords and meaning.",
              )
          : semText("semM3Only", "Available only when BGE-M3 is selected.");
      const m3Section = el("sem-m3-index-section");
      if (m3Section) m3Section.hidden = !supportsM3Hybrid;
      setProgressBar(
        m3Bar,
        progress.m3_index_done || 0,
        progress.m3_index_total || 0,
        !!progress.m3_index_ready,
      );

      if (vectorProgress)
        vectorProgress.hidden =
          !!progress.model_downloading || vectorStatusChecking || !hasSemanticIndex;
      setProgressBar(
        vectorBar,
        vectorTask?.done ?? vectorDone,
        vectorTask?.total ?? vectorTotal,
        vectorTask?.ready ?? !!progress.semantic_ready,
      );
      setProgressBar(
        acceleratorBar,
        legacyAccelerator ? 1 : (acceleratorTask?.done ?? acceleratorDone),
        legacyAccelerator ? 1 : (acceleratorTask?.total ?? acceleratorTotal),
        legacyAccelerator ||
          (acceleratorTask?.ready ?? !!progress.accelerator_ready),
      );
      setProgressBar(
        multiProfileBar,
        legacyMultiProfile ? 1 : (multiProfileTask?.done ?? multiProfileDone),
        legacyMultiProfile ? 1 : (multiProfileTask?.total ?? multiProfileTotal),
        legacyMultiProfile ||
          (multiProfileTask?.ready ?? !!progress.multi_profile_ready),
      );

      if (libraryModelSelect) libraryModelSelect.disabled = busy;
      const usesSharedQwenModels = activeModel.startsWith("qwen3-embedding-");
      if (modelDownloadButton) {
        modelDownloadButton.hidden =
          !!progress.model_downloading || !!progress.model_ready || !progress.model_supported;
        modelDownloadButton.disabled =
          !!progress.model_ready ||
          !progress.model_supported ||
          (modelTask ? !modelTask.can_start : busy || refreshing);
      }
      if (modelDeleteButton) {
        // Qwen3 权重与情报中心共用，不能从阅读器里单独删除；按产品规则把
        // 永远不能执行的操作隐藏，而不是留一个无说明的灰色按钮。
        modelDeleteButton.hidden =
          usesSharedQwenModels || !progress.model_ready || busy;
        modelDeleteButton.disabled =
          usesSharedQwenModels ||
          !progress.model_supported ||
          (modelTask ? !modelTask.can_delete : busy || !progress.model_ready);
      }
      if (modelDeleteButton)
        modelDeleteButton.title = usesSharedQwenModels
          ? "Qwen3 模型与情报中心共用，请在高级模型管理中统一清理"
          : "";
      if (vectorBuildButton)
        vectorBuildButton.disabled =
          vectorStatusChecking ||
          busy ||
          (vectorTask
            ? !vectorTask.can_start
            : !progress.model_ready || !vectorTotal);
      if (vectorRebuildButton)
        vectorRebuildButton.disabled =
          vectorStatusChecking || busy || !progress.model_ready || !vectorTotal;
      const vectorPauseAvailable =
        progress.building && activeTask === "semantic_vectors";
      if (vectorPauseButton) {
        vectorPauseButton.hidden = !vectorPauseAvailable;
        vectorPauseButton.disabled =
          !vectorPauseAvailable || !!progress.vector_pause_requested;
      }
      const vectorDeleteAvailable =
        !progress.model_downloading &&
        !progress.building &&
        !vectorStatusChecking &&
        (vectorTask ? !!vectorTask.can_delete : vectorDone > 0);
      if (vectorDeleteButton) {
        vectorDeleteButton.hidden = !vectorDeleteAvailable;
        vectorDeleteButton.disabled =
          vectorStatusChecking ||
          (vectorTask ? !vectorTask.can_delete : busy || vectorDone <= 0);
      }
      if (semanticTaskActions) {
        semanticTaskActions.hidden =
          !vectorPauseAvailable && !vectorDeleteAvailable;
      }
      if (acceleratorBuildButton)
        acceleratorBuildButton.disabled = acceleratorTask
          ? !acceleratorTask.can_start
          : busy || !progress.model_ready || vectorDone <= 0;
      if (acceleratorDeleteButton)
        acceleratorDeleteButton.disabled = acceleratorTask
          ? !acceleratorTask.can_delete
          : busy || (!progress.accelerator_ready && acceleratorDone <= 0);
      if (multiProfileBuildButton)
        multiProfileBuildButton.disabled = multiProfileTask
          ? !multiProfileTask.can_start
          : busy || vectorDone <= 0;
      if (multiProfileDeleteButton)
        multiProfileDeleteButton.disabled = multiProfileTask
          ? !multiProfileTask.can_delete
          : busy || !progress.multi_profile_bytes;
      if (retrievalMode) retrievalMode.disabled = busy;
      if (rerankerDownloadButton) {
        rerankerDownloadButton.hidden = !!progress.reranker_downloaded;
        rerankerDownloadButton.disabled =
          busy || !!progress.reranker_downloaded;
        rerankerDownloadButton.textContent = progress.reranker_partial
          ? semText("semResumeReranker", "Resume reranker download")
          : semText("semDownloadReranker", "Download reranker");
      }
      if (rerankerDeleteButton)
        rerankerDeleteButton.disabled =
          usesSharedQwenModels ||
          busy ||
          (!progress.reranker_downloaded && !progress.reranker_partial);
      if (m3BuildButton)
        m3BuildButton.disabled =
          busy || !supportsM3Hybrid || !progress.model_ready;
      if (m3DeleteButton)
        m3DeleteButton.disabled = busy || !progress.m3_index_done;
      if (modelDownloadButton)
        modelDownloadButton.textContent = semText(
          "semDownloadModel",
          "Download model",
        );
      if (modelDeleteButton)
        modelDeleteButton.textContent = semText("semDelete", "Delete");
      if (vectorBuildButton)
        vectorBuildButton.textContent =
          vectorDone > 0 && !progress.semantic_ready
            ? semText("semResumeIndex", "Continue analyzing local content")
            : semText("semUpdateLocalContent", "Update new and changed content");
      if (vectorRebuildButton)
        vectorRebuildButton.textContent = semText(
          "semRebuildAll",
          "Reanalyze all",
        );
      if (vectorPauseButton)
        vectorPauseButton.textContent = semText("semPause", "Pause");
      if (vectorDeleteButton)
        vectorDeleteButton.textContent = semText(
          "semClearSearchData",
          "Clear search data",
        );
      if (acceleratorBuildButton)
        acceleratorBuildButton.textContent = legacyAccelerator
          ? semText("semUpdateAccelerator", "Update large-library acceleration")
          : semText("semBuildAccelerator", "Enable large-library acceleration");
      if (acceleratorDeleteButton)
        acceleratorDeleteButton.textContent = semText(
          "semClearAcceleratorData",
          "Clear acceleration data",
        );
      if (multiProfileBuildButton)
        multiProfileBuildButton.textContent = semText(
          "semBuildMulti",
          "Build multi-profile index",
        );
      if (multiProfileDeleteButton)
        multiProfileDeleteButton.textContent = semText(
          "semClearMultiData",
          "Clear profile data",
        );
      if (m3DeleteButton)
        m3DeleteButton.textContent = semText(
          "semClearM3Data",
          "Clear deep-retrieval data",
        );

      if (progress.error) setStatus(progress.error, "error");
      else if (progress.model_downloading)
        setStatus(
          modelDownloaded > 0 && modelDownloadTotal > 0
            ? `正在下载语义模型 · ${modelDownloadPercent}% · ${formatBytes(Math.min(modelDownloaded, modelDownloadTotal))}/${modelPresentation?.downloadEstimate || "—"}`
            : "正在准备语义模型下载…",
          "busy",
        );
      else if (progress.building || progress.reranker_loading)
        setStatus(
          progress.building && vectorTotal
            ? `正在更新语义搜索库 · ${vectorDone}/${vectorTotal} · ${progressPercent(vectorDone, vectorTotal)}%`
            : semText("semTaskRunning", "Task is running in the background…"),
          "busy",
        );
      else setStatus(progress.current ? "本机智能方案已更新。" : "", progress.current ? "ok" : "");

      renderSemanticPrimary(progress, refreshing);

      updatePolling(
        !!(
          progress.model_downloading ||
          progress.building ||
          progress.reranker_loading ||
          refreshing
        ),
      );
      // provisional 状态只用于立即渲染，不能成为下一次打开时的“可靠快照”。
      if (!refreshing) {
        semanticCache.save(progress);
      }
    }

    // 语义状态页的轻量快照可能正处于重新核对阶段，但通用任务注册表会在每次
    // 编码批次后持久化。以它为最终兜底，避免弹窗关闭再打开时误放开重复建立。
    function restoreLiveVectorTask(
      center: SemanticTaskCenter,
      snapshots: readonly BackgroundTaskSnapshot[],
    ) {
      const cachedTotal = Number(
        semanticCache.get(center.progress.model_id)?.semantic_total || 0,
      );
      return restoreLiveSemanticVectorTask(center, snapshots, cachedTotal);
    }

    async function refresh(reconcile = false) {
      if (statusInFlight) return;
      statusInFlight = true;
      try {
        if (reconcile)
          setStatus(
            semText(
              "semReadingStatus",
              "Checking index status in the background…",
            ),
            "busy",
          );
        const [center, taskSnapshots] = await Promise.all([
          semanticPort.tasks(reconcile),
          semanticPort.backgroundTasks(),
        ]);
        render(restoreLiveVectorTask(center, taskSnapshots));
      } catch (error) {
        setStatus(
          semText(
            "semReadStatusFailed",
            "Could not read semantic-index status: {error}",
            { error },
          ),
          "error",
        );
      } finally {
        statusInFlight = false;
      }
    }

    async function refreshGpuStatus() {
      if (!gpuMeta || gpuRefreshInFlight || gpuInstallRunning) return;
      gpuRefreshInFlight = true;
      gpuMeta.textContent = semText("semCheckingGpu", "Detecting local GPU…");
      if (gpuRefreshButton) gpuRefreshButton.disabled = true;
      try {
        gpuStatus = await semanticPort.gpuStatus();
        render(semanticCache.get() || {});
      } catch (error) {
        gpuStatus = {
          message: semText("semGpuFailed", "Could not detect GPU: {error}", {
            error,
          }),
        };
        render(semanticCache.get() || {});
      } finally {
        gpuRefreshInFlight = false;
        if (gpuRefreshButton) gpuRefreshButton.disabled = false;
      }
    }

    function renderIntelligenceModel() {
      const option = intelligenceCapabilities?.models?.[0];
      const gpu = intelligenceCapabilities?.gpu;
      const showEnhancedAgent = !intelligenceRefreshInFlight && !!option?.selectable;
      if (qwen27Card) qwen27Card.hidden = !showEnhancedAgent;
      if (qwen27Capability) {
        if (intelligenceRefreshInFlight) {
          qwen27Capability.textContent = "正在检测显卡与本机模型状态…";
        } else if (intelligencePreflight) {
          const ready = intelligencePreflight.hardwareReady && intelligencePreflight.serviceReady;
          qwen27Capability.textContent = intelligencePreflight.message;
          qwen27Capability.classList.toggle("error", !ready);
        } else if (!option) {
          qwen27Capability.textContent = "未取得千问 27B 的本机能力信息";
        } else if (!option.selectable) {
          qwen27Capability.textContent = `超过硬件能力 · ${option.reason}`;
          qwen27Capability.classList.add("error");
        } else {
          qwen27Capability.classList.remove("error");
          const total = gpu?.totalVramMib ?? 0;
          const free = gpu?.freeVramMib ?? 0;
          const reclaim = free < option.requiredTotalVramMib
            ? " · 启动时会先暂停受管 GPU 模型释放显存"
            : " · 当前可直接启动";
          const configured = intelligenceStatus?.configured
            ? ` · 已配置 ${intelligenceStatus.model}`
            : " · 尚未配置";
          qwen27Capability.textContent = `${option.artifact} · ${gpu?.name || "NVIDIA GPU"} · 总显存 ${total} MiB / 当前空闲 ${free} MiB${reclaim}${configured}`;
        }
      }
      if (qwen27Select) {
        qwen27Select.hidden = !showEnhancedAgent;
        qwen27Select.disabled = intelligenceRefreshInFlight || !option?.selectable;
        qwen27Select.textContent = option?.selectable
          ? intelligenceStatus?.configured
            ? "已选择千问 27B"
            : "选择千问 27B"
          : "超过硬件能力";
      }
      if (qwen27Preflight) qwen27Preflight.hidden = !showEnhancedAgent;
      renderSmartOverview();
    }

    function renderLocalUnderstandingModel() {
      if (!understandingCapability) {
        renderAgentPrimary();
        return;
      }
      if (localUnderstandingRefreshInFlight) {
        understandingCapability.textContent = "正在检查本机 7B/8B 理解模型服务…";
        understandingCapability.classList.remove("error");
      } else if (!localUnderstandingPreflight) {
        understandingCapability.textContent = "尚未检查本机 7B/8B 理解模型";
        understandingCapability.classList.remove("error");
      } else {
        const ready = localUnderstandingPreflight.local && localUnderstandingPreflight.serviceReady;
        const model = localUnderstandingPreflight.model
          ? ` · ${localUnderstandingPreflight.model}`
          : "";
        understandingCapability.textContent = `${localUnderstandingPreflight.message}${model}`;
        understandingCapability.classList.toggle("error", !ready);
      }
      if (understandingPreflightButton) {
        understandingPreflightButton.disabled = localUnderstandingRefreshInFlight;
      }
      renderAgentPrimary();
    }

    async function refreshLocalUnderstandingModel() {
      if (localUnderstandingRefreshInFlight) return;
      localUnderstandingRefreshInFlight = true;
      renderLocalUnderstandingModel();
      try {
        localUnderstandingPreflight = await semanticPort.localUnderstandingPreflight();
      } catch (error) {
        localUnderstandingPreflight = null;
        if (understandingCapability) {
          understandingCapability.textContent = `本机 7B/8B 理解模型检查失败：${error}`;
          understandingCapability.classList.add("error");
        }
      } finally {
        localUnderstandingRefreshInFlight = false;
        renderLocalUnderstandingModel();
      }
    }

    async function refreshIntelligenceModel() {
      if (intelligenceRefreshInFlight) return;
      intelligenceRefreshInFlight = true;
      renderIntelligenceModel();
      try {
        [intelligenceCapabilities, intelligenceStatus] = await Promise.all([
          semanticPort.intelligenceCapabilities(),
          semanticPort.intelligenceStatus(),
        ]);
      } catch (error) {
        if (qwen27Capability) {
          qwen27Capability.textContent = `本机模型检测失败：${error}`;
          qwen27Capability.classList.add("error");
        }
      } finally {
        intelligenceRefreshInFlight = false;
        renderIntelligenceModel();
        render(semanticCache.get() || {});
      }
    }

    function renderReaderMediaStatus() {
      const status = readerMediaStatus;
      if (mediaStatusElement) {
        mediaStatusElement.textContent = mediaRefreshInFlight
          ? "正在检测本机 MiniMax-H3 模型、服务与硬件…"
          : status && !status.hardwareSupported
            ? "此电脑不满足本地 H3 的运行条件，已跳过安装。"
            : status?.message || "尚未取得本机 MiniMax-H3 状态";
        mediaStatusElement.classList.toggle(
          "error",
          !mediaRefreshInFlight && !!status && !status.hardwareSupported,
        );
      }
      if (mediaModelState) {
        mediaModelState.textContent = status?.modelReady
          ? `模型：已配置 ${status.selectedPreset || "H3/GGUF"} · ${status.modelId}`
          : `模型：未发现可用 H3/GGUF 权重${status?.modelId ? ` · ${status.modelId}` : ""}`;
      }
      if (mediaRuntimeState) {
        mediaRuntimeState.textContent = status?.runtimeReady
          ? `服务：已启动 · ${status.runtimeDevice || "本机"}`
          : "服务：未启动";
      }
      if (mediaHardwareState) {
        const disk = status?.requiredDiskMib
          ? ` · 磁盘 ${Math.round((status.availableDiskMib || 0) / 1024)}/${Math.round(status.requiredDiskMib / 1024)} GiB`
          : "";
        mediaHardwareState.textContent = status
          ? `硬件：${status.hardwareSupported ? "可运行" : "已跳过本地 H3"} · 内存 ${status.totalRamMib}/${status.requiredRamMib} MiB · 显存 ${status.totalVramMib}/${status.requiredVramMib} MiB${disk}`
          : "硬件：正在检测";
        mediaHardwareState.classList.toggle("error", !!status && !status.hardwareSupported);
      }
      if (mediaComfyState) {
        const root = selectedComfyUiRoot ? ` · 已选目录：${selectedComfyUiRoot.split(/[\\/]/u).filter(Boolean).at(-1)}` : "";
        const workflow = selectedComfyWorkflow ? ` · 已选工作流：${selectedComfyWorkflow.split(/[\\/]/u).filter(Boolean).at(-1)}` : "";
        const installRoot = status?.installationRoot
          ? ` · 安装位置：${status.installationRoot.split(/[\\/]/u).filter(Boolean).at(-1)}`
          : "";
        mediaComfyState.textContent = status?.configured
          ? `ComfyUI/GGUF：已配置${status.comfyUiReady ? " · ComfyUI 已连接" : " · 等待启动"}${installRoot}${root}${workflow}`
          : `ComfyUI/GGUF：尚未配置${installRoot}${root}${workflow}`;
      }
      if (mediaDownload) {
        const installing = mediaInstallStarting || status?.installationState === "queued" || status?.installationState === "running";
        const mayInstall = !mediaRefreshInFlight && status?.hardwareSupported === true;
        mediaDownload.hidden = !mayInstall;
        mediaDownload.disabled = !mayInstall || installing;
        mediaDownload.textContent = installing
          ? `正在${status?.installationStep || "配置"}…`
          : status?.installationState === "ready"
            ? "重新配置 H3"
            : "一键配置 H3";
      }
      if (mediaChooseComfy) mediaChooseComfy.disabled = mediaRefreshInFlight || mediaConfigInFlight;
      if (mediaChooseWorkflow) mediaChooseWorkflow.disabled = mediaRefreshInFlight || mediaConfigInFlight;
      if (mediaSaveComfy) {
        mediaSaveComfy.disabled = mediaRefreshInFlight || mediaConfigInFlight || !selectedComfyUiRoot || !selectedComfyWorkflow;
        mediaSaveComfy.textContent = mediaConfigInFlight ? "正在验证本机配置…" : "保存本机配置";
      }
      if (mediaStart)
        mediaStart.disabled = mediaRefreshInFlight || !status?.hardwareSupported || !status?.modelReady || !!status?.runtimeReady;
      if (mediaStop)
        mediaStop.disabled = mediaRefreshInFlight || !status?.runtimeReady;
      if (mediaRefresh) mediaRefresh.disabled = mediaRefreshInFlight;
      renderMediaPrimary();
      renderSmartOverview();
    }

    async function refreshReaderMediaStatus() {
      if (mediaRefreshInFlight) return;
      mediaRefreshInFlight = true;
      renderReaderMediaStatus();
      try {
        readerMediaStatus = await semanticPort.readerMediaStatus();
      } catch (error) {
        readerMediaStatus = null;
        if (mediaStatusElement) mediaStatusElement.textContent = `读取本机 MiniMax-H3 状态失败：${error}`;
      } finally {
        mediaRefreshInFlight = false;
        renderReaderMediaStatus();
      }
    }

    // 每个工作区只在用户实际打开时才读取它所需的本机状态。模型探测和 H3
    // 检测可能触发较慢的硬件/服务检查，不能在弹窗打开时和搜索库状态一起排队。
    async function refreshWorkspace() {
      await Promise.all([
        refresh(true),
        refreshGpuStatus(),
        refreshLocalUnderstandingModel(),
        refreshIntelligenceModel(),
        refreshReaderMediaStatus(),
        refreshAgentProfiles(),
      ]);
    }

    function stopReaderMediaInstallPolling() {
      if (mediaInstallPollTimer === null) return;
      globalThis.clearTimeout(mediaInstallPollTimer);
      mediaInstallPollTimer = null;
    }

    function pollReaderMediaInstallStatus() {
      stopReaderMediaInstallPolling();
      const poll = async () => {
        await refreshReaderMediaStatus();
        const state = readerMediaStatus?.installationState;
        if (state === "queued" || state === "running") {
          mediaInstallPollTimer = global.setTimeout(() => { void poll(); }, 1500);
          return;
        }
        mediaInstallPollTimer = null;
      };
      mediaInstallPollTimer = global.setTimeout(() => { void poll(); }, 500);
    }

    async function chooseComfyUiRoot() {
      try {
        const picked = await dialogsFromTauriGlobal(global).open({
          title: "选择已安装的 ComfyUI 文件夹",
          directory: true,
          multiple: false,
        });
        if (!picked || Array.isArray(picked)) return;
        selectedComfyUiRoot = picked;
        renderReaderMediaStatus();
      } catch (error) {
        setStatus(`无法打开 ComfyUI 文件夹选择器：${error}`, "error");
      }
    }

    async function chooseComfyWorkflow() {
      try {
        const picked = await dialogsFromTauriGlobal(global).open({
          title: "选择 MiniMax-H3 ComfyUI API 工作流 JSON",
          multiple: false,
          filters: [{ name: "ComfyUI API 工作流", extensions: ["json"] }],
        });
        if (!picked || Array.isArray(picked)) return;
        selectedComfyWorkflow = picked;
        renderReaderMediaStatus();
      } catch (error) {
        setStatus(`无法打开 ComfyUI 工作流选择器：${error}`, "error");
      }
    }

    async function saveComfyUiConfiguration() {
      if (!selectedComfyUiRoot || !selectedComfyWorkflow || mediaConfigInFlight) return;
      mediaConfigInFlight = true;
      renderReaderMediaStatus();
      setStatus("正在验证本机 ComfyUI/GGUF 目录与 API 工作流…", "busy");
      try {
        readerMediaStatus = await semanticPort.configureReaderMediaComfyUi({
          comfyUiRoot: selectedComfyUiRoot,
          workflowPath: selectedComfyWorkflow,
        });
        setStatus("本机 ComfyUI/GGUF 已保存；模型与服务仍只在本机运行。", "ok");
      } catch (error) {
        setStatus(`保存 ComfyUI/GGUF 配置失败：${error}`, "error");
      } finally {
        mediaConfigInFlight = false;
        renderReaderMediaStatus();
      }
    }

    async function installGpuRuntime() {
      if (!gpuStatus?.runtime_install_available || gpuInstallRunning) return;
      gpuInstallRunning = true;
      render(semanticCache.get() || {});
      if (gpuMeta)
        gpuMeta.textContent = semText(
          "semGpuDownloading",
          "Scanning and loading the local CUDA component…",
        );
      try {
        await semanticPort.installGpuRuntime();
        await refreshGpuStatus();
      } catch (error) {
        gpuStatus = {
          ...(gpuStatus || {}),
          message: semText(
            "semGpuInstallFailed",
            "GPU component installation failed: {error}",
            { error },
          ),
        };
      } finally {
        gpuInstallRunning = false;
        render(semanticCache.get() || {});
      }
    }
    function open() {
      modal?.classList.add("show");
      visible = true;
      if (mediaPolicy) {
        try {
          const storage = (global as SemanticRuntime & { readonly localStorage?: Storage }).localStorage;
          mediaPolicy.value = storage?.getItem("readerMediaPolicyV1") || "suggest";
        } catch {
          mediaPolicy.value = "suggest";
        }
      }
      const cached = semanticCache.get();
      if (cached) render(cached);
      else render({});
      void refreshWorkspace();
    }

    function close() {
      visible = false;
      modal?.classList.remove("show");
      stopReaderMediaInstallPolling();
      updatePolling(false);
      settingsModal?.classList.add("show");
    }

    async function run(
      operation: () => Promise<null>,
      startingText: string,
      failureText: string,
      afterSuccess?: (() => void) | null,
    ) {
      setStatus(startingText, "busy");
      try {
        await operation();
        if (afterSuccess) afterSuccess();
        await refresh();
      } catch (error) {
        setStatus(failureText + error, "error");
      }
    }

    async function pauseCurrentVectorBuildBeforeSwitch() {
      const snapshot = semanticCache.get();
      if (!snapshot?.building || snapshot.active_task !== "semantic_vectors") return;
      setStatus("正在暂停当前分析，以便切换搜索方案…", "busy");
      await semanticPort.pauseVectors();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const center = await semanticPort.tasks(false);
        render(center);
        if (!center.progress.building) return;
        await new Promise<void>((resolve) => global.setTimeout(resolve, 250));
      }
      throw new Error("当前分析尚未暂停，请稍后再次应用所选方案");
    }

    async function selectSemanticModel(
      next: string,
      label: string,
      targetRetrievalMode?: SemanticRetrievalMode,
    ) {
      const snapshot = semanticCache.get();
      const current = snapshot?.model_id || "bge-small-zh-v1.5";
      if (!next) return;
      const modelChanges = next !== current;
      const retrievalChanges =
        !!targetRetrievalMode &&
        targetRetrievalMode !== semanticCache.get()?.retrieval_mode;
      if (!modelChanges && !retrievalChanges) return;
      if (snapshot?.solution_switching || solutionSwitchRequestInFlight) {
        const pendingLabel = snapshot?.pending_model_label || "新搜索库";
        setStatus(
          `正在后台建立 ${pendingLabel}；旧搜索库仍可使用。请等待完成或失败后再切换。`,
          "busy",
        );
        render(snapshot ?? undefined);
        return;
      }
      if (libraryModelSelect) libraryModelSelect.disabled = true;
      if (libraryModelApply) libraryModelApply.disabled = true;
      if (solutionApply) solutionApply.disabled = true;
      setStatus(`正在准备“${label}”的本地搜索库…`, "busy");
      try {
        solutionSwitchRequestInFlight = true;
        semanticCache.update({
          building: true,
          active_task: "semantic_solution",
          solution_switching: true,
          pending_model_id: next,
          pending_model_label: label,
          pending_retrieval_mode:
            targetRetrievalMode || snapshot?.retrieval_mode || "standard",
          current: `正在准备“${label}”；当前智能搜索继续服务…`,
          error: "",
        });
        render(semanticCache.get() || {});
        await pauseCurrentVectorBuildBeforeSwitch();
        await semanticPort.selectSolution(
          next,
          targetRetrievalMode ||
            semanticCache.get()?.retrieval_mode ||
            "standard",
        );
        await refresh(true);
        const switching = !!semanticCache.get()?.solution_switching;
        setStatus(
          switching
            ? `正在后台准备“${label}”；当前智能搜索继续可用。`
            : `“${label}”已可用于智能搜索。`,
          switching ? "busy" : "ok",
        );
      } catch (error) {
        // select_semantic_solution 在尚未真正入队时也可能失败（例如模型
        // 不可用或已有 pending 方案）。撤回前端的乐观 busy 快照，避免
        // 失败后页面永久停在“正在建立新搜索库”。
        semanticCache.update({
          building: !!snapshot?.building,
          active_task: snapshot?.active_task || "",
          solution_switching: !!snapshot?.solution_switching,
          pending_model_id: snapshot?.pending_model_id || "",
          pending_model_label: snapshot?.pending_model_label || "",
          pending_retrieval_mode: snapshot?.pending_retrieval_mode || "",
          current: snapshot?.current || "",
          error: String(error),
        });
        if (libraryModelSelect) libraryModelSelect.value = current;
        setStatus("切换搜索方案失败：" + error, "error");
      } finally {
        solutionSwitchRequestInFlight = false;
        if (libraryModelSelect) libraryModelSelect.disabled = false;
        if (libraryModelApply) libraryModelApply.disabled = false;
        render(semanticCache.get() || {});
      }
    }

    on(gearButton, "click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    on(closeButton, "click", close);
    on(modal, "click", (event) => {
      if (event.target === modal) close();
    });
    on(semanticPrimary, "click", () => {
      const snapshot = semanticCache.get() || {};
      const activeTask = String(snapshot.active_task || "");
      if (snapshot.model_downloading) return;
      if (!snapshot.model_ready) {
        void run(
          () => semanticPort.downloadModel(),
          "正在下载语义模型…",
          "下载语义模型失败：",
        );
      } else if (snapshot.building && activeTask === "semantic_vectors") {
        void run(
          () => semanticPort.pauseVectors(),
          "正在暂停语义搜索库建立…",
          "暂停语义搜索库失败：",
        );
      } else {
        void run(
          () => semanticPort.buildVectors(),
          "正在建立语义搜索库…",
          "建立语义搜索库失败：",
        );
      }
    });
    on(agentPrimary, "click", () => {
      const localProfile = (agentProfiles?.profiles || []).some(profileRunsLocally);
      const localNeedsCheck = localProfile &&
        (!localUnderstandingPreflight || !localUnderstandingPreflight.serviceReady);
      if (localNeedsCheck) void refreshLocalUnderstandingModel();
      else openAgentCloudConfiguration();
    });
    on(mediaPrimary, "click", () => {
      if (readerMediaStatus?.modelReady && !readerMediaStatus.runtimeReady) {
        mediaStart?.click();
      } else if (!readerMediaStatus?.runtimeReady) {
        mediaDownload?.click();
      }
    });
    const profilesChanged = () => { void refreshAgentProfiles(); };
    global.addEventListener("ai-reader-profiles-changed", profilesChanged);
    listeners.push(() => global.removeEventListener("ai-reader-profiles-changed", profilesChanged));
    on(modelDownloadButton, "click", () =>
      run(
        () => semanticPort.downloadModel(),
        "正在启动模型下载…",
        "启动模型下载失败：",
      ),
    );
    on(modelDeleteButton, "click", async () => {
      if (
        !confirmAction(
          "确定删除本机语义模型缓存？之后使用语义检索需要重新下载模型。",
        )
      )
        return;
      await run(
        () => semanticPort.deleteModel(),
        "正在删除模型…",
        "删除模型失败：",
        () => semanticCache.update({ model_ready: false, model_bytes: 0 }),
      );
    });
    capabilityTabs.forEach(({ button }) => {
      on(button, "click", () => selectCapabilityTab());
    });
    on(libraryModelApply, "click", async () => {
      if (!libraryModelSelect) return;
      const next = libraryModelSelect.value;
      const label = libraryModelSelect.selectedOptions?.[0]?.textContent?.trim() || next;
      const mode: SemanticRetrievalMode = next === "bge-m3"
        ? "m3_hybrid"
        : next === "qwen3-embedding-8b"
          ? "high_precision"
          : "standard";
      await selectSemanticModel(next, label, mode);
    });
    solutionButtons.forEach(({ id, element }) => {
      on(element, "click", () => {
        stageSolution(id);
        setStatus("已选择方案；点击“应用并切换搜索库”开始。", "ok");
      });
    });
    on(solutionApply, "click", async () => {
      const solution = SEMANTIC_SEARCH_SOLUTIONS.find((item) => item.id === stagedSolutionId);
      if (!solution) return;
      const presentation = solutionPresentation(solution.id);
      try {
        await selectSemanticModel(
          solution.modelId,
          presentation?.title || solution.modelId,
          solution.retrievalMode as SemanticRetrievalMode,
        );
      } catch (error) {
        setStatus(`应用搜索方案失败：${error}`, "error");
        render(semanticCache.get() || {});
      }
    });
    on(capabilitySetup, "click", () => { void prepareThisDevice(); });
    capabilityRouteControls.forEach(({ capability, select }) => {
      on(select, "change", () => {
        const mode = select?.value as AiCapabilityRoute["mode"];
        if (select) void saveCapabilityRoute(capability, mode);
      });
    });
    on(qwen27Select, "click", async () => {
      const option = intelligenceCapabilities?.models?.[0];
      if (!option?.selectable) return;
      if (qwen27Select) qwen27Select.disabled = true;
      setStatus("正在保存千问 27B 本机模型配置…", "busy");
      try {
        intelligencePreflight = null;
        intelligenceStatus = await semanticPort.saveIntelligenceModel({
          baseUrl: "http://127.0.0.1:8080/v1",
          model: option.id,
          apiKey: "",
        });
        setStatus("千问 27B 已设为本机理解与总结模型。", "ok");
      } catch (error) {
        setStatus(`选择千问 27B 失败：${error}`, "error");
      } finally {
        renderIntelligenceModel();
        render(semanticCache.get() || {});
      }
    });
    on(qwen27Preflight, "click", async () => {
      if (qwen27Preflight) qwen27Preflight.disabled = true;
      setStatus("正在检查本机千问 27B 的显卡与服务…", "busy");
      try {
        intelligencePreflight = await semanticPort.intelligencePreflight();
        renderIntelligenceModel();
        setStatus(
          intelligencePreflight.message,
          intelligencePreflight.hardwareReady && intelligencePreflight.serviceReady ? "ok" : "error",
        );
      } catch (error) {
        setStatus(`本机千问 27B 检查失败：${error}`, "error");
      } finally {
        if (qwen27Preflight) qwen27Preflight.disabled = false;
        renderIntelligenceModel();
      }
    });
    on(understandingPreflightButton, "click", async () => {
      setStatus("正在检查本机 7B/8B 理解模型服务…", "busy");
      await refreshLocalUnderstandingModel();
      const preflight = localUnderstandingPreflight;
      if (preflight) {
        setStatus(
          preflight.message,
          preflight.local && preflight.serviceReady ? "ok" : "error",
        );
      }
    });
    on(mediaDownload, "click", async () => {
      if (mediaInstallStarting) return;
      mediaInstallStarting = true;
      renderReaderMediaStatus();
      if (mediaStatusElement) mediaStatusElement.textContent = "正在创建阅读器目录并启动 H3 一键配置；会自动选择适合本机显卡的量化档…";
      try {
        readerMediaStatus = await semanticPort.installReaderMediaModel();
        setStatus(
          readerMediaStatus.installationState === "ready"
            ? "MiniMax-H3 本地环境已就绪。"
            : "MiniMax-H3 正在后台下载和配置；可关闭此窗口，完成后再点击“启动本地服务”。",
          readerMediaStatus.installationState === "failed" ? "error" : "busy",
        );
        if (readerMediaStatus.installationState === "queued" || readerMediaStatus.installationState === "running") {
          pollReaderMediaInstallStatus();
        }
      } catch (error) {
        const message = `MiniMax-H3 一键配置未启动：${error}`;
        if (mediaStatusElement) mediaStatusElement.textContent = message;
        setStatus(message, "error");
      } finally {
        mediaInstallStarting = false;
        renderReaderMediaStatus();
      }
    });
    on(mediaChooseComfy, "click", () => { void chooseComfyUiRoot(); });
    on(mediaChooseWorkflow, "click", () => { void chooseComfyWorkflow(); });
    on(mediaSaveComfy, "click", () => { void saveComfyUiConfiguration(); });
    on(mediaStart, "click", async () => {
      if (mediaStart) mediaStart.disabled = true;
      setStatus("正在启动本机 MiniMax-H3 服务…", "busy");
      try {
        readerMediaStatus = await semanticPort.startReaderMediaRuntime();
        setStatus("MiniMax-H3 本机服务已启动。", "ok");
      } catch (error) {
        setStatus(`启动 MiniMax-H3 本机服务失败：${error}`, "error");
      } finally {
        renderReaderMediaStatus();
      }
    });
    on(mediaStop, "click", async () => {
      if (mediaStop) mediaStop.disabled = true;
      setStatus("正在停止本机 MiniMax-H3 服务…", "busy");
      try {
        readerMediaStatus = await semanticPort.stopReaderMediaRuntime();
        setStatus("MiniMax-H3 本机服务已停止。", "ok");
      } catch (error) {
        setStatus(`停止 MiniMax-H3 本机服务失败：${error}`, "error");
      } finally {
        renderReaderMediaStatus();
      }
    });
    on(mediaRefresh, "click", refreshReaderMediaStatus);
    on(mediaPolicy, "change", () => {
      try {
        const storage = (global as SemanticRuntime & { readonly localStorage?: Storage }).localStorage;
        storage?.setItem("readerMediaPolicyV1", mediaPolicy?.value || "suggest");
      } catch {
        // The generation policy is only a convenience preference.
      }
    });
    on(gpuRefreshButton, "click", refreshGpuStatus);
    on(gpuInstallButton, "click", installGpuRuntime);
    on(devicePolicySelect, "change", async () => {
      if (!devicePolicySelect) return;
      const next = devicePolicySelect.value as "auto" | "gpu" | "cpu";
      devicePolicySelect.disabled = true;
      setStatus("正在切换运行设备策略…", "busy");
      try {
        await semanticPort.selectDevicePolicy(next);
        await refreshGpuStatus();
        await refresh(true);
        setStatus("运行设备策略已更新；模型下次加载时按新策略生效。", "ok");
      } catch (error) {
        setStatus("切换运行设备失败：" + error, "error");
        await refreshGpuStatus();
      } finally {
        devicePolicySelect.disabled = false;
      }
    });
    on(vectorBuildButton, "click", () =>
      run(
        () => semanticPort.buildVectors(),
        "正在启动语义索引任务…",
        "启动语义索引失败：",
        () => {
          // 命令返回即表示 Rust 已登记后台任务；不能等到第一批编码进度回来才
          // 标记运行中，否则用户关闭再重开会短暂看到“尚未建立”并可重复点击。
          semanticCache.update({
            building: true,
            active_task: "semantic_vectors",
            vector_pause_requested: false,
            vector_paused: false,
            current: "正在建立语义索引…",
            error: "",
          });
          render(semanticCache.get() || {});
        },
      ),
    );
    on(vectorRebuildButton, "click", async () => {
      if (
        !confirmAction(
          "重新分析会先清除当前方案可重建的搜索数据，再分析全部本地图书；不会删除图书、资讯、阅读进度或阅读记录。是否继续？",
        )
      )
        return;
      await run(
        async () => {
          await semanticPort.deleteIndex("semantic");
          return semanticPort.buildVectors();
        },
        "正在重新分析全部本地内容…",
        "重新分析失败：",
        () => {
          semanticCache.clear();
          semanticCache.update({
            building: true,
            active_task: "semantic_vectors",
            current: "正在重新分析全部本地内容…",
            error: "",
          });
        },
      );
    });
    on(vectorPauseButton, "click", () =>
      run(
        () => semanticPort.pauseVectors(),
        "正在取消当前图书的未完成索引…",
        "暂停语义索引失败：",
      ),
    );
    on(acceleratorBuildButton, "click", () =>
      run(
        () => semanticPort.buildAccelerator(),
        "正在启动加速索引任务…",
        "启动加速索引失败：",
      ),
    );
    on(multiProfileBuildButton, "click", () =>
      run(
        () => semanticPort.buildMultiProfile(),
        "正在启动多中心画像任务…",
        "启动多中心画像失败：",
      ),
    );
    on(vectorDeleteButton, "click", async () => {
      if (
        !confirmAction(
          "只会清除可重新生成的本机搜索数据（包括大型书库加速数据），不会删除图书、资讯、阅读进度或阅读记录。是否继续？",
        )
      )
        return;
      await run(
        () => semanticPort.deleteIndex("semantic"),
        "正在清除本地智能搜索数据…",
        "清除搜索数据失败：",
        () => semanticCache.clear(),
      );
    });
    on(acceleratorDeleteButton, "click", async () => {
      if (
        !confirmAction("确定删除加速索引？语义索引会保留，可之后续建加速索引。")
      )
        return;
      setStatus("正在删除加速索引…", "busy");
      try {
        await semanticPort.deleteIndex("accelerator");
        semanticCache.update({
          accelerator_done: 0,
          accelerator_total: 0,
          accelerator_ready: false,
          accelerator_resumable: false,
          accelerator_bytes: 0,
        });
        await refresh();
      } catch (error) {
        setStatus("删除加速索引失败：" + error, "error");
      }
    });
    on(multiProfileDeleteButton, "click", async () => {
      if (!confirmAction("确定删除多中心画像索引？语义索引和加速索引会保留。"))
        return;
      setStatus("正在删除多中心画像索引…", "busy");
      try {
        await semanticPort.deleteIndex("multi_profile");
        semanticCache.update({
          multi_profile_done: 0,
          multi_profile_ready: false,
          multi_profile_bytes: 0,
        });
        await refresh();
      } catch (error) {
        setStatus("删除多中心画像失败：" + error, "error");
      }
    });
    on(retrievalMode, "change", async () => {
      if (!retrievalMode) return;
      await run(
        () =>
          semanticPort.selectRetrievalMode(
            retrievalMode.value as SemanticRetrievalMode,
          ),
        "正在保存检索策略…",
        "保存检索策略失败：",
      );
    });
    on(rerankerDownloadButton, "click", () =>
      run(
        () => semanticPort.downloadReranker(),
        "正在启动重排模型下载…",
        "启动重排模型下载失败：",
        () =>
          semanticCache.update({
            reranker_loading: true,
            current: "正在下载/载入重排模型…",
            error: "",
          }),
      ),
    );
    on(rerankerDeleteButton, "click", () =>
      run(
        () => semanticPort.deleteReranker(),
        "正在删除重排模型…",
        "删除重排模型失败：",
      ),
    );
    on(m3BuildButton, "click", () =>
      run(
        () => semanticPort.buildM3Index(),
        "正在建立 BGE-M3 稀疏与 ColBERT 索引…",
        "建立 M3 索引失败：",
      ),
    );
    on(m3DeleteButton, "click", () =>
      run(
        () => semanticPort.deleteM3Index(),
        "正在删除 BGE-M3 索引…",
        "删除 M3 索引失败：",
      ),
    );
    semanticPort
      .listenGpuRuntimeProgress((event) => {
        if (!gpuInstallRunning || !gpuMeta) return;
        const payload = event?.payload || {};
        const total = Math.max(1, Number(payload.total_bytes || 0));
        const done = Math.max(0, Number(payload.downloaded_bytes || 0));
        const percent = Math.max(
          0,
          Math.min(100, Math.round((done * 100) / total)),
        );
        gpuStatus = {
          ...(gpuStatus || {}),
          runtime_download_bytes: total,
          runtime_downloaded_bytes: done,
        };
        gpuMeta.textContent = semText(
          "semGpuDownloading",
          "Downloading GPU component: {percent}%…",
          { percent },
        );
      })
      .then((unlisten) => {
        gpuProgressUnlisten = unlisten;
      })
      .catch(() => undefined);
    const onLanguageChanged = () => {
      // The modal is populated after the main page, so reapply static labels
      // and rerender its generated state whenever the app language changes.
      global.ReaderAppI18n?.apply?.(modal);
      render(semanticCache.get() || {});
    };
    global.addEventListener("app-language-changed", onLanguageChanged);
    listeners.push(() =>
      global.removeEventListener("app-language-changed", onLanguageChanged),
    );

    function destroy() {
      visible = false;
      updatePolling(false);
      for (const remove of listeners.splice(0)) remove();
      gpuProgressUnlisten?.();
      gpuProgressUnlisten = null;
      activeController = null;
    }

    activeController = Object.freeze({ close, destroy, open, refresh, render });
    return activeController;
  }

  global.ReaderSemanticUI = Object.freeze({ init });
  return global.ReaderSemanticUI;
}
