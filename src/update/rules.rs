//! Stateless release metadata and endpoint validation rules.
//!
//! Fetching, build-time configuration, and Tauri command adaptation stay in
//! the parent module. Keeping these rules here makes their compatibility
//! behavior independently testable without a network client.

use serde_json::Value;

pub(super) fn version_is_newer(candidate: &str, current: &str) -> bool {
    fn parse(value: &str) -> (Vec<u64>, Option<Vec<&str>>) {
        let version = value
            .trim()
            .trim_start_matches(['v', 'V'])
            .split_once('+')
            .map_or_else(
                || value.trim().trim_start_matches(['v', 'V']),
                |(left, _)| left,
            );
        let (core, prerelease) = version
            .split_once('-')
            .map_or((version, None), |(core, prerelease)| {
                (core, Some(prerelease.split('.').collect::<Vec<_>>()))
            });
        (
            core.split('.')
                .map(|segment| segment.trim().parse().unwrap_or(0))
                .collect(),
            prerelease,
        )
    }
    let (candidate_core, candidate_prerelease) = parse(candidate);
    let (current_core, current_prerelease) = parse(current);
    for index in 0..candidate_core.len().max(current_core.len()) {
        let (left, right) = (
            candidate_core.get(index).copied().unwrap_or(0),
            current_core.get(index).copied().unwrap_or(0),
        );
        if left != right {
            return left > right;
        }
    }
    match (candidate_prerelease, current_prerelease) {
        (None, Some(_)) => true,
        (Some(_), None) | (None, None) => false,
        (Some(candidate), Some(current)) => {
            for index in 0..candidate.len().max(current.len()) {
                let Some(left) = candidate.get(index) else {
                    return false;
                };
                let Some(right) = current.get(index) else {
                    return true;
                };
                let ordering = match (left.parse::<u64>(), right.parse::<u64>()) {
                    (Ok(left), Ok(right)) => left.cmp(&right),
                    (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                    (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                    (Err(_), Err(_)) => left.cmp(right),
                };
                if !ordering.is_eq() {
                    return ordering.is_gt();
                }
            }
            false
        }
    }
}

pub(super) fn release_tag(value: &Value) -> String {
    value
        .get("tag_name")
        .and_then(|field| field.as_str())
        .or_else(|| value.get("version").and_then(|field| field.as_str()))
        .or_else(|| value.get("latest").and_then(|field| field.as_str()))
        .or_else(|| value.get("name").and_then(|field| field.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

/// Returns the first non-draft prerelease from GitHub's reverse-chronological
/// releases listing. Stable clients deliberately do not consume this fallback.
pub(super) fn latest_prerelease(value: &Value) -> Option<&Value> {
    value.as_array()?.iter().find(|release| {
        release
            .get("prerelease")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !release
                .get("draft")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            && !release_tag(release).is_empty()
    })
}

pub(super) fn version_is_prerelease(value: &str) -> bool {
    let value = value.trim().trim_start_matches(['v', 'V']);
    value
        .split_once('+')
        .map_or(value, |(core, _)| core)
        .contains('-')
}

pub(super) fn release_notes(value: &Value) -> String {
    value
        .get("body")
        .and_then(|field| field.as_str())
        .or_else(|| value.get("notes").and_then(|field| field.as_str()))
        .or_else(|| value.get("release_notes").and_then(|field| field.as_str()))
        .unwrap_or("")
        .trim()
        .to_string()
}

pub(super) fn normalized_version(value: &str) -> &str {
    value.trim().trim_start_matches(['v', 'V'])
}

pub(super) fn placeholder_release_notes(notes: &str, tag: &str) -> bool {
    let notes = notes.trim().trim_matches('#').trim();
    !notes.is_empty() && normalized_version(notes) == normalized_version(tag)
}

pub(super) fn bundled_release_notes(changelog: &str, tag: &str) -> String {
    let wanted = normalized_version(tag);
    let mut in_section = false;
    let mut lines = Vec::new();
    for line in changelog.lines() {
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

pub(super) fn release_url(value: &Value, fallback: &str) -> String {
    value
        .get("html_url")
        .and_then(|field| field.as_str())
        .or_else(|| value.get("url").and_then(|field| field.as_str()))
        .or_else(|| value.get("download_url").and_then(|field| field.as_str()))
        .unwrap_or(fallback)
        .trim()
        .to_string()
}

pub(super) fn safe_release_tag(tag: &str) -> String {
    tag.chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_')
        })
        .take(80)
        .collect()
}

pub(super) fn join_https_update_url(base: &str, suffix: &str) -> Option<String> {
    let base = base.trim().trim_end_matches('/');
    if !base.starts_with("https://") || base.contains(char::is_whitespace) {
        return None;
    }
    Some(format!("{base}/{}", suffix.trim_start_matches('/')))
}

pub(super) fn configured_github_repo(value: Option<&str>) -> Option<&str> {
    let value = value?.trim();
    let mut parts = value.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if parts.next().is_some()
        || owner.is_empty()
        || repo.is_empty()
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/')
        })
    {
        return None;
    }
    Some(value)
}

pub(super) fn github_repo_from_url(value: &str) -> Option<&str> {
    let repo = value.trim().strip_prefix("https://github.com/")?;
    configured_github_repo(Some(repo.trim_end_matches('/')))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn version_compare_handles_v_prefix_and_missing_segments() {
        assert!(version_is_newer("v1.8.2", "1.8.1"));
        assert!(version_is_newer("1.9", "1.8.99"));
        assert!(!version_is_newer("1.8", "1.8.0"));
        assert!(!version_is_newer("1.8.0", "1.8.1"));
        assert!(version_is_newer("1.0.0", "1.0.0-beta.1"));
        assert!(version_is_newer("1.0.0-beta.2", "1.0.0-beta.1"));
        assert!(!version_is_newer("1.0.0-beta.1", "1.0.0"));
    }

    #[test]
    fn prerelease_helpers_ignore_drafts_and_stable_releases() {
        let releases = json!([
            {"tag_name":"v2.0.0", "draft":false, "prerelease":false},
            {"tag_name":"v2.0.0-beta.2", "draft":true, "prerelease":true},
            {"tag_name":"v2.0.0-beta.1", "draft":false, "prerelease":true}
        ]);
        assert_eq!(
            release_tag(latest_prerelease(&releases).unwrap()),
            "v2.0.0-beta.1"
        );
        assert!(version_is_prerelease("v1.0.0-beta.1+build.5"));
        assert!(!version_is_prerelease("1.0.0"));
    }

    #[test]
    fn release_json_helpers_accept_github_and_manifest_shapes() {
        let github =
            json!({"tag_name":"v1.8.2","body":" notes ","html_url":"https://example.com/release"});
        assert_eq!(release_tag(&github), "v1.8.2");
        assert_eq!(release_notes(&github), "notes");
        assert_eq!(
            release_url(&github, "fallback"),
            "https://example.com/release"
        );

        let manifest = json!({"latest":"1.8.3","release_notes":" next ","download_url":"https://example.com/app.exe"});
        assert_eq!(release_tag(&manifest), "1.8.3");
        assert_eq!(release_notes(&manifest), "next");
        assert_eq!(
            release_url(&manifest, "fallback"),
            "https://example.com/app.exe"
        );
    }

    #[test]
    fn endpoint_and_repository_validation_rejects_non_public_configuration() {
        assert_eq!(
            join_https_update_url("https://reader.example/updates/", "latest"),
            Some("https://reader.example/updates/latest".into())
        );
        let insecure_public = format!("{}://reader.example/updates", "http");
        assert!(join_https_update_url(&insecure_public, "latest").is_none());
        assert!(join_https_update_url(" https://reader.example/bad path ", "latest").is_none());
        assert_eq!(
            configured_github_repo(Some("owner/repo-name")),
            Some("owner/repo-name")
        );
        assert_eq!(
            github_repo_from_url("https://github.com/owner/repo-name"),
            Some("owner/repo-name")
        );
        assert!(configured_github_repo(Some("owner/repo/extra")).is_none());
        assert!(configured_github_repo(Some("owner/repo?query")).is_none());
    }

    #[test]
    fn bundled_notes_and_safe_tag_handle_release_placeholders() {
        assert!(placeholder_release_notes("v1.11.2", "1.11.2"));
        assert!(!placeholder_release_notes("- 修复阅读位置", "v1.11.2"));
        assert_eq!(safe_release_tag("v1.9.5?bad=<x>"), "v1.9.5badx");
        let changelog = "## 1.2.0\n\n- changed\n\n## 1.1.0\n\n- older";
        assert_eq!(bundled_release_notes(changelog, "v1.2.0"), "- changed");
    }
}
