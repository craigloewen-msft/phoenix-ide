# Route the local GPT-OSS worker through the GPU-resident alias only, and derive its real context window

## Observed journey

- The operator opens **New conversation -> Show all models -> GPT-OSS**, sends a message, and the turn fails with:
  `Failed after 3 attempts: Server error 500: llama-server process has terminated: exit status 1: ggml_aligned_malloc: insufficient memory (attempted to allocate 53416.41 MB) ... failed to allocate CUDA_Host buffer of size 56011161600`
- The same worker is also wanted as a `spawn_agents` sub-agent target. Both surfaces share one root cause.
- Desired flow: select `ollama/gpt-oss:120b` in a new conversation or spawn it as a sub-agent, get a normal streamed response, with the model fully resident in VRAM and never spilling to host RAM.

## Verified findings

- `LlmConfig::from_env` defaults `ollama_model` to the plain tag `gpt-oss:120b`, and `LlmConfig::default` repeats that literal. No `OLLAMA_MODEL` is set anywhere in this checkout: there is no `.phoenix-ide.env` in the worktree, and `.phoenix-ide.dev.env` sets only `PHOENIX_PASSWORD` and `PHOENIX_ENABLE_MOCK_MODEL`.
- `ModelRegistry::register_discovered_ollama` requires that exact tag in `/v1/models`, then `ollama_gpt_oss_model` stores it in `ModelSpec::api_name`. `LlmServiceImpl::new_ollama` serializes `api_name` as the request `model`. So Phoenix asks Ollama for `gpt-oss:120b`.
- `ollama show --parameters` proves the two tags are not interchangeable: `gpt-oss:120b-gpu` carries `num_gpu 999` and `num_ctx 32768`; the plain `gpt-oss:120b` carries only `temperature 1`.
- Without `num_gpu 999`, Ollama's scheduler splits the 65 GB MoE weights and pins ~52 GiB of CUDA host buffer into a WSL VM with 14 GiB total RAM (`free -g`). `llama-server` exits 1, Ollama returns 500, and `transition.rs` wraps the exhausted retry as `Failed after {attempt} attempts: ...`. The reported error is fully explained by the wire tag alone.
- The failure is at inference time, not registration: the plain tag *is* installed and *is* listed, so the model appears in the picker and in the `spawn_agents` schema and then fails on every request. This is why both surfaces break together.
- Host service is healthy and correct: `local-ai-ollama` is up on `127.0.0.1:11434`, and `ollama list` shows both `gpt-oss:120b` (65 GB) and `gpt-oss:120b-gpu` (65 GB).
- Task `33001` diagnosed this same wire-tag issue but was never implemented -- its commit `ef02c67e` adds only the task file, no code. Its plan also proposed falling back to the plain tag, which is now explicitly rejected.

### Context window: Phoenix asserts a number it never verifies

- `ollama_gpt_oss_model` hardcodes `context_window: 131_072`. `ModelRegistry::context_window` feeds it to `ConvContext` and the UI.
- The live server serves **32768** for this alias: `PARAMETER num_ctx 32768` in `~/local-ai-gpu/Modelfiles/gpt-oss-120b`, reinforced by `OLLAMA_CONTEXT_LENGTH=32768` in `compose.yaml`. Ollama precedence is request `options.num_ctx` > Modelfile `num_ctx` > `OLLAMA_CONTEXT_LENGTH`; the OpenAI-compat `/v1/chat/completions` route Phoenix uses cannot send `options`, so the Modelfile value is authoritative and unreachable from Phoenix.
- Phoenix therefore lets a conversation grow toward ~131k tokens while Ollama silently truncates the prompt at 32k. Tolerable for short delegated sub-agent tasks; corrosive for the main-conversation use case this task enables.
- **32768 is not a hardware limit and not a CPU-vs-GPU artifact.** `ollama show --verbose` reports `gptoss.context_length 131072` as the architecture max. It is a conservative choice written twice in the operator's own service config.
- The GPU can afford the full window. From the model metadata -- `block_count 36`, `attention.head_count_kv 8`, `key_length`/`value_length 64`, and `attention.sliding_window 128` on alternating layers -- KV cache at 131072 tokens is roughly 4.5-9 GiB depending on how far the sliding-window layers are exploited, on top of ~61 GiB of weights. The GPU reports 98240 MiB total. Full context fits with headroom.
- So neither hardcoded number is defensible: 131072 over-promises against the current config, and 32768 would under-promise the moment the operator raises `num_ctx`. The value must be derived from the server, not asserted by Phoenix.

## Failure model and owning invariant

Phoenix's stable model identity and Ollama's wire identity are correctly separated, but Phoenix picks the wire tag by hardcoded literal and then advertises capabilities it never measured. Two unverifiable assertions follow: that the selected tag will be GPU-resident, and that it serves 131072 tokens. On this host both are false, and the first one turns every request into a 500.

Phoenix cannot control Ollama's scheduler through the OpenAI-compat route -- it cannot send `num_gpu`, which is precisely why `~/local-ai-gpu` exists and why its README says clients that cannot set request options must use the `*-gpu` alias. The only honest contract is: **register the local worker only when Phoenix can positively confirm, from the server, both that the selected tag forces full GPU offload and what context it actually serves.** Absent that proof, the worker stays unavailable rather than advertising a route that OOMs or silently truncates.

The two proofs come from the same probe, which is what makes fail-closed coherent rather than harsh: a tag carrying `num_gpu 999` also carries a readable `num_ctx`.

## Proposed implementation

1. Represent the Ollama wire-tag choice structurally in `LlmConfig` as an explicit operator pin versus automatic selection. Do not re-derive intent later by comparing against a magic string.
2. Change automatic selection in `register_discovered_ollama` to be **GPU-alias-only**: require `gpt-oss:120b-gpu` in the bounded `/v1/models` result. If it is absent, leave the worker unavailable and log why. Never fall back to the plain `gpt-oss:120b` tag. An explicit `OLLAMA_MODEL` is honored exactly, with no substitution, and is the only way to select any other tag.
3. Add a second bounded probe of Ollama's native `/api/show` for the selected tag, derived from the configured chat endpoint by replacing the `/v1/chat/completions` suffix with `/api/show`. Parse the `parameters` blob for `num_ctx` and `num_gpu`, and `model_info` for the architecture `*.context_length`.
4. Gate registration on that probe:
   - `num_gpu` present and forcing full offload -> GPU intent confirmed;
   - effective context = `min(num_ctx, architecture context_length)`, carried into `ModelSpec::context_window` instead of the hardcoded `131_072`;
   - probe unreachable, unparseable, or missing either value -> leave the worker unavailable, logged at `debug` or above. No fabricated default.
5. Keep unchanged: the stable Phoenix ID `ollama/gpt-oss:120b`, endpoint/auth isolation and the absence of any authorization header, external-only catalog coexistence, `PHOENIX_DISABLE_OLLAMA`, and per-conversation frozen catalogs. Log the selected wire tag and resolved context window at registration; never log prompts or responses.
6. Update `specs/llm/requirements.md` REQ-LLM-003 Ollama clauses to state GPU-alias-only automatic selection, exact honoring of an operator pin, server-derived context, and fail-closed registration. Refresh `specs/llm/executive.md` current-reality prose, plus the `OLLAMA_MODEL` row and the `ollama pull gpt-oss:120b` instruction in `README.md`, which currently teaches the exact setup that fails here.
7. Regressions in `phoenix-llm`: GPU alias selected when present; plain tag alone leaves the worker unavailable; both present still selects the alias; explicit pin honored exactly; explicit pin missing from the listing fails closed; context window derived from probed `num_ctx` and clamped to the architecture max; probe failure leaves the worker unavailable; external-only catalog coexistence preserved; stable ID versus wire tag still distinct. Keep the `service.rs` coverage proving the selected tag is sent unauthenticated.
8. Validate with focused `phoenix-llm` tests, then `./dev.py check` capturing the lane summary on the first run.
9. End-to-end journey after `./dev.py restart`:
   - confirm startup logs select `gpt-oss:120b-gpu` and report the derived context window;
   - confirm `/api/models` exposes `ollama/gpt-oss:120b` and the picker shows it;
   - run a bounded query in a **new conversation** and confirm a normal streamed completion;
   - spawn a bounded Explore sub-agent pinned to `ollama/gpt-oss:120b` and confirm normal fan-in;
   - confirm residency with `~/local-ai-gpu/scripts/verify-120b` (>=95% VRAM, name `gpt-oss:120b-gpu`).
10. Mark task `33001` superseded (`wont-do`), recording that its plain-tag fallback was deliberately rejected.

## Operator step outside this repo (optional, recommended)

`~/local-ai-gpu` is not owned by Phoenix, so this is a manual step. To unlock the model's full 131072-token window -- which the measurements above show this GPU can hold -- raise the pin in `~/local-ai-gpu/Modelfiles/gpt-oss-120b`:

```
FROM gpt-oss:120b
PARAMETER num_gpu 999
PARAMETER num_ctx 131072
```

Then re-run `~/local-ai-gpu/scripts/setup` to rebuild the alias and `./scripts/verify-120b` to re-confirm residency, and raise `OLLAMA_CONTEXT_LENGTH` in `compose.yaml` to match. Because step 3 derives the window from the server, Phoenix picks up whatever value is chosen on the next restart with no code change. Start at 65536 if VRAM headroom is tight alongside other loaded models.

## Risks

- Fail-closed selection means a host without the `-gpu` alias loses the worker entirely, including a vanilla `ollama pull gpt-oss:120b` install. This is the deliberate choice: never load on CPU. The startup log must say plainly which tag was missing so the cause is obvious.
- `/api/show` is Ollama-native, not OpenAI-compatible. A non-Ollama server behind `OLLAMA_CHAT_COMPLETIONS_BASE_URL` will fail the probe and lose the worker -- already implied by requiring an Ollama-specific alias tag, but call it out in the requirement.
- Parsing the `parameters` blob is string handling against an Ollama-version-specific shape. Treat any unparseable field as probe failure rather than guessing, and keep the parser total.
- `num_gpu 999` means "offload all layers", not a guarantee that they fit. It remains the operator's job to size the model to the GPU; Phoenix confirms intent, not capacity.
- Model availability is frozen at server and conversation startup, so validation needs a restart and a genuinely new conversation.
- Raising `num_ctx` increases VRAM per loaded model; with `OLLAMA_MAX_LOADED_MODELS=1` that is bounded, but re-verify residency after any change.

## Non-goals

- Phoenix does not own Docker/Ollama install, upgrade, shutdown, or GPU scheduling; `~/local-ai-gpu` remains the service owner.
- Do not switch the Ollama route to the native `/api/chat` wire format. The probe is a read-only capability query; inference stays on the OpenAI-compat translator.
- Do not auto-route conversations or sub-agents to GPT-OSS; it stays opt-in.
- Do not add support for the other `~/local-ai-gpu` aliases (20B, qwen, nemotron); this task covers the existing GPT-OSS 120B worker only.
- Do not redesign how an exhausted-retry provider error is surfaced in the UI; the raw 500 text is a separate concern.
- Do not weaken bounded discovery, failure isolation, prompt privacy, or provider isolation in the test harness.
