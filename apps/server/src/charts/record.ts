import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { parseRunEvidence } from "../benchmarks/run-metrics.js";
import { rowsFromHardwareRun, rowsFromSoftwareRun, rowsFromTrials, writeTimeseries } from "./series.js";
/** Read-only source reconstruction. Never recover or alter another controller journal. */
export async function recordExistingRun(id: string): Promise<void> {
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error("Invalid chart run ID.");
  const ablation=join(config.DATA_DIR,"ablation",id,"results.json");
  if(await stat(ablation).then(()=>true,()=>false)){
    const result=JSON.parse(await readFile(ablation,"utf8"));
    for(const trial of result.trials)for(const evaluation of trial.evaluations){if(evaluation.completedAt===undefined&&evaluation.result.artifactPath)evaluation.completedAt=(await stat(join(evaluation.result.artifactPath,"report.json"))).mtimeMs;}
    await writeTimeseries(id,rowsFromTrials(id,result.trials,result.startedAt));return;
  }
  const software=join(config.DATA_DIR,"software-runs",id,"run.json");
  if(await stat(software).then(()=>true,()=>false)){
    await writeTimeseries(id,rowsFromSoftwareRun(JSON.parse(await readFile(software,"utf8"))));return;
  }
  const path=join(config.DATA_DIR,"runs",id,"fullrun.json");
  const text=await readFile(path,"utf8").catch(()=>readFile(join(config.DATA_DIR,"runs",`${id}.jsonl`),"utf8"));
  await writeTimeseries(id,rowsFromHardwareRun(parseRunEvidence(text)));
}
