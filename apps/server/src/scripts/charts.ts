import { spawn } from "node:child_process";
import { join } from "node:path";
import { config, REPO_ROOT } from "../config.js";
import { recordExistingRun } from "../charts/record.js";
const id=process.argv[2];if(!id||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw new Error("Supply a valid run ID.");
if(process.argv.includes("--watch")){
 console.log(`Watching real verifier evidence for ${id}.`);
 let busy=false;const update=async()=>{if(busy)return;busy=true;try{await recordExistingRun(id);}catch{/* The run may not have a completed evaluation yet. */}finally{busy=false;}};
 await update();const timer=setInterval(()=>{void update();},2000);process.once("SIGINT",()=>clearInterval(timer));process.once("SIGTERM",()=>clearInterval(timer));
}else{
 await recordExistingRun(id);
 const child=spawn(config.ARIZE_PYTHON??join(REPO_ROOT,"data/telemetry-venv/bin/python"),[join(REPO_ROOT,"telemetry/export_charts.py"),join(config.DATA_DIR,"runs",id,"timeseries.jsonl")],{env:{PATH:process.env.PATH,HOME:process.env.HOME,MPLBACKEND:"Agg"},stdio:["ignore","pipe","ignore"]});
 let output="";child.stdout.on("data",chunk=>{output+=chunk.toString();});child.on("error",()=>{console.log("Chart renderer unavailable. Install telemetry/requirements.txt.");process.exitCode=1;});child.on("close",code=>{console.log(output.trim()||"Chart renderer failed. Raw verifier data is retained.");if(code)process.exitCode=1;});
}
