// Display formatting shared by every view.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdShort = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const money = (n: number): string => usd.format(n);
export const moneyShort = (n: number): string => usdShort.format(n);
export const pct = (x: number | null): string => (x === null ? "—" : `${Math.round(x * 100)}%`);
export const secs = (n: number | null): string => (n === null ? "—" : `${n.toFixed(1)} s`);

/** mm:ss for a replay clock. */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Local wall-clock time for an event ts (unix seconds). */
export function timeOfDay(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function dateTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Compact one-line rendering of attack params: "timeout_ms=3000 · orders=3". */
export function paramsInline(params: Record<string, unknown>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ");
}

export const humanize = (s: string): string => s.replace(/_/g, " ");
