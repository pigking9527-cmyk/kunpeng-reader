use crate::{
    background_tasks, book::Library, db, memory_budget, search, search_cache, semantic,
    semantic_tasks, stats::StatsStore, tts, vocab,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::sync::watch;

#[derive(Default)]
pub(crate) struct TextChaptersCache {
    entries: HashMap<u64, Arc<Vec<(String, String)>>>,
    order: VecDeque<u64>,
    bytes: u64,
}

impl TextChaptersCache {
    fn chapter_bytes(chapters: &[(String, String)]) -> u64 {
        chapters.iter().fold(0u64, |total, (title, body)| {
            total
                .saturating_add(u64::try_from(title.len()).unwrap_or(u64::MAX))
                .saturating_add(u64::try_from(body.len()).unwrap_or(u64::MAX))
        })
    }

    fn touch(&mut self, id: u64) {
        self.order.retain(|existing| *existing != id);
        self.order.push_back(id);
    }

    pub(crate) fn get(&mut self, id: u64) -> Option<Arc<Vec<(String, String)>>> {
        let chapters = Arc::clone(self.entries.get(&id)?);
        self.touch(id);
        Some(chapters)
    }

    pub(crate) fn insert(
        &mut self,
        id: u64,
        chapters: Arc<Vec<(String, String)>>,
        book_limit: usize,
        byte_limit: u64,
    ) {
        self.remove(id);
        self.bytes = self
            .bytes
            .saturating_add(Self::chapter_bytes(chapters.as_slice()));
        self.entries.insert(id, chapters);
        self.touch(id);
        while self.order.len() > book_limit || self.bytes > byte_limit {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            self.remove(oldest);
        }
    }

    pub(crate) fn remove(&mut self, id: u64) {
        if let Some(chapters) = self.entries.remove(&id) {
            self.bytes = self
                .bytes
                .saturating_sub(Self::chapter_bytes(chapters.as_slice()));
        }
        self.order.retain(|existing| *existing != id);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.bytes = 0;
    }

    pub(crate) fn bytes(&self) -> u64 {
        self.bytes
    }
}

/// Process-local wake-up companion for SQLite's durable automatic-sync
/// generation.  Entity writes persist the generation first; this object only
/// avoids waiting for the next application launch to observe it.
pub(crate) struct SyncAutoScheduler {
    app: Mutex<Option<tauri::AppHandle>>,
    timer_armed: AtomicBool,
    wake_generation: AtomicU64,
}

impl SyncAutoScheduler {
    fn new() -> Self {
        Self {
            app: Mutex::new(None),
            timer_armed: AtomicBool::new(false),
            wake_generation: AtomicU64::new(0),
        }
    }

    pub(crate) fn attach(&self, app: tauri::AppHandle) {
        if let Ok(mut slot) = self.app.lock() {
            *slot = Some(app);
        }
        self.note_local_entity_change();
    }

    pub(crate) fn note_local_entity_change(&self) {
        self.wake_generation.fetch_add(1, Ordering::AcqRel);
        let app = self.app.lock().ok().and_then(|slot| slot.clone());
        let Some(app) = app else {
            return;
        };
        if self
            .timer_armed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }
        let scheduler = app.state::<AppState>().sync_auto_scheduler.clone();
        tauri::async_runtime::spawn(async move {
            scheduler.wait_for_due_sync(app).await;
        });
    }

    fn wake_occurred_since(&self, observed_wake_generation: u64) -> bool {
        self.wake_generation.load(Ordering::Acquire) != observed_wake_generation
    }

    async fn wait_for_due_sync(self: Arc<Self>, app: tauri::AppHandle) {
        loop {
            let observed_wake_generation = self.wake_generation.load(Ordering::Acquire);
            let pending = app.state::<AppState>().with_db_read("sync_auto_due", |db| {
                if db.automatic_sync_is_configured()
                    && crate::sync::automatic_sync_credentials_ready_without_prompt(db)
                {
                    db.automatic_sync_due()
                } else {
                    Ok(None)
                }
            });
            let Some(due) = pending.ok().flatten() else {
                self.timer_armed.store(false, Ordering::Release);
                // A writer that persisted after our snapshot could have seen
                // the armed flag and skipped spawning a second task. Rearm
                // only for that real concurrent wake-up, rather than kicking
                // ourselves forever while no automatic sync is configured.
                if self.wake_occurred_since(observed_wake_generation) {
                    self.note_local_entity_change();
                }
                return;
            };
            let now = crate::now_ms();
            if due.due_at_ms > now {
                tokio::time::sleep(Duration::from_millis(due.due_at_ms - now)).await;
                continue;
            }
            self.timer_armed.store(false, Ordering::Release);
            crate::sync::start_automatic_sync(app, due.generation);
            return;
        }
    }

    pub(crate) fn finish_run(&self, state: &AppState, generation: u64, success: bool) {
        let pending = state.with_db_write("sync_auto_finish", |db| {
            if success {
                db.settle_automatic_sync_generation(generation)
            } else {
                db.fail_automatic_sync_generation(generation)
            }
        });
        if pending.unwrap_or(false) {
            self.note_local_entity_change();
        }
    }
}

/// A short-lived cancellation channel for one local-library AI request.
/// The request id is generated in the renderer and is never persisted or
/// synchronized; it only lets a later cancel command drop the active HTTP
/// future on this device.
pub(crate) struct LibraryAiRequestGuard {
    id: String,
    registry: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    sender: watch::Sender<bool>,
}

impl LibraryAiRequestGuard {
    pub(crate) fn cancellation(&self) -> watch::Receiver<bool> {
        self.sender.subscribe()
    }
}

impl Drop for LibraryAiRequestGuard {
    fn drop(&mut self) {
        let Ok(mut registry) = self.registry.lock() else {
            return;
        };
        if registry
            .get(&self.id)
            .is_some_and(|current| current.same_channel(&self.sender))
        {
            registry.remove(&self.id);
        }
    }
}

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
    pub(crate) txt_chapters: Mutex<TextChaptersCache>,
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
    pub(crate) sync_auto_scheduler: Arc<SyncAutoScheduler>,
    library_ai_requests: Arc<Mutex<HashMap<String, watch::Sender<bool>>>>,
    memory_reclaimers: Mutex<Vec<memory_budget::ReclaimerHandle>>,
}

impl AppState {
    pub(crate) fn new(mut startup_database: Option<db::AppDb>) -> Self {
        let sync_auto_scheduler = Arc::new(SyncAutoScheduler::new());
        if let Some(database) = startup_database.as_mut() {
            database.set_sync_local_change_notifier(Arc::clone(&sync_auto_scheduler));
        }
        Self {
            background_tasks: background_tasks::BackgroundTaskRegistry::new_persistent_default(),
            page_count_tasks: Mutex::new(HashMap::new()),
            library: Mutex::new(Library::load()),
            db: Mutex::new(startup_database),
            epub_runtime: crate::epub_runtime::EpubRuntime::default(),
            backfilled: AtomicBool::new(false),
            pending_jump: Mutex::new(HashMap::new()),
            search_text_cache: Arc::new(Mutex::new(search_cache::SearchTextCache::default())),
            txt_chapters: Mutex::new(TextChaptersCache::default()),
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
            sync_auto_scheduler,
            library_ai_requests: Arc::new(Mutex::new(HashMap::new())),
            memory_reclaimers: Mutex::new(Vec::new()),
        }
    }

    /// Restored/reopened databases are fresh connections and must be rebound
    /// to the in-process notifier. The durable generation remains in SQLite.
    pub(crate) fn bind_sync_auto_scheduler(&self, database: &mut db::AppDb) {
        database.set_sync_local_change_notifier(Arc::clone(&self.sync_auto_scheduler));
    }

    /// Serializes access to the sole SQLite connection while measuring mutex
    /// contention separately from SQLite query time. Backup and recovery rely
    /// on this single-connection lifecycle, so this is an observability and
    /// boundary improvement rather than an unsafe connection-pool substitute.
    pub(crate) fn with_db_read<T>(
        &self,
        operation: &'static str,
        access: impl FnOnce(&db::AppDb) -> Result<T, String>,
    ) -> Result<T, String> {
        let waiting = Instant::now();
        let guard = self.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        record_db_lock_wait(operation, waiting);
        let database = guard.as_ref().ok_or("SQLite 数据库不可用")?;
        let access_started = Instant::now();
        let result = access(database);
        record_db_locked_access(operation, access_started);
        result
    }

    /// See [`Self::with_db_read`]. Mutable access remains serialized because
    /// restore temporarily closes the sole SQLite connection before replacing
    /// the database and WAL files.
    pub(crate) fn with_db_write<T>(
        &self,
        operation: &'static str,
        access: impl FnOnce(&mut db::AppDb) -> Result<T, String>,
    ) -> Result<T, String> {
        let waiting = Instant::now();
        let mut guard = self.db.lock().map_err(|_| "数据库锁定失败".to_string())?;
        record_db_lock_wait(operation, waiting);
        let database = guard.as_mut().ok_or("SQLite 数据库不可用")?;
        let access_started = Instant::now();
        let result = access(database);
        record_db_locked_access(operation, access_started);
        result
    }

    pub(crate) fn begin_library_ai_request(
        &self,
        id: String,
    ) -> Result<LibraryAiRequestGuard, String> {
        let (sender, _receiver) = watch::channel(false);
        let mut registry = self
            .library_ai_requests
            .lock()
            .map_err(|_| "书库问答取消状态不可用".to_string())?;
        if registry.contains_key(&id) {
            return Err("同一书库问答请求仍在运行".to_string());
        }
        registry.insert(id.clone(), sender.clone());
        Ok(LibraryAiRequestGuard {
            id,
            registry: Arc::clone(&self.library_ai_requests),
            sender,
        })
    }

    pub(crate) fn cancel_library_ai_request(&self, id: &str) -> Result<bool, String> {
        let registry = self
            .library_ai_requests
            .lock()
            .map_err(|_| "书库问答取消状态不可用".to_string())?;
        let Some(sender) = registry.get(id) else {
            return Ok(false);
        };
        sender
            .send(true)
            .map_err(|_| "书库问答请求已结束".to_string())?;
        Ok(true)
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

fn record_db_lock_wait(operation: &str, waiting: Instant) {
    let elapsed_ms = waiting.elapsed().as_millis();
    let elapsed_ms = u64::try_from(elapsed_ms).unwrap_or(u64::MAX);
    crate::diagnostics::record_db_lock_wait(operation, elapsed_ms);
    if elapsed_ms >= 250 {
        crate::log(&format!(
            "[db] lock_wait={operation} elapsed_ms={elapsed_ms}"
        ));
    }
}

fn record_db_locked_access(operation: &str, started: Instant) {
    let elapsed_ms = started.elapsed().as_millis();
    let elapsed_ms = u64::try_from(elapsed_ms).unwrap_or(u64::MAX);
    crate::diagnostics::record_db_locked_access(operation, elapsed_ms);
    if elapsed_ms >= 250 {
        crate::log(&format!(
            "[db] locked_access={operation} elapsed_ms={elapsed_ms}"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::{db, AppState, SyncAutoScheduler, TextChaptersCache};
    use std::sync::Arc;

    #[test]
    fn text_chapter_cache_is_bounded_by_books_and_bytes() {
        let mut cache = TextChaptersCache::default();
        cache.insert(1, Arc::new(vec![("一".into(), "aaaa".into())]), 2, 20);
        cache.insert(2, Arc::new(vec![("二".into(), "bbbb".into())]), 2, 20);
        assert!(cache.get(1).is_some());
        cache.insert(3, Arc::new(vec![("三".into(), "cccc".into())]), 2, 20);
        assert!(cache.get(1).is_some());
        assert!(cache.get(2).is_none());
        assert!(cache.get(3).is_some());

        cache.insert(4, Arc::new(vec![("四".into(), "x".repeat(32))]), 2, 20);
        assert!(cache.get(4).is_none());
        assert!(cache.bytes() <= 20);
    }

    #[test]
    fn sync_auto_scheduler_only_rearms_after_a_concurrent_wake() {
        let scheduler = SyncAutoScheduler::new();
        let observed = scheduler
            .wake_generation
            .load(std::sync::atomic::Ordering::Acquire);
        assert!(!scheduler.wake_occurred_since(observed));

        scheduler.note_local_entity_change();
        assert!(scheduler.wake_occurred_since(observed));
    }

    #[test]
    fn database_access_helpers_preserve_read_write_callbacks() {
        let state = AppState::new(Some(db::AppDb::open_in_memory_for_tests()));
        let original = state
            .with_db_read("app_state_test_read", |database| Ok(database.device_id()))
            .expect("read callback receives database");
        assert_eq!(original, "test-device");

        state
            .with_db_write("app_state_test_write", |database| {
                database.set_metadata("app_state_test", "written")
            })
            .expect("write callback receives database");
        let saved = state
            .with_db_read("app_state_test_verify", |database| {
                Ok(database.metadata("app_state_test"))
            })
            .expect("read callback succeeds");
        assert_eq!(saved.as_deref(), Some("written"));
    }

    #[test]
    fn library_ai_cancel_is_scoped_to_one_live_request_and_cleans_up() {
        let state = AppState::new(None);
        let first = state
            .begin_library_ai_request("library-one".to_string())
            .expect("first request registers");
        let second = state
            .begin_library_ai_request("library-two".to_string())
            .expect("second request registers");
        let first_cancel = first.cancellation();
        let second_cancel = second.cancellation();

        assert!(state
            .cancel_library_ai_request("library-one")
            .expect("request can cancel"));
        assert!(*first_cancel.borrow());
        assert!(!*second_cancel.borrow());
        assert!(!state
            .cancel_library_ai_request("unknown")
            .expect("unknown is a harmless no-op"));

        drop(first);
        assert!(!state
            .cancel_library_ai_request("library-one")
            .expect("finished request no longer exists"));
        drop(second);
    }
}
