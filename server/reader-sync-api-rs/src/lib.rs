pub mod account_email;
pub mod assets;
pub mod auth;
pub mod config;
pub mod credentials;
pub mod error;
pub mod feedback;
pub mod mail;
pub mod middleware;
pub mod password_reset;
pub mod rate_limit;
pub mod recovery;
pub mod registration;
pub mod routes;
pub mod state;
pub mod sync;

use std::{sync::Arc, time::Duration};

use anyhow::{Context, Result};
use axum::{
    Router,
    extract::DefaultBodyLimit,
    http::{HeaderName, header},
    middleware as axum_middleware,
    routing::get,
};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
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
        sync::reset_data,
        recovery::status,
        recovery::restore,
        assets::init,
        assets::upload_chunk,
        assets::download,
        sync::push,
        sync::pull,
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
        sync::EntityEnvelope,
        sync::PushRequest,
        sync::PushResponse,
        sync::DataResetRequest,
        sync::DataResetResponse,
        recovery::RecoveryStatusResponse,
        recovery::RecoveryRestoreRequest,
        recovery::RecoveryRestoreResponse,
        assets::AssetInitRequest,
        assets::AssetInitResponse,
        sync::PullResponse,
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
        .acquire_timeout(Duration::from_secs(5))
        .connect_lazy(config.database_url.expose_secret())
        .context("failed to configure PostgreSQL pool")?;
    if config.run_migrations {
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
        password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
        token_hmac_key: config.token_hmac_key.clone(),
        config,
    })
}

fn install_metrics() -> Result<PrometheusHandle> {
    PrometheusBuilder::new()
        .install_recorder()
        .context("failed to install Prometheus recorder")
}

pub fn app(state: AppState) -> Router {
    let sync = Router::new()
        .route("/status", get(routes::sync_status))
        .route("/push", axum::routing::post(sync::push))
        .route("/pull", get(sync::pull))
        .route("/inventory", get(sync::inventory))
        .route("/reconcile", axum::routing::post(sync::reconcile))
        .route("/secret-state", get(sync::secret_state))
        .route(
            "/secret-state/reset",
            axum::routing::post(sync::reset_secret_state),
        )
        .route("/data/reset", axum::routing::post(sync::reset_data))
        .route("/recovery/status", get(recovery::status))
        .route("/recovery/restore", axum::routing::post(recovery::restore))
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
    let state = build_state(config).await?;
    let mail_worker = mail::spawn_worker(state.clone())?;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .with_context(|| format!("failed to bind {bind}"))?;
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
