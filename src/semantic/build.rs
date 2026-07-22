use super::model::{active as active_semantic_model, embedder as get_embedder};
use super::{
    accelerator, batch, clear_sem_profile_cache, clear_sem_query_cache, clear_sem_status_cache,
    profile, status, vector,
};
use crate::semantic_core::{chunk_text, normalize};
use crate::semantic_tasks::{begin_semantic_task, finish_semantic_task};
use crate::{book, now_ms, search, AppState};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::Manager;

/// 单本构建被用户取消时返回的内部标记。调用方据此停止整个任务，而不是把
/// 正在构建的书误记为失败。
const SEM_BUILD_PAUSED: &str = "__semantic_build_paused__";
const SEM_BUILD_CANCELLED: &str = "__semantic_build_cancelled__";
const CHECKPOINT_PERSISTENCE_FAILED: &str = "保存任务检查点失败";

fn abort_for_checkpoint_failure(
    state: &AppState,
    task: crate::background_tasks::TaskRunGuard,
    error: impl Into<String>,
) {
    let error = error.into();
    let message = if error.starts_with(CHECKPOINT_PERSISTENCE_FAILED) {
        error
    } else {
        format!("{CHECKPOINT_PERSISTENCE_FAILED}：{error}")
    };
    finish_semantic_task(state, message.clone(), Some(message.clone()));
    let _ = task.fail(message);
}

fn sem_build_control(
    pause_requested: &AtomicBool,
    task: Option<&crate::background_tasks::TaskRunGuard>,
) -> Result<(), &'static str> {
    if pause_requested.load(Ordering::Acquire) {
        return Err(SEM_BUILD_PAUSED);
    }
    match task.map(|task| task.control_signal()) {
        Some(crate::background_tasks::TaskControlSignal::Pause) => Err(SEM_BUILD_PAUSED),
        Some(crate::background_tasks::TaskControlSignal::Cancel) => Err(SEM_BUILD_CANCELLED),
        _ => Ok(()),
    }
}

/// 语义向量按“书”落盘；暂停时丢弃当前书的隐藏临时文件，已完成书保持可用。
static SEM_VECTOR_PAUSE_REQUESTED: AtomicBool = AtomicBool::new(false);

fn sem_vec_path(id: u64) -> Option<std::path::PathBuf> {
    vector::vector_path(id)
}

/// 未完成书籍只写入隐藏临时文件，容量统计与检索都不会将它当作已建索引。
fn sem_build_temp_vec_path(id: u64) -> Option<std::path::PathBuf> {
    vector::build_temp_path(id)
}

/// 该书的语义索引是否已是最新（版本/模型/源文件时间都匹配）。
fn sem_is_fresh(book: &book::Book) -> bool {
    vector::is_complete(book)
}

fn sem_index_done_for_book(book: &book::Book) -> bool {
    vector::is_complete(book)
}

/// 为一本书建立语义索引：切块 → 批量嵌入（归一化）→ 落盘（.vec 原始 f32 + .json 元信息）。
struct SemBuildBookInput<'a> {
    id: u64,
    mtime: u64,
    source_id: &'a str,
    source_bytes: u64,
    chapters: &'a [String],
}

fn sem_build_book(
    embedder: &Mutex<fastembed::TextEmbedding>,
    input: SemBuildBookInput<'_>,
    resume_at: &AtomicU64,
    pause_requested: &AtomicBool,
    task: Option<&crate::background_tasks::TaskRunGuard>,
) -> Result<(), String> {
    let SemBuildBookInput {
        id,
        mtime,
        source_id,
        source_bytes,
        chapters,
    } = input;
    let mut items: Vec<(u32, String)> = Vec::new();
    for (ci, text) in chapters.iter().enumerate() {
        sem_build_control(pause_requested, task)?;
        for c in chunk_text(text) {
            items.push((ci as u32, c));
        }
    }
    let vec_path = sem_vec_path(id).ok_or("无缓存路径")?;
    if let Some(d) = vec_path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    sem_build_control(pause_requested, task)?;
    if items.is_empty() {
        crate::atomic_file::write(&vec_path, &[])?;
        profile::discard_single(id);
        vector::publish_metadata(
            id,
            vector::Publication::empty(mtime, source_id, source_bytes),
        )?;
        return Ok(());
    }
    // 保留上一代完整索引，直到新向量已完整写入并同步。暂停或进程异常只删除
    // 当前隐藏临时文件，不能再把原本可用的旧索引一起删掉。
    let temp_vec_path = sem_build_temp_vec_path(id).ok_or("无缓存路径")?;
    let _ = std::fs::remove_file(&temp_vec_path);
    let mut vf =
        std::io::BufWriter::new(std::fs::File::create(&temp_vec_path).map_err(|e| e.to_string())?);
    let mut vector_hasher = Sha256::new();
    let mut meta_chunks: Vec<vector::Chunk> = Vec::with_capacity(items.len());
    let mut dim = 0usize;
    let mut profile_acc: Vec<f32> = Vec::new();
    let mut profile_count = 0usize;
    let mut batch_size = batch::AdaptiveBatch::for_model(active_semantic_model().dimensions());
    let mut offset = 0usize;
    // 一次推理无法在中间强杀；自适应小批次限制暂停延迟，并在内存不足时缩批
    // 重试同一段，不丢弃已经完整写入本书临时文件的前序批次。
    while offset < items.len() {
        if let Err(interrupted) = sem_build_control(pause_requested, task) {
            let _ = std::fs::remove_file(&temp_vec_path);
            return Err(interrupted.into());
        }
        let batch_len = batch_size.current().min(items.len() - offset);
        let batch = &items[offset..offset + batch_len];
        // 若正在“让路”（用户刚打开阅读窗口），先等到截止时刻，把 CPU 留给窗口冷启动
        loop {
            if let Err(interrupted) = sem_build_control(pause_requested, task) {
                let _ = std::fs::remove_file(&temp_vec_path);
                return Err(interrupted.into());
            }
            let r = resume_at.load(Ordering::Relaxed);
            let now = now_ms();
            if now >= r {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis((r - now).min(200)));
        }
        // bge 段落不加前缀，直接用原文
        let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let embs = match embedder
            .lock()
            .map_err(|_| "语义模型锁定失败".to_string())?
            .embed(inputs, None)
        {
            Ok(embeddings) => embeddings,
            Err(err) => {
                let error = err.to_string();
                if batch_size.shrink_for_error(&error) {
                    crate::log(&format!(
                        "semantic_embed retry=true book={id} offset={offset} batch={} next_batch={} backend={} error={error}",
                        batch_len,
                        batch_size.current(),
                                "CPU"
                    ));
                    if let Some(task) = task {
                        let _ = task.log(
                            crate::background_tasks::TaskLogLevel::Warning,
                            format!(
                                "显存/内存不足，批量由 {batch_len} 降至 {} 后重试",
                                batch_size.current()
                            ),
                        );
                    }
                    continue;
                }
                let _ = std::fs::remove_file(&temp_vec_path);
                return Err(error);
            }
        };
        if embs.len() != batch.len() {
            let _ = std::fs::remove_file(&temp_vec_path);
            return Err(format!(
                "语义模型返回数量异常：输入 {} 段，输出 {} 个向量",
                batch.len(),
                embs.len()
            ));
        }
        // ONNX 的一次 batch 调用无法被抢占；一返回就丢弃这批结果并立即暂停。
        if let Err(interrupted) = sem_build_control(pause_requested, task) {
            let _ = std::fs::remove_file(&temp_vec_path);
            return Err(interrupted.into());
        }
        // 每批后让一小步，给前台留出调度间隙（稳态下也不至于把 8 核占满）
        std::thread::sleep(std::time::Duration::from_millis(6));
        for (k, (c, t)) in batch.iter().enumerate() {
            let mut v = embs[k].clone();
            normalize(&mut v);
            dim = v.len();
            if profile_acc.is_empty() {
                profile_acc.resize(dim, 0.0);
            }
            if profile_acc.len() == dim {
                for (dst, src) in profile_acc.iter_mut().zip(v.iter()) {
                    *dst += *src;
                }
                profile_count += 1;
            }
            for x in &v {
                let encoded = x.to_le_bytes();
                vf.write_all(&encoded).map_err(|e| e.to_string())?;
                vector_hasher.update(encoded);
            }
            meta_chunks.push(vector::Chunk::new(*c, t.clone()));
        }
        offset += batch_len;
        batch_size.record_success();
        if let Some(task) = task {
            task.update_progress(
                offset as u64,
                items.len() as u64,
                format!("正在编码第 {offset}/{} 段", items.len()),
            )
            .map_err(|error| format!("更新任务进度失败：{error}"))?;
        }
    }
    vf.flush().map_err(|e| e.to_string())?;
    vf.get_ref().sync_all().map_err(|e| e.to_string())?;
    drop(vf);
    if let Err(interrupted) = sem_build_control(pause_requested, task) {
        let _ = std::fs::remove_file(&temp_vec_path);
        return Err(interrupted.into());
    }
    let profile = if profile_count > 0 && profile_acc.len() == dim {
        let inv = 1.0f32 / profile_count as f32;
        for v in &mut profile_acc {
            *v *= inv;
        }
        normalize(&mut profile_acc);
        Some(profile_acc)
    } else {
        None
    };
    if let Err(interrupted) = sem_build_control(pause_requested, task) {
        let _ = std::fs::remove_file(&temp_vec_path);
        return Err(interrupted.into());
    }
    let vector_bytes = std::fs::metadata(&temp_vec_path)
        .map_err(|e| e.to_string())?
        .len();
    let expected_bytes = (dim as u64)
        .checked_mul(meta_chunks.len() as u64)
        .and_then(|value| value.checked_mul(4))
        .ok_or("语义向量长度溢出")?;
    if vector_bytes != expected_bytes {
        let _ = std::fs::remove_file(&temp_vec_path);
        return Err(format!(
            "语义向量长度不完整：期望 {expected_bytes} 字节，实际 {vector_bytes} 字节"
        ));
    }
    let vector_sha256 = vector_hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    crate::atomic_file::commit_temp_file(&temp_vec_path, &vec_path)?;
    if let Some(profile) = profile {
        profile::write_single(id, mtime, dim, profile_count, &profile)?;
    }
    vector::publish_metadata(
        id,
        vector::Publication::populated(
            mtime,
            source_id,
            source_bytes,
            dim,
            meta_chunks,
            vector_bytes,
            vector_sha256,
        ),
    )?;
    Ok(())
}

/// 给定范围（want=None 表示全库）的语义索引是否“已完整”：每本逐书索引都新鲜；
/// 若是全库范围，还要求分片快速索引也已建好且新鲜。完整则无需重建。
fn semantic_complete(state: &AppState, want: &Option<std::collections::HashSet<u64>>) -> bool {
    let books: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .cloned()
            .collect()
    };
    if books.is_empty() {
        return false;
    }
    if !books.iter().all(sem_index_done_for_book) {
        return false;
    }
    if want.is_none() && !accelerator::global_index_fresh(state) {
        return false; // 全库范围：缺分片快速索引也算没完成
    }
    true
}

/// 查询某范围的语义索引是否已建立完成（供 UI 在点“建立”前判断、避免重复建立）。
pub(super) fn semantic_index_done(state: tauri::State<AppState>, ids: Option<Vec<String>>) -> bool {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    semantic_complete(state.inner(), &want)
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
pub(super) async fn build_semantic_index(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> Result<(), String> {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    // 已是最新（每本都新鲜 + 全库分片图新鲜）→ 不重建，直接报“已完成”
    if semantic_complete(state.inner(), &want) {
        let mut p = state.sem_progress.lock().unwrap();
        if !p.building {
            p.error = String::new();
            p.current = "语义索引已是最新，无需重建".into();
        }
        return Ok(());
    }
    let task_handle = begin_semantic_task(state.inner(), "semantic_full", "加载模型…", false)?;
    SEM_VECTOR_PAUSE_REQUESTED.store(false, Ordering::Release);
    let worker_app = app.clone();
    if let Err(error) = task_handle.spawn_detached("semantic-full-index", move |task| {
        let state = worker_app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                finish_semantic_task(state.inner(), "语义索引未启动", Some(err.clone()));
                let _ = task.fail(err);
                return;
            }
        };
        let books: Vec<book::Book> = {
            state
                .library
                .lock()
                .unwrap()
                .books
                .iter()
                .filter(|b| b.format != "pdf")
                .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
                .cloned()
                .collect()
        };
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.total = books.len() as u32;
        }
        let mut failures: Vec<String> = Vec::new();
        for (i, b) in books.iter().enumerate() {
            match task.control_signal() {
                crate::background_tasks::TaskControlSignal::Pause => {
                    finish_semantic_task(state.inner(), "语义索引已暂停，可续建", None);
                    let _ = task.pause();
                    return;
                }
                crate::background_tasks::TaskControlSignal::Cancel => {
                    finish_semantic_task(state.inner(), "语义索引已取消", None);
                    let _ = task.cancel();
                    return;
                }
                crate::background_tasks::TaskControlSignal::Continue => {}
            }
            if let Err(error) = task.checkpoint(
                i as u64,
                books.len() as u64,
                b.title.clone(),
                format!(r#"{{"book_id":{},"book_index":{i}}}"#, b.id),
            ) {
                abort_for_checkpoint_failure(state.inner(), task, error);
                return;
            }
            {
                let mut p = state.sem_progress.lock().unwrap();
                p.done = i as u32;
                p.current = b.title.clone();
            }
            let id = b.id;
            let mtime = search::file_mtime(&b.path);
            if sem_is_fresh(b) {
                if profile::read_single(id, mtime).is_none()
                    && profile::read_or_backfill(state.inner(), b).is_none()
                {
                    failures.push(format!("{}：无法生成相似图书缓存", b.title));
                }
                continue;
            }
            match search::get_book_chapters(state.inner(), b) {
                Some(ch) => {
                    if let Err(err) = sem_build_book(
                        &embedder,
                        SemBuildBookInput {
                            id,
                            mtime,
                            source_id: &b.content_id,
                            source_bytes: vector::source_bytes(b),
                            chapters: &ch,
                        },
                        &state.index_resume_at,
                        &SEM_VECTOR_PAUSE_REQUESTED,
                        Some(&task),
                    ) {
                        if err == SEM_BUILD_PAUSED {
                            finish_semantic_task(state.inner(), "语义索引已暂停，可续建", None);
                            let _ = task.pause();
                            return;
                        }
                        if err == SEM_BUILD_CANCELLED {
                            finish_semantic_task(state.inner(), "语义索引已取消", None);
                            let _ = task.cancel();
                            return;
                        }
                        if err.starts_with(CHECKPOINT_PERSISTENCE_FAILED) {
                            abort_for_checkpoint_failure(state.inner(), task, err);
                            return;
                        }
                        failures.push(format!("{}：{}", b.title, err));
                    }
                }
                None => failures.push(format!("{}：无法读取正文", b.title)),
            }
        }
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.done = p.total;
            p.current = "建立加速索引（分片）…".into();
        }
        // 注意：加速索引建不成「不算失败」——逐书向量已就绪、检索照常可用，只是慢一点。
        // 因此这里绝不写 p.error（p.error 只留给模型加载等真正的失败）。
        let idx_err = accelerator::build_global_index(state.inner(), Some(&task))
            .err()
            .unwrap_or_default();
        clear_sem_query_cache();
        if idx_err == accelerator::PAUSED {
            finish_semantic_task(state.inner(), "加速索引已暂停，可续建", None);
            let _ = task.pause();
            return;
        }
        if idx_err == accelerator::CANCELLED {
            finish_semantic_task(state.inner(), "加速索引已取消，可从检查点重建", None);
            let _ = task.cancel();
            return;
        }
        let current = if !failures.is_empty() {
            format!(
                "完成（{} 本未建立索引；{}）",
                failures.len(),
                failures
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("；")
            )
        } else if idx_err.is_empty() {
            "完成".into()
        } else {
            format!("完成（检索可用；加速索引未建成：{idx_err}）")
        };
        let error = (!idx_err.is_empty()).then_some(format!("加速索引未建成：{idx_err}"));
        finish_semantic_task(state.inner(), current, error.clone());
        if let Some(error) = error {
            let _ = task.fail(error);
        } else {
            if !failures.is_empty() {
                let _ = task.log(
                    crate::background_tasks::TaskLogLevel::Warning,
                    format!("{} 本图书未建立向量", failures.len()),
                );
            }
            let _ = task.complete();
        }
    }) {
        finish_semantic_task(
            app.state::<AppState>().inner(),
            "语义索引未启动",
            Some(error.clone()),
        );
        return Err(error);
    }
    Ok(())
}

fn finish_vector_pause(state: &AppState, done: u32, total: u32) {
    let mut p = state.sem_progress.lock().unwrap();
    p.done = done;
    p.total = total;
    p.semantic_done = done;
    p.semantic_total = total;
    p.semantic_bytes = status::semantic_index_bytes();
    p.building = false;
    p.active_task.clear();
    p.background_task_id.clear();
    p.vector_pause_requested = false;
    p.vector_paused = true;
    p.current = "语义索引已暂停；可从未完成图书继续建立".into();
    p.error.clear();
}

fn update_vector_book_progress(state: &AppState, done: u32, total: u32, current: String) {
    let mut p = state.sem_progress.lock().unwrap();
    p.done = done;
    p.total = total;
    p.semantic_done = done;
    p.semantic_total = total;
    p.semantic_ready = total > 0 && done == total;
    // 只统计已经完整落盘的 sem_ 文件；当前书的隐藏临时文件不会显示在容量中。
    p.semantic_bytes = status::semantic_index_bytes();
    p.current = current;
}

pub(super) async fn build_semantic_vectors(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let task_handle = begin_semantic_task(state.inner(), "semantic_vectors", "加载模型…", false)?;
    // 只有新任务真正开始时才清空旧暂停标记，避免无效的重复“建立”请求
    // 抵消用户刚点下的暂停。
    SEM_VECTOR_PAUSE_REQUESTED.store(false, Ordering::Release);
    let worker_app = app.clone();
    if let Err(error) = task_handle.spawn_detached("semantic-vectors", move |task| {
        let state = worker_app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                finish_semantic_task(state.inner(), "语义索引未启动", Some(err.clone()));
                let _ = task.fail(err);
                return;
            }
        };
        let books: Vec<book::Book> = {
            state
                .library
                .lock()
                .unwrap()
                .books
                .iter()
                .filter(|b| b.format != "pdf")
                .cloned()
                .collect()
        };
        {
            let mut p = state.sem_progress.lock().unwrap();
            p.total = books.len() as u32;
        }
        let total = books.len() as u32;
        let mut completed = 0u32;
        let mut failures: Vec<String> = Vec::new();
        for b in &books {
            let control = task.control_signal();
            if SEM_VECTOR_PAUSE_REQUESTED.load(Ordering::Acquire)
                || control == crate::background_tasks::TaskControlSignal::Pause
            {
                finish_vector_pause(state.inner(), completed, total);
                clear_sem_query_cache();
                clear_sem_profile_cache();
                clear_sem_status_cache();
                let _ = task.pause();
                return;
            }
            if control == crate::background_tasks::TaskControlSignal::Cancel {
                finish_semantic_task(state.inner(), "语义索引已取消", None);
                clear_sem_query_cache();
                clear_sem_profile_cache();
                clear_sem_status_cache();
                let _ = task.cancel();
                return;
            }
            if let Err(error) = task.checkpoint(
                completed as u64,
                total as u64,
                b.title.clone(),
                format!(r#"{{"book_id":{},"completed":{completed}}}"#, b.id),
            ) {
                abort_for_checkpoint_failure(state.inner(), task, error);
                return;
            }
            update_vector_book_progress(state.inner(), completed, total, b.title.clone());
            let id = b.id;
            let mtime = search::file_mtime(&b.path);
            if sem_is_fresh(b) {
                if profile::read_single(id, mtime).is_none()
                    && profile::read_or_backfill(state.inner(), b).is_none()
                {
                    failures.push(format!("{}：无法生成相似图书缓存", b.title));
                } else if sem_index_done_for_book(b) {
                    completed += 1;
                }
                update_vector_book_progress(state.inner(), completed, total, b.title.clone());
                continue;
            }
            match search::get_book_chapters(state.inner(), b) {
                Some(ch) => {
                    match sem_build_book(
                        &embedder,
                        SemBuildBookInput {
                            id,
                            mtime,
                            source_id: &b.content_id,
                            source_bytes: vector::source_bytes(b),
                            chapters: &ch,
                        },
                        &state.index_resume_at,
                        &SEM_VECTOR_PAUSE_REQUESTED,
                        Some(&task),
                    ) {
                        Ok(()) if sem_index_done_for_book(b) => completed += 1,
                        Ok(()) => failures.push(format!("{}：索引文件未完整写入", b.title)),
                        Err(err) if err == SEM_BUILD_PAUSED => {
                            finish_vector_pause(state.inner(), completed, total);
                            clear_sem_query_cache();
                            clear_sem_profile_cache();
                            clear_sem_status_cache();
                            let _ = task.pause();
                            return;
                        }
                        Err(err) if err == SEM_BUILD_CANCELLED => {
                            finish_semantic_task(state.inner(), "语义索引已取消", None);
                            clear_sem_query_cache();
                            clear_sem_profile_cache();
                            clear_sem_status_cache();
                            let _ = task.cancel();
                            return;
                        }
                        Err(err) if err.starts_with(CHECKPOINT_PERSISTENCE_FAILED) => {
                            abort_for_checkpoint_failure(state.inner(), task, err);
                            return;
                        }
                        Err(err) => failures.push(format!("{}：{}", b.title, err)),
                    }
                }
                None => failures.push(format!("{}：无法读取正文", b.title)),
            }
            update_vector_book_progress(state.inner(), completed, total, b.title.clone());
        }
        let mut p = state.sem_progress.lock().unwrap();
        p.done = completed;
        p.semantic_done = completed;
        p.semantic_total = total;
        p.semantic_ready = total > 0 && completed == total;
        p.semantic_bytes = status::semantic_index_bytes();
        p.building = false;
        p.active_task.clear();
        p.background_task_id.clear();
        p.vector_pause_requested = false;
        p.vector_paused = false;
        clear_sem_query_cache();
        clear_sem_profile_cache();
        p.current = if failures.is_empty() {
            "语义索引完成".into()
        } else {
            format!(
                "语义索引完成（{} 本失败；{}）",
                failures.len(),
                failures
                    .iter()
                    .take(3)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join("；")
            )
        };
        drop(p);
        clear_sem_status_cache();
        if failures.is_empty() {
            let _ = task.complete();
        } else {
            let message = format!("{} 本图书索引失败", failures.len());
            let _ = task.log(crate::background_tasks::TaskLogLevel::Warning, message);
            let _ = task.complete();
        }
    }) {
        finish_semantic_task(
            app.state::<AppState>().inner(),
            "语义索引未启动",
            Some(error.clone()),
        );
        return Err(error);
    }
    Ok(())
}

/// 请求暂停当前语义向量构建。正在执行的 ONNX 单批推理返回后立刻丢弃该批和
/// 当前书的临时文件；已完整落盘的书在“续建”时会被自动跳过。
pub(super) fn pause_semantic_vectors(state: tauri::State<AppState>) -> Result<(), String> {
    let mut p = state.sem_progress.lock().unwrap();
    if !p.building || p.active_task != "semantic_vectors" {
        return Err("当前没有可暂停的语义索引任务".into());
    }
    if p.vector_pause_requested {
        return Ok(());
    }
    SEM_VECTOR_PAUSE_REQUESTED.store(true, Ordering::Release);
    if !p.background_task_id.is_empty() {
        let _ = state.background_tasks.request_pause(&p.background_task_id);
    }
    p.vector_pause_requested = true;
    p.current = "正在取消当前图书的未完成索引…".into();
    p.error.clear();
    clear_sem_status_cache();
    Ok(())
}

pub(super) async fn build_semantic_accelerator(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let task_handle = begin_semantic_task(
        state.inner(),
        "semantic_accelerator",
        "准备建立加速索引…",
        false,
    )?;
    let worker_app = app.clone();
    if let Err(error) = task_handle.spawn_detached("semantic-accelerator", move |task| {
        let state = worker_app.state::<AppState>();
        if accelerator::indexed_book_ids(state.inner()).is_empty() {
            finish_semantic_task(state.inner(), "请先建立语义索引", None);
            let _ = task.complete();
            return;
        }
        let idx_err = accelerator::build_global_index(state.inner(), Some(&task))
            .err()
            .unwrap_or_default();
        clear_sem_query_cache();
        if idx_err == accelerator::PAUSED {
            finish_semantic_task(state.inner(), "加速索引已暂停，可续建", None);
            let _ = task.pause();
            return;
        }
        if idx_err == accelerator::CANCELLED {
            finish_semantic_task(state.inner(), "加速索引已取消，可从检查点重建", None);
            let _ = task.cancel();
            return;
        }
        let (current, error) = if idx_err.is_empty() {
            ("加速索引完成".to_string(), None)
        } else {
            (
                format!("加速索引未建成：{idx_err}"),
                Some(format!("加速索引未建成：{idx_err}")),
            )
        };
        finish_semantic_task(state.inner(), current, error.clone());
        if let Some(error) = error {
            let _ = task.fail(error);
        } else {
            let _ = task.complete();
        }
    }) {
        finish_semantic_task(
            app.state::<AppState>().inner(),
            "加速索引未启动",
            Some(error.clone()),
        );
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_pause_interrupts_a_book_without_a_task_guard() {
        let pause_requested = AtomicBool::new(false);
        assert_eq!(sem_build_control(&pause_requested, None), Ok(()));
        pause_requested.store(true, Ordering::Release);
        assert_eq!(
            sem_build_control(&pause_requested, None),
            Err(SEM_BUILD_PAUSED)
        );
    }

    #[test]
    fn book_publication_keeps_hidden_temp_and_atomic_commit_order() {
        let source = include_str!("build.rs");
        let create = source
            .find("std::fs::File::create(&temp_vec_path)")
            .expect("book build must start in a hidden temp vector");
        let sync = source
            .find("vf.get_ref().sync_all()")
            .expect("temp vector must be durable before publication");
        let commit = source
            .find("atomic_file::commit_temp_file(&temp_vec_path, &vec_path)")
            .expect("book build must publish by atomic rename");
        let metadata = commit
            + source[commit..]
                .find("vector::publish_metadata(")
                .expect("metadata must be published after the vector");
        assert!(create < sync && sync < commit && commit < metadata);
        let book_build = &source[create..source.find("fn semantic_complete(").unwrap()];
        assert!(book_build.contains("task.update_progress("));
        assert!(!book_build.contains("task.checkpoint("));
        let task_builders = &source
            [source.find("fn semantic_complete(").unwrap()..source.find("#[cfg(test)]").unwrap()];
        assert!(task_builders.matches("task.checkpoint(").count() >= 2);
    }

    #[test]
    fn build_implementation_stays_out_of_the_parent_module() {
        let parent = include_str!("../semantic.rs");
        for forbidden in [
            "struct SemBuildBookInput",
            "fn sem_build_control(",
            "fn sem_build_book(",
            "fn semantic_complete(",
            "fn finish_vector_pause(",
            "fn update_vector_book_progress(",
            "SEM_VECTOR_PAUSE_REQUESTED",
        ] {
            assert!(
                !parent.contains(forbidden),
                "semantic build boundary regressed: {forbidden}"
            );
        }
        for route in [
            "build::semantic_index_done",
            "build::build_semantic_index",
            "build::build_semantic_vectors",
            "build::pause_semantic_vectors",
            "build::build_semantic_accelerator",
        ] {
            assert!(parent.contains(route), "missing command route: {route}");
        }
    }
}
