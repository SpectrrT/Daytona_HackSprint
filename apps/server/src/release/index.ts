import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ApprovalChannel, ApprovalState, EvolutionRun, ReleaseRecord } from "@hollow-purple/shared/evolution";
import { config } from "../config.js";
import type { RunStore } from "../store.js";

/**
 * Release gate: a verified champion is released only after a human says yes.
 *
 * Phone channel: ElevenLabs places an outbound call; the voice agent's webhook tool posts the decision
 * to /api/approval with the shared secret. Dashboard channel (no ElevenLabs configured): the decision
 * comes from the Approve / Decline buttons. Only the requested channel can decide. On approval the
 * champion's exact RTL and a manifest (source hash, contract hash, regressions) are written to a release
 * bundle. On decline or a failed call, nothing is released.
 */

const optional = z.string().optional().transform((v) => (v && v.trim() ? v.trim() : undefined));
const env = z
  .object({
    ELEVENLABS_API_KEY: optional,
    ELEVENLABS_AGENT_ID: optional,
    ELEVENLABS_PHONE_NUMBER_ID: optional,
    APPROVER_PHONE_NUMBER: optional,
    APPROVE_WEBHOOK_SECRET: optional,
  })
  .parse(process.env);

export class ReleaseError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409 | 502) {
    super(message);
    this.name = "ReleaseError";
  }
}

export function approvalChannel(): ApprovalChannel {
  return env.ELEVENLABS_API_KEY && env.ELEVENLABS_AGENT_ID && env.ELEVENLABS_PHONE_NUMBER_ID && env.APPROVER_PHONE_NUMBER && env.APPROVE_WEBHOOK_SECRET
    ? "phone"
    : "dashboard";
}

/** Constant-time check of the X-Approve-Secret header the voice agent's webhook tool sends. */
export function webhookAuthorized(header: string | undefined): boolean {
  if (!env.APPROVE_WEBHOOK_SECRET || !header) return false;
  const expected = Buffer.from(env.APPROVE_WEBHOOK_SECRET);
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

export function approvalSummary(run: EvolutionRun): string {
  const winner = champion(run);
  return `Design ${winner.label} passed every directed check, all ${run.regressions.length} regression tests kept from earlier failures, and the hidden checks. Approve releasing it?`;
}

async function placeCall(summary: string, runId: string): Promise<string | undefined> {
  const response = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
    body: JSON.stringify({
      agent_id: env.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: env.ELEVENLABS_PHONE_NUMBER_ID,
      to_number: env.APPROVER_PHONE_NUMBER,
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
      : "Waiting for a human approval in the dashboard. Nothing is released without a yes.",
    payload: state,
  });
  return store.get(runId)!;
}

export async function decide(
  store: RunStore,
  runId: string,
  decision: "approve" | "decline",
  via: ApprovalChannel,
  dataDir: string = config.DATA_DIR,
): Promise<EvolutionRun> {
  const run = store.get(runId);
  if (!run) throw new ReleaseError("Run not found.", 404);
  const pending = run.approval;
  if (!pending || pending.status !== "requested") throw new ReleaseError("No approval is pending for this run.", 409);
  if (pending.channel !== via) throw new ReleaseError(`This approval must come from the ${pending.channel}.`, 403);

  const decided: ApprovalState = { ...pending, status: decision === "approve" ? "approved" : "declined", decidedAt: Date.now() };
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
