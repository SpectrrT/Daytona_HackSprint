"""The approver phone call (V1). Owner: Donald.

APPROVER=elevenlabs     place a real outbound call through the ElevenLabs agent (Twilio number)
APPROVER=fake-approve   no call; approves after a short pause (dev and tests)
APPROVER=fake-decline   no call; declines (graduation dry run: decline first, then approve)

The ElevenLabs agent (see voice/agent.md) reads the summary from the `summary` dynamic variable,
asks for a yes or no, and calls its webhook tool, which hits POST /api/approve. That endpoint must
be reachable from the internet: run the arena behind `ngrok http 8000`, or in a Daytona sandbox
and use its preview link. TODO(Donald): if the webhook is a problem on site, poll
client.conversational_ai.conversations.get(conversation_id) and read the decision from the
agent's data-collection results instead.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable

from contracts import CallStatus
from voice import approval

CALL_TIMEOUT_S = 120


def request_approval(summary: str, on_status: Callable[[CallStatus], None]) -> str:
    """Returns "approved", "declined" or "failed". Emits call.status updates along the way."""
    mode = os.getenv("APPROVER", "fake-approve")
    approval.reset()

    if mode.startswith("fake-"):
        on_status(CallStatus(status="dialing", detail=f"{mode}: no real call"))
        time.sleep(0.5)
        on_status(CallStatus(status="in_progress", detail=summary))
        time.sleep(0.5)
        decision = "approved" if mode == "fake-approve" else "declined"
        on_status(CallStatus(status=decision))
        return decision

    from elevenlabs import ElevenLabs

    client = ElevenLabs(api_key=os.environ["ELEVENLABS_API_KEY"])
    on_status(CallStatus(status="dialing"))
    try:
        call = client.conversational_ai.twilio.outbound_call(
            agent_id=os.environ["ELEVENLABS_AGENT_ID"],
            agent_phone_number_id=os.environ["ELEVENLABS_PHONE_NUMBER_ID"],
            to_number=os.environ["APPROVER_PHONE_NUMBER"],
            conversation_initiation_client_data={"dynamic_variables": {"summary": summary}},
        )
    except Exception as exc:
        on_status(CallStatus(status="failed", detail=repr(exc)))
        return "failed"

    conversation_id = getattr(call, "conversation_id", None)
    on_status(CallStatus(status="in_progress", conversation_id=conversation_id))
    decision = approval.wait(CALL_TIMEOUT_S)
    if decision is None:
        on_status(CallStatus(status="failed", conversation_id=conversation_id, detail="no answer in time"))
        return "failed"
    on_status(CallStatus(status=decision, conversation_id=conversation_id))
    return decision
