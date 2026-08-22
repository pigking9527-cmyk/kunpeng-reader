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
    /// Read-only request execution slots.  Writes use their own bounded lane so
    /// a contended account-level mutation lock cannot consume read capacity.
    pub request_slots: Arc<Semaphore>,
    /// Dedicated small execution lane for cursor checkpoint probes.  It keeps
    /// progress checks available while large pulls consume the ordinary read
    /// lane, while preventing checkpoints from taking all read capacity.
    pub checkpoint_request_slots: Arc<Semaphore>,
    /// Bounded waiting room for read requests after their execution slots are
    /// full.  A saturated queue is rejected immediately with a retryable 503.
    pub read_request_queue_slots: Arc<Semaphore>,
    /// Bounded waiting room for the checkpoint lane.
    pub checkpoint_request_queue_slots: Arc<Semaphore>,
    /// State-changing request execution slots. Per-account transaction locks
    /// still serialize conflicting mutations within this separate write lane.
    pub write_request_slots: Arc<Semaphore>,
    /// Bounded waiting room for writes.  It is separate from the read queue so
    /// write bursts cannot make lightweight sync reads wait behind them.
    pub write_request_queue_slots: Arc<Semaphore>,
    pub password_slots: Arc<Semaphore>,
    pub token_hmac_key: SecretString,
    pub config: Config,
}
