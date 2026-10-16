// Graduation: the plan reaches production only after a passed final exam and a human approval.

import { Check, Circle, Database, FlaskConical, Lock, PhoneCall, X } from "lucide-react";
import type { ReactNode } from "react";
import { StatusLabel } from "../components/Glyph";
import { humanize, money, paramsInline, timeOfDay } from "../format";
import { examGeneration, latestCall, worldsOf, type ArenaState } from "../state";

type StepState = "idle" | "active" | "pass" | "fail";

export function Graduation({ state, onSelectWorld }: { state: ArenaState; onSelectWorld(id: string): void }) {
  const exam = state.exam;
  const examGen = examGeneration(state);
  const call = latestCall(state);
  const prod = state.prod;

  const examStep: StepState = exam ? (exam.passed ? "pass" : "fail") : examGen ? "active" : "idle";
  const callStep: StepState = !call
    ? "idle"
    : call.status === "approved"
      ? "pass"
      : ["declined", "failed", "skipped"].includes(call.status)
        ? "fail"
        : "active";
  const prodStep: StepState = prod ? "pass" : examStep === "fail" || callStep === "fail" ? "fail" : "idle";

  const examWorlds = examGen
    ? [...worldsOf(state, examGen)].sort(
        (a, b) => Number(a.attackId === null) - Number(b.attackId === null) || a.id.localeCompare(b.id),
      )
    : [];

  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Graduation</h1>
        <p className="page-sub" style={{ margin: 0 }}>
          The plan runs on production only after it passes the final exam and a person approves it. Production is
          snapshotted first.
        </p>
      </div>

      <section className="card stepper" aria-label="Graduation steps">
        <Step
          state={examStep}
          icon={<FlaskConical size={17} strokeWidth={2} />}
          name="1. Final exam"
          detail={
            exam
              ? `${exam.attack_worlds - exam.breaches}/${exam.attack_worlds} blocked · ${exam.false_alarms} false alarms`
              : examGen
                ? "Running"
                : "Not started"
          }
        />
        <div className={`step-link${examStep === "pass" ? " step-link--on" : ""}`} aria-hidden="true" />
        <Step
          state={callStep}
          icon={<PhoneCall size={17} strokeWidth={2} />}
          name="2. Human approval"
          detail={call ? capitalize(humanize(call.status)) : "Waiting for the exam"}
        />
        <div className={`step-link${callStep === "pass" ? " step-link--on" : ""}`} aria-hidden="true" />
        <Step
          state={prodStep}
          icon={prod ? <Database size={17} strokeWidth={2} /> : <Lock size={17} strokeWidth={2} />}
          name="3. Production"
          detail={prod ? `Committed · ${money(prod.dollars_refunded)}` : prodStep === "fail" ? "Not run" : "Locked"}
        />
      </section>

      <div className="grad-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h2 className="card-title">Final exam results</h2>
              <div className="card-sub">Held-out attack variants the defender never trained on</div>
            </div>
            {exam && (
              <span className={`badge ${exam.passed ? "badge--good" : "badge--bad"}`}>{exam.passed ? "Passed" : "Failed"}</span>
            )}
          </div>
          {examGen ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>World</th>
                    <th>Attack</th>
                    <th>Parameters</th>
                    <th className="r">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {examWorlds.map((w) => {
                    const a = w.attackId ? state.attacks[w.attackId] : null;
                    return (
                      <tr key={w.id}>
                        <td>
                          <button className="link-btn mono" onClick={() => onSelectWorld(w.id)} title="Show world details">
                            {w.id}
                          </button>
                        </td>
                        <td>{a ? capitalize(humanize(a.type)) : <span className="muted">Clean control</span>}</td>
                        <td className="mono muted">{a ? paramsInline(a.params) : "—"}</td>
                        <td className="r">
                          <StatusLabel status={w.status} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="card-body secondary">The exam runs after the last training generation.</div>
          )}
        </section>

        <div className="grad-col">
          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Approval call</h2>
                <div className="card-sub">ElevenLabs voice agent calls the approver</div>
              </div>
            </div>
            <div className="card-body">
              {state.calls.length ? (
                <ol className="timeline-list">
                  {state.calls.map((c, i) => {
                    const bad = ["declined", "failed", "skipped"].includes(c.status);
                    return (
                      <li key={i} className={`timeline-row timeline-row--done${bad ? " timeline-row--bad" : ""}`}>
                        {bad ? <X size={15} strokeWidth={2} /> : <Check size={15} strokeWidth={2} />}
                        <span style={{ flex: 1 }}>{capitalize(humanize(c.status))}</span>
                        <span className="muted num">{timeOfDay(c.ts)}</span>
                      </li>
                    );
                  })}
                  {callStep === "active" && (
                    <li className="timeline-row">
                      <Circle size={15} strokeWidth={2} />
                      Waiting for a decision
                    </li>
                  )}
                </ol>
              ) : (
                <div className="secondary">No call yet. The approver is called only after the exam passes.</div>
              )}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title">Production</h2>
                <div className="card-sub">The one real, irreversible action</div>
              </div>
              {prod && <span className="badge badge--good">Committed</span>}
            </div>
            <div className="card-body">
              {prod ? (
                <div style={{ display: "grid", gap: 12 }}>
                  <div>
                    <div className="big-number num">{money(prod.dollars_refunded)}</div>
                    <div className="secondary">refunded to {prod.refunds_issued} customers</div>
                  </div>
                  <dl className="kv">
                    <dt>Plan</dt>
                    <dd className="mono">{prod.plan_id}</dd>
                    <dt>Snapshot taken before commit</dt>
                    <dd className="mono">{prod.snapshot}</dd>
                  </dl>
                </div>
              ) : (
                <div className="secondary" style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <Lock size={15} strokeWidth={2} />
                  {prodStep === "fail" ? "Nothing ran on production." : "Locked until both steps above pass."}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Step({ state, icon, name, detail }: { state: StepState; icon: ReactNode; name: string; detail: string }) {
  return (
    <div className={`step step--${state}`}>
      <div className="step-icon">
        {state === "pass" ? <Check size={18} strokeWidth={2.25} /> : state === "fail" ? <X size={18} strokeWidth={2.25} /> : icon}
      </div>
      <div>
        <div className="step-name">{name}</div>
        <div className="step-state">{detail}</div>
      </div>
    </div>
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
