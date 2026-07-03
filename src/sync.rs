use crate::{data_migration, db, secret_store, AppState, DEFAULT_SYNC_URL};
use serde::{Deserialize, Serialize};
use tauri::Manager;

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
    server_time: i64,
}

#[derive(Deserialize)]
struct SyncPushResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
    #[serde(default)]
    accepted_count: u32,
    #[serde(default)]
    ignored_count: u32,
}

#[derive(Deserialize)]
struct SyncPullResponse {
    server_time: i64,
    #[serde(default)]
    entities: Vec<db::SyncEntity>,
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
    if base.starts_with("http://") {
        // 只允许本机调试使用明文 HTTP；公网同步必须走 HTTPS。
        if is_local_http_base(&base) {
            return Ok(base);
        }
        return Err("同步服务器必须使用 HTTPS；只有本机调试地址允许 HTTP".into());
    }
    Err("同步服务器地址必须以 https:// 开头".into())
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
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
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
pub(crate) fn auth_logout(state: tauri::State<AppState>) -> Result<SyncSettings, String> {
    let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
    let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
    write_sync_token(db, "")?;
    db.set_metadata("sync_username", "")?;
    db.set_metadata("sync_user_id", "")?;
    Ok(sync_settings_from_db(db))
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
    data_migration::migrate_json_to_sqlite(state);
    let (settings, device_id, entities) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        let settings = sync_settings_from_db(db);
        if settings.url.trim().is_empty() || settings.token.trim().is_empty() {
            return Err("请先登录账号".into());
        }
        (settings, db.device_id(), db.all_sync_entities()?)
    };
    let base = normalize_sync_base(&settings.url)?;
    let agent = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(20))
        .build();
    let push_body = serde_json::json!({
        "device_id": device_id,
        "entities": entities,
    });
    let push: SyncPushResponse = agent
        .post(&format!("{base}/sync/push"))
        .set("Authorization", &format!("Bearer {}", settings.token))
        .set("Content-Type", "application/json")
        .send_json(push_body)
        .map_err(|e| format!("push 失败：{e}"))?
        .into_json()
        .map_err(|e| format!("push 返回解析失败：{e}"))?;

    let pull: SyncPullResponse = agent
        .get(&format!("{base}/sync/pull"))
        .query("since", &settings.last_sync_at.to_string())
        .set("Authorization", &format!("Bearer {}", settings.token))
        .call()
        .map_err(|e| format!("pull 失败：{e}"))?
        .into_json()
        .map_err(|e| format!("pull 返回解析失败：{e}"))?;

    let (pulled, server_time) = {
        let db_guard = state.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        let db = db_guard.as_ref().ok_or("SQLite 数据库不可用")?;
        if !push.entities.is_empty() {
            let _ = db.import_sync_entities(&push.entities)?;
        }
        let pulled = db.import_sync_entities(&pull.entities)?;
        let server_time = push.server_time.max(pull.server_time);
        db.set_metadata("sync_last_sync_at", &server_time.to_string())?;
        (pulled, server_time)
    };
    data_migration::apply_sqlite_to_runtime(state);
    Ok(SyncReport {
        ok: true,
        message: format!(
            "同步完成：推送 {} 条，服务端接受 {} 条，忽略 {} 条，拉取 {} 条",
            entities.len(),
            push.accepted_count,
            push.ignored_count,
            pulled
        ),
        pushed: entities.len(),
        pulled: pulled as usize,
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
        assert!(normalize_sync_base("http://sync.example.invalid").is_err());
        assert!(normalize_sync_base("http://example.com").is_err());
        assert!(normalize_sync_base("ftp://example.com").is_err());
        assert!(normalize_sync_base("https://example.com/a b").is_err());
    }
}
