use std::{sync::Arc, time::Instant};

use axum::{
    extract::{MatchedPath, Request, State},
    http::{HeaderName, HeaderValue, header},
    middleware::Next,
    response::Response,
};
use metrics::{counter, gauge, histogram};
use tokio::{sync::Semaphore, time::timeout};
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
    let Ok(_permit) = Arc::<Semaphore>::clone(&state.request_slots).try_acquire_owned() else {
        return ApiError::Busy.response(context);
    };
    let started = Instant::now();
    gauge!("reader_sync_active_requests").increment(1.0);
    let response = match timeout(state.config.request_timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => ApiError::Timeout.response(context),
    };
    gauge!("reader_sync_active_requests").decrement(1.0);
    counter!("reader_sync_requests_total", "status" => response.status().as_u16().to_string())
        .increment(1);
    histogram!("reader_sync_request_duration_seconds").record(started.elapsed().as_secs_f64());
    response
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
