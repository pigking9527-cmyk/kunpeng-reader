//! Tauri boundary adapters for reading-assistant configuration.
//!
//! Validation and persistence deliberately stay in the parent domain module:
//! commands in this module only translate Tauri's state injection into an
//! `AppState` reference and preserve the existing public command names.

use super::{
    ai_reader_profiles_inner, ai_reader_status_inner, assign_ai_reader_profile_inner,
    save_ai_reader_config_inner, save_ai_reader_profile_inner, select_ai_reader_profile_inner,
    AiReaderProfilesStatus, AiReaderStatus, AssignAiReaderProfileRequest,
    SaveAiReaderConfigRequest, SaveAiReaderProfileRequest,
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
