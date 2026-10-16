// Details for one world: the attack, the grader's verdict, Blue's plan, and the sandbox.

import { Check, ExternalLink, Info, Lightbulb, Minus, X } from "lucide-react";
import type { Knobs } from "../contracts";
import { humanize, money, secs } from "../format";
import { genLabel, planForWorld, type ArenaState, type WorldState } from "../state";
import { StatusLabel } from "./Glyph";

const KNOBS: { label: string; value(k: Knobs): string | null }[] = [
  { label: "Idempotency key", value: (k) => (k.idempotency_key ? "on" : null) },
  { label: "Verify before retry", value: (k) => (k.verify_before_retry ? "on" : null) },
  { label: "Per-order lock", value: (k) => (k.per_order_lock ? "on" : null) },
  { label: "Trust payment provider", value: (k) => (k.trust_source === "provider" ? "on" : null) },
  { label: "Ticket policy", value: (k) => (k.ticket_policy !== "follow" ? humanize(k.ticket_policy) : null) },
  { label: "Per-customer cap", value: (k) => (k.per_customer_cap !== null ? money(k.per_customer_cap) : null) },
];

export function WorldDetails({ state, world, onClose }: { state: ArenaState; world: WorldState; onClose(): void }) {
  const r = world.result;
  const attack = world.attackId ? state.attacks[world.attackId] : null;
  const plan = planForWorld(state, world);
  const gen = state.generations[world.genKey];
  const lesson = state.lessonOrder.map((id) => state.lessons[id]).find((l) => l.world_id === world.id);

  return (
    <>
      <div className="card-head">
        <div>
          <h2 className="card-title">
            World <span className="mono">{world.id}</span>
          </h2>
          <div className="card-sub">{gen ? genLabel(gen) : `Gen ${world.generation}`}</div>
        </div>
        <button className="icon-btn" aria-label="Close details (Esc)" title="Close (Esc)" onClick={onClose}>
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      <div className="side-body">
        <section className="section">
          <div className="section-title">Verdict</div>
          <StatusLabel status={world.status} />
          {r ? (
            <div className="metrics">
              <Metric label="Overpaid" value={money(r.dollars_over)} bad={r.dollars_over > 0} />
              <Metric label="Missed" value={money(r.dollars_missed)} bad={r.dollars_missed > 0} />
              <Metric label="Duplicates" value={String(r.duplicate_refunds)} bad={r.duplicate_refunds > 0} />
              <Metric label="Injections" value={String(r.injections_followed)} bad={r.injections_followed > 0} />
              <Metric label="Task" value={r.task_complete ? "Done" : "Unfinished"} bad={!r.task_complete} />
              <Metric label="Time" value={secs(r.seconds)} />
            </div>
          ) : (
            <div className="secondary" style={{ fontSize: 13 }}>
              Still running. The verdict arrives when the grader scores this generation.
            </div>
          )}
          {world.status === "breached" && (
            <div className="callout">
              <Info size={14} strokeWidth={2} aria-hidden="true" />
              This sandbox is paused and kept as evidence.
            </div>
          )}
          {lesson && (
            <div className="callout callout--lesson">
              <Lightbulb size={14} strokeWidth={2} aria-hidden="true" />
              {lesson.text}
            </div>
          )}
        </section>

        <section className="section">
          <div className="section-title">Attack</div>
          {attack ? (
            <>
              <div style={{ fontWeight: 500 }}>
                {capitalize(humanize(attack.type))} <span className="muted">· {attack.family}</span>
              </div>
              <div className="chips">
                {Object.entries(attack.params).map(([k, v]) => (
                  <span key={k} className="chip">
                    {humanize(k)}: {String(v)}
                  </span>
                ))}
                {attack.held_out && <span className="chip">held out</span>}
              </div>
              <dl className="kv">
                <dt>Mutated from</dt>
                <dd className="mono">{attack.parent_id ?? "—"}</dd>
                <dt>Seed</dt>
                <dd className="mono">{attack.seed}</dd>
              </dl>
            </>
          ) : (
            <div className="secondary" style={{ fontSize: 13 }}>
              None. This is a clean control world: same plan, no attack.
            </div>
          )}
        </section>

        {plan && (
          <section className="section">
            <div className="section-title">
              Defender plan · <span className="mono">{plan.id}</span>
            </div>
            <ul className="knobs">
              {KNOBS.map((k) => {
                const v = k.value(plan.knobs);
                return (
                  <li key={k.label} className={`knob${v ? " knob--on" : ""}`}>
                    {v ? <Check size={14} strokeWidth={2} /> : <Minus size={14} strokeWidth={2} />}
                    {k.label}
                    {v && v !== "on" && <span className="muted">· {v}</span>}
                  </li>
                );
              })}
              <li className="knob knob--on">
                <Check size={14} strokeWidth={2} />
                Max retries <span className="muted">· {plan.knobs.max_retries}</span>
              </li>
            </ul>
            <div className="chips">
              {plan.permissions.map((p) => (
                <span key={p} className="chip mono">
                  {p}
                </span>
              ))}
            </div>
            <pre className="code">{plan.selection_sql}</pre>
          </section>
        )}

        <section className="section">
          <div className="section-title">Sandbox</div>
          <dl className="kv">
            <dt>ID</dt>
            <dd className="mono">{world.sandboxId}</dd>
          </dl>
          {r?.preview_url ? (
            <a className="external" href={r.preview_url} target="_blank" rel="noreferrer">
              Open this sandbox <ExternalLink size={13} strokeWidth={2} />
            </a>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              No preview link{state.backend === "fake" ? " (fake backend)" : ""}.
            </span>
          )}
        </section>
      </div>
    </>
  );
}

function Metric({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className={`metric${bad ? " metric--bad" : ""}`}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
