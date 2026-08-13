use std::sync::Arc;

use metrics_exporter_prometheus::PrometheusHandle;
use secrecy::SecretString;
use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub metrics: PrometheusHandle,
    pub request_slots: Arc<Semaphore>,
    pub password_slots: Arc<Semaphore>,
    pub token_hmac_key: SecretString,
    pub config: Config,
}
