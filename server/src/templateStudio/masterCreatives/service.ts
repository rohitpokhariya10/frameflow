import sharp from 'sharp';
import { z } from 'zod';
import { MASTER_AI_OWN_FORMAT, masterAiCanvas, olderCleanup, studioFormat, validProtectedTemplateId, type MasterSnapshot, type MasterAiRequest, type MasterAiEstimate, type MasterAiBatch, type MasterAiProvider, type MasterAiReadiness, type CreativeInstance, type ProtectedTemplate } from '@frameflow/shared';
import type { ProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import type { ServerEnv } from '../config.js';
import type { StudioStore, JobRecord } from '../store.js';
import { enqueueJob, isTerminal } from '../jobs/queue.js';
import { preflightBudget } from '../costs/budget.js';
import { estimateTextCall } from '../costs/estimate.js';
import { toJobDto } from '../jobs/dto.js';
import { MASTER_RECIPE_VERSION, creativeIdOf, masterRequest, recipeId, type AssetEdge, type PlanContext } from './plan.js';
import { analyseArtwork, artworkFrame, cropEdge, edgeColour } from '../../decomposition/protectedTemplates/master/artwork.js';
import { blankSlotsOf, masterContent } from './content.js';
import { masterReadiness, type MissingText } from './readiness.js';
import type { WordRecognizer } from '../../textRecognition/recognizer.js';
import { createHash } from 'node:crypto';

export const masterAiInput = z.object({count:z.union([z.literal(3),z.literal(4),z.literal(5)]),formatId:z.string().refine(id=>id===MASTER_AI_OWN_FORMAT||!!studioFormat(id),'Choose a standard format.'),guidance:z.string().trim().max(1200).default('')});
export interface MasterAiJobInput {
  masterId:string; snapshot:MasterSnapshot; options:MasterAiRequest; canvas:{width:number;height:number}; sourceFile:string; sourceSha256:string;
  model:string; reasoningEffort:ServerEnv['OPENAI_TEXT_REASONING_EFFORT']; approvedMaxUsd:number; recipeVersion:number; provider:MasterAiProvider;
  /** The template check at request time (the worker reuses it; it never reads the poster again). */
  readiness:{missingText:MissingText[]; excluded:MasterAiReadiness['excluded']; olderCleanup?:boolean};
  request: {system:string; text:string; schemaName:string; maxOutputTokens:number; images:number};
}
export const MASTER_AI_KIND='generate_master_creatives';
export function savedMaster(store:ProtectedStore,id:string) {
  if(!validProtectedTemplateId(id)) throw new Error('Master not found.');
  const t=store.require(id), ref=t.master?.revisions.at(-1);
  if(!ref) throw new Error('Save a master revision before generating AI creatives.');
  const bytes=store.read(id,ref.file);
  if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256) throw new Error('The saved master revision changed on disk. Restore it before generating creatives.');
  const snapshot=JSON.parse(bytes.toString()) as MasterSnapshot;
  if(snapshot.masterId!==id || snapshot.revision!==ref.revision) throw new Error('Master snapshot does not match.');
  return {t,snapshot};
}
const requestImage=(bytes:Buffer)=>sharp(bytes).resize(1024,1024,{fit:'contain',background:'#ffffff'}).png().toBuffer();
/**
 * Local analysis a style is checked against (the same in the estimate and in the worker): the master's prepared content,
 * artwork grounds and logo edges, the template check's missing text, and where the master sits on the canvas (whole,
 * centred) with the colour around it.
 */
export async function planContext(store:ProtectedStore,snapshot:MasterSnapshot,options:MasterAiRequest,canvas:{width:number;height:number},missingText:MissingText[]):Promise<{ctx:PlanContext;artworkImage:Buffer|null}> {
  const id=snapshot.masterId,read=(f:string)=>store.read(id,f),background=read(snapshot.background.file),artwork=await analyseArtwork(background,snapshot);
  const content=masterContent(snapshot,await blankSlotsOf(snapshot,read)),edges:AssetEdge[]=[];
  for(const l of content.slots) edges.push({slotId:l.id,...await cropEdge(read(l.replacement?.file??l.original.file),artwork)});
  const f=artworkFrame(snapshot.canvas,canvas,'center','contain'),frame={x:f.x,y:f.y,k:f.width/snapshot.canvas.width};
  const ctx:PlanContext={snapshot,count:options.count,canvas,guidance:options.guidance,artwork,edges,content,missingText,frame,margin:await edgeColour(background)};
  return {ctx,artworkImage:await requestImage(background)};
}
/** The template check (local, cached per published revision) and what the designs will leave out. */
export async function readinessOf(store:ProtectedStore,t:ProtectedTemplate,snapshot:MasterSnapshot,recognizer:WordRecognizer) {
  const id=snapshot.masterId,{missingText}=await masterReadiness(t,snapshot,f=>store.read(id,f),recognizer);
  return {missingText,excluded:masterContent(snapshot,await blankSlotsOf(snapshot,f=>store.read(id,f))).excluded.map(({kind,label,reason})=>({kind,label,reason})),olderCleanup:olderCleanup(snapshot.background)};
}
export async function prepareMasterAi(store:ProtectedStore,env:ServerEnv,id:string,raw:unknown,configured:boolean,recognizer:WordRecognizer,provider:MasterAiProvider='openai'):Promise<{estimate:MasterAiEstimate; input:MasterAiJobInput}> {
  const options=masterAiInput.parse(raw),{t,snapshot}=savedMaster(store,id),canvas=masterAiCanvas(options.formatId,snapshot.canvas)!;
  const readiness=await readinessOf(store,t,snapshot,recognizer);
  const source=store.read(id,t.source.inputFile),{ctx,artworkImage}=await planContext(store,snapshot,options,canvas,readiness.missingText);
  const req=masterRequest(ctx,options,env.OPENAI_PLANNER_MODEL,env.OPENAI_TEXT_REASONING_EFFORT,{source:await requestImage(source),artwork:artworkImage});
  const text=req.content.find(c=>c.type==='text')! as {type:'text';text:string},images=req.content.filter(c=>c.type==='image').length;
  if(text.text.length>40000) throw new Error('This master has too much content for one AI request. Use a smaller master.');
  const schemaChars=JSON.stringify(z.toJSONSchema(req.schema)).length;
  const cost=estimateTextCall({model:req.model,promptChars:req.system.length+text.text.length+schemaChars,images:Array.from({length:images},()=>({width:1024,height:1024})),imageDetail:'low',maxOutputTokens:req.maxOutputTokens});
  const repair=estimateTextCall({model:req.model,promptChars:120000+req.system.length+schemaChars,images:[],imageDetail:'low',maxOutputTokens:8000});
  const maxUsd=(cost.microUsd+repair.microUsd)/1e6,artwork=!!ctx.artwork?.grounds.length;
  return {estimate:{masterRevision:snapshot.revision,model:req.model,maxUsd,maxInr:maxUsd*env.USD_INR_RATE,configured,withinCap:maxUsd<=env.MAX_JOB_BUDGET_USD,artwork,provider,readiness:{excluded:readiness.excluded,missingText:readiness.missingText.map(m=>({text:m.text,inBackground:m.inBackground})),olderCleanup:readiness.olderCleanup},
      note:'One AI style request, plus at most one correction if needed. Your layout, artwork, logos and text stay as they are; fonts, text colours and sizes, alignment and the background tint change. Everything stays editable. No new pictures are drawn.'},
    input:{masterId:id,snapshot,options,canvas,sourceFile:t.source.inputFile,sourceSha256:createHash('sha256').update(source).digest('hex'),model:req.model,reasoningEffort:req.reasoningEffort,approvedMaxUsd:maxUsd,recipeVersion:MASTER_RECIPE_VERSION,provider,readiness,
      request:{system:req.system,text:text.text,schemaName:req.schemaName,maxOutputTokens:req.maxOutputTokens,images}}};
}
type BatchResult={creativeIds?:string[];skipped?:MasterAiBatch['skipped'];provider?:MasterAiProvider};
export function masterBatch(db:StudioStore,env:ServerEnv,store:ProtectedStore,job:JobRecord):MasterAiBatch {
  const input=job.inputSnapshot as MasterAiJobInput,result=(job.result??{}) as BatchResult,recipeFile=recipeFileOf(job.id);
  let ideas:string[]=[];
  try{if(store.has(input.masterId,recipeFile)) ideas=(JSON.parse(store.read(input.masterId,recipeFile).toString()) as {plan?:{variations?:{direction?:string}[]}}).plan?.variations?.map(v=>String(v.direction??''))??[];}catch{ideas=[];}
  const creatives=(result.creativeIds??Array.from({length:input.options.count},(_,index)=>creativeIdOf(job.id,index))).map(cid=>{
    const file=`creative-${cid}.json`;
    if(!store.has(input.masterId,file)) return null;
    // One unreadable creative file never hides the rest of the batch.
    try{const c=JSON.parse(store.read(input.masterId,file).toString()) as CreativeInstance;return c.generation?{id:cid,name:c.name,previewFile:c.generation.previewFile,idea:(c.origin.kind==='ai'?ideas[c.origin.index]:undefined)||null}:null;}catch{return null;}
  }).filter((x):x is NonNullable<typeof x>=>!!x);
  return {job:toJobDto(db,env,job),masterId:input.masterId,masterRevision:input.snapshot.revision,count:input.options.count,formatId:input.options.formatId,canvas:input.canvas,provider:result.provider??input.provider??'openai',creatives,skipped:result.skipped??[]};
}
/** Enqueue synchronously after async preparation; check idempotency again here to serialize double clicks. */
export function enqueueMasterAi(db:StudioStore,env:ServerEnv,store:ProtectedStore,input:MasterAiJobInput,key:string) {
  const fullKey=`master-ai:${input.masterId}:${key}`;
  const old=db.jobs.find(j=>j.idempotencyKey===fullKey);
  if(old) {
    const previous=old.inputSnapshot as MasterAiJobInput;
    if(JSON.stringify(previous.options)!==JSON.stringify(input.options)||previous.snapshot.revision!==input.snapshot.revision) throw new Error('This request key was already used with different options. Start a new request.');
    return old;
  }
  if(db.jobs.find(j=>j.kind===MASTER_AI_KIND && (j.inputSnapshot as MasterAiJobInput).masterId===input.masterId && !isTerminal(j.state))) throw new Error('This master already has a generation in progress.');
  if(store.files(input.masterId,'creative-').length+input.options.count>500) throw new Error('This master would exceed 500 creatives.');
  preflightBudget(db,env,Math.ceil(input.approvedMaxUsd*1e6),MASTER_AI_KIND);
  return enqueueJob(db,{kind:MASTER_AI_KIND,idempotencyKey:fullKey,input}).job;
}
export const recipeFileOf=(jobId:string)=>`ai-${recipeId(jobId)}.json`;
