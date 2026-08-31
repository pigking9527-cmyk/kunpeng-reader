use serde::Serialize;

mod rules;
use rules::{
    bundled_release_notes, configured_github_repo, github_repo_from_url, join_https_update_url,
    latest_prerelease, placeholder_release_notes, release_notes as parsed_release_notes,
    release_tag, release_url, safe_release_tag, version_is_newer, version_is_prerelease,
};

const GITHUB_REPO: Option<&str> = option_env!("KUNPENG_GITHUB_REPO");
const PACKAGE_REPOSITORY: &str = env!("CARGO_PKG_REPOSITORY");
const BUNDLED_CHANGELOG: &str = include_str!("../CHANGELOG.md");
// GitHub is the source of truth; the sync server mirrors only public release metadata
// so version checks and current-version notes remain available when GitHub is blocked.
// Public source must not embed deployment addresses. Release builders may inject an
// HTTPS endpoint such as `https://reader.example/updates`.
const SERVER_UPDATE_BASE: Option<&str> = option_env!("KUNPENG_UPDATE_BASE");

#[derive(Serialize, Default)]
pub(crate) struct UpdateInfo {
    ok: bool,
    current: String,
    latest: String,
    notes: String,
    url: String,
    source: String,
    has_update: bool,
}

fn http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(6)))
        .timeout_recv_response(Some(std::time::Duration::from_secs(8)))
        .timeout_recv_body(Some(std::time::Duration::from_secs(8)))
        .build()
        .into()
}

/// The deployment manifest is intentionally checked before GitHub during
/// startup. It is geographically close to the app's primary users and carries
/// the same public release metadata; a short timeout keeps an unavailable
/// mirror from delaying the GitHub fallback.
fn quick_server_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_millis(900)))
        .timeout_recv_response(Some(std::time::Duration::from_millis(1_500)))
        .timeout_recv_body(Some(std::time::Duration::from_millis(1_500)))
        .build()
        .into()
}

fn fetch_json(agent: &ureq::Agent, url: &str) -> Option<serde_json::Value> {
    agent
        .get(url)
        .header("User-Agent", "kunpeng-reader")
        .header("Accept", "application/json")
        .call()
        .ok()?
        .body_mut()
        .read_json::<serde_json::Value>()
        .ok()
}

fn configured_server_update_url(suffix: &str) -> Option<String> {
    join_https_update_url(SERVER_UPDATE_BASE?, suffix)
}

fn configured_repository() -> Option<&'static str> {
    configured_github_repo(GITHUB_REPO).or_else(|| github_repo_from_url(PACKAGE_REPOSITORY))
}

fn update_info_from_release(
    value: &serde_json::Value,
    current: &str,
    source: &str,
    fallback_url: &str,
) -> Option<UpdateInfo> {
    let tag = release_tag(value);
    if tag.is_empty() {
        return None;
    }
    let latest = tag.trim_start_matches(['v', 'V']).to_string();
    Some(UpdateInfo {
        ok: true,
        has_update: version_is_newer(&latest, current),
        latest,
        notes: parsed_release_notes(value),
        url: release_url(value, fallback_url),
        source: source.to_string(),
        current: current.to_string(),
    })
}

#[tauri::command]
pub(crate) async fn check_update() -> UpdateInfo {
    tokio::task::spawn_blocking(check_update_blocking)
        .await
        .unwrap_or_default()
}

fn check_update_blocking() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    if let Some(server_api) = configured_server_update_url("latest") {
        if let Some(v) = fetch_json(&quick_server_agent(), &server_api) {
            if let Some(info) = update_info_from_release(&v, &current, "server", "") {
                return info;
            }
        }
    }
    if let Some(repo) = configured_repository() {
        let agent = http_agent();
        let page = format!("https://github.com/{repo}/releases/latest");
        let api = format!("https://api.github.com/repos/{repo}/releases/latest");
        if let Some(v) = fetch_json(&agent, &api) {
            if let Some(info) = update_info_from_release(&v, &current, "github", &page) {
                return info;
            }
        }
        if version_is_prerelease(&current) {
            let prereleases = format!("https://api.github.com/repos/{repo}/releases?per_page=10");
            if let Some(v) = fetch_json(&agent, &prereleases) {
                if let Some(release) = latest_prerelease(&v) {
                    if let Some(info) =
                        update_info_from_release(release, &current, "github-prerelease", &page)
                    {
                        return info;
                    }
                }
            }
        }
    }
    UpdateInfo {
        current,
        ..Default::default()
    }
}

#[tauri::command]
pub(crate) async fn release_notes(tag: String) -> String {
    tokio::task::spawn_blocking(move || release_notes_blocking(&tag))
        .await
        .unwrap_or_default()
}

fn release_notes_blocking(tag: &str) -> String {
    let agent = http_agent();
    let want = tag.trim_start_matches(['v', 'V']);
    if let Some(repo) = configured_repository() {
        let url = format!("https://api.github.com/repos/{repo}/releases/tags/{tag}");
        if let Some(v) = fetch_json(&agent, &url) {
            let got = release_tag(&v);
            if got.is_empty() || got.trim_start_matches(['v', 'V']) == want {
                let notes = parsed_release_notes(&v);
                if !notes.is_empty() && !placeholder_release_notes(&notes, tag) {
                    return notes;
                }
            }
        }
    }
    let safe_tag = safe_release_tag(tag);
    if safe_tag.is_empty() {
        return String::new();
    }
    if let Some(server_url) = configured_server_update_url(&format!("notes?tag={safe_tag}")) {
        if let Some(v) = fetch_json(&agent, &server_url) {
            let got = release_tag(&v);
            if got.is_empty() || got.trim_start_matches(['v', 'V']) == want {
                let notes = parsed_release_notes(&v);
                if !notes.is_empty() && !placeholder_release_notes(&notes, tag) {
                    return notes;
                }
            }
        }
    }
    bundled_release_notes(BUNDLED_CHANGELOG, tag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiled_changelog_remains_the_offline_release_notes_source() {
        let beta = bundled_release_notes(BUNDLED_CHANGELOG, "v1.1.0-beta.4");
        assert!(beta.contains("测试版 1.1"));
        assert!(beta.contains("GitHub"));
        let notes = bundled_release_notes(BUNDLED_CHANGELOG, "v1.11.2");
        assert!(notes.contains("Windows-only 体验更新"));
        assert!(notes.contains("书库问答"));
    }
}
