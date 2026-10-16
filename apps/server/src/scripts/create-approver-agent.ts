import "../config.js";

/**
 * Creates the ElevenLabs voice agent the release gate talks to, and prints its id for ELEVENLABS_AGENT_ID.
 *
 *   pnpm --filter @antibody/server exec node --import tsx src/scripts/create-approver-agent.ts
 *   pnpm --filter @antibody/server exec node --import tsx src/scripts/create-approver-agent.ts --update <agent id>
 *
 * --update re-sends the full configuration (prompt, first message, client tool) to an existing agent.
 *
 * The agent reads the release summary to the approver, asks for a yes or no, and calls the client tool
 * `record_decision` in the dashboard. The dashboard posts that decision with the conversation id, and the
 * controller confirms the conversation belongs to this agent before anything is released.
 */

const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("Set ELEVENLABS_API_KEY in .env first.");

const prompt = [
  "You are the release gate for Antibody, an adversarial engineering lab. You speak with one human approver.",
  "The design up for release: {{summary}}",
  "Ask clearly whether they approve releasing this design. Answer short questions about the summary, but never invent details.",
  "If and only if the approver clearly says yes or approve, call the record_decision tool with decision \"approve\".",
  "If they say no, sound unsure, or ask to wait, call record_decision with decision \"decline\". Never decide on your own.",
  "Call the tool exactly once. Then confirm the recorded decision in one short sentence and say goodbye.",
].join("\n");

const updateIndex = process.argv.indexOf("--update");
const existing = updateIndex > 0 ? process.argv[updateIndex + 1] : undefined;
const response = await fetch(existing ? `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(existing)}` : "https://api.elevenlabs.io/v1/convai/agents/create", {
  method: existing ? "PATCH" : "POST",
  headers: { "xi-api-key": key, "content-type": "application/json" },
  body: JSON.stringify({
    name: "Antibody release approver",
    tags: ["antibody"],
    conversation_config: {
      agent: {
        first_message: "Hi, this is the Antibody release gate. {{summary}} Do you approve releasing it? Please say yes or no.",
        language: "en",
        dynamic_variables: { dynamic_variable_placeholders: { summary: "A verified design is ready for release.", run_id: "none" } },
        prompt: {
          prompt,
          tools: [
            {
              type: "client",
              name: "record_decision",
              description: "Record the approver's release decision. Call exactly once, after the approver has clearly answered.",
              expects_response: true,
              response_timeout_secs: 20,
              parameters: {
                type: "object",
                required: ["decision"],
                properties: {
                  decision: { type: "string", enum: ["approve", "decline"], description: "approve only if the approver clearly said yes; otherwise decline" },
                },
              },
            },
          ],
        },
      },
    },
  }),
});
const body = (await response.json().catch(() => ({}))) as { agent_id?: string; detail?: unknown };
const agentId = body.agent_id ?? existing;
if (!response.ok || !agentId) throw new Error(`ElevenLabs agent ${existing ? "update" : "creation"} failed (${response.status}): ${JSON.stringify(body.detail ?? body).slice(0, 500)}`);
console.log(`ELEVENLABS_AGENT_ID=${agentId}`);
