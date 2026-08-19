# Allow discovered Ollama workers alongside an external-only cloud catalog

## Observed journey

- A parent conversation asks `spawn_agents` to use the installed `gpt-oss:120b` Ollama model.
- The tool schema lists only `copilot/*` models, so `ollama/gpt-oss:120b` cannot be selected.
- This reproduces in the main Phoenix development instance after the Ollama delegation feature is present and Phoenix has been freshly restarted.

## Verified findings

- Ollama is running and listening on `127.0.0.1:11434`; the installed model was independently reported as `gpt-oss:120b`.
- Phoenix contains the complete Ollama route and discovery implementation: `ModelRegistry::new_with_discovery` calls `register_discovered_ollama`, and successful discovery feeds `available_models`, `subagent_model_catalog`, and the frozen `spawn_agents` schema.
- The active `/home/omarchy/dev/phoenix-ide/.phoenix-ide.env` was generated for GitHub Copilot and sets `PHOENIX_LLM_MODELS_ONLY=1`. The standard `scripts/phoenix-copilot-env.py` generator always emits this setting.
- `ModelRegistry::register_discovered_ollama` immediately returns when `external_models_only` is true. Consequently it does not probe `/v1/models`, register the local route, or log an Ollama discovery outcome. The active startup log contains no Ollama discovery event.
- `PHOENIX_LLM_MODELS_ONLY` was introduced to prevent Phoenix built-in cloud definitions from leaking into an operator-supplied cloud catalog. Ollama is not one of those definitions: ADR-029 gives it an independently discovered, endpoint/auth-isolated local route.
- Existing Ollama tests cover ordinary catalogs, and existing external-only tests cover exclusion of built-ins, but no regression test combines an external-only catalog with successful local Ollama discovery.

## Failure model and owning invariant

`external_models_only` currently represents two unrelated policies:

1. the operator-supplied external model specs are authoritative instead of Phoenix's built-in cloud specs; and
2. independently configured/discovered local routes are disabled.

Only the first policy is specified and intended. The second makes Ollama delegation structurally unreachable in Phoenix's primary Copilot environment and contradicts the route independence established by ADR-029. A successfully discovered local Ollama route must coexist with the selected cloud catalog without restoring excluded built-in definitions or borrowing cloud endpoint/auth configuration.

## Proposed implementation

1. In `phoenix-llm` registry construction, allow bounded Ollama discovery and registration even when `PHOENIX_LLM_MODELS_ONLY=1`.
   - Preserve `model_specs` behavior: external-only mode must still exclude all Phoenix built-in cloud model definitions.
   - Keep `PHOENIX_DISABLE_OLLAMA=1` and an absent Ollama endpoint as the explicit ways to suppress probing.
   - Preserve successful-discovery gating, distinct endpoint/auth ownership, collision handling, and frozen per-conversation catalogs.
2. Add a regression test that builds an external-only registry with a fake external model and a fake Ollama `/v1/models` endpoint.
   - The external model and `ollama/gpt-oss:120b` are registered.
   - unrelated built-in models remain absent.
   - the Ollama model appears in `subagent_model_catalog` with its local/rate-limit-independent description.
3. Clarify `REQ-LLM-003`, the LLM executive summary, and any still-relevant registry documentation: external-only selects the complete operator-supplied cloud/spec catalog but does not suppress separately configured, availability-gated local routes. Keep timeless requirements free of this task reference.
4. Validate with focused `phoenix-llm` tests and `./dev.py check`.
5. Perform the user-visible smoke journey in the main environment after restart:
   - confirm Ollama discovery is logged and `/api/models` includes `ollama/gpt-oss:120b`;
   - start a fresh parent conversation so its schema freezes the new catalog;
   - spawn a bounded Explore sub-agent explicitly with `ollama/gpt-oss:120b` and confirm normal completion/fan-in.

## Risks

- Removing the guard without a combined regression could accidentally reintroduce built-in cloud models under external-only mode; assert their absence explicitly.
- A discovered local ID could collide with an external ID; retain the existing fail-closed collision behavior.
- Existing conversations intentionally retain their frozen schema; validation requires a fresh conversation after server restart.

## Non-goals

- Do not change Explore or Work default model selection.
- Do not automatically route tasks to Ollama.
- Do not install, pull, start, stop, or update Ollama or its models.
- Do not make model availability dynamically refresh inside an existing conversation.
- Do not merge Ollama into the authenticated cloud Chat Completions route or add it manually to `PHOENIX_LLM_MODELS`.
