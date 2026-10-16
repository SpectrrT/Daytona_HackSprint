import assert from "node:assert/strict";
import { test } from "node:test";
import type { LabSnapshot } from "@hollow-purple/shared/agent-lab";
import { action } from "../agent-lab/contract.js";
import { executedActions } from "./retries.js";
test("concurrent comparison binds actual journal order to every exact model action", () => {
  const first=action("refund_order","ORD-1048",7900), second=action("read_record","ORD-1048");
  const snapshot={tools:[{...second,sequence:1},{...first,sequence:2},{...first,sequence:3}]} as LabSnapshot;
  assert.deepEqual(executedActions([[first],[first,second]],snapshot),[second,first,first]);
  assert.throws(()=>executedActions([[first],[second]],snapshot),/substituted or omitted/);
  const altered=structuredClone(snapshot);altered.tools[1]!.amountCents=12900;
  assert.throws(()=>executedActions([[first],[first,second]],altered),/substituted or omitted/);
});
