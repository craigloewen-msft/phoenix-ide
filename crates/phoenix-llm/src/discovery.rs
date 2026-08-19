//! Dynamic model discovery from provider-compatible model listing endpoints.
//!
//! Queries `/v1/models` endpoints derived from configured base URLs to validate
//! which configured models are available.

use crate::ModelBackend;
use futures::StreamExt;
use serde::Deserialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use std::time::Duration;

const MAX_MODELS_RESPONSE_BYTES: usize = 256 * 1024;
/// `/api/show` carries tokenizer metadata, so it needs more headroom than a
/// model listing while staying bounded.
const MAX_SHOW_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Configuration for model discovery
pub struct DiscoveryConfig {
    /// URL for Anthropic models endpoint
    pub anthropic_models_url: Option<String>,
    /// URL for the `OpenAI` Responses models endpoint.
    pub openai_responses_models_url: Option<String>,
    /// URL for the `OpenAI` Chat Completions models endpoint.
    pub openai_chat_completions_models_url: Option<String>,
    /// Auth headers to send to the Anthropic models endpoint.
    pub anthropic_auth_headers: Vec<(String, String)>,
    /// Auth headers to send to the `OpenAI` Responses models endpoint.
    pub openai_responses_auth_headers: Vec<(String, String)>,
    /// Auth headers to send to the `OpenAI` Chat Completions models endpoint.
    pub openai_chat_completions_auth_headers: Vec<(String, String)>,
    /// Custom headers to inject on discovery requests
    pub custom_headers: Vec<(String, String)>,
}

/// `/v1/models` response — works for both Anthropic and `OpenAI`.
#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelData>,
}

#[derive(Debug, Deserialize)]
struct ModelData {
    id: String,
}

#[derive(Debug, Default)]
pub struct DiscoveredModels {
    pub anthropic_listed: bool,
    pub anthropic: HashSet<String>,
    pub openai_responses_listed: bool,
    pub openai_responses: HashSet<String>,
    pub openai_chat_completions_listed: bool,
    pub openai_chat_completions: HashSet<String>,
}

fn empty_ids() -> &'static HashSet<String> {
    static EMPTY: OnceLock<HashSet<String>> = OnceLock::new();
    EMPTY.get_or_init(HashSet::new)
}

impl DiscoveredModels {
    #[must_use]
    pub fn any_listed(&self) -> bool {
        self.anthropic_listed || self.openai_responses_listed || self.openai_chat_completions_listed
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.anthropic.is_empty()
            && self.openai_responses.is_empty()
            && self.openai_chat_completions.is_empty()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.anthropic.len() + self.openai_responses.len() + self.openai_chat_completions.len()
    }

    #[must_use]
    pub fn was_listed(&self, backend: ModelBackend) -> bool {
        match backend {
            ModelBackend::Anthropic => self.anthropic_listed,
            ModelBackend::OpenAIResponses => self.openai_responses_listed,
            ModelBackend::OpenAIChatCompletions => self.openai_chat_completions_listed,
            ModelBackend::Mock => false,
        }
    }

    #[must_use]
    pub fn ids_for_backend(&self, backend: ModelBackend) -> &HashSet<String> {
        match backend {
            ModelBackend::Anthropic => &self.anthropic,
            ModelBackend::OpenAIResponses => &self.openai_responses,
            ModelBackend::OpenAIChatCompletions => &self.openai_chat_completions,
            ModelBackend::Mock => empty_ids(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelDiscoveryError {
    Client,
    Request,
    HttpStatus(u16),
    InvalidResponse,
}

impl std::fmt::Display for ModelDiscoveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Client => formatter.write_str("client_setup"),
            Self::Request => formatter.write_str("request_failed"),
            Self::HttpStatus(status) => write!(formatter, "http_{status}"),
            Self::InvalidResponse => formatter.write_str("invalid_response"),
        }
    }
}

/// Query an OpenAI-compatible model listing without authentication.
///
/// This is intentionally separate from provider discovery: local Ollama must
/// never inherit cloud credentials or custom headers, and failure must not use
/// the configured-model fallback that is appropriate for authenticated routes.
///
/// # Errors
///
/// Returns a bounded classification when the client cannot be built, the request
/// fails or times out, the endpoint returns a non-success status, or the response
/// exceeds the size limit or is not a valid model listing.
pub async fn discover_unauthenticated_model_ids(
    url: &str,
    timeout: Duration,
) -> Result<HashSet<String>, ModelDiscoveryError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ModelDiscoveryError::Client)?;
    let response = client
        .get(url)
        .header("User-Agent", "phoenix-ide-ollama-discovery")
        .send()
        .await
        .map_err(|_| ModelDiscoveryError::Request)?;
    if !response.status().is_success() {
        return Err(ModelDiscoveryError::HttpStatus(response.status().as_u16()));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MODELS_RESPONSE_BYTES as u64)
    {
        return Err(ModelDiscoveryError::InvalidResponse);
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ModelDiscoveryError::Request)?;
        if body.len().saturating_add(chunk.len()) > MAX_MODELS_RESPONSE_BYTES {
            return Err(ModelDiscoveryError::InvalidResponse);
        }
        body.extend_from_slice(&chunk);
    }
    let models: ModelsResponse =
        serde_json::from_slice(&body).map_err(|_| ModelDiscoveryError::InvalidResponse)?;
    Ok(models.data.into_iter().map(|model| model.id).collect())
}

/// Serving capabilities Phoenix must confirm before advertising a local model.
///
/// Phoenix cannot set per-request `num_gpu`/`num_ctx` over the OpenAI-compatible
/// route, so the wire tag's own persisted parameters decide both whether a
/// request lands fully on the GPU and how much context it really serves. Both
/// facts come from one probe and both are required: a partial answer is
/// [`OllamaProbeError::MissingCapability`], never a guess.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OllamaModelCapabilities {
    /// Layers the tag pins to the GPU (`num_gpu`).
    pub gpu_layers: u32,
    /// Context the tag actually serves: `num_ctx` clamped to the architecture max.
    pub context_length: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OllamaProbeError {
    Discovery(ModelDiscoveryError),
    /// Reached the endpoint but a required parameter was absent or unparseable.
    MissingCapability(&'static str),
}

impl std::fmt::Display for OllamaProbeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Discovery(error) => error.fmt(formatter),
            Self::MissingCapability(field) => write!(formatter, "missing_{field}"),
        }
    }
}

/// Ollama's native `/api/show` response, narrowed to the capability fields.
#[derive(Debug, Deserialize)]
struct ShowResponse {
    /// Newline-separated `name<whitespace>value` pairs of persisted parameters.
    #[serde(default)]
    parameters: String,
    /// Architecture metadata keyed by model family, e.g. `gptoss.context_length`.
    #[serde(default)]
    model_info: serde_json::Map<String, serde_json::Value>,
}

/// Read a parameter out of the whitespace-separated `parameters` blob.
fn show_parameter(parameters: &str, name: &str) -> Option<u64> {
    parameters.lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        if fields.next()? != name {
            return None;
        }
        fields.next()?.parse().ok()
    })
}

/// The architecture's trained context ceiling, published as `<family>.context_length`.
fn architecture_context_length(
    model_info: &serde_json::Map<String, serde_json::Value>,
) -> Option<u64> {
    model_info
        .iter()
        .find(|(key, _)| key.ends_with(".context_length"))
        .and_then(|(_, value)| value.as_u64())
}

/// Probe Ollama's native `/api/show` for a wire tag's serving capabilities.
///
/// Deliberately unauthenticated and bounded, matching
/// [`discover_unauthenticated_model_ids`]: the local route must never inherit
/// cloud credentials, and a failure must leave the model unregistered rather
/// than fall back to a fabricated default.
///
/// # Errors
///
/// Returns [`OllamaProbeError::Discovery`] when the endpoint cannot be reached,
/// returns a non-success status, or exceeds the size limit; and
/// [`OllamaProbeError::MissingCapability`] when the tag does not publish the
/// `num_gpu`, `num_ctx`, or architecture context values Phoenix requires.
pub async fn probe_ollama_model_capabilities(
    url: &str,
    model: &str,
    timeout: Duration,
) -> Result<OllamaModelCapabilities, OllamaProbeError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| OllamaProbeError::Discovery(ModelDiscoveryError::Client))?;
    let response = client
        .post(url)
        .header("User-Agent", "phoenix-ide-ollama-discovery")
        .json(&serde_json::json!({ "model": model }))
        .send()
        .await
        .map_err(|_| OllamaProbeError::Discovery(ModelDiscoveryError::Request))?;
    if !response.status().is_success() {
        return Err(OllamaProbeError::Discovery(
            ModelDiscoveryError::HttpStatus(response.status().as_u16()),
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_SHOW_RESPONSE_BYTES as u64)
    {
        return Err(OllamaProbeError::Discovery(
            ModelDiscoveryError::InvalidResponse,
        ));
    }
    let mut stream = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OllamaProbeError::Discovery(ModelDiscoveryError::Request))?;
        if body.len().saturating_add(chunk.len()) > MAX_SHOW_RESPONSE_BYTES {
            return Err(OllamaProbeError::Discovery(
                ModelDiscoveryError::InvalidResponse,
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let show: ShowResponse = serde_json::from_slice(&body)
        .map_err(|_| OllamaProbeError::Discovery(ModelDiscoveryError::InvalidResponse))?;

    let gpu_layers = show_parameter(&show.parameters, "num_gpu")
        .ok_or(OllamaProbeError::MissingCapability("num_gpu"))?;
    let num_ctx = show_parameter(&show.parameters, "num_ctx")
        .ok_or(OllamaProbeError::MissingCapability("num_ctx"))?;
    let architecture_max = architecture_context_length(&show.model_info)
        .ok_or(OllamaProbeError::MissingCapability("context_length"))?;

    Ok(OllamaModelCapabilities {
        gpu_layers: u32::try_from(gpu_layers).unwrap_or(u32::MAX),
        context_length: usize::try_from(num_ctx.min(architecture_max))
            .map_err(|_| OllamaProbeError::MissingCapability("num_ctx"))?,
    })
}

/// Discover available model IDs from configured model-listing endpoints.
///
/// Returns backend-scoped model IDs that the endpoints report as available.
pub async fn discover_models(config: &DiscoveryConfig) -> DiscoveredModels {
    let mut models = DiscoveredModels::default();

    if let Some(ref url) = config.anthropic_models_url {
        match discover_provider(
            url,
            "anthropic",
            config.anthropic_auth_headers.as_slice(),
            &config.custom_headers,
            &[("anthropic-version", "2023-06-01")],
        )
        .await
        {
            Ok(m) => {
                models.anthropic_listed = true;
                models.anthropic.extend(m);
            }
            Err(e) => tracing::warn!(provider = "anthropic", error = %e, "Discovery failed"),
        }
    }

    if let Some(ref url) = config.openai_responses_models_url {
        match discover_provider(
            url,
            "openai",
            config.openai_responses_auth_headers.as_slice(),
            &config.custom_headers,
            &[],
        )
        .await
        {
            Ok(m) => {
                models.openai_responses_listed = true;
                models.openai_responses.extend(m);
            }
            Err(e) => {
                tracing::warn!(provider = "openai", backend = "responses", error = %e, "Discovery failed");
            }
        }
    }

    if let Some(ref url) = config.openai_chat_completions_models_url {
        match discover_provider(
            url,
            "openai",
            config.openai_chat_completions_auth_headers.as_slice(),
            &config.custom_headers,
            &[],
        )
        .await
        {
            Ok(m) => {
                models.openai_chat_completions_listed = true;
                models.openai_chat_completions.extend(m);
            }
            Err(e) => {
                tracing::warn!(provider = "openai", backend = "chat_completions", error = %e, "Discovery failed");
            }
        }
    }

    models
}

/// Discover model IDs from a single provider endpoint.
async fn discover_provider(
    url: &str,
    provider_name: &str,
    auth_headers: &[(String, String)],
    custom_headers: &[(String, String)],
    extra_headers: &[(&str, &str)],
) -> Result<HashSet<String>, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    let mut request = client
        .get(url)
        .header("provider", provider_name)
        .timeout(std::time::Duration::from_secs(5));

    for &(key, value) in extra_headers {
        request = request.header(key, value);
    }
    for (key, value) in auth_headers {
        request = request.header(key.as_str(), value.as_str());
    }
    for (key, value) in custom_headers {
        request = request.header(key.as_str(), value.as_str());
    }

    let response = request.send().await?;

    if !response.status().is_success() {
        return Err(format!(
            "{provider_name} models endpoint returned {}",
            response.status()
        )
        .into());
    }

    let models_response: ModelsResponse = response.json().await?;
    let ids: HashSet<String> = models_response.data.into_iter().map(|m| m.id).collect();

    tracing::info!("Discovered {} {} models", ids.len(), provider_name);
    Ok(ids)
}
