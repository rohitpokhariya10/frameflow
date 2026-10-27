/**
 * Generate AI Variations: one saved master becomes 3–5 style variations of itself (its layout, artwork, logos and text
 * kept; fonts, colours, sizes, alignment and a background tint changed), each a fully editable creative. Three plain
 * steps (choose, check the template and the cost, generate), then the results; every option opens in the normal creative
 * editor, where editing never calls the AI again. Only "Generate" queues the one paid style request.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { MASTER_AI_COUNTS, MASTER_AI_OWN_FORMAT, STUDIO_FORMATS, type MasterAiBatch, type MasterAiEstimate, type MasterAiRequest } from '@frameflow/shared';
import { masterApi, masterFileUrl, type MasterView } from './api';
import { Alert } from '../templateStudio/ui';

export async function aiCreativeCall<T>(masterId:string,path='',body?:unknown):Promise<T> {
  const res=await fetch(`/api/template-studio/master-creatives/${encodeURIComponent(masterId)}${path}`,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error?.message??'Could not load AI creatives.');
  return data as T;
}
/** The familiar ratio a size is closest to (within 2%), e.g. 1820 × 2420 → about 3:4. */
const ratio=(w:number,h:number)=>{const r=w/h,hit=[[1,1],[4,5],[3,4],[2,3],[9,16],[1,1.414],[5,4],[4,3],[3,2],[16,9],[1.414,1]].find(([a,b])=>Math.abs(r/(a/b)-1)<=0.02);return hit?(hit[1]===1.414?' (about A-size)':hit[0]===1.414?' (about A-size landscape)':` (about ${hit[0]}:${hit[1]})`):'';};
const formatLabel=(id:string,view?:MasterView)=>id===MASTER_AI_OWN_FORMAT?(view?`Same as this template · ${view.template.source.width} × ${view.template.source.height}`:'Same as this template'):(f=>f?`${f.label} · ${f.width} × ${f.height}`:id)(STUDIO_FORMATS.find(f=>f.id===id));
/** What the batch is doing, in plain words (its stage). */
const progress=(b:MasterAiBatch)=>b.job.currentStage==='save_master_creatives'?'Step 2 of 2 · Building and saving your editable creatives…':b.job.state==='queued'?'Waiting to start…':'Step 1 of 2 · Designing your options… This usually takes under a minute.';

export function AiCreatives({masterId,onBack,onEdit,onManual,onSetup,onOpenRun}:{masterId:string;onBack:()=>void;onEdit:(id:string)=>void;onManual:()=>void;onSetup:()=>void;onOpenRun?:(runId:string)=>Promise<void>}) {
  const [view,setView]=useState<MasterView>(),[options,setOptions]=useState<MasterAiRequest>({count:3,formatId:MASTER_AI_OWN_FORMAT,guidance:''});
  const [estimate,setEstimate]=useState<MasterAiEstimate>(),[batches,setBatches]=useState<MasterAiBatch[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState<{file:string;name:string}>(),[anyway,setAnyway]=useState(false);
  const [sending,setSending]=useState<string>();
  const key=useRef(crypto.randomUUID()),version=useRef(0),wasRunning=useRef(new Set<string>()),headings=useRef(new Map<string,HTMLHeadingElement>());
  const load=useCallback(async()=>{const r=await aiCreativeCall<{batches:MasterAiBatch[]}>(masterId);setBatches(r.batches);},[masterId]);
  useEffect(()=>{
    let live=true;
    void masterApi.get(masterId).then(v=>{if(live)setView(v);}).catch((e:Error)=>{if(live)setError(e.message);});
    void aiCreativeCall<{batches:MasterAiBatch[]}>(masterId).then(r=>{if(live)setBatches(r.batches);}).catch((e:Error)=>{if(live)setError(e.message);});
    return()=>{live=false;};
  },[masterId]);
  const running=batches.some(b=>!b.job.terminal);
  useEffect(()=>{if(!running)return;const timer=setInterval(()=>{void load().catch((e:Error)=>setError(e.message));},2000);return()=>clearInterval(timer);},[running,load]);
  // When a batch finishes while this page is open, move focus to its results.
  useEffect(()=>{for(const b of batches){if(!b.job.terminal)wasRunning.current.add(b.job.id);else if(wasRunning.current.delete(b.job.id))headings.current.get(b.job.id)?.focus();}},[batches]);
  const change=(patch:Partial<MasterAiRequest>)=>{version.current++;setOptions(o=>({...o,...patch}));setEstimate(undefined);setAnyway(false);key.current=crypto.randomUUID();};
  const check=async()=>{
    const v=version.current;setBusy(true);setError('');
    try{const e=await aiCreativeCall<MasterAiEstimate>(masterId,'/estimate',options);if(v===version.current)setEstimate(e);}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  const generate=async()=>{
    if(!estimate)return;setBusy(true);setError('');
    try{await aiCreativeCall(masterId,'',{...options,idempotencyKey:key.current,masterRevision:estimate.masterRevision,approvedMaxUsd:estimate.maxUsd,confirmCost:true,acknowledgeMissingText:anyway});setEstimate(undefined);setAnyway(false);await load();key.current=crypto.randomUUID();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  };
  /** A saved creative's own layers in the decomposition workspace (free, no AI; the creative is not changed). */
  const send=async(id:string)=>{
    if(!onOpenRun||sending)return;setSending(id);setError('');
    try{const r=await masterApi.decompose({masterId,id});await onOpenRun(r.runId);}
    catch(e){setError(`Could not send the creative to decomposition: ${(e as Error).message}`);}finally{setSending(undefined);}
  };
  const test=estimate?.provider==='offline-mock',locked=busy||running,missing=estimate?.readiness.missingText??[],blocked=missing.length>0&&!anyway;
  return <div className="ot-page">
    <div className="ot-head"><div><p className="ot-kicker">Generate AI Variations{view?` · ${view.template.name}`:''}</p><h2>New styles for your saved template</h2>
      <p>AI creates 3 to 5 style variations of this template: new fonts, text colours and sizes, alignment and a background tint. Your layout, artwork, logos and text stay as they are, and everything stays editable.</p></div>
      <div className="ot-row"><button type="button" className="ws-btn ws-btn-quiet" onClick={onManual}>Reuse Template instead (free)</button><button type="button" className="ws-btn" onClick={onBack}>Templates</button></div></div>
    {error&&<Alert>{error}</Alert>}
    <section className="ts-card" aria-labelledby="ai-setup-title"><div className="ts-card-body">
      <h3 id="ai-setup-title">1 · Choose your options</h3>
      <div className="ot-row">
        <label className="ot-field">Number of variations<select aria-label="Number of variations" value={options.count} disabled={locked} onChange={e=>change({count:Number(e.target.value) as MasterAiRequest['count']})}>{MASTER_AI_COUNTS.map(n=><option key={n} value={n}>{n} creatives</option>)}</select></label>
        <label className="ot-field">Aspect ratio<select aria-label="Aspect ratio" value={options.formatId} disabled={locked} onChange={e=>change({formatId:e.target.value})}>
          <option value={MASTER_AI_OWN_FORMAT}>{formatLabel(MASTER_AI_OWN_FORMAT,view)}{view?ratio(view.template.source.width,view.template.source.height):''}</option>
          {STUDIO_FORMATS.map(f=><option key={f.id} value={f.id}>{f.label} · {f.width} × {f.height}</option>)}</select></label>
      </div>
      {options.formatId!==MASTER_AI_OWN_FORMAT&&<p className="ot-small ot-muted">Other sizes show your whole template fitted inside, with a margin around it. Nothing is moved or cropped.</p>}
      <label className="ot-field">Style direction (optional)<textarea aria-label="Creative direction" maxLength={1200} value={options.guidance} disabled={locked} onChange={e=>change({guidance:e.target.value})} placeholder="For example: bold and festive, calm and premium, modern and minimal." /></label>
      <ul className="ot-ai-facts" aria-label="What happens">
        <li><strong>You get</strong> {options.count} style variations, each saved as its own creative.</li>
        <li><strong>Stays exactly as it is:</strong> your layout, artwork and borders, logos, QR codes and all the text, including offer details and legal text.</li>
        <li><strong>Changes:</strong> fonts and weights, text colours and sizes, alignment within each text area, and a subtle background tint. No new pictures are drawn.</li>
        <li><strong>Afterwards:</strong> edit any text, font, colour, logo or position for free. Editing never uses AI again.</li>
        <li><strong>Your template</strong> and its existing creatives do not change.</li>
      </ul>
      <h3>2 · Check your template and the cost</h3>
      {!estimate?<div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={locked} onClick={()=>void check()}>{busy?'Checking your template…':'Check generation cost'}</button><span className="ot-small ot-muted">Free and starts nothing. The first check of a template reads it on this computer (about 10 seconds).</span></div>:<>
        {estimate.readiness.olderCleanup&&<Alert tone="warn"><span data-testid="older-cleanup-ai"><strong>Your template’s clean background was made with an older version of the clean-up</strong> and may show small leftovers (stray marks, white patches) in every variation. Refresh it first, for free: <strong>Edit master → Make it again → Approve background → Save master</strong>.</span>
          <div className="ot-row" style={{marginTop:8}}><button type="button" className="ws-btn" onClick={onSetup}>Edit master</button></div></Alert>}
        {estimate.readiness.excluded.length>0&&<p className="ot-small" role="note">Left out of the variations: {estimate.readiness.excluded.map(e=>`${e.label} (${e.reason})`).join('; ')}.</p>}
        {missing.length>0&&<Alert tone="warn"><strong>Your template is missing text from the original poster: {missing.map(m=>`“${m.text}”`).join(', ')}.</strong>{' '}
          {missing.some(m=>m.inBackground)?'It is still part of the template’s background picture, so it will look as in the original but cannot be restyled or edited.':'It will not appear in the variations.'}{' '}
          Fix it first: <strong>Edit master → Scan Again</strong>, tick the new text, apply, make the clean background again and save the master.
          <div className="ot-row" style={{marginTop:8}}><button type="button" className="ws-btn" onClick={onSetup}>Edit master</button>
            <label className="ot-check"><input type="checkbox" checked={anyway} onChange={e=>setAnyway(e.target.checked)} />Generate anyway, without fixing the template</label></div></Alert>}
        {test&&<Alert tone="warn">Test mode: this server uses FrameFlow’s built-in test designer, not real AI. Nothing is charged; results are labelled “Mock”.</Alert>}
        <p role="status">{test?<>A real run of {options.count} creatives would cost up to <strong>₹{estimate.maxInr.toFixed(2)}</strong>.</>:<>This costs up to <strong>₹{estimate.maxInr.toFixed(2)} (${estimate.maxUsd.toFixed(3)})</strong> for {options.count} creatives. It is usually less.</>}</p>
        <p className="ot-small">{estimate.note}</p>
        {!estimate.configured&&<Alert>The AI service is not set up on this server, so creatives cannot be generated.</Alert>}
        {!estimate.withinCap&&<Alert>This is more than the spending limit set for one request, so it cannot start.</Alert>}
        <h3>3 · Generate</h3>
        <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={locked||blocked||!estimate.configured||!estimate.withinCap} onClick={()=>void generate()}>{busy?'Starting…':`Generate ${options.count} editable creatives`}</button>
          <button type="button" className="ws-btn ws-btn-quiet" disabled={locked} onClick={()=>setEstimate(undefined)}>Change options</button></div>
        <p className="ot-small ot-muted">{test?'Starts the test designer.':'Clicking Generate approves this cost. It is one request; a new set of designs is a new request.'}</p>
      </>}
    </div></section>
    {batches.map(b=>{
      const done=b.job.terminal&&!b.job.error,partial=done&&b.skipped.length>0,mock=b.provider==='offline-mock';
      return <section key={b.job.id} className="ts-card" aria-label={`AI batch ${b.job.id}`}><div className="ts-card-body">
        <h3 tabIndex={-1} ref={el=>{if(el)headings.current.set(b.job.id,el);else headings.current.delete(b.job.id);}}>{done?`${b.creatives.length} of ${b.count} creatives ready`:`${b.count} AI creatives`} · {formatLabel(b.formatId,view)}{mock?' · test (mock)':''}</h3>
        <p className="ot-small ot-muted">{new Date(b.job.createdAt).toLocaleString()}{b.job.terminal?` · ${mock?'no charge (test mode)':`cost ₹${b.job.cost.total.inr.replace(/^₹/,'')}`}`:''}</p>
        {!b.job.terminal&&<p role="status" aria-live="polite">{progress(b)} You can leave this page and come back later.</p>}
        {b.job.error&&<Alert>{b.job.error.message} Nothing was saved from this request, and your existing creatives are safe. Generating again is a new request.</Alert>}
        {partial&&<Alert tone="warn"><strong>Some designs did not pass FrameFlow’s checks, so they were not saved:</strong>
          <ul className="ot-ai-skipped">{b.skipped.map((s,i)=><li key={i}>{s.name?`“${s.name}”: `:''}{s.reason}</li>)}</ul></Alert>}
        {done&&<p>Saved to this template’s creatives. Open one to edit it; changes save automatically.</p>}
        <div className="ot-grid is-wide">{b.creatives.map(c=><article key={c.id} className="ot-card" aria-label={`AI creative ${c.name}`}>
          <img src={masterFileUrl(masterId,c.previewFile)} alt={`First version of ${c.name}`} loading="lazy" style={{aspectRatio:`${b.canvas.width} / ${b.canvas.height}`}}/>
          <div className="ot-card-body"><h4>{c.name}</h4>{c.idea&&<p className="ot-small">{c.idea}</p>}<p className="ot-small ot-muted">First version shown · open it for your latest edits</p>
            <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={()=>onEdit(c.id)}>Open creative</button><button type="button" className="ws-btn" onClick={()=>setPreview({file:c.previewFile,name:c.name})}>Preview</button>
              {onOpenRun&&<button type="button" className="ws-btn" disabled={!!sending} aria-busy={sending===c.id} title="Each text, logo, shape and the background as its own layer, in the decomposition workspace. Free: no AI request." onClick={()=>void send(c.id)}>{sending===c.id?'Preparing layers…':'Send to Decomposition'}</button>}</div>
          </div></article>)}</div>
      </div></section>;
    })}
    {preview&&<div className="ot-ai-preview" role="dialog" aria-modal="true" aria-label="AI creative preview" onKeyDown={e=>{if(e.key==='Escape')setPreview(undefined);}}>
      <button type="button" className="ws-btn" autoFocus onClick={()=>setPreview(undefined)}>Close preview</button>
      <div className="ot-ai-compare">
        {view&&<figure><figcaption>Your template</figcaption><img src={masterFileUrl(masterId,view.template.source.inputFile)} alt="Your template"/></figure>}
        <figure><figcaption>{preview.name}</figcaption><img src={masterFileUrl(masterId,preview.file)} alt={`${preview.name} at full size`}/></figure>
      </div></div>}
  </div>;
}
