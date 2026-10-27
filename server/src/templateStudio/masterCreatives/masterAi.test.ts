import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import sharp from 'sharp';
import { MASTER_CLEANUP_VERSION, STUDIO_FORMATS, drawableOfferStyle, masterAiCanvas, offerFace, olderCleanup, type DetectedWord, type MasterSnapshot, type CreativeInstance, type MasterAiBatch, type MasterAiEstimate, type MasterAiRequest } from '@frameflow/shared';
import { createLayerizeRouter } from '../../decomposition/layerizeRouter.js';
import { fileProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import { MASTER_WORDS, masterPosterPng } from '../../decomposition/protectedTemplates/master/masterPoster.fixture.js';
import type { MasterView } from '../../decomposition/protectedTemplates/master/service.js';
import { fakeRecognizer, type WordRecognizer } from '../../textRecognition/recognizer.js';
import { offerFontFile } from '../../textRecognition/fontMatch.js';
import { createTemplateStudioRouter } from '../router.js';
import { parseStudioEnv } from '../config.js';
import { FakeProvider } from '../testing/fakeProvider.js';
import { mockMasterPlan } from '../testing/masterCreativePlan.js';
import { claimNextJob } from '../jobs/queue.js';
import { runJob } from '../jobs/runner.js';
import { generateMasterCreativesJob } from '../jobs/kinds/generateMasterCreatives.js';
import { masterPlanSchema, masterRequest, checkMasterPlan, creativeOfPlan, acceptOptions, styledGroup, type MasterPlan } from './plan.js';
import { lineText, masterContent } from './content.js';
import { planContext, recipeFileOf } from './service.js';
import { renderMasterCreative } from './render.js';
import type { RunRecord } from '../../decomposition/layerizeExperiment.js';
import type { Provider, StructuredRequest } from '../ai/provider.js';

describe('AI style variations: production routes, queue and editable persistence (mock provider)', {timeout:120000},()=>{
  const root=mkdtempSync(join(tmpdir(),'ff-master-ai-')),store=fileProtectedStore(join(root,'protected')),provider=new FakeProvider(),recognizer=fakeRecognizer(MASTER_WORDS);
  // The template check reads the poster with its own recognizer: the master's words, or (version "extra") one word more.
  const extraWord={text:'Extra',confidence:0.95,box:{x:780,y:600,width:120,height:50}},plain=fakeRecognizer(MASTER_WORDS),extra=fakeRecognizer([...MASTER_WORDS,extraWord]);
  let withExtra=false;
  const readiness:WordRecognizer={engine:{name:'fake-readiness',version:'plain',model:'fixture',modes:['fixture']},recognize:input=>(withExtra?extra:plain).recognize(input)};
  const env=parseStudioEnv({STUDIO_MAX_JOB_BUDGET_USD:'10',STUDIO_DAILY_BUDGET_USD:'100'},join(root,'studio'));
  const studio=createTemplateStudioRouter({env,provider,worker:false,protectedDir:store.root,masterRecognizer:()=>readiness});
  const app=express().use('/api/layerize-experiment',createLayerizeRouter({protectedDir:store.root,runsDir:join(root,'runs'),masterRecognizer:()=>recognizer,deps:()=>{throw new Error('Paid decomposition forbidden');}})).use('/api/template-studio',studio);
  const server=app.listen(0,'127.0.0.1');
  let base:string,id:string,snapshot:MasterSnapshot,masterBytes:Buffer,manualBytes:Buffer,manualId:string,ocr:number;
  const call=async(path:string,body?:unknown,method='POST')=>{
    const r=await fetch(base+path,body===undefined?undefined:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:r.status,data:await r.json()};
  };
  const master=()=>`/api/layerize-experiment/master-templates/${id}`;
  const ai=()=>`/api/template-studio/master-creatives/${id}`;
  const execute=async()=>{
    const job=claimNextJob(studio.studio.db,'test',60000)!;
    return runJob(studio.studio.db,job,generateMasterCreativesJob,{workerId:'test',leaseMs:60000,env,provider,storageDir:env.assetStorageDir,protectedStore:()=>store});
  };
  /** The real request for options (no provider call), and its context for checks. */
  const prepared=async(options:MasterAiRequest)=>{
    const canvas=masterAiCanvas(options.formatId,snapshot.canvas)!,{ctx,artworkImage}=await planContext(store,snapshot,options,canvas,[]);
    return {ctx,req:masterRequest(ctx,options,env.OPENAI_PLANNER_MODEL,'low',{source:Buffer.alloc(0),artwork:artworkImage})};
  };
  const start=async(key:string,options:MasterAiRequest={count:3,formatId:'master',guidance:''})=>{
    const est=(await call(`${ai()}/estimate`,options)).data as MasterAiEstimate;
    const r=await call(ai(),{...options,idempotencyKey:key,confirmCost:true,masterRevision:1,approvedMaxUsd:est.maxUsd});
    expect(r.status,JSON.stringify(r.data)).toBe(202);
    return r.data as MasterAiBatch;
  };
  const batchOf=async(jobId:string)=>(await call(ai())).data.batches.find((b:MasterAiBatch)=>b.job.id===jobId) as MasterAiBatch;
  /** Answers the next structured calls with these bodies (one per call), then restores the mock. */
  const answering=async<T>(bodies:(string|((req:StructuredRequest)=>unknown))[],run:()=>Promise<T>)=>{
    // A correction request is text only: answers are built from the first (full) request, as a model would answer it.
    const original=provider.structured.bind(provider);let n=0,first:StructuredRequest|undefined;
    (provider as Provider).structured=async req=>{first??=req;const b=bodies[Math.min(n++,bodies.length-1)];const body=typeof b==='string'?b:JSON.stringify(b(first));return {text:body,refusal:null,incompleteReason:null,usage:{input_tokens:100,output_tokens:100},requestId:`answer-${n}`};};
    try{return {result:await run(),calls:n};}finally{provider.structured=original;}
  };
  beforeAll(async()=>{
    if(!server.listening)await new Promise(r=>server.once('listening',r));
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const form=new FormData();form.append('name','Generic offer master');form.append('image',new Blob([new Uint8Array(await masterPosterPng())],{type:'image/png'}),'source.png');
    const r=await fetch(base+'/api/layerize-experiment/master-templates',{method:'POST',body:form});
    let v=await r.json() as MasterView;id=v.template.id;
    for(let n=0;n<1200&&v.stage==='scanning';n++){await new Promise(r=>setTimeout(r,50));v=(await call(master())).data;}
    expect(v.stage).toBe('review');
    for(const action of ['review/approve-all','prepare','background/approve','publish']){
      const res=await call(`${master()}/${action}`,{expectedRevision:v.template.revision,includeUncertain:true,acknowledgeEstimate:true});
      expect(res.status,JSON.stringify(res.data)).toBe(200);v=res.data;
    }
    snapshot=(await call(`${master()}/revisions/1`)).data;
    const c=(await call(`${master()}/creatives`,{})).data as CreativeInstance;manualId=c.id;
    masterBytes=store.read(id,'template.json');manualBytes=store.read(id,`creative-${manualId}.json`);ocr=recognizer.calls.length;
  },120000);
  afterAll(async()=>{await new Promise<void>(r=>server.close(()=>r()));});

  it.each([3,4,5] as const)('generates exactly %i style variations that keep every element in place and stay editable',async count=>{
    const formatId=count===3?'master':count===4?'story-9-16':'landscape-16-9',options={count,formatId,guidance:'Different typography'};
    const est=(await call(`${ai()}/estimate`,options)).data as MasterAiEstimate;
    expect(est.configured).toBe(true);expect(est.withinCap).toBe(true);expect(est.artwork).toBe(true);expect(est.readiness).toEqual({excluded:[],missingText:[],olderCleanup:false});
    const input={...options,idempotencyKey:`count-test-${count}`,masterRevision:1,approvedMaxUsd:est.maxUsd,confirmCost:true};
    const starts=await Promise.all([call(ai(),input),call(ai(),input)]);
    expect(starts.map(r=>r.status)).toEqual([202,202]);
    const batch=starts[0].data as MasterAiBatch;expect(starts[1].data.job.id).toBe(batch.job.id);
    const callsBefore=provider.calls.length;
    expect(await execute()).toBe('complete');expect(provider.calls.length).toBe(callsBefore+1);
    const saved=await batchOf(batch.job.id);
    expect(saved.creatives).toHaveLength(count);expect(saved.skipped).toEqual([]);expect(saved.job.terminal).toBe(true);expect(saved.provider).toBe('offline-mock');
    const canvas=masterAiCanvas(formatId,snapshot.canvas)!,k=Math.min(canvas.width/snapshot.canvas.width,canvas.height/snapshot.canvas.height);
    const fx=(canvas.width-snapshot.canvas.width*k)/2,fy=(canvas.height-snapshot.canvas.height*k)/2,content=masterContent(snapshot,new Set());
    const baselines=content.groups.flatMap(g=>g.lines.map(l=>fy+l.px.baselineY*k));
    const all:CreativeInstance[]=[];
    for(const item of saved.creatives){
      const c=(await call(`${master()}/creatives/${item.id}`)).data as CreativeInstance;all.push(c);
      expect(c.canvas).toEqual(canvas);expect(c.origin.kind).toBe('ai');expect(c.generation!.provider).toBe('offline-mock');
      // The master's structure: its artwork whole and locked, every logo at its saved box, every word on a saved baseline, all its text.
      const art=c.images.find(i=>i.artwork)!;
      expect(art.locked).toBe(true);expect(art.box.x).toBeCloseTo(fx,0);expect(art.box.width).toBeCloseTo(snapshot.canvas.width*k,0);
      for(const slot of content.slots){const im=c.images.find(i=>i.slotId===slot.id)!;expect(im.box.x).toBeCloseTo(fx+slot.box.x*k,3);expect(im.box.y).toBeCloseTo(fy+slot.box.y*k,3);expect(im.box.width).toBeCloseTo(slot.box.width*k,3);}
      expect(c.texts.every(t=>baselines.some(b=>Math.abs(b-t.baselineY)<0.01))).toBe(true);
      for(const g of content.groups) expect(c.texts.filter(t=>t.groupId===g.id).map(t=>t.text).join(' ').toLowerCase()).toBe(g.text.toLowerCase());
      expect(c.shapes.map(s=>s.box.x)).toEqual(content.groups.filter(g=>g.plate).map(g=>fx+g.plate!.box.x*k));
      for(const i of c.images) if(i.asset.kind==='creative') expect(store.has(id,i.asset.file)).toBe(true);
      expect((await sharp(store.read(id,item.previewFile)).metadata()).width).toBe(canvas.width);
      const recipe=JSON.parse(store.read(id,c.generation!.recipeFile).toString());
      expect(recipe.version).toBe(4);expect(recipe.provider).toBe('offline-mock');expect(recipe.input.request.system).toContain('layout is fixed');expect(recipe.plan.variations).toHaveLength(count);
      expect(recipe.usage).toHaveLength(1);expect(recipe.input.options).toEqual(options);expect(recipe.completedCount).toBe(count);expect(recipe.input.readiness).toEqual({excluded:[],missingText:[],olderCleanup:false});
    }
    // Styles differ: each option its own headline face.
    const headline=content.groups.find(g=>g.category==='headline')!,lead=(c:CreativeInstance)=>{const ts=c.texts.filter(t=>t.groupId===headline.id);return ts.find(t=>t.style.fontSize===Math.max(...ts.map(x=>x.style.fontSize)))!.style.fontFamily;};
    expect(new Set(all.map(lead)).size).toBe(count);
    const cid=saved.creatives[0].id,c=(await call(`${master()}/creatives/${cid}`)).data as CreativeInstance;
    c.texts[0].text='Edited';c.texts[0].x+=17;c.texts[0].style.color='#123456';const logo=c.images.find(i=>!i.artwork)!;logo.box.x+=12;
    const edited=await call(`${master()}/creatives/${cid}`,{expectedRevision:c.revision,creative:c},'PUT');
    expect(edited.status,JSON.stringify(edited.data)).toBe(200);
    const reopened=(await call(`${master()}/creatives/${cid}`)).data;
    expect(reopened.texts).toEqual(c.texts);expect(reopened.images).toEqual(c.images);expect(reopened.generation).toEqual(c.generation);expect(reopened.backgroundColor).toBe(c.backgroundColor);
    expect(store.read(id,'template.json')).toEqual(masterBytes);expect(store.read(id,`creative-${manualId}.json`)).toEqual(manualBytes);
    // Generating and editing made no read with the master's recognizer and no further AI request.
    expect(recognizer.calls.length).toBe(ocr);expect(provider.calls.length).toBe(callsBefore+1);
    // Same HTTP request after completion never repeats billing or resets edits.
    expect((await call(ai(),input)).data.job.id).toBe(batch.job.id);
    expect((await call(`${master()}/creatives/${cid}`)).data.texts[0].text).toBe('Edited');
    expect((await call(ai(),{...input,count:count===3?4:3})).status).toBe(422);
  });

  it('checks every format and rejects missing styles, wrong lines, legal case, unknown shapes, harsh tints, low contrast and look-alikes',async()=>{
    for(const formatId of ['master',...STUDIO_FORMATS.map(f=>f.id)]){
      const {ctx,req}=await prepared({count:3,formatId,guidance:''}),plan=masterPlanSchema.parse(mockMasterPlan(req));
      expect(checkMasterPlan(plan,ctx),formatId).toEqual([]);
      const c=creativeOfPlan(snapshot,plan.variations[0],{jobId:'job-formats',index:0,at:'now',canvas:ctx.canvas,formatId,count:3,model:req.model,provider:'offline-mock',artwork:null,backings:new Map()},ctx);
      expect(c.canvas).toEqual(ctx.canvas);
    }
    const {ctx,req}=await prepared({count:3,formatId:'master',guidance:''}),good=masterPlanSchema.parse(mockMasterPlan(req));
    const broken=(edit:(p:MasterPlan)=>void)=>{const p=structuredClone(good);edit(p);return checkMasterPlan(p,ctx).join(' | ');};
    const group=(p:MasterPlan,category:string)=>p.variations[0].groups.find(g=>ctx.content.groups.find(x=>x.id===g.groupId)?.category===category)!;
    expect(broken(p=>{p.variations[0].groups.pop();})).toContain('exactly once');
    expect(broken(p=>{const g=group(p,'headline');g.lines=g.lines.slice(1);})).toMatch(/exactly \d+ line styles/);
    expect(broken(p=>{group(p,'legal').uppercase=true;})).toContain('original letter case');
    expect(broken(p=>{p.variations[0].plates.push({plateId:'pp-0000000000',color:'#000000'});})).toContain('not one of the supplied shapes');
    expect(broken(p=>{p.variations[0].field='#102030';})).toContain('lightness');
    expect(broken(p=>{const g=group(p,'supporting');g.lines=g.lines.map(l=>({...l,color:p.variations[0].field}));})).toContain('contrast');
    expect(broken(p=>{p.variations[1]=structuredClone(p.variations[0]);})).toContain('same face and case');
    expect(broken(p=>{const l=group(p,'headline').lines[0];l.fontFamily='Anton';l.fontWeight='700';l.italic=false;})).toMatch(/Anton has no 700 face/);
    // A missing face is a soft problem: asked to be corrected, but the option is still usable.
    const soft=structuredClone(good),l=soft.variations[0].groups.find(g=>ctx.content.groups.find(x=>x.id===g.groupId)?.category==='headline')!.lines[0];l.fontFamily='Anton';l.fontWeight='700';l.italic=false;
    expect(acceptOptions(soft,ctx).variations).toHaveLength(3);
    // Fitting: a wider, larger face shrinks inside its own place and never leaves it.
    for(const g of ctx.content.groups){
      const wide={groupId:g.id,align:'left' as const,uppercase:true,letterSpacing:0.12,lines:g.lines.map(()=>({fontFamily:'Archivo Black',fontWeight:'400' as const,italic:false,color:'#111111',scale:1.25}))};
      const place=g.plate?.box??g.area;
      for(const line of styledGroup(g,wide).lines){expect(line.fit).toBeLessThanOrEqual(1);expect(line.ink.x).toBeGreaterThanOrEqual(place.x-1);expect(line.ink.x+line.ink.width).toBeLessThanOrEqual(place.x+place.width+1);}
    }
  });

  it('joins words a scan split (measured with their font), leaves out placeholders and blank pictures, and reports them',()=>{
    const w=structuredClone(snapshot.words.find(x=>x.text==='SALE')!),style=drawableOfferStyle(w.style.fontFamily,w.style.fontWeight,w.style.fontStyle==='italic');
    const font=offerFontFile(offerFace(w.style.fontFamily,style.weight,style.italic?'italic':'normal')!),adv=(t:string)=>font.getAdvanceWidth(t,w.style.fontSize,{kerning:true});
    const part=(text:string,x:number):DetectedWord=>({...structuredClone(w),id:`pw-${text.toLowerCase().padEnd(10,'0').slice(0,10)}`,text,box:{...w.box,x},style:{...w.style,originDx:0}});
    const origin=w.box.x;
    expect(lineText([part('SA',origin),part('LE',origin+adv('SA'))])).toBe('SALE');
    expect(lineText([part('SA',origin),part('LE',origin+adv('SA '))])).toBe('SA LE');
    // A box drawn in review and never filled in, and a blank picture, are left out with a reason.
    const s=structuredClone(snapshot),placeholder={...structuredClone(s.words[0]),id:'pw-0000000002',text:'Text',origin:'admin' as const,recognized:{text:'Text',confidence:1,mode:'admin'}};
    s.words.push(placeholder);s.groups[0].lines[0].wordIds.push(placeholder.id);
    const c=masterContent(s,new Set([s.logoSlots[0].id]));
    expect(c.excluded.map(e=>e.kind)).toEqual(['text','image']);
    expect(c.groups.flatMap(g=>g.lines.map(x=>x.text)).join(' ')).not.toContain('Text');
    expect(c.slots.map(x=>x.id)).not.toContain(s.logoSlots[0].id);
  });

  it('reports text the template lacks and generates only on an explicit choice',async()=>{
    withExtra=true;readiness.engine.version='extra';
    try{
      const options={count:3 as const,formatId:'master',guidance:''},est=(await call(`${ai()}/estimate`,options)).data as MasterAiEstimate;
      expect(est.readiness.missingText.map(m=>m.text)).toEqual(['Extra']);
      const body={...options,idempotencyKey:'missing-text-1',confirmCost:true,masterRevision:1,approvedMaxUsd:est.maxUsd};
      const refused=await call(ai(),body);
      expect(refused.status).toBe(409);expect(refused.data.error.code).toBe('missing_text');
      const accepted=await call(ai(),{...body,acknowledgeMissingText:true});
      expect(accepted.status).toBe(202);
      expect(await execute()).toBe('complete');
      const saved=await batchOf(accepted.data.job.id),c=(await call(`${master()}/creatives/${saved.creatives[0].id}`)).data as CreativeInstance;
      expect(JSON.parse(store.read(id,recipeFileOf(accepted.data.job.id)).toString()).input.readiness.missingText[0].text).toBe('Extra');
      expect(c.texts.map(t=>t.text)).not.toContain('Extra');
    }finally{withExtra=false;readiness.engine.version='plain';}
  });

  it('refuses invalid counts, ratios, missing cost consent, stale snapshots and insufficient caps before a provider call',async()=>{
    const n=provider.calls.length;
    expect((await call(`${ai()}/estimate`,{count:2,formatId:'square'})).status).toBe(400);
    expect((await call(`${ai()}/estimate`,{count:3,formatId:'custom'})).status).toBe(400);
    expect((await call(ai(),{count:3,formatId:'square'})).status).toBe(400);
    const input={count:3,formatId:'square',guidance:'',idempotencyKey:'invalid-test',confirmCost:true,masterRevision:1,approvedMaxUsd:0};
    expect((await call(ai(),{...input,masterRevision:99})).status).toBe(409);
    expect((await call(ai(),input)).status).toBe(409);expect(provider.calls).toHaveLength(n);
  });
  it('rejects a changed immutable snapshot without a provider call',async()=>{
    const bytes=store.read(id,'master-r1.json'),calls=provider.calls.length;
    store.write(id,'master-r1.json',Buffer.from(`${bytes.toString()}\n`));
    try{
      const r=await call(`${ai()}/estimate`,{count:3,formatId:'square'});
      expect(r.status).toBe(422);expect(r.data.error.message).toContain('changed on disk');
      expect(provider.calls).toHaveLength(calls);
    }finally{store.write(id,'master-r1.json',bytes);}
  });
  it.each([true,false])('allows one bounded correction, recovery=%s; persists both billable responses',async recover=>{
    const batch=await start(`correction-${recover}`);
    const {result,calls}=await answering(['{}',recover?mockMasterPlan:''],execute);
    expect(result).toBe(recover?'complete':'failed');expect(calls).toBe(2);
    const saved=await batchOf(batch.job.id);
    expect(saved.creatives).toHaveLength(recover?3:0);
    const usage=studio.studio.db.usage.filter(u=>u.jobId===batch.job.id);
    expect(usage).toHaveLength(2);expect(usage[0].response?.text).toBe('{}');
    if(!recover){expect(saved.job.error!.code).toBe('invalid_output');expect(store.has(id,recipeFileOf(batch.job.id))).toBe(false);}
  });
  it('saves the options that pass when one still fails after its correction, and says which and why',async()=>{
    const batch=await start('partial-test');
    // Option 2 keeps legal text in capitals and option 3 is incomplete in both answers; option 1 is fine.
    const bad=(req:StructuredRequest)=>{
      const p=mockMasterPlan(req) as MasterPlan,legal=snapshot.groups.find(g=>g.category==='legal')!.id;
      p.variations[1].groups.find(g=>g.groupId===legal)!.uppercase=true;delete (p.variations[2] as Partial<MasterPlan['variations'][number]>).groups;return p;
    };
    const {result,calls}=await answering([bad,bad],execute);
    expect(result).toBe('complete');expect(calls).toBe(2);
    const saved=await batchOf(batch.job.id);
    expect(saved.creatives).toHaveLength(1);
    expect(saved.skipped).toHaveLength(2);
    expect(saved.skipped[0].reason).toContain('letter case');expect(saved.skipped[1].reason).toContain('incomplete');
    const recipe=JSON.parse(store.read(id,recipeFileOf(batch.job.id)).toString());
    expect(recipe.requestedCount).toBe(3);expect(recipe.completedCount).toBe(1);expect(recipe.skipped).toHaveLength(2);
  });
  it('fails honestly on empty answers and refusals, creating nothing',async()=>{
    const empty=await start('empty-test');
    const {result}=await answering(['',''],execute);
    expect(result).toBe('failed');
    const e=await batchOf(empty.job.id);expect(e.creatives).toEqual([]);expect(e.job.error!.code).toBe('invalid_output');
    const refused=await start('refusal-test');
    const original=provider.structured.bind(provider);
    (provider as Provider).structured=async()=>({text:null,refusal:'Refused test',incompleteReason:null,usage:{input_tokens:10,output_tokens:1},requestId:'refused'});
    try{expect(await execute()).toBe('failed');}finally{provider.structured=original;}
    const r=await batchOf(refused.job.id);
    expect(r.creatives).toEqual([]);expect(r.job.error!.code).toBe('refusal');expect(store.has(id,recipeFileOf(r.job.id))).toBe(false);
    expect(readFileSync(join(store.root,id,'template.json'))).toEqual(masterBytes);
  });
  it('a resumed save never overwrites an edited creative, and a damaged creative file does not hide the batch',async()=>{
    const batch=await start('resume-test');
    expect(await execute()).toBe('complete');
    const saved=await batchOf(batch.job.id),cid=saved.creatives[0].id,c=(await call(`${master()}/creatives/${cid}`)).data as CreativeInstance;
    c.texts[0].text='Kept';expect((await call(`${master()}/creatives/${cid}`,{expectedRevision:c.revision,creative:c},'PUT')).status).toBe(200);
    const before=store.read(id,`creative-${cid}.json`),db=studio.studio.db,job=db.jobs.require(batch.job.id,'Job');
    const design=db.stages.find(s=>s.jobId===job.id&&s.stage==='design_master_creatives')!.output;
    const out=await generateMasterCreativesJob.stages[1].run({db,job,outputs:{design_master_creatives:design},signal:new AbortController().signal,deps:{workerId:'test',leaseMs:60000,storageDir:env.assetStorageDir,env,provider,protectedStore:()=>store}});
    expect((out as {creativeIds:string[]}).creativeIds).toEqual(saved.creatives.map(x=>x.id));
    expect(store.read(id,`creative-${cid}.json`)).toEqual(before);
    store.write(id,`creative-${saved.creatives[1].id}.json`,Buffer.from('{not json'));
    const listed=await batchOf(batch.job.id);
    expect(listed.creatives.map(x=>x.id)).toEqual([saved.creatives[0].id,saved.creatives[2].id]);
  });

  // Runs last: it publishes revision 2 of the shared master.
  it('sends a variation to decomposition (its own layers, free, one run per revision); a repaired background reaches creatives only on request',async()=>{
    const batch=await start('decomposition-test');expect(await execute()).toBe('complete');
    const cid=(await batchOf(batch.job.id)).creatives[0].id,c=(await call(`${master()}/creatives/${cid}`)).data as CreativeInstance;
    const before=store.read(id,`creative-${cid}.json`),templateBefore=store.read(id,'template.json'),r1=store.read(id,'master-r1.json'),calls=provider.calls.length,ocrBefore=recognizer.calls.length;
    // A double click: one run, made from the creative's own elements.
    const sent=await Promise.all([1,2].map(()=>call(`${master()}/creatives/${cid}/decomposition`,{})));
    expect(sent.map(r=>r.status)).toEqual([200,200]);expect(sent[1].data.runId).toBe(sent[0].data.runId);expect(sent.filter(r=>r.data.created)).toHaveLength(1);
    const run=(await call(`/api/layerize-experiment/runs/${sent[0].data.runId}`)).data as RunRecord;
    expect(run.stage).toBe('done');expect(run.origin).toMatchObject({kind:'master-creative',generationId:id,variantId:cid});expect(run.composed?.source).toBe('master-creative');
    expect(run.canvas).toEqual(c.canvas);expect(run.creative).toMatchObject({masterId:id,masterRevision:1,creativeId:cid,creativeRevision:c.revision,aiGenerated:true});
    const meta=run.creative!.layers,art=c.images.find(i=>i.artwork)!;
    expect(meta[0]).toMatchObject({kind:'background',elementIds:[art.id]});
    // The artwork split locally into its objects, right above the base, each from the artwork element.
    const split=run.creative!.artwork!,objects=meta.filter(l=>l.kind==='artwork');
    expect(split.method).toBe('local');expect(objects).toHaveLength(split.objects);expect(meta.slice(1,1+objects.length)).toEqual(objects);
    expect(objects.every(l=>l.elementIds[0]===art.id)).toBe(true);
    expect(meta.filter(l=>l.kind==='image').map(l=>l.elementIds[0]).sort()).toEqual(c.images.filter(i=>!i.artwork&&!i.hidden).map(i=>i.id).sort());
    expect(meta.filter(l=>l.kind==='shape').map(l=>l.elementIds[0]).sort()).toEqual(c.shapes.filter(x=>!x.hidden).map(x=>x.id).sort());
    // Every drawn text in exactly one text layer; the texts themselves kept whole for the editor (native text, not pictures).
    const textIds=meta.filter(l=>l.kind==='text').flatMap(l=>l.elementIds);
    expect(textIds.sort()).toEqual(c.texts.filter(t=>t.text.trim()&&!t.hidden).map(t=>t.id).sort());
    expect(run.creative!.texts).toEqual(c.texts.filter(t=>t.text.trim()));expect(run.creative!.shapes).toEqual(c.shapes);
    expect(run.editorLayerFiles).toEqual(meta.map(l=>l.file));
    // Back to front in the creative's own order, and the layers over each other are the creative as it is drawn.
    expect(meta.slice(1).map(l=>l.z)).toEqual([...meta.slice(1).map(l=>l.z)].sort((a,b)=>a-b));
    const dir=join(root,'runs',run.id),orig=await sharp(join(dir,'original.png')).removeAlpha().raw().toBuffer(),recon=await sharp(join(dir,'reconstructed.png')).removeAlpha().raw().toBuffer();
    expect(recon.equals(orig)).toBe(true);
    const drawn=await sharp(await renderMasterCreative(c,store)).removeAlpha().raw().toBuffer();
    // As the creative itself draws: no pixel visibly different (a plate's outline included).
    let diff=0,visible=0;for(let i=0;i<drawn.length;i++){const d=Math.abs(drawn[i]-orig[i]);diff+=d;if(d>24)visible++;}
    expect(diff/drawn.length).toBeLessThan(0.05);expect(visible).toBe(0);
    const d=(await call(`/api/layerize-experiment/runs/${run.id}/diagnostics`)).data;expect(d.calls).toBe(0);expect(d.total.inr).toBe(0);
    // Read only: the creative, the master and its saved version unchanged; no AI request, no scan.
    expect(store.read(id,`creative-${cid}.json`)).toEqual(before);expect(store.read(id,'template.json')).toEqual(templateBefore);expect(store.read(id,'master-r1.json')).toEqual(r1);
    expect(provider.calls.length).toBe(calls);expect(recognizer.calls.length).toBe(ocrBefore);
    // A later revision of the creative gets its own run; the first stays.
    c.texts[0].style.color='#224466';
    const edited=(await call(`${master()}/creatives/${cid}`,{expectedRevision:c.revision,creative:c},'PUT')).data as CreativeInstance;
    const second=(await call(`${master()}/creatives/${cid}/decomposition`,{})).data;
    expect(second.created).toBe(true);expect(second.runId).not.toBe(run.id);
    expect((await call(`/api/layerize-experiment/runs/${second.runId}`)).data.creative.creativeRevision).toBe(edited.revision);
    expect((await call(`/api/layerize-experiment/runs/${run.id}`)).status).toBe(200);

    // The clean-up version is recorded; a background made by an older clean-up is reported (read only).
    expect(snapshot.background.cleanupVersion).toBe(MASTER_CLEANUP_VERSION);
    expect(olderCleanup(snapshot.background)).toBe(false);expect(olderCleanup({...snapshot.background,cleanupVersion:undefined})).toBe(true);
    let v=(await call(master())).data as MasterView;expect(v.background.olderCleanup).toBe(false);
    const t=JSON.parse(templateBefore.toString());delete t.master.cleanup.version;store.write(id,'template.json',Buffer.from(JSON.stringify(t)));
    try{expect(((await call(master())).data as MasterView).background.olderCleanup).toBe(true);}finally{store.write(id,'template.json',templateBefore);}

    // A repaired clean background, approved and saved as revision 2: creatives keep revision 1 until asked.
    const repaired=await sharp(store.read(id,snapshot.background.file)).composite([{input:{create:{width:24,height:24,channels:3,background:'#f4f4f4'}},left:4,top:4}]).png().toBuffer();
    const form=new FormData();form.append('expectedRevision',String(v.template.revision));form.append('image',new Blob([new Uint8Array(repaired)],{type:'image/png'}),'clean.png');
    v=await (await fetch(base+`${master()}/background`,{method:'POST',body:form})).json();
    for(const action of ['background/approve','publish']){const res=await call(`${master()}/${action}`,{expectedRevision:v.template.revision,acknowledgeEstimate:true});expect(res.status,JSON.stringify(res.data)).toBe(200);v=res.data;}
    expect(v.latestRevision!.revision).toBe(2);expect(store.read(id,'master-r1.json')).toEqual(r1);
    // Every file a saved version names stays (its creatives read them): the replaced clean background of version 1 too.
    const named=(r:number)=>[...store.read(id,`master-r${r}.json`).toString().matchAll(/"(?:file|maskFile|previewFile|inputFile)":\s*"([^"]+)"/g)].map(m=>m[1]);
    const kept=(...revisions:number[])=>{for(const r of revisions)for(const f of named(r))expect(store.has(id,f),`r${r}: ${f}`).toBe(true);};
    expect(named(1)).toContain(snapshot.background.file);kept(1,2);
    expect((await fetch(`${base}/api/layerize-experiment/protected-templates/${id}/files/${snapshot.background.file}`)).status).toBe(200);
    const manual=(await call(`${master()}/creatives/${manualId}`)).data as CreativeInstance,ai=(await call(`${master()}/creatives/${cid}`)).data as CreativeInstance;
    expect(manual.masterRevision).toBe(1);expect(ai.masterRevision).toBe(1);
    expect((await call(`${master()}/creatives/${manualId}/rebase`,{expectedRevision:manual.revision-1})).status).toBe(409);
    const movedManual=(await call(`${master()}/creatives/${manualId}/rebase`,{expectedRevision:manual.revision})).data as CreativeInstance;
    expect(movedManual).toMatchObject({masterRevision:2,revision:manual.revision+1,texts:manual.texts,images:manual.images,shapes:manual.shapes});
    expect(movedManual.history.at(-1)!.detail).toContain('only the background changed');
    // The variation's artwork made again from the repaired background, with its own tint; its text, logos and shapes as they were.
    const movedAi=(await call(`${master()}/creatives/${cid}/rebase`,{expectedRevision:ai.revision})).data as CreativeInstance;
    const oldArt=ai.images.find(i=>i.artwork)!,newArt=movedAi.images.find(i=>i.artwork)!;
    expect(movedAi.masterRevision).toBe(2);expect(newArt.asset.file).not.toBe(oldArt.asset.file);expect(newArt.box).toEqual(oldArt.box);
    expect(store.has(id,oldArt.asset.file)).toBe(true);
    expect(movedAi.texts).toEqual(ai.texts);expect(movedAi.images.filter(i=>!i.artwork)).toEqual(ai.images.filter(i=>!i.artwork));expect(movedAi.shapes).toEqual(ai.shapes);expect(movedAi.backgroundColor).toBe(ai.backgroundColor);
    // A revision that changes the text is refused: the creative stays as it is.
    v=(await call(master())).data;
    const a=v.template.textAnalysis!,words=a.words.map((w,i)=>i?w:{...w,text:`${w.text}X`});
    v=(await call(`${master()}/review`,{expectedRevision:v.template.revision,expectedAnalysisRevision:a.revision,words,groups:a.groups,logoSlots:a.logoSlots,plates:a.plates},'PUT')).data;
    for(const action of ['prepare','background/approve','publish']){const res=await call(`${master()}/${action}`,{expectedRevision:v.template.revision,acknowledgeEstimate:true});expect(res.status,JSON.stringify(res.data)).toBe(200);v=res.data;}
    expect(v.latestRevision!.revision).toBe(3);kept(1,2,3);
    const unchanged=store.read(id,`creative-${cid}.json`),refused=await call(`${master()}/creatives/${cid}/rebase`,{expectedRevision:movedAi.revision});
    expect(refused.status).toBe(422);expect(refused.data.error.code).toBe('NOT_BACKGROUND_ONLY');expect(store.read(id,`creative-${cid}.json`)).toEqual(unchanged);
    expect(provider.calls.length).toBe(calls);expect(recognizer.calls.length).toBe(ocrBefore);
  });
});
