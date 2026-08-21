//! Pure validation and filtering rules for recoverable WebView settings.

use serde_json::{Map, Value};

const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
const MAX_SETTING_COUNT: usize = 2048;
const MAX_KEY_BYTES: usize = 256;

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "password",
        "secret",
        "api_key",
        "apikey",
        "credential",
    ]
    .iter()
    .any(|needle| key.contains(needle))
}

pub(super) fn sanitize_settings(settings: Value) -> Result<Value, String> {
    let source = settings.as_object().ok_or("网页设置快照必须是键值对象")?;
    if source.len() > MAX_SETTING_COUNT {
        return Err("网页设置项过多，未保存".into());
    }
    let mut filtered = Map::new();
    for (key, value) in source {
        if key.is_empty() || key.len() > MAX_KEY_BYTES || is_sensitive_key(key) {
            continue;
        }
        let Some(value) = value.as_str() else {
            continue;
        };
        filtered.insert(key.clone(), Value::String(value.to_string()));
    }
    let snapshot = serde_json::json!({ "version": 1, "settings": filtered });
    if serde_json::to_vec(&snapshot)
        .map_err(|error| format!("序列化网页设置失败：{error}"))?
        .len()
        > MAX_SNAPSHOT_BYTES
    {
        return Err("网页设置过大，未保存".into());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_preferences_but_removes_credentials() {
        let value = sanitize_settings(serde_json::json!({
            "readerSettings": "{}", "translateApiKey": "private", "syncToken": "private",
            "empty": 4,
        }))
        .unwrap();
        let settings = value.get("settings").and_then(Value::as_object).unwrap();
        assert!(settings.contains_key("readerSettings"));
        assert!(!settings.contains_key("translateApiKey"));
        assert!(!settings.contains_key("syncToken"));
        assert!(!settings.contains_key("empty"));
    }

    #[test]
    fn filters_sensitive_keys_case_insensitively_and_keeps_safe_strings() {
        let snapshot = sanitize_settings(serde_json::json!({
            "ReaderSettings": "{}",
            "SYNCtoken": "private",
            "Api_Key": "private",
            "PASSWORD_HINT": "private",
            "credentialStore": "private",
        }))
        .unwrap();
        let settings = snapshot["settings"].as_object().unwrap();

        assert_eq!(snapshot["version"], 1);
        assert_eq!(
            settings.get("ReaderSettings"),
            Some(&Value::String("{}".into()))
        );
        assert_eq!(settings.len(), 1);
    }

    #[test]
    fn rejects_non_object_settings() {
        for value in [
            Value::Null,
            serde_json::json!([]),
            serde_json::json!("value"),
        ] {
            assert_eq!(
                sanitize_settings(value).unwrap_err(),
                "网页设置快照必须是键值对象"
            );
        }
    }

    #[test]
    fn drops_invalid_keys_and_non_string_values() {
        let oversized_key = "a".repeat(MAX_KEY_BYTES + 1);
        let snapshot = sanitize_settings(serde_json::json!({
            "": "empty-key",
            oversized_key: "oversized-key",
            "number": 7,
            "boolean": true,
            "object": {},
            "array": [],
            "valid": "kept",
        }))
        .unwrap();
        let settings = snapshot["settings"].as_object().unwrap();

        assert_eq!(settings.len(), 1);
        assert_eq!(settings["valid"], "kept");
    }

    #[test]
    fn rejects_too_many_settings_before_filtering() {
        let mut settings = Map::new();
        for index in 0..=MAX_SETTING_COUNT {
            settings.insert(format!("setting-{index}"), Value::String("value".into()));
        }

        assert_eq!(
            sanitize_settings(Value::Object(settings)).unwrap_err(),
            "网页设置项过多，未保存"
        );
    }

    #[test]
    fn rejects_serialized_snapshots_over_the_size_limit() {
        let snapshot = sanitize_settings(serde_json::json!({
            "valid": "a".repeat(MAX_SNAPSHOT_BYTES),
        }));

        assert_eq!(snapshot.unwrap_err(), "网页设置过大，未保存");
    }
}
