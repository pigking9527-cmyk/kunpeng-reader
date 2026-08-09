use crate::{
    background_tasks, book::Library, db, memory_budget, search, search_cache, semantic,
    semantic_tasks, stats::StatsStore, tts, vocab,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

type TextChaptersCache = Mutex<HashMap<u64, Arc<Vec<(String, String)>>>>;

pub(crate) struct AppState {
    pub(crate) background_tasks: background_tasks::BackgroundTaskRegistry,
    /// Reader WebView work uses the same durable lifecycle as native background work.
    pub(crate) page_count_tasks: Mutex<HashMap<u64, background_tasks::TaskRunGuard>>,
    pub(crate) library: Mutex<Library>,
    pub(crate) db: Mutex<Option<db::AppDb>>,
    pub(crate) epub_runtime: crate::epub_runtime::EpubRuntime,
    pub(crate) backfilled: AtomicBool,
    pub(crate) pending_jump: Mutex<HashMap<u64, (u32, String)>>,
    pub(crate) search_text_cache: Arc<Mutex<search_cache::SearchTextCache>>,
    pub(crate) txt_chapters: TextChaptersCache,
    pub(crate) embedder: Mutex<Option<Arc<Mutex<semantic::model::SemanticEmbedder>>>>,
    pub(crate) reranker: Mutex<Option<Arc<Mutex<fastembed::TextRerank>>>>,
    pub(crate) sem_cache: Arc<Mutex<HashMap<u64, Arc<semantic::SemData>>>>,
    pub(crate) sem_cache_order: Arc<Mutex<VecDeque<u64>>>,
    pub(crate) sem_cache_bytes: Arc<AtomicUsize>,
    pub(crate) sem_progress: Mutex<semantic_tasks::SemProgress>,
    pub(crate) global_index: Arc<Mutex<Option<Arc<semantic::LoadedShards>>>>,
    pub(crate) index_resume_at: AtomicU64,
    pub(crate) stats: Mutex<StatsStore>,
    pub(crate) vocab: Mutex<vocab::VocabStore>,
    pub(crate) word_pack: Mutex<tts::WordPackState>,
    pub(crate) sync_running: AtomicBool,
    memory_reclaimers: Mutex<Vec<memory_budget::ReclaimerHandle>>,
}

impl AppState {
    pub(crate) fn new(startup_database: Option<db::AppDb>) -> Self {
        Self {
            background_tasks: background_tasks::BackgroundTaskRegistry::new_persistent_default(),
            page_count_tasks: Mutex::new(HashMap::new()),
            library: Mutex::new(Library::load()),
            db: Mutex::new(startup_database),
            epub_runtime: crate::epub_runtime::EpubRuntime::default(),
            backfilled: AtomicBool::new(false),
            pending_jump: Mutex::new(HashMap::new()),
            search_text_cache: Arc::new(Mutex::new(search_cache::SearchTextCache::default())),
            txt_chapters: Mutex::new(HashMap::new()),
            embedder: Mutex::new(None),
            reranker: Mutex::new(None),
            sem_cache: Arc::new(Mutex::new(HashMap::new())),
            sem_cache_order: Arc::new(Mutex::new(VecDeque::new())),
            sem_cache_bytes: Arc::new(AtomicUsize::new(0)),
            sem_progress: Mutex::new(semantic_tasks::SemProgress::default()),
            global_index: Arc::new(Mutex::new(None)),
            index_resume_at: AtomicU64::new(0),
            stats: Mutex::new(StatsStore::load()),
            vocab: Mutex::new(vocab::VocabStore::load()),
            word_pack: Mutex::new(tts::WordPackState::default()),
            sync_running: AtomicBool::new(false),
            memory_reclaimers: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn install_memory_reclaimers(&self) {
        let mut handles = self
            .memory_reclaimers
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !handles.is_empty() {
            return;
        }
        let governor = memory_budget::governor();
        let search_text = Arc::clone(&self.search_text_cache);
        handles.push(governor.register_reclaimer(
            memory_budget::MemoryClass::SearchText,
            move |_| {
                if let Ok(mut cache) = search_text.try_lock() {
                    cache.clear();
                }
            },
        ));
        handles.push(
            governor.register_reclaimer(memory_budget::MemoryClass::SearchFilter, move |_| {
                search::clear_filter_memory_cache()
            }),
        );
        let sem_cache = Arc::clone(&self.sem_cache);
        let sem_order = Arc::clone(&self.sem_cache_order);
        let sem_bytes = Arc::clone(&self.sem_cache_bytes);
        handles.push(governor.register_reclaimer(
            memory_budget::MemoryClass::SemanticVector,
            move |_| {
                if let Ok(mut cache) = sem_cache.try_lock() {
                    cache.clear();
                    sem_bytes.store(0, Ordering::Relaxed);
                }
                if let Ok(mut order) = sem_order.try_lock() {
                    order.clear();
                }
            },
        ));
        let global_index = Arc::clone(&self.global_index);
        handles.push(governor.register_reclaimer(
            memory_budget::MemoryClass::SemanticGraph,
            move |_| {
                if let Ok(mut index) = global_index.try_lock() {
                    *index = None;
                }
            },
        ));
        handles.push(
            governor.register_reclaimer(memory_budget::MemoryClass::SemanticAux, move |_| {
                semantic::clear_semantic_aux_memory_caches()
            }),
        );
    }

    pub(crate) fn reset_runtime_caches_after_restore(&self) {
        self.epub_runtime.clear();
        self.pending_jump.lock().map(|mut cache| cache.clear()).ok();
        self.search_text_cache
            .lock()
            .map(|mut cache| *cache = search_cache::SearchTextCache::default())
            .ok();
        self.txt_chapters.lock().map(|mut cache| cache.clear()).ok();
        self.sem_cache.lock().map(|mut cache| cache.clear()).ok();
        self.sem_cache_order
            .lock()
            .map(|mut order| order.clear())
            .ok();
        self.sem_cache_bytes.store(0, Ordering::Relaxed);
        self.global_index.lock().map(|mut index| *index = None).ok();
        self.embedder
            .lock()
            .map(|mut embedder| *embedder = None)
            .ok();
        self.reranker.lock().map(|mut model| *model = None).ok();
        semantic::clear_semantic_aux_memory_caches();
        self.backfilled.store(false, Ordering::Relaxed);
    }
}
