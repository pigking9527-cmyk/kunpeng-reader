use std::sync::Arc;

use metrics_exporter_prometheus::PrometheusHandle;
use secrecy::SecretString;
use sqlx::PgPool;
use tokio::sync::Semaphore;

use crate::{
    config::Config,
    intelligence_object_store::{IntelligenceObjectStore, IntelligenceObjectStoreStatus},
};

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
    /// The configured object-store adapter.  It is deliberately injected at
    /// startup so enabling S3 cannot leave request completion on an ignored
    /// configuration branch.  Request reads select the declared, verified
    /// storage location after authorization and expiry checks; legacy rows
    /// remain on the `PostgreSQL` bytea path.
    pub intelligence_object_store: Arc<dyn IntelligenceObjectStore>,
    pub config: Config,
}

impl AppState {
    /// Test-only and local-only constructors can use this explicit safe
    /// adapter when no object storage is configured.
    #[must_use]
    pub fn disabled_intelligence_object_store() -> Arc<dyn IntelligenceObjectStore> {
        Arc::new(crate::intelligence_object_store::DisabledIntelligenceObjectStore)
    }

    /// Returns the lifecycle state of the adapter actually injected at startup.
    #[must_use]
    pub fn intelligence_object_store_status(&self) -> IntelligenceObjectStoreStatus {
        self.intelligence_object_store.status()
    }
}
