mod accelerator;
mod batch;
mod build;
mod index_runtime;
mod model;
mod profile;
mod search;
mod status;
mod vector;

pub(crate) use accelerator::LoadedShards;
pub(crate) use search::{SemBookHits, SemHit};
pub(crate) use vector::SemData;

use crate::{book, AppState};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
// ===========================================================================
//  语义检索（向量嵌入）：把段落转成向量，按余弦相似度排序，找“意思相近”的文本
// ===========================================================================

pub(crate) fn initialize_semantic_model_selection() {
    model::initialize_selection();
}

/// 画像模块只需要向量维度、段落数量和连续向量，不接触段落文本或缓存许可。
fn sem_data_vector_parts(data: &SemData) -> (usize, usize, &[f32]) {
    data.vector_parts()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect()
}

struct IntegrityWriter<W> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W> IntegrityWriter<W> {
    fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        let hash = self
            .hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect();
        (self.bytes, hash)
    }
}

impl<W: Write> Write for IntegrityWriter<W> {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        let written = self.inner.write(buffer)?;
        if written > 0 {
            self.hasher.update(&buffer[..written]);
            self.bytes = self.bytes.saturating_add(written as u64);
        }
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}

/// 当前可进入全库加速分片的书与源文件签名。一次遍历同时产生两份数据，
/// 避免状态检查、建图和首查重复读取数百个逐书元数据文件。
fn indexed_book_snapshot_cached(state: &AppState) -> (Vec<u64>, Vec<vector::IndexSourceSignature>) {
    accelerator::indexed_book_snapshot_cached(state)
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

/// 启动后低成本预载合并画像。13 MB 左右的单文件换来首查不再打开上千个小文件。
pub(crate) fn spawn_semantic_profile_warmup(app: tauri::AppHandle) {
    profile::spawn_warmup(app);
}

fn sem_index_done_for_book(book: &book::Book) -> bool {
    vector::is_complete(book)
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
        profile::delete_all_files();
        accelerator::delete_index(state.inner());
        vector::clear_memory_cache(state.inner());
        clear_sem_query_cache();
        clear_sem_profile_cache();
        clear_multi_profile_cache();
        clear_sem_status_cache();
        let mut p = state.sem_progress.lock().unwrap();
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

fn write_rmp_hashed<T: Serialize + ?Sized>(
    path: &std::path::Path,
    value: &T,
) -> Result<(u64, String), String> {
    crate::atomic_file::write_with(path, |file| {
        let buffered = std::io::BufWriter::new(file);
        let mut writer = IntegrityWriter::new(buffered);
        rmp_serde::encode::write(&mut writer, value)
            .map_err(|error| format!("序列化索引失败：{error}"))?;
        writer
            .flush()
            .map_err(|error| format!("刷新索引失败：{error}"))?;
        Ok(writer.finish())
    })
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
) -> status::SemanticTaskCenter {
    status::task_center(status::snapshot(&app, state.inner()))
}

/// 用户进入语义检索界面时提前初始化模型、跑一次编码 warmup，并按当前内存预算载入加速分片。
/// 命令立即返回；真正工作在后台线程完成。查询若紧接着到来，会复用同一加载锁而不会重复读 9GB 索引。
#[tauri::command]
pub(crate) fn prepare_semantic_search(app: tauri::AppHandle) -> Result<bool, String> {
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
    search::semantic_search(app, query, ids).await
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
        let (bytes, hash) = write_rmp_hashed(&path, entries.as_slice()).unwrap();
        let published = std::fs::read(&path).unwrap();
        assert_eq!(bytes, published.len() as u64);
        assert_eq!(hash, sha256_hex(&published));
        let decoded: Vec<(u64, u32, String)> = rmp_serde::from_slice(&published).unwrap();
        assert_eq!(decoded.len(), 2);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
