import { useEffect, useMemo, useState } from 'react';
import type { TimeseriesRow } from '@hollow-purple/shared/charts';
import { MEMORY_ARM_LABELS } from '@hollow-purple/shared/charts';
const colors:Record<string,string>={none:'#77a5ff',flat:'#e4b364',graph:'#be99ff',recorded:'#7dcfc5'};
const label=(arm:string)=>MEMORY_ARM_LABELS[arm]??'Recorded run';
interface Point { generation:number; fresh:number; found:number; fixed:number; passed:number; total:number }
function aggregate(rows:TimeseriesRow[]) {
  return [...new Set(rows.map(r=>r.arm))].map(arm=>{
    const group=rows.filter(r=>r.arm===arm);
    const points=[...new Set(group.map(r=>r.generation))].sort((a,b)=>a-b).map(generation=>{
      const exact=group.filter(r=>r.generation===generation);
      const latest=[...new Set(group.map(r=>r.seed))].flatMap(seed=>{const available=group.filter(r=>r.seed===seed&&r.generation<=generation).sort((a,b)=>b.generation-a.generation);return available[0]?[available[0]]:[];});
      return {generation,fresh:exact.reduce((n,r)=>n+r.breaches_new,0),found:latest.reduce((n,r)=>n+r.breaches_cumulative,0),fixed:latest.reduce((n,r)=>n+r.fixed_cumulative,0),passed:exact.reduce((n,r)=>n+r.heldout_pass,0),total:exact.reduce((n,r)=>n+r.heldout_total,0)};
    });
    const fixes=[...new Set(group.map(r=>r.seed))].sort((a,b)=>a-b).flatMap(seed=>group.filter(r=>r.seed===seed).sort((a,b)=>b.generation-a.generation)[0]?.fix_generations??[]);
    return {arm,points,fixes};
  });
}
function Plot({kind,rows}:{kind:number;rows:TimeseriesRow[]}) {
  const titles=['Breach curve','Found versus fixed','Held-out accuracy','Time to fix'];
  const groups=aggregate(rows);
  const width=560,height=265,left=62,right=20,top=20,bottom=52;
  const points=groups.flatMap(g=>kind===3?g.fixes.map((value,index)=>({x:index+1,y:value})):g.points.filter(p=>kind!==2||p.total>0).map(p=>({x:p.generation,y:kind===0?p.fresh:kind===1?p.found:100*p.passed/p.total})));
  const available=points.length>0;
  const maxX=Math.max(1,...points.map(p=>p.x));const maxY=kind===2?100:Math.max(1,...points.map(p=>p.y));
  const x=(value:number)=>left+value/maxX*(width-left-right);const y=(value:number)=>height-bottom-value/maxY*(height-top-bottom);
  const coord=(p:Point,fixed=false)=>`${x(p.generation)},${y(kind===0?p.fresh:kind===1?(fixed?p.fixed:p.found):100*p.passed/p.total)}`;
  const ylabel=kind===0?'New reproduced breaches':kind===1?'Verified exploit instances':kind===2?'Held-out pass (%)':'Repair generations';
  const generations=[...new Set(points.map(p=>p.x))].sort((a,b)=>a-b);
  return <article className="run-chart"><h3>{titles[kind]}</h3>{!available?<div className="chart-empty">no run yet</div>:<svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${titles[kind]}. ${ylabel}. Real verifier evidence.`}>
    {[0,.25,.5,.75,1].map(f=><g key={f}><line x1={left} x2={width-right} y1={y(f*maxY)} y2={y(f*maxY)} stroke="#34313d"/><text x={left-8} y={y(f*maxY)+4} textAnchor="end">{Number((f*maxY).toFixed(2))}{kind===2?'%':''}</text></g>)}
    {generations.map(g=><text key={g} x={x(g)} y={height-bottom+20} textAnchor="middle">{g}</text>)}
    <text x={width/2} y={height-8} textAnchor="middle">{kind===3?'Fixed exploit, discovery order within seed':'Generation'}</text><text transform={`translate(15 ${height/2}) rotate(-90)`} textAnchor="middle">{ylabel}</text>
    {groups.map((group,groupIndex)=>{const color=colors[group.arm]??colors.recorded;const ps=group.points.filter(p=>kind!==2||p.total>0);return <g key={group.arm}>
      {kind===1&&ps.length>0&&<><polygon points={[...ps.map(p=>coord(p)),...ps.slice().reverse().map(p=>coord(p,true))].join(' ')} fill={color} opacity=".15"/><polyline points={ps.map(p=>coord(p,true)).join(' ')} fill="none" stroke={color} strokeDasharray="5 4" strokeWidth="2"/>{ps.map(p=><circle key={`fixed-${p.generation}`} cx={x(p.generation)} cy={y(p.fixed)} r="4" fill={color}><title>{label(group.arm)}, generation {p.generation}: {p.fixed} fixed, {p.found} found, {p.found-p.fixed} open.</title></circle>)}</>}
      {kind!==3&&<><polyline points={ps.map(p=>coord(p)).join(' ')} fill="none" stroke={color} strokeWidth="2"/>{ps.map(p=><circle key={p.generation} cx={x(p.generation)} cy={y(kind===0?p.fresh:kind===1?p.found:100*p.passed/p.total)} r={Math.max(4,9-2*groupIndex)} fill="#1b1924" stroke={color} strokeWidth="2"><title>{label(group.arm)}, generation {p.generation}: {kind===0?`${p.fresh} new verified breaches`:kind===1?`${p.found} found, ${p.fixed} fixed, ${p.found-p.fixed} open`:`${p.passed}/${p.total} held-out checks passed`}.</title></circle>)}</>}
      {kind===3&&group.fixes.map((value,index)=><rect key={index} x={x(index+1)-10} y={y(value)} width="20" height={Math.max(1,height-bottom-y(value))} fill={color} opacity=".8"><title>{label(group.arm)}, fixed exploit {index+1}: {value} generations to fix.</title></rect>)}
    </g>;})}
  </svg>}<div className="chart-legend">{groups.filter(g=>kind===3?g.fixes.length:kind===2?g.points.some(p=>p.total):true).map(g=><span key={g.arm}><i style={{background:colors[g.arm]??colors.recorded}}/>{label(g.arm)}{kind===2&&g.points.at(-1)?.total?` (${g.points.at(-1)!.passed}/${g.points.at(-1)!.total})`:""}</span>)}{kind===1&&available&&<span>Solid: found · dashed: fixed · shade: open</span>}</div></article>;
}
/** The same four-chart renderer serves FIFO and payments time-series schemas. */
export function RunCharts({runId,pack='fifo'}:{runId?:string;pack?:string}) {
  const [rows,setRows]=useState<TimeseriesRow[]>([]);const [studyId,setStudyId]=useState<string>();const [selection,setSelection]=useState('study');const [connected,setConnected]=useState(false);
  const params=new URLSearchParams(window.location.search);const override=params.get('chartsRun');const selectedPack=params.get('pack')??pack;
  useEffect(()=>{if(selectedPack!=='fifo')return;let disposed=false;void fetch('/api/ablation/latest').then(r=>r.json()).then(value=>{if(!disposed&&value.runId)setStudyId(value.runId);}).catch(()=>{});return()=>{disposed=true;};},[selectedPack]);
  const id=override??(selection==='study'&&studyId?studyId:runId);
  useEffect(()=>{setRows([]);setConnected(false);if(!id)return;const stream=new EventSource(`/api/charts/${encodeURIComponent(id)}/events`);stream.addEventListener('timeseries',event=>{try{const value=JSON.parse((event as MessageEvent).data);if(Array.isArray(value))setRows(value);setConnected(true);}catch{/* Invalid event data earns no chart point. */}});stream.onerror=()=>setConnected(false);return()=>stream.close();},[id]);
  const filtered=useMemo(()=>rows.filter(r=>r.pack===selectedPack),[rows,selectedPack]);
  return <section className="run-charts" aria-label="Verified run charts"><div className="run-charts-heading"><div><small>REAL RUN DATA ONLY</small><h2>Measured progress</h2></div><div>{!override&&studyId&&runId&&<label>Source <select aria-label="Chart data source" value={selection} onChange={e=>setSelection(e.target.value)}><option value="study">Three-arm study</option><option value="run">Selected repair run</option></select></label>}<span>{connected?'Live SSE':'Waiting for evidence'}</span></div></div><div className="run-charts-grid">{[0,1,2,3].map(kind=><Plot key={kind} kind={kind} rows={filtered}/>)}</div><p className="chart-note">{id??'no run yet'} · {selectedPack} · Hover points for counts. Held-out rates include executed checks only. Missing trials and build rejections remain in the experiment report. Fixes require passing retained regression checks. No downward trend is assumed.</p></section>;
}
