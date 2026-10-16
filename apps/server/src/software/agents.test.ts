import { test } from "node:test";
import assert from "node:assert/strict";
import { outputSchema } from "../agents/schemas.js";
import { actionSchema } from "./agents.js";

test("browser action transport uses supported anyOf instead of rejected oneOf", () => {
  const schema = outputSchema(actionSchema);
  assert.ok(Array.isArray(schema.anyOf));
  assert.equal(JSON.stringify(schema).includes('"oneOf"'), false);
});
test("Red actions cannot execute arbitrary code, navigate elsewhere, or invent selectors", () => {
  for (const action of [
    { kind: "evaluate", code: "fetch('/other')" },
    { kind: "click", target: "admin-delete" },
    { kind: "reload", url: "https://elsewhere.example" },
    { kind: "fill", target: "quantity", value: "1", code: "extra" },
  ]) assert.equal(actionSchema.safeParse(action).success, false);
});
