# ElevenLabs approver agent (Donald)

Set this up in the ElevenLabs dashboard (Agents platform), then put its ids in `.env`.

## Agent

- **Name:** Antibody approver
- **First message:** "Hi, this is the Antibody arena calling for a refund approval. Do you have a moment?"
- **System prompt:**

  > You are calling a human approver for one decision. Read them this summary exactly: {{summary}}
  > Then ask: "Do you approve running this refund on production? Please say yes or no."
  > If they clearly say yes, call the `record_decision` tool with decision "approve".
  > If they say no, hesitate, or ask to wait, call `record_decision` with decision "decline".
  > Never approve on your own. After the tool call, thank them and end the call.

- **Dynamic variable:** `summary` (sent by `voice/call.py` at call time).

## Webhook tool: `record_decision`

- Method `POST`, URL `https://<public arena URL>/api/approve`
- Header `X-Approve-Secret: <APPROVE_WEBHOOK_SECRET from .env>`
- Body: `{"decision": "approve" | "decline"}`

The arena must be reachable from the internet for this: `ngrok http 8000`, or run the arena in
a Daytona sandbox and use its preview link.

## Phone

Import a Twilio number into ElevenLabs (Phone numbers → Import), then copy:

- `ELEVENLABS_AGENT_ID`: the agent's id
- `ELEVENLABS_PHONE_NUMBER_ID`: the imported number's id
- `APPROVER_PHONE_NUMBER`: the phone that rings on stage, in E.164 format (+1…)

Test with `APPROVER=elevenlabs python -m scripts.test_call`. The milestone is a working test call by 1:00.
