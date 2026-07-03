use crate::semantic_core::{
    chunk_text, cosine, dot, index_ram_budget, normalize, shard_est_bytes, SEM_CACHE_BUDGET,
    SEM_MODEL, SEM_QUERY_PREFIX, SEM_VERSION, SHARD_MAX_CHUNKS,
};
use crate::{book, now_ms, search, set_thread_background, AppState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::Manager;
// ===========================================================================
//  语义检索（向量嵌入）：把段落转成向量，按余弦相似度排序，找“意思相近”的文本
// ===========================================================================

/// 语义模型缓存目录（与探针共用，避免运行时再下载）。
fn sem_model_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("models");
    Some(d)
}

#[derive(Serialize, Deserialize)]
struct SemChunk {
    c: u32,    // 章节序号
    t: String, // 段落文本（展示用）
}
#[derive(Serialize, Deserialize)]
struct SemMeta {
    v: u32,
    model: String,
    mtime: u64,
    dim: usize,
    chunks: Vec<SemChunk>,
}
/// 内存里的一本书向量数据：vecs 为扁平的 [chunk0 dim 维][chunk1 …]，已 L2 归一化
pub(crate) struct SemData {
    dim: usize,
    vecs: Vec<f32>,
    chunks: Vec<SemChunk>,
}
#[derive(Default, Clone, Serialize)]
pub(crate) struct SemProgress {
    building: bool,
    done: u32,
    total: u32,
    current: String,
    error: String,
}

// 全库 HNSW 近邻索引：把所有书的向量合到一张图里，查询走近邻、毫秒级。
#[derive(Clone, Serialize, Deserialize)]
struct SemPoint(Vec<f32>);
impl instant_distance::Point for SemPoint {
    fn distance(&self, other: &Self) -> f32 {
        let mut s = 0.0f32;
        let n = self.0.len().min(other.0.len());
        for i in 0..n {
            s += self.0[i] * other.0[i];
        }
        1.0 - s // 归一化向量：余弦距离 = 1 - 点积
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct GlobalEntry {
    b: u64,    // 书 id
    c: u32,    // 章节
    t: String, // 片段
}
type GlobalHnsw = instant_distance::HnswMap<SemPoint, u32>;
#[derive(Serialize, Deserialize)]
struct ShardMeta {
    books: Vec<u64>, // 本分片包含的书（整本归属一片，不跨片）
    chunks: usize,   // 本分片段落数（估算载入内存用）
}
#[derive(Serialize, Deserialize)]
struct GlobalMeta {
    v: u32,
    model: String,
    dim: usize,
    book_ids: Vec<u64>,          // 参与建图的全部书（排序），用于判断是否过期
    source_sig: Vec<(u64, u64)>, // (书 id, 源文件修改时间)，用于判断源文件变更
    shards: Vec<ShardMeta>,      // 各分片描述
}
/// 已载入内存、可供查询的分片集合。
pub(crate) struct LoadedShards {
    graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)>, // 每片：近邻图 + 段落映射
    covered: std::collections::HashSet<u64>,     // 这些分片覆盖到的书；其余的书查询时退回暴力
    book_ids: Vec<u64>,                          // 建图时的全部书集合（判过期）
}

fn global_shard_hnsw_path(k: usize) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("global_{k}.hnsw")))
}
fn global_shard_map_path(k: usize) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("global_{k}.map")))
}
fn global_meta_path() -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join("global.json"))
}

/// 当前已建立语义索引的书 id（排序）。
fn indexed_book_ids(state: &AppState) -> Vec<u64> {
    let lib = state.library.lock().unwrap();
    let mut v: Vec<u64> = lib
        .books
        .iter()
        .filter(|b| b.format != "pdf")
        .map(|b| b.id)
        .filter(|id| sem_meta_path(*id).map(|p| p.exists()).unwrap_or(false))
        .collect();
    v.sort_unstable();
    v
}

fn indexed_book_signature(state: &AppState) -> Vec<(u64, u64)> {
    let lib = state.library.lock().unwrap();
    let mut v: Vec<(u64, u64)> = lib
        .books
        .iter()
        .filter(|b| b.format != "pdf")
        .filter(|b| sem_meta_path(b.id).map(|p| p.exists()).unwrap_or(false))
        .map(|b| (b.id, search::file_mtime(&b.path)))
        .collect();
    v.sort_unstable_by_key(|(id, _)| *id);
    v
}

fn sem_dir() -> Option<std::path::PathBuf> {
    let mut d = dirs::cache_dir()?;
    d.push("ebook-reader");
    d.push("sem");
    Some(d)
}
fn sem_meta_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.json")))
}
fn sem_vec_path(id: u64) -> Option<std::path::PathBuf> {
    Some(sem_dir()?.join(format!("sem_{id}.vec")))
}

/// 懒加载语义模型（首次会下载到 %LOCALAPPDATA%/ebook-reader/models，约 120MB）。
fn get_embedder(state: &AppState) -> Result<Arc<fastembed::TextEmbedding>, String> {
    {
        let g = state.embedder.lock().unwrap();
        if let Some(m) = g.as_ref() {
            return Ok(m.clone());
        }
    }
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let mut opt =
        InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
    if let Some(d) = sem_model_dir() {
        let _ = std::fs::create_dir_all(&d);
        opt = opt.with_cache_dir(d);
    }
    let m = TextEmbedding::try_new(opt).map_err(|e| format!("加载语义模型失败：{e}"))?;
    let arc = Arc::new(m);
    *state.embedder.lock().unwrap() = Some(arc.clone());
    Ok(arc)
}

/// 该书的语义索引是否已是最新（版本/模型/源文件时间都匹配）。
fn sem_is_fresh(id: u64, mtime: u64) -> bool {
    let Some(p) = sem_meta_path(id) else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    match serde_json::from_str::<SemMeta>(&s) {
        Ok(m) => m.v == SEM_VERSION && m.model == SEM_MODEL && m.mtime == mtime,
        Err(_) => false,
    }
}

/// 为一本书建立语义索引：切块 → 批量嵌入（归一化）→ 落盘（.vec 原始 f32 + .json 元信息）。
fn sem_build_book(
    embedder: &fastembed::TextEmbedding,
    id: u64,
    mtime: u64,
    chapters: &[String],
    resume_at: &AtomicU64,
) -> Result<(), String> {
    use std::io::Write;
    let mut items: Vec<(u32, String)> = Vec::new();
    for (ci, text) in chapters.iter().enumerate() {
        for c in chunk_text(text) {
            items.push((ci as u32, c));
        }
    }
    let vec_path = sem_vec_path(id).ok_or("无缓存路径")?;
    if let Some(d) = vec_path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if items.is_empty() {
        let _ = std::fs::write(&vec_path, []);
        let meta = SemMeta {
            v: SEM_VERSION,
            model: SEM_MODEL.to_string(),
            mtime,
            dim: 0,
            chunks: Vec::new(),
        };
        let mp = sem_meta_path(id).ok_or("无缓存路径")?;
        std::fs::write(
            &mp,
            serde_json::to_string(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        return Ok(());
    }
    let mut vf =
        std::io::BufWriter::new(std::fs::File::create(&vec_path).map_err(|e| e.to_string())?);
    let mut meta_chunks: Vec<SemChunk> = Vec::with_capacity(items.len());
    let mut dim = 0usize;
    for batch in items.chunks(128) {
        // 若正在“让路”（用户刚打开阅读窗口），先等到截止时刻，把 CPU 留给窗口冷启动
        loop {
            let r = resume_at.load(Ordering::Relaxed);
            let now = now_ms();
            if now >= r {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis((r - now).min(200)));
        }
        // bge 段落不加前缀，直接用原文
        let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let embs = embedder.embed(inputs, None).map_err(|e| e.to_string())?;
        // 每批后让一小步，给前台留出调度间隙（稳态下也不至于把 8 核占满）
        std::thread::sleep(std::time::Duration::from_millis(6));
        for (k, (c, t)) in batch.iter().enumerate() {
            let mut v = embs[k].clone();
            normalize(&mut v);
            dim = v.len();
            for x in &v {
                vf.write_all(&x.to_le_bytes()).map_err(|e| e.to_string())?;
            }
            meta_chunks.push(SemChunk {
                c: *c,
                t: t.clone(),
            });
        }
    }
    vf.flush().ok();
    let meta = SemMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        mtime,
        dim,
        chunks: meta_chunks,
    };
    let mp = sem_meta_path(id).ok_or("无缓存路径")?;
    std::fs::write(
        &mp,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 取一本书的向量数据（内存缓存 → 否则读 .vec/.json）。
fn get_sem_data(state: &AppState, id: u64) -> Option<Arc<SemData>> {
    {
        let c = state.sem_cache.lock().unwrap();
        if let Some(d) = c.get(&id) {
            return Some(d.clone());
        }
    }
    let meta: SemMeta =
        serde_json::from_str(&std::fs::read_to_string(sem_meta_path(id)?).ok()?).ok()?;
    let bytes = std::fs::read(sem_vec_path(id)?).ok()?;
    let vecs: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let data = Arc::new(SemData {
        dim: meta.dim,
        vecs,
        chunks: meta.chunks,
    });
    let size = data.vecs.len() * 4;
    {
        let mut c = state.sem_cache.lock().unwrap();
        if state.sem_cache_bytes.load(Ordering::Relaxed) + size <= SEM_CACHE_BUDGET {
            c.insert(id, data.clone());
            state.sem_cache_bytes.fetch_add(size, Ordering::Relaxed);
        }
    }
    Some(data)
}

#[derive(Serialize)]
pub(crate) struct SemHit {
    chapter: u32,
    snippet: String,
    score: f32,
}
#[derive(Serialize)]
pub(crate) struct SemBookHits {
    book_id: String,
    title: String,
    author: String,
    score: f32,
    hits: Vec<SemHit>,
}

/// 在一本书里做语义检索，返回该书最相近的前若干段。
fn sem_search_book(state: &AppState, book: &book::Book, q: &[f32]) -> Option<SemBookHits> {
    let id = book.id;
    let data = get_sem_data(state, id)?;
    let dim = data.dim;
    if dim == 0 || data.chunks.is_empty() {
        return None;
    }
    let n = data.chunks.len();
    let mut scored: Vec<(f32, usize)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = &data.vecs[i * dim..(i + 1) * dim];
        scored.push((dot(q, v), i));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored[0].0;
    let hits: Vec<SemHit> = scored
        .iter()
        .take(8)
        .map(|(s, i)| {
            let c = &data.chunks[*i];
            SemHit {
                chapter: c.c,
                snippet: c.t.clone(),
                score: *s,
            }
        })
        .collect();
    Some(SemBookHits {
        book_id: id.to_string(),
        title: book.title.clone(),
        author: book.author.clone(),
        score: best,
        hits,
    })
}

/// 全库分片快速索引是否存在且新鲜（版本/模型/参与书集合都匹配当前已索引的书）。
fn global_index_fresh(state: &AppState) -> bool {
    let Some(p) = global_meta_path() else {
        return false;
    };
    let Ok(s) = std::fs::read_to_string(&p) else {
        return false;
    };
    match serde_json::from_str::<GlobalMeta>(&s) {
        Ok(m) => {
            m.v == SEM_VERSION
                && m.model == SEM_MODEL
                && m.book_ids == indexed_book_ids(state)
                && m.source_sig == indexed_book_signature(state)
        }
        Err(_) => false,
    }
}

/// 给定范围（want=None 表示全库）的语义索引是否“已完整”：每本逐书索引都新鲜；
/// 若是全库范围，还要求分片快速索引也已建好且新鲜。完整则无需重建。
fn semantic_complete(state: &AppState, want: &Option<std::collections::HashSet<u64>>) -> bool {
    let books: Vec<(u64, std::path::PathBuf)> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .map(|b| (b.id, b.path.clone()))
            .collect()
    };
    if books.is_empty() {
        return false;
    }
    if !books
        .iter()
        .all(|(id, path)| sem_is_fresh(*id, search::file_mtime(path)))
    {
        return false;
    }
    if want.is_none() && !global_index_fresh(state) {
        return false; // 全库范围：缺分片快速索引也算没完成
    }
    true
}

/// 查询某范围的语义索引是否已建立完成（供 UI 在点“建立”前判断、避免重复建立）。
#[tauri::command]
pub(crate) fn semantic_index_done(state: tauri::State<AppState>, ids: Option<Vec<String>>) -> bool {
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());
    semantic_complete(state.inner(), &want)
}

/// 后台为全部/选定图书建立语义索引（耗时，逐本进行，可看进度）。
#[tauri::command]
pub(crate) async fn build_semantic_index(
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
    {
        let mut p = state.sem_progress.lock().unwrap();
        if p.building {
            return Err("正在建立索引，请稍候".into());
        }
        *p = SemProgress {
            building: true,
            current: "加载模型…".into(),
            ..Default::default()
        };
    }
    std::thread::spawn(move || {
        set_thread_background(true); // 后台优先级，绝不和前台抢 CPU
        let state = app.state::<AppState>();
        let embedder = match get_embedder(state.inner()) {
            Ok(e) => e,
            Err(err) => {
                let mut p = state.sem_progress.lock().unwrap();
                p.building = false;
                p.error = err;
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
            {
                let mut p = state.sem_progress.lock().unwrap();
                p.done = i as u32;
                p.current = b.title.clone();
            }
            let id = b.id;
            let mtime = search::file_mtime(&b.path);
            if sem_is_fresh(id, mtime) {
                continue;
            }
            match search::get_book_chapters(state.inner(), b) {
                Some(ch) => {
                    if let Err(err) =
                        sem_build_book(&embedder, id, mtime, &ch, &state.index_resume_at)
                    {
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
        let idx_err = build_global_index(state.inner()).err().unwrap_or_default();
        let mut p = state.sem_progress.lock().unwrap();
        p.building = false;
        p.current = if !failures.is_empty() {
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
    });
    Ok(())
}

/// 把一片的向量建图并落盘（global_{k}.hnsw 图 + global_{k}.map 映射）。
fn write_shard(
    k: usize,
    points: Vec<SemPoint>,
    values: Vec<u32>,
    mapping: &[GlobalEntry],
) -> Result<(), String> {
    use std::io::Write;
    let hp = global_shard_hnsw_path(k).ok_or("无缓存路径")?;
    if let Some(d) = hp.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let map: GlobalHnsw = instant_distance::Builder::default().build(points, values);
    let mut f = std::io::BufWriter::new(std::fs::File::create(&hp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut f, &map).map_err(|e| e.to_string())?;
    f.flush().ok();
    let mp = global_shard_map_path(k).ok_or("无缓存路径")?;
    let mut mf = std::io::BufWriter::new(std::fs::File::create(&mp).map_err(|e| e.to_string())?);
    bincode::serialize_into(&mut mf, &mapping).map_err(|e| e.to_string())?;
    mf.flush().ok();
    Ok(())
}

/// 用所有已建索引的书，构建“分片”近邻索引并落盘。一次只建一片→建图内存恒定，
/// 任何机器、任何库大小都不会因此爆内存（再大只是分片更多）。整本书归属同一片，不跨片。
fn build_global_index(state: &AppState) -> Result<(), String> {
    let ids = indexed_book_ids(state);
    // 先清掉旧的全库索引文件（含上一版单图的 global.hnsw/global.map）
    if let Some(d) = sem_dir() {
        if let Ok(rd) = std::fs::read_dir(&d) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().to_string();
                if n.starts_with("global_")
                    || n == "global.hnsw"
                    || n == "global.map"
                    || n == "global.json"
                {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    if ids.is_empty() {
        return Ok(());
    }
    let mut shards: Vec<ShardMeta> = Vec::new();
    let mut dim = 0usize;
    let mut points: Vec<SemPoint> = Vec::new();
    let mut values: Vec<u32> = Vec::new();
    let mut mapping: Vec<GlobalEntry> = Vec::new();
    let mut shard_books: Vec<u64> = Vec::new();
    let mut k = 0usize;
    for id in &ids {
        let Some(data) = get_sem_data(state, *id) else {
            continue;
        };
        if data.dim == 0 {
            continue;
        }
        dim = data.dim;
        // 当前片再加这本会超额 → 先把当前片落盘，开新片
        if !mapping.is_empty() && mapping.len() + data.chunks.len() > SHARD_MAX_CHUNKS {
            let n = mapping.len();
            write_shard(
                k,
                std::mem::take(&mut points),
                std::mem::take(&mut values),
                &mapping,
            )?;
            shards.push(ShardMeta {
                books: std::mem::take(&mut shard_books),
                chunks: n,
            });
            mapping.clear();
            k += 1;
            if let Ok(mut p) = state.sem_progress.lock() {
                p.current = format!("建立加速索引（第 {} 片）…", k + 1);
            }
        }
        for (i, chunk) in data.chunks.iter().enumerate() {
            let v = data.vecs[i * data.dim..(i + 1) * data.dim].to_vec();
            values.push(mapping.len() as u32);
            points.push(SemPoint(v));
            mapping.push(GlobalEntry {
                b: *id,
                c: chunk.c,
                t: chunk.t.clone(),
            });
        }
        shard_books.push(*id);
        // 建图阶段不长期占用逐书缓存，加完即释放
        if let Ok(mut c) = state.sem_cache.lock() {
            if let Some(old) = c.remove(id) {
                state
                    .sem_cache_bytes
                    .fetch_sub(old.vecs.len() * 4, Ordering::Relaxed);
            }
        }
    }
    if !mapping.is_empty() {
        let n = mapping.len();
        write_shard(
            k,
            std::mem::take(&mut points),
            std::mem::take(&mut values),
            &mapping,
        )?;
        shards.push(ShardMeta {
            books: std::mem::take(&mut shard_books),
            chunks: n,
        });
    }
    if shards.is_empty() {
        return Ok(());
    }
    let meta = GlobalMeta {
        v: SEM_VERSION,
        model: SEM_MODEL.to_string(),
        dim,
        book_ids: ids,
        source_sig: indexed_book_signature(state),
        shards,
    };
    std::fs::write(
        global_meta_path().ok_or("无缓存路径")?,
        serde_json::to_string(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    *state.global_index.lock().unwrap() = None; // 让下次查询重新载入
    Ok(())
}

/// 载入（并缓存）分片近邻索引。按内存预算尽量多载入分片；与当前已索引书集合不一致则视为过期。
/// 返回 None 表示无索引/过期/损坏（应整体退回暴力）。
fn load_global_index(state: &AppState) -> Option<Arc<LoadedShards>> {
    {
        let g = state.global_index.lock().unwrap();
        if let Some(a) = g.as_ref() {
            if a.book_ids == indexed_book_ids(state) {
                return Some(a.clone());
            }
        }
    }
    let meta: GlobalMeta =
        serde_json::from_str(&std::fs::read_to_string(global_meta_path()?).ok()?).ok()?;
    if meta.v != SEM_VERSION || meta.model != SEM_MODEL {
        return None;
    }
    if meta.book_ids != indexed_book_ids(state) || meta.source_sig != indexed_book_signature(state)
    {
        return None; // 索引集合变了 → 过期，退回暴力
    }
    let budget = index_ram_budget();
    let mut graphs: Vec<(GlobalHnsw, Vec<GlobalEntry>)> = Vec::new();
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut used: u64 = 0;
    for (k, sh) in meta.shards.iter().enumerate() {
        let est = shard_est_bytes(sh.chunks, meta.dim);
        // 预算用尽就停（但至少载入一片，保证有加速）；其余分片的书查询时退回暴力
        if !graphs.is_empty() && used + est > budget {
            break;
        }
        let map: GlobalHnsw = bincode::deserialize_from(std::io::BufReader::new(
            std::fs::File::open(global_shard_hnsw_path(k)?).ok()?,
        ))
        .ok()?;
        let mapping: Vec<GlobalEntry> = bincode::deserialize_from(std::io::BufReader::new(
            std::fs::File::open(global_shard_map_path(k)?).ok()?,
        ))
        .ok()?;
        for id in &sh.books {
            covered.insert(*id);
        }
        graphs.push((map, mapping));
        used += est;
    }
    if graphs.is_empty() {
        return None;
    }
    let arc = Arc::new(LoadedShards {
        graphs,
        covered,
        book_ids: meta.book_ids,
    });
    *state.global_index.lock().unwrap() = Some(arc.clone());
    Some(arc)
}

/// 在已载入内存的分片上做近邻检索，返回每本书的命中聚合。
fn search_loaded_shards(
    li: &LoadedShards,
    q: &[f32],
    titles: &HashMap<u64, (String, String)>,
) -> Vec<SemBookHits> {
    let qp = SemPoint(q.to_vec());
    let mut per: HashMap<u64, Vec<SemHit>> = HashMap::new();
    let mut best: HashMap<u64, f32> = HashMap::new();
    for (graph, mapping) in &li.graphs {
        let mut search = instant_distance::Search::default();
        for item in graph.search(&qp, &mut search).take(400) {
            let gid = *item.value as usize;
            let Some(e) = mapping.get(gid) else { continue };
            let sim = 1.0 - item.distance;
            let v = per.entry(e.b).or_default();
            if v.len() < 8 {
                v.push(SemHit {
                    chapter: e.c,
                    snippet: e.t.clone(),
                    score: sim,
                });
            }
            let bb = best.entry(e.b).or_insert(sim);
            if sim > *bb {
                *bb = sim;
            }
        }
    }
    per.into_iter()
        .map(|(id, hits)| {
            let (title, author) = titles.get(&id).cloned().unwrap_or_default();
            SemBookHits {
                book_id: id.to_string(),
                title,
                author,
                score: *best.get(&id).unwrap_or(&0.0),
                hits,
            }
        })
        .collect()
}

/// 对一组书做并行暴力语义检索（无近邻图、或分片没覆盖到的书走这里）。
fn brute_force_books(state: &AppState, targets: &[book::Book], q: &[f32]) -> Vec<SemBookHits> {
    if targets.is_empty() {
        return Vec::new();
    }
    let qref: &[f32] = q;
    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4)
        .max(1);
    let chunk_size = targets.len().div_ceil(nthreads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    let mut out = Vec::new();
                    for b in chunk {
                        if let Some(h) = sem_search_book(state, b, qref) {
                            out.push(h);
                        }
                    }
                    out
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

/// 查询建立语义索引的进度。
#[tauri::command]
pub(crate) fn semantic_status(state: tauri::State<AppState>) -> SemProgress {
    state.sem_progress.lock().unwrap().clone()
}

/// 语义检索：把查询转成向量，在已建索引的图书里按相似度排序返回。
#[tauri::command]
pub(crate) async fn semantic_search(
    state: tauri::State<'_, AppState>,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let embedder = get_embedder(state.inner())?;
    let mut q = embedder
        .embed(vec![format!("{SEM_QUERY_PREFIX}{query}")], None)
        .map_err(|e| e.to_string())?
        .remove(0);
    normalize(&mut q);

    let st: &AppState = state.inner();
    let want: Option<std::collections::HashSet<u64>> =
        ids.map(|v| v.iter().filter_map(|s| s.parse::<u64>().ok()).collect());

    // 全库查询：已载入的分片走近邻（毫秒级）；分片没覆盖到的书（内存装不下/未建索引）退回暴力，合并。
    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut results: Vec<SemBookHits> = Vec::new();
    if want.is_none() {
        if let Some(li) = load_global_index(st) {
            let titles: HashMap<u64, (String, String)> = {
                let lib = st.library.lock().unwrap();
                lib.books
                    .iter()
                    .map(|b| (b.id, (b.title.clone(), b.author.clone())))
                    .collect()
            };
            covered = li.covered.clone();
            results.extend(search_loaded_shards(&li, &q, &titles));
        }
    }

    // 需要暴力的书：限定集合内（或全库）中，已建索引、且未被已载入分片覆盖的书
    let targets: Vec<book::Book> = {
        let lib = st.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|b| b.format != "pdf")
            .filter(|b| want.as_ref().map(|w| w.contains(&b.id)).unwrap_or(true))
            .filter(|b| !covered.contains(&b.id))
            .filter(|b| sem_meta_path(b.id).map(|p| p.exists()).unwrap_or(false))
            .cloned()
            .collect()
    };
    results.extend(brute_force_books(st, &targets, &q));

    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(60);
    Ok(results)
}

/// 余弦相似度

/// 验证嵌入运行时是否可用 + 语义质量。结果写到 %LOCALAPPDATA%/ebook-reader/sem_probe.txt。
fn sem_probe_file() -> std::path::PathBuf {
    let mut d = dirs::cache_dir().unwrap_or(std::env::temp_dir());
    d.push("ebook-reader");
    let _ = std::fs::create_dir_all(&d);
    d.push("sem_probe.txt");
    d
}
fn sem_probe_write(s: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(sem_probe_file())
    {
        let _ = writeln!(f, "{s}");
    }
}
pub(crate) fn sem_probe() {
    use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
    let _ = std::fs::remove_file(sem_probe_file());
    // 把任何 panic 写进文件（窗口子系统下没有控制台）
    std::panic::set_hook(Box::new(|info| {
        sem_probe_write(&format!("PANIC: {info}"));
    }));
    let run = std::panic::catch_unwind(|| {
        sem_probe_write("starting...");
        let mut opt =
            InitOptions::new(EmbeddingModel::BGESmallZHV15).with_show_download_progress(false);
        if let Some(d) = sem_model_dir() {
            let _ = std::fs::create_dir_all(&d);
            opt = opt.with_cache_dir(d);
        }
        let model = TextEmbedding::try_new(opt).map_err(|e| format!("MODEL ERR: {e}"))?;
        sem_probe_write("model loaded, embedding...");
        let texts = vec![
            format!("{SEM_QUERY_PREFIX}高兴"),
            "开心".to_string(),
            "万念俱灰".to_string(),
            "木头桌子".to_string(),
        ];
        let e = model
            .embed(texts, None)
            .map_err(|e| format!("EMBED ERR: {e}"))?;
        sem_probe_write(&format!(
            "OK dim={} 高兴~开心={:.3} 高兴~万念俱灰={:.3} 高兴~桌子={:.3}",
            e[0].len(),
            cosine(&e[0], &e[1]),
            cosine(&e[0], &e[2]),
            cosine(&e[0], &e[3]),
        ));
        Ok::<(), String>(())
    });
    match run {
        Ok(Ok(())) => {}
        Ok(Err(msg)) => sem_probe_write(&msg),
        Err(_) => sem_probe_write("CAUGHT PANIC (see above)"),
    }
}

/// 验证 instant-distance（HNSW 近邻索引）API：建图 → 序列化 → 反序列化 → 查询。
pub(crate) fn hnsw_probe() {
    use instant_distance::{Builder, HnswMap, Point, Search};
    #[derive(Clone, Serialize, Deserialize)]
    struct V(Vec<f32>);
    impl Point for V {
        fn distance(&self, other: &Self) -> f32 {
            let mut s = 0.0f32;
            for i in 0..self.0.len().min(other.0.len()) {
                s += self.0[i] * other.0[i];
            }
            1.0 - s // 归一化向量：余弦距离 = 1 - 点积
        }
    }
    let write = |s: &str| {
        let mut d = dirs::cache_dir().unwrap_or(std::env::temp_dir());
        d.push("ebook-reader");
        let _ = std::fs::create_dir_all(&d);
        d.push("hnsw_probe.txt");
        let _ = std::fs::write(&d, s);
    };
    let pts = vec![
        V(vec![1.0, 0.0, 0.0]),
        V(vec![0.0, 1.0, 0.0]),
        V(vec![0.0, 0.0, 1.0]),
        V(vec![0.9, 0.1, 0.0]),
    ];
    let vals: Vec<u32> = vec![10, 11, 12, 13];
    let map: HnswMap<V, u32> = Builder::default().build(pts, vals);
    let bytes = match bincode::serialize(&map) {
        Ok(b) => b,
        Err(e) => {
            write(&format!("SER ERR: {e}"));
            return;
        }
    };
    let map2: HnswMap<V, u32> = match bincode::deserialize(&bytes) {
        Ok(m) => m,
        Err(e) => {
            write(&format!("DE ERR: {e}"));
            return;
        }
    };
    let q = V(vec![0.95, 0.05, 0.0]);
    let mut search = Search::default();
    let mut got = Vec::new();
    for item in map2.search(&q, &mut search).take(2) {
        got.push((*item.value, item.distance));
    }
    write(&format!("OK bytes={} top={:?}", bytes.len(), got));
}
