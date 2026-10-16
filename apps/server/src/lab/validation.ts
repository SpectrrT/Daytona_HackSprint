import type { RedAttack, Stimulus } from "@hollow-purple/shared/evolution";

export class CandidateBuildError extends Error {
  constructor(message: string) { super(message); this.name = "CandidateBuildError"; }
}

const PORTS: Record<string, { direction: string; width: number }> = {
  clk: { direction: "input", width: 1 }, reset: { direction: "input", width: 1 },
  write_en: { direction: "input", width: 1 }, read_en: { direction: "input", width: 1 },
  data_in: { direction: "input", width: 16 }, data_out: { direction: "output", width: 16 },
  read_valid: { direction: "output", width: 1 }, full: { direction: "output", width: 1 },
  empty: { direction: "output", width: 1 }, occupancy: { direction: "output", width: 6 },
};

/** Remove every comment, including Verilator metacomments, while preserving diagnostic lines. */
function stripComments(source: string): string {
  let result = "";
  for (let i = 0; i < source.length;) {
    if (source[i] === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") { result += " "; i++; }
    } else if (source[i] === "/" && source[i + 1] === "*") {
      result += "  "; i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { result += source[i] === "\n" ? "\n" : " "; i++; }
      if (i === source.length) throw new CandidateBuildError("RTL contains an unterminated comment.");
      result += "  "; i += 2;
    } else {
      if (source[i] === '"') throw new CandidateBuildError("RTL strings, file access, and foreign interfaces are not allowed.");
      result += source[i]; i++;
    }
  }
  return result;
}

/** A deliberately restricted synthesizable subset; this is a gate before sandbox compilation. */
export function validateRtl(source: string): string {
  if (typeof source !== "string" || source.length < 20 || source.length > 40_000) throw new CandidateBuildError("RTL source must contain 20–40,000 characters.");
  if (/[^\x09\x0a\x0d\x20-\x7e]/.test(source)) throw new CandidateBuildError("RTL must contain plain ASCII text.");
  const clean = stripComments(source);
  if (/[`\\#]/.test(clean)) throw new CandidateBuildError("RTL preprocessor directives, escaped identifiers, includes, paths, and timing controls are not allowed.");
  const forbidden = /\b(initial|final|import|export|DPI|program|interface|package|class|task|checker|bind|force|release|wait|fork|join|join_any|join_none|forever|while|do|specify|endspecify|primitive|table|config|library|celldefine|real|realtime|shortreal|string|chandle|event|mailbox|semaphore|rand|randc|randomize|constraint|virtual|new|delete|assert|assume|cover|property|sequence|clocking)\b/i.exec(clean);
  if (forbidden) throw new CandidateBuildError(`Unsupported RTL construct: ${forbidden[0]}. Use only synthesizable synchronous FIFO logic.`);
  for (const match of clean.matchAll(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
    if (!["clog2", "bits", "signed", "unsigned"].includes(match[1]!)) throw new CandidateBuildError(`System call $${match[1]} is not allowed in candidate RTL.`);
  }
  if (clean.includes("$") && /\$(?!clog2\b|bits\b|signed\b|unsigned\b)/.test(clean)) throw new CandidateBuildError("Unsupported RTL system token.");
  if ([...clean.matchAll(/\bmodule\b/g)].length !== 1 || [...clean.matchAll(/\bendmodule\b/g)].length !== 1) throw new CandidateBuildError("Provide exactly one standalone module named fifo.");
  const header = /^\s*module\s+fifo\s*\(([\s\S]*?)\)\s*;/.exec(clean);
  if (!header || !/\bendmodule\s*$/.test(clean)) throw new CandidateBuildError("Use one ANSI module fifo (...) with no top-level parameters or additional modules.");
  let direction = "", width = 1;
  const seen = new Set<string>();
  for (const declaration of header[1]!.split(",")) {
    let text = declaration.trim();
    const explicit = /^(input|output)\b\s*/.exec(text);
    if (explicit) { direction = explicit[1]!; width = 1; text = text.slice(explicit[0].length).trim(); }
    text = text.replace(/^(?:(?:wire|reg|logic)\b\s*)/, "");
    const range = /^\[\s*(\d+)\s*:\s*(\d+)\s*\]\s*/.exec(text);
    if (range) {
      width = Math.abs(Number(range[1]) - Number(range[2])) + 1;
      if (Number(range[2]) !== 0) throw new CandidateBuildError("FIFO ports must use zero-based ranges.");
      text = text.slice(range[0].length).trim();
    }
    const port = PORTS[text];
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(text) || !port || seen.has(text) || port.direction !== direction || port.width !== width) {
      throw new CandidateBuildError(`Invalid FIFO port declaration: ${declaration.trim().slice(0, 120)}. Match the frozen contract's exact names, directions, and widths.`);
    }
    seen.add(text);
  }
  if (seen.size !== Object.keys(PORTS).length) throw new CandidateBuildError("FIFO module is missing required frozen-contract ports.");
  return clean;
}

export function validateSequence(value: unknown, label: string, maxLength: number): Stimulus[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxLength) throw new Error(`${label} must contain 1–${maxLength} cycles.`);
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} contains an invalid stimulus.`);
    const edge = item as Record<string, unknown>;
    if (Object.keys(edge).some((key) => !["reset", "write", "read", "data"].includes(key)) ||
      typeof edge.reset !== "boolean" || typeof edge.write !== "boolean" || typeof edge.read !== "boolean" ||
      !Number.isInteger(edge.data) || Number(edge.data) < 0 || Number(edge.data) > 65535) throw new Error(`${label} requires strict reset/write/read booleans and unsigned 16-bit data.`);
    return { reset: edge.reset, write: edge.write, read: edge.read, data: edge.data as number };
  });
}

/** Agent Red may add bounded public experiments, never replace controller checks. */
export function validateRedAttacks(value: RedAttack[] = []): RedAttack[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error("Red may propose at most four attacks per candidate.");
  let total = 0;
  const ids = new Set<string>();
  return value.map((attack) => {
    if (!attack || typeof attack !== "object" || Object.keys(attack).some((key) => !["id", "name", "hypothesis", "sequence"].includes(key)) ||
      typeof attack.id !== "string" || !/^(?:agent-red-)?[a-zA-Z0-9][a-zA-Z0-9-]{0,49}$/.test(attack.id) ||
      typeof attack.name !== "string" || !attack.name.trim() || attack.name.length > 120 ||
      typeof attack.hypothesis !== "string" || !attack.hypothesis.trim() || attack.hypothesis.length > 2000) throw new Error("Malformed Red attack proposal.");
    const id = `agent-red-${attack.id.replace(/^agent-red-/, "").toLowerCase()}`;
    if (ids.has(id)) throw new Error("Red attack identifiers must be unique.");
    ids.add(id);
    const sequence = validateSequence(attack.sequence, `Red attack ${id}`, 2048);
    if (!sequence[0]!.reset) throw new Error("Each Red attack must begin with reset asserted.");
    total += sequence.length;
    if (total > 4096) throw new Error("Red proposals exceed the 4096-cycle attack budget.");
    return { id, name: attack.name.trim(), hypothesis: attack.hypothesis.trim(), sequence };
  });
}
