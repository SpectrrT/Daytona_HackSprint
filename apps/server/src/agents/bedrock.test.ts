import assert from "node:assert/strict";
import { test } from "node:test";
import { bedrockRequest } from "./bedrock.js";
test("Bedrock uses a forced output-only tool, explicit Claude model, and bounded inference budget",()=>{
 const schema={type:"object",properties:{text:{type:"string"}},required:["text"]};
 const input={binary:"",role:"blue" as const,prompt:"Unit public evidence",schema,artifactPath:"unit-only",model:"us.anthropic.claude-sonnet-4-6",timeoutMs:1000};
 const request=bedrockRequest(input);assert.equal(request.modelId,input.model);assert.equal(request.inferenceConfig?.temperature,0.2);assert.ok(request.inferenceConfig!.maxTokens!<=16384);
 assert.equal(request.toolConfig?.tools?.length,1);assert.deepEqual(request.toolConfig?.toolChoice,{tool:{name:"submit_engineering_answer"}});
 assert.deepEqual(request.toolConfig?.tools?.[0]?.toolSpec?.inputSchema,{json:schema});
 assert.throws(()=>bedrockRequest({...input,model:undefined}),/explicit Claude/);
});
