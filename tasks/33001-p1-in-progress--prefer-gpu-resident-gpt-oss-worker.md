# Route Phoenix GPT-OSS delegation through the GPU-resident Ollama alias

## Observed journey

- The operator uses `~/local-ai-gpu` to run GPT OSS through a persistent Dockerized Ollama service and wants Phoenix's `ollama/gpt-oss:120b` worker to use that service in a way that forces the model into GPU memory.
- Phoenix currently probes `http://127.0.0.1:11434/v1/models` and defaults its Ollama wire tag to `gpt-oss:120b`. That base tag retains Ollama's automatic scheduler behavior and does not guarantee the GPU residency required by `~/local-ai-gpu`.
- The desired user-visible flow is: start Phoenix, select or spawn `ollama/gpt-oss:120b`, receive a normal model response, and confirm that the actual Ollama wire model serving the request is `gpt-oss:120b-gpu` with at least 95% of its model storage resident in VRAM.

## Verified findings

- `~/local-ai-gpu/compose.yaml` owns a healthy `local-ai-ollama` container bound to `127.0.0.1:11434`, with all NVIDIA devices, flash attention, a 32K context, one loaded model, one parallel request, ten-minute keep-alive, and persistent model storage.
- `~/local-ai-gpu/Modelfiles/gpt-oss-120b` derives `gpt-oss:120b-gpu` from `gpt-oss:120b` and persists `num_gpu 999` plus `num_ctx 32768`. Its README explicitly says clients that cannot set request options must use the `*-gpu` alias to prevent MoE weights spilling into WSL VM memory.
- `~/local-ai-gpu/scripts/setup` creates the GPU alias, while `scripts/verify-120b` performs inference and rejects residency below 95% using Ollama's `/api/ps` `size_vram / size` values.
- Live inspection found the container running and healthy, both `gpt-oss:120b` and `gpt-oss:120b-gpu` installed, and `ollama ps` reporting `gpt-oss:120b-gpu` as `100% GPU` with context `32768`.
- `LlmConfig::from_env` defaults `OLLAMA_MODEL` to the base tag `gpt-oss:120b`. `ModelRegistry::register_discovered_ollama` requires that exact tag in `/v1/models`, then `ollama_gpt_oss_model` keeps Phoenix's stable ID `ollama/gpt-oss:120b` while storing the selected wire tag in `ModelSpec::api_name`.
- `LlmServiceImpl::new_ollama` already sends Chat Completions requests without cloud authentication, and existing service tests prove that the configured wire tag is serialized in the request's `model` field.
- Phoenix already supports an explicit `OLLAMA_MODEL` override, but relying on a manually edited generated `.phoenix-ide.env` is fragile: `scripts/phoenix-copilot-env.py` regenerates that file wholesale. Hard-coding the machine-specific GPU alias as Phoenix's only default would instead make ordinary Ollama installations lose the worker.

## Failure model and owning invariant

Phoenix's stable model identity and Ollama's wire model identity are correctly separate, but the implicit wire-model default names the scheduler-controlled base model even when the purpose-built GPU alias is discoverable. As a result, the Phoenix model picker can truthfully advertise a local GPT-OSS worker while requests bypass the installation's GPU-residency guarantee.

When no operator-explicit wire tag is configured, local discovery should select the GPU-forced alias if it exists and otherwise retain compatibility with the conventional base tag. When `OLLAMA_MODEL` is explicitly configured, Phoenix must honor only that exact choice rather than silently substituting another tag. The selected wire tag must remain distinct from the stable Phoenix ID and must be observable in startup logs and request tests.

## Proposed implementation

1. Make Ollama wire-model selection represent the distinction between an explicit operator choice and automatic default selection structurally in `LlmConfig`; do not infer intent later from a magic string.
2. Update `ModelRegistry::register_discovered_ollama` to select from the single bounded `/v1/models` result:
   - explicit `OLLAMA_MODEL`: require and use that exact tag;
   - no explicit value: prefer `gpt-oss:120b-gpu`, then fall back to `gpt-oss:120b`;
   - no matching tag: leave the stable local worker unavailable, preserving fail-closed discovery.
3. Keep the public Phoenix ID `ollama/gpt-oss:120b`, endpoint/auth isolation, external-only catalog coexistence, and frozen per-conversation catalogs unchanged. Log the selected Ollama wire tag at registration without logging prompts or responses.
4. Update LLM requirements/current-reality documentation and the README environment guidance to describe explicit selection and GPU-alias preference without making `~/local-ai-gpu` a mandatory dependency for other installations. Replace the current generic `ollama pull` instruction with both the ordinary fallback path and the GPU-resident setup path.
5. Add registry regressions covering GPU-alias preference, base-tag fallback, explicit base or custom-tag precedence, explicit missing-tag failure, neither-tag failure, external-only coexistence, and stable-ID/configured-wire-tag separation. Preserve service coverage that the selected alias is sent in the Chat Completions request body without auth.
6. Validate with focused `phoenix-llm` tests and `./dev.py check`.
7. Perform an end-to-end local smoke journey after restarting Phoenix:
   - ensure `~/local-ai-gpu/scripts/setup` has made the service and aliases ready;
   - confirm startup discovery logs select `gpt-oss:120b-gpu` and `/api/models` exposes `ollama/gpt-oss:120b`;
   - start a fresh conversation and make a bounded query through Phoenix using `ollama/gpt-oss:120b`, confirming a normal completion/fan-in;
   - run `~/local-ai-gpu/scripts/verify-120b` (or its equivalent `/api/ps` check) and require the loaded model name to be `gpt-oss:120b-gpu` with at least 95% VRAM residency.

## Risks

- A loose fallback could override an operator's intentional `OLLAMA_MODEL`; tests must distinguish explicit and automatic configuration.
- Renaming the public model ID would break stored selections and callers; only `api_name` may vary.
- Model availability is frozen at Phoenix/conversation startup. Validation requires a server restart and a fresh conversation after the alias exists.
- Running both a direct verification request and a Phoenix request can obscure which route loaded the model. Clear or inspect residency before the Phoenix query, confirm the selected wire tag in Phoenix logs/request evidence, then use `/api/ps` only as post-query residency evidence.

## Non-goals

- Do not make Phoenix own Docker/Ollama installation, upgrades, shutdown, or general GPU scheduling; `~/local-ai-gpu` remains the service owner.
- Do not automatically route all work or parent conversations to GPT OSS.
- Do not expose the Ollama service beyond loopback or merge it with authenticated cloud Chat Completions routes.
- Do not add support for every alias in `~/local-ai-gpu`; this task is limited to Phoenix's existing GPT-OSS 120B worker.
- Do not weaken bounded discovery, failure isolation, prompt privacy, or test-harness provider isolation.
