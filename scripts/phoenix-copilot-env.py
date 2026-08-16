#!/usr/bin/env python3
"""Regenerate .phoenix-ide.env to route Phoenix at the GitHub Copilot API.

Credentials come from Agency's `agency auth github`, which mints a token for the
Microsoft GitHub EMU account. That token is entitled to the full Copilot catalog
(Claude, Gemini, Grok, GPT-5.x), whereas the personal OAuth token in
`~/.copilot/config.json` only unlocks the GPT-4o family.

Rather than baking a token into the env file, this writes `LLM_API_KEY_HELPER`
so Phoenix re-runs `agency auth github` whenever its cached credential expires.
No regeneration is needed after a re-login.

Model specs are derived live from the `/models` endpoint, including which API
each model speaks: newer models (gpt-5.x, grok) are Responses-API only, while
the rest use chat completions.

Prerequisite -- sign in with the EMU account (username ending in `_microsoft`):
    gh auth login --web --hostname github.com
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".phoenix-ide.env"

API_BASE = "https://api.githubcopilot.com"
CHAT_URL = f"{API_BASE}/chat/completions"
RESPONSES_URL = f"{API_BASE}/responses"
MODELS_URL = f"{API_BASE}/models"

HELPER_COMMAND = "agency auth github"
INTEGRATION_ID = "copilot-cli"
EDITOR_VERSION = "CopilotCLI/1.0.78"

CHAT_ENDPOINT = "/chat/completions"
RESPONSES_ENDPOINT = "/responses"

ID_PREFIX = "copilot/"
DEFAULT_MODEL = "copilot/claude-opus-5"

# Surfaced first in the picker. Everything else still registers.
RECOMMENDED = {
    "claude-opus-5",
    "claude-sonnet-5",
    "gpt-5.6-sol",
    "gemini-3.6-flash",
}

# Legacy models that add noise to the picker without adding capability.
SKIP = {
    "gpt-3.5-turbo",
    "gpt-3.5-turbo-0613",
    "gpt-4",
    "gpt-4-0613",
    "gpt-4-o-preview",
    "gpt-4o-2024-05-13",
    # Internal utility model for context summarization, not a chat model.
    "trajectory-compaction",
}

# Copilot reports a raw model family; map it to the user-facing vendor.
FAMILY_BY_PREFIX = (
    ("claude", "Anthropic"),
    ("gemini", "Google"),
    ("grok", "xAI"),
    ("mai-", "Microsoft"),
    ("gpt-", "OpenAI"),
    ("o1", "OpenAI"),
    ("o3", "OpenAI"),
)

EFFORT_LEVELS = {"none", "minimal", "low", "medium", "high", "xhigh", "max"}


def vendor_family(api_name: str) -> str:
    for prefix, vendor in FAMILY_BY_PREFIX:
        if api_name.startswith(prefix):
            return vendor
    return "Copilot"


def mint_token() -> str:
    """Run the credential helper once, to authenticate the /models query."""
    if shutil.which("agency") is None:
        sys.exit("error: `agency` not on PATH — install Agency first")

    proc = subprocess.run(
        HELPER_COMMAND.split(), capture_output=True, text=True, timeout=180
    )
    if proc.returncode != 0:
        sys.exit(
            f"error: `{HELPER_COMMAND}` failed:\n{proc.stderr.strip()}\n\n"
            "Sign in with the Microsoft EMU account (username ending in "
            "'_microsoft'):\n  gh auth login --web --hostname github.com"
        )
    # Contract: raw token on stdout, diagnostics on stderr.
    token = proc.stdout.strip()
    if not token:
        sys.exit(f"error: `{HELPER_COMMAND}` returned no token")
    return token


def fetch_models(token: str) -> list[dict]:
    req = urllib.request.Request(
        MODELS_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Copilot-Integration-Id": INTEGRATION_ID,
            "Editor-Version": EDITOR_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp).get("data", [])
    except urllib.error.HTTPError as exc:
        body = exc.read().decode(errors="replace")[:300]
        sys.exit(f"error: HTTP {exc.code} from {MODELS_URL}: {body}")


def build_spec(model: dict) -> dict | None:
    caps = model.get("capabilities") or {}
    if caps.get("type") != "chat":
        return None

    api_name = model["id"]
    if api_name in SKIP:
        return None

    # Older models omit the endpoint list; those are chat-completions only.
    endpoints = model.get("supported_endpoints") or [CHAT_ENDPOINT]
    if CHAT_ENDPOINT in endpoints:
        backend = "openai_chat_completions"
    elif RESPONSES_ENDPOINT in endpoints:
        backend = "openai_responses"
    else:
        return None  # e.g. Anthropic-only /v1/messages; nothing usable here.

    limits = caps.get("limits") or {}
    supports = caps.get("supports") or {}

    context_window = limits.get("max_context_window_tokens")
    max_output = limits.get("max_output_tokens")
    if not context_window:
        return None

    levels = [e for e in supports.get("reasoning_effort") or [] if e in EFFORT_LEVELS]
    if levels:
        effort = {"support": "supported", "levels": levels, "native_default": None}
    else:
        effort = {"support": "unsupported"}

    name = model.get("name") or api_name
    window_k = context_window // 1000
    return {
        "id": f"{ID_PREFIX}{api_name}",
        "api_name": api_name,
        "backend": backend,
        "family": vendor_family(api_name),
        "description": f"{name} via GitHub Copilot ({window_k}K ctx)",
        "context_window": context_window,
        "max_output_tokens": max_output,
        "recommended": api_name in RECOMMENDED,
        "supports_tool_search": bool(supports.get("tool_calls")),
        "effort_capabilities": effort,
    }


def main() -> None:
    token = mint_token()
    raw_models = fetch_models(token)

    specs = [s for s in (build_spec(m) for m in raw_models) if s]
    specs.sort(key=lambda s: (not s["recommended"], s["id"]))
    if not specs:
        sys.exit("error: no usable models returned by /models")

    ids = {s["id"] for s in specs}
    default_model = DEFAULT_MODEL if DEFAULT_MODEL in ids else specs[0]["id"]

    body = f"""# Phoenix IDE local LLM config -- GitHub Copilot backend.
#
# Generated by scripts/phoenix-copilot-env.py. Gitignored.
# Credentials are NOT stored here: LLM_API_KEY_HELPER re-runs
# `{HELPER_COMMAND}` whenever Phoenix needs a fresh token, so this file
# survives re-logins. Rerun the generator only to refresh the model list.
#
# Requires the Microsoft GitHub EMU account (username ending in '_microsoft')
# to be the active gh account: gh auth login --web --hostname github.com

LLM_API_KEY_HELPER={HELPER_COMMAND}
LLM_API_KEY_HELPER_TTL_MS=3600000
LLM_AUTH_HEADER=bearer
OPENAI_CHAT_COMPLETIONS_BASE_URL={CHAT_URL}
OPENAI_RESPONSES_BASE_URL={RESPONSES_URL}
LLM_CUSTOM_HEADERS=Copilot-Integration-Id: {INTEGRATION_ID}\\nEditor-Version: {EDITOR_VERSION}
DEFAULT_MODEL={default_model}
PHOENIX_LLM_MODELS_ONLY=1
PHOENIX_LLM_MODELS={json.dumps(specs, separators=(",", ":"))}
"""
    ENV_FILE.write_text(body)
    os.chmod(ENV_FILE, 0o600)

    chat_n = sum(1 for s in specs if s["backend"] == "openai_chat_completions")
    resp_n = sum(1 for s in specs if s["backend"] == "openai_responses")
    print(f"wrote {ENV_FILE} (mode 600)")
    print(f"  {len(specs)} models: {chat_n} chat-completions, {resp_n} responses")
    print(f"  default: {default_model}")
    print("restart Phoenix to pick it up: ./dev.py restart")


if __name__ == "__main__":
    main()
