// Local API profile manager. Credentials never cross this browser boundary.
window.ReaderApiSettingsUI = {
  init({ invoke }) {
    const modal = document.getElementById("api-settings-modal");
    const aiProfile = document.getElementById("api-ai-profile");
    const aiPreset = document.getElementById("api-ai-preset");
    const aiName = document.getElementById("api-ai-name");
    const aiProvider = document.getElementById("api-ai-provider");
    const aiBaseUrl = document.getElementById("api-ai-base-url");
    const aiModel = document.getElementById("api-ai-model");
    const aiKey = document.getElementById("api-ai-key");
    const aiStatus = document.getElementById("api-ai-status");
    const translationProvider = document.getElementById("api-translation-provider");
    const translationId = document.getElementById("api-translation-id");
    const translationKey = document.getElementById("api-translation-key");
    const translationSummary = document.getElementById("api-translation-summary");
    const translationStatus = document.getElementById("api-translation-status");
    const defaults = {
      deepseek: "https://api.deepseek.com/v1",
      openai: "https://api.openai.com/v1",
      anthropic: "https://api.anthropic.com",
      compatible: "",
    };
    let aiProfiles = [];

    function setStatus(element, message, error = false) {
      if (!element) return;
      element.textContent = message || "";
      element.style.color = error ? "#aa4d48" : "";
    }
    function selectedProfile() {
      return aiProfiles.find((profile) => profile.id === aiProfile?.value) || null;
    }
    function fillProfile(profile) {
      if (!profile) {
        if (aiProfile) aiProfile.value = "";
        if (aiName) aiName.value = "";
        if (aiProvider) aiProvider.value = "deepseek";
        if (aiBaseUrl) aiBaseUrl.value = defaults.deepseek;
        if (aiModel) aiModel.value = "deepseek-v4-flash";
        if (aiKey) { aiKey.value = ""; aiKey.placeholder = "新建时必填"; }
        return;
      }
      if (aiProfile) aiProfile.value = profile.id;
      if (aiName) aiName.value = profile.name || "";
      if (aiProvider) aiProvider.value = profile.provider || "compatible";
      if (aiBaseUrl) aiBaseUrl.value = profile.baseUrl || "";
      if (aiModel) aiModel.value = profile.model || "";
      if (aiKey) { aiKey.value = ""; aiKey.placeholder = "已安全保存；留空则保留原密钥"; }
    }
    function renderAiProfiles(status) {
      aiProfiles = Array.isArray(status?.profiles) ? status.profiles : [];
      if (!aiProfile) return;
      const activeId = status?.activeId || "";
      aiProfile.replaceChildren();
      aiProfiles.forEach((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = (profile.name || profile.model || "未命名配置") + (profile.id === activeId ? "（当前）" : "");
        aiProfile.appendChild(option);
      });
      fillProfile(aiProfiles.find((profile) => profile.id === activeId) || aiProfiles[0] || null);
    }
    function renderTranslationProfiles(status) {
      if (!translationProvider) return;
      translationProvider.value = status?.activeProvider || "baidu";
      const configured = (Array.isArray(status?.profiles) ? status.profiles : [])
        .filter((profile) => profile.configured)
        .map((profile) => profile.provider);
      if (translationSummary) {
        translationSummary.textContent = configured.length
          ? "已配置：" + configured.join("、") + "。阅读页只显示这些服务。"
          : "尚未配置翻译服务。保存任一服务后即可在阅读页切换。";
      }
      if (translationId) translationId.value = "";
      if (translationKey) translationKey.value = "";
    }
    async function refresh() {
      const [ai, translation] = await Promise.all([
        invoke("ai_reader_profiles"),
        invoke("translation_credentials_status"),
      ]);
      renderAiProfiles(ai);
      renderTranslationProfiles(translation);
    }
    async function open() {
      if (!modal) return;
      modal.classList.add("show");
      setStatus(aiStatus, "正在读取本机配置…");
      try { await refresh(); setStatus(aiStatus, ""); }
      catch (error) { setStatus(aiStatus, "读取配置失败：" + error, true); }
    }
    function notifyProfilesChanged() {
      window.dispatchEvent(new CustomEvent("ai-reader-profiles-changed"));
    }

    document.getElementById("api-settings-open")?.addEventListener("click", open);
    document.getElementById("api-settings-close")?.addEventListener("click", () => modal?.classList.remove("show"));
    modal?.addEventListener("click", (event) => { if (event.target === modal) modal.classList.remove("show"); });
    aiProfile?.addEventListener("change", () => fillProfile(selectedProfile()));
    aiPreset?.addEventListener("change", () => {
      const provider = aiPreset.value;
      if (!provider) return;
      fillProfile(null);
      if (aiProvider) aiProvider.value = provider;
      if (aiBaseUrl) aiBaseUrl.value = defaults[provider] || "";
      aiPreset.value = "";
      aiName?.focus();
    });
    aiProvider?.addEventListener("change", () => {
      if (aiProfile?.value) return;
      if (aiBaseUrl) aiBaseUrl.value = defaults[aiProvider.value] || "";
    });
    document.getElementById("api-ai-use")?.addEventListener("click", async () => {
      const id = aiProfile?.value;
      if (!id) return setStatus(aiStatus, "请先保存新配置。", true);
      try {
        await invoke("select_ai_reader_profile", { id });
        await refresh();
        notifyProfilesChanged();
        setStatus(aiStatus, "已设为智读与书库问答当前模型。");
      } catch (error) { setStatus(aiStatus, "切换失败：" + error, true); }
    });
    document.getElementById("api-ai-save")?.addEventListener("click", async () => {
      const button = document.getElementById("api-ai-save");
      button.disabled = true;
      try {
        const result = await invoke("save_ai_reader_profile", { request: {
          id: aiProfile?.value || "", name: aiName?.value || "", provider: aiProvider?.value || "compatible",
          baseUrl: aiBaseUrl?.value || "", model: aiModel?.value || "", apiKey: aiKey?.value || "",
        }});
        renderAiProfiles(result);
        notifyProfilesChanged();
        setStatus(aiStatus, "已保存，并设为智读与书库问答当前模型。");
      } catch (error) { setStatus(aiStatus, "保存失败：" + error, true); }
      finally { button.disabled = false; }
    });
    document.getElementById("api-translation-save")?.addEventListener("click", async () => {
      const button = document.getElementById("api-translation-save");
      const provider = translationProvider?.value || "baidu";
      button.disabled = true;
      try {
        await invoke("save_translation_credential", { request: { provider, apiId: translationId?.value || "", apiKey: translationKey?.value || "" } });
        const result = await invoke("set_translation_active_provider", { provider });
        renderTranslationProfiles(result);
        setStatus(translationStatus, "已保存并设为阅读页当前翻译。");
      } catch (error) { setStatus(translationStatus, "保存失败：" + error, true); }
      finally { button.disabled = false; }
    });
  },
};
