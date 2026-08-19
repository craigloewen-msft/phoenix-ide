//! Unified LLM service implementation

use super::models::{ApiFormat, ModelSpec};
use super::types::{LlmRequest, LlmResponse};
use super::{
    anthropic, openai, CodexCredential, LlmAuth, LlmError, LlmService, TokenChunk,
    CODEX_BACKEND_URL,
};
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

/// Empty placeholder used when no tags should be forwarded — keeps the
/// provider-call signatures uniform without allocating per request.
fn empty_tags() -> &'static BTreeMap<String, String> {
    use std::sync::OnceLock;
    static EMPTY: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    EMPTY.get_or_init(BTreeMap::new)
}

enum ServiceAuth {
    Required(LlmAuth),
    None,
}

impl ServiceAuth {
    async fn resolve_required(&self) -> Result<super::ResolvedAuth, LlmError> {
        match self {
            Self::Required(auth) => auth.resolve().await,
            Self::None => Err(LlmError::invalid_request(
                "Unauthenticated LLM route cannot use an authenticated wire backend",
            )),
        }
    }

    async fn resolve_optional_bearer(&self) -> Result<Option<String>, LlmError> {
        match self {
            Self::Required(auth) => Ok(Some(auth.resolve().await?.credential)),
            Self::None => Ok(None),
        }
    }

    async fn invalidate(&self) -> bool {
        match self {
            Self::Required(auth) => auth.invalidate().await,
            Self::None => false,
        }
    }

    const fn is_required(&self) -> bool {
        matches!(self, Self::Required(_))
    }
}

/// Unified service implementation that dispatches by API format
pub struct LlmServiceImpl {
    pub spec: ModelSpec,
    auth: ServiceAuth,
    telemetry_provider: &'static str,
    pub anthropic_base_url: Option<String>,
    pub openai_responses_base_url: Option<String>,
    pub openai_chat_completions_base_url: Option<String>,
    pub custom_headers: Vec<(String, String)>,
    /// Free-form metadata pairs injected as a top-level `tags` object on
    /// every outbound request. Phoenix doesn't interpret these — they're a
    /// pass-through channel for whatever proxy the request is routed
    /// through. Attached only when the request is going to a non-default
    /// endpoint (`*_base_url`); direct provider APIs reject unknown top-level
    /// fields. See `effective_request_tags`.
    pub request_tags: BTreeMap<String, String>,
    /// When true, `OpenAI` Responses requests target the `ChatGPT` backend
    /// (`chatgpt.com/backend-api/codex`) and the request body is adjusted:
    /// `store: false` is set and a default `instructions` value is injected
    /// when the caller did not provide one.
    pub use_codex_backend: bool,
    /// Concrete `CodexCredential` reference used to source the
    /// `chatgpt-account-id` header per request — re-read each call so a
    /// `codex login` against a different account during the session reaches
    /// the wire instead of being pinned at registry build time.
    pub codex_credential: Option<Arc<CodexCredential>>,
    /// WebSocket continuation is shared by all calls through this service and
    /// isolated by the caller's prompt-cache cohort.
    pub(crate) codex_ws_sessions: Arc<Mutex<openai::CodexWsSessions>>,
}

impl LlmServiceImpl {
    #[must_use]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        spec: ModelSpec,
        auth: LlmAuth,
        anthropic_base_url: Option<String>,
        openai_responses_base_url: Option<String>,
        openai_chat_completions_base_url: Option<String>,
        custom_headers: Vec<(String, String)>,
        request_tags: BTreeMap<String, String>,
    ) -> Self {
        let telemetry_provider = spec.backend.header_value();
        Self {
            spec,
            auth: ServiceAuth::Required(auth),
            telemetry_provider,
            anthropic_base_url,
            openai_responses_base_url,
            openai_chat_completions_base_url,
            custom_headers,
            request_tags,
            use_codex_backend: false,
            codex_credential: None,
            codex_ws_sessions: Arc::new(Mutex::new(openai::CodexWsSessions::default())),
        }
    }

    /// Build the dedicated local Ollama route. Its lack of authentication is a
    /// typed service property, not an empty or fabricated API key.
    #[must_use]
    pub fn new_ollama(spec: ModelSpec, chat_endpoint: String) -> Self {
        debug_assert_eq!(spec.backend.api_format(), ApiFormat::OpenAIChatCompletions);
        Self {
            spec,
            auth: ServiceAuth::None,
            telemetry_provider: "ollama",
            anthropic_base_url: None,
            openai_responses_base_url: None,
            openai_chat_completions_base_url: Some(chat_endpoint),
            custom_headers: Vec::new(),
            request_tags: BTreeMap::new(),
            use_codex_backend: false,
            codex_credential: None,
            codex_ws_sessions: Arc::new(Mutex::new(openai::CodexWsSessions::default())),
        }
    }

    /// Build a service that routes `OpenAI` Responses calls through the `ChatGPT`
    /// backend (codex bridge). The base URL is forced to `CODEX_BACKEND_URL`
    /// regardless of any `OPENAI_BASE_URL` setting; `Anthropic` URL fields are
    /// ignored on this path.
    pub fn new_with_codex_backend(
        spec: ModelSpec,
        auth: LlmAuth,
        custom_headers: Vec<(String, String)>,
        codex_credential: Arc<CodexCredential>,
    ) -> Self {
        Self {
            spec,
            auth: ServiceAuth::Required(auth),
            telemetry_provider: "openai",
            anthropic_base_url: None,
            openai_responses_base_url: Some(CODEX_BACKEND_URL.to_string()),
            openai_chat_completions_base_url: None,
            custom_headers,
            // No proxy in front of the codex bridge — tags would be sent
            // directly to chatgpt.com which rejects unknown body fields.
            request_tags: BTreeMap::new(),
            use_codex_backend: true,
            codex_credential: Some(codex_credential),
            codex_ws_sessions: Arc::new(Mutex::new(openai::CodexWsSessions::default())),
        }
    }

    /// Returns the tags map to attach on the wire for this request. Empty
    /// unless the request is routed through a non-default endpoint
    /// (the API-format-specific `*_BASE_URL` override). Direct-to-provider
    /// calls go out untagged so unknown-field rejection can't break us. The
    /// codex bridge sets
    /// `request_tags = BTreeMap::new()` in its constructor, so it stays
    /// untagged even though it does set `openai_responses_base_url`.
    fn effective_request_tags(&self, format_base_url: Option<&str>) -> &BTreeMap<String, String> {
        if format_base_url.is_some() {
            &self.request_tags
        } else {
            empty_tags()
        }
    }
}

#[async_trait]
impl LlmService for LlmServiceImpl {
    async fn complete(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError> {
        let result = self.complete_inner(request).await;

        // On auth failure: invalidate credential cache and retry once (only if
        // the credential source actually had something cached to invalidate —
        // static keys can't be refreshed, so retrying would be pointless).
        if let Err(ref e) = result {
            if e.kind == super::LlmErrorKind::Auth && self.auth.invalidate().await {
                tracing::warn!(
                    model = %self.spec.id,
                    "Auth failure; credential cache invalidated, retrying"
                );
                return self.complete_inner(request).await;
            }
        }

        result
    }

    async fn complete_streaming(
        &self,
        request: &LlmRequest,
        chunk_tx: &mpsc::Sender<TokenChunk>,
    ) -> Result<LlmResponse, LlmError> {
        let result = self.complete_streaming_inner(request, chunk_tx).await;

        // On auth failure: invalidate cached credential so the next request uses
        // fresh ones, but don't retry. Retrying a stream risks sending duplicate
        // tokens through chunk_tx if any were emitted before the error.
        if let Err(ref e) = result {
            if e.kind == super::LlmErrorKind::Auth && self.auth.invalidate().await {
                tracing::warn!(
                    model = %self.spec.id,
                    "Auth failure (streaming); credential cache invalidated (next request will use fresh credentials)"
                );
            }
        }

        result
    }

    fn model_id(&self) -> &str {
        &self.spec.id
    }

    fn uses_codex_bridge(&self) -> bool {
        self.use_codex_backend
    }

    fn continuation_request_limits(&self) -> super::ContinuationRequestLimits {
        if self.use_codex_backend && self.spec.api_name.starts_with("gpt-5.6") {
            super::ContinuationRequestLimits::codex_responses_lite()
        } else if self.use_codex_backend {
            super::ContinuationRequestLimits::codex_bridge()
        } else {
            super::ContinuationRequestLimits::TokenWindowOnly
        }
    }
}

impl LlmServiceImpl {
    /// Build the custom headers for a request, auto-injecting `provider` based on the model spec.
    /// When the codex bridge is in use, the live `chatgpt-account-id` is read
    /// from the credential at every request so a mid-session account switch
    /// (signing in with Codex from Phoenix) reaches the wire.
    fn headers_for_provider(&self) -> Vec<(String, String)> {
        let mut headers = self.custom_headers.clone();
        if self.auth.is_required()
            && (!headers.is_empty()
                || self.anthropic_base_url.is_some()
                || self.openai_responses_base_url.is_some()
                || self.openai_chat_completions_base_url.is_some())
        {
            // Auto-inject provider header if not already present
            if !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("provider"))
            {
                headers.push((
                    "provider".to_string(),
                    self.spec.provider_header_value().to_string(),
                ));
            }
        }
        if let Some(ref cred) = self.codex_credential {
            if let Some(account_id) = cred.account_id() {
                if !headers
                    .iter()
                    .any(|(k, _)| k.eq_ignore_ascii_case("chatgpt-account-id"))
                {
                    headers.push(("chatgpt-account-id".to_string(), account_id));
                }
            }
            // OpenAI-Beta is required by the ChatGPT-backend Responses
            // endpoint for the experimental Responses surface; Codex CLI
            // and Pi both send it. `originator` is OpenAI's telemetry-
            // attribution channel so traffic from Phoenix is identifiable
            // alongside Codex CLI and Pi traffic.
            if !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("openai-beta"))
            {
                headers.push((
                    "OpenAI-Beta".to_string(),
                    "responses=experimental".to_string(),
                ));
            }
            if !headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("originator"))
            {
                headers.push(("originator".to_string(), "phoenix-ide".to_string()));
            }
        }
        headers
    }

    fn begin_provider_attempt(&self, request: &LlmRequest, transport: super::LlmTransport) {
        if let Some(telemetry) = &request.telemetry {
            telemetry.attempt_capture.begin(
                telemetry,
                self.telemetry_provider,
                &self.spec.id,
                transport,
            );
        }
    }

    async fn complete_inner(&self, request: &LlmRequest) -> Result<LlmResponse, LlmError> {
        match self.spec.backend.api_format() {
            ApiFormat::Anthropic => {
                let resolved = self.resolve_auth().await?;
                self.begin_provider_attempt(request, super::LlmTransport::HttpJson);
                // Build headers AFTER resolve so any per-request state the
                // credential refresh updates (notably the codex account_id
                // pulled from auth.json) is reflected in this request's
                // headers, not the previous request's snapshot.
                let headers = self.headers_for_provider();
                anthropic::complete(
                    &self.spec,
                    &resolved,
                    self.anthropic_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.anthropic_base_url.as_deref()),
                    request,
                )
                .await
            }
            ApiFormat::OpenAIResponses => {
                let key = self.auth.resolve_required().await?.credential;
                self.begin_provider_attempt(request, super::LlmTransport::HttpJson);
                let headers = self.headers_for_provider();
                openai::complete(
                    &self.spec,
                    &key,
                    self.openai_responses_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.openai_responses_base_url.as_deref()),
                    request,
                    self.use_codex_backend,
                )
                .await
            }
            ApiFormat::OpenAIChatCompletions => {
                let key = self.auth.resolve_optional_bearer().await?;
                self.begin_provider_attempt(request, super::LlmTransport::HttpJson);
                let headers = self.headers_for_provider();
                openai::complete_chat(
                    &self.spec,
                    key.as_deref(),
                    self.openai_chat_completions_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.openai_chat_completions_base_url.as_deref()),
                    request,
                )
                .await
            }
        }
    }

    async fn complete_streaming_inner(
        &self,
        request: &LlmRequest,
        chunk_tx: &mpsc::Sender<TokenChunk>,
    ) -> Result<LlmResponse, LlmError> {
        match self.spec.backend.api_format() {
            ApiFormat::Anthropic => {
                let resolved = self.resolve_auth().await?;
                self.begin_provider_attempt(request, super::LlmTransport::HttpSse);
                let headers = self.headers_for_provider();
                anthropic::complete_streaming(
                    &self.spec,
                    &resolved,
                    self.anthropic_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.anthropic_base_url.as_deref()),
                    request,
                    chunk_tx,
                )
                .await
            }
            ApiFormat::OpenAIResponses => {
                let key = self.auth.resolve_required().await?.credential;
                let transport = if self.use_codex_backend {
                    super::LlmTransport::Websocket
                } else {
                    super::LlmTransport::HttpSse
                };
                self.begin_provider_attempt(request, transport);
                let headers = self.headers_for_provider();
                openai::complete_streaming(
                    &self.spec,
                    &key,
                    self.openai_responses_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.openai_responses_base_url.as_deref()),
                    request,
                    chunk_tx,
                    self.use_codex_backend,
                    Some(&self.codex_ws_sessions),
                )
                .await
            }
            ApiFormat::OpenAIChatCompletions => {
                let key = self.auth.resolve_optional_bearer().await?;
                self.begin_provider_attempt(request, super::LlmTransport::HttpSse);
                let headers = self.headers_for_provider();
                openai::complete_streaming_chat(
                    &self.spec,
                    key.as_deref(),
                    self.openai_chat_completions_base_url.as_deref(),
                    &headers,
                    self.effective_request_tags(self.openai_chat_completions_base_url.as_deref()),
                    request,
                    chunk_tx,
                )
                .await
            }
        }
    }

    /// Resolve auth credential for this request.
    async fn resolve_auth(&self) -> Result<super::ResolvedAuth, super::LlmError> {
        self.auth.resolve_required().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::all_models;
    use crate::registry::{AuthStyle, StaticCredential};
    use axum::{
        body::{Body, Bytes},
        extract::State,
        http::HeaderMap,
        response::Response,
        routing::post,
        Json, Router,
    };
    use std::sync::Mutex as StdMutex;

    #[derive(Debug)]
    struct MissingCredential;

    #[async_trait::async_trait]
    impl crate::registry::CredentialSource for MissingCredential {
        async fn get(&self) -> Option<String> {
            None
        }

        async fn invalidate(&self) -> bool {
            false
        }
    }

    fn request_with_capture() -> (LlmRequest, crate::LlmAttemptCapture) {
        let attempt_capture = crate::LlmAttemptCapture::new();
        let request = LlmRequest {
            system: vec![],
            messages: vec![],
            tools: vec![],
            max_tokens: None,
            effective_effort: phoenix_core::domain::llm_types::EffectiveEffort::native_unknown(),
            telemetry: Some(crate::LlmRequestTelemetry {
                conversation_id: "conversation".to_string(),
                root_conversation_id: "root".to_string(),
                request_id: "request".to_string(),
                retry_attempt: 1,
                attempt_capture: attempt_capture.clone(),
            }),
            cache_key: crate::PromptCacheKey::stable("test"),
        };
        (request, attempt_capture)
    }

    fn make_service(
        anthropic_base_url: Option<&str>,
        openai_base_url: Option<&str>,
        tags: BTreeMap<String, String>,
    ) -> LlmServiceImpl {
        let spec = all_models()
            .into_iter()
            .find(|s| s.id == "claude-sonnet-5")
            .expect("claude-sonnet-5 must be in the model registry");
        let auth = LlmAuth::new(Arc::new(StaticCredential::new("k")), AuthStyle::ApiKey);
        LlmServiceImpl::new(
            spec,
            auth,
            anthropic_base_url.map(String::from),
            openai_base_url.map(String::from),
            None,
            vec![],
            tags,
        )
    }

    fn one_tag() -> BTreeMap<String, String> {
        let mut t = BTreeMap::new();
        t.insert("disable_data_logging".to_string(), "true".to_string());
        t
    }

    #[derive(Clone, Default)]
    struct CapturedChatRequest {
        headers: Arc<StdMutex<Option<HeaderMap>>>,
        body: Arc<StdMutex<Option<serde_json::Value>>>,
    }

    async fn capture_chat_request(
        State(capture): State<CapturedChatRequest>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Json<serde_json::Value> {
        *capture.headers.lock().unwrap() = Some(headers);
        *capture.body.lock().unwrap() = Some(serde_json::from_slice(&body).unwrap());
        Json(serde_json::json!({
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "local result"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 1, "completion_tokens": 2}
        }))
    }

    async fn capture_streaming_chat_request(
        State(capture): State<CapturedChatRequest>,
        headers: HeaderMap,
        body: Bytes,
    ) -> Response {
        *capture.headers.lock().unwrap() = Some(headers);
        *capture.body.lock().unwrap() = Some(serde_json::from_slice(&body).unwrap());
        let stream = concat!(
            "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"local stream\"},\"finish_reason\":null}],\"usage\":null}\n\n",
            "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":2}}\n\n",
            "data: [DONE]\n\n"
        );
        Response::builder()
            .header("Content-Type", "text/event-stream")
            .body(Body::from(stream))
            .unwrap()
    }

    #[tokio::test]
    async fn ollama_route_omits_auth_and_uses_configured_wire_model() {
        let capture = CapturedChatRequest::default();
        let app = Router::new()
            .route("/v1/chat/completions", post(capture_chat_request))
            .with_state(capture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service = LlmServiceImpl::new_ollama(
            crate::ollama_gpt_oss_model("custom-gpt-oss-tag", 32_768),
            format!("http://{address}/v1/chat/completions"),
        );
        let (mut request, _) = request_with_capture();
        request.tools.push(crate::ToolDefinition {
            name: "inspect_code".to_string(),
            description: "Inspect code".to_string(),
            input_schema: serde_json::json!({"type": "object"}),
            defer_loading: false,
        });

        let response = service.complete(&request).await.unwrap();

        assert!(response.content.iter().any(
            |block| matches!(block, crate::ContentBlock::Text { text } if text == "local result")
        ));
        let headers = capture.headers.lock().unwrap().clone().unwrap();
        assert!(headers.get("authorization").is_none());
        assert!(headers.get("x-api-key").is_none());
        assert!(headers.get("provider").is_none());
        let body = capture.body.lock().unwrap().clone().unwrap();
        assert_eq!(body["model"], "custom-gpt-oss-tag");
        assert_eq!(body["tools"][0]["function"]["name"], "inspect_code");
        assert_eq!(body["tool_choice"], "auto");
        server.abort();
    }

    #[tokio::test]
    async fn ollama_streaming_route_omits_auth() {
        let capture = CapturedChatRequest::default();
        let app = Router::new()
            .route("/v1/chat/completions", post(capture_streaming_chat_request))
            .with_state(capture.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let service = LlmServiceImpl::new_ollama(
            crate::ollama_gpt_oss_model("gpt-oss:120b", 32_768),
            format!("http://{address}/v1/chat/completions"),
        );
        let (request, _) = request_with_capture();
        let (chunk_tx, mut chunk_rx) = mpsc::channel(4);

        let response = service
            .complete_streaming(&request, &chunk_tx)
            .await
            .unwrap();

        assert!(response.content.iter().any(
            |block| matches!(block, crate::ContentBlock::Text { text } if text == "local stream")
        ));
        assert!(matches!(
            chunk_rx.try_recv().unwrap(),
            crate::TokenChunk::Text(text) if text == "local stream"
        ));
        let headers = capture.headers.lock().unwrap().clone().unwrap();
        assert!(headers.get("authorization").is_none());
        assert!(headers.get("x-api-key").is_none());
        let body = capture.body.lock().unwrap().clone().unwrap();
        assert_eq!(body["stream"], true);
        server.abort();
    }

    #[tokio::test]
    async fn local_auth_failure_does_not_finalize_provider_attempt() {
        let spec = all_models()
            .into_iter()
            .find(|model| model.id == "claude-sonnet-5")
            .expect("claude-sonnet-5 must be in the model registry");
        let service: Arc<dyn LlmService> = Arc::new(LlmServiceImpl::new(
            spec,
            LlmAuth::new(Arc::new(MissingCredential), AuthStyle::ApiKey),
            None,
            None,
            None,
            vec![],
            BTreeMap::new(),
        ));
        let service =
            crate::LoggingService::new(service, "anthropic", crate::LlmTransport::HttpSse);
        let (request, capture) = request_with_capture();
        let (chunk_tx, _chunk_rx) = mpsc::channel(1);

        let error = service
            .complete_streaming(&request, &chunk_tx)
            .await
            .expect_err("missing local credential should fail");

        assert_eq!(error.kind, crate::LlmErrorKind::Auth);
        assert_eq!(capture.finalized(), None);
    }

    fn chat_gateway_service_with_api_name(api_name: &str) -> LlmServiceImpl {
        let mut spec = all_models()
            .into_iter()
            .find(|s| s.id == "gpt-5.5")
            .expect("gpt-5.5 must be in the model registry");
        spec.backend = crate::ModelBackend::OpenAIChatCompletions;
        spec.api_name = api_name.to_string();
        let auth = LlmAuth::new(Arc::new(StaticCredential::new("k")), AuthStyle::PlainBearer);
        LlmServiceImpl::new(
            spec,
            auth,
            None,
            None,
            Some("https://gateway.example/v1/chat/completions".to_string()),
            vec![
                ("tenant-id".to_string(), "example".to_string()),
                ("source".to_string(), "test-source".to_string()),
            ],
            BTreeMap::new(),
        )
    }

    #[test]
    fn ollama_and_cloud_chat_services_keep_endpoint_and_auth_separate() {
        let cloud = chat_gateway_service_with_api_name("cloud/model");
        let ollama = LlmServiceImpl::new_ollama(
            crate::ollama_gpt_oss_model("gpt-oss:120b", 32_768),
            "http://127.0.0.1:11434/v1/chat/completions".to_string(),
        );

        assert_eq!(
            cloud.openai_chat_completions_base_url.as_deref(),
            Some("https://gateway.example/v1/chat/completions")
        );
        assert!(cloud.auth.is_required());
        assert_eq!(
            ollama.openai_chat_completions_base_url.as_deref(),
            Some("http://127.0.0.1:11434/v1/chat/completions")
        );
        assert!(!ollama.auth.is_required());
    }

    #[test]
    fn provider_header_uses_api_name_prefix_for_gateway_models() {
        let svc = chat_gateway_service_with_api_name("gateway-provider/example-org/Code-Model");
        let headers = svc.headers_for_provider();
        assert_eq!(
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("provider"))
                .map(|(_, value)| value.as_str()),
            Some("gateway-provider")
        );
    }

    #[test]
    fn explicit_provider_header_still_wins() {
        let mut svc = chat_gateway_service_with_api_name("gateway-provider/example-org/Code-Model");
        svc.custom_headers
            .push(("provider".to_string(), "custom".to_string()));
        let headers = svc.headers_for_provider();
        assert_eq!(
            headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("provider"))
                .map(|(_, value)| value.as_str()),
            Some("custom")
        );
    }

    #[test]
    fn openai_format_base_urls_are_isolated() {
        let mut responses_spec = all_models()
            .into_iter()
            .find(|s| s.id == "gpt-5.5")
            .expect("gpt-5.5 must be in the model registry");
        responses_spec.backend = crate::ModelBackend::OpenAIResponses;
        let mut chat_spec = responses_spec.clone();
        chat_spec.backend = crate::ModelBackend::OpenAIChatCompletions;
        let auth = LlmAuth::new(Arc::new(StaticCredential::new("k")), AuthStyle::PlainBearer);

        let responses = LlmServiceImpl::new(
            responses_spec,
            auth.clone(),
            None,
            Some("https://gateway.example/v1/responses".to_string()),
            Some("https://gateway.example/v1/chat/completions".to_string()),
            vec![],
            one_tag(),
        );
        let chat = LlmServiceImpl::new(
            chat_spec,
            auth,
            None,
            Some("https://gateway.example/v1/responses".to_string()),
            Some("https://gateway.example/v1/chat/completions".to_string()),
            vec![],
            one_tag(),
        );

        assert_eq!(
            responses.openai_responses_base_url.as_deref(),
            Some("https://gateway.example/v1/responses")
        );
        assert_eq!(
            chat.openai_chat_completions_base_url.as_deref(),
            Some("https://gateway.example/v1/chat/completions")
        );
        assert_eq!(
            responses
                .effective_request_tags(responses.openai_responses_base_url.as_deref())
                .len(),
            1
        );
        assert_eq!(
            chat.effective_request_tags(chat.openai_chat_completions_base_url.as_deref())
                .len(),
            1
        );
    }

    #[test]
    fn tags_attached_for_anthropic_base_url_only_path() {
        // Helper + ANTHROPIC_BASE_URL means a proxy is in front; tags must reach it.
        let svc = make_service(
            Some("https://proxy.example/anthropic/v1/messages"),
            None,
            one_tag(),
        );
        assert_eq!(
            svc.effective_request_tags(svc.anthropic_base_url.as_deref())
                .len(),
            1
        );
    }

    #[test]
    fn tags_dropped_for_direct_provider_call() {
        // No base_url override -> direct to api.anthropic.com,
        // which 400s on unknown body fields. Drop the tags.
        let svc = make_service(None, None, one_tag());
        assert!(svc.effective_request_tags(None).is_empty());
    }

    #[test]
    fn tags_isolated_per_api_format() {
        // Anthropic via proxy, OpenAI direct: an OpenAI call must not
        // pick up tags just because anthropic_base_url is set.
        let svc = make_service(
            Some("https://proxy.example/anthropic/v1/messages"),
            None,
            one_tag(),
        );
        assert!(
            svc.effective_request_tags(svc.openai_responses_base_url.as_deref())
                .is_empty(),
            "OpenAI call must not inherit Anthropic's base-URL gate"
        );
    }
}
