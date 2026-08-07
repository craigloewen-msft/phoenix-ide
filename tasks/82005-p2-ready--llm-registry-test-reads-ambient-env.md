The Rust test `phoenix-llm registry::tests::test_no_api_keys_no_models` asserts
that a default `LlmConfig` yields no available models, but `ModelRegistry::new`
consults `PHOENIX_ENABLE_MOCK_MODEL` from the process environment. `./dev.py`
loads `.phoenix-ide.dev.env`, which sets `PHOENIX_ENABLE_MOCK_MODEL=1`, so the
mock model IS registered and the assertion fails.

This makes `./dev.py check` red for environmental reasons on any machine with a
dev env loaded, which directly violates the check contract stated in dev.py:
"Red == broken code. Never `your network is broken`".

Fix direction: make the test hermetic — construct the registry with an explicit
mock-model flag rather than letting it read process env, so the assertion tests
the config, not the ambient environment. Prefer fixing the seam (registry takes
the flag as data) over an env-var-scrubbing test harness, since a test that
depends on ambient env is the actual defect.

Found while investigating check wall-clock (task 82004); unrelated to that work.
