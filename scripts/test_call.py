"""Places one approver call and prints the status updates (Donald's 1:00 milestone).

    APPROVER=elevenlabs python -m scripts.test_call

Needs the arena running and publicly reachable for the webhook (see voice/agent.md).
"""

from __future__ import annotations

from dotenv import load_dotenv


def main() -> None:
    load_dotenv()
    from voice.call import request_approval

    decision = request_approval(
        "This is a test call from Antibody. No refund will run.",
        on_status=lambda status: print(status.model_dump()),
    )
    print("decision:", decision)


if __name__ == "__main__":
    main()
