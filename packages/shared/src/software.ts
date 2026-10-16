import type { AgentInvocation, EngineeringContract } from "./evolution.js";

export interface CheckoutContract extends EngineeringContract {
  version: 1;
  domain: "software";
  example: "checkout";
  initialStock: 5;
  unitPriceCents: 1999;
}
export type WebAction =
  | { kind: "fill"; target: "request-id" | "quantity"; value: string }
  | { kind: "click" | "double-click"; target: "checkout" }
  | { kind: "reload" };
export interface WebAttack { id: string; name: string; hypothesis: string; actions: WebAction[] }
export interface CheckoutInput { requestId: unknown; quantity: unknown }
export interface HttpObservation { status: number; body: unknown; sourceHash: string }
export interface ObservedRequest { input: CheckoutInput; response: HttpObservation }
export interface RequestBatch { requests: ObservedRequest[] }
export interface CheckoutOrder { id: number; requestId: string; quantity: number; totalCents: number }
export interface LedgerSnapshot { stock: number; orders: CheckoutOrder[]; sourceHash: string; runtimeHash: string }
export interface SoftwareCheck { id: string; passed: boolean; summary: string; requests: number; hidden: boolean }
export interface BrowserTrial {
  attack: WebAttack;
  batches: RequestBatch[];
  ledger: LedgerSnapshot;
  check: SoftwareCheck;
  screenshotPath: string;
}
export interface SoftwareFailure { id: string; summary: string; reproduced: boolean; discovery: BrowserTrial; replay: BrowserTrial }
export interface SoftwareCandidate {
  id: string;
  parentId?: string;
  label: string;
  source: string;
  sourceHash: string;
  importedFixture?: boolean;
  blueAgent?: AgentInvocation;
  redAgent?: AgentInvocation;
  rationale?: string;
  attacks: WebAttack[];
  checks: SoftwareCheck[];
  status: "building" | "testing" | "rejected" | "verified";
  sandboxId?: string;
  appUrl?: string;
  commit?: string;
  error?: string;
}
export interface SoftwareRun {
  id: string;
  status: "running" | "completed" | "failed" | "stopped";
  contract: CheckoutContract;
  candidates: SoftwareCandidate[];
  regressions: SoftwareFailure[];
  lessons: string[];
  events: { at: number; message: string; candidateId?: string }[];
  budget: { maxCandidates: number; maxBrowserActions: number; maxRequests: number; usedBrowserActions: number; usedRequests: number };
  createdAt: number;
  finishedAt?: number;
  championId?: string;
  desktopSandboxId?: string;
  desktopUrl?: string;
  videoPath?: string;
  error?: string;
}
