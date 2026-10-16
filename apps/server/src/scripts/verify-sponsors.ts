import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvolutionRun } from "@antibody/shared/evolution";
import { config } from "../config.js";
import { buildBlue, searchRed } from "../agents/index.js";
import { writeBlueLesson } from "../agents/lessons.js";
import { evaluateCandidate } from "../lab/index.js";
import { passesAcceptance } from "../arena/tools.js";
import { requireHardwareSnapshot } from "../daytona/client.js";
import { flushTelemetry, telemetryStatus, traced } from "../telemetry/index.js";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Supply a completed real run export with a reproduced public failure.");
const evidence = JSON.parse(await readFile(sourcePath, "utf8")) as EvolutionRun;
const parent = evidence.candidates.find((candidate) => candidate.backend === "verilator" && candidate.failure?.reproduced);
if (!parent?.failure) throw new Error("Missing independently reproduced hardware evidence.");
await requireHardwareSnapshot();
const id = `sponsor-${randomUUID()}`;
const directory = join(config.DATA_DIR, "verification", id);
await mkdir(directory, { recursive: true, mode: 0o700 });
const result = await traced("run", id, {}, async () => {
  const lesson = await writeBlueLesson({ run: { ...evidence, id }, candidate: parent, failure: parent.failure!, family: "occupancy" });
  const blue = await buildBlue({ runId: id, candidateId: "c2", contract: evidence.contract, parent, lessons: [lesson.text], failures: [parent.failure!], branch: 0, generation: 1 });
  const red = await searchRed({ runId: id, candidateId: "c2", contract: evidence.contract, candidate: { source: blue.source, label: blue.label }, failures: [parent.failure!], round: 0, seed: 20261016 });
  const evaluation = await evaluateCandidate({ runId: id, candidateId: "c2", variant: "generated", provider: "daytona", source: blue.source, seed: 20261016, regressions: [parent.failure!], attacks: red.attacks });
  return { id, sourceEvidenceRunId: evidence.id, actualNewModelCalls: 3, provider: blue.agent.provider,
    accepted: passesAcceptance(evaluation, 1, red.attacks.map((attack) => `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`)),
    evaluation, blue: blue.agent, red: red.agent, lessonWriter: lesson.agent };
});
await flushTelemetry();
await writeFile(join(directory, "report.json"), JSON.stringify({ ...result, telemetry: telemetryStatus() }, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ id, accepted: result.accepted, actualNewModelCalls: 3, provider: result.provider, telemetry: telemetryStatus() }));
if (!result.accepted || telemetryStatus().failed) process.exitCode = 1;
