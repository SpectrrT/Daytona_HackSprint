// The activity feed: what happened, newest first, in plain words. Derived from state only.

import { money, secs } from "../format";
import { genLabel, genStats, orderedGenerations, type ArenaState } from "../state";

type Kind = "good" | "bad" | "warn" | "lesson" | "accent" | "neutral";
interface Item {
  id: string;
  kind: Kind;
  meta: string;
  title: string;
  body?: string;
}

const CALL_TEXT: Record<string, { title: string; kind: Kind }> = {
  dialing: { title: "Calling the approver", kind: "accent" },
  ringing: { title: "Approver's phone is ringing", kind: "accent" },
  in_progress: { title: "Approver is on the call", kind: "accent" },
  approved: { title: "Approved by the approver", kind: "good" },
  declined: { title: "Declined by the approver; nothing ran on production", kind: "bad" },
  failed: { title: "Call failed; nothing ran on production", kind: "bad" },
  skipped: { title: "No call placed: the final exam did not pass", kind: "warn" },
};

/** Events in the order they happen (generation by generation, then exam, call, commit), newest first.
 *  Built in logical order rather than sorted by timestamp: events land milliseconds apart. */
export function activityItems(s: ArenaState): Item[] {
  const items: Item[] = [];
  for (const g of orderedGenerations(s)) {
    const label = genLabel(g);
    if (g.startedAt !== null) {
      items.push({
        id: `${g.key}:start`,
        kind: "neutral",
        meta: label,
        title: g.exam
          ? `Final exam started on ${g.attackIds.length} held-out attacks`
          : `Started: ${g.attackIds.length} attack worlds, ${g.cleanWorlds} clean worlds`,
      });
    }
    if (g.done) {
      const st = genStats(s, g);
      items.push({
        id: `${g.key}:done`,
        kind: st.survived === st.attackWorlds ? "good" : "bad",
        meta: label,
        title: `${st.survived} of ${st.attackWorlds} attack worlds defended`,
        body: `${money(st.dollarsLost)} lost · ${st.falseAlarms} false alarms · ${secs(st.seconds)}`,
      });
    }
    for (const id of g.lessonIds) {
      const l = s.lessons[id];
      items.push({
        id: `lesson:${id}`,
        kind: "lesson",
        meta: `Lesson · ${label}`,
        title: l.text,
      });
    }
  }
  if (s.exam) {
    const ex = s.exam;
    items.push({
      id: "exam",
      kind: ex.passed ? "good" : "bad",
      meta: "Final exam",
      title: ex.passed
        ? `Passed: ${ex.attack_worlds} of ${ex.attack_worlds} held-out attacks blocked`
        : `Failed: ${ex.breaches} breaches, ${ex.false_alarms} false alarms`,
    });
  }
  s.calls.forEach((c, i) => {
    const text = CALL_TEXT[c.status] ?? { title: c.status, kind: "neutral" as Kind };
    items.push({ id: `call:${i}`, kind: text.kind, meta: "Approval", title: text.title });
  });
  if (s.prod) {
    items.push({
      id: "prod",
      kind: "good",
      meta: "Production",
      title: `Committed ${s.prod.refunds_issued} refunds (${money(s.prod.dollars_refunded)})`,
      body: `Snapshot ${s.prod.snapshot} taken first`,
    });
  }
  return items.reverse();
}

export function Activity({ state }: { state: ArenaState }) {
  const items = activityItems(state).slice(0, 50);
  return (
    <>
      <div className="card-head">
        <div>
          <h2 className="card-title">Activity</h2>
          <div className="card-sub">Select a world to see its details</div>
        </div>
      </div>
      <div className="side-body">
        {items.length === 0 ? (
          <div className="empty" style={{ minHeight: 160 }}>
            Nothing yet.
          </div>
        ) : (
          <ol className="activity" aria-live="polite">
            {items.map((it) => (
              <li key={it.id} className={`activity-item activity-item--${it.kind}`}>
                <span className="activity-dot" aria-hidden="true" />
                <div>
                  <div className="activity-meta">{it.meta}</div>
                  <div className="activity-title">{it.title}</div>
                  {it.body && <div className="activity-body">{it.body}</div>}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </>
  );
}
