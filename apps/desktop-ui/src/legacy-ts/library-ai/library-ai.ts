import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

type LibraryMode = "question" | "compare" | "recommend";
type AnswerLength = "short" | "medium" | "long";
type HistorySyncMode = "off" | "recent" | "manual";
interface UiElement extends HTMLElement {
  value: string;
  placeholder: string;
  disabled: boolean;
  checked: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
  readonly options: HTMLOptionsCollection;
  setRangeText(replacement: string, start: number, end: number, selectionMode?: SelectionMode): void;
}

interface LibraryBook extends Record<string, unknown> {
  readonly id: string | number;
  readonly title?: string;
  readonly author?: string;
  readonly description?: string;
  readonly summary?: string;
  readonly missing?: boolean;
  readonly contentId?: string;
  readonly content_id?: string;
  readonly tags?: readonly string[];
  readonly modelTags?: readonly string[];
  readonly collections?: readonly string[];
}

interface LibrarySource extends Record<string, unknown> {
  readonly bookId?: string | number;
  readonly bookTitle?: string;
  readonly chapter?: number;
  readonly sourceKind?: string;
  readonly excerpt?: string;
  readonly unavailable?: boolean;
  readonly unavailableReason?: string;
  readonly recoveryNeeded?: boolean;
  readonly deletedAt?: string;
  readonly deleted_at?: string;
}

interface RecommendationItem extends Record<string, unknown> {
  readonly bookId: string | number;
  readonly title?: string;
  readonly review?: string;
}

interface LibraryRecommendation extends Record<string, unknown> {
  readonly summary?: string;
  readonly items: readonly RecommendationItem[];
}

interface LibraryAnswer extends Record<string, unknown> {
  readonly content: string;
  readonly sources: readonly LibrarySource[];
  readonly singleBook?: boolean;
  readonly recommendation?: LibraryRecommendation;
  readonly retrievalStages?: readonly string[];
}

interface LibraryHistoryEntry extends Record<string, unknown> {
  readonly id?: string;
  readonly at?: string;
  readonly task?: LibraryMode;
  readonly question?: string;
  readonly content?: string;
  readonly sources?: readonly LibrarySource[];
  readonly cloudSaved?: boolean;
  readonly deletedAt?: string;
  readonly deleted_at?: string;
}

interface LibraryHistorySnapshot extends Record<string, unknown> {
  readonly entries?: readonly LibraryHistoryEntry[];
  readonly syncEnabled?: boolean;
  readonly syncMode?: HistorySyncMode;
}
interface LocalHistorySourceCacheEntry {
  readonly savedAt?: string;
  readonly sources?: readonly LibrarySource[];
}
type LocalHistorySources = Record<string, LocalHistorySourceCacheEntry>;

interface SemanticStatus extends Record<string, unknown> {
  readonly model_id?: string;
  readonly model_ready?: boolean;
  readonly semantic_ready?: boolean;
  readonly semantic_done?: number;
  readonly status_refreshing?: boolean;
  readonly m3_long_context_enabled?: boolean;
}

interface AiStatus extends Record<string, unknown> { readonly configured?: boolean; }
interface AiProfile extends Record<string, unknown> {
  readonly id: string;
  readonly name?: string;
  readonly model?: string;
  readonly configured?: boolean;
  readonly localLibraryAiEligible?: boolean;
}
interface AiProfiles extends Record<string, unknown> {
  readonly profiles?: readonly AiProfile[];
  readonly assignments?: { readonly libraryId?: string };
  readonly activeId?: string;
}
interface LibraryAnswerSettings extends Record<string, unknown> {
  readonly answerLength?: AnswerLength;
  readonly recommendationCandidateLimit?: number;
  readonly recommendationResultLimit?: number;
}
interface AppSettingsSnapshot extends Record<string, unknown> {
  readonly hasLibraryAnswerSettings?: boolean;
  readonly libraryAnswerLength?: AnswerLength;
  readonly libraryHistorySyncMode?: HistorySyncMode;
  readonly libraryAnswerFontSize?: number;
  readonly libraryLongContextEnabled?: boolean;
}
interface SemanticTasks extends Record<string, unknown> { readonly progress?: SemanticStatus; }
interface ModelTagsSettings extends Record<string, unknown> { readonly enabled?: boolean; }

type LibraryAiCommands = {
  readonly app_settings_sync_save: { readonly args: { readonly request: Record<string, unknown> }; readonly result: AppSettingsSnapshot };
  readonly app_settings_sync_get: { readonly result: AppSettingsSnapshot };
  readonly set_library_answer_length: { readonly args: { readonly request: { readonly answerLength: AnswerLength } }; readonly result: LibraryAnswerSettings };
  readonly private_sync_set_library_history_mode: { readonly args: { readonly request: { readonly syncMode: HistorySyncMode } }; readonly result: LibraryHistorySnapshot };
  readonly set_semantic_m3_long_context: { readonly args: { readonly enabled: boolean }; readonly result: null };
  readonly semantic_status: { readonly result: SemanticStatus };
  readonly set_library_recommendation_candidate_limit: { readonly args: { readonly request: { readonly candidateLimit: number } }; readonly result: LibraryAnswerSettings };
  readonly set_library_recommendation_result_limit: { readonly args: { readonly request: { readonly resultLimit: number } }; readonly result: LibraryAnswerSettings };
  readonly list_books: { readonly result: readonly LibraryBook[] };
  readonly open_book_at: { readonly args: { readonly request: { readonly id: string; readonly chapter: number; readonly term: string } }; readonly result: null };
  readonly library_history_source_preview: { readonly args: { readonly request: { readonly bookId: string; readonly bookTitle: string; readonly chapter: number; readonly sourceKind: string } }; readonly result: LibrarySource };
  readonly private_sync_set_library_history_cloud_saved: { readonly args: { readonly request: { readonly id: string; readonly cloudSaved: boolean } }; readonly result: LibraryHistorySnapshot };
  readonly private_sync_library_history_delete: { readonly args: { readonly request: { readonly id: string } }; readonly result: LibraryHistorySnapshot };
  readonly private_sync_library_history_list: { readonly result: LibraryHistorySnapshot };
  readonly private_sync_library_history_merge: { readonly args: { readonly request: { readonly entries: readonly LibraryHistoryEntry[] } }; readonly result: LibraryHistorySnapshot };
  readonly ask_library_assistant: { readonly args: { readonly request: { readonly task: LibraryMode; readonly question: string; readonly selectedBookIds: readonly string[] } }; readonly result: LibraryAnswer };
  readonly ai_reader_status: { readonly result: AiStatus };
  readonly ai_reader_profiles: { readonly result: AiProfiles };
  readonly semantic_tasks: { readonly args: { readonly reconcile: boolean }; readonly result: SemanticTasks };
  readonly library_model_tags_settings: { readonly result: ModelTagsSettings };
  readonly library_answer_settings: { readonly result: LibraryAnswerSettings };
  readonly assign_ai_reader_profile: { readonly args: { readonly request: { readonly purpose: "library"; readonly id: string } }; readonly result: AiProfiles };
  readonly save_recommended_booklist: { readonly args: { readonly name: string; readonly description: string; readonly bookIds: readonly string[]; readonly reviews: Readonly<Record<string, string>> }; readonly result: null };
};
type VerifiedLibraryAiCommands = LibraryAiCommands extends TauriCommandMap ? LibraryAiCommands : never;

interface AppI18n { t?(key: string): string; }
interface SemanticStatusCache { merge?(status: SemanticStatus): SemanticStatus; }
interface BookClassificationSettings { open?(): void; }
interface LibraryAiRuntime extends Window {
  ReaderAppI18n?: AppI18n;
  ReaderSemanticStatusCache?: SemanticStatusCache;
  ReaderBookClassificationSettingsUI?: BookClassificationSettings;
  ReaderLibraryAiUI?: LibraryAiUi;
}
interface LibraryAiAssistant {
  load(): Promise<void>;
  refreshBooks(): Promise<void>;
  run(): Promise<void>;
  setMode(next: LibraryMode): void;
  renderBooks(): void;
}
interface LibraryAiUi {
  readonly init: (options?: LibraryAiInitOptions) => LibraryAiAssistant | null;
  readonly MAX_QUESTION_SOURCES: number;
  readonly MAX_COMPARE_BOOKS: number;
}
interface LibraryAiInitOptions {
  readonly root?: Document;
  readonly transport?: TauriTransport;
  readonly invoke?: TauriTransport["invoke"];
}

function asRuntime(value: unknown): LibraryAiRuntime | null {
  return typeof value === "object" && value !== null && "document" in value
    ? value as LibraryAiRuntime
    : null;
}

export function createLibraryAiUi(global: LibraryAiRuntime, injectedTransport?: TauriTransport): LibraryAiUi {
  "use strict";
  const MAX_COMPARE_BOOKS = 8;
  const MAX_QUESTION_SOURCES = 20;
  const DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT = 20;
  const DEFAULT_RECOMMENDATION_RESULT_LIMIT = 12;
  const ANSWER_FONT_SIZE_KEY = "libraryAiAnswerFontSizeV1";
  const HISTORY_LAYOUT_KEY = "libraryAiHistoryLayoutV1";
  const HISTORY_SOURCES_KEY = "libraryAiHistorySourcesV1";
  const HISTORY_SOURCE_MAX_CHARS = 2400;
  const HISTORY_SOURCE_CARD_CHARS = 520;
  const HISTORY_SOURCE_POPUP_CHARS = 900;
  const DEFAULT_ANSWER_FONT_SIZE = 16;
  const MIN_ANSWER_FONT_SIZE = 14;
  const MAX_ANSWER_FONT_SIZE = 22;
  const i18n = (key: string, fallback: string): string => global.ReaderAppI18n?.t?.(key) || fallback;
  const i18nFormat = (key: string, fallback: string, values: Readonly<Record<string, unknown>> = {}): string => Object.entries(values).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), i18n(key, fallback));

  function init({ root = global.document, transport, invoke }: LibraryAiInitOptions = {}): LibraryAiAssistant | null {
    const selectedTransport = transport ?? injectedTransport ?? (invoke ? { invoke } : transportFromTauriGlobal(global));
    const api = createTauriApi<VerifiedLibraryAiCommands>(selectedTransport);
    const $ = (id: string): UiElement => root.getElementById(id) as UiElement;
    const page = $("library-ai-page");
    const booksEl = $("books"), stateEl = $("state"), answerEl = $("answer"), sourcesEl = $("sources"), sourceList = $("source-list"), sourcePreview = $("source-preview");
    if (!page || !booksEl || !stateEl || !answerEl || !sourcesEl || !sourceList || !sourcePreview) return null;

    const selectedBookIds = new Set<string>();
    let books: LibraryBook[] = [], useModelTags = true, mode: LibraryMode = "question", running = false, loading = false, activeSource: LibrarySource | null = null, previewPinned = false, previewHideTimer: number | null = null;
    let booksRefreshVersion = 0;
    let libraryHistory: LibraryHistoryEntry[] = [], historySyncMode: HistorySyncMode = "off", showingHistory = false, latestAnswer: LibraryAnswer | null = null, latestRecommendation: LibraryRecommendation | null = null;
    let historyLayout: "list" | "grid" = "list";
    let answerFontSize = DEFAULT_ANSWER_FONT_SIZE, answerLength: AnswerLength = "short", recommendationCandidateLimit = DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT, recommendationResultLimit = DEFAULT_RECOMMENDATION_RESULT_LIMIT, semanticStatus: SemanticStatus | null = null;
    let appSettingsSyncReady = false, appSettingsSyncTimer = 0;
    let longContextHelpTimer: number | null = null;
    let questionContextMenu: HTMLElement | null = null;
    const organizationName = (value: unknown): string => String(value || "").trim();
    const organizationKey = (value: unknown): string => organizationName(value).toLocaleLowerCase("zh-CN");
    const tagsForBook = (book: LibraryBook): string[] => {
      const tags = Array.isArray(book.tags) ? book.tags : [];
      const modelTags = useModelTags && Array.isArray(book.modelTags) ? book.modelTags : [];
      return Array.from(new Set([...tags, ...modelTags].map(organizationName).filter(Boolean)));
    };
    const selectionLimit = () => mode === "compare" ? MAX_COMPARE_BOOKS : Infinity;
    const selectedIds = () => Array.from(selectedBookIds);

    function readAnswerFontSize() {
      try {
        const stored = Number(global.localStorage?.getItem(ANSWER_FONT_SIZE_KEY));
        return Number.isFinite(stored) ? Math.max(MIN_ANSWER_FONT_SIZE, Math.min(MAX_ANSWER_FONT_SIZE, Math.round(stored))) : DEFAULT_ANSWER_FONT_SIZE;
      } catch { return DEFAULT_ANSWER_FONT_SIZE; }
    }

    function applyAnswerFontSize(save = false) {
      answerEl.style.setProperty("--library-ai-answer-font-size", `${answerFontSize}px`);
      const output = $("library-ai-font-size"), decrease = $("library-ai-font-decrease"), increase = $("library-ai-font-increase");
      if (output) output.textContent = `${answerFontSize}px`;
      if (decrease) decrease.disabled = answerFontSize <= MIN_ANSWER_FONT_SIZE;
      if (increase) increase.disabled = answerFontSize >= MAX_ANSWER_FONT_SIZE;
      if (save) try { global.localStorage?.setItem(ANSWER_FONT_SIZE_KEY, String(answerFontSize)); } catch {}
    }

    function queueLibraryAnswerSettingsSync() {
      if (!appSettingsSyncReady || !invoke) return;
      global.clearTimeout(appSettingsSyncTimer);
      appSettingsSyncTimer = global.setTimeout(() => {
        api.invoke("app_settings_sync_save", {
          request: {
            libraryAnswerLength: answerLength,
            libraryHistorySyncMode: historySyncMode,
            libraryAnswerFontSize: answerFontSize,
            libraryLongContextEnabled: Boolean(semanticStatus?.m3_long_context_enabled),
          },
        }).catch(() => {});
      }, 180);
    }

    async function applySyncedLibraryAnswerSettings(remote: AppSettingsSnapshot): Promise<boolean> {
      if (!remote?.hasLibraryAnswerSettings) return false;
      appSettingsSyncReady = false;
      answerLength = remote.libraryAnswerLength && ["short", "medium", "long"].includes(remote.libraryAnswerLength) ? remote.libraryAnswerLength : "short";
      answerFontSize = Math.max(MIN_ANSWER_FONT_SIZE, Math.min(MAX_ANSWER_FONT_SIZE, Math.round(Number(remote.libraryAnswerFontSize) || DEFAULT_ANSWER_FONT_SIZE)));
      applyAnswerFontSize(true);
      try {
        const settings = await api.invoke("set_library_answer_length", { request: { answerLength } });
        answerLength = settings?.answerLength || answerLength;
        const snapshot = await api.invoke("private_sync_set_library_history_mode", {
          request: { syncMode: remote.libraryHistorySyncMode && ["off", "recent", "manual"].includes(remote.libraryHistorySyncMode) ? remote.libraryHistorySyncMode : "off" },
        });
        applyLibraryHistorySnapshot(snapshot);
        if (remote.libraryLongContextEnabled === false && semanticStatus?.m3_long_context_enabled) {
          await api.invoke("set_semantic_m3_long_context", { enabled: false });
          semanticStatus = await api.invoke("semantic_status");
        } else if (remote.libraryLongContextEnabled === true && semanticStatus?.model_id === "bge-m3") {
          await api.invoke("set_semantic_m3_long_context", { enabled: true });
          semanticStatus = await api.invoke("semantic_status");
        }
      } catch {
        // 保留本机值并在下次同步完成或重新打开书库问答时重试。
      } finally {
        appSettingsSyncReady = true;
        renderAnswerLengthSettings();
        if (showingHistory) renderLibraryHistory();
      }
      return true;
    }

    async function hydrateLibraryAnswerSettings() {
      try {
        const remote = await api.invoke("app_settings_sync_get");
        const applied = await applySyncedLibraryAnswerSettings(remote);
        appSettingsSyncReady = true;
        if (!applied) queueLibraryAnswerSettingsSync();
      } catch {
        appSettingsSyncReady = true;
      }
    }

    function readHistoryLayout() {
      try { return global.localStorage?.getItem(HISTORY_LAYOUT_KEY) === "grid" ? "grid" : "list"; }
      catch { return "list"; }
    }

    function applyHistoryLayout(list: HTMLElement, button: HTMLButtonElement, save = false): void {
      const grid = historyLayout === "grid";
      list.classList.toggle("grid", grid);
      const label = grid
        ? i18n("historyGridToList", "Grid view is active. Select to switch to list view.")
        : i18n("historyListToGrid", "List view is active. Select to switch to grid view.");
      button.title = label;
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", String(grid));
      const icon = button.querySelector("i");
      if (icon) icon.className = grid ? "library-ai-history-grid-icon" : "library-ai-history-list-icon";
      if (save) try { global.localStorage?.setItem(HISTORY_LAYOUT_KEY, historyLayout); } catch {}
    }

    function renderAnswerLengthSettings() {
      const overlay = $("library-ai-answer-settings-overlay");
      const trigger = $("library-ai-answer-settings");
      root.querySelectorAll<HTMLElement>("[data-answer-length]").forEach((button) => {
        const selected = button.dataset.answerLength === answerLength;
        button.setAttribute("aria-checked", String(selected));
      });
      root.querySelectorAll<HTMLElement>("[data-library-history-sync]").forEach((button) => {
        button.setAttribute("aria-checked", String(button.dataset.libraryHistorySync === historySyncMode));
      });      if (trigger) trigger.textContent = i18n("answerSettings", "Settings");
      const candidateLimit = $("library-ai-recommendation-candidate-limit");
      if (candidateLimit && root.activeElement !== candidateLimit) candidateLimit.value = String(recommendationCandidateLimit);
      const resultLimit = $("library-ai-recommendation-result-limit");
      if (resultLimit && root.activeElement !== resultLimit) resultLimit.value = String(recommendationResultLimit);
      if (overlay?.hidden && trigger) trigger.setAttribute("aria-expanded", "false");
      const longContext = $("library-ai-long-context");
      const m3Active = semanticStatus?.model_id === "bge-m3";
      const modelReady = Boolean(semanticStatus?.model_ready);
      const indexReady = Number(semanticStatus?.semantic_done || 0) > 0;
      const available = m3Active && modelReady && indexReady;
      if (longContext) {
        const enabled = Boolean(semanticStatus?.m3_long_context_enabled);
        longContext.setAttribute("aria-checked", String(enabled));
        longContext.classList.toggle("is-unavailable", !available);
        longContext.setAttribute("aria-disabled", String(!available));
        longContext.title = available
          ? i18n("toggleLongContextReading", "Toggle long-context reading")
          : i18n("longContextUnavailable", "This cannot be enabled yet. Click for setup instructions.");
      }
    }

    function closeAnswerLengthSettings() {
      const overlay = $("library-ai-answer-settings-overlay");
      if (overlay) overlay.hidden = true;
      $("library-ai-answer-settings")?.setAttribute("aria-expanded", "false");
    }

    function toggleAnswerLengthSettings() {
      const overlay = $("library-ai-answer-settings-overlay");
      if (!overlay) return;
      overlay.hidden = !overlay.hidden;
      $("library-ai-answer-settings")?.setAttribute("aria-expanded", String(!overlay.hidden));
      if (!overlay.hidden) $("library-ai-answer-settings-close")?.focus();
    }

    async function saveAnswerLength(length: string | undefined, button: HTMLButtonElement): Promise<void> {
      if (!length || !["short", "medium", "long"].includes(length)) return;
      const answerLengthToSave = length as AnswerLength;
      button.disabled = true;
      try {
        const settings = await api.invoke("set_library_answer_length", { request: { answerLength: answerLengthToSave } });
        answerLength = settings.answerLength || answerLengthToSave;
        queueLibraryAnswerSettingsSync();
        renderAnswerLengthSettings();
        state("", false);
      } catch (error) {
        state(i18nFormat("answerLengthSaveFailed", "Could not save answer length: {error}", { error: String(error) }), true);
      } finally {
        button.disabled = false;
      }
    }

    function applyLibraryHistorySnapshot(snapshot: LibraryHistorySnapshot | null | undefined): void {
      libraryHistory = hydrateLibraryHistory(snapshot?.entries || libraryHistory);
      historySyncMode = snapshot?.syncMode && ["off", "recent", "manual"].includes(snapshot.syncMode) ? snapshot.syncMode : "off";
    }

    async function saveLibraryHistorySyncMode(syncMode: string | undefined, button: HTMLButtonElement): Promise<void> {
      if (!syncMode || !["off", "recent", "manual"].includes(syncMode)) return;
      const historyMode = syncMode as HistorySyncMode;
      button.disabled = true;
      try {
        const snapshot = await api.invoke("private_sync_set_library_history_mode", { request: { syncMode: historyMode } });
        applyLibraryHistorySnapshot(snapshot);
        queueLibraryAnswerSettingsSync();
        renderAnswerLengthSettings();
        if (showingHistory) renderLibraryHistory();
        state(syncMode === "recent" ? "已开启最近回答同步；云端最多保留 100 条。" : syncMode === "manual" ? "已开启手动同步；可在问答记录中点“云端”保存。" : "书库问答将只保存在本机。", false);
      } catch (error) {
        state("保存回答同步设置失败：" + String(error), true);
      } finally {
        button.disabled = false;
      }
    }
    async function saveLongContext(enabled: boolean, checkbox: HTMLButtonElement): Promise<void> {
      checkbox.disabled = true;
      try {
        await api.invoke("set_semantic_m3_long_context", { enabled });
        semanticStatus = await api.invoke("semantic_status");
        queueLibraryAnswerSettingsSync();
        renderAnswerLengthSettings();
        state(enabled
          ? i18n("longContextEnabled", "Long-context reading is enabled.")
          : i18n("longContextDisabled", "Long-context reading is disabled."), false);
      } catch (error) {
        showLongContextHelp(longContextSetupPath());
        state(i18nFormat("longContextSaveFailed", "Could not set long-context reading: {error}", { error: String(error) }), true);
      } finally {
        checkbox.disabled = false;
        renderAnswerLengthSettings();
      }
    }

    function longContextSetupPath() {
      return i18n("longContextSetupPath", "Setup: Settings → Semantic index → choose BGE-M3 → download the model → build a semantic index; then return to Library Q&A → Settings to enable it.");
    }

    function showLongContextHelp(message: string): void {
      const help = $("library-ai-long-context-help");
      if (!help) return;
      if (longContextHelpTimer) global.clearTimeout(longContextHelpTimer);
      help.textContent = message;
      help.hidden = false;
      longContextHelpTimer = global.setTimeout(() => { help.hidden = true; }, 8_000);
    }

    function closeQuestionContextMenu() {
      questionContextMenu?.remove();
      questionContextMenu = null;
    }

    async function copyQuestionText(value: string): Promise<boolean> {
      if (!value) return false;
      if (global.navigator?.clipboard?.writeText) {
        try { await global.navigator.clipboard.writeText(value); return true; } catch {}
      }
      const fallback = root.createElement("textarea");
      fallback.value = value;
      fallback.setAttribute("aria-hidden", "true");
      fallback.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      root.body.appendChild(fallback);
      fallback.select();
      const copied = Boolean(root.execCommand?.("copy"));
      fallback.remove();
      return copied;
    }

    function insertQuestionText(value: string): void {
      const question = $("question");
      if (!question || !value) return;
      const start = Number(question.selectionStart || 0), end = Number(question.selectionEnd || start);
      question.setRangeText(value, start, end, "end");
      question.dispatchEvent(new Event("input", { bubbles: true }));
      question.focus({ preventScroll: true });
    }

    function showQuestionContextMenu(event: MouseEvent): void {
      event.preventDefault();
      event.stopPropagation();
      closeQuestionContextMenu();
      const question = $("question");
      const selectedText = question.value.slice(question.selectionStart || 0, question.selectionEnd || 0);
      const menu = root.createElement("div");
      menu.className = "library-ai-question-menu";
      menu.setAttribute("role", "menu");
      const addAction = (label: string, action: () => Promise<void>, disabled = false): void => {
        const button = root.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("pointerdown", (pointerEvent) => pointerEvent.preventDefault());
        button.addEventListener("click", async () => {
          closeQuestionContextMenu();
          await action();
        });
        menu.appendChild(button);
      };
      addAction(i18n("copy", "复制"), async () => {
        if (!(await copyQuestionText(selectedText))) state("无法复制所选文字。", true);
      }, !selectedText);
      addAction(i18n("cut", "剪切"), async () => {
        if (!(await copyQuestionText(selectedText))) { state("无法剪切所选文字。", true); return; }
        const start = Number(question.selectionStart || 0), end = Number(question.selectionEnd || start);
        question.setRangeText("", start, end, "start");
        question.dispatchEvent(new Event("input", { bubbles: true }));
        question.focus({ preventScroll: true });
      }, !selectedText);
      addAction(i18n("paste", "粘贴"), async () => {
        try {
          if (!global.navigator?.clipboard?.readText) throw new Error("clipboard unavailable");
          insertQuestionText(await global.navigator.clipboard.readText());
        }
        catch { state("无法读取剪贴板，请确认系统已允许阅读器访问剪贴板。", true); }
      });
      const width = 136, height = 126;
      menu.style.left = `${Math.max(8, Math.min(event.clientX, (global.innerWidth || width) - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(event.clientY, (global.innerHeight || height) - height - 8))}px`;
      root.body.appendChild(menu);
      questionContextMenu = menu;
    }

    function state(message: string, error = false): void {
      stateEl.textContent = message;
      stateEl.className = "library-ai-state" + (error ? " error" : "");
    }

    function readinessMessage(aiStatus: AiStatus, semanticStatusValue: SemanticStatus | null): string {
      const apiReady = Boolean(aiStatus?.configured);
      const indexReady = Boolean(semanticStatusValue?.semantic_ready) || Number(semanticStatusValue?.semantic_done || 0) > 0;
      if (apiReady && indexReady) return "";
      if (semanticStatusValue?.status_refreshing) return apiReady ? "" : "请先在设置中配置大模型接口和模型；远程服务还需要 API Key。";
      if (!apiReady && !indexReady) return "请先在设置中配置大模型接口和模型（远程服务还需要 API Key），并为本地图书建立语义索引。";
      if (!apiReady) return "请先在设置中配置大模型接口和模型；远程服务还需要 API Key。";
      return "请先在设置中为本地图书建立语义索引。";
    }

    async function saveRecommendationCandidateLimit(input: HTMLInputElement): Promise<void> {
      const candidateLimit = Math.round(Number(input.value));
      if (!Number.isFinite(candidateLimit) || candidateLimit < 5 || candidateLimit > 100) {
        input.value = String(recommendationCandidateLimit);
        state("推荐书单粗选数量请输入 5–100 本。", true);
        return;
      }
      input.disabled = true;
      try {
        const settings = await api.invoke("set_library_recommendation_candidate_limit", { request: { candidateLimit } });
        recommendationCandidateLimit = Number(settings?.recommendationCandidateLimit || candidateLimit);
        input.value = String(recommendationCandidateLimit);
        renderBooks();
        state(`推荐书单将先从本地粗选 ${recommendationCandidateLimit} 本。`, false);
      } catch (error) {
        input.value = String(recommendationCandidateLimit);
        state("保存推荐书单粗选数量失败：" + String(error), true);
      } finally {
        input.disabled = false;
      }
    }

    async function saveRecommendationResultLimit(input: HTMLInputElement): Promise<void> {
      const resultLimit = Math.round(Number(input.value));
      if (!Number.isFinite(resultLimit) || resultLimit < 5 || resultLimit > 30) {
        input.value = String(recommendationResultLimit);
        state("大模型精选数量请输入 5–30 本。", true);
        return;
      }
      input.disabled = true;
      try {
        const settings = await api.invoke("set_library_recommendation_result_limit", { request: { resultLimit } });
        recommendationResultLimit = Number(settings?.recommendationResultLimit || resultLimit);
        input.value = String(recommendationResultLimit);
        renderBooks();
        state(`大模型将从本地候选中精选 ${recommendationResultLimit} 本；候选不足时按实际本数。`, false);
      } catch (error) {
        input.value = String(recommendationResultLimit);
        state("保存大模型精选数量失败：" + String(error), true);
      } finally {
        input.disabled = false;
      }
    }

    const mergeSemanticStatus = (status: SemanticStatus | null | undefined): SemanticStatus => global.ReaderSemanticStatusCache?.merge?.(status ?? {}) || status || {};

    async function reconcileSemanticReadiness(aiStatus: AiStatus, initialStatus: SemanticStatus): Promise<void> {
      let status = mergeSemanticStatus(initialStatus);
      try {
        for (let attempt = 0; status?.status_refreshing && attempt < 20; attempt += 1) {
          await new Promise((resolve) => global.setTimeout(resolve, 500));
          status = mergeSemanticStatus(await api.invoke("semantic_status"));
        }
      } catch {
        return;
      }
      semanticStatus = status;
      renderAnswerLengthSettings();
      if (!running && !showingHistory) state(readinessMessage(aiStatus, semanticStatus), !aiStatus?.configured);
    }

    function renderModelProfiles(status: AiProfiles): void {
      const select = $("library-ai-model-profile");
      if (!select) return;
      const profiles = Array.isArray(status.profiles) ? status.profiles.filter((profile) => profile.configured) : [];
      select.replaceChildren();
      if (!profiles.length) {
        const option = root.createElement("option");
        option.value = "";
        option.textContent = "请先在设置中配置大模型";
        select.appendChild(option);
        select.disabled = true;
        return;
      }
      profiles.forEach((profile) => {
        const option = root.createElement("option");
        option.value = profile.id;
        const label = profile.name || profile.model || "已配置大模型";
        option.textContent = profile.localLibraryAiEligible
          ? `${label} · 本地 7B+`
          : label;
        select.appendChild(option);
      });
      const libraryId = status.assignments?.libraryId || status.activeId;
      select.value = profiles.some((profile) => profile.id === libraryId) ? libraryId : profiles[0].id;
      select.disabled = false;
    }

    function organizationEntries(field: "tags" | "collections"): Array<{ name: string; key: string; count: number }> {
      const entries = new Map<string, { name: string; key: string; count: number }>();
      books.forEach((book) => (field === "tags" ? tagsForBook(book) : (book[field] || [])).forEach((rawName) => {
        const name = organizationName(rawName), key = organizationKey(name);
        if (!key) return;
        const entry = entries.get(key) || { name, key, count: 0 };
        entry.count += 1;
        entries.set(key, entry);
      }));
      return Array.from(entries.values()).sort((left, right) => left.name.localeCompare(right.name, "zh"));
    }

    function renderFilterOptions(element: UiElement, field: "tags" | "collections", allLabel: string): void {
      const previous = element.value;
      element.replaceChildren();
      const all = root.createElement("option");
      all.value = "";
      all.textContent = allLabel;
      element.append(all);
      organizationEntries(field).forEach((entry) => {
        const option = root.createElement("option");
        option.value = entry.key;
        option.textContent = `${entry.name}（${entry.count}）`;
        element.append(option);
      });
      element.value = Array.from(element.options).some((option) => option.value === previous) ? previous : "";
    }

    function currentBooks(): LibraryBook[] {
      const tag = $("tag-filter").value, collection = $("collection-filter").value;
      const query = String($("library-ai-book-search")?.value || "").trim().toLocaleLowerCase();
      return books.filter((book) => {
        const tags = new Set(tagsForBook(book).map(organizationKey));
        const collections = new Set((book.collections || []).map(organizationKey));
        const searchText = [book.title, book.author, book.description, book.summary, ...tagsForBook(book)].filter(Boolean).join(" ").toLocaleLowerCase();
        return (!tag || tags.has(tag)) && (!collection || collections.has(collection)) && (!query || searchText.includes(query));
      });
    }

    function updateScopeStatus(visibleBooks: readonly LibraryBook[]): void {
      const selected = selectedBookIds.size;
      const visibleSelected = visibleBooks.filter((book) => selectedBookIds.has(String(book.id))).length;
      if (mode === "question" || mode === "recommend") {
        const visible = visibleSelected < selected ? i18nFormat("scopeVisible", " ({count} currently shown)", { count: visibleSelected }) : "";
        $("scope-summary").textContent = selected
          ? i18nFormat("questionScopeSelected", "Current scope: {selected} selected book(s){visible}", { selected, visible })
          : mode === "recommend"
            ? `推荐范围：全部书库（本地粗选 ${recommendationCandidateLimit} 本，大模型精选 ${recommendationResultLimit} 本）`
            : i18n("scopeAllBooks", "当前范围：全部书库");
        $("clear-selection").textContent = i18n("cancelLimit", "取消限定");
        $("selection-tools").hidden = false;
        $("select-visible").disabled = !visibleBooks.length || visibleSelected === visibleBooks.length;
        $("invert-visible").disabled = !visibleBooks.length;
      } else {
        const visible = visibleSelected < selected ? i18nFormat("scopeVisible", " ({count} currently shown)", { count: visibleSelected }) : "";
        $("scope-summary").textContent = i18nFormat("compareScope", "Comparison scope: {selected}/{limit} book(s){visible}", { selected, limit: MAX_COMPARE_BOOKS, visible });
        $("clear-selection").textContent = i18n("clearSelection", "清空选择");
        $("selection-tools").hidden = true;
      }
      $("clear-selection").disabled = selected === 0;
    }

    function syncBookSelectionControls(visibleBooks: readonly LibraryBook[]): void {
      const limit = selectionLimit();
      const atLimit = Number.isFinite(limit) && selectedBookIds.size >= limit;
      booksEl.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((box) => {
        const checked = selectedBookIds.has(box.value);
        box.checked = checked;
        box.disabled = atLimit && !checked;
        box.closest(".library-ai-book")?.classList.toggle("unavailable", box.disabled);
      });
      updateScopeStatus(visibleBooks);
    }

    function renderBooks() {
      const visibleBooks = currentBooks();
      $("book-count").textContent = visibleBooks.length === books.length
        ? i18nFormat("bookCountAll", "{count} books on shelf", { count: books.length })
        : i18nFormat("bookCountFiltered", "Showing {visible} of {total} books", { visible: visibleBooks.length, total: books.length });
      $("clear-filters").disabled = !$("tag-filter").value && !$("collection-filter").value;
      booksEl.replaceChildren();
      if (!books.length) {
        booksEl.innerHTML = '<div class="library-ai-empty-books">' + i18n("noBooks", "书架中还没有图书。") + "</div>";
        updateScopeStatus(visibleBooks);
        return;
      }
      if (!visibleBooks.length) {
        const query = String($("library-ai-book-search")?.value || "").trim();
        booksEl.innerHTML = '<div class="library-ai-empty-books">' + (query ? i18n("noBookSearchMatches", "No books match the title, author, description, or tags.") : i18n("noFilteredBooks", "No books match the current tags and collections.")) + "</div>";
        updateScopeStatus(visibleBooks);
        return;
      }
      visibleBooks.forEach((book) => {
        const id = String(book.id);
        const label = root.createElement("label");
        label.className = "library-ai-book";
        const box = root.createElement("input");
        box.type = "checkbox";
        box.value = id;
        box.checked = selectedBookIds.has(id);
        box.addEventListener("change", () => {
          if (box.checked) {
            const limit = selectionLimit();
            if (Number.isFinite(limit) && selectedBookIds.size >= limit) {
              box.checked = false;
              state(i18nFormat("selectionLimitMessage", "{mode} supports up to {limit} books.", { mode: i18n(mode === "compare" ? "crossBookCompare" : "libraryQuestion", mode), limit: selectionLimit() }), true);
              return;
            }
            selectedBookIds.add(id);
          } else {
            selectedBookIds.delete(id);
          }
          syncBookSelectionControls(visibleBooks);
        });
        const text = root.createElement("span");
        const title = root.createElement("span");
        title.className = "library-ai-book-name";
        title.textContent = book.title || i18n("unnamedBook", "Untitled book");
        const author = root.createElement("span");
        author.className = "library-ai-book-author";
        author.textContent = book.author || i18n("unknownAuthor", "Unknown author");
        text.append(title, author);
        label.append(box, text);
        booksEl.append(label);
      });
      syncBookSelectionControls(visibleBooks);
    }

    function applyBooks(list: readonly LibraryBook[]): void {
      books = Array.isArray(list) ? list.filter((book) => !book.missing) : [];
      const knownIds = new Set(books.map((book) => String(book.id)));
      Array.from(selectedBookIds).forEach((id) => { if (!knownIds.has(id)) selectedBookIds.delete(id); });
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderFilterOptions($("collection-filter"), "collections", i18n("allCollections", "全部收藏夹"));
      renderBooks();
    }

    async function refreshBooks() {
      const refreshVersion = ++booksRefreshVersion;
      $("book-count").textContent = i18n("loadingLibrary", "正在刷新书架…");
      try {
        const list = await api.invoke("list_books");
        if (refreshVersion !== booksRefreshVersion) return;
        applyBooks(list);
      } catch (error) {
        if (refreshVersion !== booksRefreshVersion) return;
        renderBooks();
        state("无法更新书架：" + String(error), true);
      }
    }

    function selectVisibleBooks() {
      if (mode === "compare") return;
      currentBooks().forEach((book) => selectedBookIds.add(String(book.id)));
      renderBooks();
    }

    function invertVisibleBooks() {
      if (mode === "compare") return;
      currentBooks().forEach((book) => {
        const id = String(book.id);
        if (selectedBookIds.has(id)) selectedBookIds.delete(id);
        else selectedBookIds.add(id);
      });
      renderBooks();
    }

    function setMode(next: LibraryMode): void {
      mode = next;
      if (mode === "compare" && selectedBookIds.size > MAX_COMPARE_BOOKS) {
        const kept = selectedIds().slice(0, MAX_COMPARE_BOOKS);
        selectedBookIds.clear();
        kept.forEach((id) => selectedBookIds.add(id));
        state(`跨书对比最多选择 ${MAX_COMPARE_BOOKS} 本，已保留前 ${MAX_COMPARE_BOOKS} 本。`, true);
      }
      $("mode-question").classList.toggle("active", mode === "question");
      $("mode-compare").classList.toggle("active", mode === "compare");
      $("mode-recommend")?.classList.toggle("active", mode === "recommend");
      $("question").placeholder = mode === "compare"
        ? "比较选中作品对同一主题的观点、分歧与依据。"
        : mode === "recommend"
          ? "例如：我想理解晚明财政困境，该先读哪些书？"
          : "例如：这些书如何解释清末财政困境？";
      $("run").textContent = mode === "recommend" ? "生成推荐书单" : i18n("startQuestion", "开始问答");
      $("library-ai-booklist-save").hidden = mode !== "recommend";
      latestRecommendation = null;
      renderBooks();
    }

    function sourceLabel(source: LibrarySource, index: number): string {
      const kind = source.sourceKind ? ` · ${source.sourceKind}` : "";
      return `《${source.bookTitle || "未命名图书"}》· 第 ${Number(source.chapter || 0) + 1} 章${kind} · 来源 ${index + 1}`;
    }

    async function openSource(source: LibrarySource): Promise<void> {
      if (source?.unavailable) {
        state(source.unavailableReason || "原书未加入本机书架，无法跳转引用正文。", true);
        return;
      }
      try {
        await api.invoke("open_book_at", { request: { id: String(source.bookId), chapter: Number(source.chapter || 0), term: "" } });
      } catch (error) {
        state("无法跳转原文：" + String(error), true);
      }
    }

    function hideSourcePreview(force = false) {
      if (previewPinned && !force) return;
      if (previewHideTimer !== null) global.clearTimeout(previewHideTimer);
      previewHideTimer = null;
      previewPinned = false;
      activeSource = null;
      sourcePreview.hidden = true;
    }

    function scheduleSourcePreviewHide() {
      if (previewHideTimer !== null) global.clearTimeout(previewHideTimer);
      previewHideTimer = global.setTimeout(() => hideSourcePreview(), 180);
    }

    function positionSourcePreview(anchor?: Element | null): void {
      const view = global.window || global;
      const width = Math.min(560, Math.max(360, (view.innerWidth || 760) - 28));
      const height = Math.min(340, Math.max(190, (view.innerHeight || 600) - 28));
      const rect = anchor?.getBoundingClientRect?.();
      const left = rect
        ? Math.max(14, Math.min(rect.left + (rect.width / 2) - (width / 2), (view.innerWidth || width) - width - 14))
        : Math.max(14, ((view.innerWidth || width) - width) / 2);
      const below = rect ? rect.bottom + 10 : 80;
      const top = Math.max(14, Math.min(below, (view.innerHeight || height) - height - 14));
      sourcePreview.style.width = `${width}px`;
      sourcePreview.style.maxHeight = `${height}px`;
      sourcePreview.style.left = `${left}px`;
      sourcePreview.style.top = `${top}px`;
    }

    function showSourcePreview(source: LibrarySource, index: number, pin = false, anchor?: Element | null): void {
      if (previewHideTimer !== null) global.clearTimeout(previewHideTimer);
      previewHideTimer = null;
      activeSource = source;
      previewPinned = pin;
      $("source-preview-title").textContent = sourceLabel(source, index);
      $("source-preview-excerpt").textContent = displaySourceExcerpt(source.excerpt, HISTORY_SOURCE_POPUP_CHARS);
      positionSourcePreview(anchor);
      sourcePreview.hidden = false;
    }

    function displaySourceExcerpt(value: unknown, limit: number): string {
      const text = String(value || "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\r/g, "")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (!text) return "没有可显示的原文片段。";
      return text.length > limit ? `${text.slice(0, limit)}…\n\n（原文预览已截断；可点击打开原文查看完整章节。）` : text;
    }

    function appendAnswerInline(parent: HTMLElement, text: string, sources: readonly LibrarySource[]): void {
      const token = /\[来源\s*(\d+)\]|\*\*([^*\n]+)\*\*/g;
      let cursor = 0, match;
      while ((match = token.exec(text))) {
        parent.append(root.createTextNode(text.slice(cursor, match.index)));
        if (match[2] !== undefined) {
          const strong = root.createElement("strong");
          appendAnswerInline(strong, match[2], sources);
          parent.append(strong);
        } else {
          const index = Number(match[1]) - 1;
          const source = sources[index];
          if (!source) {
            parent.append(root.createTextNode(match[0]));
          } else {
            const footnote = root.createElement("button");
            footnote.type = "button";
            footnote.className = "library-ai-footnote";
            footnote.textContent = `[${index + 1}]`;
            footnote.setAttribute("aria-label", `查看${sourceLabel(source, index)}的脚注原文`);
            footnote.addEventListener("pointerenter", () => showSourcePreview(source, index, false, footnote));
            footnote.addEventListener("pointerleave", scheduleSourcePreviewHide);
            footnote.addEventListener("focus", () => showSourcePreview(source, index, false, footnote));
            footnote.addEventListener("blur", scheduleSourcePreviewHide);
            footnote.addEventListener("click", () => {
              if (activeSource === source && previewPinned) hideSourcePreview(true);
              else showSourcePreview(source, index, true, footnote);
            });
            parent.append(footnote);
          }
        }
        cursor = token.lastIndex;
      }
      parent.append(root.createTextNode(text.slice(cursor)));
    }

    function renderAnswer(content: unknown, sources: readonly LibrarySource[], { hideDirectAnswerHeading = false }: { readonly hideDirectAnswerHeading?: boolean } = {}): void {
      answerEl.replaceChildren();
      const byNumber = Array.isArray(sources) ? sources : [];
      const lines = String(content || "没有得到可显示的回答。").replace(/\r/g, "").split("\n");
      let list: HTMLUListElement | HTMLOListElement | null = null, listKind: "ul" | "ol" | "" = "";
      const closeList = () => { list = null; listKind = ""; };
      const appendListItem = (kind: "ul" | "ol", text: string): void => {
        if (!list || listKind !== kind) {
          list = root.createElement(kind);
          list.className = "library-ai-answer-list";
          listKind = kind;
          answerEl.append(list);
        }
        const item = root.createElement("li");
        appendAnswerInline(item, text, byNumber);
        list.append(item);
      };
      lines.forEach((raw) => {
        const line = raw.trim();
        if (!line) {
          closeList();
          return;
        }
        const heading = line.match(/^(#{1,3})\s+(.+)$/);
        if (heading) {
          closeList();
          const hashes = heading[1] ?? "";
          const headingText = heading[2] ?? "";
          if (hideDirectAnswerHeading && headingText.trim() === "直接回答") return;
          const element = root.createElement(hashes.length === 1 ? "h3" : "h4");
          appendAnswerInline(element, headingText, byNumber);
          answerEl.append(element);
          return;
        }
        if (/^(---|\*\*\*|___)$/.test(line)) {
          closeList();
          answerEl.append(root.createElement("hr"));
          return;
        }
        const bullet = line.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          appendListItem("ul", bullet[1] ?? "");
          return;
        }
        const ordered = line.match(/^\d+[.)]\s+(.+)$/);
        if (ordered) {
          appendListItem("ol", ordered[1] ?? "");
          return;
        }
        closeList();
        const paragraph = root.createElement("p");
        appendAnswerInline(paragraph, line, byNumber);
        answerEl.append(paragraph);
      });
    }

    function renderBooklistRecommendation(recommendation: LibraryRecommendation): void {
      answerEl.replaceChildren();
      const summary = root.createElement("p");
      summary.className = "library-ai-booklist-summary";
      summary.textContent = recommendation.summary || "模型已从本地检索候选中精选以下图书。";
      answerEl.append(summary);
      const list = root.createElement("div");
      list.className = "library-ai-booklist-recommendations";
      recommendation.items.forEach((item, index) => {
        const row = root.createElement("article");
        row.className = "library-ai-booklist-recommendation";
        const rank = root.createElement("span");
        rank.className = "library-ai-booklist-rank";
        rank.textContent = String(index + 1);
        const body = root.createElement("div");
        const title = root.createElement("strong");
        title.textContent = item.title || "未命名图书";
        const review = root.createElement("p");
        review.textContent = item.review || "与问题相关。";
        body.append(title, review);
        row.append(rank, body);
        list.append(row);
      });
      answerEl.append(list);
      $("library-ai-booklist-save").hidden = false;
      const name = $("library-ai-booklist-name");
      if (name && !name.value.trim()) name.value = "问题推荐书单";
    }

    function renderSources(sources: readonly LibrarySource[]): void {
      sourceList.replaceChildren();
      hideSourcePreview(true);
      if (!Array.isArray(sources) || !sources.length) {
        sourcesEl.hidden = true;
        return;
      }
      const oneBook = mode === "question" && new Set(sources.map((source) => String(source.bookId))).size === 1;
      $("source-title").textContent = mode === "recommend"
        ? `本地粗选候选（${sources.length} 本；模型仅可从中精选）`
        : mode === "question"
        ? (oneBook
          ? `单书深度依据（${sources.length} 段；回答仅引用经筛选的脚注）`
          : `检索候选（前 ${sources.length} 本 · 每本 1 段；回答仅引用经筛选的脚注）`)
        : `脚注来源（对比依据 ${sources.length} 段）`;
      sources.forEach((source, index) => {
        const button = root.createElement("button");
        button.type = "button";
        button.className = "library-ai-source";
        const title = root.createElement("span");
        title.className = "library-ai-source-title";
        title.textContent = `[${index + 1}] ${sourceLabel(source, index)}`;
        const excerpt = root.createElement("span");
        excerpt.className = "library-ai-source-excerpt";
        excerpt.textContent = displaySourceExcerpt(source.excerpt, HISTORY_SOURCE_CARD_CHARS);
        button.append(title, excerpt);
        button.addEventListener("click", () => showSourcePreview(source, index, true, button));
        sourceList.append(button);
      });
      sourcesEl.hidden = false;
    }

    function libraryHistoryTaskLabel(task: LibraryMode | undefined): string {
      return task === "compare" ? "跨书对比" : "书库问答";
    }

    function historyAnswerSummary(entry: LibraryHistoryEntry): string {
      const lines = String(entry?.content || "").replace(/\r/g, "").split("\n");
      for (const rawLine of lines) {
        let line = rawLine.trim();
        if (!line || /^#{1,6}(?:\s|$)/.test(line) || /^[-*_]{3,}$/.test(line)) continue;
        line = line
          .replace(/^>\s*/, "")
          .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
          .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/\[(?:来源\s*)?\d+\]/g, "")
          .replace(/[*_~`]/g, "")
          .replace(/^(?:直接回答|核心结论|结论)\s*[：:]\s*/, "")
          .replace(/\s+/g, " ")
          .trim();
        if (!line) continue;
        const sentence = line.match(/^(.{1,180}?[。！？!?])/)?.[1] || line;
        const characters = Array.from(sentence);
        return characters.length > 120 ? `${characters.slice(0, 120).join("").trimEnd()}…` : sentence;
      }
      return "暂无回答摘要";
    }

    function portableSourceReference(source: LibrarySource): LibrarySource {
      return {
        bookTitle: String(source?.bookTitle || "未命名图书").slice(0, 800),
        chapter: Number(source?.chapter || 0),
        sourceKind: String(source?.sourceKind || "正文检索").slice(0, 120),
      };
    }

    function libraryHistoryIdentity(entry: LibraryHistoryEntry): string {
      return String(entry?.id || [entry?.at || "", entry?.task || "", entry?.question || "", String(entry?.content || "").slice(0, 160)].join("\u001f"));
    }

    function historyEntryId(entry: LibraryHistoryEntry): string {
      return String(entry?.id || `legacy:${entry?.at || "unknown"}`);
    }

    function newHistoryEntryId() {
      const suffix = global.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      return `library:${new Date().toISOString()}:${suffix}`;
    }

    function historyEntryIsDeleted(entry: LibraryHistoryEntry): boolean {
      return Boolean(entry?.deletedAt || entry?.deleted_at);
    }

    function sourceTitleKey(value: unknown): string {
      return String(value || "")
        .replace(/[《》〈〉“”‘’「」『』"]/g, "")
        .replace(/\s+/g, "")
        .trim()
        .toLocaleLowerCase("zh-CN");
    }

    function readLocalHistorySources(): LocalHistorySources {
      try {
        const saved: unknown = JSON.parse(global.localStorage?.getItem(HISTORY_SOURCES_KEY) || "{}");
        return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as LocalHistorySources : {};
      } catch { return {}; }
    }

    function writeLocalHistorySources(entry: LibraryHistoryEntry, sources: readonly LibrarySource[]): void {
      try {
        const cache = readLocalHistorySources();
        cache[libraryHistoryIdentity(entry)] = {
          savedAt: entry.at || new Date().toISOString(),
          sources: sources.map((source) => ({
            bookId: String(source?.bookId || ""),
            bookTitle: String(source?.bookTitle || "未命名图书").slice(0, 800),
            chapter: Number(source?.chapter || 0),
            sourceKind: String(source?.sourceKind || "正文检索").slice(0, 120),
            excerpt: String(source?.excerpt || "").slice(0, HISTORY_SOURCE_MAX_CHARS),
          })),
        };
        const keys = Object.keys(cache).sort((left, right) => String(cache[right]?.savedAt || "").localeCompare(String(cache[left]?.savedAt || "")));
        keys.slice(30).forEach((key) => delete cache[key]);
        global.localStorage?.setItem(HISTORY_SOURCES_KEY, JSON.stringify(cache));
      } catch { /* 本机正文缓存不可用时，仍保留可同步的来源索引。 */ }
    }

    function deleteLocalHistorySources(entry: LibraryHistoryEntry): void {
      try {
        const cache = readLocalHistorySources();
        delete cache[libraryHistoryIdentity(entry)];
        global.localStorage?.setItem(HISTORY_SOURCES_KEY, JSON.stringify(cache));
      } catch { /* 删除云端记录不应受本机缓存失败影响。 */ }
    }

    function hydrateLibraryHistory(entries: readonly LibraryHistoryEntry[]): LibraryHistoryEntry[] {
      const cache = readLocalHistorySources();
      return (Array.isArray(entries) ? entries : []).filter((entry) => !historyEntryIsDeleted(entry)).map((entry) => {
        const saved = cache[libraryHistoryIdentity(entry)];
        const portable: readonly LibrarySource[] = Array.isArray(entry.sources) ? entry.sources : [];
        const recovered: readonly LibrarySource[] = Array.isArray(saved?.sources) ? saved.sources : [];
        const sameReference = portable.length === recovered.length && portable.every((source, index) => {
          const candidate = recovered[index];
          return sourceTitleKey(source?.bookTitle) === sourceTitleKey(candidate?.bookTitle)
            && Number(source?.chapter || 0) === Number(candidate?.chapter || 0);
        });
        return sameReference && recovered.length ? { ...entry, sources: recovered } : entry;
      });
    }

    function historySourcesForDisplay(entry: LibraryHistoryEntry): LibrarySource[] {
      const titleKey = (value: unknown): string => String(value || "")
        .replace(/[《》〈〉“”‘’「」『』"']/g, "")
        .replace(/\s+/g, "")
        .trim()
        .toLocaleLowerCase("zh-CN");
      return (Array.isArray(entry?.sources) ? entry.sources : []).map((source) => {
        const bookId = String(source?.bookId || "");
        const sourceTitle = titleKey(source?.bookTitle);
        const matchedBook = books.find((book) => sourceTitle && titleKey(book.title) === sourceTitle)
          || books.find((book) => String(book.contentId || book.content_id || "") === bookId)
          || (!sourceTitle ? books.find((book) => String(book.id) === bookId) : null);
        if (matchedBook && String(source?.excerpt || "").trim()) {
          // Earlier builds stored a source id from a different local import.
          // Resolve it back to the current shelf entry by stable content id or
          // title so a moved/re-imported book is not falsely reported missing.
          return { ...source, bookId: String(matchedBook.id) };
        }
        if (matchedBook) {
          // Entries created by older releases contain a portable reference
          // only.  Recover a readable local chapter once, then persist that
          // text in this device's private history cache (never in sync).
          return {
            ...source,
            bookId: String(matchedBook.id),
            recoveryNeeded: true,
            excerpt: "正在从本机书架恢复该章节正文…",
          };
        }
        return {
          ...source,
          unavailable: true,
          unavailableReason: "原书未加入本机书架或已从本机书架移除，无法显示或跳转引用正文。",
          excerpt: "原书未加入本机书架或已从本机书架移除，引用正文不可用。",
        };
      });
    }

    async function recoverLegacyHistorySources(entry: LibraryHistoryEntry, sources: readonly LibrarySource[]): Promise<LibrarySource[]> {
      const recovered = await Promise.all(sources.map(async (source) => {
        if (!source?.recoveryNeeded) return source;
        try {
          const preview = await api.invoke("library_history_source_preview", {
            request: {
              bookId: String(source.bookId || ""),
              bookTitle: String(source.bookTitle || ""),
              chapter: Number(source.chapter || 0),
              sourceKind: String(source.sourceKind || "正文检索"),
            },
          });
          return { ...preview, recoveredFromLegacyHistory: true };
        } catch (error) {
          return {
            ...source,
            recoveryNeeded: false,
            unavailable: true,
            unavailableReason: `无法恢复旧记录的引用正文：${String(error)}`,
            excerpt: "原书仍在书架，但无法读取当时引用的章节正文。",
          };
        }
      }));
      writeLocalHistorySources(entry, recovered);
      return recovered;
    }

    function renderLibraryHistory() {
      showingHistory = true;
      latestAnswer = latestAnswer || null;
      $("library-ai-history").classList.add("active");
      $("library-ai-history").textContent = i18n("returnToAnswer", "返回本次回答");
      answerEl.className = "library-ai-answer";
      answerEl.replaceChildren();
      const historyToolbar = root.createElement("div");
      historyToolbar.className = "library-ai-history-toolbar";
      const note = root.createElement("p");
      note.className = "library-ai-history-note";
      note.textContent = historySyncMode === "recent"
        ? "本机历史不限数量；最近 100 条回答会同步到云端。跨设备仅同步来源书名、章节与材料类型。"
        : historySyncMode === "manual"
          ? "本机历史不限数量；点每条记录左侧的“云端”后才会保存到云端（最多 100 条）。"
          : "本机历史不限数量；当前回答不同步到云端。";
      const layoutButton = root.createElement("button");
      layoutButton.type = "button";
      layoutButton.className = "library-ai-history-layout";
      const layoutIcon = root.createElement("i");
      layoutIcon.setAttribute("aria-hidden", "true");
      layoutButton.append(layoutIcon);
      historyToolbar.append(note, layoutButton);
      answerEl.append(historyToolbar);
      const list = root.createElement("div");
      list.className = "library-ai-history-list";
      applyHistoryLayout(list, layoutButton);
      layoutButton.addEventListener("click", () => {
        historyLayout = historyLayout === "grid" ? "list" : "grid";
        applyHistoryLayout(list, layoutButton, true);
      });
      libraryHistory.forEach((entry) => {
        const row = root.createElement("div");
        row.className = "library-ai-history-row";
        const button = root.createElement("button");
        button.type = "button";
        button.className = "library-ai-history-item";
        const question = root.createElement("span");
        question.className = "library-ai-history-question";
        question.textContent = entry.question || i18n("unnamedQuestion", "未命名问答");
        const summary = root.createElement("span");
        summary.className = "library-ai-history-summary";
        summary.textContent = historyAnswerSummary(entry);
        const syncStatus = root.createElement("span");
        const cloudSaved = historySyncMode === "recent" || (historySyncMode === "manual" && entry.cloudSaved === true);
        syncStatus.className = `library-ai-history-sync-status ${cloudSaved ? "is-synced" : "is-local"}`;
        syncStatus.textContent = cloudSaved ? "已同步" : "不同步";
        button.append(question, summary, syncStatus);
        button.addEventListener("click", () => showLibraryHistoryEntry(entry));
        if (historySyncMode === "manual") {
          const cloud = root.createElement("button");
          cloud.type = "button";
          cloud.className = `library-ai-history-cloud ${cloudSaved ? "is-synced" : ""}`;
          cloud.textContent = "云端";
          cloud.setAttribute("aria-label", cloudSaved ? `取消云端保存：${question.textContent}` : `保存到云端：${question.textContent}`);
          cloud.addEventListener("click", async (event) => {
            event.preventDefault();
            event.stopPropagation();
            cloud.disabled = true;
            try {
              const snapshot = await api.invoke("private_sync_set_library_history_cloud_saved", { request: { id: historyEntryId(entry), cloudSaved: !cloudSaved } });
              applyLibraryHistorySnapshot(snapshot);
              renderLibraryHistory();
              state(cloudSaved ? "已取消这条问答的云端保存。" : "已保存到云端；它会保留到你取消云端保存或删除为止。", false);
            } catch (error) {
              state("更新云端保存状态失败：" + String(error), true);
              cloud.disabled = false;
            }
          });
          row.append(cloud);
        }
        const remove = root.createElement("button");
        remove.type = "button";
        remove.className = "library-ai-history-delete";
        remove.textContent = i18n("delete", "删除");
        remove.setAttribute("aria-label", `删除书库问答记录：${question.textContent}`);
        remove.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (global.confirm && !global.confirm("删除这条书库问答记录？删除后会同步到其他设备。")) return;
          try {
            const snapshot = await api.invoke("private_sync_library_history_delete", { request: { id: historyEntryId(entry) } });
            deleteLocalHistorySources(entry);
            applyLibraryHistorySnapshot(snapshot);
            renderLibraryHistory();
            state("已删除书库问答记录；删除会在下次同步时传到其他设备。", false);
          } catch (error) {
            state("删除书库问答记录失败：" + String(error), true);
          }
        });
        row.append(button, remove);
        list.append(row);
      });
      if (!libraryHistory.length) {
        const empty = root.createElement("p");
        empty.className = "library-ai-history-note";
        empty.textContent = i18n("noQuestionHistory", "还没有保存的书库问答。完成一次问答后会自动保存到这里。");
        answerEl.append(empty);
      } else {
        answerEl.append(list);
      }
      renderSources([]);
      state("问答记录已载入。", false);
    }

    async function showLibraryHistoryEntry(entry: LibraryHistoryEntry): Promise<void> {
      showingHistory = false;
      $("library-ai-history").classList.remove("active");
      $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
      answerEl.className = "library-ai-answer";
      let sources = historySourcesForDisplay(entry);
      renderAnswer(entry.content, sources, { hideDirectAnswerHeading: true });
      renderSources(sources);
      const needsRecovery = sources.some((source) => source?.recoveryNeeded);
      state(needsRecovery
        ? "正在从本机书架恢复旧记录的章节正文…"
        : `已打开保存的${libraryHistoryTaskLabel(entry.task)}记录。`, false);
      if (!needsRecovery) return;
      sources = await recoverLegacyHistorySources(entry, sources);
      renderAnswer(entry.content, sources, { hideDirectAnswerHeading: true });
      renderSources(sources);
      state("已从本机书架恢复旧记录的章节正文；原记录未保存的精确片段不会进入同步。", false);
    }

    async function refreshLibraryHistory() {
      const snapshot = await api.invoke("private_sync_library_history_list");
      applyLibraryHistorySnapshot(snapshot);
      return libraryHistory;
    }

    async function saveLibraryHistory(question: string, answer: LibraryAnswer): Promise<void> {
      const entry: LibraryHistoryEntry = {
        id: newHistoryEntryId(),
        version: 1,
        scope: "library",
        task: mode,
        question,
        content: answer.content || "",
        sources: Array.isArray(answer.sources) ? answer.sources.map(portableSourceReference) : [],
        at: new Date().toISOString(),
      };
      writeLocalHistorySources(entry, Array.isArray(answer.sources) ? answer.sources : []);
      const snapshot = await api.invoke("private_sync_library_history_merge", { request: { entries: [entry] } });
      applyLibraryHistorySnapshot(snapshot);
    }

    async function toggleLibraryHistory() {
      if (showingHistory) {
        showingHistory = false;
        $("library-ai-history").classList.remove("active");
        $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
        if (latestAnswer) {
          answerEl.className = "library-ai-answer";
          renderAnswer(latestAnswer.content, latestAnswer.sources);
          renderSources(latestAnswer.sources);
          state("已返回本次回答。", false);
        } else {
          answerEl.className = "library-ai-answer empty";
          answerEl.textContent = i18n("answerPlaceholder", "选择范围并输入问题后开始。若没有结果，请先在主窗口的设置中建立语义索引。");
          renderSources([]);
        }
        return;
      }
      try {
        await refreshLibraryHistory();
        renderLibraryHistory();
      } catch (error) {
        state("读取问答记录失败：" + String(error), true);
      }
    }

    async function run() {
      if (running) return;
      const question = $("question").value.trim(), selectedBookIdsForRequest = selectedIds();
      if (!question) {
        state(i18n("enterQuestion", "请输入问题。"), true);
        $("question").focus();
        return;
      }
      if (mode === "compare" && selectedBookIdsForRequest.length < 2) {
        state("跨书对比至少选择两本图书。", true);
        return;
      }
      running = true;
      $("run").disabled = true;
      $("run").textContent = mode === "recommend" ? "本地粗选与模型精选中…" : i18n("askInProgress", "检索并问答中…");
      const explicitBookTitle = /《[^》]+》/.test(question);
      state(mode === "recommend"
        ? "正在本地检索问题相关图书，再请大模型从候选中精选并写评语…"
        : mode === "question" && !selectedBookIdsForRequest.length
        ? (explicitBookTitle
          ? "正在识别题中书名；唯一匹配时将使用单书深度问答…"
          : "正在检索全部书库，并筛选可支撑回答的文本证据…")
        : mode === "question" && selectedBookIdsForRequest.length === 1
          ? "正在对所选图书进行书内多轮检索、证据筛选与自检…"
          : "正在检索所选图书的本地语义索引…");
      answerEl.className = "library-ai-answer empty";
      answerEl.textContent = mode === "recommend" ? "正在整理本地候选书目并生成书单评语…" : "正在整理引用片段并向你的智读服务提问…";
      $("library-ai-booklist-save").hidden = mode !== "recommend";
      renderSources([]);
      try {
        const answer = await api.invoke("ask_library_assistant", { request: { task: mode, question, selectedBookIds: selectedBookIdsForRequest } });
        const processingStages = Array.isArray(answer.retrievalStages)
          ? answer.retrievalStages.map((stage) => String(stage).trim()).filter(Boolean).join(" → ")
          : "";
        showingHistory = false;
        $("library-ai-history").classList.remove("active");
        $("library-ai-history").textContent = i18n("libraryHistory", "问答记录");
        latestAnswer = answer;
        answerEl.className = "library-ai-answer";
        if (mode === "recommend" && answer.recommendation) {
          latestRecommendation = answer.recommendation;
          renderBooklistRecommendation(answer.recommendation);
          renderSources(answer.sources);
          state(`完成。已先从本地检索得到 ${answer.sources?.length || 0} 本候选，再由大模型精选 ${answer.recommendation.items?.length || 0} 本；${processingStages ? `处理链路：${processingStages}。` : ""}确认名称后可保存为书单。`);
          return;
        }
        renderAnswer(answer.content, answer.sources);
        renderSources(answer.sources);
        const singleBookTitle = answer.sources?.[0]?.bookTitle;
        let saveNote = "问答已保存到本机。";
        try {
          await saveLibraryHistory(question, answer);
          saveNote = historySyncMode === "recent"
            ? "问答已保存；最近记录会在下次同步时上传。"
            : historySyncMode === "manual"
              ? "问答已保存到本机；可在问答记录中点“云端”保存。"
              : "问答已保存到本机。";
        } catch {
          saveNote = "回答完成，但问答记录保存失败。";
        }
        state(answer.singleBook
          ? `完成。已按《${singleBookTitle || "所选图书"}》执行单书深度问答；${processingStages ? `处理链路：${processingStages}；` : ""}${saveNote}`
          : `完成。回答仅依据下方列出的本地检索片段；${processingStages ? `处理链路：${processingStages}；` : ""}${saveNote}`);
      } catch (error) {
        answerEl.className = "library-ai-answer empty";
        answerEl.textContent = i18n("libraryQuestionFailed", "书库问答失败。");
        state(String(error), true);
      } finally {
        running = false;
        $("run").disabled = false;
        $("run").textContent = mode === "recommend" ? "生成推荐书单" : i18n("startQuestion", "开始问答");
      }
    }

    async function load() {
      if (loading) return;
      loading = true;
      state(i18n("loadingLibrary", "正在读取书架与智读配置…"));
      try {
        const [status, profiles, semanticTaskCenter, list, modelTagSettings, answerSettings, history] = await Promise.all([
          api.invoke("ai_reader_status"),
          api.invoke("ai_reader_profiles"),
          api.invoke("semantic_tasks", { reconcile: true }),
          api.invoke("list_books"),
          api.invoke("library_model_tags_settings"),
          api.invoke("library_answer_settings"),
          api.invoke("private_sync_library_history_list"),
        ]);
        historyLayout = readHistoryLayout();
        applyLibraryHistorySnapshot(history);
        renderModelProfiles(profiles);
        semanticStatus = mergeSemanticStatus(semanticTaskCenter?.progress);
        useModelTags = modelTagSettings?.enabled !== false;
        answerLength = answerSettings?.answerLength || "short";
        recommendationCandidateLimit = Number(answerSettings?.recommendationCandidateLimit || DEFAULT_RECOMMENDATION_CANDIDATE_LIMIT);
        recommendationResultLimit = Number(answerSettings?.recommendationResultLimit || DEFAULT_RECOMMENDATION_RESULT_LIMIT);
        renderAnswerLengthSettings();
        await hydrateLibraryAnswerSettings();
        applyBooks(list);
        const readiness = readinessMessage(status, semanticStatus);
        state(readiness, !status?.configured);
        if (semanticStatus?.status_refreshing) void reconcileSemanticReadiness(status, semanticStatus);
      } catch (error) {
        state("无法读取书架或智读配置：" + String(error), true);
      } finally {
        loading = false;
      }
    }

    $("mode-question").addEventListener("click", () => setMode("question"));
    $("mode-compare").addEventListener("click", () => setMode("compare"));
    $("mode-recommend")?.addEventListener("click", () => setMode("recommend"));
    $("tag-filter").addEventListener("change", renderBooks);
    $("collection-filter").addEventListener("change", renderBooks);
    $("library-ai-book-search").addEventListener("input", renderBooks);
    $("clear-filters").addEventListener("click", () => {
      $("tag-filter").value = "";
      $("collection-filter").value = "";
      renderBooks();
    });
    $("clear-selection").addEventListener("click", () => {
      selectedBookIds.clear();
      renderBooks();
    });
    $("select-visible").addEventListener("click", selectVisibleBooks);
    $("invert-visible").addEventListener("click", invertVisibleBooks);
    $("library-ai-classify")?.addEventListener("click", () => {
      global.ReaderBookClassificationSettingsUI?.open?.();
    });
    $("library-ai-history").addEventListener("click", toggleLibraryHistory);
    $("library-ai-answer-settings")?.addEventListener("click", toggleAnswerLengthSettings);
    $("library-ai-answer-settings-close")?.addEventListener("click", closeAnswerLengthSettings);
    $("library-ai-answer-settings-overlay")?.addEventListener("click", (event) => {
      if (event.target === event.currentTarget) closeAnswerLengthSettings();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-answer-length]").forEach((button) => {
      button.addEventListener("click", () => { void saveAnswerLength(button.dataset.answerLength, button); });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-library-history-sync]").forEach((button) => {
      button.addEventListener("click", () => { void saveLibraryHistorySyncMode(button.dataset.libraryHistorySync, button); });
    });
    $("library-ai-recommendation-candidate-limit")?.addEventListener("change", (event) => {
      void saveRecommendationCandidateLimit(event.currentTarget as HTMLInputElement);
    });
    $("library-ai-recommendation-result-limit")?.addEventListener("change", (event) => {
      void saveRecommendationResultLimit(event.currentTarget as HTMLInputElement);
    });
    $("library-ai-long-context")?.addEventListener("click", (event) => {
      const toggle = event.currentTarget as HTMLButtonElement;
      const enabled = toggle.getAttribute("aria-checked") === "true";
      const available = toggle.getAttribute("aria-disabled") !== "true";
      if (!available) {
        showLongContextHelp(longContextSetupPath());
        return;
      }
      void saveLongContext(!enabled, toggle);
    });
    answerFontSize = readAnswerFontSize();
    applyAnswerFontSize();
    $("library-ai-font-decrease")?.addEventListener("click", () => {
      answerFontSize = Math.max(MIN_ANSWER_FONT_SIZE, answerFontSize - 1);
      applyAnswerFontSize(true);
      queueLibraryAnswerSettingsSync();
    });
    $("library-ai-font-increase")?.addEventListener("click", () => {
      answerFontSize = Math.min(MAX_ANSWER_FONT_SIZE, answerFontSize + 1);
      applyAnswerFontSize(true);
      queueLibraryAnswerSettingsSync();
    });
    $("library-ai-model-profile")?.addEventListener("change", async (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      const id = select.value;
      if (!id) return;
      select.disabled = true;
      try {
        const profiles = await api.invoke("assign_ai_reader_profile", { request: { purpose: "library", id } });
        renderModelProfiles(profiles);
        const selected = profiles?.profiles?.find((profile) => profile.id === id);
        state(selected?.configured ? "已切换书库问答使用的大模型。" : "所选大模型配置不完整。", !selected?.configured);
      } catch (error) {
        state("切换大模型失败：" + String(error), true);
      } finally { select.disabled = false; }
    });
    $("source-preview-close").addEventListener("click", () => hideSourcePreview(true));
    $("source-preview-open").addEventListener("click", () => { if (activeSource) openSource(activeSource); });
    sourcePreview.addEventListener("pointerenter", () => { if (previewHideTimer !== null) global.clearTimeout(previewHideTimer); });
    sourcePreview.addEventListener("pointerleave", scheduleSourcePreviewHide);
    $("run").addEventListener("click", run);
    $("library-ai-booklist-save")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const recommendation = latestRecommendation;
      const name = String($("library-ai-booklist-name")?.value || "").trim();
      if (!recommendation?.items?.length) return;
      if (!name) { $("library-ai-booklist-name")?.focus(); return; }
      const form = event.currentTarget as HTMLFormElement;
      const submit = form.querySelector<HTMLButtonElement>("button[type=submit]");
      if (!submit) return;
      submit.disabled = true;
      try {
        const reviews = Object.fromEntries(recommendation.items.map((item) => [String(item.bookId), String(item.review || "")]));
        await api.invoke("save_recommended_booklist", {
          name,
          description: String(recommendation.summary || ""),
          bookIds: recommendation.items.map((item) => String(item.bookId)),
          reviews,
        });
        form.hidden = true;
        state(`已保存“${name}”。书单内容和逐书评语可在收藏夹的“收藏书单”中继续编辑。`);
        await refreshBooks();
      } catch (error) {
        state("保存推荐书单失败：" + String(error), true);
      } finally { submit.disabled = false; }
    });
    $("question").addEventListener("contextmenu", showQuestionContextMenu);
    $("question").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault();
        void run();
      }
    });
    global.addEventListener("library-model-tags-setting-changed", (event) => {
      const detail = (event as CustomEvent<{ readonly enabled?: boolean }>).detail;
      useModelTags = detail?.enabled !== false;
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderBooks();
    });
    global.addEventListener("ai-reader-profiles-changed", () => {
      api.invoke("ai_reader_profiles").then(renderModelProfiles).catch(() => {});
    });
    global.addEventListener("app-settings-synced", () => { void hydrateLibraryAnswerSettings(); });
    global.addEventListener("app-language-changed", () => {
      renderAnswerLengthSettings();
      renderFilterOptions($("tag-filter"), "tags", i18n("allTags", "全部标签"));
      renderFilterOptions($("collection-filter"), "collections", i18n("allCollections", "全部收藏夹"));
      renderBooks();
      if (showingHistory) renderLibraryHistory();
      else if (!latestAnswer && !running) answerEl.textContent = i18n("answerPlaceholder", "选择范围并输入问题后开始。若没有结果，请先在主窗口的设置中建立语义索引。");
    });
    global.addEventListener("pointerdown", (event) => {
      if (questionContextMenu && !questionContextMenu.contains(event.target as Node | null)) closeQuestionContextMenu();
    }, true);
    global.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeQuestionContextMenu();
        closeAnswerLengthSettings();
      }
    });
    return { load, refreshBooks, run, setMode, renderBooks };
  }

  return Object.freeze({ init, MAX_QUESTION_SOURCES, MAX_COMPARE_BOOKS });
}

export function installLibraryAi(target: unknown = globalThis, transport?: TauriTransport): LibraryAiUi | null {
  const runtime = asRuntime(target);
  if (!runtime) return null;
  const ui = createLibraryAiUi(runtime, transport);
  runtime.ReaderLibraryAiUI = ui;
  return ui;
}
