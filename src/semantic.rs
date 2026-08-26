mod accelerator;
mod batch;
mod build;
mod device;
pub(crate) mod gpu;
pub(crate) mod gpu_runtime;
mod index_runtime;
mod m3;
pub(crate) mod model;
mod profile;
mod qwen;
mod retrieval;
mod search;
mod solution;
mod status;
mod storage;
mod vector;

pub(crate) use accelerator::LoadedShards;
pub(crate) use search::{SemBookHits, SemHit};
pub(crate) use vector::SemData;

use crate::AppState;
use tauri::Manager;
// ===========================================================================
//  语义检索（向量嵌入）：把段落转成向量，按余弦相似度排序，找“意思相近”的文本
// ===========================================================================

pub(crate) fn initialize_semantic_model_selection() {
    model::initialize_selection();
    device::initialize();
    retrieval::initialize();
    if let Err(error) = solution::commit(model::active_id(), retrieval::active_mode().id()) {
        crate::log(&format!(
            "semantic_solution migration_write_failed error={error}"
        ));
    }
}

/// Encode a bounded batch of public-news excerpts for the intelligence
/// workspace.  Unlike the book RAG path, this does not load, create, or write
/// a book vector shard or global HNSW index: the caller owns the returned
/// vectors for the duration of one request only.
///
/// The semantic model must already be available locally.  A news refresh must
/// not silently start a model download or compete with the reader's explicit
/// semantic setup flow.
pub(crate) fn embed_public_news_documents(
    state: &AppState,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    const MAX_PUBLIC_NEWS_DOCUMENTS: usize = 128;
    const MAX_PUBLIC_NEWS_DOCUMENT_CHARS: usize = 1_800;

    if texts.is_empty() || texts.len() > MAX_PUBLIC_NEWS_DOCUMENTS {
        return Err(format!(
            "资讯语义召回一次只能处理 1–{MAX_PUBLIC_NEWS_DOCUMENTS} 条候选"
        ));
    }
    if !model::available(state) {
        return Err("本地语义模型未就绪，已保留规则聚类结果".into());
    }
    let inputs = texts
        .iter()
        .map(|text| {
            let excerpt: String = text
                .trim()
                .chars()
                .take(MAX_PUBLIC_NEWS_DOCUMENT_CHARS)
                .collect();
            if excerpt.is_empty() {
                Err("资讯语义候选不能是空文本".to_string())
            } else {
                Ok(model::document_input(&excerpt))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let embedder = model::embedder(state)?;
    let mut vectors = embedder
        .lock()
        .map_err(|_| "资讯语义模型锁定失败".to_string())?
        .embed_dense(inputs)?;
    if vectors.len() != texts.len() || vectors.iter().any(|vector| vector.is_empty()) {
        return Err("本地语义模型返回的资讯向量不完整".into());
    }
    for vector in &mut vectors {
        crate::semantic_core::normalize(vector);
    }
    Ok(vectors)
}

/// 画像模块只需要向量维度、段落数量和连续向量，不接触段落文本或缓存许可。
fn sem_data_vector_parts(data: &SemData) -> (usize, usize, &[f32]) {
    data.vector_parts()
}

fn sem_dir() -> Option<std::path::PathBuf> {
    vector::directory()
}
fn sem_meta_path(id: u64) -> Option<std::path::PathBuf> {
    vector::metadata_path(id)
}
fn sem_vec_path(id: u64) -> Option<std::path::PathBuf> {
    vector::vector_path(id)
}
fn clear_multi_profile_cache() {
    profile::clear_multi_cache();
}

pub(crate) fn clear_semantic_aux_memory_caches() {
    clear_sem_query_cache();
    profile::clear_caches();
}

/// 画像预热会读取整份书库语义快照；默认不在启动时运行，避免与刚打开的阅读页
/// 抢占 CPU/磁盘。性能诊断可显式开启，正常使用仍在第一次真实语义查询时惰性加载。
pub(crate) fn spawn_semantic_profile_warmup(app: tauri::AppHandle) {
    if std::env::var_os("KUNPENG_SEMANTIC_PROFILE_WARM_ON_START").is_some() {
        profile::spawn_warmup(app);
    } else {
        crate::log("semantic_profile_bundle startup warmup skipped; lazy on first semantic query");
    }
}

fn get_sem_data(state: &AppState, id: u64) -> Option<std::sync::Arc<SemData>> {
    vector::load(state, id)
}

/// 全库分片快速索引是否存在且新鲜（版本/模型/参与书集合都匹配当前已索引的书）。
pub(crate) fn clear_sem_status_cache() {
    status::clear();
}

fn clear_sem_query_cache() {
    search::clear_cache();
}

fn clear_sem_profile_cache() {
    profile::clear_single_cache();
}

/// 查询某范围的语义索引是否已建立完成（供 UI 在点“建立”前判断、避免重复建立）。
#[tauri::command]
pub(crate) fn semantic_index_done(state: tauri::State<AppState>, ids: Option<Vec<String>>) -> bool {
    build::semantic_index_done(state, ids)
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
#[tauri::command]
pub(crate) async fn build_semantic_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    build::build_semantic_index(app, state, ids).await
}

#[tauri::command]
pub(crate) async fn download_semantic_model(app: tauri::AppHandle) -> Result<(), String> {
    model::download(app).await
}

#[tauri::command]
pub(crate) fn delete_semantic_model(state: tauri::State<AppState>) -> Result<(), String> {
    model::delete(state)
}

#[tauri::command]
pub(crate) fn select_semantic_model(
    state: tauri::State<AppState>,
    model_id: String,
) -> Result<(), String> {
    model::select(state, model_id)
}

#[tauri::command]
pub(crate) fn select_semantic_device_policy(
    state: tauri::State<AppState>,
    policy: String,
) -> Result<(), String> {
    device::select(state, &policy)
}

#[tauri::command]
pub(crate) fn select_semantic_retrieval_mode(
    state: tauri::State<AppState>,
    mode: String,
) -> Result<(), String> {
    retrieval::select_mode(state, &mode)
}

/// 模型与检索模式必须作为一个方案提交。前端不应再连续调用两个独立命令，
/// 否则中途失败会让用户以为已经选中了一个实际并未完整生效的组合。
#[tauri::command]
pub(crate) async fn select_semantic_solution(
    app: tauri::AppHandle,
    model_id: String,
    retrieval_mode: String,
) -> Result<(), String> {
    model::request_solution(app, &model_id, &retrieval_mode).await
}

#[tauri::command]
pub(crate) fn download_semantic_reranker(app: tauri::AppHandle) -> Result<(), String> {
    retrieval::download_reranker(app)
}

#[tauri::command]
pub(crate) fn set_semantic_m3_long_context(
    state: tauri::State<AppState>,
    enabled: bool,
) -> Result<(), String> {
    retrieval::set_long_context_enabled(state, enabled)
}

#[tauri::command]
pub(crate) fn delete_semantic_reranker(state: tauri::State<AppState>) -> Result<(), String> {
    retrieval::delete_reranker(state)
}

#[tauri::command]
pub(crate) async fn build_semantic_m3_index(app: tauri::AppHandle) -> Result<(), String> {
    m3::build(app).await
}

#[tauri::command]
pub(crate) fn delete_semantic_m3_index(state: tauri::State<AppState>) -> Result<(), String> {
    m3::delete(state)
}

#[tauri::command]
pub(crate) fn delete_semantic_index(
    state: tauri::State<AppState>,
    kind: String,
) -> Result<(), String> {
    {
        let p = state.sem_progress.lock().unwrap();
        if p.building || p.model_downloading {
            return Err("索引或模型任务正在运行，请稍候".into());
        }
    }
    let kind = kind.trim();
    if kind == "semantic" {
        vector::delete_index_files();
        let _ = m3::delete_files();
        profile::delete_all_files();
        accelerator::delete_index(state.inner());
        vector::clear_memory_cache(state.inner());
        clear_sem_query_cache();
        clear_sem_profile_cache();
        clear_multi_profile_cache();
        clear_sem_status_cache();
        let mut p = state.sem_progress.lock().unwrap();
        // 删除已成功时不能让旧任务计数继续作为状态来源，否则前端会显示
        // “已删除”但仍保留旧进度条和可点击的删除按钮。
        p.done = 0;
        p.total = 0;
        p.shard_done = 0;
        p.shard_total = 0;
        p.semantic_done = 0;
        p.semantic_total = 0;
        p.semantic_ready = false;
        p.semantic_bytes = 0;
        p.accelerator_done = 0;
        p.accelerator_total = 0;
        p.accelerator_ready = false;
        p.accelerator_resumable = false;
        p.accelerator_bytes = 0;
        p.multi_profile_done = 0;
        p.multi_profile_total = 0;
        p.multi_profile_ready = false;
        p.multi_profile_bytes = 0;
        p.current = "语义索引和加速索引已删除".into();
        p.error.clear();
        Ok(())
    } else if kind == "multi_profile" {
        profile::delete_multi_files()?;
        clear_sem_query_cache();
        if !status::update_multi_profile(0, None, false) {
            clear_sem_status_cache();
        }
        let mut p = state.sem_progress.lock().unwrap();
        p.current = "多中心画像索引已删除".into();
        p.error.clear();
        Ok(())
    } else if kind == "accelerator" {
        accelerator::delete_index(state.inner());
        clear_sem_query_cache();
        clear_sem_status_cache();
        let mut p = state.sem_progress.lock().unwrap();
        p.current = "加速索引已删除".into();
        p.error.clear();
        Ok(())
    } else {
        Err("未知索引类型".into())
    }
}

#[tauri::command]
pub(crate) async fn build_semantic_vectors(app: tauri::AppHandle) -> Result<(), String> {
    build::build_semantic_vectors(app).await
}

/// 请求暂停当前语义向量构建。正在执行的 ONNX 单批推理返回后立刻丢弃该批和
/// 当前书的临时文件；已完整落盘的书在“续建”时会被自动跳过。
#[tauri::command]
pub(crate) fn pause_semantic_vectors(state: tauri::State<AppState>) -> Result<(), String> {
    build::pause_semantic_vectors(state)
}

#[tauri::command]
pub(crate) async fn build_semantic_accelerator(app: tauri::AppHandle) -> Result<(), String> {
    build::build_semantic_accelerator(app).await
}

#[tauri::command]
pub(crate) async fn build_semantic_multi_profile(app: tauri::AppHandle) -> Result<(), String> {
    profile::build(app).await
}

/// 查询建立语义索引的进度。
#[tauri::command]
pub(crate) fn semantic_status(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
) -> status::SemanticProgressDto {
    status::public_snapshot(&app, state.inner())
}

#[tauri::command]
pub(crate) fn semantic_tasks(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    reconcile: Option<bool>,
) -> status::SemanticTaskCenter {
    status::task_center(status::snapshot(
        &app,
        state.inner(),
        reconcile.unwrap_or(false),
    ))
}

/// 用户进入语义检索界面时提前初始化模型、跑一次编码 warmup，并按当前内存预算载入加速分片。
/// 命令立即返回；真正工作在后台线程完成。查询若紧接着到来，会复用同一加载锁而不会重复读 9GB 索引。
#[tauri::command]
pub(crate) fn prepare_semantic_search(app: tauri::AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    state.with_db_read("prepare_semantic_search_route", |db| {
        crate::ai_reader::capabilities::ensure_local_search_enabled(db)
    })?;
    search::prepare(app)
}

#[tauri::command]
pub(crate) fn warm_semantic_model(app: tauri::AppHandle) -> Result<bool, String> {
    search::warm_model(app)
}

/// 语义检索：把查询转成向量，在已建索引的图书里按相似度排序返回。
#[tauri::command]
pub(crate) async fn semantic_search(
    app: tauri::AppHandle,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let state = app.state::<AppState>();
    state.with_db_read("semantic_search_route", |db| {
        crate::ai_reader::capabilities::ensure_local_search_enabled(db)
    })?;
    search::semantic_search(app, query, ids).await
}

/// Expand a retrieved short passage into its neighbouring prose without
/// reading the original book file. The semantic index preserves chapter
/// ordering, so this remains local and bounded while a reader is open.
pub(crate) fn semantic_context_around(
    app: &tauri::AppHandle,
    book_id: &str,
    chapter: u32,
    snippet: &str,
    max_chars: usize,
) -> Option<String> {
    let id = book_id.parse::<u64>().ok()?;
    search::context_around(
        app.state::<AppState>().inner(),
        id,
        chapter,
        snippet,
        max_chars,
    )
}

#[tauri::command]
pub(crate) async fn similar_books(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Vec<profile::SimilarBook>, String> {
    profile::similar_books(state, id).await
}

pub(crate) fn sem_probe() {
    model::probe();
}

/// 验证 instant-distance（HNSW 近邻索引）API：建图 → 序列化 → 反序列化 → 查询。
pub(crate) fn hnsw_probe() {
    accelerator::probe();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamed_messagepack_reports_the_published_length_and_hash() {
        let dir = std::env::temp_dir().join(format!(
            "kunpeng-global-stream-{}-{}",
            std::process::id(),
            crate::now_ms()
        ));
        let path = dir.join("global.map");
        let entries = vec![(7_u64, 3_u32, "第一个片段"), (8, 4, "第二个片段")];
        let (bytes, hash) = storage::write_rmp_hashed(&path, entries.as_slice()).unwrap();
        let published = std::fs::read(&path).unwrap();
        assert_eq!(bytes, published.len() as u64);
        assert_eq!(hash, storage::sha256_hex(&published));
        let decoded: Vec<(u64, u32, String)> = rmp_serde::from_slice(&published).unwrap();
        assert_eq!(decoded.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
