use std::{sync::Arc, time::Instant};

use axum::{
    extract::{MatchedPath, Request, State},
    http::{HeaderName, HeaderValue, header},
    middleware::Next,
    response::Response,
};
use metrics::{counter, gauge, histogram};
use tokio::{
    sync::{Semaphore, TryAcquireError},
    time::timeout,
};
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

pub static REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone, Copy, Debug)]
pub struct RequestContext {
    pub request_id: Uuid,
}

impl Default for RequestContext {
    fn default() -> Self {
        Self {
            request_id: Uuid::new_v4(),
        }
    }
}

pub async fn request_context(mut request: Request, next: Next) -> Response {
    let context = RequestContext::default();
    request.extensions_mut().insert(context);
    let mut response = next.run(request).await;
    if let Ok(value) = HeaderValue::from_str(&context.request_id.to_string()) {
        response
            .headers_mut()
            .insert(REQUEST_ID_HEADER.clone(), value);
    }
    response
}

pub async fn protect(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let context = request
        .extensions()
        .get::<RequestContext>()
        .copied()
        .unwrap_or_default();
    let request_class = request_class(&request);
    // `MatchedPath` is the router template, never the request URI.  It keeps
    // observability useful without turning query strings or identifiers into
    // metric labels.
    let route = matched_route(&request).to_owned();
    let request_lane = request_lane(&request, &route);
    let deadline = Instant::now() + state.config.request_queue_timeout;
    let queue_started = Instant::now();
    let (execution_slots, queue_slots) = match request_lane {
        RequestLane::Read => (
            Arc::clone(&state.request_slots),
            Arc::clone(&state.read_request_queue_slots),
        ),
        RequestLane::Checkpoint => (
            Arc::clone(&state.checkpoint_request_slots),
            Arc::clone(&state.checkpoint_request_queue_slots),
        ),
        RequestLane::Write => (
            Arc::clone(&state.write_request_slots),
            Arc::clone(&state.write_request_queue_slots),
        ),
    };
    let _permit = match acquire_slot(
        execution_slots,
        queue_slots,
        request_class,
        request_lane,
        &route,
        deadline,
    )
    .await
    {
        Ok(permit) => permit,
        Err(rejection) => {
            record_queue_wait(
                &route,
                request_class,
                request_lane,
                "rejected",
                queue_started.elapsed(),
            );
            record_queue_rejection(&route, request_class, request_lane, rejection);
            counter!(
                "reader_sync_busy_rejections_total",
                "source" => "request_queue"
            )
            .increment(1);
            let response = ApiError::Busy.response(context);
            record_response(&route, request_class, request_lane, &response);
            return response;
        }
    };
    record_queue_wait(
        &route,
        request_class,
        request_lane,
        "acquired",
        queue_started.elapsed(),
    );
    record_database_pool_pressure(&state);
    let handler_started = Instant::now();
    gauge!(
        "reader_sync_active_requests",
        "route" => route.clone(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str()
    )
    .increment(1.0);
    let response = match timeout(state.config.request_timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError::Timeout.response(context),
    };
    gauge!(
        "reader_sync_active_requests",
        "route" => route.clone(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str()
    )
    .decrement(1.0);
    let handler_elapsed = handler_started.elapsed();
    histogram!(
        "reader_sync_request_handler_duration_seconds",
        "route" => route.clone(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str()
    )
    .record(handler_elapsed.as_secs_f64());
    // Keep the original aggregate series for existing dashboards while the
    // labelled handler series above separates queueing from route execution.
    histogram!("reader_sync_request_duration_seconds").record(handler_elapsed.as_secs_f64());
    record_database_pool_pressure(&state);
    record_response(&route, request_class, request_lane, &response);
    response
}

fn record_database_pool_pressure(state: &AppState) {
    // These are instantaneous pressure gauges, not a substitute for the
    // explicit auth acquire-time histogram.  Together they distinguish a
    // saturated pool from SQL/handler work without adding a query or a label
    // derived from a request.
    gauge!("reader_sync_database_pool_size").set(f64::from(state.pool.size()));
    let idle = u32::try_from(state.pool.num_idle()).unwrap_or(u32::MAX);
    gauge!("reader_sync_database_pool_idle").set(f64::from(idle));
}

async fn acquire_slot(
    execution_slots: Arc<Semaphore>,
    queue_slots: Arc<Semaphore>,
    request_class: RequestClass,
    request_lane: RequestLane,
    route: &str,
    deadline: Instant,
) -> Result<tokio::sync::OwnedSemaphorePermit, QueueRejection> {
    let permit = match Arc::clone(&execution_slots).try_acquire_owned() {
        Ok(permit) => permit,
        Err(TryAcquireError::NoPermits) => {
            // Do not let a saturated PostgreSQL pool turn into an unbounded
            // collection of Tokio tasks.  Each lane owns a distinct bounded
            // waiting room, so write bursts cannot evict lightweight reads.
            let queue_permit = match Arc::clone(&queue_slots).try_acquire_owned() {
                Ok(permit) => permit,
                Err(TryAcquireError::NoPermits) => return Err(QueueRejection::Full),
                Err(TryAcquireError::Closed) => return Err(QueueRejection::Closed),
            };
            gauge!(
                "reader_sync_queued_requests",
                "route" => route.to_owned(),
                "class" => request_class.as_str(),
                "lane" => request_lane.as_str()
            )
            .increment(1.0);
            let remaining = deadline.saturating_duration_since(Instant::now());
            let permit = timeout(remaining, execution_slots.acquire_owned()).await;
            gauge!(
                "reader_sync_queued_requests",
                "route" => route.to_owned(),
                "class" => request_class.as_str(),
                "lane" => request_lane.as_str()
            )
            .decrement(1.0);
            drop(queue_permit);
            if let Ok(Ok(permit)) = permit {
                permit
            } else {
                return Err(QueueRejection::Timeout);
            }
        }
        Err(TryAcquireError::Closed) => return Err(QueueRejection::Closed),
    };
    Ok(permit)
}

fn record_queue_rejection(
    route: &str,
    request_class: RequestClass,
    request_lane: RequestLane,
    rejection: QueueRejection,
) {
    counter!(
        "reader_sync_request_queue_rejections_total",
        "route" => route.to_owned(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str(),
        "reason" => rejection.as_str()
    )
    .increment(1);
}

fn record_queue_wait(
    route: &str,
    request_class: RequestClass,
    request_lane: RequestLane,
    outcome: &'static str,
    elapsed: std::time::Duration,
) {
    histogram!(
        "reader_sync_request_queue_wait_seconds",
        "route" => route.to_owned(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str(),
        "outcome" => outcome
    )
    .record(elapsed.as_secs_f64());
}

fn record_response(
    route: &str,
    request_class: RequestClass,
    request_lane: RequestLane,
    response: &Response,
) {
    let status = response.status().as_u16().to_string();
    counter!("reader_sync_requests_total", "status" => status.clone()).increment(1);
    counter!(
        "reader_sync_requests_by_route_total",
        "route" => route.to_owned(),
        "class" => request_class.as_str(),
        "lane" => request_lane.as_str(),
        "status" => status
    )
    .increment(1);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestClass {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RequestLane {
    Read,
    Checkpoint,
    Write,
}

#[derive(Clone, Copy, Debug)]
enum QueueRejection {
    Full,
    Timeout,
    Closed,
}

impl QueueRejection {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Full => "queue_full",
            Self::Timeout => "queue_timeout",
            Self::Closed => "queue_closed",
        }
    }
}

impl RequestClass {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }
}

impl RequestLane {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Checkpoint => "checkpoint",
            Self::Write => "write",
        }
    }
}

fn request_class(request: &Request) -> RequestClass {
    if request.method().is_safe() {
        RequestClass::Read
    } else {
        RequestClass::Write
    }
}

fn request_lane(request: &Request, route: &str) -> RequestLane {
    if request.method().is_safe()
        && matches!(
            route,
            "/v1/sync/checkpoint" | "/v1/auth/me" | "/v1/auth/usage"
        )
    {
        RequestLane::Checkpoint
    } else if request.method().is_safe() {
        RequestLane::Read
    } else {
        RequestLane::Write
    }
}

pub async fn require_protocol_v5(request: Request, next: Next) -> Response {
    let context = request
        .extensions()
        .get::<RequestContext>()
        .copied()
        .unwrap_or_default();
    let supported = request
        .headers()
        .get("x-sync-protocol-version")
        .and_then(|value| value.to_str().ok())
        == Some("5");
    if !supported {
        return ApiError::UnsupportedProtocol.response(context);
    }
    next.run(request).await
}

/// Prevents authentication and synchronization responses from being cached.
pub async fn no_store(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub fn matched_route(request: &Request) -> &str {
    request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str)
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use axum::{
        Router,
        body::Body,
        http::{Request, StatusCode},
        middleware as axum_middleware,
        routing::{get, post},
    };
    use metrics_exporter_prometheus::PrometheusBuilder;
    use tokio::{sync::Semaphore, time::sleep};
    use tower::ServiceExt;

    use crate::{config::Config, pool_for_test, state::AppState};

    use super::protect;

    fn state(read_slots: usize, write_slots: usize, queue_timeout: Duration) -> AppState {
        let mut config = Config::for_test("postgresql://unused:unused@127.0.0.1:1/unused");
        config.max_concurrent_requests = read_slots;
        config.max_concurrent_checkpoint_requests = 1;
        config.max_concurrent_write_requests = write_slots;
        config.max_queued_read_requests = 2;
        config.max_queued_checkpoint_requests = 1;
        config.max_queued_write_requests = 2;
        config.request_queue_timeout = queue_timeout;
        let recorder = PrometheusBuilder::new().build_recorder();
        AppState {
            pool: pool_for_test(),
            metrics: recorder.handle(),
            request_slots: Arc::new(Semaphore::new(read_slots)),
            checkpoint_request_slots: Arc::new(Semaphore::new(
                config.max_concurrent_checkpoint_requests,
            )),
            read_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_read_requests)),
            checkpoint_request_queue_slots: Arc::new(Semaphore::new(
                config.max_queued_checkpoint_requests,
            )),
            write_request_slots: Arc::new(Semaphore::new(write_slots)),
            write_request_queue_slots: Arc::new(Semaphore::new(config.max_queued_write_requests)),
            password_slots: Arc::new(Semaphore::new(config.max_concurrent_password_operations)),
            token_hmac_key: config.token_hmac_key.clone(),
            config,
        }
    }

    fn protected_service(state: AppState) -> Router {
        Router::new()
            .route("/read", get(|| async { StatusCode::NO_CONTENT }))
            .route(
                "/v1/sync/checkpoint",
                get(|| async { StatusCode::NO_CONTENT }),
            )
            .route("/write", post(|| async { StatusCode::NO_CONTENT }))
            .layer(axum_middleware::from_fn_with_state(state, protect))
    }

    #[tokio::test]
    async fn keeps_read_capacity_available_when_writes_are_full() {
        let service = protected_service(state(1, 0, Duration::from_millis(5)));
        let read = service
            .clone()
            .oneshot(
                Request::get("/read")
                    .body(Body::empty())
                    .expect("read request"),
            )
            .await
            .expect("read response");
        assert_eq!(read.status(), StatusCode::NO_CONTENT);

        let write = service
            .oneshot(
                Request::post("/write")
                    .body(Body::empty())
                    .expect("write request"),
            )
            .await
            .expect("write response");
        assert_eq!(write.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn contended_write_does_not_consume_a_read_execution_slot() {
        let state = state(1, 1, Duration::from_millis(100));
        let held_write_slot = state
            .write_request_slots
            .clone()
            .acquire_owned()
            .await
            .expect("write slot");
        let service = protected_service(state);
        let queued_write = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .oneshot(
                        Request::post("/write")
                            .body(Body::empty())
                            .expect("write request"),
                    )
                    .await
                    .expect("write response")
            }
        });
        sleep(Duration::from_millis(10)).await;
        let read = service
            .oneshot(
                Request::get("/read")
                    .body(Body::empty())
                    .expect("read request"),
            )
            .await
            .expect("read response");
        assert_eq!(read.status(), StatusCode::NO_CONTENT);
        drop(held_write_slot);
        assert_eq!(
            queued_write.await.expect("join write").status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn checkpoint_stays_available_when_ordinary_reads_are_full() {
        let state = state(1, 1, Duration::from_millis(5));
        let held_read_slot = state
            .request_slots
            .clone()
            .acquire_owned()
            .await
            .expect("ordinary read slot");
        let service = protected_service(state);
        let checkpoint = service
            .oneshot(
                Request::get("/v1/sync/checkpoint")
                    .body(Body::empty())
                    .expect("checkpoint request"),
            )
            .await
            .expect("checkpoint response");
        assert_eq!(checkpoint.status(), StatusCode::NO_CONTENT);
        drop(held_read_slot);
    }

    #[tokio::test]
    async fn checkpoint_exhaustion_does_not_consume_an_ordinary_read_slot() {
        let state = state(1, 1, Duration::from_millis(5));
        let held_checkpoint_slot = state
            .checkpoint_request_slots
            .clone()
            .acquire_owned()
            .await
            .expect("checkpoint slot");
        let service = protected_service(state);
        let read = service
            .oneshot(
                Request::get("/read")
                    .body(Body::empty())
                    .expect("read request"),
            )
            .await
            .expect("read response");
        assert_eq!(read.status(), StatusCode::NO_CONTENT);
        drop(held_checkpoint_slot);
    }

    #[tokio::test]
    async fn waits_briefly_for_an_execution_slot_before_rejecting() {
        let state = state(1, 1, Duration::from_millis(100));
        let held_slot = state
            .request_slots
            .clone()
            .acquire_owned()
            .await
            .expect("read slot");
        let service = protected_service(state);
        let pending = tokio::spawn(async move {
            service
                .oneshot(
                    Request::get("/read")
                        .body(Body::empty())
                        .expect("read request"),
                )
                .await
                .expect("read response")
        });
        sleep(Duration::from_millis(10)).await;
        drop(held_slot);
        assert_eq!(
            pending.await.expect("join response").status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn rejects_when_the_read_waiting_room_is_full_with_a_retry_hint() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let metrics = recorder.handle();
        let _local_recorder = metrics::set_default_local_recorder(&recorder);
        let mut state = state(1, 1, Duration::from_millis(100));
        state.read_request_queue_slots = Arc::new(Semaphore::new(1));
        let held_slot = state
            .request_slots
            .clone()
            .acquire_owned()
            .await
            .expect("read slot");
        let service = protected_service(state);
        let queued_read = tokio::spawn({
            let service = service.clone();
            async move {
                service
                    .oneshot(
                        Request::get("/read")
                            .body(Body::empty())
                            .expect("queued read request"),
                    )
                    .await
                    .expect("queued read response")
            }
        });
        sleep(Duration::from_millis(10)).await;

        let rejected = service
            .oneshot(
                Request::get("/read")
                    .body(Body::empty())
                    .expect("rejected read request"),
            )
            .await
            .expect("rejected read response");
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(rejected.headers()["retry-after"], "1");
        let rendered = metrics.render();
        assert!(rendered.contains("reader_sync_busy_rejections_total{source=\"request_queue\"} 1"));
        assert!(rendered.contains("reader_sync_api_errors_total{code=\"SERVER_BUSY\"} 1"));

        drop(held_slot);
        assert_eq!(
            queued_read.await.expect("join queued read").status(),
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn records_template_route_queue_and_handler_timings_without_request_uri() {
        let recorder = PrometheusBuilder::new().build_recorder();
        let metrics = recorder.handle();
        let _local_recorder = metrics::set_default_local_recorder(&recorder);

        let response = protected_service(state(1, 1, Duration::from_millis(5)))
            .oneshot(
                Request::get("/read?cursor=must-not-be-a-metric-label")
                    .body(Body::empty())
                    .expect("read request"),
            )
            .await
            .expect("read response");
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let rendered = metrics.render();
        assert!(rendered.contains("reader_sync_request_queue_wait_seconds"));
        assert!(rendered.contains("reader_sync_request_handler_duration_seconds"));
        assert!(rendered.contains("reader_sync_database_pool_size"));
        assert!(rendered.contains("reader_sync_database_pool_idle"));
        assert!(rendered.contains("route=\"/read\""));
        assert!(rendered.contains("class=\"read\""));
        assert!(rendered.contains("lane=\"read\""));
        assert!(!rendered.contains("cursor=must-not-be-a-metric-label"));
    }
}
