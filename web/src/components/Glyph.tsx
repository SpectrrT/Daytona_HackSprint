// Status glyphs drawn inside world dots, so a status never relies on color alone.
// Paths are centered on (0, 0) and sized for a dot of radius 9.

import type { WorldStatus } from "../state";

export function GlyphPath({ status }: { status: WorldStatus }) {
  switch (status) {
    case "breached":
      return <path className="dot-glyph" d="M-3.2 -3.2 L3.2 3.2 M3.2 -3.2 L-3.2 3.2" />;
    case "defended":
      return <path className="dot-glyph" d="M-3.6 0.3 L-1.1 2.8 L3.7 -2.6" />;
    case "false_alarm":
      return <path className="dot-glyph" d="M0 -3.6 L0 1 M0 3.6 L0 3.7" />;
    case "clean":
      return <path className="dot-glyph" d="M-3 0 L3 0" />;
    default:
      return null;
  }
}

export const STATUS_LABEL: Record<WorldStatus, string> = {
  pending: "Running",
  breached: "Breached",
  defended: "Defended",
  clean: "Clean control",
  false_alarm: "False alarm",
};

/** A standalone status dot for legends and tables. */
export function StatusDot({ status, size = 16 }: { status: WorldStatus; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="-10 -10 20 20" aria-hidden="true" className={`dot--${status}`}>
      <circle className="dot-body" r="9" style={{ animation: "none" }} />
      <GlyphPath status={status} />
    </svg>
  );
}

/** Status as an icon plus a word: never color alone. */
export function StatusLabel({ status }: { status: WorldStatus }) {
  return (
    <span className={`status status--${status}`}>
      <StatusDot status={status} size={14} />
      {STATUS_LABEL[status]}
    </span>
  );
}
