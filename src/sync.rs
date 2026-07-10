use crate::{data_migration, db, secret_store, AppState, DEFAULT_SYNC_URL};
use serde::{Deserialize, Serialize};
use tauri::Manager;

const LEGACY_SYNC_HTTP_URL: &str = "http://sync.example.invalid";
const SYNC_PULL_PAGE_SIZE: usize = 1_000;
const MAX_SYNC_PULL_PAGES: usize = 1_000;
const SYNC_PUSH_BATCH_ENTITIES: usize = 400;
const SYNC_PUSH_BATCH_BYTES: usize = 2 * 1024 * 1024;

#[derive(Serialize, Deserialize, Default, Clone)]
pub(crate) struct SyncSettings {
    url: String,
    #[serde(skip_serializing)]
    token: String,
    #[serde(default)]
    username: String,
    #[serde(default)]
    user_id: String,
    #[serde(default)]
    last_sync_at: i64,
    #[serde(default)]
    last_sync_pushed: usize,
    #[serde(default)]
    last_sync_pulled: usize,
    #[serde(default)]
    last_sync_accepted: usize,
    #[serde(default)]
    last_sync_ignored: usize,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct AuthUser {
    id: String,
    username: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub(crate) struct AuthResponse {
    #[serde(default)]
    ok: bool,
    #[serde(skip_serializing)]
    token: String,
    user: AuthUser,
}

#[derive(Serialize)]
pub(crate) struct SyncReport {
    ok: bool,
    message: String,
    pushed: usize,
    pulled: usize,
    accepted: usize,
    ignored: usize,
    server_time: i64,
}

#[derive(Deserialize)]
struct SyncPushResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    accepted_count: Option<u32>,
    #[serde(default)]
    accepted: Option<serde_json::Value>,
    #[serde(default)]
    ignored_count: Option<u32>,
    #[serde(default)]
    ignored: Option<serde_json::Value>,
}

impl SyncPushResponse {
    fn accepted_total(&self) -> u32 {
        self.accepted_count
            .unwrap_or_else(|| legacy_sync_count(self.accepted.as_ref()))
    }

    fn ignored_total(&self) -> u32 {
        self.ignored_count
            .unwrap_or_else(|| legacy_sync_count(self.ignored.as_ref()))
    }
}

fn legacy_sync_count(value: Option<&serde_json::Value>) -> u32 {
    match value {
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .and_then(|count| u32::try_from(count).ok())
            .unwrap_or_default(),
        Some(serde_json::Value::Array(items)) => u32::try_from(items.len()).unwrap_or(u32::MAX),
        _ => 0,
    }
}

#[derive(Deserialize)]
struct SyncPullResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    next_cursor: String,
    #[serde(default)]
    has_more: bool,
}

fn sync_settings_from_db(db: &db::AppDb) -> SyncSettings {
    SyncSettings {
        url: db
            .metadata("sync_url")
            .unwrap_or_else(|| DEFAULT_SYNC_URL.to_string()),
        token: read_sync_token(db).unwrap_or_default(),
        username: db.metadata("sync_username").unwrap_or_default(),
        user_id: db.metadata("sync_user_id").unwrap_or_default(),
        last_sync_at: db
            .metadata("sync_last_sync_at")
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0),
        last_sync_pushed: db
            .metadata("sync_last_pushed")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_pulled: db
            .metadata("sync_last_pulled")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_accepted: db
            .metadata("sync_last_accepted")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
        last_sync_ignored: db
            .metadata("sync_last_ignored")
            .and_then(|s| s.parse::<usize>().ok())
            .unwrap_or(0),
    }
}

fn read_sync_token(db: &db::AppDb) -> Result<String, String> {
    if let Some(protected) = db.metadata("sync_token_protected") {
        return secret_store::unprotect_secret(&protected);
    }
    Ok(db.metadata("sync_token").unwrap_or_default())
}

fn write_sync_token(db: &db::AppDb, token: &str) -> Result<(), String> {
    let protected = secret_store::protect_secret(token.trim())?;
    db.set_metadata("sync_token_protected", &protected)?;
    // Clear the legacy plaintext slot so new writes do not leave token material there.
    db.set_metadata("sync_token", "")?;
    Ok(())
}

fn is_local_http_base(base: &str) -> bool {
    base == "http://localhost"
        || base.starts_with("http://localhost:")
        || base == "http://127.0.0.1"
        || base.starts_with("http://127.0.0.1:")
        || base == "http://[::1]"
        || base.starts_with("http://[::1]:")
}

fn normalize_sync_base(input: &str) -> Result<String, String> {
    let base = if input.trim().is_empty() {
        DEFAULT_SYNC_URL.to_string()
    } else {
        input.trim().trim_end_matches('/').to_string()
    };
    if base.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("同步服务器地址包含非法空白字符".into());
    }
    if base.starts_with("https://") {
        return Ok(base);
    }
    // Versions before the HTTPS rollout persisted this exact public endpoint.
    // Upgrade only the known legacy origin; arbitrary public HTTP remains blocked.
    if base == LEGACY_SYNC_HTTP_URL {
        return Ok(DEFAULT_SYNC_URL.to_string());
    }
    if base.starts_with("http://") {
        // 只允许本机调试使用明文 HTTP；公网同步必须走 HTTPS。
        if is_local_http_base(&base) {
            return Ok(base);
        }
        return Err("同步服务器必须使用 HTTPS；只有本机调试地址允许 HTTP".into());
    }
    Err("同步服务器地址必须以 https:// 开头".into())
}

fn sync_push_batches(entities: &[db::SyncEntity]) -> Result<Vec<Vec<db::SyncEntity>>, String> {
    let mut batches = Vec::new();
    let mut batch = Vec::new();
    let mut batch_bytes = 0usize;

    for entity in entities {
        let entity_bytes = serde_json::to_vec(entity)
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

fn newer_cursor(current: &str, candidate: &str) -> String {
    let current_value = current.trim().parse::<i128>().unwrap_or(0);
    let candidate_value = candidate.trim().parse::<i128>().unwrap_or(0);
    if candidate_value > current_value {
        candidate.trim().to_string()
    } else {
        current.trim().to_string()
    }
}

fn save_auth_response(db: &db::AppDb, res: &AuthResponse) -> Result<(), String> {
    if res.token.trim().is_empty() {
        return Err("服务器没有返回登录 token".into());
    }
    write_sync_token(db, &res.token)?;
    db.set_metadata("sync_username", res.user.username.trim())?;
    db.set_metadata("sync_user_id", res.user.id.trim())?;
    Ok(())
}

fn auth_request_inner(
    state: &AppState,
    endpoint: &str,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    let base = normalize_sync_base(&url)?;
    let username = username.trim().to_string();
    if username.is_empty() || password.is_empty() {
        return Err("请输入账号和密码".into());
    }
    {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        db.set_metadata("sync_url", &base)?;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let body = serde_json::json!({
        "username": username,
        "password": password,
    });
    let res: AuthResponse = agent
        .post(&format!("{base}{endpoint}"))
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| format!("认证请求失败：{e}"))?
        .into_json()
        .map_err(|e| format!("认证返回解析失败：{e}"))?;
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    save_auth_response(db, &res)?;
    Ok(res)
}

#[tauri::command]
pub(crate) fn sync_get_settings(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    Ok(sync_settings_from_db(db))
}

#[tauri::command]
pub(crate) fn sync_set_settings(
    state: tauri::State<AppState>,
    url: String,
    token: String,
) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    let base = normalize_sync_base(&url)?;
    db.set_metadata("sync_url", &base)?;
    write_sync_token(db, &token)?;
    Ok(sync_settings_from_db(db))
}

#[tauri::command]
pub(crate) async fn auth_logout(app: tauri::AppHandle) -> Result<SyncSettings, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let settings = {
            let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
            sync_settings_from_db(db)
        };
        if !settings.token.is_empty() {
            if let Ok(base) = normalize_sync_base(&settings.url) {
                // Remote revocation is best effort: an offline user must still
                // be able to remove credentials from this device immediately.
                let _ = ureq::AgentBuilder::new()
                    .timeout(std::time::Duration::from_secs(8))
                    .build()
                    .post(&format!("{base}/auth/logout"))
                    .set("Authorization", &format!("Bearer {}", settings.token))
                    .set("Content-Type", "application/json")
                    .send_json(serde_json::json!({}));
            }
        }
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        write_sync_token(db, "")?;
        db.set_metadata("sync_username", "")?;
        db.set_metadata("sync_user_id", "")?;
        Ok(sync_settings_from_db(db))
    })
    .await
    .map_err(|e| format!("退出登录任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_register(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/register", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

#[tauri::command]
pub(crate) async fn auth_login(
    app: tauri::AppHandle,
    url: String,
    username: String,
    password: String,
) -> Result<AuthResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        auth_request_inner(state.inner(), "/auth/login", url, username, password)
    })
    .await
    .map_err(|e| format!("认证任务失败：{e}"))?
}

fn sync_now_inner(state: &AppState) -> Result<SyncReport, String> {
    data_migration::ensure_content_ids_for_sync(state)?;
    // Snapshot local JSON first so unsynced edits are represented in SQLite.
    data_migration::migrate_json_to_sqlite(state)?;
    let (settings, device_id, cursor) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        let settings = sync_settings_from_db(db);
        if settings.url.trim().is_empty() || settings.token.trim().is_empty() {
            return Err("请先登录账号".into());
        }
        let cursor = db.metadata("sync_cursor").unwrap_or_default();
        (settings, db.device_id(), cursor)
    };
    let base = normalize_sync_base(&settings.url)?;
    if base != settings.url {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.set_metadata("sync_url", &base)?;
    }
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();

    // Pull before push. A newly imported zero-progress book must not overwrite
    // the established position from another computer. Continue paging until the
    // server confirms that this cursor has caught up.
    let mut pulled = 0u32;
    let mut pull_server_time = 0i64;
    let mut sync_cursor = cursor.clone();
    let mut pull_cursor = if cursor.is_empty() {
        settings.last_sync_at.to_string()
    } else {
        cursor
    };
    let mut pull_completed = false;
    for _ in 0..MAX_SYNC_PULL_PAGES {
        let pull: SyncPullResponse = agent
            .get(&format!("{base}/sync/pull"))
            .query("cursor", &pull_cursor)
            .query("limit", &SYNC_PULL_PAGE_SIZE.to_string())
            .set("Authorization", &format!("Bearer {}", settings.token))
            .call()
            .map_err(|e| format!("pull 失败：{e}"))?
            .into_json()
            .map_err(|e| format!("pull 返回解析失败：{e}"))?;
        pull_server_time = pull_server_time.max(pull.server_time);
        data_migration::merge_pulled_book_states(state, &pull.entities)?;
        pulled += {
            let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
            let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
            db.import_sync_entities(&pull.entities)?
        };
        let next_cursor = pull.next_cursor.trim();
        if !next_cursor.is_empty() {
            sync_cursor = newer_cursor(&sync_cursor, next_cursor);
        }
        if !pull.has_more {
            pull_completed = true;
            break;
        }
        if next_cursor.is_empty() || next_cursor == pull_cursor {
            return Err("pull 游标没有前进，已停止以避免重复同步".into());
        }
        pull_cursor = next_cursor.to_string();
    }
    if !pull_completed {
        return Err("pull 分页数量超过安全上限，稍后可继续同步".into());
    }
    data_migration::apply_sqlite_to_runtime(state)?;
    // Persist the field-wise book merge; unchanged JSON does not become dirty.
    data_migration::migrate_json_to_sqlite(state)?;
    let entities = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        db.dirty_sync_entities()?
    };
    let mut pushed = 0usize;
    let mut accepted = 0usize;
    let mut ignored = 0usize;
    let mut push_server_time = 0i64;
    for batch in sync_push_batches(&entities)? {
        let push_body = serde_json::json!({
            "schema_version": 2,
            "device_id": device_id,
            "entities": batch,
        });
        let push: SyncPushResponse = agent
            .post(&format!("{base}/sync/push"))
            .set("Authorization", &format!("Bearer {}", settings.token))
            .set("Content-Type", "application/json")
            .send_json(push_body)
            .map_err(|e| format!("push 失败：{e}"))?
            .into_json()
            .map_err(|e| format!("push 返回解析失败：{e}"))?;
        pushed += batch.len();
        accepted += push.accepted_total() as usize;
        ignored += push.ignored_total() as usize;
        push_server_time = push_server_time.max(push.server_time);
        // The server has decided this exact version. Conditional updates ensure
        // a concurrent local edit stays dirty and is uploaded on the next run.
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        db.mark_sync_entities_clean(&batch)?;
        if !push.entities.is_empty() {
            let _ = db.import_sync_entities(&push.entities)?;
        }
    }

    let server_time = {
        let mut db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let server_time = push_server_time.max(pull_server_time);
        db.set_metadata("sync_last_sync_at", &server_time.to_string())?;
        if !sync_cursor.is_empty() {
            db.set_metadata("sync_cursor", &sync_cursor)?;
        }
        db.set_metadata("sync_last_pushed", &pushed.to_string())?;
        db.set_metadata("sync_last_pulled", &pulled.to_string())?;
        db.set_metadata("sync_last_accepted", &accepted.to_string())?;
        db.set_metadata("sync_last_ignored", &ignored.to_string())?;
        server_time
    };
    data_migration::apply_sqlite_to_runtime(state)?;
    Ok(SyncReport {
        ok: true,
        message: format!(
            "同步完成：推送 {} 条，服务端接受 {} 条，忽略 {} 条，拉取 {} 条",
            pushed, accepted, ignored, pulled
        ),
        pushed,
        pulled: pulled as usize,
        accepted,
        ignored,
        server_time,
    })
}

#[tauri::command]
pub(crate) async fn sync_now(app: tauri::AppHandle) -> Result<SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        sync_now_inner(state.inner())
    })
    .await
    .map_err(|e| format!("同步任务失败：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_sync_responses_do_not_expose_tokens() {
        let settings = SyncSettings {
            url: "https://example.com".to_string(),
            token: "secret-token".to_string(),
            username: "alice".to_string(),
            user_id: "u1".to_string(),
            last_sync_at: 123,
            last_sync_pushed: 2,
            last_sync_pulled: 3,
            last_sync_accepted: 2,
            last_sync_ignored: 0,
        };
        let auth = AuthResponse {
            ok: true,
            token: "auth-token".to_string(),
            user: AuthUser {
                id: "u1".to_string(),
                username: "alice".to_string(),
            },
        };

        let settings_json = serde_json::to_value(settings).unwrap();
        let auth_json = serde_json::to_value(auth).unwrap();
        assert!(settings_json.get("token").is_none());
        assert!(auth_json.get("token").is_none());
        assert_eq!(settings_json["username"], "alice");
        assert_eq!(auth_json["user"]["username"], "alice");
    }

    #[test]
    fn sync_base_requires_https_except_localhost() {
        assert_eq!(
            normalize_sync_base(" https://reader.example.com/ ").unwrap(),
            "https://reader.example.com"
        );
        assert_eq!(normalize_sync_base("").unwrap(), DEFAULT_SYNC_URL);
        assert_eq!(
            normalize_sync_base("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_sync_base("http://sync.example.invalid").unwrap(),
            DEFAULT_SYNC_URL
        );
        assert!(normalize_sync_base("http://sync.example.invalid:8787").is_err());
        assert!(normalize_sync_base("http://sync.example.invalid/sync").is_err());
        assert!(normalize_sync_base("http://example.com").is_err());
        assert!(normalize_sync_base("ftp://example.com").is_err());
        assert!(normalize_sync_base("https://example.com/a b").is_err());
    }

    #[test]
    fn push_response_accepts_v1_v2_and_combined_count_fields() {
        for (json, accepted, ignored) in [
            (r#"{"server_time":1,"accepted":2,"ignored":3}"#, 2, 3),
            (
                r#"{"server_time":1,"accepted":["a","b"],"ignored":["c"]}"#,
                2,
                1,
            ),
            (
                r#"{"server_time":1,"accepted_count":4,"ignored_count":5}"#,
                4,
                5,
            ),
            (
                r#"{"server_time":1,"accepted_count":6,"accepted":["a","b"],"ignored_count":7,"ignored":["c"]}"#,
                6,
                7,
            ),
        ] {
            let response: SyncPushResponse = serde_json::from_str(json).unwrap();
            assert_eq!(response.accepted_total(), accepted);
            assert_eq!(response.ignored_total(), ignored);
        }
    }

    #[test]
    fn sync_push_batches_bound_entity_count() {
        let entities = (0..(SYNC_PUSH_BATCH_ENTITIES + 1))
            .map(|index| db::SyncEntity {
                kind: "vocab".to_string(),
                id: index.to_string(),
                json: serde_json::json!({"word": "test"}),
                updated_at: index as i64,
                deleted_at: 0,
                device_id: "test".to_string(),
                sync_version: 1,
            })
            .collect::<Vec<_>>();
        let batches = sync_push_batches(&entities).unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0].len(), SYNC_PUSH_BATCH_ENTITIES);
        assert_eq!(batches[1].len(), 1);
    }

    #[test]
    fn newer_cursor_never_moves_backwards() {
        assert_eq!(newer_cursor("100", "99"), "100");
        assert_eq!(newer_cursor("100", "101"), "101");
        assert_eq!(newer_cursor("", "101"), "101");
    }
}
