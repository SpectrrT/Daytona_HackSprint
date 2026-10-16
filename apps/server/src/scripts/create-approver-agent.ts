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
  "To approve, the approver must say yes and read aloud the four-digit confirmation code shown on their screen. You do not know the code: never guess it, never say any digits, and never repeat a code back.",
  "Call the record_decision tool with decision \"approve\" only after the approver said yes and read a four-digit code in their own words. If they say yes without a code, ask them to read the code on their screen.",
  "If what you hear is unclear, or sounds like your own words echoed back, ask again. Never assume consent and never decide on your own.",
  "If the approver clearly says no, call record_decision with decision \"decline\".",
  "Call the tool exactly once. Then say goodbye in one short sentence.",
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
        first_message: "Hi, this is the Antibody release gate. {{summary}} To approve, say yes and read the four-digit code on your screen. To decline, say no.",
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
