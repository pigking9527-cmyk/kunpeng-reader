//! Tauri boundary adapters for reading-assistant configuration.
//!
//! Validation and persistence deliberately stay in the parent domain module:
//! commands in this module only translate Tauri's state injection into an
//! `AppState` reference and preserve the existing public command names.

use super::{
    ai_capability_routes_status_inner, ai_reader_profiles_inner, ai_reader_status_inner,
    assign_ai_reader_profile_inner, intelligence_daily_digest_get_inner,
    intelligence_daily_digest_list_inner, intelligence_daily_digest_save_inner,
    intelligence_extract_source_evidence_inner, intelligence_generate_brief_inner,
    intelligence_host_preflight_inner, intelligence_judge_event_pairs_inner,
    intelligence_local_model_capabilities_inner, intelligence_local_model_preflight_inner,
    intelligence_local_model_save_inner, intelligence_local_model_status_inner,
    intelligence_triage_articles_inner, local_understanding_model_preflight_inner,
    news_rag::{
        cluster_intelligence_news_semantically, IntelligenceSemanticCandidate,
        IntelligenceSemanticClusterResult,
    },
    save_ai_capability_route_inner, save_ai_reader_config_inner, save_ai_reader_profile_inner,
    score_news_preferences_inner, select_ai_reader_profile_inner, AiCapabilityRoutesStatus,
    AiReaderProfilesStatus, AiReaderStatus, AssignAiReaderProfileRequest,
    IntelligenceArticleTriageResults, IntelligenceDailyDigest, IntelligenceDailyDigestSaveRequest,
    IntelligenceDailyDigestSummary, IntelligenceEventPairJudgements,
    IntelligenceExtractSourceEvidenceRequest, IntelligenceGenerateBriefRequest,
    IntelligenceGeneratedBrief, IntelligenceHostPreflight, IntelligenceJudgeEventPairsRequest,
    IntelligenceLocalModelCapabilities, IntelligenceLocalModelPreflight,
    IntelligenceLocalModelStatus, IntelligenceSourceEvidence, IntelligenceTriageArticlesRequest,
    LocalUnderstandingModelPreflight, NewsPreferenceScoreRequest, NewsPreferenceScores,
    SaveAiCapabilityRouteRequest, SaveAiReaderConfigRequest, SaveAiReaderProfileRequest,
    SaveIntelligenceLocalModelRequest,
};
use crate::host_inference_lifecycle::{
    IntelligenceHostPairingConfirmRequest, IntelligenceHostPairingInvite,
    IntelligenceHostPairingSummary, IntelligenceHostPairingsStatus,
};
use crate::AppState;

#[tauri::command]
pub(crate) fn ai_reader_status(
    state: tauri::State<'_, AppState>,
) -> Result<AiReaderStatus, String> {
    ai_reader_status_inner(state.inner())
}

/// Returns the five local Smart Management routes.  This command never
/// touches sync configuration or contacts a model/host.
#[tauri::command]
pub(crate) fn ai_capability_routes_status(
    state: tauri::State<'_, AppState>,
) -> Result<AiCapabilityRoutesStatus, String> {
    ai_capability_routes_status_inner(state.inner())
}

/// Runs the explicit authenticated host check.  Only a safe status projection
/// crosses the Tauri boundary; pairing material and account credentials stay local.
#[tauri::command]
pub(crate) fn intelligence_host_preflight(
    state: tauri::State<'_, AppState>,
) -> Result<IntelligenceHostPreflight, String> {
    intelligence_host_preflight_inner(state.inner())
}

/// Creates a one-time, account-authenticated host invite. Its secret invite
/// code is returned exactly once; the private HPKE key never leaves Rust.
#[tauri::command]
pub(crate) fn intelligence_host_pairing_begin(
    state: tauri::State<'_, AppState>,
) -> Result<IntelligenceHostPairingInvite, String> {
    crate::host_inference_lifecycle::begin_pairing(state.inner())
}

/// Verifies a host-produced public confirmation against the authenticated
/// service before persisting the DPAPI-protected client identity.
#[tauri::command]
pub(crate) fn intelligence_host_pairing_confirm(
    state: tauri::State<'_, AppState>,
    request: IntelligenceHostPairingConfirmRequest,
) -> Result<IntelligenceHostPairingSummary, String> {
    crate::host_inference_lifecycle::confirm_pairing(state.inner(), request)
}

#[tauri::command]
pub(crate) fn intelligence_host_pairings(
    state: tauri::State<'_, AppState>,
) -> Result<IntelligenceHostPairingsStatus, String> {
    crate::host_inference_lifecycle::list_pairings(state.inner())
}

#[tauri::command]
pub(crate) fn intelligence_host_pairing_revoke(
    state: tauri::State<'_, AppState>,
    pair_id: String,
) -> Result<IntelligenceHostPairingsStatus, String> {
    crate::host_inference_lifecycle::revoke_pairing(state.inner(), pair_id)
}

/// Persists one local capability route after strict mode/ID validation.
#[tauri::command]
pub(crate) fn save_ai_capability_route(
    state: tauri::State<'_, AppState>,
    request: SaveAiCapabilityRouteRequest,
) -> Result<AiCapabilityRoutesStatus, String> {
    save_ai_capability_route_inner(state.inner(), request)
}

#[tauri::command]
pub(crate) fn ai_reader_profiles(
    state: tauri::State<'_, AppState>,
) -> Result<AiReaderProfilesStatus, String> {
    ai_reader_profiles_inner(state.inner())
}

#[tauri::command]
pub(crate) fn select_ai_reader_profile(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<AiReaderStatus, String> {
    select_ai_reader_profile_inner(state.inner(), id)
}

#[tauri::command]
pub(crate) fn assign_ai_reader_profile(
    state: tauri::State<'_, AppState>,
    request: AssignAiReaderProfileRequest,
) -> Result<AiReaderProfilesStatus, String> {
    assign_ai_reader_profile_inner(state.inner(), request)
}

#[tauri::command]
pub(crate) fn save_ai_reader_profile(
    state: tauri::State<'_, AppState>,
    request: SaveAiReaderProfileRequest,
) -> Result<AiReaderProfilesStatus, String> {
    save_ai_reader_profile_inner(state.inner(), request)
}

#[tauri::command]
pub(crate) fn save_ai_reader_config(
    state: tauri::State<'_, AppState>,
    request: SaveAiReaderConfigRequest,
) -> Result<AiReaderStatus, String> {
    save_ai_reader_config_inner(state.inner(), request)
}

#[tauri::command]
pub(crate) fn intelligence_local_model_status(
    state: tauri::State<'_, AppState>,
) -> Result<IntelligenceLocalModelStatus, String> {
    intelligence_local_model_status_inner(state.inner())
}

#[tauri::command]
pub(crate) async fn intelligence_local_model_capabilities(
) -> Result<IntelligenceLocalModelCapabilities, String> {
    tauri::async_runtime::spawn_blocking(intelligence_local_model_capabilities_inner)
        .await
        .map_err(|error| format!("本机模型显卡检测失败：{error}"))
}

#[tauri::command]
pub(crate) async fn intelligence_local_model_preflight(
    state: tauri::State<'_, AppState>,
) -> Result<IntelligenceLocalModelPreflight, String> {
    intelligence_local_model_preflight_inner(state.inner()).await
}

/// Checks only the local OpenAI-compatible `/models` endpoint for the model
/// actually assigned to 智读与书库.  No book text or prompt is sent.
#[tauri::command]
pub(crate) async fn local_understanding_model_preflight(
    state: tauri::State<'_, AppState>,
) -> Result<LocalUnderstandingModelPreflight, String> {
    local_understanding_model_preflight_inner(state.inner()).await
}

#[tauri::command]
pub(crate) fn intelligence_local_model_save(
    state: tauri::State<'_, AppState>,
    request: SaveIntelligenceLocalModelRequest,
) -> Result<IntelligenceLocalModelStatus, String> {
    intelligence_local_model_save_inner(state.inner(), request)
}

#[tauri::command]
pub(crate) async fn intelligence_generate_brief(
    state: tauri::State<'_, AppState>,
    request: IntelligenceGenerateBriefRequest,
) -> Result<IntelligenceGeneratedBrief, String> {
    intelligence_generate_brief_inner(state.inner(), request).await
}

/// Judges only rule/RAG-recalled public-news pairs.  It remains model-agnostic:
/// callers can optionally select another model already available from the same
/// configured local endpoint, while the endpoint itself stays loopback-only.
#[tauri::command]
pub(crate) async fn intelligence_judge_event_pairs(
    state: tauri::State<'_, AppState>,
    request: IntelligenceJudgeEventPairsRequest,
) -> Result<IntelligenceEventPairJudgements, String> {
    intelligence_judge_event_pairs_inner(state.inner(), request).await
}

#[tauri::command]
pub(crate) async fn intelligence_triage_articles(
    state: tauri::State<'_, AppState>,
    request: IntelligenceTriageArticlesRequest,
) -> Result<IntelligenceArticleTriageResults, String> {
    intelligence_triage_articles_inner(state.inner(), request).await
}

/// Scores only already-downloaded, account-validated formal publications for
/// local display order. It never persists, hides, syncs, or uploads a score.
#[tauri::command]
pub(crate) async fn score_news_preferences(
    state: tauri::State<'_, AppState>,
    request: NewsPreferenceScoreRequest,
) -> Result<NewsPreferenceScores, String> {
    score_news_preferences_inner(state.inner(), request).await
}

#[tauri::command]
pub(crate) async fn intelligence_extract_source_evidence(
    state: tauri::State<'_, AppState>,
    request: IntelligenceExtractSourceEvidenceRequest,
) -> Result<IntelligenceSourceEvidence, String> {
    intelligence_extract_source_evidence_inner(state.inner(), request).await
}

#[tauri::command]
pub(crate) fn intelligence_cluster_news_semantically(
    state: tauri::State<'_, AppState>,
    candidates: Vec<IntelligenceSemanticCandidate>,
) -> Result<IntelligenceSemanticClusterResult, String> {
    cluster_intelligence_news_semantically(state.inner(), &candidates)
}

/// Saves a public-news-only daily briefing in the local cache. It is not part
/// of reader backup, sync, or any remote payload.
#[tauri::command]
pub(crate) fn intelligence_daily_digest_save(
    request: IntelligenceDailyDigestSaveRequest,
) -> Result<IntelligenceDailyDigestSummary, String> {
    intelligence_daily_digest_save_inner(request)
}

/// Lists up to 90 local calendar-day digest summaries, newest first.
#[tauri::command]
pub(crate) fn intelligence_daily_digest_list() -> Result<Vec<IntelligenceDailyDigestSummary>, String>
{
    intelligence_daily_digest_list_inner()
}

/// Reads one local day when `day` is supplied; without it, returns the most
/// recently saved day. The frontend owns timezone selection and passes its
/// local YYYY-MM-DD key unchanged.
#[tauri::command]
pub(crate) fn intelligence_daily_digest_get(
    day: Option<String>,
) -> Result<Option<IntelligenceDailyDigest>, String> {
    intelligence_daily_digest_get_inner(day)
}
