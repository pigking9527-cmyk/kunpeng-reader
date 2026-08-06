use serde::Serialize;

const GITHUB_REPO: &str = "pigking9527-cmyk/kunpeng-reader";
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

fn ver_gt(a: &str, b: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.trim()
            .trim_start_matches(['v', 'V'])
            .split('.')
            .map(|x| x.trim().parse().unwrap_or(0))
            .collect()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let (x, y) = (
            pa.get(i).copied().unwrap_or(0),
            pb.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
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

fn rel_tag(v: &serde_json::Value) -> String {
    v.get("tag_name")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("version").and_then(|x| x.as_str()))
        .or_else(|| v.get("latest").and_then(|x| x.as_str()))
        .or_else(|| v.get("name").and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn rel_notes(v: &serde_json::Value) -> String {
    v.get("body")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("notes").and_then(|x| x.as_str()))
        .or_else(|| v.get("release_notes").and_then(|x| x.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn normalized_version(value: &str) -> &str {
    value.trim().trim_start_matches(['v', 'V'])
}

/// Some GitHub releases use the tag itself as a placeholder body.  It is not
/// useful as "what changed", so keep looking for the real release notes.
fn placeholder_release_notes(notes: &str, tag: &str) -> bool {
    let notes = notes.trim().trim_matches('#').trim();
    !notes.is_empty() && normalized_version(notes) == normalized_version(tag)
}

/// The current application's changelog is compiled into the binary.  This
/// keeps the About dialog useful offline and prevents a sparse GitHub release
/// body from reducing a full update to just "v1.11.2".
fn bundled_release_notes(tag: &str) -> String {
    let wanted = normalized_version(tag);
    let mut in_section = false;
    let mut lines = Vec::new();
    for line in BUNDLED_CHANGELOG.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            let version = heading
                .split_whitespace()
                .next()
                .map(normalized_version)
                .unwrap_or_default();
            if in_section {
                break;
            }
            in_section = version == wanted;
            continue;
        }
        if in_section {
            lines.push(line);
        }
    }
    lines.join("\n").trim().to_string()
}

fn rel_url(v: &serde_json::Value, fallback: &str) -> String {
    v.get("html_url")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("url").and_then(|x| x.as_str()))
        .or_else(|| v.get("download_url").and_then(|x| x.as_str()))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

fn safe_release_tag(tag: &str) -> String {
    tag.chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(80)
        .collect()
}

fn join_server_update_url(base: &str, suffix: &str) -> Option<String> {
    let base = base.trim().trim_end_matches('/');
    if !base.starts_with("https://") || base.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("{base}/{}", suffix.trim_start_matches('/')))
}

fn configured_server_update_url(suffix: &str) -> Option<String> {
    join_server_update_url(SERVER_UPDATE_BASE?, suffix)
}

#[tauri::command]
pub(crate) async fn check_update() -> UpdateInfo {
    tokio::task::spawn_blocking(check_update_blocking)
        .await
        .unwrap_or_default()
}

fn check_update_blocking() -> UpdateInfo {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let agent = http_agent();
    let api = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let page = format!("https://github.com/{GITHUB_REPO}/releases/latest");
    if let Some(v) = fetch_json(&agent, &api) {
        let tag = rel_tag(&v);
        if !tag.is_empty() {
            let latest = tag.trim_start_matches(['v', 'V']).to_string();
            let notes = rel_notes(&v);
            let url = rel_url(&v, &page);
            return UpdateInfo {
                ok: true,
                has_update: ver_gt(&latest, &current),
                latest,
                notes,
                url,
                source: "github".to_string(),
                current,
            };
        }
    }
    if let Some(server_api) = configured_server_update_url("latest") {
        if let Some(v) = fetch_json(&agent, &server_api) {
            let tag = rel_tag(&v);
            if !tag.is_empty() {
                let latest = tag.trim_start_matches(['v', 'V']).to_string();
                return UpdateInfo {
                    ok: true,
                    has_update: ver_gt(&latest, &current),
                    latest,
                    notes: rel_notes(&v),
                    url: rel_url(&v, &page),
                    source: "server".to_string(),
                    current,
                };
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
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}");
    let want = tag.trim_start_matches(['v', 'V']);
    if let Some(v) = fetch_json(&agent, &url) {
        let got = rel_tag(&v);
        if got.is_empty() || got.trim_start_matches(['v', 'V']) == want {
            let notes = rel_notes(&v);
            if !notes.is_empty() && !placeholder_release_notes(&notes, tag) {
                return notes;
            }
        }
    }
    let safe_tag = safe_release_tag(tag);
    if safe_tag.is_empty() {
        return String::new();
    }
    if let Some(server_url) = configured_server_update_url(&format!("notes?tag={safe_tag}")) {
        if let Some(v) = fetch_json(&agent, &server_url) {
            let got = rel_tag(&v);
            if got.is_empty() || got.trim_start_matches(['v', 'V']) == want {
                let notes = rel_notes(&v);
                if !notes.is_empty() && !placeholder_release_notes(&notes, tag) {
                    return notes;
                }
            }
        }
    }
    bundled_release_notes(tag)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn version_compare_handles_v_prefix_and_missing_segments() {
        assert!(ver_gt("v1.8.2", "1.8.1"));
        assert!(ver_gt("1.9", "1.8.99"));
        assert!(!ver_gt("1.8", "1.8.0"));
        assert!(!ver_gt("1.8.0", "1.8.1"));
    }

    #[test]
    fn release_json_helpers_accept_github_and_manifest_shapes() {
        let github =
            json!({"tag_name":"v1.8.2","body":" notes ","html_url":"https://example.com/release"});
        assert_eq!(rel_tag(&github), "v1.8.2");
        assert_eq!(rel_notes(&github), "notes");
        assert_eq!(rel_url(&github, "fallback"), "https://example.com/release");

        let manifest = json!({"latest":"1.8.3","release_notes":" next ","download_url":"https://example.com/app.exe"});
        assert_eq!(rel_tag(&manifest), "1.8.3");
        assert_eq!(rel_notes(&manifest), "next");
        assert_eq!(
            rel_url(&manifest, "fallback"),
            "https://example.com/app.exe"
        );
    }

    #[test]
    fn release_tag_query_only_keeps_safe_characters() {
        assert_eq!(safe_release_tag("v1.9.5"), "v1.9.5");
        assert_eq!(safe_release_tag("v1.9.5?bad=<x>"), "v1.9.5badx");
    }

    #[test]
    fn bundled_notes_replace_a_tag_only_release_body() {
        assert!(placeholder_release_notes("v1.11.2", "1.11.2"));
        assert!(!placeholder_release_notes("- 修复阅读位置", "v1.11.2"));
        let notes = bundled_release_notes("v1.11.2");
        assert!(notes.contains("Windows-only 体验更新"));
        assert!(notes.contains("书库问答"));
    }

    #[test]
    fn server_update_fallback_requires_an_https_build_endpoint() {
        assert_eq!(
            join_server_update_url("https://reader.example/updates/", "latest"),
            Some("https://reader.example/updates/latest".into())
        );
        let insecure = ["http:", "//reader.example/updates"].concat();
        assert!(join_server_update_url(&insecure, "latest").is_none());
        assert!(join_server_update_url(" https://reader.example/bad path ", "latest").is_none());
    }
}
