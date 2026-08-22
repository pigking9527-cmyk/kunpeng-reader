//! Portable core-data package format and validation rules.
//!
//! This module is deliberately free of SQLite connections and filesystem
//! operations. `AppDb` owns the query and transaction boundary, while this
//! module owns only the bounded JSON envelope accepted by that boundary.

use serde_json::{Map, Value};

/// The portable migration package is intentionally narrower than live sync.
/// It contains only state that can safely move between local installations;
/// credentials, cursors, acknowledgements, library files and local paths are
/// never package entities.
pub(super) const CORE_PACKAGE_ENTITY_KINDS: &[&str] = &[
    "reading_progress_v1",
    "reading_data_v1",
    "reading_statistics_v1",
    "model_book_tags_v1",
    "vocab",
    "reading_bucket_v2",
];
const LEGACY_CORE_PACKAGE_ENTITY_KINDS: &[&str] = &[
    "book_state_v2",
    "model_book_tags_v1",
    "vocab",
    "reading_bucket_v2",
];
pub(super) const CORE_PACKAGE_FORMAT: &str = "kunpeng-reader-core-data-package";
pub(super) const CORE_PACKAGE_VERSION: u64 = 2;
const LEGACY_CORE_PACKAGE_VERSION: u64 = 1;
pub(crate) const MAX_CORE_PACKAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CORE_PACKAGE_ENTITIES: usize = 50_000;
const MAX_CORE_PACKAGE_ENTITY_BYTES: usize = 256 * 1024;
const MAX_CORE_PACKAGE_ID_BYTES: usize = 512;
const MAX_CORE_PACKAGE_DEVICE_ID_BYTES: usize = 256;
const MAX_CORE_PACKAGE_JSON_DEPTH: usize = 64;
const MAX_CORE_PACKAGE_OBJECT_FIELDS: usize = 512;
const MAX_CORE_PACKAGE_ARRAY_ITEMS: usize = 10_000;
const MAX_CORE_PACKAGE_STRING_BYTES: usize = 64 * 1024;

pub(super) struct ValidatedPackageEntity {
    pub(super) kind: String,
    pub(super) id: String,
    pub(super) json_text: String,
    pub(super) updated_at: i64,
    pub(super) deleted_at: i64,
    pub(super) device_id: String,
    pub(super) sync_version: i64,
}

pub(super) fn validate_core_package(value: &Value) -> Result<Vec<ValidatedPackageEntity>, String> {
    let package_bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if package_bytes.len() as u64 > MAX_CORE_PACKAGE_BYTES {
        return Err(format!(
            "核心数据包超过 {} MiB 未压缩 JSON 上限",
            MAX_CORE_PACKAGE_BYTES / 1024 / 1024
        ));
    }
    let root = value
        .as_object()
        .ok_or_else(|| "核心数据包顶层必须是对象".to_string())?;
    let format = required_package_str(root, "format", 128)?;
    let version = root
        .get("version")
        .and_then(Value::as_u64)
        .ok_or_else(|| "核心数据包 version 必须是正整数".to_string())?;
    if format != CORE_PACKAGE_FORMAT {
        return Err(format!("不支持的数据包格式或版本：{format} v{version}"));
    }
    let allowed_kinds = match version {
        LEGACY_CORE_PACKAGE_VERSION => LEGACY_CORE_PACKAGE_ENTITY_KINDS,
        CORE_PACKAGE_VERSION => CORE_PACKAGE_ENTITY_KINDS,
        _ => return Err(format!("不支持的数据包格式或版本：{format} v{version}")),
    };
    reject_unknown_fields(
        root,
        &[
            "format",
            "version",
            "exported_at",
            "source_device_id",
            "entities",
        ],
        "核心数据包顶层",
    )?;
    if root.get("exported_at").and_then(Value::as_u64).is_none() {
        return Err("核心数据包 exported_at 必须是非负整数时间戳".into());
    }
    required_package_str(root, "source_device_id", MAX_CORE_PACKAGE_DEVICE_ID_BYTES)?;
    let entities = root
        .get("entities")
        .and_then(Value::as_array)
        .ok_or_else(|| "核心数据包缺少 entities 数组".to_string())?;
    if entities.len() > MAX_CORE_PACKAGE_ENTITIES {
        return Err(format!(
            "核心数据包实体超过 {MAX_CORE_PACKAGE_ENTITIES} 条上限"
        ));
    }
    let mut validated = Vec::with_capacity(entities.len());
    for (index, entity) in entities.iter().enumerate() {
        let object = entity
            .as_object()
            .ok_or_else(|| format!("entities[{index}] 必须是对象"))?;
        reject_unknown_fields(
            object,
            &[
                "kind",
                "id",
                "data",
                "updated_at",
                "deleted_at",
                "device_id",
                "sync_version",
            ],
            &format!("entities[{index}]"),
        )?;
        let kind = required_package_str(object, "kind", 64)?;
        if !allowed_kinds.contains(&kind.as_str()) {
            return Err(format!("entities[{index}] 含非核心或不支持的 kind：{kind}"));
        }
        let id = required_package_str(object, "id", MAX_CORE_PACKAGE_ID_BYTES)?;
        let device_id =
            required_package_str(object, "device_id", MAX_CORE_PACKAGE_DEVICE_ID_BYTES)?;
        let updated_at = required_package_i64(object, "updated_at")?;
        let deleted_at = required_package_i64(object, "deleted_at")?;
        let sync_version = required_package_i64(object, "sync_version")?;
        if updated_at < 0 || deleted_at < 0 || sync_version < 1 {
            return Err(format!("entities[{index}] 的 LWW 元数据无效"));
        }
        let payload = object
            .get("data")
            .ok_or_else(|| format!("entities[{index}] 缺少 data"))?;
        if !payload.is_object() {
            return Err(format!("entities[{index}] 的 data 必须是对象"));
        }
        validate_portable_payload(payload, 0, &format!("entities[{index}].data"))?;
        let serialized_entity = serde_json::to_vec(entity).map_err(|error| error.to_string())?;
        if serialized_entity.len() > MAX_CORE_PACKAGE_ENTITY_BYTES {
            return Err(format!(
                "entities[{index}] 超过 {} KiB 序列化上限",
                MAX_CORE_PACKAGE_ENTITY_BYTES / 1024
            ));
        }
        let json_text = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        validated.push(ValidatedPackageEntity {
            kind,
            id,
            json_text,
            updated_at,
            deleted_at,
            device_id,
            sync_version,
        });
    }
    Ok(validated)
}

fn required_package_str(
    object: &Map<String, Value>,
    field: &str,
    max_bytes: usize,
) -> Result<String, String> {
    let value = object
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("数据包字段 {field} 必须是字符串"))?;
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(format!("数据包字段 {field} 为空或超过长度上限"));
    }
    Ok(value.to_string())
}

fn required_package_i64(object: &Map<String, Value>, field: &str) -> Result<i64, String> {
    object
        .get(field)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("数据包字段 {field} 必须是整数"))
}

fn reject_unknown_fields(
    object: &Map<String, Value>,
    allowed: &[&str],
    location: &str,
) -> Result<(), String> {
    if let Some(field) = object
        .keys()
        .find(|field| !allowed.contains(&field.as_str()))
    {
        return Err(format!("{location} 含不允许的字段：{field}"));
    }
    Ok(())
}

fn validate_portable_payload(value: &Value, depth: usize, location: &str) -> Result<(), String> {
    if depth > MAX_CORE_PACKAGE_JSON_DEPTH {
        return Err(format!(
            "{location} 的 JSON 嵌套超过 {MAX_CORE_PACKAGE_JSON_DEPTH} 层"
        ));
    }
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => Ok(()),
        Value::String(text) => {
            if text.len() > MAX_CORE_PACKAGE_STRING_BYTES {
                Err(format!("{location} 的字符串超过长度上限"))
            } else {
                Ok(())
            }
        }
        Value::Array(values) => {
            if values.len() > MAX_CORE_PACKAGE_ARRAY_ITEMS {
                return Err(format!("{location} 的数组超过项目上限"));
            }
            for (index, child) in values.iter().enumerate() {
                validate_portable_payload(child, depth + 1, &format!("{location}[{index}]"))?;
            }
            Ok(())
        }
        Value::Object(object) => {
            if object.len() > MAX_CORE_PACKAGE_OBJECT_FIELDS {
                return Err(format!("{location} 的对象字段超过上限"));
            }
            for (key, child) in object {
                if key.len() > MAX_CORE_PACKAGE_ID_BYTES {
                    return Err(format!("{location} 含过长字段名"));
                }
                let normalized = key.to_ascii_lowercase().replace('-', "_");
                if matches!(
                    normalized.as_str(),
                    "path"
                        | "file_path"
                        | "source_path"
                        | "book_path"
                        | "secret"
                        | "secrets"
                        | "token"
                        | "access_token"
                        | "refresh_token"
                        | "password"
                        | "api_key"
                        | "apikey"
                        | "cursor"
                        | "ack"
                        | "acknowledgement"
                        | "acknowledgements"
                        | "data_generation"
                ) {
                    return Err(format!("{location} 含不允许导出的本机或敏感字段：{key}"));
                }
                validate_portable_payload(child, depth + 1, &format!("{location}.{key}"))?;
            }
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_v2_envelope_without_a_database_connection() {
        let package = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": 1,
            "source_device_id": "source-device",
            "entities": [{
                "kind": "vocab",
                "id": "zh:纯规则",
                "data": {"word": "纯规则", "future_field": true},
                "updated_at": 2,
                "deleted_at": 0,
                "device_id": "source-device",
                "sync_version": 1
            }]
        });

        let entities = validate_core_package(&package).unwrap();
        assert_eq!(entities.len(), 1);
        assert_eq!(entities[0].kind, "vocab");
        assert_eq!(entities[0].id, "zh:纯规则");
        assert_eq!(
            entities[0].json_text,
            r#"{"future_field":true,"word":"纯规则"}"#
        );
    }

    #[test]
    fn rejects_case_and_separator_normalized_sensitive_payload_keys() {
        let package = json!({
            "format": CORE_PACKAGE_FORMAT,
            "version": CORE_PACKAGE_VERSION,
            "exported_at": 1,
            "source_device_id": "source-device",
            "entities": [{
                "kind": "vocab",
                "id": "zh:敏感字段",
                "data": {"Access-Token": "private"},
                "updated_at": 2,
                "deleted_at": 0,
                "device_id": "source-device",
                "sync_version": 1
            }]
        });

        let error = match validate_core_package(&package) {
            Ok(_) => panic!("sensitive portable payload key must be rejected"),
            Err(error) => error,
        };
        assert!(error.contains("敏感字段"));
    }
}
