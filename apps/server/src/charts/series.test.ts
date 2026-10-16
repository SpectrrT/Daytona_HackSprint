import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candidate, EvolutionRun, FailureEvidence } from "@antibody/shared/evolution";
import { rowsFromHardwareRun, rowsFromTrials, validateRow } from "./series.js";
import type { TimeseriesRow } from "@antibody/shared/charts";
import { createApp } from "../index.js";
const failure:FailureEvidence={id:"unit-replay",testId:"simultaneous",testName:"Unit breach",seed:1,cycle:1,expected:1,actual:2,summary:"Unit test replay evidence",sequence:[{reset:true,read:false,write:false,data:0}],trace:[],reproduced:true};
const c=(id:string,generation:number,broken=false):Candidate=>({id,generation,label:"Unit fixture",source:"unit",sourceHash:"unit",variant:"generated",status:broken?"failed":"verified",backend:"verilator",cycles:1,score:0,lessons:[],createdAt:0,failure:broken?failure:undefined,checks:[{id:"held-out",name:"Unit heldout",hidden:true,passed:!broken,cycles:1,summary:"Unit evidence"},...(generation?[{id:"regression-0",name:"Unit replay",hidden:false,passed:true,cycles:1,summary:"Unit evidence"}]:[])]});
function run(){const parent=c("p",0,true),child=c("c",1);const events=[{type:"candidate.updated",payload:parent,ts:2000},{type:"candidate.updated",payload:child,ts:3000},{type:"candidate.updated",payload:child,ts:4000}].map((v,i)=>({...v,runId:"unit-series",seq:i+1,message:"Unit evidence"}));return {id:"unit-series",createdAt:1000,regressions:[failure],events} as unknown as EvolutionRun;}
test("fresh audits and lesson updates do not duplicate generations, breaches, fixes or held-out checks",()=>{
 const rows=rowsFromHardwareRun(run());assert.equal(rows.length,2);
 assert.deepEqual(rows.map(r=>[r.generation,r.breaches_new,r.breaches_cumulative,r.fixed_cumulative,r.open_bugs,r.heldout_pass,r.heldout_total]),[[0,1,1,0,1,0,1],[1,0,1,1,0,1,1]]);
 assert.deepEqual(rows[1]!.fix_generations,[1]);assert.equal(rows[1]!.t_elapsed_s,3);
});
test("behavioral-model, pending, unreproduced and absent evidence do not become verified breach data",()=>{
 const r=run();for(const event of r.events){const candidate=event.payload as Candidate;candidate.backend="model";}
 assert.deepEqual(rowsFromHardwareRun(r),[]);
 const empty={...r,events:[]};assert.deepEqual(rowsFromHardwareRun(empty),[]);
 const unreproduced=run();(unreproduced.events[0]!.payload as Candidate).failure={...failure,reproduced:false};assert.equal(rowsFromHardwareRun(unreproduced)[0]!.breaches_new,0);
});
test("count invariants reject impossible, negative and nonfinite points instead of plotting them",()=>{
 const row=rowsFromHardwareRun(run())[1]!;validateRow(row);
 for(const change of [{heldout_pass:2},{open_bugs:3},{t_elapsed_s:Infinity},{generation:-1},{fix_generations:[-1]}])assert.throws(()=>validateRow({...row,...change}));
});
test("only retained regression verdicts count as fixes, even if a candidate claims verified",()=>{
 const r=run();for(const event of r.events){const candidate=event.payload as Candidate;if(candidate.generation)candidate.checks=candidate.checks.filter(c=>c.id!=="regression-0");}
 const last=rowsFromHardwareRun(r).at(-1)!;assert.equal(last.fixed_cumulative,0);assert.equal(last.open_bugs,1);assert.deepEqual(last.fix_generations,[]);
});
test("chart endpoints reject path traversal and stream an empty snapshot without sample data",async()=>{
 const app=createApp();const invalid=await app.request('/api/charts/invalid!/events');assert.equal(invalid.status,400);
 const controller=new AbortController();const response=await app.request(new Request('http://localhost/api/charts/unit-empty/events',{signal:controller.signal}));
 assert.match(response.headers.get('content-type')??'',/text\/event-stream/);const reader=response.body!.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/event: timeseries\ndata: \[\]/);controller.abort();await reader.cancel();
});
