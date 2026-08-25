const byId = (id) => document.getElementById(id);
const state = byId("host-state");
const updated = byId("host-updated");
const metrics = byId("metrics");
const audit = byId("audit");
const runSummary = byId("run-summary");
const refresh = byId("refresh");
const initialize = byId("initialize");
const runOnce = byId("run-once");
const continuousLogin = byId("continuous-login");
const continuousStart = byId("continuous-start");
const continuousStop = byId("continuous-stop");
const distributionState = byId("distribution-state");
const distributionForm = byId("distribution-form");
const distributionBaseUrl = byId("distribution-base-url");
const distributionPublishCredential = byId("distribution-publish-credential");
const distributionRelayCredential = byId("distribution-relay-credential");
const distributionLaunchAtLogin = byId("distribution-launch-at-login");
const distributionPair = byId("distribution-pair");
const distributionRevoke = byId("distribution-revoke");
const distributionNotice = byId("distribution-notice");
const loadArticleAudit = byId("load-article-audit");
const articleReviewNotice = byId("article-review-notice");
const articleReviewList = byId("article-review-list");
const articleReviewDetail = byId("article-review-detail");

function metric(label, value, detail) {
  const item = document.createElement("article"); item.className = "metric";
  const title = document.createElement("strong"); title.textContent = label;
  const count = document.createElement("span"); count.textContent = String(value);
  const caption = document.createElement("span"); caption.textContent = detail;
  item.replaceChildren(title, count, caption); return item;
}
const outcomeLabels = {
  disabled: "主机未启用", collector_not_configured: "未配置采集器", evidence_completed: "证据阶段完成",
  collection_and_backfill_incomplete: "采集与全文补全未完成", collection_incomplete: "采集未完成",
  content_backfill_incomplete: "全文补全未完成", evidence_completed_models_not_configured: "证据阶段完成，模型未配置",
  triage_runtime_unavailable: "初筛模型不可用", triage_incomplete: "初筛未完成",
  relation_processing_incomplete: "关系判断未完成", editorial_runtime_unavailable: "综合模型不可用",
  processing_incomplete: "综合未完成", collected: "已采集", collection_failed: "采集失败",
  processed: "已处理", processing_idle: "无待处理项", processing_retry_scheduled: "已安排重试",
  processing_not_configured: "处理未配置", daily_prepared_locally: "已在本机准备发布包",
  daily_events_unavailable: "暂无可发布事件", daily_already_published: "当日已发布",
  daily_published: "已发布", publication_transport_unavailable: "发布通道不可用",
  publication_failed: "发布失败", not_run: "未执行", unknown: "未识别的安全状态",
};
const lifecycleLabels = {
  running: "运行中", completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "未知",
};
function outcomeLabel(value) { return outcomeLabels[value] || "未识别的安全状态"; }
function lifecycleLabel(value) { return lifecycleLabels[value] || "未知"; }
function formatRun(report) {
  if (!report) return "尚无运行记录";
  return `结果 ${outcomeLabel(report.outcome)} · 采集 ${outcomeLabel(report.collection)}（新增 ${Number(report.collected) || 0}，重复 ${Number(report.duplicates) || 0}）· 全文完成 ${Number(report.backfilled) || 0}，重试 ${Number(report.backfillRetried) || 0} · 初筛 ${Number(report.triaged) || 0}，重试 ${Number(report.retried) || 0} · 关系 ${outcomeLabel(report.relation)} · 综合 ${outcomeLabel(report.editorial)}（${Number(report.processed) || 0} 项，复核 ${Number(report.reviewed) || 0}）· 发布 ${outcomeLabel(report.publication)}`;
}
function formatAuditRun(auditRun) {
  if (!auditRun) return "尚无运行记录";
  const status = lifecycleLabel(auditRun.status);
  const stage = auditRun.currentStage ? ` · ${stageLabel(auditRun.currentStage)}` : "";
  const runCode = typeof auditRun.runCode === "string" && /^[a-f0-9]{8}$/i.test(auditRun.runCode)
    ? auditRun.runCode.toLowerCase() : "未知";
  const report = auditRun.report ? ` · ${formatRun(auditRun.report)}` : auditRun.status === "running"
    ? " · 聚合结果将在本轮写入完成后显示" : "";
  return `轮次 #${runCode} · ${status}${stage}${report}`;
}
const stageLabels = {
  preparing: "准备本机处理",
  collection: "采集来源元数据",
  full_text_backfill: "补取并归档全文",
  triage_runtime: "校验并装载 8B 判定模型",
  triage_runtime_ready: "8B 判定模型已就绪",
  small_model_triage: "8B 判断重要性",
  vector_recall_and_relation: "召回近邻并判断事件关系",
  editorial_runtime: "校验并切换 27B 综合模型",
  editorial_runtime_ready: "27B 综合模型已就绪",
  editorial_synthesis: "27B 生成综合报道",
  publication: "生成并投递发布包",
  publication_without_model: "模型不可用时检查已有发布包",
};
function stageLabel(value) { return stageLabels[value] || "未知阶段"; }
const backfillFailureLabels = {
  http_access_denied: "访问受限",
  http_not_found: "页面不存在",
  http_rate_limited: "访问限流",
  http_server_error: "来源服务异常",
  network_request_failed: "网络请求失败",
  body_paywall_or_interstitial: "付费墙或跳转页",
  body_not_found: "未提取到正文",
  content_extraction_failed: "正文提取失败",
  google_news_target_unresolved: "聚合来源未解析",
  archive_persist_failed: "本地归档失败",
  other: "其他固定错误",
};
function backfillHealth(status) {
  return status && status.fullTextBackfill && typeof status.fullTextBackfill === "object" ? status.fullTextBackfill : {};
}
function formatBackfillFailures(health) {
  const rows = Array.isArray(health.failureCategories) ? health.failureCategories : [];
  const visible = rows.filter((row) => Number(row && row.count) > 0)
    .map((row) => `${backfillFailureLabels[row.category] || "其他固定错误"} ${Number(row.count)}`);
  return visible.length ? visible.join(" · ") : "暂无持久失败分类";
}
function render(status) {
  const fullTextHealth = backfillHealth(status);
  const waitingFullText = Number.isFinite(Number(fullTextHealth.waitingCount))
    ? Number(fullTextHealth.waitingCount) : Number(status.awaitingFullTextCount) || 0;
  const continuousActive = Boolean(status.continuousProcessingActive);
  continuousLogin.checked = Boolean(status.launchAtLogin);
  continuousStart.disabled = continuousActive || Boolean(status.pipelineRunning);
  continuousStop.disabled = !continuousActive && !Boolean(status.enabled);
  runOnce.disabled = continuousActive;
  state.textContent = status.pipelineRunning
    ? `本机主机正在处理：${stageLabel(status.currentStage)}`
    : continuousActive ? "本机持续处理正在等待下一轮"
      : status.enabled ? "本机持续处理等待启动" : "主机尚未启用";
  if (status.lastError) state.textContent = String(status.lastError);
  updated.textContent = `更新于 ${new Date().toLocaleTimeString("zh-CN")}`;
  metrics.replaceChildren(
    metric("永久归档", status.articleCount, `当前版本完整证据 ${status.fullTextCount} 篇`),
    metric("待补全文", waitingFullText, "有公开来源、等待归档正文"),
    metric("版本变更待核验", status.evidenceVersionMismatchCount || 0, "保留旧正文，不把它当作当前版本证据"),
    metric("文章级可重试", fullTextHealth.retryableNowCount || 0, `退避中 ${fullTextHealth.delayedCount || 0} 篇`),
    metric("来源健康", `${fullTextHealth.healthySourceCount || 0}/${fullTextHealth.knownSourceCount || 0}`, `降级 ${fullTextHealth.degradedSourceCount || 0} · 熔断 ${fullTextHealth.circuitOpenSourceCount || 0}`),
    metric("模型候选总数", status.queuedCount, `其中待 8B 初筛 ${status.readyForTriageCount} 篇`),
    metric("历史归档补全", status.historicalBackfillCount, "不进入当前模型队列"),
    metric("待关系判断", status.readyForRelationCount, "已完成初筛，等待 8B 关系核验"),
    metric("待 27B 综合", status.readyForEditorialCount, `已生成事件 ${status.processedCount}`),
    metric("保留", status.keptCount, `已过滤 ${status.filteredCount} 篇`),
    metric("持续处理", continuousActive ? "运行中" : status.enabled ? "待启动" : "已停止", status.launchAtLogin ? "登录 Windows 后继续" : "仅本次后台运行"),
    metric("主机组件", status.workerAvailable ? 1 : 0, status.configurationReady ? "来源与模型已配置" : "配置尚未完成"),
  );
  byId("collection-detail").textContent = status.archivePresent ? `永久档案已打开；当前版本完整证据 ${Number(status.fullTextCount) || 0} 篇，${waitingFullText} 篇等待全文补全，其中 ${Number(status.evidenceVersionMismatchCount) || 0} 篇保留旧版本正文但必须重新核验。文章级可重试 ${fullTextHealth.retryableNowCount || 0} 篇、退避中 ${fullTextHealth.delayedCount || 0} 篇。已观测来源 ${fullTextHealth.knownSourceCount || 0} 个：健康 ${fullTextHealth.healthySourceCount || 0}、降级 ${fullTextHealth.degradedSourceCount || 0}、熔断 ${fullTextHealth.circuitOpenSourceCount || 0}；不显示来源名称。失败分类：${formatBackfillFailures(fullTextHealth)}。` : "尚未创建本机永久档案。请先初始化并执行一轮处理。";
  byId("triage-detail").textContent = `待初筛 ${status.readyForTriageCount} 篇；已完成关系判断、等待综合 ${status.readyForEditorialCount} 篇。`;
  byId("editorial-detail").textContent = `已生成 ${status.processedCount} 个综合事件；发布状态由登录账户的主机配对决定。`;
  runSummary.textContent = status.auditRun ? formatAuditRun(status.auditRun) : formatRun(status.lastRun);
  const rows = status.auditRun && Array.isArray(status.auditRun.stageSequence)
    ? status.auditRun.stageSequence : Array.isArray(status.auditSummary) ? status.auditSummary : [];
  if (!rows.length) { audit.className = "audit-empty"; audit.textContent = "尚无审计摘要。执行一轮处理后会显示各阶段的聚合结果。"; return; }
  const report = status.auditRun && status.auditRun.report;
  const reportItem = report ? (() => {
    const item = document.createElement("article"); item.className = "audit-item";
    const label = document.createElement("strong"); label.textContent = "本轮聚合报告";
    const value = document.createElement("span"); value.textContent = formatRun(report);
    item.replaceChildren(label, value); return item;
  })() : null;
  audit.className = "audit"; audit.replaceChildren(...[reportItem, ...rows.map((row) => {
    const item = document.createElement("article"); item.className = "audit-item";
    const label = document.createElement("strong"); label.textContent = stageLabel(String(row.stage || ""));
    const value = document.createElement("span");
    const phase = document.createElement("b"); phase.textContent = lifecycleLabel(String(row.status || "unknown"));
    const unit = row.unit === "stage_invocations" ? "次调用" : "项";
    value.replaceChildren(phase, document.createTextNode(` · ${Number(row.count) || 0} ${unit}`));
    item.replaceChildren(label, value); return item;
  })].filter(Boolean));
}
async function getStatus() { const response = await fetch("/api/status", { cache: "no-store" }); if (!response.ok) throw new Error("status unavailable"); return response.json(); }
async function getDistributionStatus() { const response = await fetch("/api/distribution-status", { cache: "no-store" }); if (!response.ok) throw new Error("distribution unavailable"); return response.json(); }
async function refreshStatus() { refresh.disabled = true; try { render(await getStatus()); } catch { state.textContent = "无法连接本机主机"; updated.textContent = "请确认本机工作台仍在运行"; } finally { refresh.disabled = false; } }
async function post(action) { const response = await fetch(action, { method: "POST", headers: { "Content-Type": "application/json", "X-Kunpeng-Host-Dashboard": "1" }, body: "{}" }); if (!response.ok) { const message = await response.text(); throw new Error(message || "操作失败"); } return response.json(); }
async function postJson(action, body) { const response = await fetch(action, { method: "POST", headers: { "Content-Type": "application/json", "X-Kunpeng-Host-Dashboard": "1" }, body: JSON.stringify(body) }); if (!response.ok) { const message = await response.text(); throw new Error(message || "操作失败"); } return response.json(); }
function stateChip(label, value) { const chip = document.createElement("span"); chip.className = `chip ${/(complete|completed|keep|canonical|prepared|ready)/.test(String(value)) ? "done" : /(waiting|queued|retry|failed)/.test(String(value)) ? "wait" : ""}`; chip.textContent = label; return chip; }
function auditDetailBlock(label, value) { const block = document.createElement("article"); const title = document.createElement("strong"); title.textContent = label; const detail = document.createElement("span"); detail.textContent = value; block.replaceChildren(title, detail); return block; }
function formatCount(label, count) { return `${label} ${Number(count) || 0}`; }
function renderArticleAudit(items) {
  articleReviewList.replaceChildren(...items.map((item) => {
    const row = document.createElement("article"); row.className = "article-row";
    const summary = document.createElement("div"); const title = document.createElement("h3"); title.textContent = String(item.title || "未命名新闻");
    const source = document.createElement("p"); source.textContent = `${String(item.source || "未标注来源")} · ${String(item.publishedAt || "未标注时间")}`;
    const meta = document.createElement("div"); meta.className = "article-row-meta";
    meta.replaceChildren(
      stateChip(`全文：${item.fullText && item.fullText.status || "waiting"}`, item.fullText && item.fullText.status),
      stateChip(`去重：${item.dedupe && item.dedupe.role || "waiting"}`, item.dedupe && item.dedupe.role),
      stateChip(`8B：${item.triageState || "queued"}`, item.triageState),
      stateChip(`27B：${item.editorial && item.editorial.state || "waiting"}`, item.editorial && item.editorial.state),
    );
    summary.replaceChildren(title, source, meta);
    const button = document.createElement("button"); button.type = "button"; button.textContent = "查看每步明细"; button.addEventListener("click", () => { void loadArticleDetail(item.handle); });
    row.replaceChildren(summary, button); return row;
  }));
}
async function loadArticleDetail(handle) {
  articleReviewDetail.hidden = false; articleReviewDetail.textContent = "正在读取该条新闻的固定处理投影…";
  try {
    const item = await postJson("/api/audit/article", { handle });
    const title = document.createElement("h3"); title.textContent = String(item.title || "新闻处理明细");
    const subtitle = document.createElement("p"); subtitle.textContent = `${String(item.source || "未标注来源")} · ${String(item.publishedAt || "未标注时间")}`;
    const grid = document.createElement("div"); grid.className = "detail-grid";
    const full = item.fullText || {}; const media = item.media || {}; const dedupe = item.dedupe || {}; const semantic = item.semantic || {}; const triage = item.triage || {}; const editorial = item.editorial || {}; const publication = item.publication || {};
    grid.replaceChildren(
      auditDetailBlock("01 抓取与全文", `正文：${full.status || "waiting"}；版本 ${Number(full.versions) || 0}；段落 ${Number(full.paragraphs) || 0}`),
      auditDetailBlock("02 媒体归档", `${formatCount("图片", media.images)}；${formatCount("视频链接", media.videos)}`),
      auditDetailBlock("03 确定性去重", `角色：${dedupe.role || "waiting"}；同正文别名 ${Number(dedupe.aliases) || 0}`),
      auditDetailBlock("04 语义近邻与关系", `向量：${semantic.vectorReady ? `已就绪 ${semantic.vectorDimensions || ""} 维` : "等待"}；关系候选 ${Number(semantic.relationCandidates) || 0}；状态 ${semantic.relationState || "waiting"}`),
      auditDetailBlock("05 8B 初筛", `状态：${triage.state || item.triageState || "queued"}；重要性 ${triage.importance ?? "待判定"}；置信度 ${triage.confidencePercent == null ? "待判定" : `${triage.confidencePercent}%`}；模型 ${triage.model || "尚未调用"}`),
      auditDetailBlock("06 27B 综合与事件", `状态：${editorial.state || "waiting"}；${editorial.eventLinked ? `已归入事件：${editorial.eventTitle || "已生成"}` : "尚未归入综合事件"}`),
      auditDetailBlock("07 本地日报包", publication.day ? `状态：${publication.state || "prepared_locally"}；最近包 ${publication.day}` : "尚未准备日报包"),
      auditDetailBlock("审阅边界", "本页为处理证明；不显示正文、原始链接、模型提示词/推理或任何凭据。"),
    );
    const close = document.createElement("button"); close.type = "button"; close.className = "secondary detail-close"; close.textContent = "收起明细"; close.addEventListener("click", () => { articleReviewDetail.hidden = true; articleReviewDetail.replaceChildren(); });
    articleReviewDetail.replaceChildren(title, subtitle, grid, close);
  } catch { articleReviewDetail.textContent = "该条新闻的审计投影暂不可读取；本机处理未受影响。"; }
}
async function refreshArticleAudit() {
  loadArticleAudit.disabled = true; articleReviewNotice.textContent = "正在读取最近 24 条新闻的处理投影…";
  try { const result = await post("/api/audit/articles"); const items = Array.isArray(result.items) ? result.items : []; renderArticleAudit(items); articleReviewNotice.textContent = items.length ? `已加载 ${items.length} 条。点击“查看每步明细”只读取该条记录。` : "当前档案尚无可审阅新闻。"; }
  catch { articleReviewNotice.textContent = "无法读取逐条审计；后台处理未受影响。"; }
  finally { loadArticleAudit.disabled = false; }
}
function setDistributionNotice(message, error = false) { distributionNotice.textContent = message; distributionNotice.classList.toggle("error", error); }
function renderDistribution(status) {
  const paired = Boolean(status && status.paired);
  distributionState.textContent = paired ? "已配对" : "尚未配对";
  distributionRevoke.disabled = !paired;
  if (paired) {
    setDistributionNotice(`本机处理${status.enabled ? "已启用" : "未启用"}；发布凭据 ${status.publishCredentialPresent ? "已保存" : "缺失"}，回源凭据 ${status.relayCredentialPresent ? "已保存" : "缺失"}。`);
  } else {
    setDistributionNotice("未保存发布凭据。输入短期、可撤销的 capability 后才会启动本机分发。 ");
  }
}
async function refreshDistribution() {
  try { renderDistribution(await getDistributionStatus()); }
  catch { distributionState.textContent = "无法读取"; setDistributionNotice("无法读取本机分发状态。", true); }
}
initialize.addEventListener("click", async () => { initialize.disabled = true; try { await post("/api/initialize"); await refreshStatus(); } catch (error) { state.textContent = `初始化失败：${error.message}`; } finally { initialize.disabled = false; } });
runOnce.addEventListener("click", async () => { runOnce.disabled = true; try { await post("/api/run-once"); state.textContent = "已开始一轮本机处理，状态会自动刷新"; } catch (error) { state.textContent = `启动失败：${error.message}`; runOnce.disabled = false; return; } setTimeout(() => { runOnce.disabled = false; void refreshStatus(); }, 800); });
continuousStart.addEventListener("click", async () => { continuousStart.disabled = true; try { await postJson("/api/continuous-start", { launchAtLogin: continuousLogin.checked }); state.textContent = "已启动本机持续处理；页面可关闭，后台会继续按轮处理"; setTimeout(() => { void refreshStatus(); }, 700); } catch (error) { state.textContent = `启动持续处理失败：${error.message}`; continuousStart.disabled = false; } });
continuousStop.addEventListener("click", async () => { continuousStop.disabled = true; try { await post("/api/continuous-stop"); state.textContent = "本机持续处理将在当前轮完成后停止"; setTimeout(() => { void refreshStatus(); }, 1200); } catch (error) { state.textContent = `停止持续处理失败：${error.message}`; continuousStop.disabled = false; } });
refresh.addEventListener("click", () => { void refreshStatus(); });
loadArticleAudit.addEventListener("click", () => { void refreshArticleAudit(); });
distributionForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  distributionPair.disabled = true;
  setDistributionNotice("正在保存本机配对…");
  const request = {
    baseUrl: distributionBaseUrl.value.trim(),
    publishCredential: distributionPublishCredential.value,
    relayCredential: distributionRelayCredential.value,
    launchAtLogin: distributionLaunchAtLogin.checked,
  };
  try {
    const response = await fetch("/api/distribution-pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Kunpeng-Host-Dashboard": "1" },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new Error("pairing failed");
    distributionForm.reset();
    distributionLaunchAtLogin.checked = true;
    await refreshDistribution();
  } catch {
    setDistributionNotice("本机分发配对未完成；请核对 HTTPS 地址、短期 capability 和本机 worker 安装。", true);
  } finally {
    // Do not retain a capability in DOM state after this one native request.
    distributionBaseUrl.value = "";
    distributionPublishCredential.value = "";
    distributionRelayCredential.value = "";
    distributionPair.disabled = false;
  }
});
distributionRevoke.addEventListener("click", async () => {
  distributionRevoke.disabled = true;
  try { await post("/api/distribution-revoke"); await refreshDistribution(); }
  catch { setDistributionNotice("无法撤销本机分发配置。", true); }
  finally { distributionRevoke.disabled = false; }
});
void refreshStatus(); setInterval(() => { void refreshStatus(); }, 5000);
void refreshDistribution(); setInterval(() => { void refreshDistribution(); }, 5000);
