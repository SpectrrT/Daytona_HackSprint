// Geometry for the arena matrix: attack branches down the left, generations across, one dot per
// world. Pure function of ArenaState so live and replay render identically.

import type { AttackSpec } from "../contracts";
import {
  genLabel,
  genStats,
  orderedGenerations,
  worldsOf,
  type ArenaState,
  type GenStats,
  type GenerationState,
  type WorldState,
} from "../state";

export const LABEL_W = 230;
export const HEADER_H = 70;
export const ROW_H = 50;
export const GROUP_GAP = 10; // space between families
const GROUP_LABEL_H = 20;
export const DOT_R = 9;
export const DOT_GAP = 26;
const MIN_COL_W = 112;
const PAD_RIGHT = 12;

export interface MRow {
  key: string;
  family: string;
  type: string;
  control: boolean;
  y: number; // center line
  lessons: number;
}
export interface MGroup {
  family: string;
  y: number; // baseline of the family label
}
export interface MCol {
  key: string;
  label: string;
  exam: boolean;
  current: boolean;
  x: number; // left edge
  w: number;
  stats: GenStats;
  gen: GenerationState;
}
export interface MDot {
  world: WorldState;
  attack: AttackSpec | null;
  cx: number;
  cy: number;
  lessonId: string | null;
}
export interface MLink {
  id: string;
  d: string;
  kept: boolean; // same params carried forward (it breached last time) vs a mutation
}
export interface MatrixLayout {
  width: number;
  height: number;
  rows: MRow[];
  groups: MGroup[];
  cols: MCol[];
  dots: MDot[];
  links: MLink[];
}

const CONTROL = "control";
const rowKeyOf = (a: AttackSpec) => `${a.family}/${a.type}`;

export function layoutMatrix(s: ArenaState): MatrixLayout | null {
  const gens = orderedGenerations(s);
  if (!gens.length) return null;

  // Rows: families in order of first appearance, types within them likewise; controls last.
  const families: string[] = [];
  const typesByFamily = new Map<string, string[]>();
  for (const id of s.attackOrder) {
    const a = s.attacks[id];
    if (!typesByFamily.has(a.family)) {
      families.push(a.family);
      typesByFamily.set(a.family, []);
    }
    const types = typesByFamily.get(a.family)!;
    if (!types.includes(a.type)) types.push(a.type);
  }

  const lessonsByRow = new Map<string, number>();
  const lessonByWorld = new Map<string, string>();
  for (const id of s.lessonOrder) {
    const l = s.lessons[id];
    lessonByWorld.set(l.world_id, l.id);
    const a = s.attacks[l.attack_id];
    if (a) lessonsByRow.set(rowKeyOf(a), (lessonsByRow.get(rowKeyOf(a)) ?? 0) + 1);
  }

  const rows: MRow[] = [];
  const groups: MGroup[] = [];
  let y = HEADER_H;
  for (const family of families) {
    groups.push({ family, y: y + 14 });
    y += GROUP_LABEL_H;
    for (const type of typesByFamily.get(family)!) {
      const key = `${family}/${type}`;
      rows.push({ key, family, type, control: false, y: y + ROW_H / 2, lessons: lessonsByRow.get(key) ?? 0 });
      y += ROW_H;
    }
    y += GROUP_GAP;
  }
  groups.push({ family: "control", y: y + 14 });
  y += GROUP_LABEL_H;
  rows.push({ key: CONTROL, family: "control", type: "clean worlds", control: true, y: y + ROW_H / 2, lessons: 0 });
  y += ROW_H;
  const height = y + 8;
  const rowY = new Map(rows.map((r) => [r.key, r.y]));

  // Columns are as wide as their busiest cell.
  const cells = new Map<string, WorldState[]>();
  let busiest = 1;
  for (const g of gens) {
    for (const w of worldsOf(s, g)) {
      const a = w.attackId ? s.attacks[w.attackId] : null;
      const cellKey = `${g.key}|${a ? rowKeyOf(a) : CONTROL}`;
      const list = cells.get(cellKey) ?? [];
      list.push(w);
      cells.set(cellKey, list);
      busiest = Math.max(busiest, list.length);
    }
  }
  const colW = Math.max(MIN_COL_W, busiest * DOT_GAP + 44);
  const current = currentKey(gens);
  const cols: MCol[] = gens.map((g, i) => ({
    key: g.key,
    label: genLabel(g),
    exam: g.exam,
    current: g.key === current,
    x: LABEL_W + i * colW,
    w: colW,
    stats: genStats(s, g),
    gen: g,
  }));
  const width = LABEL_W + gens.length * colW + PAD_RIGHT;

  // Dots
  const dots: MDot[] = [];
  const dotByAttack = new Map<string, MDot>();
  for (const col of cols) {
    for (const row of rows) {
      const list = cells.get(`${col.key}|${row.key}`) ?? [];
      list.forEach((w, i) => {
        const attack = w.attackId ? (s.attacks[w.attackId] ?? null) : null;
        const dot: MDot = {
          world: w,
          attack,
          ...cellOffset(col.x + col.w / 2, rowY.get(row.key)!, i, list.length),
          lessonId: lessonByWorld.get(w.id) ?? null,
        };
        dots.push(dot);
        if (attack) dotByAttack.set(attack.id, dot);
      });
    }
  }

  // Lineage: each attack links back to the attack it came from in the previous generation.
  const links: MLink[] = [];
  for (const dot of dots) {
    const parentId = dot.attack?.parent_id;
    const parent = parentId ? dotByAttack.get(parentId) : undefined;
    if (!parent || !dot.attack) continue;
    const x1 = parent.cx + DOT_R + 2;
    const x2 = dot.cx - DOT_R - 2;
    const mid = (x1 + x2) / 2;
    links.push({
      id: `${parent.attack!.id}->${dot.attack.id}`,
      d: `M${x1},${parent.cy} C${mid},${parent.cy} ${mid},${dot.cy} ${x2},${dot.cy}`,
      kept: JSON.stringify(parent.attack!.params) === JSON.stringify(dot.attack.params),
    });
  }

  return { width, height, rows, groups, cols, dots, links };
}

/** One dot sits centered; two stack vertically; more spread across the cell. */
function cellOffset(cx: number, cy: number, i: number, n: number): { cx: number; cy: number } {
  if (n === 2) return { cx: cx + (i ? 7 : -7), cy: cy + (i ? 10 : -10) };
  return { cx: cx + (i - (n - 1) / 2) * DOT_GAP, cy };
}

/** The generation in progress, or the last one. */
function currentKey(gens: GenerationState[]): string | null {
  let latest: GenerationState | null = null;
  for (const g of gens) if (g.startedAt !== null && (!latest || g.startedAt >= (latest.startedAt ?? 0))) latest = g;
  return (latest ?? gens.at(-1) ?? null)?.key ?? null;
}
