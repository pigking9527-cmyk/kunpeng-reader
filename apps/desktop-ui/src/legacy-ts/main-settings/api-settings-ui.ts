import {
  createTauriApi,
  transportFromTauriGlobal,
  type TauriCommandMap,
  type TauriTransport,
} from "../../../../../packages/tauri-api/src/index.js";

interface AiReaderProfileSummary {
  readonly id: string;
  readonly name?: string;
  readonly provider?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly localLibraryAiEligible?: boolean;
}

interface AiReaderAssignments extends Record<string, unknown> {
  readonly readingId?: string;
  readonly libraryId?: string;
  readonly otherId?: string;
}

interface AiReaderProfilesStatus {
  readonly activeId?: string;
  readonly assignments?: AiReaderAssignments;
  readonly profiles?: readonly AiReaderProfileSummary[];
}

interface TranslationCredentialStatus {
  readonly provider?: string;
  readonly configured?: boolean;
}

interface TranslationCredentialsStatus {
  readonly activeProvider?: string;
  readonly profiles?: readonly TranslationCredentialStatus[];
}

interface SaveAiReaderProfileRequest {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
}

type ApiSettingsCommands = {
  ai_reader_profiles: { readonly result: AiReaderProfilesStatus };
  translation_credentials_status: {
    readonly result: TranslationCredentialsStatus;
  };
  assign_ai_reader_profile: {
    readonly args: {
      readonly request: { readonly purpose: string; readonly id: string };
    };
    readonly result: AiReaderProfilesStatus;
  };
  save_ai_reader_profile: {
    readonly args: { readonly request: SaveAiReaderProfileRequest };
    readonly result: AiReaderProfilesStatus;
  };
  save_translation_credential: {
    readonly args: {
      readonly request: {
        readonly provider: string;
        readonly apiId: string;
        readonly apiKey: string;
      };
    };
    readonly result: unknown;
  };
  set_translation_active_provider: {
    readonly args: { readonly provider: string };
    readonly result: TranslationCredentialsStatus;
  };
};

type VerifiedApiSettingsCommands = ApiSettingsCommands extends TauriCommandMap
  ? ApiSettingsCommands
  : never;

export interface ApiSettingsInitOptions {
  readonly invoke?: TauriTransport["invoke"];
  readonly transport?: TauriTransport;
}

export interface ApiSettingsGlobalApi {
  init(options: ApiSettingsInitOptions): void;
}

interface ApiSettingsRuntime extends Record<string, unknown> {
  readonly document: Document;
  dispatchEvent(event: Event): boolean;
  ReaderApiSettingsUI?: ApiSettingsGlobalApi;
}

const PROVIDER_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  deepseek: "https://api.deepseek.com/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  compatible: "",
});

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function runtimeFrom(value: unknown): ApiSettingsRuntime | null {
  const target = record(value);
  if (
    !target ||
    !record(target.document) ||
    typeof target.dispatchEvent !== "function"
  ) {
    return null;
  }
  return target as unknown as ApiSettingsRuntime;
}

function input(element: Element | null): HTMLInputElement | null {
  return element as HTMLInputElement | null;
}

function select(element: Element | null): HTMLSelectElement | null {
  return element as HTMLSelectElement | null;
}

function html(element: Element | null): HTMLElement | null {
  return element as HTMLElement | null;
}

function profilesFrom(status: AiReaderProfilesStatus | null | undefined) {
  return Array.isArray(status?.profiles) ? [...status.profiles] : [];
}

function assignmentsFrom(
  status: AiReaderProfilesStatus | null | undefined,
): AiReaderAssignments {
  return { readingId: "", libraryId: "", otherId: "", ...status?.assignments };
}

export function createApiSettingsGlobal(
  runtime: ApiSettingsRuntime,
  defaultTransport?: TauriTransport,
): ApiSettingsGlobalApi {
  const init = ({ invoke, transport }: ApiSettingsInitOptions): void => {
    let resolvedTransport = transport;
    if (!resolvedTransport && invoke) {
      resolvedTransport = { ...defaultTransport, invoke };
    }
    resolvedTransport ??= defaultTransport;
    if (!resolvedTransport) return;

    const api = createTauriApi<VerifiedApiSettingsCommands>(resolvedTransport);
    const document = runtime.document;
    const modal = html(document.getElementById("api-settings-modal"));
    const title = html(document.getElementById("api-settings-title"));
    const defaultTitle = title?.textContent || "大模型与翻译 API";
    const aiProfile = select(document.getElementById("api-ai-profile"));
    const aiPreset = select(document.getElementById("api-ai-preset"));
    const aiName = input(document.getElementById("api-ai-name"));
    const aiProvider = select(document.getElementById("api-ai-provider"));
    const aiBaseUrl = input(document.getElementById("api-ai-base-url"));
    const aiModel = input(document.getElementById("api-ai-model"));
    const aiKey = input(document.getElementById("api-ai-key"));
    const aiStatus = html(document.getElementById("api-ai-status"));
    const aiPurposePicker = html(
      document.getElementById("api-ai-purpose-picker"),
    );
    const translationProvider = select(
      document.getElementById("api-translation-provider"),
    );
    const translationId = input(document.getElementById("api-translation-id"));
    const translationKey = input(
      document.getElementById("api-translation-key"),
    );
    const translationSummary = html(
      document.getElementById("api-translation-summary"),
    );
    const translationStatus = html(
      document.getElementById("api-translation-status"),
    );
    let aiProfiles: AiReaderProfileSummary[] = [];
    let aiAssignments: AiReaderAssignments = assignmentsFrom(undefined);

    const setStatus = (
      element: HTMLElement | null,
      message: string,
      error = false,
    ): void => {
      if (!element) return;
      element.textContent = message || "";
      element.style.color = error ? "#aa4d48" : "";
    };

    const selectedProfile = (): AiReaderProfileSummary | null =>
      aiProfiles.find((profile) => profile.id === aiProfile?.value) || null;

    const fillProfile = (profile: AiReaderProfileSummary | null): void => {
      if (!profile) {
        if (aiProfile) aiProfile.value = "";
        if (aiName) aiName.value = "";
        if (aiProvider) aiProvider.value = "deepseek";
        if (aiBaseUrl) aiBaseUrl.value = PROVIDER_DEFAULTS.deepseek ?? "";
        if (aiModel) aiModel.value = "deepseek-v4-flash";
        if (aiKey) {
          aiKey.value = "";
          aiKey.placeholder = "新建时必填";
        }
        return;
      }
      if (aiProfile) aiProfile.value = profile.id;
      if (aiName) aiName.value = profile.name || "";
      if (aiProvider) aiProvider.value = profile.provider || "compatible";
      if (aiBaseUrl) aiBaseUrl.value = profile.baseUrl || "";
      if (aiModel) aiModel.value = profile.model || "";
      if (aiKey) {
        aiKey.value = "";
        aiKey.placeholder = "已安全保存；留空则保留原密钥";
      }
    };

    const renderPurposeAssignments = (): void => {
      const selectedId = aiProfile?.value || "";
      aiPurposePicker
        ?.querySelectorAll<HTMLButtonElement>("[data-ai-purpose]")
        .forEach((button) => {
          const purpose = button.dataset.aiPurpose || "";
          const assigned = String(aiAssignments[`${purpose}Id`] || "");
          const selected = Boolean(selectedId) && assigned === selectedId;
          button.classList.toggle("is-selected", selected);
          button.setAttribute("aria-pressed", String(selected));
          button.disabled = !selectedId;
        });
    };

    const renderAiProfiles = (
      status: AiReaderProfilesStatus | null | undefined,
    ): void => {
      aiProfiles = profilesFrom(status);
      if (!aiProfile) return;
      aiAssignments = assignmentsFrom(status);
      const selectedId = aiProfile.value;
      const readingId = String(aiAssignments.readingId || status?.activeId || "");
      aiProfile.replaceChildren();
      aiProfiles.forEach((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        const label = profile.name || profile.model || "未命名配置";
        option.textContent = profile.localLibraryAiEligible
          ? `${label} · 本地 7B+`
          : label;
        aiProfile.appendChild(option);
      });
      fillProfile(
        aiProfiles.find((profile) => profile.id === selectedId) ||
          aiProfiles.find((profile) => profile.id === readingId) ||
          aiProfiles[0] ||
          null,
      );
      renderPurposeAssignments();
    };

    const renderTranslationProfiles = (
      status: TranslationCredentialsStatus | null | undefined,
    ): void => {
      if (!translationProvider) return;
      translationProvider.value = status?.activeProvider || "baidu";
      const configured = (Array.isArray(status?.profiles) ? status.profiles : [])
        .filter((profile) => profile.configured)
        .map((profile) => profile.provider);
      if (translationSummary) {
        translationSummary.textContent = configured.length
          ? `已配置：${configured.join("、")}。阅读页只显示这些服务。`
          : "尚未配置翻译服务。保存任一服务后即可在阅读页切换。";
      }
      if (translationId) translationId.value = "";
      if (translationKey) translationKey.value = "";
    };

    const refresh = async (): Promise<void> => {
      const [ai, translation] = await Promise.all([
        api.invoke("ai_reader_profiles"),
        api.invoke("translation_credentials_status"),
      ]);
      renderAiProfiles(ai);
      renderTranslationProfiles(translation);
    };

    const close = (): void => {
      modal?.classList.remove("show");
      modal?.removeAttribute("data-agent-config-mode");
      if (title) title.textContent = defaultTitle;
    };

    const open = async (): Promise<void> => {
      if (!modal) return;
      const agentConfigMode = modal.getAttribute("data-agent-config-mode") === "true";
      if (title) title.textContent = agentConfigMode ? "云端 Agent 配置" : "大模型与翻译 API";
      modal.classList.add("show");
      setStatus(aiStatus, "正在读取本机配置…");
      try {
        await refresh();
        setStatus(aiStatus, "");
      } catch (error: unknown) {
        setStatus(aiStatus, `读取配置失败：${String(error)}`, true);
      }
    };

    const notifyProfilesChanged = (): void => {
      runtime.dispatchEvent(new CustomEvent("ai-reader-profiles-changed"));
    };

    document.getElementById("api-settings-open")?.addEventListener("click", open);
    document
      .getElementById("api-settings-close")
      ?.addEventListener("click", close);
    modal?.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });
    aiProfile?.addEventListener("change", () => {
      fillProfile(selectedProfile());
      renderPurposeAssignments();
    });
    aiPreset?.addEventListener("change", () => {
      const provider = aiPreset.value;
      if (!provider) return;
      fillProfile(null);
      if (aiProvider) aiProvider.value = provider;
      if (aiBaseUrl) aiBaseUrl.value = PROVIDER_DEFAULTS[provider] || "";
      aiPreset.value = "";
      aiName?.focus();
    });
    aiProvider?.addEventListener("change", () => {
      if (aiProfile?.value) return;
      if (aiBaseUrl) aiBaseUrl.value = PROVIDER_DEFAULTS[aiProvider.value] || "";
    });
    aiPurposePicker?.addEventListener("click", async (event) => {
      const target = event.target as Element | null;
      const button = target?.closest<HTMLButtonElement>("[data-ai-purpose]");
      const id = aiProfile?.value;
      if (!button || !id) return;
      const purpose = button.dataset.aiPurpose || "";
      button.disabled = true;
      try {
        const result = await api.invoke("assign_ai_reader_profile", {
          request: { purpose, id },
        });
        renderAiProfiles(result);
        notifyProfilesChanged();
        setStatus(aiStatus, "已分配模型用途。");
      } catch (error: unknown) {
        setStatus(aiStatus, `分配失败：${String(error)}`, true);
      } finally {
        button.disabled = false;
      }
    });
    document.getElementById("api-ai-save")?.addEventListener("click", async () => {
      const button = document.getElementById("api-ai-save") as HTMLButtonElement;
      button.disabled = true;
      try {
        const result = await api.invoke("save_ai_reader_profile", {
          request: {
            id: aiProfile?.value || "",
            name: aiName?.value || "",
            provider: aiProvider?.value || "compatible",
            baseUrl: aiBaseUrl?.value || "",
            model: aiModel?.value || "",
            apiKey: aiKey?.value || "",
          },
        });
        renderAiProfiles(result);
        notifyProfilesChanged();
        setStatus(aiStatus, "已保存，并设为智读模型。");
      } catch (error: unknown) {
        setStatus(aiStatus, `保存失败：${String(error)}`, true);
      } finally {
        button.disabled = false;
      }
    });
    document
      .getElementById("api-translation-save")
      ?.addEventListener("click", async () => {
        const button = document.getElementById(
          "api-translation-save",
        ) as HTMLButtonElement;
        const provider = translationProvider?.value || "baidu";
        button.disabled = true;
        try {
          await api.invoke("save_translation_credential", {
            request: {
              provider,
              apiId: translationId?.value || "",
              apiKey: translationKey?.value || "",
            },
          });
          const result = await api.invoke("set_translation_active_provider", {
            provider,
          });
          renderTranslationProfiles(result);
          setStatus(
            translationStatus,
            "已保存并设为阅读页当前翻译。",
          );
        } catch (error: unknown) {
          setStatus(translationStatus, `保存失败：${String(error)}`, true);
        } finally {
          button.disabled = false;
        }
      });
  };

  return Object.freeze({ init });
}

/** Classic installer replacing `ui/api-settings-ui.js`. */
export function installApiSettingsUi(
  target: unknown,
  transport?: TauriTransport,
): ApiSettingsGlobalApi | null {
  const runtime = runtimeFrom(target);
  if (!runtime) return null;
  let resolvedTransport = transport;
  if (!resolvedTransport) {
    try {
      resolvedTransport = transportFromTauriGlobal(target);
    } catch {
      resolvedTransport = undefined;
    }
  }
  const api = createApiSettingsGlobal(runtime, resolvedTransport);
  runtime.ReaderApiSettingsUI = api;
  return api;
}
