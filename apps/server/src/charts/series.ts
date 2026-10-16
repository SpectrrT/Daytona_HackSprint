import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { TimeseriesRow } from "@hollow-purple/shared/charts";
import type { Candidate, EvolutionRun, FailureEvidence } from "@hollow-purple/shared/evolution";
import type { SoftwareRun } from "@hollow-purple/shared/software";
import { config, REPO_ROOT } from "../config.js";
import type { Trial } from "../ablation/trial.js";
const validId = (id: string) => { if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid chart run ID."); return id; };
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function validateRow(row: TimeseriesRow): TimeseriesRow {
  validId(row.run);
  if (![row.pack, row.arm].every(v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v))) throw new Error("Invalid chart labels.");
  const counts = [row.seed,row.generation,row.breaches_new,row.breaches_cumulative,row.fixed_cumulative,row.open_bugs,row.heldout_pass,row.heldout_total,...row.fix_generations];
  if (counts.some(v => !Number.isSafeInteger(v) || v < 0) || !Number.isFinite(row.t_elapsed_s) || row.t_elapsed_s < 0 || row.heldout_pass > row.heldout_total || row.fixed_cumulative + row.open_bugs !== row.breaches_cumulative || row.breaches_new > row.breaches_cumulative) throw new Error("Invalid or inconsistent verifier time series.");
  return row;
}
export function rowsFromTrials(runId: string, trials: Trial[], startedAt: number): TimeseriesRow[] {
  const rows: TimeseriesRow[] = [];
  for (const trial of trials) {
    const bugs: { digest: string; discovered: number; regressionIndex: number; fixed?: number; failure: FailureEvidence }[] = [];
    const baseCount = trial.evaluations[0]?.result.checks.filter(c => /^regression-/.test(c.id)).length ?? 0;
    let publicFailures = 0;
    for (const evaluation of trial.evaluations) {
      const { result, generation } = evaluation; if (result.backend !== "verilator") continue;
      let newCount = 0;
      if (result.failure?.reproduced && !/held.out|hidden/i.test(result.failure.testId)) {
        const identity = digest(result.failure.sequence);
        if (!bugs.some(b => b.digest === identity)) { bugs.push({ digest: identity, discovered: generation, regressionIndex: baseCount + publicFailures, failure: result.failure }); newCount++; }
        publicFailures++;
      }
      // Trial regressions follow the frozen corpus, then earlier public failures.
      // Match the actual check's public name as well as its passed verdict.
      for (const bug of bugs) {
        if (generation <= bug.discovered) continue;
        const check = result.checks.find(c => c.id === `regression-${bug.regressionIndex}`);
        if (check?.passed && bug.fixed === undefined) bug.fixed = generation;
        else if (check && !check.passed) bug.fixed = undefined;
      }
      const hidden = result.checks.filter(c => c.hidden && c.id === "held-out");
      if (evaluation.completedAt === undefined) continue;
      const completedAt = evaluation.completedAt;
      const closed = bugs.filter(b => b.fixed !== undefined);
      rows.push(validateRow({ run: runId, pack: "fifo", arm: trial.mode, seed: trial.seed, generation, t_elapsed_s: Math.max(0, (completedAt - startedAt) / 1000), breaches_new: newCount, breaches_cumulative: bugs.length, fixed_cumulative: closed.length, open_bugs: bugs.length - closed.length, heldout_pass: hidden.filter(c => c.passed).length, heldout_total: hidden.length, fix_generations: closed.map(b => b.fixed! - b.discovered) }));
    }
  }
  return rows;
}
/** Uses only committed replay evidence and real regression verdicts, including fresh audits. */
export function rowsFromHardwareRun(run: EvolutionRun): TimeseriesRow[] {
  const snapshots = run.events.filter(e => e.type === "candidate.updated" && (e.payload as Candidate | undefined)?.backend === "verilator" && ["verified","failed","rejected"].includes((e.payload as Candidate).status))
    .map(e => ({ candidate: e.payload as Candidate, at: e.ts }));
  if (!snapshots.length) return [];
  const seen = new Set<string>(); const rows = new Map<number, TimeseriesRow>();
  const bugs: { failure: FailureEvidence; discovered: number; fixed?: number }[] = [];
  for (const { candidate, at } of snapshots) {
    const generation = candidate.generation;
    let row = rows.get(generation);
    if (!row) { row = { run: run.id, pack: "fifo", arm: run.events.some(e=>e.type==="lesson.learned"&&(e.payload as {status?:string}|undefined)?.status==="validated") ? "graph" : "recorded", seed: Number(run.events.find(e=>e.type==="contract.frozen")?.payload && (run.events.find(e=>e.type==="contract.frozen")!.payload as {seed?:number}).seed) || 0, generation, t_elapsed_s:0, breaches_new:0, breaches_cumulative:0, fixed_cumulative:0, open_bugs:0, heldout_pass:0, heldout_total:0, fix_generations:[] }; rows.set(generation,row); }
    if (candidate.failure?.reproduced) {
      const key=digest(candidate.failure.sequence);
      if(!seen.has(key)){seen.add(key);bugs.push({failure:candidate.failure,discovered:generation});row.breaches_new++;}
    }
    for(const bug of bugs){
      const index=run.regressions.findIndex(f=>digest(f.sequence)===digest(bug.failure.sequence));
      const check=candidate.checks.find(c=>c.id===`regression-${index}`);
      if(generation>bug.discovered&&check?.passed&&bug.fixed===undefined)bug.fixed=generation;
      else if(check&&!check.passed)bug.fixed=undefined;
    }
    const hidden=candidate.checks.filter(c=>c.hidden&&c.id==="held-out");
    const closed=bugs.filter(b=>b.fixed!==undefined);
    Object.assign(row,{t_elapsed_s:Math.max(0,(at-run.createdAt)/1000),breaches_cumulative:bugs.length,fixed_cumulative:closed.length,open_bugs:bugs.length-closed.length,heldout_pass:hidden.filter(c=>c.passed).length,heldout_total:hidden.length,fix_generations:closed.map(b=>b.fixed!-b.discovered)});
  }
  return [...rows.values()].map(validateRow);
}
export function rowsFromSoftwareRun(run: SoftwareRun): TimeseriesRow[] {
  const finished=run.candidates.filter(c=>c.checks.length&&["verified","rejected"].includes(c.status));
  const generations=new Map<string,number>();
  for(const candidate of run.candidates)generations.set(candidate.id,candidate.parentId?(generations.get(candidate.parentId)??0)+1:0);
  const bugs:{id:string;discovered:number;fixed?:number}[]=[];const rows:TimeseriesRow[]=[];
  for(const generation of [...new Set(finished.map(c=>generations.get(c.id)!))].sort((a,b)=>a-b)){
    const group=finished.filter(c=>generations.get(c.id)===generation);
    const selected=group.find(c=>c.id===run.championId)??group.find(c=>c.status==="verified")??group.at(-1)!;
    let fresh=0;
    for(const failure of run.regressions.filter(f=>f.reproduced&&group.some(c=>f.id.startsWith(`${c.id}-`)))){
      if(!bugs.some(b=>b.id===failure.id)){bugs.push({id:failure.id,discovered:generation});fresh++;}
    }
    for(const bug of bugs){const check=selected.checks.find(c=>c.id===`regression-${bug.id}`);if(generation>bug.discovered&&check?.passed&&bug.fixed===undefined)bug.fixed=generation;else if(check&&!check.passed)bug.fixed=undefined;}
    const hidden=group.flatMap(c=>c.checks.filter(check=>check.hidden));const closed=bugs.filter(b=>b.fixed!==undefined);
    const at=Math.max(run.createdAt,...run.events.filter(e=>group.some(c=>c.id===e.candidateId)).map(e=>e.at));
    rows.push(validateRow({run:run.id,pack:"payments",arm:"recorded",seed:0,generation,t_elapsed_s:Math.max(0,(at-run.createdAt)/1000),breaches_new:fresh,breaches_cumulative:bugs.length,fixed_cumulative:closed.length,open_bugs:bugs.length-closed.length,heldout_pass:hidden.filter(c=>c.passed).length,heldout_total:hidden.length,fix_generations:closed.map(b=>b.fixed!-b.discovered)}));
  }
  return rows;
}
let queue=Promise.resolve();
export async function writeTimeseries(runId:string,rows:TimeseriesRow[]):Promise<void>{
  if(process.env.NODE_TEST_CONTEXT)return;
  const task=queue.then(async()=>{
    const directory=join(config.DATA_DIR,"runs",validId(runId));await mkdir(directory,{recursive:true,mode:0o700});
    const checked=rows.map(validateRow);const identities=checked.map(r=>`${r.pack}:${r.arm}:${r.seed}:${r.generation}`);
    if(new Set(identities).size!==identities.length)throw new Error("Duplicate generation rows.");
    const path=join(directory,"timeseries.jsonl");const value=checked.map(r=>JSON.stringify(r)).join("\n")+(checked.length?"\n":"");
    const prior=await readFile(path,"utf8").catch(()=>"");if(prior===value)return;
    await writeFile(`${path}.tmp`,value,{mode:0o600});await rename(`${path}.tmp`,path);
    if(config.ARIZE_ENABLED&&config.ARIZE_API_KEY&&config.ARIZE_SPACE_ID){
      await new Promise<void>(resolve=>{
        const child=spawn(config.ARIZE_PYTHON??join(REPO_ROOT,"data/telemetry-venv/bin/python"),[join(REPO_ROOT,"telemetry/timeseries_metrics.py"),path],{env:{PATH:process.env.PATH,HOME:process.env.HOME,ARIZE_API_KEY:config.ARIZE_API_KEY,ARIZE_SPACE_ID:config.ARIZE_SPACE_ID},stdio:"ignore"});
        const timer=setTimeout(()=>{child.kill("SIGKILL");resolve();},45000);child.on("error",()=>{clearTimeout(timer);resolve();});child.on("close",()=>{clearTimeout(timer);resolve();});
      });
    }
  });queue=task.catch(()=>{});await task;
}
export async function readTimeseries(runId:string):Promise<TimeseriesRow[]>{
  const text=await readFile(join(config.DATA_DIR,"runs",validId(runId),"timeseries.jsonl"),"utf8").catch(()=>"");
  if(Buffer.byteLength(text)>2*1024*1024)throw new Error("Time series exceeds read budget.");
  return text.trim()?text.trim().split(/\r?\n/).map(line=>validateRow(JSON.parse(line))):[];
}
