import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedAttack } from "@antibody/shared/evolution";
import { buildTests } from "./tests.js";
import { validateRedAttacks, validateRtl } from "./validation.js";
import { evaluateCandidate } from "./index.js";

const SOURCE = `module fifo (
 input logic clk, reset, write_en, read_en,
 input logic [15:0] data_in,
 output logic [15:0] data_out,
 output logic read_valid, full, empty,
 output logic [5:0] occupancy
);
 always_ff @(posedge clk) begin
   if (reset) begin data_out <= 0; read_valid <= 0; occupancy <= 0; end
 end
 assign full = occupancy == 32;
 assign empty = occupancy == 0;
endmodule`;
const ATTACK: RedAttack = { id: "boundary", name: "Boundary", hypothesis: "A concurrent reset may leave stale state.",
  sequence: [{ reset: true, write: true, read: true, data: 65535 }] };

test("standalone fixed-port RTL is accepted and compiler metacomments are stripped", () => {
  const clean = validateRtl(SOURCE.replace("always_ff", "/* verilator public_flat_rw */ always_ff"));
  assert.ok(clean.includes("always_ff"));
  assert.ok(!clean.includes("verilator"));
});

test("source gate blocks filesystem, foreign code, delays, initialization, and extra modules", () => {
  for (const body of ["initial $system(\"cat /etc/passwd\");", "import \"DPI-C\" function void execute();", "initial begin end",
    "always #1 data_out = 0;", "`include \"/tmp/driver.cpp\"", "assign x = $fopen(1);", "assign x = $c(1);",
    "module helper; endmodule", "always begin while (1) begin end end"]) {
    assert.throws(() => validateRtl(SOURCE.replace("endmodule", `${body}\nendmodule`)));
  }
});

test("source gate enforces frozen interface and source size", () => {
  assert.throws(() => validateRtl(SOURCE.replace("[15:0] data_in", "[7:0] data_in")));
  assert.throws(() => validateRtl(SOURCE.replace("write_en,", "arbitrary_input,")));
  assert.throws(() => validateRtl(SOURCE + " ".repeat(40_000)));
});

test("Red receives a public namespace and cannot replace mandatory checks", () => {
  const attacks = validateRedAttacks([ATTACK]);
  assert.equal(attacks[0]!.id, "agent-red-boundary");
  const tests = buildTests(42, [], attacks);
  for (const id of ["order", "simultaneous", "full-replace", "empty-concurrent", "reset-active", "red-seeded", "held-out", "agent-red-boundary"]) {
    assert.equal(tests.filter((item) => item.id === id).length, 1);
  }
  assert.equal(tests.find((item) => item.id === "held-out")!.hidden, true);
  assert.equal(tests.find((item) => item.id === "agent-red-boundary")!.hidden, false);
});

test("Red attack bounds reject malformed values, duplicate names, and excess compute", () => {
  assert.throws(() => validateRedAttacks(Array(5).fill(ATTACK)));
  assert.throws(() => validateRedAttacks([ATTACK, { ...ATTACK, id: "BOUNDARY" }]));
  assert.throws(() => validateRedAttacks([{ ...ATTACK, sequence: [{ reset: true, write: true, read: false, data: -1 }] }]));
  assert.throws(() => validateRedAttacks([{ ...ATTACK, sequence: [{ reset: true, write: "true", read: false, data: 1 }] } as unknown as RedAttack]));
  assert.throws(() => validateRedAttacks([{ ...ATTACK, sequence: [{ reset: false, write: true, read: false, data: 1 }] }]));
  assert.throws(() => validateRedAttacks([{ ...ATTACK, sequence: Array(2049).fill(ATTACK.sequence[0]) }]));
  assert.throws(() => validateRedAttacks(["a", "b", "c"].map((id) => ({ ...ATTACK, id, sequence: Array(2048).fill(ATTACK.sequence[0]) }))));
});

test("generated source cannot be verified by the local behavioral model", async () => {
  await assert.rejects(() => evaluateCandidate({ runId: "validation", candidateId: "local-rejected", variant: "generated", source: SOURCE,
    provider: "local", seed: 42, regressions: [] }), /behavioral model cannot verify arbitrary source/);
});

test("unsafe generated source produces repairable build evidence before cloud creation", async () => {
  const result = await evaluateCandidate({ runId: "validation", candidateId: "unsafe-rejected", variant: "generated",
    source: SOURCE.replace("endmodule", "initial $system(1);\nendmodule"), provider: "daytona", seed: 42, regressions: [] });
  assert.ok(result.buildError);
  assert.equal(result.backend, "verilator");
  assert.equal(result.cycles, 0);
  assert.equal(result.checks[0]!.passed, false);
  assert.equal(result.sandboxId, undefined);
});
