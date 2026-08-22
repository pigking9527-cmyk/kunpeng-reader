//! Tauri boundary adapters for reading-assistant configuration.
//!
//! Validation and persistence deliberately stay in the parent domain module:
//! commands in this module only translate Tauri's state injection into an
//! `AppState` reference and preserve the existing public command names.

use super::{
    ai_reader_profiles_inner, ai_reader_status_inner, assign_ai_reader_profile_inner,
    intelligence_daily_digest_get_inner, intelligence_daily_digest_list_inner,
    intelligence_daily_digest_save_inner, intelligence_extract_source_evidence_inner,
    intelligence_generate_brief_inner, intelligence_judge_event_pairs_inner,
    intelligence_local_model_save_inner, intelligence_local_model_status_inner,
    intelligence_triage_articles_inner,
    news_rag::{
        cluster_intelligence_news_semantically, IntelligenceSemanticCandidate,
        IntelligenceSemanticClusterResult,
    },
    save_ai_reader_config_inner, save_ai_reader_profile_inner, select_ai_reader_profile_inner,
    AiReaderProfilesStatus, AiReaderStatus, AssignAiReaderProfileRequest,
    IntelligenceArticleTriageResults, IntelligenceDailyDigest, IntelligenceDailyDigestSaveRequest,
    IntelligenceDailyDigestSummary, IntelligenceEventPairJudgements,
    IntelligenceExtractSourceEvidenceRequest, IntelligenceGenerateBriefRequest,
    IntelligenceGeneratedBrief, IntelligenceJudgeEventPairsRequest, IntelligenceLocalModelStatus,
    IntelligenceSourceEvidence, IntelligenceTriageArticlesRequest, SaveAiReaderConfigRequest,
    SaveAiReaderProfileRequest, SaveIntelligenceLocalModelRequest,
};
use crate::AppState;

#[tauri::command]
pub(crate) fn ai_reader_status(
    state: tauri::State<'_, AppState>,
) -> Result<AiReaderStatus, String> {
    ai_reader_status_inner(state.inner())
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
