// Book classification belongs to Smart settings.  The generated model tags
// stay separate from manual tags; this page only controls their local use.
window.ReaderBookClassificationSettingsUI = {
  init({ invoke }) {
    const modal = document.getElementById("book-classification-settings-modal");
    const openButton = document.getElementById("book-classification-settings-open");
    const closeButton = document.getElementById("book-classification-settings-close");
    const runButton = document.getElementById("book-classification-settings-run");
    const status = document.getElementById("book-classification-settings-status");
    const useModelTags = document.getElementById("set-use-model-tags");
    if (!modal || !openButton || !closeButton || !runButton || !status || !useModelTags || typeof invoke !== "function") return;

    let poll = 0;
    const stopPoll = () => {
      if (poll) window.clearInterval(poll);
      poll = 0;
    };
    const startPoll = () => {
      if (!poll) poll = window.setInterval(() => { void refresh(); }, 900);
    };
    const setStatus = (text) => {
      status.textContent = text;
      status.title = text;
    };
    async function refreshTagSetting() {
      const settings = await invoke("library_model_tags_settings");
      useModelTags.checked = settings?.enabled !== false;
    }
    async function refresh() {
      try {
        const [task, coverage] = await Promise.all([
          invoke("library_profile_status"),
          invoke("library_profile_coverage_status"),
          refreshTagSetting(),
        ]);
        const active = task && ["queued", "running", "pausing"].includes(task.state);
        const total = Number(coverage?.totalBooks || 0);
        const incomplete = Number(coverage?.incompleteBooks || 0);
        const complete = Math.max(0, total - incomplete);
        if (active) {
          const progress = task.progress || {};
          setStatus(task.current || `正在分类（${Number(progress.done || 0)}/${Number(progress.total || total)}）`);
          runButton.disabled = true;
          runButton.textContent = "正在分类";
          startPoll();
          return;
        }
        stopPoll();
        runButton.disabled = false;
        if (task?.state === "paused") {
          setStatus(`${task.current || "书籍分类已中断"}；可从已保存的位置继续`);
          runButton.textContent = "继续分类";
          return;
        }
        if (!total) {
          setStatus("尚未发现可分类的图书");
        } else if (task?.state === "failed") {
          setStatus(task.error || "书籍分类失败，可重新开始");
        } else {
          setStatus(`已完成 ${complete} / ${total} 本图书的分类`);
        }
        runButton.textContent = "开始分类";
      } catch (error) {
        stopPoll();
        runButton.disabled = false;
        runButton.textContent = "重新读取";
        setStatus(`分类状态读取失败：${String(error)}`);
      }
    }
    const close = () => {
      modal.classList.remove("show");
      stopPoll();
    };
    const open = () => {
      modal.classList.add("show");
      void refresh();
    };
    window.ReaderBookClassificationSettingsUI.open = open;
    window.ReaderBookClassificationSettingsUI.close = close;
    openButton.addEventListener("click", open);
    closeButton.addEventListener("click", close);
    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    runButton.addEventListener("click", async () => {
      runButton.disabled = true;
      setStatus("正在建立分类任务…");
      try {
        await invoke("start_library_auto_classification");
        await refresh();
      } catch (error) {
        runButton.disabled = false;
        setStatus(String(error));
      }
    });
    useModelTags.addEventListener("change", async () => {
      const enabled = useModelTags.checked;
      useModelTags.disabled = true;
      try {
        const settings = await invoke("set_library_model_tags_enabled", { enabled });
        useModelTags.checked = settings?.enabled !== false;
        window.dispatchEvent(new CustomEvent("library-model-tags-setting-changed", { detail: { enabled: useModelTags.checked } }));
      } catch (error) {
        useModelTags.checked = !enabled;
        window.AppDialog?.alert?.("保存大模型分类标签设置失败：" + error, { title: "书籍分类", confirmLabel: "关闭", tone: "error" });
      } finally {
        useModelTags.disabled = false;
      }
    });
  },
};
