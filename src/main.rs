#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]
mod ai_reader;
mod app_commands;
mod app_settings;
mod app_state;
mod atomic_file;
mod auto_import_watch;
pub mod background_tasks;
mod backup;
mod book;
mod booklist_sync;
mod data_commands;
mod data_migration;
mod db;
mod diagnostics;
mod dict;
mod epub_runtime;
mod epub_toc;
mod external_dict;
mod feedback;
mod gesture_settings;
mod intelligence_client;
mod html_sanitize;
mod import;
mod import_core;
mod library_commands;
mod macos_reader_wheel;
mod memory_budget;
mod newsnow;
mod pdf_support;
mod private_sync;
mod profile;
mod reader_backgrounds;
mod reader_commands;
mod reader_fonts;
mod reader_page;
mod reader_palettes;
mod reader_protocol;
mod recovery_settings;
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
mod sync;
mod text_chapters;
mod translate;
mod tts;
mod tts_core;
mod update;
mod url_open;
mod vocab;
mod window_commands;
use crate::ai_reader as ar;
pub(crate) use app_state::AppState;
pub(crate) use runtime_support::{
    emit_startup_perf, interactive_search_workers, log, now_ms, report_save_error,
    set_thread_background, with_thread_background_priority, DEFAULT_SYNC_URL, RES_BASE,
};
#[cfg(target_os = "macos")]
use tauri::menu::MenuItem;
use tauri::{menu::Menu, Manager};
#[cfg(target_os = "macos")]
const MENU_MAIN_WINDOW_CLOSE: &str = "main-window-close";
fn main() {
    if let Err(error) =
        profile::preflight_process_args().and_then(|()| profile::initialize_from_process_args())
    {
        eprintln!("{error}");
        std::process::exit(2);
    }
    runtime_support::mark_process_started();
    runtime_support::remove_legacy_debug_log();
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
            // Never create an empty reader.db while failed recovery files are incomplete.
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
        .manage(startup_enhancement::MainWindowRuntime::default())
        .manage(AppState::new(startup_database))
        .menu(|app| {
            let menu = Menu::default(app)?;
            #[cfg(target_os = "macos")]
            if let Some(file_menu) = menu.items()?.into_iter().find_map(|item| {
                let submenu = item.as_submenu()?;
                (submenu.text().ok().as_deref() == Some("File")).then(|| submenu.clone())
            }) {
                // 无边框 WebView 在部分 macOS 环境不会可靠执行预置菜单项的
                // performClose:。用有明确 ID 的原生菜单项接管 Command+W。
                let _ = file_menu.remove_at(0)?;
                let close = MenuItem::with_id(
                    app,
                    MENU_MAIN_WINDOW_CLOSE,
                    "关闭窗口",
                    true,
                    Some("CmdOrCtrl+W"),
                )?;
                file_menu.insert(&close, 0)?;
            }
            Ok(menu)
        })
        .on_menu_event(|_app, _event| {
            #[cfg(target_os = "macos")]
            if _event.id() == MENU_MAIN_WINDOW_CLOSE {
                if let Some(window) = _app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false))
                {
                    let result = if window.label() == "main" {
                        window_commands::main_window_close(window.as_ref().clone())
                    } else {
                        window.close().map_err(|error| error.to_string())
                    };
                    if let Err(error) = result {
                        log(&format!("原生关闭窗口快捷键失败：{error}"));
                    }
                }
            }
        })
        .setup(|app| {
            macos_reader_wheel::install_paged_reader_wheel_monitor();
            semantic::initialize_semantic_model_selection();
            {
                let state = app.state::<AppState>();
                state.install_memory_reclaimers();
                state.sync_auto_scheduler.attach(app.handle().clone());
                if let Err(error) = data_migration::apply_local_organization_entities(state.inner())
                {
                    // Do not project an old library when authoritative organization data failed.
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
                if let Err(error) =
                    reader_backgrounds::prune_unreferenced_cached_assets(state.inner())
                {
                    log(&format!("孤立主题背景图清理已跳过：{error}"));
                }
            }
            // Avoid creating Tauri's fallback 980×720 frame: wait for saved
            // geometry, then create the window hidden.
            let geom = {
                app.state::<AppState>()
                    .library
                    .lock()
                    .unwrap()
                    .main_geom
                    .clone()
            };
            let mut main_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|config| config.label == "main")
                .cloned()
                .ok_or("缺少主窗口配置")?;
            if let Some(saved) = geom.as_ref().filter(|saved| {
                saved.w >= 300.0 && saved.h >= 300.0 && saved.x > -10_000.0 && saved.y > -10_000.0
            }) {
                main_config.width = saved.w;
                main_config.height = saved.h;
                main_config.x = Some(saved.x);
                main_config.y = Some(saved.y);
                main_config.maximized = saved.maximized;
            }
            let main_window_builder = tauri::WebviewWindowBuilder::from_config(app, &main_config)?;
            #[cfg(target_os = "macos")]
            let main_window_builder =
                if let Some(identifier) = profile::webview_data_store_identifier() {
                    main_window_builder.data_store_identifier(identifier)
                } else {
                    main_window_builder
                };
            let _main_window = main_window_builder.build()?;
            startup_enhancement::retain_main_window(app.handle(), _main_window.as_ref().window());
            sync::start_silent_startup_sync(app.handle().clone());
            // Content-free wake-ups are subscribed at app start, never by a
            // WebView page open. Full packages still pass the native cache
            // validation and acknowledgement order before any display.
            intelligence_client::spawn_delivery_stream(app.handle().clone());
            backup::spawn_daily(app.handle().clone());
            semantic::spawn_semantic_profile_warmup(app.handle().clone());
            startup::spawn_associated_book_watcher(app.handle().clone());
            auto_import_watch::spawn(app.handle().clone());
            startup::spawn_maintenance(app.handle().clone()); // 延后低抢占维护任务，避免刚打开窗口拖动卡顿
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_title(startup::VERSIONED_MAIN_WINDOW_TITLE);
                window_commands::apply_geom_safe(&win, &geom);
                // 主窗口保持隐藏到书架首帧绘制后经 main_window_show 揭示，先稳定保存的几何状态。
                if startup_enhancement::should_start_login_background(app.handle()) {
                    startup_enhancement::begin_login_background(app.handle());
                }
                let app_ev = app.handle().clone();
                let main_native_window = win.as_ref().window();
                win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                        window_commands::persist_reader_window_states_before_main_close(&app_ev);
                        window_commands::persist_main_window_state(&app_ev, &main_native_window);
                        if startup_enhancement::should_keep_running(&app_ev) {
                            api.prevent_close();
                            let _ = startup_enhancement::background_main_from_window(
                                &app_ev,
                                &main_native_window,
                            );
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
            window_commands::main_window_exit,
            window_commands::main_window_show,
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
            library_commands::create_booklist,
            library_commands::delete_booklist,
            library_commands::save_recommended_booklist,
            library_commands::library_health,
            library_commands::maintain_search_index,
            library_commands::merge_duplicate_books,
            library_commands::book_reading_timeline,
            window_commands::reader_window_open,
            window_commands::reader_shell_pool_ready,
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
            newsnow::newsnow_intelligence_snapshot_get,
            newsnow::newsnow_intelligence_snapshot_save,
            newsnow::newsnow_intelligence_enrich_articles,
            newsnow::newsnow_list,
            newsnow::newsnow_prefetch,
            newsnow::newsnow_refresh,
            newsnow::newsnow_preview_image,
            newsnow::newsnow_prepare_article_shell,
            newsnow::newsnow_open_article,
            newsnow::newsnow_close_article,
            ai_reader::ai_reader_status,
            ai_reader::ai_reader_profiles,
            ai_reader::select_ai_reader_profile,
            intelligence_client::intelligence_client_cache_status,
            intelligence_client::intelligence_client_cached_publications,
            intelligence_client::intelligence_client_asset_data_url,
            intelligence_client::intelligence_client_refresh,
            intelligence_client::intelligence_archive_calendar,
            intelligence_client::intelligence_archive_request,
            intelligence_client::intelligence_archive_request_status,
            intelligence_client::intelligence_archive_download,
            ai_reader::assign_ai_reader_profile,
            ai_reader::save_ai_reader_profile,
            ai_reader::save_ai_reader_config,
            ar::intelligence_local_model_status,
            ar::intelligence_local_model_save,
            ar::intelligence_extract_source_evidence,
            ar::intelligence_generate_brief,
            ar::intelligence_judge_event_pairs,
            ar::intelligence_triage_articles,
            ar::intelligence_cluster_news_semantically,
            ar::intelligence_daily_digest_save,
            ar::intelligence_daily_digest_list,
            ar::intelligence_daily_digest_get,
            ai_reader::ask_reading_assistant,
            ai_reader::ask_library_assistant,
            ai_reader::cancel_library_assistant,
            ai_reader::library_history_source_preview,
            ai_reader::library_profile_status,
            ai_reader::library_profile_coverage_status,
            ai_reader::library_model_tags_settings,
            ai_reader::library_answer_settings,
            ai_reader::set_library_answer_length,
            ai_reader::set_library_recommendation_candidate_limit,
            ai_reader::set_library_recommendation_result_limit,
            ai_reader::set_library_model_tags_enabled,
            ai_reader::start_library_auto_classification,
            private_sync::private_sync_get_settings,
            app_settings::commands::app_settings_sync_get,
            app_settings::commands::app_settings_sync_save,
            newsnow::newsnow_custom_sources_get,
            newsnow::newsnow_custom_sources_save,
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
            sync::sync_account_open_refresh,
            sync::sync_start_silent,
            sync::sync_set_settings,
            sync::auth_register,
            sync::auth_register_start,
            sync::auth_register_confirm,
            sync::auth_login,
            sync::auth_security_status,
            sync::auth_usage_status,
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
            recovery_settings::recovery_web_settings_save,
            recovery_settings::recovery_web_settings_take_restored,
            data_commands::migrate_data_to_sqlite,
            data_commands::export_data_package,
            data_commands::import_data_package,
            data_commands::clear_local_app_data_preflight,
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
            epub_runtime::prewarm_book,
            window_commands::reader_shell_preload_status,
            window_commands::set_reader_shell_preload_enabled,
            window_commands::set_recent_reading_chapter_cache_enabled,
            window_commands::clear_recent_reading_chapter_cache,
            window_commands::benchmark_reader_shell_opening,
            window_commands::reader_shell_hidden_after_save,
            epub_runtime::book_info,
            window_commands::prepare_reader_switch_target,
            window_commands::cancel_prepared_reader_switch_target,
            window_commands::complete_reader_switch,
            gesture_settings::reader_gesture_settings_save,
            gesture_settings::reader_gesture_settings_load,
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
            reader_commands::set_book_description,
            reader_commands::set_book_title,
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
            library_commands::relocate_book,
            macos_reader_wheel::set_reader_paged_wheel_momentum_filter
        ])
        .build(tauri::generate_context!("tauri.conf.json"))
        .expect("启动 Tauri 失败")
        .run(|app, event| match event {
            // Command+Q、菜单栏“退出”和关闭主窗口遵循启动增强开关：开启时仅隐藏窗口、保留进程。
            tauri::RunEvent::ExitRequested { api, .. }
                if startup_enhancement::should_keep_running(app)
                    && !window_commands::take_explicit_application_exit_request() =>
            {
                api.prevent_exit();
                startup_enhancement::background_main(app);
            }
            // macOS 在 Dock 或 Finder 重新打开一个没有可见窗口的应用时，
            // 不会走前端的 `main_window_show`。关闭后保留后台进程时，
            // 必须在系统 Reopen 事件中恢复主窗口。
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => startup_enhancement::activate_main(app, now_ms()),
            // Finder sends an Opened event to the already-running app instead
            // of launching a second process. Convert only local supported book
            // files, then let the existing front end import and open them.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect();
                startup::open_associated_book_paths(app, paths);
            }
            _ => {}
        });
}
