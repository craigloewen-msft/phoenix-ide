# ADR-029: Local LLM routes own authentication and delegation metadata

- **Status:** Accepted
- **Date:** 2026-08-18
- **Affects:** REQ-LLM-002, REQ-LLM-003, REQ-LLM-003a, REQ-SA-011

## Context

Ollama exposes GPT-OSS through the OpenAI-compatible Chat Completions wire format, but sharing a wire format does not mean sharing an endpoint or authentication policy. Reusing the process-wide cloud Chat Completions route would require a fabricated key and could redirect unrelated models to localhost.

Parent agents also need enough information to decide when local delegation is useful. A model ID alone does not communicate locality or independence from remote rate limits, while a second catalog in system-prompt prose could drift from spawn-time validation.

## Options considered

1. **Configure Ollama as an ordinary external Chat Completions model** — requires dummy authentication and gives all Chat Completions models one endpoint.
2. **Add an automatic task router** — hides delegation decisions and introduces a separate policy mechanism.
3. **Give Ollama its own route and describe it in the existing spawn catalog** — keeps endpoint/auth ownership typed, preserves visible delegation, and reuses the existing child lifecycle.

## Decision

A local provider route owns its exact endpoint and authentication policy independently from its wire format. Ollama reuses Chat Completions translation but has an explicit unauthenticated service route and is registered only after bounded model discovery proves the configured GPT-OSS tag is installed.

The registered model specification owns the concise delegation description. Parent conversations freeze model IDs and descriptions into the `spawn_agents` schema, and spawn-time validation consumes that same catalog. The parent model decides whether to select the local worker; Phoenix does not add an automatic router.

## Consequences

- **Positive:** Ollama and authenticated cloud Chat Completions models coexist without credential or endpoint crossover.
- **Positive:** Parent agents learn that GPT-OSS is local where they make the typed model choice.
- **Positive:** Unreachable or uninstalled local models are not advertised.
- **Negative:** Ollama availability is sampled at startup and remains frozen for an existing parent conversation.
- **Neutral:** Sub-agent persistence, permissions, cancellation, timeout, and fan-in are unchanged.

## References

- `specs/llm/requirements.md`
- `specs/subagents/requirements.md`
- `ModelRegistry::register_discovered_ollama`
- `SpawnAgentsTool::input_schema`
