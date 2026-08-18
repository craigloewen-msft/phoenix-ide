//! LLM error types

use super::rate_limit::QuotaDetails;
use chrono::{DateTime, Datelike, Local, Utc};
use thiserror::Error;

/// LLM error with classification
#[derive(Debug, Error)]
#[error("{message}")]
pub struct LlmError {
    pub kind: LlmErrorKind,
    pub message: String,
    /// When true, a recovery mechanism (e.g. credential helper) is actively
    /// running and may resolve this error. The state machine should wait
    /// rather than treat it as terminal.
    pub recovery_in_progress: bool,
    /// Present iff `kind == UsageLimitReached`. Structured payload extracted
    /// from the codex backend's 429 response (body + headers). Used to render
    /// plan-aware messages and (later) drive a quota status indicator. Boxed
    /// because `UsageLimitReached` is the rare path and this keeps `LlmError`
    /// small enough that `Result<_, LlmError>` stays under clippy's
    /// `result_large_err` threshold across the LLM hot path.
    pub quota: Option<Box<QuotaDetails>>,
}

impl LlmError {
    pub fn new(kind: LlmErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            recovery_in_progress: false,
            quota: None,
        }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::Network, message)
    }

    pub fn rate_limit(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::RateLimit, message)
    }

    pub fn server_error(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::ServerError, message)
    }

    pub fn server_overloaded(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::ServerOverloaded, message)
    }

    #[must_use]
    pub fn usage_limit_reached(quota: QuotaDetails) -> Self {
        let message = render_usage_limit_message(&quota);
        Self {
            kind: LlmErrorKind::UsageLimitReached,
            message,
            recovery_in_progress: false,
            quota: Some(Box::new(quota)),
        }
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::Auth, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::InvalidRequest, message)
    }

    #[allow(dead_code)] // Will be used when providers detect content filter responses
    pub fn content_filter(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::ContentFilter, message)
    }

    #[allow(dead_code)] // Will be used when providers detect context window errors
    pub fn context_window_exceeded(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::ContextWindowExceeded, message)
    }
}

// LlmErrorKind / LlmAttemptReason are co-owned by the llm layer (producer),
// the runtime/state-machine (retry classification), and api/wire
// (serialization). They live in the base crate; re-export so
// `crate::error::…` and `crate::…` paths are unchanged.
pub use phoenix_core::domain::llm_error_kind::{LlmAttemptReason, LlmErrorKind};

impl LlmError {
    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self::new(LlmErrorKind::InvalidResponse, message)
    }

    #[must_use]
    pub fn from_http_status(status: u16, body: &str) -> Self {
        match status {
            401 | 403 => Self::auth(format!("Authentication failed: {body}")),
            429 => Self::rate_limit(format!("Rate limited: {body}")),
            400..=499 => Self::invalid_request(format!("Bad request ({status}): {body}")),
            500..=599 => Self::server_error(format!("Server error ({status}): {body}")),
            _ => Self::server_error(format!("Unexpected HTTP {status}: {body}")),
        }
    }
}

/// Render a plan-aware "usage limit reached" message for the codex backend.
///
/// Wording mirrors the codex CLI's `UsageLimitReachedError::fmt`
/// (`/tmp/codex/codex-rs/protocol/src/error.rs:453-517`) verbatim so users see
/// the same recovery instructions across tools.
fn render_usage_limit_message(quota: &QuotaDetails) -> String {
    // 1. Per-model limit override: when `limit_name` is set and isn't the
    //    generic "codex" family, the user can switch models to keep working.
    if let Some(limit_name) = quota
        .limit_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        if !limit_name.eq_ignore_ascii_case("codex") {
            return format!(
                "You've hit your usage limit for {limit_name}. Switch to another model now,{}",
                retry_suffix_after_or(quota.resets_at.as_ref())
            );
        }
    }

    if matches!(
        quota.rate_limit_reached_type,
        Some(crate::rate_limit::RateLimitReachedType::WorkspaceOwnerCreditsDepleted)
    ) {
        return format!(
            "Your workspace has run out of Codex credits. Visit https://chatgpt.com/codex/settings/usage to purchase more credits{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        );
    }

    if matches!(
        quota.rate_limit_reached_type,
        Some(crate::rate_limit::RateLimitReachedType::WorkspaceOwnerUsageLimitReached)
    ) {
        return format!(
            "Your workspace usage limit has been reached. Visit https://chatgpt.com/codex/settings/usage to manage the limit{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        );
    }

    // 2. Backend-provided promo message wins over plan-specific defaults.
    if let Some(promo) = quota.promo_message.as_deref() {
        return format!(
            "You've hit your usage limit. {promo},{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        );
    }

    // 3. Plan-aware defaults. Plan-type strings are matched case-insensitively
    //    against the values the codex backend sends.
    let plan = quota.plan_type.as_deref().map(str::to_ascii_lowercase);
    match plan.as_deref() {
        Some("plus") => format!(
            "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        ),
        Some(
            "team"
            | "business"
            | "self_serve_business_usage_based"
            | "enterprise_cbp_usage_based",
        ) => format!(
            "You've hit your usage limit. To get more access now, send a request to your admin{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        ),
        Some("free" | "go") => format!(
            "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus),{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        ),
        Some("pro" | "pro_lite") => format!(
            "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits{}",
            retry_suffix_after_or(quota.resets_at.as_ref())
        ),
        // Enterprise / Edu and unknown / absent plans all collapse to the
        // generic wording. Codex CLI keeps these as separate match arms for
        // documentation; we merge to satisfy clippy::match_same_arms.
        _ => format!(
            "You've hit your usage limit.{}",
            retry_suffix(quota.resets_at.as_ref())
        ),
    }
}

fn retry_suffix(resets_at: Option<&DateTime<Utc>>) -> String {
    match resets_at {
        Some(ts) => format!(" Try again at {}.", format_retry_timestamp(ts)),
        None => " Try again later.".to_string(),
    }
}

fn retry_suffix_after_or(resets_at: Option<&DateTime<Utc>>) -> String {
    match resets_at {
        Some(ts) => format!(" or try again at {}.", format_retry_timestamp(ts)),
        None => " or try again later.".to_string(),
    }
}

fn format_retry_timestamp(resets_at: &DateTime<Utc>) -> String {
    let local_reset = resets_at.with_timezone(&Local);
    let local_now = now_for_retry().with_timezone(&Local);
    if local_reset.date_naive() == local_now.date_naive() {
        local_reset.format("%-I:%M %p").to_string()
    } else {
        let suffix = day_suffix(local_reset.day());
        local_reset
            .format(&format!("%b %-d{suffix}, %Y %-I:%M %p"))
            .to_string()
    }
}

fn day_suffix(day: u32) -> &'static str {
    match day {
        11..=13 => "th",
        _ => match day % 10 {
            1 => "st",
            2 => "nd",
            3 => "rd",
            _ => "th",
        },
    }
}

fn now_for_retry() -> DateTime<Utc> {
    Utc::now()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rate_limit::QuotaDetails;

    fn quota(plan: Option<&str>, resets_at: Option<DateTime<Utc>>) -> QuotaDetails {
        QuotaDetails {
            plan_type: plan.map(str::to_string),
            resets_at,
            limit_id: None,
            limit_name: None,
            primary: None,
            secondary: None,
            additional_limits: Vec::new(),
            credits: None,
            individual_limit: None,
            promo_message: None,
            rate_limit_reached_type: None,
        }
    }

    #[test]
    fn http_status_classification_preserves_actionable_provider_detail() {
        let cases = [
            (
                401,
                LlmErrorKind::Auth,
                "Authentication failed: invalid API key",
            ),
            (
                429,
                LlmErrorKind::RateLimit,
                "Rate limited: retry after 30 seconds",
            ),
            (
                400,
                LlmErrorKind::InvalidRequest,
                "Bad request (400): context window exceeded",
            ),
            (
                503,
                LlmErrorKind::ServerError,
                "Server error (503): overloaded",
            ),
            (
                302,
                LlmErrorKind::ServerError,
                "Unexpected HTTP 302: redirect rejected",
            ),
        ];

        for (status, kind, expected) in cases {
            let detail = expected
                .rsplit_once(": ")
                .map_or(expected, |(_, detail)| detail);
            let error = LlmError::from_http_status(status, detail);
            assert_eq!(error.kind, kind);
            assert_eq!(error.message, expected);
        }
    }

    #[test]
    fn workspace_owner_credit_depletion_uses_purchase_guidance() {
        let mut details = quota(Some("team"), None);
        details.rate_limit_reached_type =
            Some(crate::rate_limit::RateLimitReachedType::WorkspaceOwnerCreditsDepleted);
        let message = render_usage_limit_message(&details);
        assert!(message.contains("purchase more credits"));
        assert!(!message.contains("request to your admin"));
    }

    #[test]
    fn all_error_kinds_have_explicit_auto_retry_and_user_resume_policy() {
        use phoenix_core::domain::retry_policy::{AutoRetryPolicy, UserResumePolicy};
        use AutoRetryPolicy::{AutoRetryable, NoAutoRetry};
        use LlmErrorKind::{
            Auth, ContentFilter, ContextWindowExceeded, InvalidRequest, InvalidResponse, Network,
            RateLimit, ServerError, ServerOverloaded, UsageLimitReached,
        };
        use UserResumePolicy::{NotResumable, Resumable};

        let cases = [
            (Network, AutoRetryable, Resumable),
            (RateLimit, AutoRetryable, Resumable),
            (UsageLimitReached, NoAutoRetry, Resumable),
            (ServerError, AutoRetryable, Resumable),
            (InvalidResponse, AutoRetryable, Resumable),
            (ServerOverloaded, NoAutoRetry, Resumable),
            (Auth, NoAutoRetry, Resumable),
            (InvalidRequest, NoAutoRetry, NotResumable),
            (ContentFilter, NoAutoRetry, NotResumable),
            (ContextWindowExceeded, NoAutoRetry, NotResumable),
        ];

        for (kind, auto_retry, user_resume) in cases {
            assert_eq!(
                kind.auto_retry_policy(),
                auto_retry,
                "auto retry for {kind:?}"
            );
            assert_eq!(
                kind.user_resume_policy(),
                user_resume,
                "user resume for {kind:?}"
            );
        }
    }
}
