import assert from "node:assert/strict";
import { test } from "node:test";
import { safeAttributes, traced } from "./index.js";
test("role traces allow only bounded metrics and identifiers, dropping prompts, credentials, paths and nonfinite values",()=>{
 const attrs=safeAttributes({"hollow.candidate_id":"x".repeat(500),"hollow.score":Infinity,"llm.token_count.prompt":123,"input.value":"SECRET","ARIZE_API_KEY":"SECRET","artifactPath":"/private/path","hollow.provider":"bedrock"});
 assert.deepEqual(Object.keys(attrs).sort(),["hollow.candidate_id","hollow.provider","llm.token_count.prompt"]);assert.equal(String(attrs["hollow.candidate_id"]).length,200);assert.doesNotMatch(JSON.stringify(attrs),/SECRET|private/);
});
test("disabled/test telemetry preserves return values and original application failures",async()=>{
 const value={ok:true};assert.equal(await traced("blue","unit",{},async()=>value),value);
 const error=new Error("Unit model failure");await assert.rejects(traced("verifier","unit",{},async()=>{throw error;}),cause=>cause===error);
});
