use std::{
    net::{IpAddr, SocketAddr},
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    Extension, Json,
    extract::{ConnectInfo, State, rejection::JsonRejection},
    http::HeaderMap,
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sqlx::types::Json as SqlJson;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    credentials::rate_limit_subject_digest, error::ApiError, middleware::RequestContext,
    rate_limit::check_feedback_limits, state::AppState,
};

const MAX_TEXT_CHARS: usize = 20_000;
const MAX_APP_VERSION_CHARS: usize = 80;
const MAX_PLATFORM_CHARS: usize = 500;
const MAX_IMAGES: usize = 3;
const MAX_IMAGE_NAME_CHARS: usize = 160;
const MAX_IMAGE_BYTES: usize = 1024 * 1024;
const MAX_ATTACHMENTS: usize = 1;
const MAX_ATTACHMENT_BYTES: usize = 256 * 1024;

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackImage {
    name: String,
    mime: String,
    data: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackAttachment {
    name: String,
    mime: String,
    data: String,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FeedbackRequest {
    kind: String,
    text: String,
    app_version: String,
    platform: String,
    images: Vec<FeedbackImage>,
    #[serde(default)]
    attachments: Vec<FeedbackAttachment>,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackResponse {
    pub ok: bool,
    pub id: Uuid,
    pub message: &'static str,
    pub emailed: bool,
    pub accepted_attachments: usize,
    pub request_id: Uuid,
}

#[utoipa::path(
    post,
    path = "/v1/feedback",
    request_body = FeedbackRequest,
    responses(
        (status = 201, body = FeedbackResponse),
        (status = 400, body = crate::error::ErrorBody),
        (status = 429, body = crate::error::ErrorBody),
        (status = 503, body = crate::error::ErrorBody)
    )
)]
pub async fn submit(
    State(state): State<AppState>,
    Extension(context): Extension<RequestContext>,
    peer: Option<Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    input: Result<Json<FeedbackRequest>, JsonRejection>,
) -> Response {
    let Ok(Json(input)) = input else {
        return ApiError::InvalidRequest.response(context);
    };
    if validate(&input).is_err() {
        return ApiError::InvalidRequest.response(context);
    }
    let client_ip = client_ip(&state, peer.map(|Extension(peer)| peer.0), &headers);
    if let Err(error) = check_feedback_limits(&state, client_ip).await {
        return error.response(context);
    }
    match persist(&state, input, client_ip).await {
        Ok((id, accepted_attachments)) => (
            axum::http::StatusCode::CREATED,
            Json(FeedbackResponse {
                ok: true,
                id,
                message: "反馈已接收。",
                // Feedback recipients are deliberately not configured through
                // the registration SMTP settings. Do not claim mail delivery.
                emailed: false,
                accepted_attachments,
                request_id: context.request_id,
            }),
        )
            .into_response(),
        Err(error) => error.response(context),
    }
}

fn validate(input: &FeedbackRequest) -> Result<(), ()> {
    if !matches!(input.kind.as_str(), "bug" | "feature")
        || input.text.chars().count() > MAX_TEXT_CHARS
        || input.app_version.chars().count() > MAX_APP_VERSION_CHARS
        || input.platform.chars().count() > MAX_PLATFORM_CHARS
        || input.images.len() > MAX_IMAGES
        || input.attachments.len() > MAX_ATTACHMENTS
        || (input.kind != "bug" && !input.attachments.is_empty())
    {
        return Err(());
    }
    for image in &input.images {
        if image.name.is_empty()
            || image.name.chars().count() > MAX_IMAGE_NAME_CHARS
            || !matches!(
                image.mime.as_str(),
                "image/jpeg" | "image/png" | "image/webp"
            )
        {
            return Err(());
        }
        let bytes = STANDARD.decode(&image.data).map_err(|_| ())?;
        if bytes.is_empty()
            || bytes.len() > MAX_IMAGE_BYTES
            || !matches_image_magic(&image.mime, &bytes)
        {
            return Err(());
        }
    }
    for attachment in &input.attachments {
        if attachment.name.is_empty()
            || attachment.name.chars().count() > MAX_IMAGE_NAME_CHARS
            || attachment.mime != "application/json"
            || !attachment.name.to_ascii_lowercase().ends_with(".json")
        {
            return Err(());
        }
        let bytes = STANDARD.decode(&attachment.data).map_err(|_| ())?;
        if !(1..=MAX_ATTACHMENT_BYTES).contains(&bytes.len()) {
            return Err(());
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| ())?;
        serde_json::from_str::<serde_json::Value>(text).map_err(|_| ())?;
    }
    Ok(())
}

fn matches_image_magic(mime: &str, bytes: &[u8]) -> bool {
    match mime {
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    }
}

async fn persist(
    state: &AppState,
    input: FeedbackRequest,
    client_ip: IpAddr,
) -> Result<(Uuid, usize), ApiError> {
    let client_ip_digest = rate_limit_subject_digest(
        &state.token_hmac_key,
        "feedback-client-ip",
        &client_ip.to_string(),
    )
    .map_err(|_| ApiError::Internal)?;
    let id = Uuid::new_v4();
    let accepted_attachments = input.attachments.len();
    sqlx::query(
        "INSERT INTO feedback_v4 \
         (id,kind,text,images_json,attachments_json,app_version,platform,client_ip_digest,created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(id)
    .bind(input.kind)
    .bind(input.text)
    .bind(SqlJson(input.images))
    .bind(SqlJson(input.attachments))
    .bind(input.app_version)
    .bind(input.platform)
    .bind(client_ip_digest.as_slice())
    .bind(now_ms())
    .execute(&state.pool)
    .await
    .map_err(|_| ApiError::DatabaseUnavailable)?;
    Ok((id, accepted_attachments))
}

fn client_ip(state: &AppState, peer: Option<SocketAddr>, headers: &HeaderMap) -> IpAddr {
    let peer = peer.map_or(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), |peer| peer.ip());
    if state.config.trust_loopback_proxy_headers
        && peer.is_loopback()
        && let Some(forwarded) = headers
            .get("x-real-ip")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.trim().parse().ok())
    {
        return forwarded;
    }
    peer
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> FeedbackRequest {
        FeedbackRequest {
            kind: "bug".to_owned(),
            text: "页面无法翻页".to_owned(),
            app_version: "1.0.0".to_owned(),
            platform: "macOS".to_owned(),
            images: vec![],
            attachments: vec![],
        }
    }

    #[test]
    fn accepts_a_bounded_utf8_json_bug_attachment() {
        let mut request = request();
        request.attachments.push(FeedbackAttachment {
            name: "problem-state.json".to_owned(),
            mime: "application/json".to_owned(),
            data: STANDARD.encode(br#"{"events":[]}"#),
        });
        assert!(validate(&request).is_ok());
    }

    #[test]
    fn rejects_feature_attachments_and_invalid_json() {
        let mut request = request();
        request.kind = "feature".to_owned();
        request.attachments.push(FeedbackAttachment {
            name: "proposal.json".to_owned(),
            mime: "application/json".to_owned(),
            data: STANDARD.encode(br"{}"),
        });
        assert!(validate(&request).is_err());
        request.kind = "bug".to_owned();
        request.attachments[0].data = STANDARD.encode(b"not json");
        assert!(validate(&request).is_err());
    }

    #[test]
    fn rejects_oversized_attachment_and_image_with_wrong_magic() {
        let mut request = request();
        request.attachments.push(FeedbackAttachment {
            name: "too-large.json".to_owned(),
            mime: "application/json".to_owned(),
            data: STANDARD.encode(vec![b' '; MAX_ATTACHMENT_BYTES]),
        });
        assert!(validate(&request).is_err());
        request.attachments.clear();
        request.images.push(FeedbackImage {
            name: "not-a-photo.jpg".to_owned(),
            mime: "image/jpeg".to_owned(),
            data: STANDARD.encode(b"not a JPEG"),
        });
        assert!(validate(&request).is_err());
    }
}
