import { useEffect, useState } from 'react';
interface Arm { arm:string; retryPass:number; retryTotal:number; cleanPass:number; cleanTotal:number }
interface Evidence { id?:string; status:string; model?:string; summary?:Arm[]; arize?:{status?:string} }
export function RetryBenchmarkPanel() {
  const [data,setData]=useState<Evidence>();
  useEffect(()=>{let active=true;const update=()=>fetch('/api/benchmarks/retries/latest').then(r=>r.json()).then(value=>{if(active)setData(value);}).catch(()=>{});void update();const timer=setInterval(update,5000);return()=>{active=false;clearInterval(timer);};},[]);
  const count=(passed:number,total:number)=>total?`${passed}/${total}`:'no run yet';
  return <section className="ablation-panel" aria-label="Paired retry safety evidence"><div className="ablation-heading"><div><small>PAIRED SYSTEM COMPARISON</small><h2>Correct effects when requests overlap</h2></div><span>{data?.status??'no run yet'}</span></div><p>Claude receives the full policy. The same model-generated actions run through model-only execution and a Blue-written, verified guard. Each model job sees the same pre-commit state.</p>
    <div className="ablation-arms">{['model-only','verified-guard'].map(name=>{const arm=data?.summary?.find(a=>a.arm===name);return <article key={name}><h3>{name==='model-only'?'Claude, full policy':'Hollow Purple verified guard'}</h3><dl><dt>Retry safety and useful completion</dt><dd>{arm?count(arm.retryPass,arm.retryTotal):'no run yet'}</dd><dt>Clean tasks completed</dt><dd>{arm?count(arm.cleanPass,arm.cleanTotal):'no run yet'}</dd></dl></article>;})}</div>
    <p className="ablation-provenance">{data?.model??'Model pending'} · {data?.id??'Awaiting evidence'} · Arize {data?.arize?.status??'pending'}</p><p className="chart-note">Actual Daytona processes and persisted SQLite effects. This measures atomic tool-state enforcement, separately from the memory ablation. Established idempotency systems are not compared here.</p></section>;
}
