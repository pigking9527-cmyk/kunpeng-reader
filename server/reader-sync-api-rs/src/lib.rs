pub mod account_email;
pub mod account_mutation;
pub mod account_validation;
pub mod assets;
pub mod auth;
pub mod config;
pub mod credentials;
pub mod error;
pub mod feedback;
pub mod mail;
pub mod middleware;
pub mod password_reset;
pub mod phone_registration;
pub mod rate_limit;
pub mod registration;
pub mod routes;
pub mod sms;
pub mod state;
pub mod sync;

use std::sync::Arc;

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderName, header},
    middleware as axum_middleware,
    routing::get,
};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use secrecy::ExposeSecret;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tokio::sync::Semaphore;
use tower_http::{
    catch_panic::CatchPanicLayer, compression::CompressionLayer,
    sensitive_headers::SetSensitiveRequestHeadersLayer, trace::TraceLayer,
};
use tracing::info;
use utoipa::{
    Modify, OpenApi,
    openapi::security::{Http, HttpAuthScheme, SecurityScheme},
};

use crate::{
    config::Config,
    error::ErrorBody,
    middleware::{no_store, protect, request_context, require_protocol_v5},
    routes::{HealthResponse, SyncStatusResponse},
    state::AppState,
};

#[derive(OpenApi)]
#[openapi(
    paths(
        routes::health,
        routes::ready,
        routes::sync_status,
        auth::login,
        auth::logout,
        auth::session,
        auth::me,
        auth::change_password,
        password_reset::request,
        password_reset::confirm,
        feedback::submit,
        registration::start,
        registration::confirm,
        phone_registration::start,
        phone_registration::confirm,
        sync::reset_data,
        assets::init,
        assets::upload_chunk,
        assets::download,
        sync::push,
        sync::pull,
        sync::checkpoint,
        sync::inventory,
        sync::reconcile,
        sync::secret_state,
        sync::reset_secret_state,
        auth::security,
        auth::usage,
        auth::delete_account,
        account_email::bind_start,
        account_email::bind_confirm,
        account_email::rebind_old_start,
        account_email::rebind_old_confirm,
        account_email::rebind_new_start,
        account_email::rebind_new_confirm
    ),
    components(schemas(
        HealthResponse,
        SyncStatusResponse,
        ErrorBody,
        auth::LoginRequest,
        auth::SessionResponse,
        auth::SessionUser,
        auth::LogoutResponse,
        auth::PasswordChangeRequest,
        auth::PasswordChangeResponse,
        password_reset::PasswordResetConfirmRequest,
        password_reset::PasswordResetRequest,
        password_reset::PasswordResetRequestResponse,
        feedback::FeedbackAttachment,
        feedback::FeedbackImage,
        feedback::FeedbackRequest,
        feedback::FeedbackResponse,
        registration::RegistrationStartRequest,
        registration::RegistrationStartResponse,
        registration::RegistrationConfirmRequest,
        phone_registration::PhoneRegistrationStartRequest,
        phone_registration::PhoneRegistrationStartResponse,
        phone_registration::PhoneRegistrationConfirmRequest,
        sync::EntityEnvelope,
        sync::PushRequest,
        sync::PushResponse,
        sync::DataResetRequest,
        sync::DataResetResponse,
        assets::AssetInitRequest,
        assets::AssetInitResponse,
        sync::PullResponse,
        sync::CheckpointQuery,
        sync::CheckpointResponse,
        sync::InventoryResponse,
        sync::ReconcileRequest,
        sync::ManifestEntry,
        sync::ReconcileResponse,
        sync::EntityKey,
        sync::SecretBundleStateResponse,
        auth::SecurityStatusResponse,
        auth::AccountUsageResponse,
        auth::AccountDeleteRequest,
        auth::AccountDeleteResponse,
        account_email::EmailStartRequest,
        account_email::EmailConfirmRequest,
        account_email::RebindOldConfirmRequest,
        account_email::RebindNewStartRequest,
        account_email::EmailChallengeResponse,
        account_email::RebindGrantResponse
    )),
    tags((name = "reader-sync", description = "Kunpeng Reader synchronization API")),
    modifiers(&SecurityAddon)
)]
struct ApiDoc;

struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        if let Some(components) = openapi.components.as_mut() {
            components.add_security_scheme(
                "bearer_token",
                SecurityScheme::Http(Http::new(HttpAuthScheme::Bearer)),
            );
        }
    }
}

/// Builds shared state without opening a database connection eagerly.
///
/// # Errors
///
/// Returns an error for an invalid database URL, a failed migration, or a
/// process-wide metrics recorder conflict.
pub async fn build_state(config: Config) -> Result<AppState> {
    let pool = PgPoolOptions::new()
        .max_connections(config.database_max_connections)
        .acquire_timeout(config.database_acquire_timeout)
        .connect_lazy(config.database_url.expose_secret())
        .context("failed to configure PostgreSQL pool")?;
    if config.run_migrations {
        // Keep the embedded SQLx migration set in the executable used by the
        // disposable candidate service; migrations are part of the runtime
        // artifact, not merely deployment-side files.
        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .context("failed to run PostgreSQL migrations")?;
    }
    let metrics = install_metrics()?;
    Ok(AppState {
        pool,
        metrics,
        request_slots: Arc::new(Semaphore::new(config.max_concurrent_requests)),
        checkpoint_request_slots: Arc::new(Semaphore::new(
            config.max_concurrent_checkpoint_requests,
        )),
        read_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_read_requests)),
        checkpoint_request_queue_slots: Arc::new(Semaphore::new(
            config.max_queued_checkpoint_requests,
        )),
        write_request_slots: Arc::new(Semaphore::new(config.max_concurrent_write_requests)),
        write_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_write_requests)),
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        config,
    })
}

fn install_metrics() -> Result<PrometheusHandle> {
    // Fixed buckets make the per-stage capacity monitor subtractable.  The
    // default rolling summaries are useful for a live dashboard but cannot
    // attribute a P99 to one bounded load phase.  The metric names and their
    // route/class/operation labels are all controlled by this service.
    const REQUEST_LATENCY_BUCKETS: &[f64] = &[
        0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 15.0,
    ];
    PrometheusBuilder::new()
        .set_buckets_for_metric(
            Matcher::Full("reader_sync_request_queue_wait_seconds".to_owned()),
            REQUEST_LATENCY_BUCKETS,
        )
        .context("failed to configure request queue latency buckets")?
        .set_buckets_for_metric(
            Matcher::Full("reader_sync_request_handler_duration_seconds".to_owned()),
            REQUEST_LATENCY_BUCKETS,
        )
        .context("failed to configure request handler latency buckets")?
        .set_buckets_for_metric(
            Matcher::Full("reader_sync_database_pool_acquire_seconds".to_owned()),
            REQUEST_LATENCY_BUCKETS,
        )
        .context("failed to configure database acquire latency buckets")?
        .set_buckets_for_metric(
            Matcher::Full("reader_sync_database_query_seconds".to_owned()),
            REQUEST_LATENCY_BUCKETS,
        )
        .context("failed to configure database query latency buckets")?
        .install_recorder()
        .context("failed to install Prometheus recorder")
}

#[allow(clippy::too_many_lines)]
pub fn app(state: AppState) -> Router {
    let sync = Router::new()
        .route("/status", get(routes::sync_status))
        .route("/push", axum::routing::post(sync::push))
        .route("/pull", get(sync::pull))
        .route("/checkpoint", get(sync::checkpoint))
        .route("/inventory", get(sync::inventory))
        .route("/reconcile", axum::routing::post(sync::reconcile))
        .route("/secret-state", get(sync::secret_state))
        .route(
            "/secret-state/reset",
            axum::routing::post(sync::reset_secret_state),
        )
        .route("/data/reset", axum::routing::post(sync::reset_data))
        .route("/assets/init", axum::routing::post(assets::init))
        .route(
            "/assets/{asset_id}",
            get(assets::download).put(assets::upload_chunk),
        )
        .route_layer(axum_middleware::from_fn(require_protocol_v5))
        .route_layer(axum_middleware::from_fn(no_store));
    let auth = Router::new()
        .route(
            "/register",
            axum::routing::post(registration::legacy_register),
        )
        .route("/login", axum::routing::post(auth::login))
        .route("/logout", axum::routing::post(auth::logout))
        .route(
            "/password/change",
            axum::routing::post(auth::change_password),
        )
        .route(
            "/password/reset/request",
            axum::routing::post(password_reset::request),
        )
        .route(
            "/password/reset/confirm",
            axum::routing::post(password_reset::confirm),
        )
        .route("/session", get(auth::session))
        .route("/me", get(auth::me))
        .route("/security", get(auth::security))
        .route("/usage", get(auth::usage))
        .route("/account/delete", axum::routing::post(auth::delete_account))
        .route(
            "/email/start",
            axum::routing::post(account_email::bind_start),
        )
        .route(
            "/email/confirm",
            axum::routing::post(account_email::bind_confirm),
        )
        .route(
            "/email/rebind/old/start",
            axum::routing::post(account_email::rebind_old_start),
        )
        .route(
            "/email/rebind/old/confirm",
            axum::routing::post(account_email::rebind_old_confirm),
        )
        .route(
            "/email/rebind/new/start",
            axum::routing::post(account_email::rebind_new_start),
        )
        .route(
            "/email/rebind/new/confirm",
            axum::routing::post(account_email::rebind_new_confirm),
        )
        .route("/register/start", axum::routing::post(registration::start))
        .route(
            "/register/confirm",
            axum::routing::post(registration::confirm),
        )
        .route(
            "/register/phone/start",
            axum::routing::post(phone_registration::start),
        )
        .route(
            "/register/phone/confirm",
            axum::routing::post(phone_registration::confirm),
        )
        .route_layer(axum_middleware::from_fn(no_store));
    let openapi = ApiDoc::openapi();
    Router::new()
        .route("/health", get(routes::health))
        .route("/ready", get(routes::ready))
        .route("/metrics", get(routes::metrics))
        .route("/v1/feedback", axum::routing::post(feedback::submit))
        .route(
            "/openapi.json",
            get(move || async move { axum::Json(openapi.clone()) }),
        )
        .nest("/v1/sync", sync)
        .nest("/v1/auth", auth)
        .fallback(routes::not_found)
        .layer(DefaultBodyLimit::max(state.config.body_limit_bytes))
        .layer(SetSensitiveRequestHeadersLayer::new([
            header::AUTHORIZATION,
            HeaderName::from_static("x-sync-protocol-version"),
        ]))
        .layer(CompressionLayer::new())
        .layer(CatchPanicLayer::new())
        .layer(TraceLayer::new_for_http())
        .layer(axum_middleware::from_fn_with_state(state.clone(), protect))
        .layer(axum_middleware::from_fn(request_context))
        .with_state(state)
}

/// Runs the HTTP service until SIGINT or SIGTERM.
///
/// # Errors
///
/// Returns an error when state initialization, socket binding, or the HTTP
/// server fails.
pub async fn serve(config: Config) -> Result<()> {
    let bind = config.bind;
    let listen_backlog = config.listen_backlog;
    let state = build_state(config).await?;
    let mail_worker = mail::spawn_worker(state.clone())?;
    let sms_worker = sms::spawn_worker(state.clone())?;
    let orphan_asset_reclaimer = assets::spawn_orphan_reclaimer(state.clone());
    let socket = match bind {
        std::net::SocketAddr::V4(_) => tokio::net::TcpSocket::new_v4(),
        std::net::SocketAddr::V6(_) => tokio::net::TcpSocket::new_v6(),
    }
    .with_context(|| format!("failed to create TCP socket for {bind}"))?;
    socket
        .set_reuseaddr(true)
        .with_context(|| format!("failed to configure TCP socket for {bind}"))?;
    socket
        .bind(bind)
        .with_context(|| format!("failed to bind {bind}"))?;
    let listener = socket
        .listen(listen_backlog)
        .with_context(|| format!("failed to listen on {bind}"))?;
    info!(%bind, "reader sync API listening");
    let result = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("HTTP server failed");
    if let Some(worker) = mail_worker {
        worker.abort();
    }
    if let Some(worker) = sms_worker {
        worker.abort();
    }
    orphan_asset_reclaimer.abort();
    result
}

async fn shutdown_signal() {
    let interrupt = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        () = interrupt => {},
        () = terminate => {},
    }
}

/// Installs the process-wide structured tracing subscriber.
///
/// # Errors
///
/// Returns an error when another tracing subscriber has already been installed.
pub fn init_tracing() -> Result<()> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "reader_sync_api=info,tower_http=info".into());
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .json()
        .with_current_span(false)
        .with_span_list(false)
        .try_init()
        .map_err(|error| anyhow::anyhow!("failed to initialize tracing: {error}"))
}

/// Builds a lazy pool that is intentionally unreachable by unit tests.
///
/// # Panics
///
/// Panics only if the hard-coded test URL becomes invalid to SQLx.
#[doc(hidden)]
#[must_use]
pub fn pool_for_test() -> PgPool {
    PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy("postgresql://unused:unused@127.0.0.1:1/unused")
        .expect("valid test PostgreSQL URL")
}
