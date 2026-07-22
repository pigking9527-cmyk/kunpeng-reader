use super::model::{
    available as semantic_model_available, embedder as get_embedder,
    query_input as semantic_query_input, SEMANTIC_MODEL_MISSING,
};
use super::{accelerator, profile, vector, SemData};
use crate::semantic_core::{dot, normalize};
use crate::{
    book, interactive_search_workers, set_thread_background, with_thread_background_priority,
    AppState,
};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::Manager;

static SEM_QUERY_CACHE: OnceLock<Mutex<SemQueryCache>> = OnceLock::new();
static SEM_EMBED_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SEM_QUERY_ACTIVE: AtomicUsize = AtomicUsize::new(0);
static SEM_MODEL_WARMING: AtomicBool = AtomicBool::new(false);
// 全局图尚未载入或只覆盖部分书籍时，用很小的书籍画像先筛选候选。
// 这是冷启动的快速路径：宁可后台继续载入大图，也不让首次查询同步读取数 GB 数据。
const SEM_PROFILE_CANDIDATE_LIMIT: usize = 24;
const SEM_COMPACT_PROFILE_CANDIDATE_LIMIT: usize = 8;
const SEM_LEXICAL_CANDIDATE_LIMIT: usize = 16;

#[derive(Default)]
struct SemQueryCache {
    order: VecDeque<String>,
    entries: HashMap<String, (u64, Vec<SemBookHits>)>,
}

struct SemanticQueryActivity;

impl SemanticQueryActivity {
    fn enter() -> Self {
        SEM_QUERY_ACTIVE.fetch_add(1, Ordering::AcqRel);
        Self
    }
}

impl Drop for SemanticQueryActivity {
    fn drop(&mut self) {
        SEM_QUERY_ACTIVE.fetch_sub(1, Ordering::AcqRel);
    }
}

fn sem_query_cache() -> &'static Mutex<SemQueryCache> {
    SEM_QUERY_CACHE.get_or_init(|| Mutex::new(SemQueryCache::default()))
}

fn sem_embed_lock() -> &'static Mutex<()> {
    SEM_EMBED_LOCK.get_or_init(|| Mutex::new(()))
}

/// 取一本书的向量数据（内存缓存 → 否则读 .vec/.json）。
fn get_sem_data(state: &AppState, id: u64) -> Option<Arc<SemData>> {
    vector::load(state, id)
}

#[derive(Clone, Serialize)]
pub(crate) struct SemHit {
    pub(super) chapter: u32,
    pub(super) snippet: String,
    pub(super) score: f32,
}
#[derive(Clone, Serialize)]
pub(crate) struct SemBookHits {
    pub(super) book_id: String,
    pub(super) title: String,
    pub(super) author: String,
    pub(super) score: f32,
    pub(super) hits: Vec<SemHit>,
}

fn compact_lexical_phrase(query: &str) -> Option<String> {
    let phrase = query
        .trim()
        .trim_matches(|character: char| {
            matches!(
                character,
                '"' | '\'' | '“' | '”' | '‘' | '’' | '《' | '》' | '〈' | '〉'
            )
        })
        .trim();
    let count = phrase.chars().count();
    ((2..=16).contains(&count) && !phrase.chars().any(char::is_whitespace))
        .then(|| phrase.to_lowercase())
}

fn lexical_relevance(phrase: &str, text: &str) -> f32 {
    if phrase.is_empty() || text.is_empty() {
        return 0.0;
    }
    let folded = text.to_lowercase();
    if folded.contains(phrase) {
        return 1.0;
    }
    let query_chars = phrase.chars().collect::<Vec<_>>();
    if query_chars.len() < 2 {
        return 0.0;
    }
    let text_chars = folded.chars().collect::<Vec<_>>();
    let bigram_total = query_chars.len() - 1;
    let bigram_matches = query_chars
        .windows(2)
        .filter(|query_pair| text_chars.windows(2).any(|pair| pair == *query_pair))
        .count();
    let char_matches = query_chars
        .iter()
        .filter(|character| text_chars.contains(character))
        .count();
    let bigram_coverage = bigram_matches as f32 / bigram_total as f32;
    let char_coverage = char_matches as f32 / query_chars.len() as f32;
    (bigram_coverage * 0.8 + char_coverage * 0.2).clamp(0.0, 1.0)
}

fn hybrid_score(semantic: f32, lexical: f32, compact_phrase: bool) -> f32 {
    let (semantic_weight, lexical_weight) = if compact_phrase {
        (0.65, 0.35)
    } else {
        (0.88, 0.12)
    };
    (semantic.clamp(-1.0, 1.0) * semantic_weight + lexical * lexical_weight).clamp(-1.0, 1.0)
}

/// 在一本书里做语义检索。短专名使用“向量相似度 + 完整短语/相邻字词面”
/// 混合排序，确保精确事件名不会被只共享地名的长段落压过。
fn sem_search_book(
    state: &AppState,
    book: &book::Book,
    q: &[f32],
    lexical_phrase: Option<&str>,
) -> Option<SemBookHits> {
    let id = book.id;
    let data = get_sem_data(state, id)?;
    if data.is_empty() {
        return None;
    }
    let n = data.len();
    let mut scored: Vec<(f32, usize)> = Vec::with_capacity(n);
    for i in 0..n {
        let v = data.vector(i)?;
        let semantic = dot(q, v);
        let lexical = lexical_phrase
            .and_then(|phrase| {
                data.chunk(i)
                    .map(|(_, text)| lexical_relevance(phrase, text))
            })
            .unwrap_or(0.0);
        scored.push((hybrid_score(semantic, lexical, lexical_phrase.is_some()), i));
    }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let best = scored[0].0;
    let hits: Vec<SemHit> = scored
        .iter()
        .take(8)
        .map(|(s, i)| {
            let (chapter, text) = data.chunk(*i).unwrap_or_default();
            SemHit {
                chapter,
                snippet: text.to_string(),
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

pub(super) fn clear_cache() {
    if let Ok(mut cache) = sem_query_cache().lock() {
        cache.order.clear();
        cache.entries.clear();
    }
}

fn sem_query_cache_stamp() -> u64 {
    accelerator::cache_stamp()
}

fn sem_query_cache_key(query: &str, ids: &Option<Vec<String>>) -> String {
    let mut key = query.trim().to_lowercase();
    key.push_str("\nrank=hybrid-v1");
    if let Some(ids) = ids {
        let mut ids = ids.clone();
        ids.sort();
        key.push_str("\nids=");
        key.push_str(&ids.join(","));
    } else {
        key.push_str("\nids=*");
    }
    key
}

fn get_sem_query_cache(key: &str, stamp: u64) -> Option<Vec<SemBookHits>> {
    let cache = sem_query_cache().lock().ok()?;
    cache
        .entries
        .get(key)
        .and_then(|(s, v)| if *s == stamp { Some(v.clone()) } else { None })
}

fn put_sem_query_cache(key: String, stamp: u64, value: &[SemBookHits]) {
    let Ok(mut cache) = sem_query_cache().lock() else {
        return;
    };
    if !cache.entries.contains_key(&key) {
        cache.order.push_back(key.clone());
    }
    cache.entries.insert(key.clone(), (stamp, value.to_vec()));
    while cache.order.len() > 32 {
        if let Some(old) = cache.order.pop_front() {
            cache.entries.remove(&old);
        }
    }
}

/// 对一组书做并行暴力语义检索（无近邻图、或分片没覆盖到的书走这里）。
fn brute_force_books(
    state: &AppState,
    targets: &[book::Book],
    q: &[f32],
    lexical_phrase: Option<&str>,
) -> Vec<SemBookHits> {
    if targets.is_empty() {
        return Vec::new();
    }
    let qref: &[f32] = q;
    let lexical_phrase = lexical_phrase.map(str::to_string);
    let lexical_phrase_ref = lexical_phrase.as_deref();
    let nthreads = interactive_search_workers(targets.len());
    let chunk_size = targets.len().div_ceil(nthreads).max(1);
    std::thread::scope(|scope| {
        let handles: Vec<_> = targets
            .chunks(chunk_size)
            .map(|chunk| {
                scope.spawn(move || {
                    with_thread_background_priority(|| {
                        let mut out = Vec::new();
                        for b in chunk {
                            if let Some(h) = sem_search_book(state, b, qref, lexical_phrase_ref) {
                                out.push(h);
                            }
                        }
                        out
                    })
                })
            })
            .collect();
        handles
            .into_iter()
            .flat_map(|h| h.join().unwrap_or_default())
            .collect()
    })
}

fn rerank_graph_book(book: &mut SemBookHits, lexical_phrase: Option<&str>) {
    let Some(phrase) = lexical_phrase else {
        return;
    };
    for hit in &mut book.hits {
        hit.score = hybrid_score(hit.score, lexical_relevance(phrase, &hit.snippet), true);
    }
    book.hits.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    book.score = book.hits.first().map(|hit| hit.score).unwrap_or(book.score);
}

fn merge_book_results(results: Vec<SemBookHits>) -> Vec<SemBookHits> {
    let mut merged = HashMap::<String, SemBookHits>::new();
    for mut book in results {
        if let Some(existing) = merged.get_mut(&book.book_id) {
            existing.score = existing.score.max(book.score);
            existing.hits.append(&mut book.hits);
            existing.hits.sort_by(|left, right| {
                right
                    .score
                    .partial_cmp(&left.score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            let mut seen = HashSet::new();
            existing
                .hits
                .retain(|hit| seen.insert((hit.chapter, hit.snippet.clone())));
            existing.hits.truncate(8);
            existing.score = existing
                .hits
                .first()
                .map(|hit| hit.score)
                .unwrap_or(existing.score);
        } else {
            merged.insert(book.book_id.clone(), book);
        }
    }
    merged.into_values().collect()
}

fn profile_candidate_books(
    targets: &[book::Book],
    q: &[f32],
    limit: usize,
) -> (Vec<book::Book>, usize) {
    profile::candidate_books(targets, q, limit)
}

/// 用户进入语义检索界面时提前初始化模型、跑一次编码 warmup，并按当前内存预算载入加速分片。
/// 命令立即返回；真正工作在后台线程完成。查询若紧接着到来，会复用同一加载锁而不会重复读 9GB 索引。
pub(super) fn prepare(app: tauri::AppHandle) -> Result<bool, String> {
    {
        let state = app.state::<AppState>();
        if !semantic_model_available(state.inner()) {
            return Err(SEMANTIC_MODEL_MISSING.to_string());
        }
    }
    if accelerator::is_prepared() {
        return Ok(false);
    }
    if !accelerator::begin_prepare() {
        return Ok(false);
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let total_started = Instant::now();
        let state = app.state::<AppState>();
        let model_started = Instant::now();
        let result = get_embedder(state.inner()).and_then(|embedder| {
            let model_ms = model_started.elapsed().as_millis();
            let warm_started = Instant::now();
            // 已有真实查询在等待时不抢先跑虚拟 warmup；真实查询本身就是 warmup。
            if SEM_QUERY_ACTIVE.load(Ordering::Acquire) == 0 {
                let _guard = sem_embed_lock()
                    .lock()
                    .map_err(|_| "语义编码锁定失败".to_string())?;
                let _ = embedder
                    .lock()
                    .map_err(|_| "语义模型锁定失败".to_string())?
                    .embed(
                        vec![semantic_query_input("阅读")],
                        None,
                    )
                    .map_err(|e| e.to_string())?;
            }
            let warm_ms = warm_started.elapsed().as_millis();
            // 首查走轻量画像路径时，避免 9GB 顺序读取与候选向量争抢磁盘。
            // 查询返回后再在后台载入全局图，后续查询即可直接复用。
            while SEM_QUERY_ACTIVE.load(Ordering::Acquire) > 0 {
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            let index_started = Instant::now();
            let loaded = accelerator::load_global_index(state.inner());
            let index_ms = index_started.elapsed().as_millis();
            crate::log(&format!(
                "semantic_prepare model_ms={model_ms} warm_ms={warm_ms} index_ms={index_ms} shards={} covered={} total_ms={}",
                loaded.as_ref().map(|index| index.shard_count()).unwrap_or(0),
                loaded.as_ref().map(|index| index.covered_ids().len()).unwrap_or(0),
                total_started.elapsed().as_millis()
            ));
            Ok(())
        });
        match result {
            Ok(()) => accelerator::finish_prepare(true),
            Err(error) => {
                crate::log(&format!(
                    "semantic_prepare failed elapsed_ms={} error={error}",
                    total_started.elapsed().as_millis()
                ));
                accelerator::finish_prepare(false);
            }
        }
        set_thread_background(false);
    });
    Ok(true)
}

/// 只在后台预热语义模型，不读取 GB 级 HNSW 加速分片。主窗口和阅读页可共享
/// 同一个模型实例；原子门闩保证启动预热、界面预热与真实查询不会重复创建模型。
pub(super) fn warm_model(app: tauri::AppHandle) -> Result<bool, String> {
    {
        let state = app.state::<AppState>();
        if !semantic_model_available(state.inner()) {
            return Err(SEMANTIC_MODEL_MISSING.to_string());
        }
        if state
            .embedder
            .lock()
            .map_err(|_| "语义模型状态锁定失败".to_string())?
            .is_some()
        {
            return Ok(false);
        }
    }
    if SEM_MODEL_WARMING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Ok(false);
    }
    std::thread::spawn(move || {
        set_thread_background(true);
        let started = Instant::now();
        let state = app.state::<AppState>();
        let result = get_embedder(state.inner()).and_then(|embedder| {
            if SEM_QUERY_ACTIVE.load(Ordering::Acquire) == 0 {
                let _guard = sem_embed_lock()
                    .lock()
                    .map_err(|_| "语义编码锁定失败".to_string())?;
                let _ = embedder
                    .lock()
                    .map_err(|_| "语义模型锁定失败".to_string())?
                    .embed(vec![semantic_query_input("阅读")], None)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        crate::log(&format!(
            "semantic_model_warmup ok={} elapsed_ms={} error={}",
            result.is_ok(),
            started.elapsed().as_millis(),
            result.as_ref().err().map(String::as_str).unwrap_or("")
        ));
        SEM_MODEL_WARMING.store(false, Ordering::Release);
        set_thread_background(false);
    });
    Ok(true)
}

fn semantic_search_inner(
    state: &AppState,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    let total_started = Instant::now();
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let query_chars = query.chars().count();
    let cache_key = sem_query_cache_key(&query, &ids);
    let cache_stamp = sem_query_cache_stamp();
    if let Some(cached) = get_sem_query_cache(&cache_key, cache_stamp) {
        crate::log(&format!(
            "semantic_search cache_hit=true query_chars={query_chars} results={} total_ms={}",
            cached.len(),
            total_started.elapsed().as_millis()
        ));
        return Ok(cached);
    }

    let model_started = Instant::now();
    let embedder = get_embedder(state)?;
    let model_ms = model_started.elapsed().as_millis();
    let encode_started = Instant::now();
    let mut q = {
        let _guard = sem_embed_lock()
            .lock()
            .map_err(|_| "语义编码锁定失败".to_string())?;
        embedder
            .lock()
            .map_err(|_| "语义模型锁定失败".to_string())?
            .embed(vec![semantic_query_input(&query)], None)
            .map_err(|e| e.to_string())?
            .remove(0)
    };
    normalize(&mut q);
    let encode_ms = encode_started.elapsed().as_millis();
    let want: Option<std::collections::HashSet<u64>> = ids.map(|values| {
        values
            .iter()
            .filter_map(|id| id.parse::<u64>().ok())
            .collect()
    });

    let mut covered: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut results: Vec<SemBookHits> = Vec::new();
    let mut loaded_shards = 0usize;
    let index_started = Instant::now();
    let loaded_index = if want.is_none() {
        accelerator::loaded_global_index_if_ready(state)
    } else {
        None
    };
    let index_ms = index_started.elapsed().as_millis();
    let graph_started = Instant::now();
    if let Some(index) = loaded_index {
        let titles: HashMap<u64, (String, String)> = {
            let lib = state.library.lock().unwrap();
            lib.books
                .iter()
                .map(|book| (book.id, (book.title.clone(), book.author.clone())))
                .collect()
        };
        loaded_shards = index.shard_count();
        covered = index.covered_ids();
        let mut graph_results = accelerator::search_loaded_shards(&index, &q, &titles);
        let lexical_phrase = compact_lexical_phrase(&query);
        for book in &mut graph_results {
            rerank_graph_book(book, lexical_phrase.as_deref());
        }
        results.extend(graph_results);
    }
    let graph_ms = graph_started.elapsed().as_millis();

    let all_targets: Vec<book::Book> = {
        let lib = state.library.lock().unwrap();
        lib.books
            .iter()
            .filter(|book| book.format != "pdf")
            .filter(|book| {
                want.as_ref()
                    .map(|set| set.contains(&book.id))
                    .unwrap_or(true)
            })
            .filter(|book| vector::metadata_exists(book.id))
            .cloned()
            .collect()
    };
    let mut targets = all_targets
        .iter()
        .filter(|book| !covered.contains(&book.id))
        .cloned()
        .collect::<Vec<_>>();
    let fallback_books = targets.len();
    let profile_started = Instant::now();
    let mut multi_profile_books = 0usize;
    let lexical_phrase = compact_lexical_phrase(&query);
    let lexical_candidates = lexical_phrase
        .as_deref()
        .map(|phrase| {
            crate::search::semantic_lexical_candidates(
                state,
                &all_targets,
                phrase,
                SEM_LEXICAL_CANDIDATE_LIMIT,
            )
        })
        .unwrap_or_default();
    let lexical_books = lexical_candidates.len();
    if want.is_none() {
        let profile_limit = if lexical_books >= 4 {
            SEM_COMPACT_PROFILE_CANDIDATE_LIMIT
        } else {
            SEM_PROFILE_CANDIDATE_LIMIT
        };
        let selection = profile_candidate_books(&targets, &q, profile_limit);
        targets = selection.0;
        multi_profile_books = selection.1;
    }
    let mut selected_ids = targets.iter().map(|book| book.id).collect::<HashSet<_>>();
    for book in lexical_candidates {
        if selected_ids.insert(book.id) {
            targets.push(book);
        }
    }
    let profile_ms = profile_started.elapsed().as_millis();
    let candidate_books = targets.len();
    let brute_started = Instant::now();
    results.extend(brute_force_books(
        state,
        &targets,
        &q,
        lexical_phrase.as_deref(),
    ));
    let brute_ms = brute_started.elapsed().as_millis();

    results = merge_book_results(results);
    results.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    results.truncate(60);
    put_sem_query_cache(cache_key, cache_stamp, &results);
    crate::log(&format!(
        "semantic_search cache_hit=false query_chars={query_chars} model_ms={model_ms} encode_ms={encode_ms} index_ms={index_ms} graph_ms={graph_ms} profile_ms={profile_ms} brute_ms={brute_ms} shards={loaded_shards} covered={} fallback_books={fallback_books} candidates={candidate_books} lexical_books={lexical_books} multi_profile_books={multi_profile_books} vector_cache_mb={} results={} total_ms={}",
        covered.len(),
        state.sem_cache_bytes.load(Ordering::Relaxed) / (1024 * 1024),
        results.len(),
        total_started.elapsed().as_millis()
    ));
    Ok(results)
}

/// 语义检索：把查询转成向量，在已建索引的图书里按相似度排序返回。
pub(super) async fn semantic_search(
    app: tauri::AppHandle,
    query: String,
    ids: Option<Vec<String>>,
) -> Result<Vec<SemBookHits>, String> {
    {
        let state = app.state::<AppState>();
        if !semantic_model_available(state.inner()) {
            return Err(SEMANTIC_MODEL_MISSING.to_string());
        }
    }
    let query_activity = SemanticQueryActivity::enter();
    // 查询直接走已经载入的图；冷启动使用画像候选快速路径。不要在一次查询后
    // 自动反序列化 GB 级 HNSW 分片，这种后台内存洪峰仍会让 WebView 输入卡顿。
    tauri::async_runtime::spawn_blocking(move || {
        with_thread_background_priority(|| {
            let _query_activity = query_activity;
            let state = app.state::<AppState>();
            semantic_search_inner(state.inner(), query, ids)
        })
    })
    .await
    .map_err(|error| format!("语义检索任务失败：{error}"))?
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stable_for_the_same_book_scope() {
        let first =
            sem_query_cache_key("  阅读  ", &Some(vec!["9".into(), "2".into(), "5".into()]));
        let second = sem_query_cache_key("阅读", &Some(vec!["5".into(), "9".into(), "2".into()]));
        assert_eq!(first, second);
        assert_eq!(first, "阅读\nrank=hybrid-v1\nids=2,5,9");
        assert_eq!(
            sem_query_cache_key("阅读", &None),
            "阅读\nrank=hybrid-v1\nids=*"
        );
    }

    #[test]
    fn compact_phrase_accepts_short_terms_and_rejects_sentences() {
        assert_eq!(
            compact_lexical_phrase("“天津教案”").as_deref(),
            Some("天津教案")
        );
        assert_eq!(
            compact_lexical_phrase("天津教案").as_deref(),
            Some("天津教案")
        );
        assert_eq!(compact_lexical_phrase("天津 教案"), None);
        assert_eq!(
            compact_lexical_phrase("请分析天津教案发生的历史背景和影响"),
            None
        );
    }

    #[test]
    fn lexical_relevance_prefers_exact_compound_over_shared_place_name() {
        let exact = lexical_relevance("天津教案", "晚清天津教案的起因与影响");
        let partial = lexical_relevance("天津教案", "天津工业与农业发展");
        let unrelated = lexical_relevance("天津教案", "江南赋税制度");
        assert_eq!(exact, 1.0);
        assert!(exact > partial);
        assert!(partial > unrelated);
    }

    #[test]
    fn hybrid_ranking_can_promote_an_exact_event_name() {
        let exact = hybrid_score(0.48, 1.0, true);
        let generic = hybrid_score(
            0.60,
            lexical_relevance("天津教案", "天津工业与农业发展"),
            true,
        );
        assert!(exact > generic);
    }

    #[test]
    fn search_implementation_stays_out_of_the_parent_module() {
        let parent = include_str!("../semantic.rs");
        for forbidden in [
            "struct SemQueryCache",
            "struct SemanticQueryActivity",
            "fn sem_query_cache(",
            "fn sem_embed_lock(",
            "fn sem_search_book(",
            "fn brute_force_books(",
            "fn semantic_search_inner(",
            "SEM_QUERY_ACTIVE",
            "SEM_PROFILE_CANDIDATE_LIMIT",
        ] {
            assert!(
                !parent.contains(forbidden),
                "semantic search boundary regressed: {forbidden}"
            );
        }
        assert!(parent.contains("pub(crate) use search::{SemBookHits, SemHit}"));
        assert!(parent.contains("search::clear_cache()"));
        assert!(parent.contains("search::prepare(app)"));
        assert!(parent.contains("search::semantic_search(app, query, ids)"));
    }
}
