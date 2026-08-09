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
    const aiPurposePicker = document.getElementById("api-ai-purpose-picker");
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
    let aiAssignments = { readingId: "", libraryId: "", otherId: "" };

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
    function renderPurposeAssignments() {
      const selectedId = aiProfile?.value || "";
      aiPurposePicker?.querySelectorAll("[data-ai-purpose]").forEach((button) => {
        const purpose = button.dataset.aiPurpose;
        const assigned = aiAssignments[purpose + "Id"] || "";
        const selected = !!selectedId && assigned === selectedId;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", String(selected));
        button.disabled = !selectedId;
      });
    }
    function renderAiProfiles(status) {
      aiProfiles = Array.isArray(status?.profiles) ? status.profiles : [];
      if (!aiProfile) return;
      aiAssignments = { readingId: "", libraryId: "", otherId: "", ...(status?.assignments || {}) };
      const selectedId = aiProfile.value;
      const readingId = aiAssignments.readingId || status?.activeId || "";
      aiProfile.replaceChildren();
      aiProfiles.forEach((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name || profile.model || "未命名配置";
        aiProfile.appendChild(option);
      });
      fillProfile(aiProfiles.find((profile) => profile.id === selectedId)
        || aiProfiles.find((profile) => profile.id === readingId)
        || aiProfiles[0] || null);
      renderPurposeAssignments();
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
    aiProfile?.addEventListener("change", () => {
      fillProfile(selectedProfile());
      renderPurposeAssignments();
    });
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
    aiPurposePicker?.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-ai-purpose]");
      const id = aiProfile?.value;
      if (!button || !id) return;
      const purpose = button.dataset.aiPurpose;
      button.disabled = true;
      try {
        const result = await invoke("assign_ai_reader_profile", {
          request: { purpose, id },
        });
        renderAiProfiles(result);
        notifyProfilesChanged();
        setStatus(aiStatus, "已分配模型用途。");
      } catch (error) { setStatus(aiStatus, "分配失败：" + error, true); }
      finally { button.disabled = false; }
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
        setStatus(aiStatus, "已保存，并设为智读模型。");
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
