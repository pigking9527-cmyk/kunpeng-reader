//! Wire-only sync protocol types and deterministic local helpers.
//!
//! This module deliberately has no HTTP, Tauri, database-lock, or account
//! lifecycle ownership. The parent synchronizer owns transport and commits;
//! these helpers only preserve the existing request/response interpretation.

use crate::db;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub(super) const SYNC_PUSH_BATCH_ENTITIES: usize = 400;
pub(super) const SYNC_PUSH_BATCH_BYTES: usize = 2 * 1024 * 1024;

/// The v5 Axum envelope uses `payload`; SQLite deliberately calls the same
/// opaque document `json`. Keep that translation at the wire boundary.
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncEntityEnvelope {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) updated_at: i64,
    pub(super) deleted_at: i64,
    pub(super) device_id: String,
    pub(super) sync_version: i64,
    pub(super) payload: serde_json::Value,
}

impl From<&db::SyncEntity> for SyncEntityEnvelope {
    fn from(entity: &db::SyncEntity) -> Self {
        Self {
            id: entity.id.clone(),
            kind: entity.kind.clone(),
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id.clone(),
            sync_version: entity.sync_version,
            payload: entity.json.clone(),
        }
    }
}

impl From<SyncEntityEnvelope> for db::SyncEntity {
    fn from(entity: SyncEntityEnvelope) -> Self {
        Self {
            id: entity.id,
            kind: entity.kind,
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id,
            sync_version: entity.sync_version,
            json: entity.payload,
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncPushRequest {
    mutation_id: Uuid,
    data_generation: i64,
    pub(super) entities: Vec<SyncEntityEnvelope>,
}

impl SyncPushRequest {
    pub(super) fn new(data_generation: i64, batch: &[db::SyncEntity]) -> Self {
        Self {
            mutation_id: Uuid::new_v4(),
            data_generation,
            entities: batch.iter().map(SyncEntityEnvelope::from).collect(),
        }
    }

    pub(super) fn mutation_id(&self) -> Uuid {
        self.mutation_id
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncPushResponse {
    pub(super) mutation_id: Uuid,
    pub(super) data_generation: i64,
    accepted: Vec<SyncEntityEnvelope>,
    conflicts: Vec<SyncEntityEnvelope>,
}

impl SyncPushResponse {
    pub(super) fn accepted_entities(&self) -> Vec<db::SyncEntity> {
        self.accepted.clone().into_iter().map(Into::into).collect()
    }

    pub(super) fn conflicts(&self) -> Vec<db::SyncEntity> {
        self.conflicts.clone().into_iter().map(Into::into).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncPullResponse {
    pub(super) data_generation: i64,
    entities: Vec<SyncEntityEnvelope>,
    pub(super) next_cursor: i64,
    pub(super) has_more: bool,
}

impl SyncPullResponse {
    pub(super) fn into_entities(self) -> Vec<db::SyncEntity> {
        self.entities.into_iter().map(Into::into).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncInventoryResponse {
    pub(super) server_time: i64,
    pub(super) data_generation: i64,
    pub(super) entity_count: usize,
    pub(super) inventory_digest: String,
    pub(super) revision: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncManifestEntry {
    kind: String,
    id: String,
    updated_at: i64,
    deleted_at: i64,
    device_id: String,
    sync_version: i64,
}

impl From<&db::SyncEntity> for SyncManifestEntry {
    fn from(entity: &db::SyncEntity) -> Self {
        Self {
            kind: entity.kind.clone(),
            id: entity.id.clone(),
            updated_at: entity.updated_at,
            deleted_at: entity.deleted_at,
            device_id: entity.device_id.clone(),
            sync_version: entity.sync_version,
        }
    }
}

#[derive(Deserialize)]
pub(super) struct SyncEntityKey {
    pub(super) kind: String,
    pub(super) id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SyncReconcileResponse {
    pub(super) server_time: i64,
    pub(super) data_generation: i64,
    pub(super) entity_count: usize,
    pub(super) inventory_digest: String,
    pub(super) revision: String,
    pub(super) upload: Vec<SyncEntityKey>,
    pub(super) entities: Vec<SyncEntityEnvelope>,
}

impl SyncReconcileResponse {
    pub(super) fn entities(&self) -> Vec<db::SyncEntity> {
        self.entities.clone().into_iter().map(Into::into).collect()
    }
}

pub(super) fn reconcile_proves_inventory(
    local_count: usize,
    response: &SyncReconcileResponse,
) -> bool {
    response.entity_count == local_count
        && response.upload.is_empty()
        && response.entities.is_empty()
}

fn update_inventory_text(hasher: &mut Sha256, value: &str) {
    let bytes = value.as_bytes();
    hasher.update(u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    hasher.update(bytes);
}

pub(super) fn sync_inventory_digest(entities: &[db::SyncEntity]) -> String {
    let mut sorted = entities.iter().collect::<Vec<_>>();
    sorted.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut hasher = Sha256::new();
    for entity in sorted {
        update_inventory_text(&mut hasher, &entity.kind);
        update_inventory_text(&mut hasher, &entity.id);
        update_inventory_text(&mut hasher, &entity.device_id);
        hasher.update(entity.sync_version.to_be_bytes());
        hasher.update(entity.updated_at.to_be_bytes());
        hasher.update(entity.deleted_at.to_be_bytes());
    }
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(super) fn inventory_matches(local: &[db::SyncEntity], remote: &SyncInventoryResponse) -> bool {
    local.len() == remote.entity_count
        && sync_inventory_digest(local).eq_ignore_ascii_case(&remote.inventory_digest)
}

pub(super) fn sync_push_batches(
    entities: &[db::SyncEntity],
) -> Result<Vec<Vec<db::SyncEntity>>, String> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut batch_bytes = 0usize;

    // Per-entry history retention can replace an old live entity with a
    // tombstone in the same sync. Send retirements first so the server can
    // enforce the account limit without rejecting the following replacement.
    let mut ordered = entities.to_vec();
    ordered.sort_by_key(|entity| {
        (
            entity.deleted_at == 0,
            entity.kind.clone(),
            entity.id.clone(),
        )
    });
    for entity in &ordered {
        let entity_bytes = serde_json::to_vec(&SyncEntityEnvelope::from(entity))
            .map_err(|e| format!("同步实体序列化失败：{e}"))?
            .len();
        if !batch.is_empty()
            && (batch.len() >= SYNC_PUSH_BATCH_ENTITIES
                || batch_bytes.saturating_add(entity_bytes) > SYNC_PUSH_BATCH_BYTES)
        {
            batches.push(batch);
            batch = Vec::new();
            batch_bytes = 0;
        }
        batch_bytes = batch_bytes.saturating_add(entity_bytes);
        batch.push(entity.clone());
    }
    if !batch.is_empty() {
        batches.push(batch);
    }
    Ok(batches)
}

pub(super) fn newer_cursor(current: &str, candidate: &str) -> String {
    let current = current.trim();
    let candidate = candidate.trim();
    match (current.parse::<i128>(), candidate.parse::<i128>()) {
        (Ok(current_value), Ok(candidate_value)) if candidate_value > current_value => {
            candidate.to_string()
        }
        (Ok(_), Ok(_)) => current.to_string(),
        _ if candidate.is_empty() || candidate == current => current.to_string(),
        _ => candidate.to_string(),
    }
}

pub(super) fn cursor_strictly_advances(current: &str, candidate: &str) -> bool {
    let current = current.trim();
    let candidate = candidate.trim();
    if candidate.is_empty() || candidate == current {
        return false;
    }
    match (current.parse::<i128>(), candidate.parse::<i128>()) {
        (Ok(current), Ok(candidate)) => candidate > current,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entity(id: &str, version: i64) -> db::SyncEntity {
        db::SyncEntity {
            kind: "vocab".into(),
            id: id.into(),
            json: serde_json::json!({}),
            updated_at: 1,
            deleted_at: 0,
            device_id: "device-a".into(),
            sync_version: version,
        }
    }

    #[test]
    fn v5_push_envelope_uses_payload_and_keeps_accept_conflict_sets_distinct() {
        let response: SyncPushResponse = serde_json::from_value(serde_json::json!({
            "mutationId": "00112233-4455-6677-8899-aabbccddeeff",
            "dataGeneration": 4,
            "accepted": [
                {"kind":"vocab","id":"accepted","payload":{},"updatedAt":2,"deletedAt":0,"deviceId":"device-a","syncVersion":1}
            ],
            "conflicts": [
                {"kind":"vocab","id":"conflict","payload":{},"updatedAt":3,"deletedAt":0,"deviceId":"device-z","syncVersion":2}
            ]
        }))
        .unwrap();
        assert_eq!(
            response
                .accepted_entities()
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["accepted"]
        );
        assert_eq!(response.conflicts()[0].device_id, "device-z");
        assert_eq!(response.data_generation, 4);
        assert!(
            serde_json::from_value::<SyncPushResponse>(serde_json::json!({
                "mutationId": "00112233-4455-6677-8899-aabbccddeeff",
                "accepted": [],
                "conflicts": []
            }))
            .is_err()
        );
    }

    #[test]
    fn inventory_digest_and_cursor_rules_are_deterministic() {
        let entities = vec![
            db::SyncEntity {
                kind: "vocab".into(),
                id: "zh:词".into(),
                json: serde_json::json!({}),
                updated_at: 1_700_000_000_100,
                deleted_at: 1_700_000_000_200,
                device_id: "device-b".into(),
                sync_version: 7,
            },
            db::SyncEntity {
                kind: "book_state_v2".into(),
                id: "书-1".into(),
                json: serde_json::json!({}),
                updated_at: 1_700_000_000_000,
                deleted_at: 0,
                device_id: "device-a".into(),
                sync_version: 3,
            },
        ];
        assert_eq!(
            sync_inventory_digest(&entities),
            "5b47a5b8875ddb2d9cf9fc65c7698eaa3de450ccb547b84a11f2f688fa41c267"
        );
        let inventory = SyncInventoryResponse {
            server_time: 0,
            data_generation: 1,
            entity_count: 2,
            inventory_digest: "5b47a5b8875ddb2d9cf9fc65c7698eaa3de450ccb547b84a11f2f688fa41c267"
                .into(),
            revision: "10".into(),
        };
        assert!(inventory_matches(&entities, &inventory));
        assert!(cursor_strictly_advances("100", "101"));
        assert!(!cursor_strictly_advances("100", "99"));
        assert_eq!(newer_cursor("100", "99"), "100");
        assert_eq!(newer_cursor("opaque-a", "opaque-b"), "opaque-b");
    }

    #[test]
    fn reconcile_needs_an_empty_action_set_to_prove_inventory() {
        let response = SyncReconcileResponse {
            server_time: 1,
            data_generation: 1,
            entity_count: 2,
            inventory_digest: "legacy-digest".into(),
            revision: "10".into(),
            upload: vec![],
            entities: vec![],
        };
        assert!(reconcile_proves_inventory(2, &response));
        assert!(!reconcile_proves_inventory(1, &response));

        let mut action = response;
        action.upload.push(SyncEntityKey {
            kind: "vocab".into(),
            id: "word".into(),
        });
        assert!(!reconcile_proves_inventory(2, &action));
    }

    #[test]
    fn v5_push_request_projects_sqlite_json_as_payload() {
        let mut local = entity("v5", 2);
        local.json = serde_json::json!({"future": true});
        let request = SyncPushRequest::new(3, &[local]);
        let encoded = serde_json::to_value(request).unwrap();
        assert_eq!(encoded["dataGeneration"], 3);
        assert!(encoded.get("mutationId").is_some());
        assert!(encoded.get("schema_version").is_none());
        assert_eq!(encoded["entities"][0]["payload"]["future"], true);
        assert!(encoded["entities"][0].get("json").is_none());
        assert!(encoded["entities"][0].get("updatedAt").is_some());
        assert!(encoded["entities"][0].get("updated_at").is_none());
    }

    #[test]
    fn v5_pull_response_accepts_camel_case_wire_envelopes() {
        let pull: SyncPullResponse = serde_json::from_value(serde_json::json!({
            "dataGeneration": 9,
            "nextCursor": 3,
            "hasMore": false,
            "entities": [{
                "id": "default",
                "kind": "app_settings_v1",
                "updatedAt": 12,
                "deletedAt": 0,
                "deviceId": "device-a",
                "syncVersion": 4,
                "payload": {"readerJumpBackIconSizePx": 32}
            }]
        }))
        .unwrap();
        let entities = pull.into_entities();
        assert_eq!(entities[0].updated_at, 12);
        assert_eq!(entities[0].device_id, "device-a");
        assert_eq!(entities[0].json["readerJumpBackIconSizePx"], 32);
        assert!(
            serde_json::from_value::<SyncPullResponse>(serde_json::json!({
                "dataGeneration": 9,
                "nextCursor": 3,
                "entities": []
            }))
            .is_err()
        );
    }

    #[test]
    fn batches_tombstones_before_live_entities_and_respect_count_limit() {
        let mut tombstone = entity("retired", 1);
        tombstone.deleted_at = 1;
        let mut entities = vec![tombstone];
        entities.extend((0..SYNC_PUSH_BATCH_ENTITIES).map(|index| entity(&index.to_string(), 1)));
        let batches = sync_push_batches(&entities).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0][0].id, "retired");
        assert_eq!(batches[0].len(), SYNC_PUSH_BATCH_ENTITIES);
    }
}
