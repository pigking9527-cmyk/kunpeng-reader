// 阅读窗口逻辑（整本合并为一页，连续滚动）
const invoke = window.__TAURI__.core.invoke;
const listen = window.__TAURI__.event.listen;
let currentBookTitle = "";
let currentBookId = "";
let currentBookContentId = "";
// 页面测量仍在阅读 WebView 中完成；该 id 把它纳入统一任务中心，
// 以便暂停/取消和可观察进度不再是另一套孤立状态。
let pageCountTaskId = "";
window.currentBookId = "";
window.currentBookContentId = "";
window.ReaderAnimationSettings?.applyReader?.(document);
function syncAnimationSettingsToPage(settings) {
  if (!frameReady || isPdf || typeof sendToPage !== "function") return;
  sendToPage({ animationSettings: settings || window.ReaderAnimationSettings?.read?.() || {} });
}
window.addEventListener("reader-animation-settings-changed", (event) => {
  window.ReaderAnimationSettings?.applyReader?.(document);
  syncAnimationSettingsToPage(event.detail);
});
window.addEventListener("storage", (event) => {
  if (event.key !== window.ReaderAnimationSettings?.STORAGE_KEY) return;
  window.ReaderAnimationSettings?.applyReader?.(document);
  syncAnimationSettingsToPage();
});
window.addEventListener("contextmenu", (e) => e.preventDefault()); // 禁用浏览器右键菜单
function readerDebugSettingOn(key) {
  try {
    const settings = JSON.parse(localStorage.getItem("debugSettingsV1") || "{}");
    return settings[key] !== false;
  } catch (e) {
    return true;
  }
}
const DIAG_DISABLE_READER_REPORTS = !readerDebugSettingOn("reader_stats_report");
let windowDraggingUntil = 0;
let windowDragReleaseTimer = null;
function markWindowDragging() {
  // Tauri 的原生拖窗过程不总能把 move/up 事件稳定回传给 WebView。
  // 给一个较长保护窗，松手事件回来时再缩短，避免拖动数秒后后台写盘插入造成卡顿。
  windowDraggingUntil = Date.now() + 20000;
  if (typeof sendToPage === "function") sendToPage({ windowDragging: 1 });
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 20500);
}
function isWindowDragging() {
  return Date.now() < windowDraggingUntil;
}
function endWindowDraggingSoon() {
  windowDraggingUntil = Date.now() + 500;
  if (windowDragReleaseTimer) clearTimeout(windowDragReleaseTimer);
  windowDragReleaseTimer = setTimeout(() => {
    if (!isWindowDragging() && typeof sendToPage === "function") sendToPage({ windowDragging: 0 });
  }, 650);
}

function initWindowControls() {
  document.querySelector(".reader-drag-space")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("reader-progress-group")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("chapter-progress")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("progress")?.addEventListener("pointerdown", markWindowDragging);
  document.getElementById("win-min")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_minimize").catch(() => {});
  });
  document.getElementById("win-max")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_toggle_maximize").catch(() => {});
  });
  document.getElementById("win-close")?.addEventListener("click", (e) => {
    e.stopPropagation();
    invoke("main_window_close").catch(() => {});
  });
  window.addEventListener("pointerup", endWindowDraggingSoon);
  window.addEventListener("mouseup", endWindowDraggingSoon);
}
initWindowControls();

// 禁用浏览器自带查找（Ctrl+F / F3），用阅读器自带搜索
window.addEventListener("keydown", (e) => {
  if (((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) || e.key === "F3") e.preventDefault();
}, true);

// 沉浸模式和外壳浮层统一交给 ReaderShell 状态机。
let immersive = ReaderShell.isImmersive();
function setImmersive(on) {
  ReaderShell.dispatch({ type: "SET_IMMERSIVE", on: !!on });
  immersive = ReaderShell.isImmersive();
}
function toggleReaderToolbar() {
  ReaderShell.dispatch({ type: "TOGGLE_TOOLBAR" });
  immersive = ReaderShell.isImmersive();
}
window.toggleReaderToolbar = toggleReaderToolbar;
const readerToolbar = document.querySelector(".toolbar");
const aiReaderSide = document.getElementById("ai-reader-side");
const aiReaderStatus = document.getElementById("ai-reader-status");
const aiReaderAnswer = document.getElementById("ai-reader-answer");
const aiReaderSources = document.getElementById("ai-reader-sources");
const aiReaderQuestion = document.getElementById("ai-reader-question");
const aiReaderHistory = document.getElementById("ai-reader-history");
let aiReaderSelectedText = "";
let aiReaderRequestRunning = false;
let aiReaderSidePending = null;
let aiReaderSideTimer = null;
let aiReaderSideRequestId = 0;
function applyAiReaderSide(open, requestId = 0) {
  aiReaderSidePending = null;
  if (aiReaderSideTimer) { clearTimeout(aiReaderSideTimer); aiReaderSideTimer = null; }
  if (!aiReaderSide) return;
  document.body.classList.toggle("ai-reader-open", !!open);
  // 强制读取最终 iframe 宽度后再通知正文页。正文页会等到这个宽度连续两帧稳定，
  // 才按准备阶段记录的字符偏移重新分页，避免 WebView2 的 resize 时序竞争。
  if (requestId && frameReady && !isPdf) {
    requestAnimationFrame(() => {
      const width = Math.round(frame.getBoundingClientRect().width || 0);
      sendToPage({ aiReaderSideCommit: requestId, aiReaderSideExpectedWidth: width });
    });
  }
}
function setAiReaderSide(open, focusAnchor = null) {
  const next = !!open;
  if (!frameReady || isPdf) { applyAiReaderSide(next); return; }
  const requestId = ++aiReaderSideRequestId;
  aiReaderSidePending = { open: next, requestId };
  // 侧栏会改变正文宽度。这里不再用刚被高亮的文字作为分页锚点：它可能位于
  // 视口中部，窄屏重排后会被分到另一页。正文 iframe 会保存当前视口顶部的
  // 源文本偏移，并在 resize 后以该偏移恢复页面。
  sendToPage({
    preserveAnchor: 1,
    aiReaderSideRequestId: requestId,
    pageCountViewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 1),
  });
  if (aiReaderSideTimer) clearTimeout(aiReaderSideTimer);
  // 页面尚未就绪或消息丢失时仍能打开；正常路径会在锚点确认后更快执行。
  aiReaderSideTimer = setTimeout(() => {
    if (aiReaderSidePending?.requestId === requestId) applyAiReaderSide(next, requestId);
  }, 420);
}
function aiReaderSetStatus(value) { if (aiReaderStatus) aiReaderStatus.textContent = value || ""; }
const aiReaderProviderInput = document.getElementById("ai-reader-provider");
const aiReaderBaseUrlInput = document.getElementById("ai-reader-base-url");
const aiReaderModelInput = document.getElementById("ai-reader-model");
const aiReaderCustomModelInput = document.getElementById("ai-reader-custom-model");
const aiReaderModelTip = document.getElementById("ai-reader-model-tip");
const AI_READER_PROVIDERS = {
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    models: [["deepseek-v4-flash", "DeepSeek V4 Flash（推荐，较快）"], ["deepseek-v4-pro", "DeepSeek V4 Pro（更强）"]],
    tip: "DeepSeek 使用 OpenAI 兼容接口；旧 deepseek-chat 已停止支持。",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    models: [["gpt-5.6-luna", "GPT-5.6 Luna（经济）"], ["gpt-5.6-terra", "GPT-5.6 Terra（平衡）"], ["gpt-5.6-sol", "GPT-5.6 Sol（高能力）"]],
    tip: "OpenAI 使用 Chat Completions API；建议阅读问答从 Luna 或 Terra 开始。",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    models: [["claude-haiku-4-5", "Claude Haiku 4.5（较快）"], ["claude-sonnet-5", "Claude Sonnet 5（平衡）"], ["claude-opus-5", "Claude Opus 5（高能力）"]],
    tip: "Anthropic 使用原生 Messages API，程序会使用 x-api-key，不会套用 OpenAI 协议。",
  },
  compatible: {
    baseUrl: "",
    models: [],
    tip: "适用于 OpenAI 兼容接口；填写服务商提供的基础地址和模型名。",
  },
};
function normalizeAiReaderProvider(provider) {
  return Object.prototype.hasOwnProperty.call(AI_READER_PROVIDERS, provider) ? provider : "compatible";
}
function aiReaderSelectedModel() {
  return aiReaderProviderInput?.value === "compatible"
    ? (aiReaderCustomModelInput?.value || "").trim()
    : (aiReaderModelInput?.value || "").trim();
}
function configureAiReaderProvider(provider, selectedModel = "", resetBase = false) {
  const key = normalizeAiReaderProvider(provider);
  const preset = AI_READER_PROVIDERS[key];
  if (aiReaderProviderInput) aiReaderProviderInput.value = key;
  if (resetBase && aiReaderBaseUrlInput) aiReaderBaseUrlInput.value = preset.baseUrl;
  if (aiReaderModelTip) aiReaderModelTip.textContent = preset.tip;
  if (!aiReaderModelInput || !aiReaderCustomModelInput) return;
  const isCustom = key === "compatible";
  aiReaderModelInput.hidden = isCustom;
  aiReaderCustomModelInput.hidden = !isCustom;
  if (isCustom) {
    aiReaderCustomModelInput.value = selectedModel || aiReaderCustomModelInput.value || "";
    return;
  }
  aiReaderModelInput.replaceChildren();
  preset.models.forEach(([value, label]) => {
    const option = document.createElement("option"); option.value = value; option.textContent = label; aiReaderModelInput.appendChild(option);
  });
  const known = preset.models.some(([value]) => value === selectedModel);
  aiReaderModelInput.value = known ? selectedModel : preset.models[0][0];
}
aiReaderProviderInput?.addEventListener("change", () => configureAiReaderProvider(aiReaderProviderInput.value, "", true));
configureAiReaderProvider(aiReaderProviderInput?.value || "deepseek", "deepseek-v4-flash", false);
function aiReaderHistoryIdentity() { return String(window.currentBookContentId || currentBookContentId || window.currentBookId || currentBookId || "unknown"); }
function aiReaderHistoryKey() { return "aiReaderHistoryV1:" + aiReaderHistoryIdentity(); }
function aiReaderTaskLabel(task) { return task === "summary" ? "总结已读内容" : task === "mindmap" ? "生成脑图" : "提问"; }
function aiReaderReadHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem(aiReaderHistoryKey()) || "[]");
    return Array.isArray(entries) ? entries.slice(0, 40) : [];
  } catch (_) { return []; }
}
function aiReaderSaveHistory(entry) {
  try {
    const entries = aiReaderReadHistory();
    entries.unshift(entry);
    localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(entries.slice(0, 40)));
  } catch (_) { /* 历史不可用不影响本次问答。 */ }
  if (currentBookContentId) {
    invoke("private_sync_history_merge", { request: { contentId: currentBookContentId, entries: [entry] } }).catch(() => {
      // 未开启历史同步、旧数据库或离线均不影响本地智读。
    });
  }
}
async function aiReaderMergeSyncedHistory() {
  if (!currentBookContentId) return;
  try {
    const remote = await invoke("private_sync_history_list", { contentId: currentBookContentId });
    if (!Array.isArray(remote) || !remote.length) return;
    const known = aiReaderReadHistory();
    const merged = [...remote, ...known].filter((entry, index, all) => entry && all.findIndex((candidate) =>
      candidate && candidate.at === entry.at && candidate.question === entry.question && candidate.content === entry.content
    ) === index).slice(0, 40);
    localStorage.setItem(aiReaderHistoryKey(), JSON.stringify(merged));
  } catch (_) { /* 同步历史不可用时继续使用本机历史。 */ }
}
function aiReaderRenderSources(sources) {
  if (!aiReaderSources) return;
  const list = aiReaderSources.querySelector("ul");
  if (!sources || !sources.length) { aiReaderSources.hidden = true; return; }
  list.replaceChildren(...sources.map((source) => {
    const item = document.createElement("li");
    item.textContent = "第 " + (Number(source.chapter || 0) + 1) + " 章：" + String(source.excerpt || "");
    return item;
  }));
  aiReaderSources.hidden = false;
}
function aiReaderParseMindmap(content) {
  let text = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = text.indexOf("{"); const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  try {
    const root = JSON.parse(text);
    return root && typeof root === "object" && root.title ? root : null;
  } catch (_) { return null; }
}
function aiReaderMindmapNode(title, x, y, root) {
  const ns = "http://www.w3.org/2000/svg";
  const group = document.createElementNS(ns, "g");
  if (root) group.setAttribute("class", "root");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", String(x)); rect.setAttribute("y", String(y - 19));
  rect.setAttribute("width", "158"); rect.setAttribute("height", "38"); rect.setAttribute("rx", "9");
  const label = document.createElementNS(ns, "text");
  label.setAttribute("x", String(x + 79)); label.setAttribute("y", String(y + 5)); label.setAttribute("text-anchor", "middle");
  label.textContent = String(title || "未命名").replace(/\s+/g, " ").slice(0, 16);
  group.append(rect, label);
  return group;
}
function aiReaderRenderMindmap(tree) {
  const wrap = document.createElement("div"); wrap.className = "ai-reader-mindmap";
  const ns = "http://www.w3.org/2000/svg";
  const leaves = (node) => {
    const children = Array.isArray(node.children) ? node.children.filter((child) => child && typeof child === "object") : [];
    return children.length ? children.reduce((total, child) => total + leaves(child), 0) : 1;
  };
  const depth = (node) => {
    const children = Array.isArray(node.children) ? node.children : [];
    return children.length ? 1 + Math.max(...children.map(depth)) : 1;
  };
  const svg = document.createElementNS(ns, "svg");
  const leafCount = Math.min(80, leaves(tree));
  svg.setAttribute("width", String(Math.max(420, depth(tree) * 194 + 28)));
  svg.setAttribute("height", String(Math.max(180, leafCount * 62 + 32)));
  let nextLeaf = 0;
  const draw = (node, level) => {
    const children = Array.isArray(node.children) ? node.children.filter((child) => child && typeof child === "object") : [];
    const childLayouts = children.map((child) => draw(child, level + 1));
    const y = childLayouts.length ? childLayouts.reduce((sum, child) => sum + child.y, 0) / childLayouts.length : 32 + (nextLeaf++) * 62;
    const x = 14 + level * 194;
    childLayouts.forEach((child) => {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("d", `M ${x + 158} ${y} C ${x + 178} ${y}, ${child.x - 20} ${child.y}, ${child.x} ${child.y}`);
      svg.appendChild(path);
    });
    svg.appendChild(aiReaderMindmapNode(node.title, x, y, level === 0));
    return { x, y };
  };
  draw(tree, 0); wrap.appendChild(svg); return wrap;
}
function aiReaderRenderAnswer(answer, task) {
  if (!aiReaderAnswer) return;
  let content = String(answer.content || "");
  if (task === "mindmap") {
    const tree = aiReaderParseMindmap(content);
    if (tree) aiReaderAnswer.replaceChildren(aiReaderRenderMindmap(tree));
    else aiReaderAnswer.textContent = content || "模型没有返回可绘制的脑图，请重试。";
  } else {
    aiReaderAnswer.textContent = content || "没有得到可显示的回答。";
  }
  aiReaderAnswer.hidden = false;
  aiReaderHistory?.classList.remove("show");
  aiReaderAnswer.classList.remove("empty");
  aiReaderRenderSources(answer.sources);
}
function aiReaderShowHistory() {
  if (!aiReaderHistory) return;
  const showing = aiReaderHistory.classList.toggle("show");
  if (!showing) { aiReaderAnswer.hidden = false; return; }
  aiReaderAnswer.hidden = true;
  aiReaderSources.hidden = true;
  const entries = aiReaderReadHistory();
  aiReaderHistory.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div"); empty.className = "ai-reader-history-empty"; empty.textContent = "这本书还没有智读记录。"; aiReaderHistory.appendChild(empty); return;
  }
  entries.forEach((entry) => {
    const item = document.createElement("button"); item.type = "button"; item.className = "ai-reader-history-item";
    const question = document.createElement("span"); question.className = "ai-reader-history-question";
    question.textContent = entry.question || aiReaderTaskLabel(entry.task);
    const meta = document.createElement("span"); meta.className = "ai-reader-history-meta";
    meta.textContent = `${aiReaderTaskLabel(entry.task)} · ${entry.at ? new Date(entry.at).toLocaleString() : "历史记录"}`;
    item.append(question, meta);
    item.addEventListener("click", () => aiReaderRenderAnswer(entry, entry.task || "question"));
    aiReaderHistory.appendChild(item);
  });
}
async function openAiReader(prefill = "", focusAnchor = null) {
  setAiReaderSide(true, focusAnchor);
  if (typeof closeSettings === "function") closeSettings();
  aiReaderMergeSyncedHistory();
  aiReaderSelectedText = String(prefill || "").trim().slice(0, 2400);
  if (prefill && aiReaderQuestion) {
    aiReaderQuestion.value = `请结合已读内容解释这段文字：\n${String(prefill).trim().slice(0, 900)}`;
    setTimeout(() => aiReaderQuestion.focus(), 0);
  }
  try {
    const status = await invoke("ai_reader_status");
    configureAiReaderProvider(status.provider || "deepseek", status.model || "deepseek-v4-flash", false);
    aiReaderBaseUrlInput.value = status.baseUrl || AI_READER_PROVIDERS[normalizeAiReaderProvider(status.provider)].baseUrl;
    aiReaderSetStatus(status.configured ? "已配置本机 API" : "请先保存 API 配置");
    document.getElementById("ai-reader-config").open = !status.configured;
  } catch (error) { aiReaderSetStatus("读取配置失败：" + error); }
}
async function runAiReader(task) {
  if (aiReaderRequestRunning) return;
  const question = aiReaderQuestion?.value?.trim() || (task === "summary" ? "总结目前已读的内容" : task === "mindmap" ? "梳理目前已读内容的脑图" : "");
  if (task === "question" && !question) { aiReaderSetStatus("请输入问题"); aiReaderQuestion?.focus(); return; }
  aiReaderRequestRunning = true;
  aiReaderSetStatus("智读正在整理已读内容…");
  aiReaderHistory?.classList.remove("show");
  aiReaderAnswer.hidden = false;
  aiReaderAnswer.textContent = "正在请求模型…";
  aiReaderAnswer.classList.add("empty");
  aiReaderSources.hidden = true;
  try {
    const answer = await invoke("ask_reading_assistant", { request: {
      task,
      question,
      currentChapter: curChapter,
      currentFraction: curChFrac,
      selectedText: aiReaderSelectedText,
    } });
    aiReaderRenderAnswer(answer, task);
    aiReaderSaveHistory({ task, question, content: answer.content || "", sources: answer.sources || [], at: new Date().toISOString() });
    aiReaderSetStatus("完成");
  } catch (error) {
    aiReaderAnswer.textContent = "智读失败：" + String(error);
    aiReaderAnswer.classList.remove("empty");
    aiReaderSetStatus("失败");
  } finally { aiReaderRequestRunning = false; }
}
document.getElementById("ai-reader-btn")?.addEventListener("click", (event) => { event.stopPropagation(); openAiReader(); });
document.getElementById("ai-reader-close")?.addEventListener("click", () => setAiReaderSide(false));
document.getElementById("ai-reader-history-btn")?.addEventListener("click", aiReaderShowHistory);
document.getElementById("ai-reader-enter-submit")?.addEventListener("click", () => runAiReader("question"));
aiReaderQuestion?.addEventListener("keydown", (event) => {
  // Enter 提问，Shift + Enter 换行；候选词确认的 Enter 不得提前请求 API。
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    event.stopPropagation();
    runAiReader("question");
  }
});
document.getElementById("ai-reader-save-config")?.addEventListener("click", async () => {
  const button = document.getElementById("ai-reader-save-config");
  button.disabled = true;
  try {
    const status = await invoke("save_ai_reader_config", { request: {
      provider: aiReaderProviderInput?.value || "compatible",
      baseUrl: aiReaderBaseUrlInput?.value || "",
      model: aiReaderSelectedModel(),
      apiKey: document.getElementById("ai-reader-api-key").value,
    }});
    document.getElementById("ai-reader-api-key").value = "";
    aiReaderSetStatus(status.configured ? "已安全保存到本机" : "配置不完整");
    if (status.configured) document.getElementById("ai-reader-config").open = false;
  } catch (error) { aiReaderSetStatus("保存失败：" + error); }
  finally { button.disabled = false; }
});
document.getElementById("ai-reader-ask")?.addEventListener("click", () => runAiReader("question"));
document.getElementById("ai-reader-summary")?.addEventListener("click", () => runAiReader("summary"));
document.getElementById("ai-reader-mindmap")?.addEventListener("click", () => runAiReader("mindmap"));
readerToolbar?.addEventListener("pointerenter", () => {
  ReaderShell.dispatch({ type: "TOOLBAR_POINTER_ENTER" });
});
readerToolbar?.addEventListener("pointerleave", () => {
  ReaderShell.dispatch({ type: "TOOLBAR_POINTER_LEAVE" });
});
document.getElementById("immersive-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  setImmersive(!immersive);
});
setImmersive(immersive); // 应用上次的沉浸状态
// PDF 缩放
document.getElementById("zoom-in").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "in" }); });
document.getElementById("zoom-out").addEventListener("click", (e) => { e.stopPropagation(); sendToPage({ zoom: "out" }); });
let pdfDual = false;
let pdfStateTimer = null;
document.getElementById("pdf-dual").addEventListener("click", (e) => {
  e.stopPropagation();
  pdfDual = !pdfDual;
  document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
  sendToPage({ dual: pdfDual });
});
// 朗读
let ttsPlaying = false,
  ttsNoZhWarned = false;
const ttsBtn = document.getElementById("tts-btn");
ttsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  ttsPlaying = !ttsPlaying;
  sendToPage({ tts: ttsPlaying ? "start" : "stop" });
});

// 书架检索点击 → 跳到命中章节并高亮（等合并页就绪后再发）
let frameReady = false;
let pendingJump = null;
function doJump(j) {
  if (!j) {
    window.consumePendingCrossSearch?.();
    return;
  }
  if (frameReady) {
    sendToPage({ gotoChapter: j.chapter || 0, search: j.term || "" });
    if (!j.term) setTimeout(() => window.consumePendingCrossSearch?.(), 120);
  } else {
    pendingJump = j;
  }
}
listen("shelf-jump", (e) => doJump(e.payload));

const frame = document.getElementById("frame");
const tocEl = document.getElementById("toc");
const backdropEl = document.getElementById("backdrop");
const loadingEl = document.getElementById("loading");
let loadingHidden = false;
function hideLoading() {
  if (!loadingHidden) {
    loadingHidden = true;
    loadingEl.classList.add("hide");
  }
}
const settingsEl = document.getElementById("settings");
const chapterProgressEl = document.getElementById("chapter-progress");
const progressEl = document.getElementById("progress");
let pageCountMeasuring = true;
function showProgressLoading() {
  if (isPdf) {
    progressEl.innerHTML = '<span class="mini-spinner" aria-label="加载中"></span>';
    return;
  }
  pageCountMeasuring = true;
  progressEl.classList.remove("page-count-total");
  progressEl.classList.add("page-count-loading");
  progressEl.title = "全书页数统计中";
  progressEl.setAttribute("aria-label", "全书页数统计中");
  progressEl.innerHTML = '<span class="mini-spinner" aria-label="全书页数统计中"></span>';
}
function showWholeBookPages(page, total) {
  pageCountMeasuring = false;
  progressEl.classList.remove("page-count-loading");
  progressEl.classList.add("page-count-total");
  const text = page + "/" + total + "页";
  progressEl.title = text;
  progressEl.setAttribute("aria-label", text);
  progressEl.textContent = text;
}
function showChapterProgress(page, total, progress) {
  if (!chapterProgressEl) return;
  const text =
    "第" + (curVchap + 1) + "/" + vchapTotal + "章 · 本章 " +
    (page || 1) + "/" + (total || 1) + "页 · " + progress.toFixed(1) + "%";
  chapterProgressEl.title = text;
  chapterProgressEl.setAttribute("aria-label", text);
  chapterProgressEl.textContent = text;
}

let resumeChapter = 0;
let resumeFrac = 0;
// 当前位置（由合并页上报）
let curProgress = 0; // 全书进度 0~100
let curChapter = 0;
let curChFrac = 0; // 章内比例
let curReadingAnchor = null; // 排版无关的正文字符锚点，供下次续读恢复
let curTotalCh = 1;
let isPdf = false; // PDF.js 模式
let lastPosSig = ""; // 阅读位置签名，用于沉浸模式翻页时自动收起工具栏
let keepImmersiveBarUntil = 0;
window.keepImmersiveBarAfterNav = function () {
  keepImmersiveBarUntil = Date.now() + 1800;
  ReaderShell.dispatch({ type: "SHOW_TOOLBAR" });
};
// 逻辑（虚拟）章节：按目录把大文件细分。vchaps 为 [{ch:spine序号, frag}]
let vchaps = [];
let curVchap = 0;
let vchapTotal = 1;
showProgressLoading();

function setSettingsOpen(open) {
  ReaderShell.setOverlay(ReaderShell.OVERLAY.SETTINGS, !!open);
}
function closeSettings() {
  setSettingsOpen(false);
}
function isSearchInputEditActive() {
  return typeof window.isReaderSearchEditing === "function" && window.isReaderSearchEditing();
}
// 把"搜索框/设置面板是否打开"同步给合并页：打开时正文点击只用于关闭浮层
function syncOverlay() {
  const open = ReaderShell.hasOverlay();
  if (open) pauseReadTracking("overlay");
  sendToPage({ overlayOpen: open ? 1 : 0 });
}
window.addEventListener("reader-shell-statechange", (e) => {
  if (e.detail?.previous?.overlay !== e.detail?.next?.overlay) syncOverlay();
});

// 把阅读位置回传后端（节流，避免频繁写盘）
let progTimer = null;
function reportProgress() {
  if (DIAG_DISABLE_READER_REPORTS) return;
  if (isWindowDragging()) return;
  if (progTimer) clearTimeout(progTimer);
  progTimer = setTimeout(() => {
    if (isWindowDragging()) return;
    invoke("set_progress", {
      request: {
        progress: curProgress,
        chapter: curChapter,
        frac: curChFrac,
        anchor: curReadingAnchor,
      },
    }).catch(() => {});
  }, 800);
}

// ---- 已读字数统计：按可见字数、停留时间、短页和快速翻页折算，避免大窗口短停虚高 ----
const READ_TRACK = {
  normalCpmLimit: 1200,
  shortPageCpmLimit: 900,
  shortPageChars: 150,
  tinyPageChars: 30,
  shortMinMs: 2000,
  shortMaxMs: 8000,
  fastTurnRatio: 0.3,
  fastTurnStreak: 3,
  fastTurnCredit: 0.25,
  idleCapMs: 2 * 60 * 1000,
  minDwellMs: 500,
  maxCreditedPages: 3000,
  periodicCreditMs: 10000,
  backtrackCooldownMs: 2500,
  readingTimeTickMs: 15000,
  readingTimeMaxCreditSec: 20,
};
let rwSegment = null,
  rwAccum = 0,
  rwTimer = null,
  rwFastStreak = 0;
const rwCreditedByPage = new Map();
let rwCreditStorageKey = "",
  rwCreditSaveTimer = null,
  rwLastPosition = 0,
  rwLastPageData = null,
  rwBacktrackBlockedUntil = 0,
  rwBacktrackResumeTimer = null,
  rtLastActiveAt = Date.now();
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function readCreditKey() {
  return currentBookId ? "readWordsCredit:v1:" + currentBookId : "";
}
function ensureReadCreditCache() {
  const key = readCreditKey();
  if (!key || key === rwCreditStorageKey) return;
  rwCreditStorageKey = key;
  rwCreditedByPage.clear();
  try {
    const entries = JSON.parse(localStorage.getItem(key) || "[]");
    if (Array.isArray(entries)) {
      entries.forEach((entry) => {
        if (!Array.isArray(entry) || entry.length < 2) return;
        const pageKey = String(entry[0] || "");
        const credited = Math.max(0, Math.floor(Number(entry[1]) || 0));
        if (pageKey && credited > 0) rwCreditedByPage.set(pageKey, credited);
      });
    }
  } catch (e) {}
  pruneCreditedPages();
}
function saveReadCreditCache(immediate = false) {
  if (!rwCreditStorageKey) return;
  if (rwCreditSaveTimer) {
    clearTimeout(rwCreditSaveTimer);
    rwCreditSaveTimer = null;
  }
  const save = () => {
    try {
      localStorage.setItem(rwCreditStorageKey, JSON.stringify([...rwCreditedByPage.entries()]));
    } catch (e) {}
  };
  if (immediate) save();
  else rwCreditSaveTimer = setTimeout(save, 1000);
}
function flushReadWords(immediate = false) {
  if (DIAG_DISABLE_READER_REPORTS) return;
  if (isWindowDragging() && !immediate) return;
  if (rwTimer) {
    clearTimeout(rwTimer);
    rwTimer = null;
  }
  const flush = () => {
    if (isWindowDragging() && !immediate) return;
    const charsToAdd = Math.floor(rwAccum);
    if (charsToAdd > 0) {
      rwAccum -= charsToAdd;
      invoke("add_read_words", { words: charsToAdd }).catch(() => {});
    }
  };
  if (immediate) {
    flush();
    return;
  }
  rwTimer = setTimeout(() => {
    rwTimer = null;
    flush();
  }, 1500);
}
function readTrackingBlocked() {
  if (isWindowDragging()) return true;
  if (!document.hasFocus() || document.hidden) return true;
  if (Date.now() < rwBacktrackBlockedUntil) return true;
  return ReaderShell.hasOverlay();
}
function readPageKey(d) {
  const chapter = Number.isFinite(d.chapter) ? d.chapter : curChapter || 0;
  const gp = Number(d.gPage || 0);
  const page = Number(d.page || 0);
  return chapter + ":" + (gp > 0 ? "g" + gp : "p" + page);
}
function readPagePosition(d) {
  const gp = Number(d.gPage || 0);
  if (gp > 0) return gp;
  const chapter = Number.isFinite(d.chapter) ? d.chapter : curChapter || 0;
  const page = Number(d.page || 0);
  return chapter * 100000 + page;
}
function requiredReadMs(chars) {
  if (chars <= 0) return 0;
  if (chars < READ_TRACK.tinyPageChars) return 1000;
  if (chars < READ_TRACK.shortPageChars) {
    return clamp((chars / READ_TRACK.shortPageCpmLimit) * 60000, READ_TRACK.shortMinMs, READ_TRACK.shortMaxMs);
  }
  return (chars / READ_TRACK.normalCpmLimit) * 60000;
}
function pruneCreditedPages() {
  while (rwCreditedByPage.size > READ_TRACK.maxCreditedPages) {
    const first = rwCreditedByPage.keys().next().value;
    rwCreditedByPage.delete(first);
  }
}
function creditReadSegment(reason, options = {}) {
  if (!rwSegment) return;
  const seg = rwSegment;
  if (!options.keep) rwSegment = null;
  if (options.discard) return;
  ensureReadCreditCache();
  const rawDwell = Math.max(0, Date.now() - seg.startedAt);
  const chars = Math.max(0, seg.chars || 0);
  if (chars <= 0 || rawDwell < READ_TRACK.minDwellMs) return;
  const required = requiredReadMs(chars);
  if (required <= 0) return;
  const dwellCap = Math.max(READ_TRACK.idleCapMs, required);
  const dwell = clamp(rawDwell, 0, dwellCap);
  const ratio = clamp(dwell / required, 0, 1);
  if (ratio < READ_TRACK.fastTurnRatio) rwFastStreak += 1;
  else rwFastStreak = 0;
  const creditRatio = rwFastStreak >= READ_TRACK.fastTurnStreak ? ratio * READ_TRACK.fastTurnCredit : ratio;
  const totalCreditForPage = Math.floor(chars * creditRatio);
  const alreadyCredited = rwCreditedByPage.get(seg.key) || 0;
  const delta = Math.max(0, totalCreditForPage - alreadyCredited);
  if (delta <= 0) return;
  rwCreditedByPage.set(seg.key, alreadyCredited + delta);
  pruneCreditedPages();
  saveReadCreditCache();
  rwAccum += delta;
  if (window.__kunpengReadDebug) {
    console.debug("read-track", {
      key: seg.key,
      reason,
      chars,
      rawDwell,
      dwell,
      required,
      ratio,
      creditRatio,
      totalCreditForPage,
      alreadyCredited,
      delta,
    });
  }
  flushReadWords();
}
function pauseReadTracking(reason) {
  creditReadSegment(reason || "pause");
}
function discardReadTracking(reason) {
  if (window.__kunpengReadDebug && rwSegment) console.debug("read-track-discard", { key: rwSegment.key, reason });
  rwSegment = null;
}
function resetReadingTimeClock() {
  rtLastActiveAt = readTrackingBlocked() ? 0 : Date.now();
}
function scheduleBacktrackResume(d) {
  rwLastPageData = d;
  if (rwBacktrackResumeTimer) clearTimeout(rwBacktrackResumeTimer);
  const delay = Math.max(READ_TRACK.backtrackCooldownMs, rwBacktrackBlockedUntil - Date.now() + 20);
  rwBacktrackResumeTimer = setTimeout(() => {
    rwBacktrackResumeTimer = null;
    if (rwLastPageData === d && !readTrackingBlocked()) trackReadWords(d, { resumeAfterBacktrack: true });
  }, delay);
}
function trackReadWords(d) {
  if (!readerDebugSettingOn("reader_words_detect")) return;
  const key = readPageKey(d);
  const chars = Math.max(0, d.pageChars || 0);
  if (!key || chars <= 0) return;
  ensureReadCreditCache();
  const pos = readPagePosition(d);
  if (pos > 0 && rwLastPosition > 0 && pos < rwLastPosition) {
    rwBacktrackBlockedUntil = Date.now() + READ_TRACK.backtrackCooldownMs;
    discardReadTracking("backtrack");
    resetReadingTimeClock();
    rwLastPosition = pos;
    scheduleBacktrackResume(d);
    return;
  }
  if (pos > 0) rwLastPosition = pos;
  rwLastPageData = d;
  if (readTrackingBlocked()) {
    pauseReadTracking("blocked");
    scheduleBacktrackResume(d);
    return;
  }
  if (rwSegment && rwSegment.key === key) {
    rwSegment.chars = Math.max(rwSegment.chars, chars);
    return;
  }
  creditReadSegment("page_change");
  rwSegment = { key, chars, startedAt: Date.now() };
}
function creditCurrentReadPage() {
  if (!readerDebugSettingOn("reader_words_detect")) return;
  if (readTrackingBlocked()) {
    pauseReadTracking("periodic_blocked");
    return;
  }
  creditReadSegment("periodic", { keep: true });
}
function tickReadingTime() {
  if (DIAG_DISABLE_READER_REPORTS) return;
  const now = Date.now();
  if (readTrackingBlocked()) {
    rtLastActiveAt = 0;
    return;
  }
  if (!rtLastActiveAt) {
    rtLastActiveAt = now;
    return;
  }
  const seconds = Math.floor(Math.min((now - rtLastActiveAt) / 1000, READ_TRACK.readingTimeMaxCreditSec));
  rtLastActiveAt = now;
  if (seconds > 0) invoke("add_reading_time", { seconds }).catch(() => {});
}
window.addEventListener("blur", () => {
  pauseReadTracking("blur");
  resetReadingTimeClock();
});
window.addEventListener("focus", resetReadingTimeClock);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pauseReadTracking("hidden");
    flushReadWords(true);
    resetReadingTimeClock();
  } else {
    resetReadingTimeClock();
  }
});
window.addEventListener("beforeunload", () => {
  pauseReadTracking("beforeunload");
  flushReadWords(true);
  saveReadCreditCache(true);
});
window.pauseReadTracking = pauseReadTracking;
window.discardReadTracking = discardReadTracking;
// ---- 底部整本书进度条（与顶部阅读工具栏同现同隐）----
const vbar = document.getElementById("vbar");
const vthumb = document.getElementById("vthumb");
const bookProgressEl = document.getElementById("book-progress");
const bookProgressTrack = document.getElementById("book-progress-track");
const bookProgressFill = document.getElementById("book-progress-fill");
const bookProgressThumb = document.getElementById("book-progress-thumb");
const bookProgressRestore = document.getElementById("book-progress-restore");
let vdragging = false;
let bookProgressDragging = false;
let bookProgressRestorePoint = null;
let bookProgressLastFrac = 0;
let bookProgressLastSent = 0;

function showBookProgress() {
  ReaderShell.dispatch({ type: "SHOW_TOOLBAR" });
  updateBookProgress();
}
function hideBookProgress() {
  ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
}
function updateThumb() {
  const h = vbar.clientHeight;
  if (h > 0) {
    const th = 30;
    let top = (curProgress / 100) * (h - th);
    top = Math.max(0, Math.min(h - th, top));
    vthumb.style.height = th + "px";
    vthumb.style.top = top + "px";
  }
  updateBookProgress();
}
function updateBookProgress() {
  if (!bookProgressTrack) return;
  paintBookProgress(Math.max(0, Math.min(100, Number(curProgress) || 0)));
  bookProgressEl.classList.toggle("can-restore", !!bookProgressRestorePoint);
}
function paintBookProgress(percent) {
  if (!bookProgressTrack) return;
  bookProgressFill.style.width = percent + "%";
  bookProgressThumb.style.left = percent + "%";
  bookProgressTrack.setAttribute("aria-valuenow", String(Math.max(1, Math.round(percent))));
}
function rememberBookProgressRestorePoint() {
  if (bookProgressRestorePoint) return;
  bookProgressRestorePoint = {
    chapter: Math.max(0, Number(curChapter) || 0),
    chFrac: Math.max(0, Math.min(1, Number(curChFrac) || 0)),
    progress: Math.max(0, Math.min(100, Number(curProgress) || 0)),
  };
  updateBookProgress();
}
function bookProgressFracFromX(clientX) {
  const rect = bookProgressTrack.getBoundingClientRect();
  if (!rect.width) return 0.01;
  return Math.max(0.01, Math.min(1, (clientX - rect.left) / rect.width));
}
function jumpByBookProgress(frac) {
  if (isPdf) return;
  rememberBookProgressRestorePoint();
  const target = Math.max(0.01, Math.min(1, frac));
  paintBookProgress(target * 100);
  sendToPage({ gotoFrac: target });
}
bookProgressThumb?.addEventListener("mousedown", (e) => {
  if (isPdf) return;
  e.preventDefault();
  e.stopPropagation();
  showBookProgress();
  rememberBookProgressRestorePoint();
  bookProgressDragging = true;
  bookProgressLastFrac = Math.max(0.01, Math.min(1, (Number(curProgress) || 0) / 100));
  bookProgressLastSent = 0;
  document.body.style.userSelect = "none";
  frame.style.pointerEvents = "none";
});
bookProgressTrack?.addEventListener("mousedown", (e) => {
  if (isPdf || e.target === bookProgressThumb) return;
  e.preventDefault();
  showBookProgress();
  jumpByBookProgress(bookProgressFracFromX(e.clientX));
});
bookProgressRestore?.addEventListener("click", () => {
  const point = bookProgressRestorePoint;
  if (!point || isPdf) return;
  bookProgressRestorePoint = null;
  updateBookProgress();
  sendToPage({ gotoChapter: point.chapter, chFrac: point.chFrac });
});
function fracFromY(clientY) {
  const rect = vbar.getBoundingClientRect();
  const th = vthumb.offsetHeight;
  let top = clientY - rect.top - th / 2;
  const range = rect.height - th;
  top = Math.max(0, Math.min(range, top));
  vthumb.style.top = top + "px";
  return range > 0 ? top / range : 0;
}
vthumb.addEventListener("mousedown", (e) => {
  e.preventDefault();
  e.stopPropagation();
  hideBookProgress();
  vdragging = true;
  document.body.style.userSelect = "none";
  frame.style.pointerEvents = "none";
});
vbar.addEventListener("mousedown", (e) => {
  if (e.target === vthumb) return;
  hideBookProgress();
  sendToPage({ gotoFrac: fracFromY(e.clientY) });
});
let vLastFrac = 0;
let vLastSent = 0;
document.addEventListener("mousemove", (e) => {
  if (bookProgressDragging) {
    bookProgressLastFrac = bookProgressFracFromX(e.clientX);
    paintBookProgress(bookProgressLastFrac * 100); // 拖动时先本地跟手，正文跳转节流处理
    const now = Date.now();
    if (now - bookProgressLastSent >= 40) {
      bookProgressLastSent = now;
      jumpByBookProgress(bookProgressLastFrac);
    }
    return;
  }
  if (!vdragging) return;
  vLastFrac = fracFromY(e.clientY);
  const now = Date.now();
  if (now - vLastSent >= 40) {
    vLastSent = now;
    sendToPage({ gotoFrac: vLastFrac });
  }
});
document.addEventListener("mouseup", () => {
  if (bookProgressDragging) {
    bookProgressDragging = false;
    document.body.style.userSelect = "";
    frame.style.pointerEvents = "";
    jumpByBookProgress(bookProgressLastFrac); // 松手时确保精确落到最后位置
    return;
  }
  if (vdragging) {
    vdragging = false;
    document.body.style.userSelect = "";
    frame.style.pointerEvents = "";
    sendToPage({ gotoFrac: vLastFrac });
  }
});
window.addEventListener("resize", () => {
  if (!isPdf) {
    showProgressLoading();
    if (frameReady) {
      sendToPage({
        pageCountViewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 1),
      });
    }
  }
  updateBookProgress();
});

// ---- 书籍信息弹窗 ----
const infoModal = document.getElementById("info-modal");
ReaderShell.registerOverlay(ReaderShell.OVERLAY.INFO, {
  onOpen() {
    window.pauseReadTracking?.("book-info");
  },
});
function fmtWords(n) {
  n = n || 0;
  if (n >= 10000) return (n / 10000).toFixed(2) + " 万字";
  return n + " 字";
}
function fmtSize(b) {
  b = b || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + "M";
  if (b >= 1024) return Math.round(b / 1024) + "K";
  return b + "B";
}
function renderInfoChips(element, values) {
  element.replaceChildren();
  const items = Array.isArray(values) ? values.filter(Boolean) : [];
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "info-chip empty";
    empty.textContent = "未添加";
    element.appendChild(empty);
    return;
  }
  items.forEach((value) => {
    const chip = document.createElement("span");
    chip.className = "info-chip";
    chip.textContent = value;
    element.appendChild(chip);
  });
}
function renderBookInfoTags(element, manualTags, modelTags) {
  element.replaceChildren();
  const append = (values, model) => (Array.isArray(values) ? values : []).filter(Boolean).forEach((value) => {
    const chip = document.createElement("span");
    chip.className = "info-chip" + (model ? " model-tag" : "");
    if (model) {
      const origin = document.createElement("span");
      origin.className = "info-chip-origin";
      origin.textContent = "AI";
      chip.append(origin, document.createTextNode(value));
      chip.title = "大模型分类标签";
    } else {
      chip.textContent = value;
    }
    element.appendChild(chip);
  });
  append(manualTags, false);
  append(modelTags, true);
  if (!element.childElementCount) {
    const empty = document.createElement("span");
    empty.className = "info-chip empty";
    empty.textContent = "未添加";
    element.appendChild(empty);
  }
}
// ---- 评分（五颗星，支持半星 0.5 刻度；点左半=半星、右半=整星，再点同一处清除）----
// 通用半星组件：在 container 里建 5 颗叠层星，鼠标悬停预览、点击回调 onPick(value)。
function makeStars(container, onPick) {
  for (let i = 0; i < 5; i++) {
    const st = document.createElement("span");
    st.className = "star";
    const bg = document.createElement("span");
    bg.className = "s-bg";
    bg.textContent = "★";
    const fg = document.createElement("span");
    fg.className = "s-fg";
    fg.textContent = "★";
    st.append(bg, fg);
    container.appendChild(st);
  }
  const stars = [...container.querySelectorAll(".star")];
  function paint(v) {
    stars.forEach((st, i) => {
      const f = Math.max(0, Math.min(1, v - i)); // 该颗的填充比例：0 / .5 / 1
      st.querySelector(".s-fg").style.width = f * 100 + "%";
    });
  }
  function valAt(e) {
    for (let i = 0; i < stars.length; i++) {
      const r = stars[i].getBoundingClientRect();
      if (e.clientX <= r.right) return i + (e.clientX < r.left + r.width / 2 ? 0.5 : 1);
    }
    return 5;
  }
  container.addEventListener("mousemove", (e) => paint(valAt(e)));
  container.addEventListener("mouseleave", () => paint(container._val || 0));
  container.addEventListener("click", (e) => {
    let v = valAt(e);
    if (v === container._val) v = 0; // 点中当前值 → 清除
    container._val = v;
    paint(v);
    onPick(v);
  });
  container.setVal = (v) => {
    container._val = v || 0;
    paint(container._val);
  };
  paint(0);
}
const infoStars = document.getElementById("info-stars");
makeStars(infoStars, (v) => invoke("set_rating", { rating: v }).catch(() => {}));
invoke("book_meta").then((m) => { currentBookTitle = m.title || ""; }).catch(() => {});

document.getElementById("info-btn")?.addEventListener("click", async () => {
  document.getElementById("info-words").textContent = "统计中…";
  ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, true);
  try {
    const m = await invoke("book_meta");
    currentBookTitle = m.title || "";
    document.getElementById("info-title").textContent = m.title || "—";
    document.getElementById("info-author").textContent = m.author || "未知";
    document.getElementById("info-format").textContent = (m.format || "").toUpperCase();
    document.getElementById("info-words").textContent = fmtWords(m.word_count);
    document.getElementById("info-size").textContent = fmtSize(m.size);
  renderBookInfoTags(document.getElementById("info-tags"), m.tags, m.model_tags || m.modelTags);
    renderInfoChips(document.getElementById("info-collections"), m.collections);
    document.getElementById("info-desc").textContent = m.description || "";
    infoStars.setVal(m.rating || 0);
  } catch (e) {
    document.getElementById("info-words").textContent = "读取失败：" + e;
  }
});
document.getElementById("info-close").addEventListener("click", () => {
  ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
});
infoModal.addEventListener("click", (e) => {
  if (e.target === infoModal) ReaderShell.setOverlay(ReaderShell.OVERLAY.INFO, false);
});
// 简介编辑：失焦保存
document.getElementById("info-desc").addEventListener("blur", () => {
  const desc = document.getElementById("info-desc").textContent.trim();
  invoke("set_description", { description: desc }).catch(() => {});
});

const readerEndModal = document.getElementById("reader-end-modal");
const readerEndList = document.getElementById("reader-end-list");
function closeReaderEnd() {
  readerEndModal?.classList.remove("show");
}
async function openReaderEnd() {
  if (!readerEndModal || !readerEndList || !currentBookId) return;
  readerEndModal.classList.add("show");
  readerEndList.innerHTML = '<div class="reader-end-empty">正在寻找相似图书…</div>';
  try {
    const list = await invoke("similar_books", { id: String(currentBookId) });
    readerEndList.replaceChildren();
    if (!Array.isArray(list) || !list.length) {
      const empty = document.createElement("div");
      empty.className = "reader-end-empty";
      empty.textContent = "暂时没有相似图书。可以先在语义索引中完成建库。";
      readerEndList.appendChild(empty);
      return;
    }
    list.slice(0, 5).forEach((book) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "reader-end-item";
      const cover = document.createElement("div");
      cover.className = "reader-end-cover";
      if (book.cover) {
        const image = document.createElement("img");
        image.src = book.cover;
        image.alt = book.title || "";
        cover.appendChild(image);
      } else {
        cover.textContent = book.title || "未命名";
      }
      const body = document.createElement("div");
      const title = document.createElement("div");
      title.className = "reader-end-title";
      title.textContent = book.title || "未命名";
      const meta = document.createElement("div");
      meta.className = "reader-end-meta";
      const score = Math.round(Math.max(0, Math.min(1, Number(book.score) || 0)) * 100);
      meta.textContent = (book.author ? book.author + " · " : "") + "相关性 " + score + "%";
      body.append(title, meta);
      if (book.description) {
        const description = document.createElement("div");
        description.className = "reader-end-desc";
        description.textContent = book.description;
        body.appendChild(description);
      }
      item.append(cover, body);
      item.addEventListener("click", () => {
        closeReaderEnd();
        invoke("open_book_at", {
          request: { id: String(book.id), chapter: 0, term: "" },
        }).catch((error) => {
          readerEndModal.classList.add("show");
          readerEndList.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "reader-end-empty";
          empty.textContent = "打开失败：" + error;
          readerEndList.appendChild(empty);
        });
      });
      readerEndList.appendChild(item);
    });
  } catch (error) {
    readerEndList.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "reader-end-empty";
    empty.textContent = "读取失败：" + error;
    readerEndList.appendChild(empty);
  }
}
document.getElementById("reader-end-close")?.addEventListener("click", closeReaderEnd);
readerEndModal?.addEventListener("click", (event) => {
  if (event.target === readerEndModal) closeReaderEnd();
});

// 全书搜索 UI 与 sendToPage 消息桥在 reader-search-ui.js。

// 接收合并页上报：阅读进度 / 正文被点击 / 搜索结果数
window.addEventListener("message", (e) => {
  if (!window.ReaderMessageGuard?.validateEvent(e, frame, window.location)) return;
  if (e.data.bookEnd) {
    openReaderEnd();
    return;
  }
  if (e.data.readerAnchorReady) {
    const pending = aiReaderSidePending;
    if (pending && (!e.data.aiReaderSideRequestId || e.data.aiReaderSideRequestId === pending.requestId)) {
      applyAiReaderSide(pending.open, pending.requestId);
    }
    return;
  }
  if (typeof e.data.readerPerf === "string") {
    invoke("reader_perf_log", { event: e.data.readerPerf }).catch(() => {});
    return;
  }
  if (e.data.layoutBusy) {
    if (!isPdf) showProgressLoading();
    return;
  }
  if (typeof e.data.progress === "number") {
    curProgress = e.data.progress;
    curChapter = e.data.chapter || 0;
    curChFrac = e.data.chFrac || 0;
    curReadingAnchor = e.data.anchor || null;
    curTotalCh = e.data.totalCh || 1;
    if (typeof e.data.logicalCh === "number") curVchap = e.data.logicalCh;
    if (e.data.logicalTotal) vchapTotal = e.data.logicalTotal;
    if (isPdf) {
      progressEl.textContent =
        "第 " + (e.data.page || 1) + "/" + (e.data.total || 1) + " 页 · " + curProgress.toFixed(1) + "%";
    } else {
      // 全书页数是补充信息，不能覆盖原有的章节、本章页数和百分比。
      showChapterProgress(e.data.page, e.data.total, curProgress);
      const gP = e.data.gPage || 0,
        gT = e.data.gTotal || 0;
      if (gT > 0) {
        showWholeBookPages(gP, gT);
      } else if (pageCountMeasuring) {
        // 章节位置上报不能把右上角的全书测量状态覆盖掉。
        showProgressLoading();
      }
    }
    reportProgress();
    trackReadWords(e.data); // 累计真正读过的字数
    if (!vdragging && !isPdf) updateThumb();
    else updateBookProgress();
    hideLoading(); // 当前章/页排版完成
    // 沉浸模式下：翻页/滚到新页 → 自动收起浮现的工具栏，避免挡住正文。
    // 但若设置面板/搜索框正开着，则不收——否则调节滑块时正文重排会改变页码签名，
    // 误判为“翻页”而把工具栏（连同打开的设置面板）一起隐藏。
    const sig = (e.data.gPage || 0) + "_" + (e.data.page || 0) + "_" + (e.data.chapter || 0);
    const panelOpen = ReaderShell.hasOverlay();
    const toolbarPinned = ReaderShell.getState().toolbar === ReaderShell.TOOLBAR.IMMERSIVE_PINNED;
    if (lastPosSig && sig !== lastPosSig && immersive && toolbarPinned && !panelOpen && Date.now() > keepImmersiveBarUntil) {
      ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
    }
    lastPosSig = sig;
  }
  if (e.data.ttsState !== undefined) {
    ttsPlaying = !!e.data.ttsState;
    ttsBtn.textContent = ttsPlaying ? "⏸" : "🔊";
    ttsBtn.classList.toggle("active", ttsPlaying);
  }
  if (e.data.ttsSynth) {
    // 合并页要某句的在线音频 → 调 edge_tts → 回传音频+词时间戳
    const r = e.data.ttsSynth;
    invoke("edge_tts", { request: { text: r.text, voice: r.voice, rate: r.rate } })
      .then((res) => sendToPage({ ttsAudio: { seq: r.seq, idx: r.idx, audio: res.audio, marks: res.marks } }))
      .catch((err) => sendToPage({ ttsAudioErr: { seq: r.seq, idx: r.idx, err: String(err) } }));
  }
  if (e.data.dictPrefetch) prefetchMicrosoftWord(e.data.dictPrefetch);
  if (e.data.dictSpeak) speakMicrosoftWord(e.data.dictSpeak);
  if (e.data.ttsErr) {
    const m = e.data.ttsErr;
    alert(typeof m === "string"
      ? "在线朗读失败：" + m + "\n（可在设置→朗读 把音源切到“系统语音”。）"
      : m === 1 ? "当前环境不支持朗读（Web Speech API 不可用）。"
      : "在线朗读取音失败。可切换为系统语音。");
  }
  if (e.data.ttsNoZh && !ttsNoZhWarned) {
    ttsNoZhWarned = true;
    alert("没找到中文朗读语音，会用默认语音（中文可能读不准）。\n建议：Windows 设置 → 时间和语言 → 语音 → 添加“中文（中国）”自然语音，然后重开本书。");
  }
  if (e.data.outline) buildToc(e.data.outline); // PDF 内置目录
  if (e.data.pdfState) {
    // PDF 缩放/双页变化 → 记住（节流写盘），并同步双页按钮高亮
    const st = e.data.pdfState;
    pdfDual = !!st.dual;
    document.getElementById("pdf-dual").classList.toggle("active", pdfDual);
    if (pdfStateTimer) clearTimeout(pdfStateTimer);
    pdfStateTimer = setTimeout(() => {
      invoke("set_pdf_state", { scale: st.scale, dual: !!st.dual }).catch(() => {});
    }, 600);
  }
  if (e.data.searchResults && isPdf) renderResults(rsearchTerm, e.data.searchResults); // PDF 书内搜索结果
  if (e.data.uiClick) {
    // 正文被点击：关闭外壳浮层（沉浸与非沉浸一致）。
    if (!isSearchInputEditActive()) ReaderShell.closeOverlay();
  }
  if (e.data.userNav) {
    // 正文区键盘/滚轮翻页：收起搜索框与沉浸工具栏。
    // 不在这里关设置面板——设置途中（滑块/数字框调节）可能触发翻页类事件，会误关；
    // 设置面板只在“点设置页之外”时关闭（见 uiClick 与下方 document 点击处理）。
    if (ReaderShell.isOverlay(ReaderShell.OVERLAY.SEARCH) && !isSearchInputEditActive()) toggleSearch(false);
    ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
  }
  if (e.data.readerNavigated) hideBookProgress();
  if (e.data.centerTap) {
    toggleReaderToolbar();
  }
  if (e.data.ready) {
    hideLoading();
    frameReady = true;
    syncAnimationSettingsToPage();
    if (vchaps.length) sendToPage({ vchaps }); // 把逻辑章节表交给合并页
    sendToPage({ highlights }); // 把高亮交给合并页渲染
    if (!isPdf) {
      // 页数使用阅读窗口的稳定宽度；智读侧栏之后只压缩正文，不生成另一套缓存。
      sendToPage({
        pageCountViewportWidth: Math.round(document.documentElement.clientWidth || window.innerWidth || 1),
      });
      const chapterTotal = Array.isArray(vchaps) ? vchaps.length : 0;
      invoke("begin_page_count_task", { total: chapterTotal })
        .then((id) => {
          pageCountTaskId = String(id || "");
          // 取上次测好的页数缓存：版式一致则合并页直接采用，免重算。
          // 必须在任务登记后发送，完整缓存才能立即把该任务收口为完成。
          return invoke("get_page_cache");
        })
        .then((pc) => { if (pc) sendToPage({ pageCache: pc }); })
        .catch(() => {
          pageCountTaskId = "";
          invoke("get_page_cache")
            .then((pc) => { if (pc) sendToPage({ pageCache: pc }); })
            .catch(() => {});
        });
    }
    if (pendingJump) {
      doJump(pendingJump);
      pendingJump = null;
    }
  }
  if (e.data.pageCache) {
    // 每 4 章保存一次：超大书中途关闭后，下次按当前版式继续测量。
    const pc = e.data.pageCache;
    invoke("save_page_cache", {
      request: {
        sig: pc.sig,
        pages: pc.pages,
        complete: !!pc.complete,
      },
    }).catch(() => {});
    const done = Array.isArray(pc.pages)
      ? pc.pages.reduce((sum, pageCount) => sum + (Number(pageCount) > 0 ? 1 : 0), 0)
      : 0;
    if (pageCountTaskId || pc.pages?.length) {
      invoke("report_page_count_task", {
        request: {
          done,
          total: Array.isArray(pc.pages) ? pc.pages.length : 0,
          sig: String(pc.sig || ""),
          complete: !!pc.complete,
        },
      }).then((control) => {
        if (control === "pause" || control === "cancel") {
          sendToPage({ pageCountTaskControl: control });
        }
        if (control === "complete" || control === "cancel") pageCountTaskId = "";
      }).catch(() => {});
    }
  }
  if (e.data.downloadImage) {
    const img = e.data.downloadImage || {};
    const dataUrl = String(img.dataUrl || "");
    if (dataUrl.startsWith("data:image/")) {
      invoke("save_download_image", {
        name: String(img.name || "书摘.png"),
        dataUrl,
      })
        .then((path) => sendToPage({ excerptSaved: path || "" }))
        .catch((err) => {
          sendToPage({ excerptSaveError: String(err || "保存图片失败") });
          const a = document.createElement("a");
          a.download = String(img.name || "书摘.png").replace(/[\\/:*?"<>|]/g, "_");
          a.href = dataUrl;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
    }
  }
  if (e.data.webSearch) {
    const request = typeof e.data.webSearch === "string"
      ? { term: e.data.webSearch, engine: "baidu" }
      : e.data.webSearch;
    invoke("web_search", { term: request.term, engine: request.engine || "baidu" }).catch(() => {});
  }
  if (e.data.crossSearch) {
    openCrossSearch(e.data.crossSearch);
  }
  if (e.data.semanticSearch) {
    openSemanticSearch(e.data.semanticSearch);
  }
  if (e.data.aiReader) {
    const request = e.data.aiReader;
    openAiReader(request.text || "", {
      start: request.anchorStart,
      end: request.anchorEnd,
    });
  }
  if (e.data.getTranslationCredentialStatus) {
    const provider = String(e.data.getTranslationCredentialStatus || "");
    invoke("translation_credential_status", { provider })
      .then((status) => sendToPage({ translationCredentialStatus: status }))
      .catch((err) => sendToPage({ translationCredentialStatus: { provider, configured: false, error: String(err) } }));
  }
  if (e.data.saveTranslationCredential) {
    const credential = e.data.saveTranslationCredential;
    invoke("save_translation_credential", {
      request: {
        provider: credential.provider || "",
        apiId: credential.apiId || "",
        apiKey: credential.apiKey || "",
      },
    })
      .then((status) => sendToPage({ translationCredentialSaved: status }))
      .catch((err) => sendToPage({ translationCredentialSaved: { provider: credential.provider || "", configured: false, error: String(err) } }));
  }
  if (e.data.translateText) {
    const req = e.data.translateText;
    invoke("translate_text", {
      request: {
        text: req.text || "",
        sourceLang: req.source || "auto",
        targetLang: req.target || "system",
        provider: req.provider || "baidu",
        credentialConfigId: req.credentialConfigId || "",
      },
    })
      .then((r) => sendToPage({ translateResult: r }))
      .catch((err) =>
        sendToPage({
          translateResult: {
            ok: false,
            provider: req.provider || "baidu",
            source_lang: req.source || "auto",
            target_lang: req.target || "system",
            original: req.text || "",
            translated: "",
            error: String(err || "翻译失败"),
          },
        }),
      );
  }
  if (e.data.dict !== undefined) {
    invoke("dict_lookup", { term: e.data.dict, context: e.data.dictContext || "" })
      .then((r) => sendToPage({ dictResult: { ...r, autoSpeak: vocabAutoSpeak } }))
      .catch(() => sendToPage({ dictResult: { found: false, word: e.data.dict } }));
  }
  if (e.data.vocabAdd) {
    const v = e.data.vocabAdd;
    invoke("vocab_add", {
      entry: {
        word: v.word,
        lang: v.lang,
        def: v.def || "",
        def_en: v.def_en || "",
        phonetic: v.phonetic || "",
        example: v.example || "",
        book_title: currentBookTitle || "",
      },
    }).catch(() => {});
  }
  if (e.data.addHighlight) {
    addHighlight(e.data.addHighlight, "");
  }
  if (e.data.addHighlightCorrect) {
    addHighlight(e.data.addHighlightCorrect, "", false, true);
  }
  if (e.data.addHighlightCorrectDraft) {
    const d = e.data.addHighlightCorrectDraft;
    addCorrectedHighlight(d, d.correctedText || "");
  }
  if (e.data.addHighlightNote) {
    addHighlight(e.data.addHighlightNote, "", true); // 先建高亮，随即打开批注面板
  }
  if (typeof e.data.openAnnotations === "number") {
    openAnnotations(e.data.openAnnotations);
  }
  if (typeof e.data.removeHighlight === "number") {
    invoke("remove_highlight", { index: e.data.removeHighlight }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightNote) {
    const { index, note } = e.data.setHighlightNote;
    invoke("set_highlight_note", { index, note }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightText) {
    const { index, text } = e.data.setHighlightText;
    invoke("set_highlight_text", { index, text }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.setHighlightColor) {
    const { index, color } = e.data.setHighlightColor;
    invoke("set_highlight_color", { index, color }).then((list) => {
      highlights = list;
      sendToPage({ highlights });
      renderHighlights();
    });
  }
  if (e.data.addBookmark) {
    const o = e.data.addBookmark;
    // 统一标签：第 N 页/章 · 百分比 ·（选中的文字片段，若有）
    const pageNo = (o.chapter || 0) + 1;
    let label = "第 " + pageNo + " " + (isPdf ? "页" : "章") + " · " + curProgress.toFixed(1) + "%";
    if (o.text) label += " · " + o.text;
    invoke("add_bookmark", {
      chapter: o.chapter || 0,
      frac: o.frac || 0,
      label,
    }).then((list) => {
      bookmarks = list;
      renderBookmarks();
    });
  }
  if (e.data.tocResolved && ReaderShell.isOverlay(ReaderShell.OVERLAY.TOC)) {
    const r = e.data.tocResolved;
    if (r.chapter === curChapter) {
      const items = [...tocPane.querySelectorAll(".toc-item")];
      let el = items.find(
        (it) => parseInt(it.dataset.chapter, 10) === curChapter && (it.dataset.frag || "") === (r.frag || "")
      );
      if (!el) el = items.find((it) => parseInt(it.dataset.chapter, 10) === curChapter);
      markToc(el);
    }
  }
});

// 外壳内点击：只要不是点在齿轮按钮/设置面板上，就关闭设置面板
document.addEventListener("click", (e) => {
  if (!ReaderShell.isOverlay(ReaderShell.OVERLAY.SETTINGS)) return;
  if (e.target.closest(".gear-wrap")) return; // 点齿轮或面板内部，不关
  closeSettings();
});

// 焦点在外壳时，把翻页键转发给合并页
window.addEventListener("keydown", (e) => {
  // 中文输入法候选/上屏会发 Process（keyCode 229）及组合键事件；
  // 这些事件不能触发阅读器的翻页和关闭浮层逻辑。
  if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
  // 焦点在输入控件（搜索框、设置里的滑块/数字框/下拉）时，方向键用于调节数值，
  // 不能抢去翻页，否则会 preventDefault 掉调节、还顺手关掉设置面板
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
  let dir = 0;
  if (e.key === "PageDown" || e.key === "ArrowRight" || e.key === "ArrowDown" || (e.key === " " && !e.shiftKey)) dir = 1;
  else if (e.key === "PageUp" || e.key === "ArrowLeft" || e.key === "ArrowUp" || (e.key === " " && e.shiftKey)) dir = -1;
  if (dir !== 0) {
    e.preventDefault();
    // 翻页同时收起浮层与沉浸工具栏
    if (
      ReaderShell.isOverlay(ReaderShell.OVERLAY.SEARCH) ||
      ReaderShell.isOverlay(ReaderShell.OVERLAY.SETTINGS)
    ) ReaderShell.closeOverlay();
    ReaderShell.dispatch({ type: "HIDE_TOOLBAR" });
    if (frame.contentWindow) frame.contentWindow.postMessage({ pageTurn: dir }, "*");
  }
});

// ---------- 阅读设置 ----------
// 阅读设置状态与面板绑定在 reader-settings-ui.js。

// 合并页加载完成后，PDF 直接由 WebView 渲染，加载事件即可关掉遮罩。
frame.addEventListener("load", () => {
  if (document.body.classList.contains("pdf-mode")) hideLoading();
});

// 阅读统计：只在有效阅读状态下按真实间隔累计；当前页也会定期结算字数。
setInterval(tickReadingTime, READ_TRACK.readingTimeTickMs);
setInterval(creditCurrentReadPage, READ_TRACK.periodicCreditMs);

// 目录、书签、批注/高亮 UI 在 reader-notes-ui.js。

(async () => {
  initSettingsUI();
  applyShellTheme(settings.theme);
  try {
    const info = await invoke("book_info");
    currentBookId = info.id || "";
    window.currentBookId = currentBookId;
    currentBookContentId = info.content_id || "";
    window.currentBookContentId = currentBookContentId;
    aiReaderMergeSyncedHistory();
    ensureReadCreditCache();
    window.updateCrossReturnButton?.();
    window.consumePendingCrossSearch?.();
    currentBookTitle = info.title || currentBookTitle || "";
    bookmarks = info.bookmarks || [];
    renderBookmarks();
    highlights = info.highlights || [];
    renderHighlights();
    if (info.format === "pdf") {
      document.body.classList.add("pdf-mode");
      isPdf = true;
      const rp = (info.resume_chapter || 0) + 1; // resume_chapter 存的是页码-1
      // 恢复这本 PDF 上次的缩放/双页
      let pscale = 0, pdual = 0;
      try {
        const ps = await invoke("get_pdf_state");
        if (ps) { pscale = ps.scale || 0; pdual = ps.dual ? 1 : 0; }
      } catch (e) {}
      if (pdual) {
        pdfDual = true;
        document.getElementById("pdf-dual").classList.add("active");
      }
      frame.src =
        "pdfview.html?u=" + encodeURIComponent(info.url) +
        "&p=" + rp +
        "&scale=" + pscale +
        "&dual=" + pdual +
        "&s=" + encodeURIComponent(JSON.stringify(settings));
      return;
    }
    resumeChapter = info.resume_chapter || 0;
    resumeFrac = info.resume_frac || 0;
    buildToc(info.toc || []);
    // 逻辑章节 = 目录条目按"所在文件(spine)"去重，每个文件取第一条：
    // 金庸全集每"回"是独立文件 → 保留到回级；Python Cookbook 上千个"#锚点小节"同属十几个章节文件 → 合并回章级。
    const toc = info.toc || [];
    vchaps = [];
    const seenCh = new Set();
    for (const e of toc) {
      const ch = e.chapter || 0;
      if (seenCh.has(ch)) continue;
      seenCh.add(ch);
      vchaps.push({ ch, frag: e.frag || "" });
    }
    vchapTotal = vchaps.length || (info.chapter_count || 1);
    // 设置 + 续读位置（章节/章内比例）随 URL 传给合并页：据此只加载该章并定位
    const q =
      "?rc=" + resumeChapter +
      "&rf=" + resumeFrac +
      "&ra=" + encodeURIComponent(JSON.stringify(info.resume_position || null)) +
      "&s=" + encodeURIComponent(JSON.stringify(settings));
    frame.src = info.url + q;
    // 若本次是从书架检索点开的，取走待跳转位置，合并页就绪后跳过去
    invoke("take_pending_jump").then((j) => { if (j) doJump(j); }).catch(() => {});
  } catch (e) {
    document.body.innerHTML =
      "<p style='padding:20px;color:#b00'>打开失败：" + e + "</p>";
  }
})();
