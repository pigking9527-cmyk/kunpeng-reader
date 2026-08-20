import {
  createTauriApi,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface TaskProgress {
  readonly done?: unknown;
  readonly total?: unknown;
}

interface ClassificationTask {
  readonly state?: unknown;
  readonly current?: unknown;
  readonly progress?: TaskProgress | null;
  readonly error?: unknown;
}

interface ClassificationCoverage {
  readonly totalBooks?: unknown;
  readonly incompleteBooks?: unknown;
}

interface ModelTagsSettings {
  readonly enabled?: unknown;
}

type BookClassificationCommands = {
  library_model_tags_settings: { readonly result: ModelTagsSettings | null };
  library_profile_status: { readonly result: ClassificationTask | null };
  library_profile_coverage_status: {
    readonly result: ClassificationCoverage | null;
  };
  start_library_auto_classification: { readonly result: unknown };
  set_library_model_tags_enabled: {
    readonly args: { readonly enabled: boolean };
    readonly result: ModelTagsSettings | null;
  };
};

type VerifiedBookClassificationCommands =
  BookClassificationCommands extends TauriCommandMap ? BookClassificationCommands : never;

interface AlertDialog {
  alert?(
    message: unknown,
    options?: Readonly<Record<string, unknown>>,
  ): Promise<boolean> | void;
}

interface BookClassificationRuntime extends Record<string, unknown> {
  readonly document: Document;
  readonly AppDialog?: AlertDialog;
  clearInterval(timer: ReturnType<typeof setInterval> | 0): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  dispatchEvent(event: Event): boolean;
  ReaderBookClassificationSettingsUI?: BookClassificationSettingsUiApi;
}

export interface BookClassificationInitOptions {
  readonly invoke?: TauriTransport["invoke"];
}

export interface BookClassificationSettingsUiApi {
  init(options?: BookClassificationInitOptions): void;
  open?(): void;
  close?(): void;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): BookClassificationRuntime | null {
  const runtime = record(value);
  if (
    !runtime ||
    !record(runtime.document) ||
    typeof runtime.clearInterval !== "function" ||
    typeof runtime.setInterval !== "function" ||
    typeof runtime.dispatchEvent !== "function"
  ) {
    return null;
  }
  return runtime as unknown as BookClassificationRuntime;
}

export function createBookClassificationSettingsUi(
  runtime: BookClassificationRuntime,
): BookClassificationSettingsUiApi {
  const publicApi: BookClassificationSettingsUiApi = {
    init: (options: BookClassificationInitOptions = {}): void => {
      const modal = runtime.document.getElementById(
        "book-classification-settings-modal",
      ) as HTMLElement | null;
      const openButton = runtime.document.getElementById(
        "book-classification-settings-open",
      ) as HTMLButtonElement | null;
      const closeButton = runtime.document.getElementById(
        "book-classification-settings-close",
      ) as HTMLButtonElement | null;
      const runButton = runtime.document.getElementById(
        "book-classification-settings-run",
      ) as HTMLButtonElement | null;
      const status = runtime.document.getElementById(
        "book-classification-settings-status",
      ) as HTMLElement | null;
      const useModelTags = runtime.document.getElementById(
        "set-use-model-tags",
      ) as HTMLInputElement | null;
      const invoke = options.invoke;
      if (
        !modal ||
        !openButton ||
        !closeButton ||
        !runButton ||
        !status ||
        !useModelTags ||
        typeof invoke !== "function"
      ) {
        return;
      }
      const api = createTauriApi<VerifiedBookClassificationCommands>({ invoke });

      let poll: ReturnType<typeof setInterval> | 0 = 0;
      const stopPoll = (): void => {
        if (poll) runtime.clearInterval(poll);
        poll = 0;
      };
      const setStatus = (text: unknown): void => {
        status.textContent = String(text);
        status.title = String(text);
      };
      const refreshTagSetting = async (): Promise<void> => {
        const settings = await api.invoke("library_model_tags_settings");
        useModelTags.checked = settings?.enabled !== false;
      };
      const refresh = async (): Promise<void> => {
        try {
          const [task, coverage] = await Promise.all([
            api.invoke("library_profile_status"),
            api.invoke("library_profile_coverage_status"),
            refreshTagSetting(),
          ]);
          const activeStates: readonly unknown[] = ["queued", "running", "pausing"];
          const active = Boolean(task && activeStates.includes(task.state));
          const total = Number(coverage?.totalBooks || 0);
          const incomplete = Number(coverage?.incompleteBooks || 0);
          const complete = Math.max(0, total - incomplete);
          if (active) {
            const progress = task?.progress || {};
            setStatus(
              task?.current ||
                `正在分类（${Number(progress.done || 0)}/${Number(progress.total || total)}）`,
            );
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
      };
      const startPoll = (): void => {
        if (!poll) {
          poll = runtime.setInterval(() => {
            void refresh();
          }, 900);
        }
      };
      const close = (): void => {
        modal.classList.remove("show");
        stopPoll();
      };
      const open = (): void => {
        modal.classList.add("show");
        void refresh();
      };
      publicApi.open = open;
      publicApi.close = close;
      openButton.addEventListener("click", open);
      closeButton.addEventListener("click", close);
      modal.addEventListener("click", (event) => {
        if (event.target === modal) close();
      });
      runButton.addEventListener("click", async () => {
        runButton.disabled = true;
        setStatus("正在建立分类任务…");
        try {
          await api.invoke("start_library_auto_classification");
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
          const settings = await api.invoke("set_library_model_tags_enabled", { enabled });
          useModelTags.checked = settings?.enabled !== false;
          runtime.dispatchEvent(
            new CustomEvent("library-model-tags-setting-changed", {
              detail: { enabled: useModelTags.checked },
            }),
          );
        } catch (error) {
          useModelTags.checked = !enabled;
          void runtime.AppDialog?.alert?.(`保存大模型分类标签设置失败：${String(error)}`, {
            title: "书籍分类",
            confirmLabel: "关闭",
            tone: "error",
          });
        } finally {
          useModelTags.disabled = false;
        }
      });
    },
  };
  return publicApi;
}

/** Classic installer replacing `ui/book-classification-settings-ui.js`. */
export function installBookClassificationSettingsUi(
  target: unknown,
): BookClassificationSettingsUiApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  const api = createBookClassificationSettingsUi(runtime);
  runtime.ReaderBookClassificationSettingsUI = api;
  return api;
}
