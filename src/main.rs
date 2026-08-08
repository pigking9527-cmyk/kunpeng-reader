#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod ai_reader;
mod app_commands;
mod app_settings;
mod atomic_file;
mod auto_import_watch;
pub mod background_tasks;
mod backup;
mod book;
mod data_commands;
mod data_migration;
mod db;
mod diagnostics;
mod dict;
mod epub_runtime;
mod epub_toc;
mod external_dict;
mod feedback;
mod hownet;
mod html_sanitize;
mod import;
mod import_core;
mod library_commands;
mod memory_budget;
mod newsnow;
mod pdf_support;
mod private_sync;
mod reader_backgrounds;
mod reader_commands;
mod reader_fonts;
mod reader_page;
mod reader_palettes;
mod reader_protocol;
mod runtime_support;
mod search;
mod search_cache;
mod search_core;
mod search_index;
mod secret_store;
mod semantic;
mod semantic_core;
mod semantic_tasks;
#[cfg(test)]
mod smoke_tests;
mod startup;
mod startup_enhancement;
mod stats;
#[cfg(test)]
mod stats_core;
mod sync;
#[cfg(test)]
mod sync_core;
mod text_chapters;
mod translate;
mod tts;
mod tts_core;
mod update;
mod url_open;
mod vocab;
mod window_commands;
pub(crate) use runtime_support::{
    emit_startup_perf, interactive_search_workers, log, now_ms, report_save_error,
    set_thread_background, with_thread_background_priority, DEFAULT_SYNC_URL, RES_BASE,
};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use {book::Library, stats::StatsStore};
/// 全局状态：书架 + 已打开的 EPUB 缓存（避免每个资源请求都重新解压）。
type TextChaptersCache = Mutex<HashMap<u64, Arc<Vec<(String, String)>>>>;
pub(crate) struct AppState {
    pub(crate) background_tasks: background_tasks::BackgroundTaskRegistry,
    /// Reader WebView work uses the same durable lifecycle as native background work.
    pub(crate) page_count_tasks: Mutex<HashMap<u64, background_tasks::TaskRunGuard>>,
    pub(crate) library: Mutex<Library>,
    pub(crate) db: Mutex<Option<db::AppDb>>,
    epub_runtime: epub_runtime::EpubRuntime,
    backfilled: std::sync::atomic::AtomicBool, // 是否已回填旧书的作者/导入时间
    pending_jump: Mutex<HashMap<u64, (u32, String)>>, // 书架检索点击 → 阅读窗口待跳转位置
    pub(crate) search_text_cache: Arc<Mutex<search_cache::SearchTextCache>>, // 全文检索原文/小写副本共享 LRU 预算
    pub(crate) txt_chapters: TextChaptersCache, // txt 阅读用：切分好的章节 (标题, 正文)
    pub(crate) embedder: Mutex<Option<Arc<Mutex<semantic::model::SemanticEmbedder>>>>, // 语义模型（懒加载，首次会下载）
    pub(crate) reranker: Mutex<Option<Arc<Mutex<fastembed::TextRerank>>>>, // 可选交叉编码器，只重排少量候选
    pub(crate) sem_cache: Arc<Mutex<HashMap<u64, Arc<semantic::SemData>>>>, // 语义检索：内存缓存的向量
    pub(crate) sem_cache_order: Arc<Mutex<VecDeque<u64>>>, // 逐书向量 LRU：换词时淘汰旧书，避免缓存被首批结果永久占满
    pub(crate) sem_cache_bytes: Arc<AtomicUsize>,
    pub(crate) sem_progress: Mutex<semantic_tasks::SemProgress>, // 建立语义索引的进度
    pub(crate) global_index: Arc<Mutex<Option<Arc<semantic::LoadedShards>>>>, // 全库近邻索引：已载入内存的分片集合
    pub(crate) index_resume_at: AtomicU64, // 语义索引“让路”截止时刻(ms,0=不暂停)：打开阅读窗口时临时暂停建索引，让窗口秒开
    pub(crate) stats: Mutex<StatsStore>,   // 详细阅读统计的小时桶
    pub(crate) vocab: Mutex<vocab::VocabStore>, // 生词本：查过的词
    word_pack: Mutex<tts::WordPackState>,  // 高频词语音包后台生成状态
    pub(crate) sync_running: AtomicBool,   // 防止启动与手动同步并发上传同一批实体
    memory_reclaimers: Mutex<Vec<memory_budget::ReclaimerHandle>>,
}
impl AppState {
    fn install_memory_reclaimers(&self) {
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
fn main() {
    runtime_support::mark_process_started();
    if std::env::args().any(|a| a == "--sem-probe") {
        semantic::sem_probe();
        return;
    }
    if std::env::args().any(|a| a == "--hnsw-probe") {
        semantic::hnsw_probe();
        return;
    }
    let startup_book_paths = startup::startup_book_paths();
    if !startup::ensure_single_instance(startup_book_paths.clone()) {
        return;
    }
    let startup_database = match backup::recover_interrupted_restore() {
        Ok(()) => match db::AppDb::open() {
            Ok(database) => Some(database),
            Err(error) => {
                log(&format!("SQLite 数据库启动失败：{error}"));
                None
            }
        },
        Err(error) => {
            // Do not call AppDb::open after a failed recovery: SQLite would
            // create an empty reader.db if the crash happened after the old
            // file was renamed but before the new file was committed.
            log(&format!(
                "未完成恢复事务自救失败，已阻止创建空数据库：{error}"
            ));
            None
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(startup::StartupBookPaths::new(startup_book_paths))
        .manage(startup_enhancement::StartupEnhancementState::load())
        .manage(AppState {
            background_tasks: background_tasks::BackgroundTaskRegistry::new_persistent_default(),
            page_count_tasks: Mutex::new(HashMap::new()),
            library: Mutex::new(Library::load()),
            db: Mutex::new(startup_database),
            epub_runtime: epub_runtime::EpubRuntime::default(),
            backfilled: std::sync::atomic::AtomicBool::new(false),
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
        })
        .setup(|app| {
            semantic::initialize_semantic_model_selection();
            {
                let state = app.state::<AppState>();
                state.install_memory_reclaimers();
                if let Err(error) = data_migration::apply_local_organization_entities(state.inner())
                {
                    // Do not project an old library file when the authoritative
                    // organization entities could not be read.
                    log(&format!(
                        "独立标签/收藏夹恢复失败，已阻止 SQLite 投影：{error}"
                    ));
                } else if let Err(error) = data_migration::migrate_json_to_sqlite(state.inner()) {
                    log(&format!("SQLite 迁移失败：{error}"));
                } else {
                    match data_migration::converge_entity_model(state.inner()) {
                        Ok(removed) if removed > 0 => {
                            log(&format!("实体模型已收敛，移除旧实体 {removed} 条"))
                        }
                        Ok(_) => {}
                        Err(error) => log(&format!("实体模型收敛已安全跳过：{error}")),
                    }
                }
            }
            backup::spawn_daily(app.handle().clone());
            semantic::spawn_semantic_profile_warmup(app.handle().clone());
            startup::spawn_associated_book_watcher(app.handle().clone());
            auto_import_watch::spawn(app.handle().clone());
            startup::spawn_maintenance(app.handle().clone()); // 延后低抢占维护任务，避免刚打开窗口拖动卡顿
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(startup::VERSIONED_MAIN_WINDOW_TITLE);
                let geom = {
                    app.state::<AppState>()
                        .library
                        .lock()
                        .unwrap()
                        .main_geom
                        .clone()
                };
                window_commands::apply_geom_safe(&win, &geom);
                let app_ev = app.handle().clone();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        if let Some(w) = app_ev.get_webview_window("main") {
                            window_commands::persist_main_window_state(&app_ev, &w);
                            if startup_enhancement::should_keep_running(&app_ev) {
                                api.prevent_close();
                                startup_enhancement::background_main(&app_ev);
                            }
                        }
                    }
                });
            }
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("reader", epub_runtime::handle_protocol_request)
        .invoke_handler(tauri::generate_handler![
            window_commands::main_window_minimize,
            window_commands::main_window_toggle_maximize,
            window_commands::main_window_close,
            window_commands::main_window_start_dragging,
            window_commands::main_window_start_resize_dragging,
            library_commands::list_books,
            library_commands::book_file_sizes,
            library_commands::set_book_organization,
            library_commands::add_books_organization,
            library_commands::rename_book_organization,
            library_commands::delete_book_organization,
            library_commands::list_booklists,
            library_commands::update_booklist,
            library_commands::library_health,
            library_commands::maintain_search_index,
            library_commands::merge_duplicate_books,
            library_commands::book_reading_timeline,
            window_commands::reader_window_open,
            app_commands::background_task_status,
            app_commands::background_task_cancel,
            app_commands::background_task_pause,
            app_commands::app_version,
            app_commands::startup_elapsed_ms,
            app_commands::runtime_diagnostics,
            app_commands::clear_runtime_diagnostics,
            app_commands::open_default_apps_settings,
            startup::take_startup_book_paths,
            startup_enhancement::startup_enhancement_config,
            startup_enhancement::set_startup_enhancement_config,
            app_commands::save_download_image,
            reader_backgrounds::cache_reader_background_image,
            reader_backgrounds::reader_background_local_url,
            app_commands::problem_trace_checkpoint,
            app_commands::save_problem_trace_to_desktop,
            app_commands::dict_lookup,
            app_commands::external_dict_list,
            app_commands::external_dict_import,
            app_commands::external_dict_delete,
            app_commands::external_dict_set_enabled,
            app_commands::external_dict_move_priority,
            app_commands::translation_credential_status,
            app_commands::translation_credentials_status,
            app_commands::set_translation_active_provider,
            app_commands::save_translation_credential,
            app_commands::translate_text,
            feedback::submit_feedback,
            newsnow::newsnow_status,
            newsnow::newsnow_sources,
            newsnow::newsnow_list,
            newsnow::newsnow_prefetch,
            newsnow::newsnow_refresh,
            newsnow::newsnow_preview_image,
            newsnow::newsnow_open_article,
            newsnow::newsnow_close_article,
            ai_reader::ai_reader_status,
            ai_reader::ai_reader_profiles,
            ai_reader::select_ai_reader_profile,
            ai_reader::save_ai_reader_profile,
            ai_reader::save_ai_reader_config,
            ai_reader::ask_reading_assistant,
            ai_reader::ask_library_assistant,
            ai_reader::library_history_source_preview,
            ai_reader::library_profile_status,
            ai_reader::library_profile_coverage_status,
            ai_reader::library_model_tags_settings,
            ai_reader::library_answer_settings,
            ai_reader::set_library_answer_length,
            ai_reader::set_library_model_tags_enabled,
            ai_reader::start_library_auto_classification,
            private_sync::private_sync_get_settings,
            app_settings::app_settings_sync_get,
            app_settings::app_settings_sync_save,
            reader_palettes::reader_palette_sync_get,
            reader_palettes::reader_palette_sync_save,
            private_sync::private_sync_set_options,
            private_sync::private_sync_history_list,
            private_sync::private_sync_history_merge,
            private_sync::private_sync_history_delete,
            private_sync::private_sync_reader_history_snapshot,
            private_sync::private_sync_set_reader_history_mode,
            private_sync::private_sync_set_reader_history_cloud_saved,
            private_sync::private_sync_library_history_list,
            private_sync::private_sync_set_library_history_mode,
            private_sync::private_sync_library_history_merge,
            private_sync::private_sync_set_library_history_cloud_saved,
            private_sync::private_sync_library_history_delete,
            private_sync::private_sync_set_password,
            private_sync::private_sync_unlock_secrets,
            private_sync::private_sync_forget_password,
            vocab::vocab_add,
            vocab::vocab_list,
            vocab::vocab_remove,
            vocab::vocab_set_level,
            vocab::vocab_review,
            vocab::notes_summary,
            sync::sync_get_settings,
            sync::sync_set_settings,
            sync::auth_register,
            sync::auth_login,
            sync::auth_security_status,
            sync::auth_bind_email_start,
            sync::auth_bind_email_confirm,
            sync::auth_rebind_email_old_start,
            sync::auth_rebind_email_old_confirm,
            sync::auth_rebind_email_new_start,
            sync::auth_rebind_email_new_confirm,
            sync::auth_change_password,
            sync::sync_reset_cloud_data,
            sync::auth_delete_account,
            sync::auth_request_password_reset,
            sync::auth_confirm_password_reset,
            sync::auth_logout,
            sync::sync_now,
            data_commands::recovery_backup_status,
            data_commands::create_recovery_backup,
            data_commands::restore_recovery_backup,
            data_commands::migrate_data_to_sqlite,
            data_commands::export_data_package,
            data_commands::import_data_package,
            data_commands::clear_local_app_data,
            update::check_update,
            update::release_notes,
            library_commands::shelf_books,
            import::add_books,
            library_commands::remove_book,
            library_commands::remove_books,
            library_commands::set_cover,
            import::get_auto_import,
            import::set_auto_import,
            import::auto_import_scan,
            library_commands::open_book,
            epub_runtime::book_info,
            app_commands::reader_perf_log,
            reader_commands::book_meta,
            reader_commands::book_meta_by_id,
            reader_fonts::reader_font_status,
            reader_fonts::download_reader_font,
            library_commands::compute_word_counts,
            library_commands::set_progress,
            reader_commands::add_bookmark,
            reader_commands::remove_bookmark,
            stats::reading_stats,
            stats::reading_stats_range,
            stats::add_reading_time,
            stats::add_read_words,
            app_commands::open_url,
            tts::edge_tts,
            tts::word_tts,
            tts::word_tts_cache_size,
            tts::clear_word_tts_cache,
            tts::word_tts_pack_status,
            tts::word_tts_pack_missing,
            tts::clear_word_tts_pack,
            tts::start_word_tts_pack,
            tts::pause_word_tts_pack,
            pdf_support::get_page_cache,
            pdf_support::save_page_cache,
            pdf_support::begin_page_count_task,
            pdf_support::report_page_count_task,
            pdf_support::get_pdf_state,
            pdf_support::set_pdf_state,
            epub_runtime::search_book,
            reader_commands::set_description,
            reader_commands::set_book_description,
            reader_commands::set_book_title,
            reader_commands::set_rating,
            reader_commands::set_book_rating,
            search::web_search,
            library_commands::open_book_at,
            library_commands::take_pending_jump,
            search::shelf_search,
            search::shelf_search_book_hits,
            search::build_shelf_index,
            search::open_search_window,
            semantic::build_semantic_index,
            semantic::download_semantic_model,
            semantic::delete_semantic_model,
            semantic::select_semantic_model,
            semantic::select_semantic_retrieval_mode,
            semantic::set_semantic_m3_long_context,
            semantic::download_semantic_reranker,
            semantic::delete_semantic_reranker,
            semantic::build_semantic_m3_index,
            semantic::delete_semantic_m3_index,
            semantic::delete_semantic_index,
            semantic::build_semantic_vectors,
            semantic::pause_semantic_vectors,
            semantic::build_semantic_accelerator,
            semantic::build_semantic_multi_profile,
            semantic::semantic_index_done,
            semantic::gpu::semantic_gpu_status,
            semantic::gpu_runtime::install_semantic_gpu_runtime,
            semantic::semantic_status,
            semantic::semantic_tasks,
            semantic::prepare_semantic_search,
            semantic::warm_semantic_model,
            semantic::semantic_search,
            semantic::similar_books,
            reader_commands::add_highlight,
            reader_commands::remove_highlight,
            reader_commands::set_highlight_note,
            reader_commands::set_highlight_text,
            reader_commands::set_highlight_color,
            library_commands::relocate_book
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 失败");
}
