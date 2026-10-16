"""Checks every key in .env works (`make check-keys`). Everyone runs this in the first 15 minutes.

Each check is cheap: Daytona lists sandboxes, Bedrock sends one tiny message, SurrealDB connects,
ElevenLabs reads the account, Arize only checks the variables are set.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv


def _daytona() -> str:
    from daytona import Daytona

    Daytona().list()
    return "listed sandboxes"


def _bedrock() -> str:
    from anthropic import AnthropicBedrockMantle

    client = AnthropicBedrockMantle(aws_region=os.getenv("AWS_REGION", "us-east-1"))
    msg = client.messages.create(
        model=os.getenv("CLAUDE_MODEL", "anthropic.claude-opus-5-5"),
        max_tokens=64,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": "Reply with the single word: ready"}],
    )
    return f"{msg.model}: " + "".join(b.text for b in msg.content if b.type == "text").strip()


def _surreal() -> str:
    if os.getenv("MEMORY_BACKEND", "memory") != "surreal":
        return "skipped (MEMORY_BACKEND=memory)"
    from memory.store import SurrealTreeStore

    SurrealTreeStore()
    return "connected"


def _arize() -> str:
    missing = [k for k in ("ARIZE_SPACE_ID", "ARIZE_API_KEY") if not os.getenv(k)]
    if missing:
        raise RuntimeError(f"missing {missing}")
    return "variables set (traces appear after the first model call)"


def _elevenlabs() -> str:
    if os.getenv("APPROVER", "fake-approve") != "elevenlabs":
        return "skipped (APPROVER is fake)"
    from elevenlabs import ElevenLabs

    ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"]).user.get()
    missing = [
        k for k in ("ELEVENLABS_AGENT_ID", "ELEVENLABS_PHONE_NUMBER_ID", "APPROVER_PHONE_NUMBER") if not os.getenv(k)
    ]
    return f"account ok; missing {missing}" if missing else "account ok; agent and numbers set"


def main() -> None:
    load_dotenv()
    for name, check in [
        ("Daytona", _daytona),
        ("Bedrock", _bedrock),
        ("SurrealDB", _surreal),
        ("Arize", _arize),
        ("ElevenLabs", _elevenlabs),
    ]:
        try:
            print(f"  ok   {name:11} {check()}")
        except Exception as exc:
            print(f"  FAIL {name:11} {type(exc).__name__}: {str(exc)[:200]}")


if __name__ == "__main__":
    main()
