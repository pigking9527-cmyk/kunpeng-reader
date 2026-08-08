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
        pollTimer = global.setInterval(() => { void refresh(false); }, 1500);
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
      const vectorLive = progress.building && progress.total > 0 && (
        activeTask === "semantic_vectors" ||
        activeTask === "semantic_full" ||
        (!activeTask && !progress.shard_total)
      );
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
          downloadEstimate: "95 MB"
        },
        "bge-large-zh-v1.5": {
          title: semText("semLargeTitle", "High-precision semantic search · BGE Large Chinese"),
          copy: semText("semLargeCopy", "A higher-precision Chinese semantic model."),
          downloadEstimate: "1.3 GB"
        },
        "bge-m3": {
          title: semText("semM3Title", "BGE-M3 · Multilingual hybrid retrieval"),
          copy: semText("semM3Copy", "Supports dense, sparse, and ColBERT representations."),
          downloadEstimate: "620 MB"
        },
        "multilingual-e5-small": {
          title: semText("semE5Title", "Multilingual-E5-Small · Lightweight multilingual retrieval"),
          copy: semText("semE5Copy", "A lightweight multilingual semantic model."),
          downloadEstimate: "450 MB"
        }
      }[activeModel];
      const supportsM3Hybrid = activeModel === "bge-m3";
      const retrievalPresentation = {
        standard: semText("semRetrievalStandardCopy", "Faster: combines keyword and semantic results."),
        high_precision: semText("semRetrievalHighCopy", "More accurate: fuses results and reranks the best content."),
        m3_hybrid: semText("semRetrievalM3Copy", "Broader coverage for keywords, meaning, and multilingual terms.")
      };

      if (modelSetupTitle && modelPresentation) modelSetupTitle.textContent = modelPresentation.title;
      if (modelSetupCopy && modelPresentation) modelSetupCopy.textContent = modelPresentation.copy;

      if (modelSelect && progress.model_id) modelSelect.value = progress.model_id;

      const modelLabel = progress.model_label ? progress.model_label + " · " : "";
      if (modelMeta) {
        modelMeta.textContent = !progress.model_supported
          ? modelLabel + semText("semModelUnsupported", "ONNX weights are not available for local use.")
          : progress.model_downloading
          ? modelLabel + semText("semModelDownloading", "Downloading/loading model…")
          : progress.model_ready
          ? modelLabel + semText("semModelReady", "Ready")
          : modelLabel + semText("semModelNotDownloaded", "Not downloaded; first download is about {size}.", { size: modelPresentation?.downloadEstimate || "—" });
      }
      if (vectorMeta) {
        vectorMeta.textContent = vectorTotal
          ? semText("semProgressBooks", "{done}/{total} books", { done: vectorDone, total: vectorTotal }) + (progress.semantic_ready ? `, ${semText("semCompleted", "completed")}` : "")
          : semText("semNoBooks", "There are no books available for semantic indexing.");
      }
      if (acceleratorMeta) {
        acceleratorMeta.textContent = legacyAccelerator
          ? semText("semLegacyIndex", "Built with an older index; update it to use the current algorithm.")
          : acceleratorTotal
          ? semText("semProgressParts", "{done}/{total} parts", { done: acceleratorDone, total: acceleratorTotal }) + (progress.accelerator_ready ? `, ${semText("semCompleted", "completed")}` : (progress.accelerator_resumable ? `, ${semText("semCanResume", "can resume")}` : ""))
          : semText("semAcceleratorDescription", "Returns results faster for large libraries with a semantic index.");
      }
      if (multiProfileMeta) {
        multiProfileMeta.textContent = legacyMultiProfile
          ? semText("semLegacyIndex", "Built with an older index; update it to use the current algorithm.")
          : multiProfileTotal
          ? semText("semProgressBooks", "{done}/{total} books", { done: multiProfileDone, total: multiProfileTotal }) + (progress.multi_profile_ready ? `, ${semText("semCompleted", "completed")}` : (multiProfileDone ? `, ${semText("semUpdateNeeded", "needs update")}` : ""))
          : semText("semMultiProfileDescription", "Classifies topics in a book for better cross-topic results.");
      }
      const gpuDownloadTotal = Math.max(0, Number(gpuStatus?.runtime_download_bytes || 0));
      const gpuDownloaded = Math.max(0, Math.min(gpuDownloadTotal, Number(gpuStatus?.runtime_downloaded_bytes || 0)));
      const gpuDownloadPercent = gpuDownloadTotal ? Math.round(gpuDownloaded * 100 / gpuDownloadTotal) : 0;
      const hasSavedGpuDownload = gpuDownloaded > 0 && !gpuStatus?.runtime_ready;
      if (gpuMeta && !gpuInstallRunning) {
        const hardwareMessage = gpuStatus?.message || semText("semGpuInitial", "Select Recheck to read the local GPU status.");
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
        ? semText("semRerankerLoading", "Loading the reranker. It will show Ready when complete.")
        : progress.reranker_ready
        ? semText("semRerankerReady", "Ready. It places the best-matching content first.")
        : progress.reranker_downloaded
        ? "已下载，尚未加载；点击“加载重排模型”后才会启用。"
        : semText("semRerankerNotReady", "Places the best-matching content first; first download is about 1.6 GB.");
      if (m3Meta) m3Meta.textContent = supportsM3Hybrid
        ? (progress.m3_index_ready ? semText("semM3Ready", "Ready. Complex questions are easier to find.") : semText("semM3BuildHint", "Build it to balance keywords and meaning."))
        : semText("semM3Only", "Available only when BGE-M3 is selected.");
      const m3Section = el("sem-m3-index-section");
      if (m3Section) m3Section.hidden = !supportsM3Hybrid;
      setProgressBar(m3Bar, progress.m3_index_done || 0, progress.m3_index_total || 0, progress.m3_index_ready);

      setProgressBar(vectorBar, vectorTask?.done ?? vectorDone, vectorTask?.total ?? vectorTotal, vectorTask?.ready ?? progress.semantic_ready);
      setProgressBar(acceleratorBar, legacyAccelerator ? 1 : (acceleratorTask?.done ?? acceleratorDone), legacyAccelerator ? 1 : (acceleratorTask?.total ?? acceleratorTotal), legacyAccelerator || (acceleratorTask?.ready ?? progress.accelerator_ready));
      setProgressBar(multiProfileBar, legacyMultiProfile ? 1 : (multiProfileTask?.done ?? multiProfileDone), legacyMultiProfile ? 1 : (multiProfileTask?.total ?? multiProfileTotal), legacyMultiProfile || (multiProfileTask?.ready ?? progress.multi_profile_ready));

      if (modelSelect) modelSelect.disabled = busy;
      if (modelDownloadButton) modelDownloadButton.disabled = !!progress.model_ready || !progress.model_supported || (modelTask ? !modelTask.can_start : (busy || refreshing));
      if (modelDeleteButton) modelDeleteButton.disabled = !progress.model_supported || (modelTask ? !modelTask.can_delete : (busy || !progress.model_ready));
      if (vectorBuildButton) vectorBuildButton.disabled = vectorTask ? !vectorTask.can_start : (busy || !progress.model_ready || !vectorTotal);
      const vectorPauseAvailable = progress.building && activeTask === "semantic_vectors";
      if (vectorPauseButton) {
        vectorPauseButton.hidden = !vectorPauseAvailable;
        vectorPauseButton.disabled = !vectorPauseAvailable || !!progress.vector_pause_requested;
      }
      if (vectorDeleteButton) vectorDeleteButton.disabled = vectorTask ? !vectorTask.can_delete : (busy || vectorDone <= 0);
      if (acceleratorBuildButton) acceleratorBuildButton.disabled = acceleratorTask ? !acceleratorTask.can_start : (busy || !progress.model_ready || vectorDone <= 0);
      if (acceleratorDeleteButton) acceleratorDeleteButton.disabled = acceleratorTask ? !acceleratorTask.can_delete : (busy || (!progress.accelerator_ready && acceleratorDone <= 0));
      if (multiProfileBuildButton) multiProfileBuildButton.disabled = multiProfileTask ? !multiProfileTask.can_start : (busy || vectorDone <= 0);
      if (multiProfileDeleteButton) multiProfileDeleteButton.disabled = multiProfileTask ? !multiProfileTask.can_delete : (busy || !progress.multi_profile_bytes);
      if (retrievalMode) retrievalMode.disabled = busy;
      if (rerankerDownloadButton) {
        rerankerDownloadButton.disabled = busy || !!progress.reranker_ready;
        rerankerDownloadButton.textContent = progress.reranker_downloaded ? semText("semLoadReranker", "Load reranker") : semText("semDownloadReranker", "Download reranker");
      }
      if (rerankerDeleteButton) rerankerDeleteButton.disabled = busy || !progress.reranker_downloaded;
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

    async function refresh(reconcile = false) {
      if (statusInFlight) return;
      statusInFlight = true;
      try {
        if (reconcile) setStatus(semText("semReadingStatus", "Checking index status in the background…"), "busy");
        render(await invoke("semantic_tasks", { reconcile }));
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
      global.setTimeout(() => { void refresh(false); }, 30);
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
      if (next === current) return;
      if (!confirmAction("切换模型会使用一套独立的语义索引。切换后请下载新模型并重新建立语义索引；原模型的缓存会被保留。是否继续？")) {
        modelSelect.value = current;
        return;
      }
      const cachedNext = cache.use(next);
      if (cachedNext) render(cachedNext);
      modelSelect.disabled = true;
      setStatus("正在切换语义模型…", "busy");
      try {
        await invoke("select_semantic_model", { modelId: next });
        // 切换模型后自动后台核对该模型的索引；打开设置本身不触发这项扫描。
        await refresh(true);
      } catch (error) {
        modelSelect.value = current;
        setStatus("切换模型失败：" + error, "error");
      } finally {
        modelSelect.disabled = false;
      }
    });
    on(gpuRefreshButton, "click", refreshGpuStatus);
    on(gpuInstallButton, "click", installGpuRuntime);
    on(vectorBuildButton, "click", () => run("build_semantic_vectors", "正在启动语义索引任务…", "启动语义索引失败："));
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
    on(rerankerDownloadButton, "click", () => run("download_semantic_reranker", "正在下载重排模型…", "下载重排模型失败："));
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
