# Let Phoenix delegate work to local GPT-OSS through Ollama

## Goal

When Ollama is running `gpt-oss:120b`, Phoenix should show it to parent agents as an available `spawn_agents` model. The parent agent may delegate suitable work to it, avoiding remote rate limits, but Phoenix will not force its use.

## Key facts

- Phoenix already has sub-agent delegation and an OpenAI-compatible Chat Completions client.
- The current workaround is unsafe: it needs a fake OpenAI key and redirects every Chat Completions model to one endpoint.
- The correct fix is a separate Ollama route that can coexist with Anthropic, OpenAI, Codex, and other configured models.
- The investigation environment did not have Ollama available, so implementation must include both fake-server tests and a live same-host smoke test.

## Plan

1. Add an Ollama route using the existing Chat Completions translation.
   - Default endpoint: `http://127.0.0.1:11434/v1/chat/completions`.
   - Default model tag: `gpt-oss:120b`.
   - Allow endpoint/tag overrides.
   - Send no authentication header.
2. At startup, briefly query Ollama's `/v1/models`. Register `ollama/gpt-oss:120b` only when Ollama reports that model; otherwise continue normally without it.
3. Include concise model descriptions in the registry-backed `spawn_agents` schema, so parent agents know GPT-OSS is local and does not consume remote rate limits.
4. Keep model choice discretionary. Do not change existing Explore/Work defaults or create a new delegation tool.
5. Update the LLM/sub-agent specs and README.

## Acceptance

- Ollama and cloud models work at the same time and use their own endpoints/auth policies.
- A fresh parent conversation sees the local model and its description in `spawn_agents` only while it is available.
- Selecting it creates a normal durable child conversation whose result returns through existing fan-in.
- Stale/unknown model IDs are rejected before any child starts.
- Tests cover discovery, no-auth requests, endpoint isolation, tool calls, streaming, and delegation; `./dev.py check` passes.

## Not included

Phoenix will not install, start, stop, or update Ollama; pull model weights; force automatic routing; change sub-agent permissions/lifecycle; or add a settings UI.
