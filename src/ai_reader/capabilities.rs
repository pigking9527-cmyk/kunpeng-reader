//! Local-only Smart Management capability routing.
//!
//! This is deliberately separate from synced reader configuration.  A route
//! says where this device prefers to execute an AI capability; it contains no
//! book text, credentials, endpoint URL or model index and is never projected
//! into a sync entity.

use crate::db::AppDb;
use serde::{Deserialize, Serialize};

const CAPABILITY_ROUTES_KEY: &str = "ai_capability_routes_local:v1";
const MAX_PROFILE_ID_CHARS: usize = 96;
const MAX_HOST_ID_CHARS: usize = 96;

const CAPABILITIES: [&str; 5] = [
    "search",
    "understanding",
    "news_preference",
    "deep_analysis",
    "companion",
];

const MODES: [&str; 5] = ["auto", "local", "intelligence_host", "cloud", "off"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiCapabilityRoute {
    pub(crate) capability: String,
    pub(crate) mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) updated_at: Option<i64>,
    /// These flags are runtime capability information, not persisted settings.
    /// They deliberately do not infer availability from a GPU name: actual
    /// model health remains a separate check owned by the runtime/UI layer.
    pub(crate) allow_auto: bool,
    pub(crate) allow_local: bool,
    pub(crate) allow_intelligence_host: bool,
    pub(crate) allow_cloud: bool,
    pub(crate) allow_off: bool,
    pub(crate) unavailable_reason: Option<String>,
}

/// On-disk form intentionally excludes runtime availability.  It remains
/// compact and can never preserve a stale claim that a remote host or GPU is
/// ready.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredAiCapabilityRoute {
    capability: String,
    mode: String,
    #[serde(default)]
    profile_id: Option<String>,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    updated_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAiCapabilityRouteRequest {
    pub(crate) capability: String,
    pub(crate) mode: String,
    #[serde(default)]
    pub(crate) profile_id: Option<String>,
    #[serde(default)]
    pub(crate) host_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiCapabilityRoutesStatus {
    pub(crate) routes: Vec<AiCapabilityRoute>,
}

fn default_routes() -> Vec<AiCapabilityRoute> {
    CAPABILITIES
        .iter()
        .map(|capability| AiCapabilityRoute {
            capability: (*capability).to_string(),
            mode: "auto".to_string(),
            profile_id: None,
            host_id: None,
            updated_at: None,
            allow_auto: false,
            allow_local: false,
            allow_intelligence_host: false,
            allow_cloud: false,
            allow_off: false,
            unavailable_reason: None,
        })
        .collect()
}

fn normalize_optional_id(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max_chars || value.chars().any(char::is_control) {
        return Err(format!("{field} 格式无效或过长"));
    }
    Ok(Some(value.to_string()))
}

fn normalize_route(
    capability: &str,
    mode: &str,
    profile_id: Option<String>,
    host_id: Option<String>,
    updated_at: Option<i64>,
) -> Result<AiCapabilityRoute, String> {
    let capability = capability.trim();
    if !CAPABILITIES.contains(&capability) {
        return Err("不支持的智能能力".into());
    }
    let mode = mode.trim();
    if !MODES.contains(&mode) {
        return Err("不支持的能力处理方式".into());
    }
    let profile_id = normalize_optional_id(profile_id, "模型配置 ID", MAX_PROFILE_ID_CHARS)?;
    let host_id = normalize_optional_id(host_id, "情报主机 ID", MAX_HOST_ID_CHARS)?;

    match mode {
        "intelligence_host" => {
            if host_id.is_none() {
                return Err("请选择情报主机后再启用情报主机处理".into());
            }
            if profile_id.is_some() {
                return Err("情报主机处理不能同时指定本机或云端模型配置".into());
            }
        }
        "auto" | "off" => {
            if profile_id.is_some() || host_id.is_some() {
                return Err("自动或关闭模式不能附带模型或主机选择".into());
            }
        }
        "local" | "cloud" => {
            if host_id.is_some() {
                return Err("本机或云端处理不能附带情报主机 ID".into());
            }
        }
        _ => unreachable!(),
    }

    Ok(AiCapabilityRoute {
        capability: capability.to_string(),
        mode: mode.to_string(),
        profile_id,
        host_id,
        updated_at,
        allow_auto: false,
        allow_local: false,
        allow_intelligence_host: false,
        allow_cloud: false,
        allow_off: false,
        unavailable_reason: None,
    })
}

fn route_with_runtime_availability(mut route: AiCapabilityRoute) -> AiCapabilityRoute {
    route.allow_auto = true;
    route.allow_local = true;
    // The semantic index is a local corpus and has no cloud embedding
    // transport.  Showing "cloud" there would create a route which cannot be
    // honoured.  Other capabilities can use a configured remote chat model.
    route.allow_cloud = route.capability != "search";
    route.allow_off = true;
    // A saved host ID is never enough. The route is available only after the
    // local DPAPI pairing and a short-lived authenticated preflight agree.
    let host = crate::host_inference_lifecycle::route_availability(
        &route.capability,
        route.host_id.as_deref(),
    );
    route.allow_intelligence_host = host.available;
    route.unavailable_reason = (!host.available).then(|| host.reason.to_string());
    route
}

fn route_mode_allowed(route: &AiCapabilityRoute) -> bool {
    match route.mode.as_str() {
        "auto" => route.allow_auto,
        "local" => route.allow_local,
        "intelligence_host" => route.allow_intelligence_host,
        "cloud" => route.allow_cloud,
        "off" => route.allow_off,
        _ => false,
    }
}

fn routes_for_status(routes: Vec<AiCapabilityRoute>) -> Vec<AiCapabilityRoute> {
    routes
        .into_iter()
        .map(route_with_runtime_availability)
        .collect()
}

fn load_routes(db: &AppDb) -> Result<Vec<AiCapabilityRoute>, String> {
    let raw = db.metadata(CAPABILITY_ROUTES_KEY).unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(default_routes());
    }
    let stored: Vec<StoredAiCapabilityRoute> =
        serde_json::from_str(&raw).map_err(|error| format!("本机智能能力设置损坏：{error}"))?;
    let mut by_capability = std::collections::BTreeMap::new();
    for route in stored {
        let normalized = normalize_route(
            &route.capability,
            &route.mode,
            route.profile_id,
            route.host_id,
            route.updated_at,
        )?;
        if by_capability
            .insert(normalized.capability.clone(), normalized)
            .is_some()
        {
            return Err("本机智能能力设置包含重复能力".into());
        }
    }
    let defaults = default_routes();
    Ok(defaults
        .into_iter()
        .map(|default| by_capability.remove(&default.capability).unwrap_or(default))
        .collect())
}

fn stored_route(route: &AiCapabilityRoute) -> StoredAiCapabilityRoute {
    StoredAiCapabilityRoute {
        capability: route.capability.clone(),
        mode: route.mode.clone(),
        profile_id: route.profile_id.clone(),
        host_id: route.host_id.clone(),
        updated_at: route.updated_at,
    }
}

pub(super) fn status(db: &AppDb) -> Result<AiCapabilityRoutesStatus, String> {
    Ok(AiCapabilityRoutesStatus {
        routes: routes_for_status(load_routes(db)?),
    })
}

/// Returns the persisted local routing decision without projecting it into a
/// sync entity. Execution paths use this to enforce an explicit `off` choice
/// rather than treating Smart Management as display-only UI.
pub(super) fn route(db: &AppDb, capability: &str) -> Result<AiCapabilityRoute, String> {
    load_routes(db)?
        .into_iter()
        .find(|route| route.capability == capability)
        .ok_or_else(|| "本机智能能力设置不完整".to_string())
}

/// Semantic search has no remote corpus or cloud embedding protocol yet.  The
/// UI route is therefore enforced at the command boundary: disabling it keeps
/// keyword search available, while semantic queries return a useful reason
/// instead of silently continuing to consume local model resources.
pub(crate) fn ensure_local_search_enabled(db: &AppDb) -> Result<(), String> {
    let route = route(db, "search")?;
    match route.mode.as_str() {
        "auto" | "local" => Ok(()),
        "off" => Err("智能搜索已在智能管理中关闭；关键词搜索仍可使用".into()),
        "cloud" => Err("云端智能搜索尚未接入此客户端；请改用自动或本机".into()),
        "intelligence_host" => Err("情报主机智能搜索尚未接入此客户端".into()),
        _ => Err("智能搜索处理方式无效".into()),
    }
}

pub(super) fn save(
    db: &AppDb,
    request: SaveAiCapabilityRouteRequest,
    updated_at: i64,
) -> Result<AiCapabilityRoutesStatus, String> {
    let route = normalize_route(
        &request.capability,
        &request.mode,
        request.profile_id,
        request.host_id,
        Some(updated_at),
    )?;
    let availability = route_with_runtime_availability(route.clone());
    if !route_mode_allowed(&availability) {
        if route.mode == "cloud" && route.capability == "search" {
            return Err("云端智能搜索尚未接入此客户端；请改用自动或本机".into());
        }
        return Err(availability
            .unavailable_reason
            .unwrap_or_else(|| "该智能能力处理方式尚未接入".to_string()));
    }
    let mut routes = load_routes(db)?;
    let index = routes
        .iter()
        .position(|existing| existing.capability == route.capability)
        .ok_or("本机智能能力设置不完整")?;
    routes[index] = route;
    let stored: Vec<_> = routes.iter().map(stored_route).collect();
    let serialized = serde_json::to_string(&stored).map_err(|error| error.to_string())?;
    db.set_metadata(CAPABILITY_ROUTES_KEY, &serialized)?;
    Ok(AiCapabilityRoutesStatus {
        routes: routes_for_status(routes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_configuration_exposes_five_auto_routes() {
        let db = AppDb::open_in_memory_for_tests();
        let status = status(&db).unwrap();
        assert_eq!(status.routes.len(), 5);
        assert!(status.routes.iter().all(|route| {
            route.mode == "auto"
                && route.updated_at.is_none()
                && route.allow_auto
                && !route.allow_intelligence_host
                && route.unavailable_reason.is_some()
        }));
        let json = serde_json::to_value(status).unwrap();
        let route = &json["routes"][0];
        assert_eq!(route["allowAuto"], true);
        assert_eq!(route["allowIntelligenceHost"], false);
        assert_eq!(route["unavailableReason"], "此设备尚未完成情报主机安全配对");
    }

    #[test]
    fn saves_one_route_without_changing_the_others() {
        let db = AppDb::open_in_memory_for_tests();
        let saved = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "deep_analysis".into(),
                mode: "cloud".into(),
                profile_id: Some("cloud-profile".into()),
                host_id: None,
            },
            123,
        )
        .unwrap();
        let deep = saved
            .routes
            .iter()
            .find(|route| route.capability == "deep_analysis")
            .unwrap();
        assert_eq!(deep.mode, "cloud");
        assert_eq!(deep.profile_id.as_deref(), Some("cloud-profile"));
        assert_eq!(deep.updated_at, Some(123));
        let raw = db.metadata(CAPABILITY_ROUTES_KEY).unwrap();
        assert!(!raw.contains("allowIntelligenceHost"));
        assert!(!raw.contains("unavailableReason"));
        assert_eq!(
            status(&db)
                .unwrap()
                .routes
                .iter()
                .find(|route| route.capability == "search")
                .unwrap()
                .mode,
            "auto"
        );
    }

    #[test]
    fn rejects_unimplemented_search_cloud_and_host_routes() {
        let db = AppDb::open_in_memory_for_tests();
        let cloud = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "search".into(),
                mode: "cloud".into(),
                profile_id: None,
                host_id: None,
            },
            1,
        )
        .unwrap_err();
        assert!(cloud.contains("尚未接入"));
        let host = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "deep_analysis".into(),
                mode: "intelligence_host".into(),
                profile_id: None,
                host_id: Some("host-one".into()),
            },
            1,
        )
        .unwrap_err();
        assert!(host.contains("情报主机"));
    }

    #[test]
    fn local_search_gate_only_allows_auto_or_local() {
        let db = AppDb::open_in_memory_for_tests();
        ensure_local_search_enabled(&db).unwrap();
        save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "search".into(),
                mode: "off".into(),
                profile_id: None,
                host_id: None,
            },
            1,
        )
        .unwrap();
        assert!(ensure_local_search_enabled(&db)
            .unwrap_err()
            .contains("关键词搜索"));
    }

    #[test]
    fn rejects_ambiguous_or_invalid_route_combinations() {
        let db = AppDb::open_in_memory_for_tests();
        let missing_host = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "deep_analysis".into(),
                mode: "intelligence_host".into(),
                profile_id: None,
                host_id: None,
            },
            1,
        )
        .unwrap_err();
        assert!(missing_host.contains("情报主机"));

        let unexpected_profile = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "search".into(),
                mode: "auto".into(),
                profile_id: Some("profile-one".into()),
                host_id: None,
            },
            1,
        )
        .unwrap_err();
        assert!(unexpected_profile.contains("自动"));

        let unknown = save(
            &db,
            SaveAiCapabilityRouteRequest {
                capability: "unknown".into(),
                mode: "local".into(),
                profile_id: None,
                host_id: None,
            },
            1,
        )
        .unwrap_err();
        assert!(unknown.contains("不支持"));
    }
}
