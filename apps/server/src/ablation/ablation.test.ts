import assert from "node:assert/strict";
import { test } from "node:test";
import { BUFFER_PROMPT, type Candidate, type EvolutionRun, type EvaluationResult, type FailureEvidence } from "@antibody/shared/evolution";
import { freezeContract } from "../engine/contract.js";
import { LessonMemory, type Entity, type GraphNode, type GraphEdge } from "../memory/graph.js";
import { digest, retrieveContext, assertCorpus, armOrder, RETRIEVAL_TOKEN_BUDGET, type Corpus } from "./memory.js";
import { runTrial } from "./trial.js";
import { summarizeTrials, formatMetrics } from "./metrics.js";
import { buildBluePrompt, buildRedPrompt } from "../agents/index.js";
import { createHash } from "node:crypto";
import { repairChallenge } from "./challenge.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const source = "// Unit test evidence, never submitted to a provider";
const failure: FailureEvidence = { id: "unit-public-failure", testId: "simultaneous", testName: "Concurrent count", seed: 1, cycle: 2, expected: 1, actual: 2, summary: "Raw trace: concurrent requests changed occupancy.", sequence: [{reset:true,read:false,write:false,data:0},{reset:false,read:true,write:true,data:42}], trace: [], reproduced: true };
const candidate = (id: string, parentId?: string): Candidate => ({ id, parentId, generation: parentId ? 1 : 0, label: "Unit fixture", variant: "generated", status: "testing", source, sourceHash: sha(source), checks: [], lessons: [], cycles: 0, score: 0, createdAt: 0 });
const result = (hiddenPass = true): EvaluationResult => ({ source, sourceHash: sha(source), backend: "verilator", cycles: 10, reproduced: false, checks: [...["order","simultaneous","full-replace","empty-concurrent","reset-active","red-seeded","regression-0"].map(id=>({id,name:id,passed:true,hidden:false,cycles:1,summary:"Unit fixture"})), ...["held-out","transfer-empty-boundary"].map(id=>({id,name:id,passed:hiddenPass,hidden:true,cycles:1,summary:"Unit fixture"}))] });
async function corpus(): Promise<Corpus> {
  const nodes = new Map<string, GraphNode>(); const edges = new Map<string, GraphEdge>();
  const backend = { check: async()=>{}, write: async(_run: string, n: GraphNode[], e: GraphEdge[])=>{for(const v of n)nodes.set(v.id,v);for(const v of e)edges.set(JSON.stringify(v),v);}, entity: async(id: string): Promise<Entity|undefined> => { const node=nodes.get(id);return node?{node,edges:[...edges.values()].filter(e=>e.source===id||e.target===id)}:undefined;} };
  const run: EvolutionRun = { id:"unit-corpus",prompt:BUFFER_PROMPT,provider:"daytona",status:"completed",contract:freezeContract(BUFFER_PROMPT,0),candidates:[candidate("p"),candidate("c","p")],regressions:[failure],events:[],createdAt:0,budget:{maxCandidates:2,maxCycles:10000,usedCandidates:2,usedCycles:20} };
  const memory = new LessonMemory(backend,async()=>({text:"Distilled unit lesson: use pre-edge acceptance and update occupancy atomically.",agent:{role:"blue",provider:"bedrock",model:"unit-claude",durationMs:1}}));
  for(const c of run.candidates)await memory.recordCandidate(run,c);
  await memory.recordBreach(run,run.candidates[0]!,failure);
  await memory.validate(run,run.candidates[1]!,result(),[]);
  const body = {schemaVersion:1 as const,model:"unit-claude",contractHash:run.contract.hash,trainingFamily:"simultaneous" as const,targetFamily:"empty_boundary" as const,frozenAt:"unit-test",developmentRun:run,graph:await memory.snapshot(run),failures:[failure]};
  return {...body,corpusHash:digest(body)};
}
test("three arms share one verified corpus; none has no fallback and raw retrieval never receives distilled lessons",async()=>{
 const c=await corpus();assertCorpus(c);
 assert.deepEqual((await retrieveContext(c,"none")).items,[]);
 const flat=await retrieveContext(c,"flat");assert.match(flat.items.join(""),/Raw trace/);assert.doesNotMatch(flat.items.join(""),/Distilled unit lesson/);
 const graph=await retrieveContext(c,"graph");assert.match(graph.items.join(""),/Distilled unit lesson/);assert.deepEqual(graph.path,["empty_boundary","occupancy","fifo_contract"]);
 for(const mode of ["none","flat","graph"] as const)assert.ok((await retrieveContext(c,mode)).bytes<=RETRIEVAL_TOKEN_BUDGET);
});
test("hash tampering, unverified failures and target-family contamination prevent an ablation",async()=>{
 const original=await corpus();const bad=structuredClone(original);bad.failures[0]!.summary="modified";assert.throws(()=>assertCorpus(bad),/hash mismatch/);
 for(const mutation of [(c:Corpus)=>{c.failures[0]!.reproduced=false;},(c:Corpus)=>{c.graph.nodes.find(n=>n.kind==="failure")!.family="empty_boundary";}]){
  const c=structuredClone(original);mutation(c);const {corpusHash:_,...body}=c;c.corpusHash=digest(body);assert.throws(()=>assertCorpus(c));
 }
});
test("graph transfer requires the stored ancestry edge, not just matching lesson text",async()=>{
 const c=await corpus();c.graph.edges=c.graph.edges.filter(e=>!(e.relation==="child_of"&&e.source.endsWith(":empty_boundary")));const {corpusHash:_,...body}=c;c.corpusHash=digest(body);assert.deepEqual((await retrieveContext(c,"graph")).items,[]);
});
test("seed order is randomized reproducibly without dropping or duplicating an arm",()=>{
 const orders=[730201,738120,746039].map(armOrder);assert.ok(new Set(orders.map(v=>v.join())).size>1);
 for(const seed of [1,2,3,730201]){assert.deepEqual(armOrder(seed),armOrder(seed));assert.deepEqual([...armOrder(seed)].sort(),["flat","graph","none"]);}
});
test("a hidden-only failure cannot trigger a repair, enter either prompt, or earn acceptance",async()=>{
 const c=await corpus();let blueCalls=0,redCalls=0;
 const agent={role:"blue" as const,provider:"bedrock" as const,model:"unit-claude",startedAt:0,durationMs:1,inputTokens:10,outputTokens:10};
 const trial=await runTrial({runId:"unit-trial",seed:1,mode:"none",corpus:c,generations:3},{buildBlue:async input=>{blueCalls++;assert.deepEqual(input.memoryContext,[]);assert.deepEqual(input.lessons,[]);assert.deepEqual(input.failures,[]);return {label:"unit",source,rationale:"unit",agent};},searchRed:async input=>{redCalls++;assert.deepEqual(input.memoryContext,[]);assert.deepEqual(input.failures,[]);return {attacks:[],rationale:"unit",agent:{...agent,role:"red"}};},evaluateCandidate:async()=>result(false)});
 assert.equal(blueCalls,1);assert.equal(redCalls,1);assert.equal(trial.generationsUntilAllGates,null);
 const summary=summarizeTrials([trial])[0]!;assert.deepEqual(summary.heldOut,{passed:0,evaluated:1});assert.equal(summary.censoredTrials,1);
 const parent={...candidate("p"),checks:result(false).checks};const hidden={...failure,testId:"held-out",summary:"HIDDEN SENTINEL"};
 assert.doesNotMatch(buildBluePrompt({runId:"unit",candidateId:"c",contract:c.developmentRun.contract,parent,lessons:[],failures:[hidden],branch:0,generation:1}),/HIDDEN SENTINEL|transfer-empty-boundary/);
 assert.doesNotMatch(buildRedPrompt({runId:"unit",candidateId:"c",contract:c.developmentRun.contract,candidate:{source,label:"unit"},failures:[hidden],round:0,seed:1}),/HIDDEN SENTINEL/);
});
test("provider failures are missing, never zero accuracy or a substituted model",async()=>{
 const c=await corpus();const trial=await runTrial({runId:"unit-failed",seed:1,mode:"flat",corpus:c,generations:2},{buildBlue:async()=>{throw new Error("Unit provider unavailable");},searchRed:async()=>{throw new Error("must not run");},evaluateCandidate:async()=>{throw new Error("must not run");}});
 assert.equal(trial.status,"missing");assert.equal(trial.evaluations.length,0);assert.match(formatMetrics(summarizeTrials([trial])),/A missing, B missing, C missing/);
});

test("an interrupted paid model call cannot make token totals look complete",()=>{
 const agent={role:"blue" as const,provider:"bedrock" as const,model:"unit",startedAt:0,durationMs:1,inputTokens:10,outputTokens:10};
 const evaluation={generation:0,result:result(),blue:agent,red:{...agent,role:"red" as const},retrieval:{ids:[],bytes:0,path:[]}};
 const trials=[{mode:"none" as const,seed:1,status:"completed" as const,evaluations:[evaluation],generationsUntilAllGates:1,regressionsReintroduced:0,wallMs:10},{mode:"none" as const,seed:2,status:"missing" as const,evaluations:[],generationsUntilAllGates:null,regressionsReintroduced:0,wallMs:10}];
 const summary=summarizeTrials(trials)[0]!;assert.equal(summary.acceptedDesigns,1);assert.equal(summary.totalModelTokens,null);assert.equal(summary.modelTokensPerAcceptedDesign,null);assert.equal(summary.missingTrials,1);
});

test("fresh compound repair cases are fixed independently of the arm and keep the same public contract", async () => {
 const hashes = new Set([0,1,2].map(seed => repairChallenge(seed).sourceHash)); assert.equal(hashes.size,3);
 const c=await corpus();const seen:string[]=[];
 const agent={role:"blue" as const,provider:"bedrock" as const,model:"unit-claude",startedAt:0,durationMs:1,inputTokens:10,outputTokens:10};
 for(const mode of ["none","flat","graph"] as const){
  const trial=await runTrial({runId:`unit-repair-${mode}`,seed:900001,mode,corpus:c,generations:1,task:"compound-repair-v1"},{buildBlue:async input=>{assert.equal(input.contract.hash,c.contractHash);assert.equal(input.parent!.status,"queued");assert.deepEqual(input.parent!.checks,[]);assert.deepEqual(input.failures,[]);seen.push(input.parent!.sourceHash!);return {label:"unit",source,rationale:"unit",agent};},searchRed:async()=>({attacks:[],rationale:"unit",agent:{...agent,role:"red"}}),evaluateCandidate:async()=>result()});
  assert.equal(trial.startingSourceHash,repairChallenge(900001).sourceHash);assert.equal(trial.task,"compound-repair-v1");
 }
 assert.equal(new Set(seen).size,1);
});
