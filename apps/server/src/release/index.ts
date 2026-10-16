import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ApprovalChannel, ApprovalState, EvolutionRun, ReleaseRecord } from "@antibody/shared/evolution";
import { config } from "../config.js";
import type { RunStore } from "../store.js";

/**
 * Release gate: a verified champion is released only after a human says yes.
 *
 * Voice channel (ElevenLabs agent configured): the approver talks to the ElevenLabs release agent in the dashboard.
 * The agent calls its `record_decision` client tool; the dashboard posts that decision with the conversation id,
 * and the controller confirms with ElevenLabs that the conversation was held with this agent before accepting it.
 * To approve, the person must also read a four-digit code shown only on their screen; the controller finds it in
 * the person's own turns of the ElevenLabs transcript. The agent never knows the code, so speaker echo or room
 * noise transcribed as "yes" cannot release anything. Declining needs no code: it can only keep a design unreleased.
 * Phone channel (Twilio number imported into ElevenLabs): an outbound call; the agent's webhook tool posts the
 * decision to /api/approval with the shared secret. Dashboard channel: Approve / Decline buttons.
 * Only the requested channel can decide. On approval the champion's exact RTL and a manifest (source hash, contract
 * hash, regressions) are written to a release bundle. On decline or a failed call, nothing is released.
 */

const optional = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));
const envSchema = z.object({
  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_AGENT_ID: optional,
  ELEVENLABS_PHONE_NUMBER_ID: optional,
  APPROVER_PHONE_NUMBER: optional,
  APPROVE_WEBHOOK_SECRET: optional,
});
/** Read on each call so tests and restarts see the current environment. */
const env = () => envSchema.parse(process.env);
const ELEVENLABS = "https://api.elevenlabs.io/v1";

export class ReleaseError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409 | 502) {
    super(message);
    this.name = "ReleaseError";
  }
}

export function availableChannels(): ApprovalChannel[] {
  const e = env();
  const channels: ApprovalChannel[] = [];
  if (e.ELEVENLABS_API_KEY && e.ELEVENLABS_AGENT_ID && e.ELEVENLABS_PHONE_NUMBER_ID && e.APPROVER_PHONE_NUMBER && e.APPROVE_WEBHOOK_SECRET) channels.push("phone");
  if (e.ELEVENLABS_API_KEY && e.ELEVENLABS_AGENT_ID) channels.push("voice");
  channels.push("dashboard");
  return channels;
}

/** The preferred channel: phone, then voice, then dashboard. */
export function approvalChannel(): ApprovalChannel {
  return availableChannels()[0]!;
}

/** Constant-time check of the X-Approve-Secret header the phone agent's webhook tool sends. */
export function webhookAuthorized(header: string | undefined): boolean {
  const secret = env().APPROVE_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const expected = Buffer.from(secret);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function champion(run: EvolutionRun) {
  const winner = run.candidates.find((c) => c.id === run.championId);
  if (run.status !== "completed" || !winner || winner.status !== "verified") {
    throw new ReleaseError("Only a completed run with a verified champion can be released.", 409);
  }
  return winner;
}

/** Read aloud by the release agent, which then asks for the yes or no itself. */
export function approvalSummary(run: EvolutionRun): string {
  const winner = champion(run);
  const name = winner.label.replace(/[_-]+/g, " ").replace(/\s+g\d+\s+b\d+$/i, "");
  const regressions = run.regressions.length;
  const kept = regressions === 0 ? "" : regressions === 1 ? ", plus the regression test kept from an earlier failure" : `, plus all ${regressions} regression tests kept from earlier failures`;
  return `Design ${winner.id}, ${name}, passed all ${winner.checks.length} checks: the directed tests, Red's attacks and the hidden checks${kept}.`;
}

async function placeCall(summary: string, runId: string): Promise<string | undefined> {
  const e = env();
  const response = await fetch(`${ELEVENLABS}/convai/twilio/outbound-call`, {
    method: "POST",
    headers: { "xi-api-key": e.ELEVENLABS_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: e.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: e.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: e.APPROVER_PHONE_NUMBER,
      conversation_initiation_client_data: { dynamic_variables: { summary, run_id: runId } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`ElevenLabs returned ${response.status}`);
  const body = (await response.json().catch(() => ({}))) as { conversation_id?: string };
  return body.conversation_id;
}

export async function requestApproval(store: RunStore, runId: string, channel: ApprovalChannel = approvalChannel()): Promise<EvolutionRun> {
  const run = store.get(runId);
  if (!run) throw new ReleaseError("Run not found.", 404);
  if (run.release) throw new ReleaseError("This champion has already been released.", 409);
  if (run.approval?.status === "requested") return run; // already waiting: requesting again is a no-op
  if (run.approval?.status === "declined") throw new ReleaseError("The approver declined this champion. Start a new run to try again.", 409);
  const winner = champion(run);
  if (!availableChannels().includes(channel)) throw new ReleaseError(`The ${channel} approval channel is not configured.`, 409);

  const state: ApprovalState = { status: "requested", channel, candidateId: winner.id, requestedAt: Date.now() };
  if (channel === "phone") {
    try {
      state.conversationId = await placeCall(approvalSummary(run), runId);
    } catch (error) {
      const failed: ApprovalState = { ...state, status: "failed", decidedAt: Date.now(), detail: error instanceof Error ? error.message : "Call failed" };
      await store.emit(runId, { type: "approval.decided", candidateId: winner.id, message: "The approval call failed. Nothing was released.", payload: failed });
      return store.get(runId)!;
    }
  }
  await store.emit(runId, {
    type: "approval.requested",
    candidateId: winner.id,
    message: channel === "phone"
      ? "Calling the human approver. Nothing is released without a yes."
      : channel === "voice"
        ? "Waiting for the approver to talk to the ElevenLabs release agent. Nothing is released without a yes."
        : "Waiting for a human approval in the dashboard. Nothing is released without a yes.",
    payload: state,
  });
  return store.get(runId)!;
}

/** A signed ElevenLabs session for the voice channel. The API key never reaches the browser. */
/** Four digits shown only on the approver's screen, derived from a server secret, the run and the request time. */
export function confirmationCode(run: EvolutionRun): string {
  const e = env();
  const digest = createHmac("sha256", e.APPROVE_WEBHOOK_SECRET ?? e.ELEVENLABS_API_KEY ?? "").update(`${run.id}:${run.approval?.requestedAt ?? 0}`).digest();
  return String(1000 + (digest.readUInt32BE(0) % 9000));
}

const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
/** Runs of digits a person spoke, transcribed as numerals ("4 7 1 9") or words ("four seven one nine"). */
export function spokenDigitRuns(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((word) => /^\d+$/.test(word) ? word : DIGIT_WORDS[word] ?? "|").join("").split("|");
}

export async function voiceSession(store: RunStore, runId: string): Promise<{ signedUrl: string; summary: string; agentId: string; code: string }> {
  const run = store.get(runId);
  if (!run) throw new ReleaseError("Run not found.", 404);
  if (run.approval?.status !== "requested" || run.approval.channel !== "voice") throw new ReleaseError("No voice approval is pending for this run.", 409);
  const e = env();
  const response = await fetch(`${ELEVENLABS}/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(e.ELEVENLABS_AGENT_ID!)}`, {
    headers: { "xi-api-key": e.ELEVENLABS_API_KEY! },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => ({}))) as { signed_url?: string };
  if (!response.ok || !body.signed_url) throw new ReleaseError(`ElevenLabs did not start a session (${response.status}).`, 502);
  // The code is for the approver's screen only; it is never sent to the agent.
  return { signedUrl: body.signed_url, summary: approvalSummary(run), agentId: e.ELEVENLABS_AGENT_ID!, code: confirmationCode(run) };
}

interface VoiceConversation { agent_id?: string; status?: string; transcript?: { role?: string; message?: string | null }[] }

/**
 * Confirms with ElevenLabs that the conversation was held with the release agent and, for an approval, that the
 * person read the on-screen code in one of their own turns. Waits briefly for the transcript to catch up.
 */
async function verifyVoiceConversation(conversationId: string, code?: string): Promise<void> {
  const e = env();
  const deadline = Date.now() + 25_000;
  let held = false;
  for (;;) {
    const response = await fetch(`${ELEVENLABS}/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": e.ELEVENLABS_API_KEY! },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    if (response?.ok) {
      const body = (await response.json().catch(() => ({}))) as VoiceConversation;
      if (body.agent_id !== e.ELEVENLABS_AGENT_ID) throw new ReleaseError("That conversation was not held with the release agent.", 403);
      if (!code || (body.transcript ?? []).some((turn) => turn.role === "user" && spokenDigitRuns(turn.message ?? "").some((run) => run.includes(code)))) return;
      held = true;
      if (body.status === "done" || body.status === "failed") break;
    } else if (response && response.status !== 404) break;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (held) throw new ReleaseError("The approver did not read the confirmation code shown on screen, so nothing was released. Start the conversation again and read the code aloud.", 403);
  throw new ReleaseError("Could not confirm the voice conversation with ElevenLabs.", 502);
}

export async function decide(
  store: RunStore,
  runId: string,
  decision: "approve" | "decline",
  via: ApprovalChannel,
  dataDir: string = config.DATA_DIR,
  evidence: { conversationId?: string } = {},
): Promise<EvolutionRun> {
  const run = store.get(runId);
  if (!run) throw new ReleaseError("Run not found.", 404);
  const pending = run.approval;
  if (!pending || pending.status !== "requested") throw new ReleaseError("No approval is pending for this run.", 409);
  if (pending.channel !== via) throw new ReleaseError(`This approval must come from the ${pending.channel}.`, 403);
  if (via === "voice") {
    if (!evidence.conversationId) throw new ReleaseError("A voice decision needs its ElevenLabs conversation id.", 403);
    await verifyVoiceConversation(evidence.conversationId, decision === "approve" ? confirmationCode(run) : undefined);
  }

  const decided: ApprovalState = {
    ...pending,
    status: decision === "approve" ? "approved" : "declined",
    decidedAt: Date.now(),
    ...(evidence.conversationId ? { conversationId: evidence.conversationId } : {}),
  };
  await store.emit(runId, {
    type: "approval.decided",
    candidateId: pending.candidateId,
    message: decision === "approve" ? "Approved by a human. Releasing the verified design." : "Declined by the human approver. Nothing was released.",
    payload: decided,
  });
  if (decision === "approve") await release(store, runId, via, dataDir);
  return store.get(runId)!;
}

/** The single run waiting on a phone decision (the voice agent's webhook has no run id). */
export function pendingPhoneRun(store: RunStore): string | undefined {
  return store
    .list()
    .map((summary) => store.get(summary.id))
    .find((run) => run?.approval?.status === "requested" && run.approval.channel === "phone")?.id;
}

async function release(store: RunStore, runId: string, via: ApprovalChannel, dataDir: string): Promise<void> {
  const run = store.get(runId)!;
  const winner = champion(run);
  const sourceHash = winner.sourceHash ?? createHash("sha256").update(winner.source).digest("hex");
  const relative = join("runs", runId, "release");
  const dir = join(dataDir, relative);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${winner.id}.sv`), winner.source);
  const record: ReleaseRecord = {
    candidateId: winner.id,
    label: winner.label,
    sourceHash,
    contractHash: run.contract.hash,
    regressions: run.regressions.length,
    checks: winner.checks.length,
    approvedVia: via,
    releasedAt: Date.now(),
    bundlePath: relative,
  };
  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`);
  await store.emit(runId, {
    type: "design.released",
    candidateId: winner.id,
    message: `Released ${winner.label}: source ${sourceHash.slice(0, 12)}, contract ${run.contract.hash.slice(0, 12)}, ${run.regressions.length} regression tests passed.`,
    payload: record,
  });
}
