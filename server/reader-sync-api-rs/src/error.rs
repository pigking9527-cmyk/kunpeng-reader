use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::middleware::RequestContext;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("server is temporarily busy")]
    Busy,
    #[error("request timed out")]
    Timeout,
    #[error("sync protocol version 5 is required")]
    UnsupportedProtocol,
    #[error("invalid username or password")]
    InvalidCredentials,
    #[error("authentication is required")]
    Unauthorized,
    #[error("account is disabled")]
    AccountDisabled,
    #[error("verified email is required")]
    EmailVerificationRequired,
    #[error("intelligence access is not enabled for this account")]
    IntelligenceAccessDenied,
    #[error("an intelligence publisher credential is required")]
    IntelligencePublisherRequired,
    #[error("private intelligence-host inference is disabled")]
    IntelligenceHostInferenceDisabled,
    #[error("an intelligence-host capability credential is required")]
    IntelligenceHostCredentialRequired,
    #[error("idempotency key was already used for different content")]
    IdempotencyKeyReused,
    #[error("data generation does not match")]
    DataGenerationMismatch,
    #[error("mutation id was already used for different content")]
    IdempotencyConflict,
    #[error("active device limit reached")]
    DeviceLimitReached,
    #[error("verification challenge is invalid or expired")]
    VerificationInvalid,
    #[error("account name or email is unavailable")]
    AccountUnavailable,
    #[error("an email is already bound")]
    EmailAlreadyBound,
    #[error("no verified email is bound")]
    EmailNotBound,
    #[error("email verification is invalid or expired")]
    EmailVerificationInvalid,
    #[error("email rebind grant is invalid or expired")]
    RebindGrantInvalid,
    #[error("new email must differ from the current email")]
    EmailUnchanged,
    #[error("account deletion confirmation does not match")]
    AccountConfirmationMismatch,
    #[error("email verification registration is required")]
    RegistrationEmailRequired,
    #[error("registration email delivery is unavailable")]
    RegistrationUnavailable,
    #[error("phone registration delivery is unavailable")]
    PhoneRegistrationUnavailable,
    #[error("daily SMS safety budget exceeded")]
    SmsBudgetExceeded,
    #[error("rate limit exceeded")]
    RateLimited,
    #[error("synchronization quota exceeded")]
    SyncQuotaExceeded,
    #[error("invalid request")]
    InvalidRequest,
    #[error("database is unavailable")]
    DatabaseUnavailable,
    #[error("route not found")]
    NotFound,
    #[error("internal server error")]
    Internal,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    pub error: ErrorDetail,
}

#[derive(Debug, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorDetail {
    pub code: &'static str,
    pub message: &'static str,
    pub request_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_seconds: Option<u64>,
}

impl ApiError {
    #[must_use]
    pub fn response(self, context: RequestContext) -> Response {
        let (status, code, message, retry_after) = self.response_details();
        metrics::counter!("reader_sync_api_errors_total", "code" => code).increment(1);
        let mut response = (
            status,
            Json(ErrorBody {
                error: ErrorDetail {
                    code,
                    message,
                    request_id: context.request_id,
                    retry_after_seconds: retry_after,
                },
            }),
        )
            .into_response();
        if let Some(seconds) = retry_after
            && let Ok(value) = HeaderValue::from_str(&seconds.to_string())
        {
            response.headers_mut().insert(RETRY_AFTER, value);
        }
        response
    }

    #[allow(clippy::too_many_lines)]
    fn response_details(self) -> (StatusCode, &'static str, &'static str, Option<u64>) {
        if let Some(details) = self.registration_response_details() {
            return details;
        }
        match self {
            Self::Busy => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SERVER_BUSY",
                "server is temporarily busy",
                Some(1),
            ),
            Self::Timeout => (
                StatusCode::GATEWAY_TIMEOUT,
                "REQUEST_TIMEOUT",
                "request timed out",
                Some(1),
            ),
            Self::UnsupportedProtocol => (
                StatusCode::UPGRADE_REQUIRED,
                "SYNC_PROTOCOL_UNSUPPORTED",
                "sync protocol version 5 is required",
                None,
            ),
            Self::InvalidCredentials => (
                StatusCode::UNAUTHORIZED,
                "INVALID_CREDENTIALS",
                "invalid username or password",
                None,
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "UNAUTHORIZED",
                "authentication is required",
                None,
            ),
            Self::AccountDisabled => (
                StatusCode::FORBIDDEN,
                "ACCOUNT_DISABLED",
                "account is disabled",
                None,
            ),
            Self::EmailVerificationRequired => (
                StatusCode::FORBIDDEN,
                "EMAIL_VERIFICATION_REQUIRED",
                "verified email is required",
                None,
            ),
            Self::IntelligenceAccessDenied => (
                StatusCode::FORBIDDEN,
                "INTELLIGENCE_ACCESS_DENIED",
                "intelligence access is not enabled for this account",
                None,
            ),
            Self::IntelligencePublisherRequired => (
                StatusCode::FORBIDDEN,
                "INTELLIGENCE_PUBLISHER_REQUIRED",
                "an intelligence publisher credential is required",
                None,
            ),
            Self::IntelligenceHostInferenceDisabled => (
                StatusCode::FORBIDDEN,
                "INTELLIGENCE_HOST_INFERENCE_DISABLED",
                "private intelligence-host inference is disabled",
                None,
            ),
            Self::IntelligenceHostCredentialRequired => (
                StatusCode::FORBIDDEN,
                "INTELLIGENCE_HOST_CREDENTIAL_REQUIRED",
                "an intelligence-host capability credential is required",
                None,
            ),
            Self::IdempotencyKeyReused => (
                StatusCode::CONFLICT,
                "IDEMPOTENCY_KEY_REUSED",
                "idempotency key was already used for different content",
                None,
            ),
            Self::DataGenerationMismatch => (
                StatusCode::CONFLICT,
                "DATA_GENERATION_MISMATCH",
                "data generation does not match",
                None,
            ),
            Self::IdempotencyConflict => (
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "mutation id was already used for different content",
                None,
            ),
            Self::DeviceLimitReached => (
                StatusCode::CONFLICT,
                "DEVICE_LIMIT_REACHED",
                "active device limit reached",
                None,
            ),
            Self::VerificationInvalid
            | Self::AccountUnavailable
            | Self::EmailAlreadyBound
            | Self::EmailNotBound
            | Self::EmailVerificationInvalid
            | Self::RebindGrantInvalid
            | Self::EmailUnchanged
            | Self::AccountConfirmationMismatch
            | Self::RegistrationEmailRequired
            | Self::RegistrationUnavailable
            | Self::PhoneRegistrationUnavailable
            | Self::SmsBudgetExceeded
            | Self::RateLimited => unreachable!("handled above"),
            Self::SyncQuotaExceeded => (
                StatusCode::TOO_MANY_REQUESTS,
                "SYNC_QUOTA_EXCEEDED",
                "synchronization quota exceeded",
                Some(3600),
            ),
            Self::InvalidRequest => (
                StatusCode::BAD_REQUEST,
                "INVALID_REQUEST",
                "invalid request",
                None,
            ),
            Self::DatabaseUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "DATABASE_UNAVAILABLE",
                "database is unavailable",
                Some(2),
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND", "route not found", None),
            Self::Internal => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                "internal server error",
                None,
            ),
        }
    }

    fn registration_response_details(
        &self,
    ) -> Option<(StatusCode, &'static str, &'static str, Option<u64>)> {
        match self {
            Self::VerificationInvalid => Some((
                StatusCode::BAD_REQUEST,
                "INVALID_OR_EXPIRED_CODE",
                "verification challenge is invalid or expired",
                None,
            )),
            Self::AccountUnavailable => Some((
                StatusCode::CONFLICT,
                "REGISTRATION_CONFLICT",
                "account name or email is unavailable",
                None,
            )),
            Self::EmailAlreadyBound => Some((
                StatusCode::CONFLICT,
                "EMAIL_ALREADY_BOUND",
                "an email is already bound",
                None,
            )),
            Self::EmailNotBound => Some((
                StatusCode::BAD_REQUEST,
                "EMAIL_NOT_BOUND",
                "no verified email is bound",
                None,
            )),
            Self::EmailVerificationInvalid => Some((
                StatusCode::BAD_REQUEST,
                "INVALID_OR_EXPIRED_CODE",
                "email verification is invalid or expired",
                None,
            )),
            Self::RebindGrantInvalid => Some((
                StatusCode::BAD_REQUEST,
                "INVALID_OR_EXPIRED_REBIND_GRANT",
                "email rebind grant is invalid or expired",
                None,
            )),
            Self::EmailUnchanged => Some((
                StatusCode::BAD_REQUEST,
                "EMAIL_UNCHANGED",
                "new email must differ from the current email",
                None,
            )),
            Self::AccountConfirmationMismatch => Some((
                StatusCode::BAD_REQUEST,
                "ACCOUNT_CONFIRMATION_MISMATCH",
                "account deletion confirmation does not match",
                None,
            )),
            Self::RegistrationEmailRequired => Some((
                StatusCode::CONFLICT,
                "REGISTRATION_EMAIL_REQUIRED",
                "use the two-stage email verification registration flow",
                None,
            )),
            Self::RegistrationUnavailable => Some((
                StatusCode::SERVICE_UNAVAILABLE,
                "REGISTRATION_UNAVAILABLE",
                "registration email delivery is unavailable",
                Some(5),
            )),
            Self::PhoneRegistrationUnavailable => Some((
                StatusCode::SERVICE_UNAVAILABLE,
                "PHONE_REGISTRATION_UNAVAILABLE",
                "phone registration delivery is unavailable",
                Some(5),
            )),
            Self::SmsBudgetExceeded => Some((
                StatusCode::SERVICE_UNAVAILABLE,
                "SMS_BUDGET_EXCEEDED",
                "daily SMS safety budget exceeded",
                None,
            )),
            Self::RateLimited => Some((
                StatusCode::TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "rate limit exceeded",
                Some(60),
            )),
            _ => None,
        }
    }
}
