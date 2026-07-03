use serde::Serialize;

const GITHUB_REPO: &str = "pigking9527-cmyk/kunpeng-reader";
const UPDATE_MANIFEST_URL: &str = "https://sync.example.invalid/kunpeng-reader/update.json";

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
    ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(6))
        .timeout_read(std::time::Duration::from_secs(8))
        .build()
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
        .set("User-Agent", "kunpeng-reader")
        .set("Accept", "application/json")
        .call()
        .ok()?
        .into_json::<serde_json::Value>()
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

fn rel_url(v: &serde_json::Value, fallback: &str) -> String {
    v.get("html_url")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("url").and_then(|x| x.as_str()))
        .or_else(|| v.get("download_url").and_then(|x| x.as_str()))
        .unwrap_or(fallback)
        .trim()
        .to_string()
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
    let sources = [
        (
            "github",
            format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest"),
            format!("https://github.com/{GITHUB_REPO}/releases/latest"),
        ),
        (
            "server",
            UPDATE_MANIFEST_URL.to_string(),
            UPDATE_MANIFEST_URL.to_string(),
        ),
    ];
    for (name, api, page) in sources {
        if let Some(v) = fetch_json(&agent, &api) {
            let tag = rel_tag(&v);
            if tag.is_empty() {
                continue;
            }
            let latest = tag.trim_start_matches(['v', 'V']).to_string();
            let notes = rel_notes(&v);
            let url = rel_url(&v, &page);
            return UpdateInfo {
                ok: true,
                has_update: ver_gt(&latest, &current),
                latest,
                notes,
                url,
                source: name.to_string(),
                current,
            };
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
    let urls = [
        format!("https://api.github.com/repos/{GITHUB_REPO}/releases/tags/{tag}"),
        UPDATE_MANIFEST_URL.to_string(),
    ];
    let want = tag.trim_start_matches(['v', 'V']);
    for url in urls {
        if let Some(v) = fetch_json(&agent, &url) {
            let got = rel_tag(&v);
            if !got.is_empty() && got.trim_start_matches(['v', 'V']) != want {
                continue;
            }
            let notes = rel_notes(&v);
            if !notes.is_empty() {
                return notes;
            }
        }
    }
    String::new()
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
}
