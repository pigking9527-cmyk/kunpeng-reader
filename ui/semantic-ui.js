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

    let pollTimer = null;
    let statusInFlight = false;
    let visible = false;
    const listeners = [];

    function on(element, eventName, handler) {
      if (!element) return;
      element.addEventListener(eventName, handler);
      listeners.push(() => element.removeEventListener(eventName, handler));
    }

    function formatBytes(value) {
      const bytes = Number(value || 0);
      if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB";
      if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
      if (bytes >= 1024) return (bytes / 1024).toFixed(1) + " KB";
      return bytes ? bytes + " B" : "0 B";
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
        pollTimer = global.setInterval(refresh, 1500);
      } else if ((!visible || !shouldPoll) && pollTimer) {
        global.clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    function render(payload = {}) {
      const center = Array.isArray(payload?.tasks) ? payload : null;
      let progress = center ? center.progress || {} : payload;
      progress = cache.merge(progress);
      const busy = !!(progress.building || progress.model_downloading);
      const refreshing = !!progress.status_refreshing;
      // 后端正在后台校验时，任务 detail 只是“正在读取…”。优先展示上次可靠快照，
      // 避免四张卡片一起闪回加载态；按钮仍保持禁用直到校验完成。
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
      const vectorSize = progress.semantic_bytes ? "，占用 " + formatBytes(progress.semantic_bytes) : "";
      const acceleratorSize = progress.accelerator_bytes ? "，占用 " + formatBytes(progress.accelerator_bytes) : "";
      const multiProfileSize = progress.multi_profile_bytes ? "，占用 " + formatBytes(progress.multi_profile_bytes) : "";
      const legacyAccelerator = legacyCompleted(acceleratorTask, acceleratorTotal, progress.accelerator_bytes);
      const legacyMultiProfile = legacyCompleted(multiProfileTask, multiProfileTotal, progress.multi_profile_bytes);
      const activeModel = progress.model_id || modelSelect?.value || "bge-small-zh-v1.5";
      const modelPresentation = {
        "bge-small-zh-v1.5": {
          title: "轻量语义检索 · BGE Small 中文",
          copy: "默认的轻量中文语义模型，适合大多数书库；下载、建索引和查询都更快，占用也更小。"
        },
        "bge-large-zh-v1.5": {
          title: "高精度语义检索 · BGE Large 中文",
          copy: "适合更看重中文语义区分度的书库。精度更高，但模型下载、建索引和查询开销也更大。"
        }
      }[activeModel];

      if (modelSetupTitle && modelPresentation) modelSetupTitle.textContent = modelPresentation.title;
      if (modelSetupCopy && modelPresentation) modelSetupCopy.textContent = modelPresentation.copy;

      if (modelSelect && progress.model_id) modelSelect.value = progress.model_id;

      const modelLabel = progress.model_label ? progress.model_label + " · " : "";
      if (modelMeta) {
        modelMeta.textContent = modelTask?.detail
          ? modelLabel + modelTask.detail + (modelTask.bytes ? "，缓存大小 " + formatBytes(modelTask.bytes) : "")
          : !progress.model_supported
          ? modelLabel + "官方尚未提供可用于本地端的 ONNX 权重。"
          : progress.model_downloading
          ? modelLabel + "正在下载/加载模型…"
          : progress.model_ready
          ? modelLabel + "已就绪" + (progress.model_bytes ? "，缓存大小 " + formatBytes(progress.model_bytes) : "")
          : refreshing
          ? modelLabel + "正在读取模型状态…"
          : modelLabel + "未下载。";
      }
      if (vectorMeta) {
        vectorMeta.textContent = vectorTask?.detail
          ? vectorTask.detail + (vectorTask.bytes ? "，占用 " + formatBytes(vectorTask.bytes) : "")
          : refreshing && !vectorTotal
          ? "正在读取语义索引状态…"
          : vectorTotal
          ? vectorDone + "/" + vectorTotal + " 本" + (progress.semantic_ready ? "，已完成" : "") + vectorSize
          : "书架中暂无可建立语义索引的图书";
      }
      if (acceleratorMeta) {
        acceleratorMeta.textContent = legacyAccelerator
          ? "已建立（旧版索引，更新后可用于当前算法）" + acceleratorSize
          : acceleratorTask?.detail
          ? acceleratorTask.detail + (acceleratorTask.bytes ? "，占用 " + formatBytes(acceleratorTask.bytes) : "")
          : refreshing && !acceleratorTotal
          ? "正在读取加速索引状态…"
          : acceleratorTotal
          ? acceleratorDone + "/" + acceleratorTotal + " 片" + (progress.accelerator_ready ? "，已完成" : (progress.accelerator_resumable ? "，可续建" : "")) + acceleratorSize
          : "建立语义索引后可建立加速索引";
      }
      if (multiProfileMeta) {
        multiProfileMeta.textContent = legacyMultiProfile
          ? "已建立（旧版画像，更新后可用于当前算法）" + multiProfileSize
          : multiProfileTask?.detail
          ? multiProfileTask.detail + (multiProfileTask.bytes ? "，占用 " + formatBytes(multiProfileTask.bytes) : "")
          : refreshing && !multiProfileTotal
          ? "正在读取多中心画像状态…"
          : multiProfileTotal
          ? multiProfileDone + "/" + multiProfileTotal + " 本" + (progress.multi_profile_ready ? "，已完成" : (multiProfileDone ? "，需要更新" : "")) + multiProfileSize
          : "建立语义索引后可生成多中心画像";
      }

      setProgressBar(vectorBar, vectorTask?.done ?? vectorDone, vectorTask?.total ?? vectorTotal, vectorTask?.ready ?? progress.semantic_ready);
      setProgressBar(acceleratorBar, legacyAccelerator ? 1 : (acceleratorTask?.done ?? acceleratorDone), legacyAccelerator ? 1 : (acceleratorTask?.total ?? acceleratorTotal), legacyAccelerator || (acceleratorTask?.ready ?? progress.accelerator_ready));
      setProgressBar(multiProfileBar, legacyMultiProfile ? 1 : (multiProfileTask?.done ?? multiProfileDone), legacyMultiProfile ? 1 : (multiProfileTask?.total ?? multiProfileTotal), legacyMultiProfile || (multiProfileTask?.ready ?? progress.multi_profile_ready));

      if (modelSelect) modelSelect.disabled = busy || refreshing;
      if (modelDownloadButton) modelDownloadButton.disabled = !progress.model_supported || (modelTask ? !modelTask.can_start : (busy || refreshing));
      if (modelDeleteButton) modelDeleteButton.disabled = !progress.model_supported || (modelTask ? !modelTask.can_delete : (busy || !progress.model_ready));
      if (vectorBuildButton) vectorBuildButton.disabled = vectorTask ? !vectorTask.can_start : (busy || refreshing || !progress.model_ready || !vectorTotal);
      const vectorPauseAvailable = progress.building && activeTask === "semantic_vectors";
      if (vectorPauseButton) {
        vectorPauseButton.hidden = !vectorPauseAvailable;
        vectorPauseButton.disabled = !vectorPauseAvailable || !!progress.vector_pause_requested || refreshing;
      }
      if (vectorDeleteButton) vectorDeleteButton.disabled = vectorTask ? !vectorTask.can_delete : (busy || vectorDone <= 0);
      if (acceleratorBuildButton) acceleratorBuildButton.disabled = acceleratorTask ? !acceleratorTask.can_start : (busy || refreshing || !progress.model_ready || vectorDone <= 0);
      if (acceleratorDeleteButton) acceleratorDeleteButton.disabled = acceleratorTask ? !acceleratorTask.can_delete : (busy || (!progress.accelerator_ready && acceleratorDone <= 0));
      if (multiProfileBuildButton) multiProfileBuildButton.disabled = multiProfileTask ? !multiProfileTask.can_start : (busy || refreshing || vectorDone <= 0);
      if (multiProfileDeleteButton) multiProfileDeleteButton.disabled = multiProfileTask ? !multiProfileTask.can_delete : (busy || !progress.multi_profile_bytes);
      if (modelDownloadButton) modelDownloadButton.textContent = modelTask?.primary_label || "下载模型";
      if (modelDeleteButton) modelDeleteButton.textContent = modelTask?.delete_label || "删除模型";
      if (vectorBuildButton) vectorBuildButton.textContent = vectorTask?.primary_label || (vectorDone > 0 && !progress.semantic_ready ? "续建语义索引" : "建立语义索引");
      if (vectorPauseButton) vectorPauseButton.textContent = progress.vector_pause_requested ? "正在暂停…" : "暂停";
      if (vectorDeleteButton) vectorDeleteButton.textContent = vectorTask?.delete_label || "删除";
      if (acceleratorBuildButton) acceleratorBuildButton.textContent = legacyAccelerator ? "更新加速索引" : (acceleratorTask?.primary_label || (progress.accelerator_resumable ? "续建加速索引" : "建立加速索引"));
      if (acceleratorDeleteButton) acceleratorDeleteButton.textContent = acceleratorTask?.delete_label || "删除";
      if (multiProfileBuildButton) multiProfileBuildButton.textContent = legacyMultiProfile ? "更新多中心画像" : (multiProfileTask?.primary_label || (multiProfileDone > 0 && !progress.multi_profile_ready ? "更新多中心画像" : "建立多中心画像"));
      if (multiProfileDeleteButton) multiProfileDeleteButton.textContent = multiProfileTask?.delete_label || "删除";

      if (progress.error) setStatus(progress.error, "error");
      else if (progress.model_downloading || progress.building) setStatus(progress.current || "任务正在后台运行…", "busy");
      else if (refreshing) setStatus("正在后台读取索引状态…", "busy");
      else setStatus(progress.current || "", progress.current ? "ok" : "");

      updatePolling(!!(progress.model_downloading || progress.building || refreshing));
      if (!refreshing || progress.model_ready || vectorTotal || acceleratorTotal || multiProfileTotal || progress.building || progress.model_downloading) {
        cache.save(progress);
      }
    }

    async function refresh() {
      if (statusInFlight) return;
      statusInFlight = true;
      try {
        render(await invoke("semantic_tasks"));
      } catch (error) {
        setStatus("读取语义索引状态失败：" + error, "error");
      } finally {
        statusInFlight = false;
      }
    }

    function open() {
      settingsModal?.classList.remove("show");
      modal?.classList.add("show");
      visible = true;
      const cached = cache.get();
      if (cached) render(cached);
      global.setTimeout(refresh, 30);
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
      modelSelect.disabled = true;
      setStatus("正在切换语义模型…", "busy");
      try {
        await invoke("select_semantic_model", { modelId: next });
        cache.clear();
        await refresh();
      } catch (error) {
        modelSelect.value = current;
        setStatus("切换模型失败：" + error, "error");
      } finally {
        modelSelect.disabled = false;
      }
    });
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

    function destroy() {
      visible = false;
      updatePolling(false);
      for (const remove of listeners.splice(0)) remove();
      activeController = null;
    }

    activeController = Object.freeze({ close, destroy, open, refresh, render });
    return activeController;
  }

  global.ReaderSemanticUI = Object.freeze({ init });
})(typeof window !== "undefined" ? window : globalThis);
