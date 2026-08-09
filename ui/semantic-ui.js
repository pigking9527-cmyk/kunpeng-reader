// 书架页的语义模型与索引设置。依赖全部由 app.js 在 init 时注入，避免依赖
// app.js 的词法变量或 semantic-status-cache.js 的隐式全局函数。
(function exposeSemanticUi(global) {
  "use strict";

  let activeController = null;

  function init(options = {}) {
    if (activeController) return activeController;

    const root = options.root;
    const invoke = options.invoke;
    const settingsModal = options.settingsModal;
    const cache = options.cache;
    const confirmAction = options.confirmAction || ((message) => global.confirm(message));
    if (!root || typeof root.getElementById !== "function") throw new Error("ReaderSemanticUI.init 缺少 root");
    if (typeof invoke !== "function") throw new Error("ReaderSemanticUI.init 缺少 invoke");
    if (!cache || typeof cache.get !== "function" || typeof cache.merge !== "function") {
      throw new Error("ReaderSemanticUI.init 缺少状态缓存 API");
    }

    const el = (id) => root.getElementById(id);
    const modal = el("semantic-index-modal");
    const gearButton = el("semantic-gear");
    const closeButton = el("semantic-index-close");
    const modelMeta = el("sem-model-meta");
    const modelSelect = el("sem-model-select");
    const modelSetupTitle = el("sem-model-setup-title");
    const modelSetupCopy = el("sem-model-setup-copy");
    const vectorMeta = el("sem-vector-meta");
    const vectorGpuMeta = el("sem-vector-gpu-meta");
    const acceleratorMeta = el("sem-accel-meta");
    const multiProfileMeta = el("sem-multi-meta");
    const retrievalSection = el("sem-retrieval-section");
    const retrievalMeta = el("sem-retrieval-meta");
    const retrievalMode = el("sem-retrieval-mode");
    const retrievalM3Option = el("sem-retrieval-m3-option");
    const gpuMeta = el("sem-gpu-meta");
    const gpuRefreshButton = el("sem-gpu-refresh");
    const gpuInstallButton = el("sem-gpu-install");
    const rerankerMeta = el("sem-reranker-meta");
    const rerankerDownloadButton = el("sem-reranker-download");
    const rerankerDeleteButton = el("sem-reranker-delete");
    const m3Meta = el("sem-m3-meta");
    const m3BuildButton = el("sem-m3-build");
    const m3DeleteButton = el("sem-m3-delete");
    const m3Bar = el("sem-m3-bar");
    const statusElement = el("sem-status");
    const vectorBar = el("sem-vector-bar");
    const vectorProgress = el("sem-vector-progress");
    const acceleratorBar = el("sem-accel-bar");
    const multiProfileBar = el("sem-multi-bar");
    const modelDownloadButton = el("sem-model-download");
    const modelDeleteButton = el("sem-model-delete");
    const vectorBuildButton = el("sem-vector-build");
    const vectorPauseButton = el("sem-vector-pause");
    const vectorDeleteButton = el("sem-vector-delete");
    const acceleratorBuildButton = el("sem-accel-build");
    const acceleratorDeleteButton = el("sem-accel-delete");
    const multiProfileBuildButton = el("sem-multi-build");
    const multiProfileDeleteButton = el("sem-multi-delete");
    const semText = (key, fallback, values = {}) => {
      let value = global.ReaderAppI18n?.t?.(key);
      if (!value || /^⟦.+⟧$/.test(value)) value = fallback;
      return String(value).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? "");
    };
    // 与 Rust 模型定义的向量维度保持一致；切换提示与模型说明都从这里读取，
    // 让用户能判断不同模型建立索引时的向量规格。
    const MODEL_DIMENSIONS = Object.freeze({
      "bge-small-zh-v1.5": 512,
      "bge-large-zh-v1.5": 1024,
      "bge-m3": 1024,
      "multilingual-e5-small": 384
    });

    let pollTimer = null;
    let statusInFlight = false;
    let visible = false;
    let gpuStatus = null;
    let gpuInstallRunning = false;
    let gpuRefreshInFlight = false;
    let gpuProgressUnlisten = null;
    const listeners = [];

    function on(element, eventName, handler) {
      if (!element) return;
      element.addEventListener(eventName, handler);
      listeners.push(() => element.removeEventListener(eventName, handler));
    }

    function setProgressBar(bar, done, total, ready) {
      const percent = total > 0 ? Math.max(0, Math.min(100, Math.round(done * 100 / total))) : 0;
      if (!bar) return;
      bar.style.width = percent + "%";
      bar.parentElement?.classList.toggle("done", !!ready);
    }

    function formatBytes(bytes) {
      const value = Math.max(0, Number(bytes || 0));
      if (value >= 1024 * 1024 * 1024) return (value / (1024 * 1024 * 1024)).toFixed(1) + " GB";
      return Math.max(1, Math.round(value / (1024 * 1024))) + " MB";
    }

    // 老版本已经落盘的加速/画像索引没有当前强校验元数据，不能直接拿来查询，
    // 但在界面上不能伪装成“从未建立”。用满进度明确表示已有完成产物，按钮
    // 则保留“更新”语义，避免把旧数据误认成当前可用索引。
    function legacyCompleted(taskItem, total, bytes) {
      return !taskItem?.running && !total && Number(bytes || 0) > 0;
    }

    function setStatus(text = "", kind = "") {
      if (!statusElement) return;
      statusElement.textContent = text || "";
      statusElement.className = "ai-status" + (kind ? " " + kind : "");
    }

    function task(center, id) {
      return Array.isArray(center?.tasks) ? center.tasks.find((item) => item.id === id) : null;
    }

    function updatePolling(shouldPoll) {
      if (visible && shouldPoll && !pollTimer) {
        // 构建结束时 Rust 会清除旧的状态缓存；轮询必须请求一次后台核对，
        // 否则轻量快照会回退到 0/总数，把刚完成或可续建的索引误显示为“尚未建立”。
        // 后端在任务仍运行时不会启动逐书扫描，因此这里不会与编码争用磁盘。
        pollTimer = global.setInterval(() => { void refresh(true); }, 1500);
      } else if ((!visible || !shouldPoll) && pollTimer) {
        global.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function render(payload = {}) {
      const center = Array.isArray(payload?.tasks) ? payload : null;
      let progress = center ? center.progress || {} : payload;
      progress = cache.merge(progress);
      const busy = !!(progress.building || progress.model_downloading || progress.reranker_loading);
      const refreshing = !!progress.status_refreshing;
      // 后端正在后台校验时优先展示同一模型上次确认过的快照；没有可靠快照时
      // 展示保守的 0/总数，绝不根据元数据文件名猜测为全部完成。
      const taskSource = refreshing && cache.get() ? null : center;
      const modelTask = task(taskSource, "semantic_model");
      const vectorTask = task(taskSource, "semantic_vectors");
      const acceleratorTask = task(taskSource, "semantic_accelerator");
      const multiProfileTask = task(taskSource, "semantic_multi_profile");
      const activeTask = progress.active_task || "";
      const vectorLive = progress.building && (
        activeTask === "semantic_vectors" ||
        activeTask === "semantic_full" ||
        (!activeTask && !progress.shard_total)
      );
      // 逐书状态还在核对时，0/总数只代表“尚未读取完成”，不是“尚未建立”。
      // 不显示旧缓存或保守的 0，等核对结果回到后再展示未建立、可续建或完成。
      const vectorStatusChecking = refreshing && !vectorLive;
      const vectorDone = vectorLive ? (progress.done || 0) : (progress.semantic_done || 0);
      const vectorTotal = vectorLive ? (progress.total || 0) : (progress.semantic_total || 0);
      const acceleratorDone = progress.accelerator_done || 0;
      const acceleratorTotal = progress.accelerator_total || 0;
      const multiProfileDone = progress.multi_profile_done || 0;
      const multiProfileTotal = progress.multi_profile_total || 0;
      const legacyAccelerator = legacyCompleted(acceleratorTask, acceleratorTotal, progress.accelerator_bytes);
      const legacyMultiProfile = legacyCompleted(multiProfileTask, multiProfileTotal, progress.multi_profile_bytes);
      const activeModel = progress.model_id || modelSelect?.value || "bge-small-zh-v1.5";
      const modelPresentation = {
        "bge-small-zh-v1.5": {
          title: semText("semSmallTitle", "Light semantic search · BGE Small Chinese"),
          copy: semText("semSmallCopy", "The default lightweight Chinese semantic model."),
          dimensions: MODEL_DIMENSIONS["bge-small-zh-v1.5"],
          downloadBytes: 95 * 1024 * 1024,
          downloadEstimate: "95 MB"
        },
        "bge-large-zh-v1.5": {
          title: semText("semLargeTitle", "High-precision semantic search · BGE Large Chinese"),
          copy: semText("semLargeCopy", "A higher-precision Chinese semantic model."),
          dimensions: MODEL_DIMENSIONS["bge-large-zh-v1.5"],
          downloadBytes: 1.3 * 1024 * 1024 * 1024,
          downloadEstimate: "1.3 GB"
        },
        "bge-m3": {
          title: semText("semM3Title", "BGE-M3 · Multilingual hybrid retrieval"),
          copy: semText("semM3Copy", "Supports dense, sparse, and ColBERT representations."),
          dimensions: MODEL_DIMENSIONS["bge-m3"],
          downloadBytes: 620 * 1024 * 1024,
          downloadEstimate: "620 MB"
        },
        "multilingual-e5-small": {
          title: semText("semE5Title", "Multilingual-E5-Small · Lightweight multilingual retrieval"),
          copy: semText("semE5Copy", "A lightweight multilingual semantic model."),
          dimensions: MODEL_DIMENSIONS["multilingual-e5-small"],
          downloadBytes: 450 * 1024 * 1024,
          downloadEstimate: "450 MB"
        }
      }[activeModel];
      const supportsM3Hybrid = activeModel === "bge-m3";
      const retrievalPresentation = {
        standard: semText("semRetrievalStandardCopy", "Faster: combines keyword and semantic results."),
        high_precision: semText("semRetrievalHighCopy", "More accurate: fuses results and reranks the best content."),
        m3_hybrid: semText("semRetrievalM3Copy", "Broader coverage for keywords, meaning, and multilingual terms.")
      };

      if (modelSetupTitle && modelPresentation) {
        modelSetupTitle.textContent = modelPresentation.title + " · " + semText(
          "semVectorDimensions",
          "{dimensions} dimensions",
          { dimensions: modelPresentation.dimensions }
        );
      }
      if (modelSetupCopy && modelPresentation) modelSetupCopy.textContent = modelPresentation.copy;

      if (modelSelect && progress.model_id) modelSelect.value = progress.model_id;

      const modelLabel = progress.model_label ? progress.model_label + " · " : "";
      const modelDownloadTotal = Number(modelPresentation?.downloadBytes || 0);
      const modelDownloaded = Math.max(0, Number(progress.model_bytes || 0));
      const modelDownloadPercent = modelDownloadTotal
        ? Math.min(99, Math.floor(modelDownloaded * 100 / modelDownloadTotal))
        : 0;
      const modelDownloadProgress = modelDownloaded > 0 && modelDownloadTotal > 0
        ? semText("semModelDownloadProgress", "Downloading model: {percent}% ({downloaded}/{total})", {
          percent: modelDownloadPercent,
          downloaded: formatBytes(Math.min(modelDownloaded, modelDownloadTotal)),
          total: modelPresentation.downloadEstimate
        })
        : semText("semModelDownloading", "Downloading/loading model…");
      if (modelMeta) {
        modelMeta.textContent = !progress.model_supported
          ? modelLabel + semText("semModelUnsupported", "ONNX weights are not available for local use.")
          : progress.model_downloading
          ? modelLabel + modelDownloadProgress
          : progress.model_ready
          ? modelLabel + semText("semModelReady", "Ready")
          : modelLabel + semText("semModelNotDownloaded", "Not downloaded; first download is about {size}.", { size: modelPresentation?.downloadEstimate || "—" });
      }
      const hasSemanticIndex = vectorLive || vectorDone > 0 || !!progress.semantic_ready;
      if (vectorMeta) {
        vectorMeta.textContent = vectorStatusChecking
          ? semText("semCheckingIndex", "Checking semantic-index progress…")
          : vectorLive && !vectorTotal
          ? semText("semTaskRunning", "Task is running in the background…")
          : !hasSemanticIndex
          ? semText("semNotBuilt", "Not built")
          : vectorTotal
          ? semText("semProgressBooks", "{done}/{total} books", { done: vectorDone, total: vectorTotal }) + (progress.semantic_ready ? `, ${semText("semCompleted", "completed")}` : "")
          : semText("semNoBooks", "There are no books available for semantic indexing.");
      }
      // runtime_ready 是对 CUDA Provider 的实际注册检测；仅在正在向量化时提示，
      // 不把“GPU 硬件存在”误说成当前索引已经由 GPU 加速。
      const gpuIndexing = vectorLive && !!gpuStatus?.runtime_ready;
      if (vectorGpuMeta) {
        vectorGpuMeta.hidden = !gpuIndexing;
        vectorGpuMeta.textContent = gpuIndexing
          ? semText("semGpuIndexing", "GPU-accelerated indexing in progress.")
          : "";
      }
      if (acceleratorMeta) {
        const acceleratorDescription = semText("semAcceleratorDescription", "Returns results faster for large libraries with a semantic index.");
        const acceleratorProgress = semText("semProgressParts", "{done}/{total} parts", { done: acceleratorDone, total: acceleratorTotal });
        acceleratorMeta.textContent = legacyAccelerator
          ? semText("semLegacyIndex", "Built with an older index; update it to use the current algorithm.")
          : acceleratorTotal
          ? acceleratorProgress + (progress.accelerator_ready ? `, ${semText("semCompleted", "completed")}` : (progress.accelerator_resumable ? `, ${semText("semCanResume", "can resume")}` : "")) + ` · ${acceleratorDescription}`
          : acceleratorDescription;
      }
      if (multiProfileMeta) {
        const multiProfileDescription = semText("semMultiProfileDescription", "Classifies topics in a book for better cross-topic results.");
        const multiProfileProgress = semText("semProgressBooks", "{done}/{total} books", { done: multiProfileDone, total: multiProfileTotal });
        multiProfileMeta.textContent = legacyMultiProfile
          ? semText("semLegacyIndex", "Built with an older index; update it to use the current algorithm.")
          : multiProfileTotal
          ? multiProfileProgress + (progress.multi_profile_ready ? `, ${semText("semCompleted", "completed")}` : (multiProfileDone ? `, ${semText("semUpdateNeeded", "needs update")}` : "")) + ` · ${multiProfileDescription}`
          : multiProfileDescription;
      }
      const gpuDownloadTotal = Math.max(0, Number(gpuStatus?.runtime_download_bytes || 0));
      const gpuDownloaded = Math.max(0, Math.min(gpuDownloadTotal, Number(gpuStatus?.runtime_downloaded_bytes || 0)));
      const gpuDownloadPercent = gpuDownloadTotal ? Math.round(gpuDownloaded * 100 / gpuDownloadTotal) : 0;
      const hasSavedGpuDownload = gpuDownloaded > 0 && !gpuStatus?.runtime_ready;
      if (gpuMeta && !gpuInstallRunning) {
        const hardwareMessage = gpuStatus?.runtime_ready
          ? semText("semGpuReady", "Acceleration is ready.")
          : gpuStatus?.message || semText("semGpuInitial", "Select Recheck to read the local GPU status.");
        gpuMeta.textContent = hardwareMessage;
        gpuMeta.title = hardwareMessage;
      }
      if (gpuInstallButton) {
        gpuInstallButton.hidden = !gpuStatus?.runtime_install_available || !!gpuStatus?.runtime_ready;
        gpuInstallButton.disabled = gpuInstallRunning;
        gpuInstallButton.textContent = gpuInstallRunning
          ? semText("semInstallingGpuRuntime", "Installing GPU component…")
          : hasSavedGpuDownload
          ? semText("semResumeGpuRuntime", "Resume GPU component installation ({percent}%)", { percent: gpuDownloadPercent })
          : semText("semInstallGpuRuntime", "Install GPU component");
      }
      if (retrievalSection) retrievalSection.hidden = false;
      if (retrievalM3Option) {
        retrievalM3Option.hidden = !supportsM3Hybrid;
        retrievalM3Option.disabled = !supportsM3Hybrid;
      }
      if (retrievalMode && progress.retrieval_mode) {
        retrievalMode.value = supportsM3Hybrid || progress.retrieval_mode !== "m3_hybrid"
          ? progress.retrieval_mode
          : "standard";
      }
      const selectedRetrievalMode = retrievalMode?.value || progress.retrieval_mode || "standard";
      if (retrievalMeta) retrievalMeta.textContent = retrievalPresentation[selectedRetrievalMode] || retrievalPresentation.standard;
      if (rerankerMeta) rerankerMeta.textContent = progress.reranker_loading
        ? semText("semRerankerLoading", "Preparing the reranker automatically. It reranks candidate content so citations are more accurate.")
        : progress.reranker_ready || progress.reranker_downloaded
        ? semText("semRerankerReady", "Ready. It loads automatically when high-precision retrieval calls it, then reranks candidate content for more accurate citations.")
        : progress.reranker_partial
        ? semText("semRerankerPartial", "Download incomplete. Continue downloading to prepare the reranker for high-precision retrieval.")
        : semText("semRerankerNotDownloaded", "Not downloaded. Download the reranker before using high-precision retrieval.");
      if (m3Meta) m3Meta.textContent = supportsM3Hybrid
        ? (progress.m3_index_ready ? semText("semM3Ready", "Ready. Complex questions are easier to find.") : semText("semM3BuildHint", "Build it to balance keywords and meaning."))
        : semText("semM3Only", "Available only when BGE-M3 is selected.");
      const m3Section = el("sem-m3-index-section");
      if (m3Section) m3Section.hidden = !supportsM3Hybrid;
      setProgressBar(m3Bar, progress.m3_index_done || 0, progress.m3_index_total || 0, progress.m3_index_ready);

      if (vectorProgress) vectorProgress.hidden = vectorStatusChecking || !hasSemanticIndex;
      setProgressBar(vectorBar, vectorTask?.done ?? vectorDone, vectorTask?.total ?? vectorTotal, vectorTask?.ready ?? progress.semantic_ready);
      setProgressBar(acceleratorBar, legacyAccelerator ? 1 : (acceleratorTask?.done ?? acceleratorDone), legacyAccelerator ? 1 : (acceleratorTask?.total ?? acceleratorTotal), legacyAccelerator || (acceleratorTask?.ready ?? progress.accelerator_ready));
      setProgressBar(multiProfileBar, legacyMultiProfile ? 1 : (multiProfileTask?.done ?? multiProfileDone), legacyMultiProfile ? 1 : (multiProfileTask?.total ?? multiProfileTotal), legacyMultiProfile || (multiProfileTask?.ready ?? progress.multi_profile_ready));

      if (modelSelect) modelSelect.disabled = busy;
      if (modelDownloadButton) modelDownloadButton.disabled = !!progress.model_ready || !progress.model_supported || (modelTask ? !modelTask.can_start : (busy || refreshing));
      if (modelDeleteButton) modelDeleteButton.disabled = !progress.model_supported || (modelTask ? !modelTask.can_delete : (busy || !progress.model_ready));
      if (vectorBuildButton) vectorBuildButton.disabled = vectorStatusChecking || busy || (vectorTask ? !vectorTask.can_start : (!progress.model_ready || !vectorTotal));
      const vectorPauseAvailable = progress.building && activeTask === "semantic_vectors";
      if (vectorPauseButton) {
        vectorPauseButton.hidden = !vectorPauseAvailable;
        vectorPauseButton.disabled = !vectorPauseAvailable || !!progress.vector_pause_requested;
      }
      if (vectorDeleteButton) vectorDeleteButton.disabled = vectorStatusChecking || (vectorTask ? !vectorTask.can_delete : (busy || vectorDone <= 0));
      if (acceleratorBuildButton) acceleratorBuildButton.disabled = acceleratorTask ? !acceleratorTask.can_start : (busy || !progress.model_ready || vectorDone <= 0);
      if (acceleratorDeleteButton) acceleratorDeleteButton.disabled = acceleratorTask ? !acceleratorTask.can_delete : (busy || (!progress.accelerator_ready && acceleratorDone <= 0));
      if (multiProfileBuildButton) multiProfileBuildButton.disabled = multiProfileTask ? !multiProfileTask.can_start : (busy || vectorDone <= 0);
      if (multiProfileDeleteButton) multiProfileDeleteButton.disabled = multiProfileTask ? !multiProfileTask.can_delete : (busy || !progress.multi_profile_bytes);
      if (retrievalMode) retrievalMode.disabled = busy;
      if (rerankerDownloadButton) {
        rerankerDownloadButton.hidden = !!progress.reranker_downloaded;
        rerankerDownloadButton.disabled = busy || !!progress.reranker_downloaded;
        rerankerDownloadButton.textContent = progress.reranker_partial
          ? semText("semResumeReranker", "Resume reranker download")
          : semText("semDownloadReranker", "Download reranker");
      }
      if (rerankerDeleteButton) rerankerDeleteButton.disabled = busy || (!progress.reranker_downloaded && !progress.reranker_partial);
      if (m3BuildButton) m3BuildButton.disabled = busy || !supportsM3Hybrid || !progress.model_ready;
      if (m3DeleteButton) m3DeleteButton.disabled = busy || !progress.m3_index_done;
      if (modelDownloadButton) modelDownloadButton.textContent = semText("semDownloadModel", "Download model");
      if (modelDeleteButton) modelDeleteButton.textContent = semText("semDelete", "Delete");
      if (vectorBuildButton) vectorBuildButton.textContent = vectorDone > 0 && !progress.semantic_ready ? semText("semResumeIndex", "Resume semantic index") : semText("semBuildIndex", "Build semantic index");
      if (vectorPauseButton) vectorPauseButton.textContent = semText("semPause", "Pause");
      if (vectorDeleteButton) vectorDeleteButton.textContent = semText("semDelete", "Delete");
      if (acceleratorBuildButton) acceleratorBuildButton.textContent = legacyAccelerator ? semText("semUpdateAccelerator", "Update accelerator index") : semText("semBuildAccelerator", "Build accelerator index");
      if (acceleratorDeleteButton) acceleratorDeleteButton.textContent = semText("semDelete", "Delete");
      if (multiProfileBuildButton) multiProfileBuildButton.textContent = semText("semBuildMulti", "Build multi-profile index");
      if (multiProfileDeleteButton) multiProfileDeleteButton.textContent = semText("semDelete", "Delete");

      if (progress.error) setStatus(progress.error, "error");
      else if (progress.model_downloading || progress.building || progress.reranker_loading) setStatus(progress.current || semText("semTaskRunning", "Task is running in the background…"), "busy");
      else setStatus(progress.current || "", progress.current ? "ok" : "");

      updatePolling(!!(progress.model_downloading || progress.building || progress.reranker_loading || refreshing));
      // provisional 状态只用于立即渲染，不能成为下一次打开时的“可靠快照”。
      if (!refreshing) {
        cache.save(progress);
      }
    }

    function activeVectorTask(snapshots) {
      return (Array.isArray(snapshots) ? snapshots : [])
        .filter((item) => item?.kind === "semantic_vectors" && ["queued", "running", "pausing"].includes(item?.state))
        .sort((left, right) => Number(right?.created_at_ms || 0) - Number(left?.created_at_ms || 0))[0] || null;
    }

    function completedBooksFromCheckpoint(task) {
      try {
        const completed = JSON.parse(task?.checkpoint || "")?.completed;
        return Number.isFinite(Number(completed)) ? Math.max(0, Number(completed)) : null;
      } catch (_) {
        return null;
      }
    }

    // 语义状态页的轻量快照可能正处于重新核对阶段，但通用任务注册表会在每次
    // 编码批次后持久化。以它为最终兜底，避免弹窗关闭再打开时误放开重复建立。
    function restoreLiveVectorTask(center, snapshots) {
      const taskSnapshot = activeVectorTask(snapshots);
      if (!taskSnapshot || !center || !Array.isArray(center.tasks)) return center;
      const progress = center.progress || {};
      const cached = cache.get(progress.model_id);
      const total = Math.max(0, Number(progress.total || 0), Number(progress.semantic_total || 0), Number(cached?.semantic_total || 0));
      const checkpointDone = completedBooksFromCheckpoint(taskSnapshot);
      const done = Math.min(total || Number.MAX_SAFE_INTEGER, checkpointDone ?? Math.max(0, Number(taskSnapshot.progress?.done || 0)));
      const restoredProgress = {
        ...progress,
        building: true,
        active_task: "semantic_vectors",
        vector_pause_requested: taskSnapshot.state === "pausing" || !!taskSnapshot.pause_requested,
        vector_paused: false,
        done,
        total,
        semantic_done: done,
        semantic_total: total,
        semantic_ready: false,
        current: taskSnapshot.current || progress.current || "正在建立语义索引…",
        error: taskSnapshot.error || "",
      };
      return {
        ...center,
        progress: restoredProgress,
        current: restoredProgress.current,
        error: restoredProgress.error,
        tasks: center.tasks.map((item) => item?.id !== "semantic_vectors" ? item : {
          ...item,
          status: "running",
          done,
          total,
          running: true,
          ready: false,
          resumable: false,
          can_start: false,
          can_delete: false,
        }),
      };
    }

    async function refresh(reconcile = false) {
      if (statusInFlight) return;
      statusInFlight = true;
      try {
        if (reconcile) setStatus(semText("semReadingStatus", "Checking index status in the background…"), "busy");
        const [center, taskSnapshots] = await Promise.all([
          invoke("semantic_tasks", { reconcile }),
          invoke("background_task_status"),
        ]);
        render(restoreLiveVectorTask(center, taskSnapshots));
      } catch (error) {
        setStatus(semText("semReadStatusFailed", "Could not read semantic-index status: {error}", { error }), "error");
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
        gpuStatus = await invoke("semantic_gpu_status");
        render(cache.get() || {});
      } catch (error) {
        gpuStatus = { message: semText("semGpuFailed", "Could not detect GPU: {error}", { error }) };
        render(cache.get() || {});
      } finally {
        gpuRefreshInFlight = false;
        if (gpuRefreshButton) gpuRefreshButton.disabled = false;
      }
    }

    async function installGpuRuntime() {
      if (!gpuStatus?.runtime_install_available || gpuInstallRunning) return;
      const total = Math.max(0, Number(gpuStatus.runtime_download_bytes || 0));
      const downloaded = Math.max(0, Math.min(total, Number(gpuStatus.runtime_downloaded_bytes || 0)));
      const gib = Math.max(0.1, (total - downloaded) / (1024 ** 3)).toFixed(1);
      if (!confirmAction(semText("semGpuInstallConfirm", "Download and install about {size} GiB of remaining NVIDIA GPU runtime files? The CPU fallback remains available.", { size: gib }))) return;
      gpuInstallRunning = true;
      render(cache.get() || {});
      const initialPercent = total ? Math.round(downloaded * 100 / total) : 0;
      if (gpuMeta) gpuMeta.textContent = semText("semGpuDownloading", "Downloading GPU component: {percent}%…", { percent: initialPercent });
      try {
        await invoke("install_semantic_gpu_runtime");
        await refreshGpuStatus();
      } catch (error) {
        gpuStatus = {
          ...(gpuStatus || {}),
          message: semText("semGpuInstallFailed", "GPU component installation failed: {error}", { error }),
        };
      } finally {
        gpuInstallRunning = false;
        render(cache.get() || {});
      }
    }
    function open() {
      settingsModal?.classList.remove("show");
      modal?.classList.add("show");
      visible = true;
      const cached = cache.get();
      if (cached) render(cached);
      else render({});
      // 索引快照与 GPU 探测都异步刷新；GPU 探测在 Rust 阻塞线程执行，不占用页面线程。
      // 首次打开也要核对当前模型的已落盘索引。只读轻量快照无法区分
      // “从未建立”和“刚构建完成后缓存已失效”的两种状态。
      global.setTimeout(() => { void refresh(true); }, 30);
      global.setTimeout(() => { void refreshGpuStatus(); }, 60);
    }

    function close() {
      visible = false;
      modal?.classList.remove("show");
      updatePolling(false);
      settingsModal?.classList.add("show");
    }

    async function run(command, startingText, failureText, afterSuccess, payload) {
      setStatus(startingText, "busy");
      try {
        if (payload === undefined) await invoke(command);
        else await invoke(command, payload);
        if (afterSuccess) afterSuccess();
        await refresh();
      } catch (error) {
        setStatus(failureText + error, "error");
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
    on(modelDownloadButton, "click", () => run("download_semantic_model", "正在启动模型下载…", "启动模型下载失败："));
    on(modelDeleteButton, "click", async () => {
      if (!confirmAction("确定删除本机语义模型缓存？之后使用语义检索需要重新下载模型。")) return;
      await run("delete_semantic_model", "正在删除模型…", "删除模型失败：", () => cache.update({ model_ready: false, model_bytes: 0 }));
    });
    on(modelSelect, "change", async () => {
      const next = modelSelect.value;
      const current = cache.get()?.model_id || "bge-small-zh-v1.5";
      const dimensions = MODEL_DIMENSIONS[next];
      const modelLabel = modelSelect.selectedOptions?.[0]?.textContent?.trim() || next;
      if (next === current) return;
      if (!confirmAction("切换模型会使用一套独立的语义索引。切换后请下载新模型并重新建立语义索引；原模型的缓存会被保留。是否继续？")) {
        modelSelect.value = current;
        return;
      }
      const cachedNext = cache.use(next);
      if (cachedNext) render(cachedNext);
      modelSelect.disabled = true;
      setStatus(semText("semModelSwitching", "Switching to {model} ({dimensions} dimensions)…", { model: modelLabel, dimensions }), "busy");
      try {
        await invoke("select_semantic_model", { modelId: next });
        // 切换模型后自动后台核对该模型的索引；打开设置本身不触发这项扫描。
        await refresh(true);
        setStatus(semText("semModelSwitched", "Switched to {model} ({dimensions}-dimensional vectors).", { model: modelLabel, dimensions }), "ok");
      } catch (error) {
        modelSelect.value = current;
        setStatus("切换模型失败：" + error, "error");
      } finally {
        modelSelect.disabled = false;
      }
    });
    on(gpuRefreshButton, "click", refreshGpuStatus);
    on(gpuInstallButton, "click", installGpuRuntime);
    on(vectorBuildButton, "click", () => run(
      "build_semantic_vectors",
      "正在启动语义索引任务…",
      "启动语义索引失败：",
      () => {
        // 命令返回即表示 Rust 已登记后台任务；不能等到第一批编码进度回来才
        // 标记运行中，否则用户关闭再重开会短暂看到“尚未建立”并可重复点击。
        cache.update({
          building: true,
          active_task: "semantic_vectors",
          vector_pause_requested: false,
          vector_paused: false,
          current: "正在建立语义索引…",
          error: "",
        });
        render(cache.get() || {});
      },
    ));
    on(vectorPauseButton, "click", () => run("pause_semantic_vectors", "正在取消当前图书的未完成索引…", "暂停语义索引失败："));
    on(acceleratorBuildButton, "click", () => run("build_semantic_accelerator", "正在启动加速索引任务…", "启动加速索引失败："));
    on(multiProfileBuildButton, "click", () => run("build_semantic_multi_profile", "正在启动多中心画像任务…", "启动多中心画像失败："));
    on(vectorDeleteButton, "click", async () => {
      if (!confirmAction("确定删除语义索引？加速索引也会一起删除。")) return;
      await run("delete_semantic_index", "正在删除语义索引…", "删除语义索引失败：", () => cache.clear(), { kind: "semantic" });
    });
    on(acceleratorDeleteButton, "click", async () => {
      if (!confirmAction("确定删除加速索引？语义索引会保留，可之后续建加速索引。")) return;
      setStatus("正在删除加速索引…", "busy");
      try {
        await invoke("delete_semantic_index", { kind: "accelerator" });
        cache.update({ accelerator_done: 0, accelerator_total: 0, accelerator_ready: false, accelerator_resumable: false, accelerator_bytes: 0 });
        await refresh();
      } catch (error) {
        setStatus("删除加速索引失败：" + error, "error");
      }
    });
    on(multiProfileDeleteButton, "click", async () => {
      if (!confirmAction("确定删除多中心画像索引？语义索引和加速索引会保留。")) return;
      setStatus("正在删除多中心画像索引…", "busy");
      try {
        await invoke("delete_semantic_index", { kind: "multi_profile" });
        cache.update({ multi_profile_done: 0, multi_profile_ready: false, multi_profile_bytes: 0 });
        await refresh();
      } catch (error) {
        setStatus("删除多中心画像失败：" + error, "error");
      }
    });
    on(retrievalMode, "change", async () => {
      await run("select_semantic_retrieval_mode", "正在保存检索策略…", "保存检索策略失败：", null, { mode: retrievalMode.value });
    });
    on(rerankerDownloadButton, "click", () => run(
      "download_semantic_reranker",
      "正在启动重排模型下载…",
      "启动重排模型下载失败：",
      () => cache.update({ reranker_loading: true, current: "正在下载/载入重排模型…", error: "" }),
    ));
    on(rerankerDeleteButton, "click", () => run("delete_semantic_reranker", "正在删除重排模型…", "删除重排模型失败："));
    on(m3BuildButton, "click", () => run("build_semantic_m3_index", "正在建立 BGE-M3 稀疏与 ColBERT 索引…", "建立 M3 索引失败："));
    on(m3DeleteButton, "click", () => run("delete_semantic_m3_index", "正在删除 BGE-M3 索引…", "删除 M3 索引失败："));
    global.__TAURI__?.event?.listen?.("semantic-gpu-runtime-progress", (event) => {
      if (!gpuInstallRunning || !gpuMeta) return;
      const payload = event?.payload || {};
      const total = Math.max(1, Number(payload.total_bytes || 0));
      const done = Math.max(0, Number(payload.downloaded_bytes || 0));
      const percent = Math.max(0, Math.min(100, Math.round(done * 100 / total)));
      gpuStatus = { ...(gpuStatus || {}), runtime_download_bytes: total, runtime_downloaded_bytes: done };
      gpuMeta.textContent = semText("semGpuDownloading", "Downloading GPU component: {percent}%…", { percent });
    }).then((unlisten) => { gpuProgressUnlisten = unlisten; }).catch(() => {});
    const onLanguageChanged = () => {
      // The modal is populated after the main page, so reapply static labels
      // and rerender its generated state whenever the app language changes.
      global.ReaderAppI18n?.apply?.(modal);
      render(cache.get() || {});
    };
    global.addEventListener("app-language-changed", onLanguageChanged);
    listeners.push(() => global.removeEventListener("app-language-changed", onLanguageChanged));

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
})(typeof window !== "undefined" ? window : globalThis);
