import { expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createTransform } from '../image/coordinates.js';
import { DecompositionRepository } from '../repository.js';
import { ArtifactStore } from '../artifactStore.js';
import { PipelineContext } from '../context.js';
import { readDecompositionConfig, normalizeDecompositionOptions } from '../config.js';
import { semanticDiscovery, semanticReview, saveTrio } from './semanticPipeline.js';
import { recoverSemanticOwnership, semanticTarget, scoreSemanticMask, proposalSeeds } from './semanticOwnership.js';
import { encodeMask, decodeMask, emptyMask, unionMasks, measureMask } from '../image/masks.js';
import type { Infer } from '../providers/inference.js';
import { ProviderError, endpointRegistry, buildProviderInput } from '../providers/adapters.js';
import type { DurableFalClient } from '../providers/falClient.js';
const rect = (x:number,y:number,w:number,h:number) => {const mask=emptyMask(256,320);for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++)mask.data[yy*256+xx]=255;return mask;};
async function fixture() {
  const master=await sharp({create:{width:256,height:320,channels:3,background:'#112233'}}).png().toBuffer();
  const person=rect(70,20,80,270), phone=rect(150,120,40,70), torso=rect(80,110,50,60), full=unionMasks(person,phone);
  return {master,person,phone,torso,full};
}
it('segments a source target without SAM2 and chooses complete group over high-score torso; all points share object id',async()=>{
  const f=await fixture();const target=semanticTarget('woman_holding_phone','target');
  const infer=vi.fn<Infer>(async(model,request)=>{expect(model).toBe('sam3');expect(await sharp(request.image).metadata()).toMatchObject({width:256,height:320});
    if(request.prompt===target.providerPrompt){expect(request.points).toEqual([{x:170,y:140,label:1,objectId:0},{x:20,y:20,label:0,objectId:0}]);return Object.assign([await encodeMask(f.torso),await encodeMask(f.full)],{scores:[0.99,0.8]});}
    return Object.assign([await encodeMask(request.prompt==='woman'?f.person:f.phone)],{scores:[0.9]});
  });
  const result=await recoverSemanticOwnership(f.master,infer,{target,points:[{x:170,y:140,label:1},{x:20,y:20,label:0}]});
  expect(result.mask?.data).toEqual(f.full.data);expect(result.scores[0].reasons).toContain('TARGET_NOT_RECOVERED');expect(infer).toHaveBeenCalledTimes(3);
  expect(scoreSemanticMask(f.person,{target,members:[f.person,f.phone]}).reasons).toContain('TARGET_NOT_RECOVERED');
  expect(endpointRegistry.sam3.endpoint).toBe('fal-ai/sam-3-1/image');
  expect(buildProviderInput('sam3',{imageUrl:'https://fal.media/test.png',width:256,height:320,prompt:target.providerPrompt,points:[{x:170,y:140,label:1,objectId:0}]})).toMatchObject({point_prompts:[{x:170,y:140,label:1,object_id:0}],include_scores:true,include_boxes:true});
});
it('does not accept missing member evidence, out-of-bounds guidance, or hallucinated group labels',async()=>{
  const f=await fixture();const target=semanticTarget('table with laptop','generic');
  const infer=vi.fn<Infer>(async(_model,r)=>r.prompt==='laptop'?[]:[await encodeMask(f.person)]);
  const result=await recoverSemanticOwnership(f.master,infer,{target});expect(result.mask).toBeUndefined();expect(result.warnings).toContain('GROUP_MEMBERS_UNVERIFIED');
  infer.mockClear();await expect(recoverSemanticOwnership(f.master,infer,{target,points:[{x:256,y:0,label:1}]})).rejects.toMatchObject({code:'GUIDANCE_BOUNDS'});expect(infer).not.toHaveBeenCalled();
  expect(target.label).toBe('table with laptop');expect(target.memberHints).toEqual(['table','laptop']);
});
async function contextFixture() {
  const f=await fixture(),dir=await mkdtemp(resolve(tmpdir(),'frameflow-semantic-')),repo=new DecompositionRepository(dir),store=new ArtifactStore(dir,repo),config=readDecompositionConfig({DECOMP_DATA_DIR:dir,DECOMP_PROVIDER_MODE:'live'});
  const source=await store.write({ownerId:'operator',kind:'source',mimeType:'image/png',width:256,height:320},f.master);
  repo.addSource({id:'source',ownerId:'operator',originalArtifactId:source.artifactId,masterArtifactId:source.artifactId,originalSha256:source.sha256,workingMasterSha256:source.sha256,width:256,height:320,mimeType:'image/png',hasAlpha:false,orientationNormalized:false,metadata:{},createdAt:Date.now()});
  repo.createJob('operator','source',normalizeDecompositionOptions({},config),'semantic-test');const job=repo.claimJob('worker')!;job.phase=3;job.data={verificationMode:'live',analysisTransform:createTransform(256,320,1024)};
  const context=new PipelineContext(job,repo,store,config,undefined,'worker');
  return {...f,context,repo,store,cleanup:async()=>{repo.close();await rm(dir,{recursive:true,force:true});}};
}
it('registered proposals seed source segmentation; unregistered geometry cannot create semantic ownership',async()=>{
  const f=await contextFixture();try{
    const proposal={id:'proposal-1',label:'Object 1',rgba:f.master,alpha:f.full,width:256,height:320,registered:false,warnings:[]};
    const infer=vi.fn<Infer>(async()=>[await encodeMask(f.full)]);f.context.infer=infer;
    expect(await semanticDiscovery(f.context,f.master,[proposal])).toBe(false);expect(infer).not.toHaveBeenCalled();
    expect(await semanticDiscovery(f.context,f.master,[{...proposal,registered:true}])).toBe(true);
    expect(infer.mock.calls[0][1].prompt).toBe('the indicated object');expect(proposalSeeds(f.full).some(p=>p.label===1)).toBe(true);
    expect(f.context.job.phase).toBe(4);
  }finally{await f.cleanup();}
});
it('manual correction makes no provider call and mask/alpha/overlay share one exact native revision',async()=>{
  const f=await contextFixture();try{
    const original=await saveTrio(f.context,f.master,f.torso,f.torso,'test/original');
    f.context.job.data.candidates=[{id:'target',label:'object',...original,target:semanticTarget('object','target'),qualityStatus:'needs-correction'}];
    const infer=vi.fn<Infer>();f.context.infer=infer;
    await semanticReview(f.context,f.master,{action:'manual-masks',expectedRevision:f.context.job.revision,objects:[{id:'target',selected:true,strokes:[{mode:'add',radius:10,points:[{x:170,y:140}]},{mode:'subtract',radius:5,points:[{x:90,y:120}]}]}]});
    expect(infer).not.toHaveBeenCalled();
    // A manual save returns to ownership review (it never jumps to alpha); the candidate carries the new exact revision.
    expect(f.context.job.data.refined).toBeUndefined();expect(f.context.job.review?.gate).toBe('semantic-mask-review');
    const r=(f.context.job.data.candidates as {revisionId:string;maskRevisionId:string;alphaRevisionId:string;overlayRevisionId:string;maskArtifactId:string;alphaArtifactId:string;overlayArtifactId:string;qualityTier:string}[])[0];
    expect(r.revisionId).not.toBe(original.revisionId);expect(r.maskRevisionId).toBe(r.revisionId);expect(r.maskRevisionId).toBe(r.alphaRevisionId);expect(r.maskRevisionId).toBe(r.overlayRevisionId);
    expect(r.qualityTier).not.toBe('PASS');
    const mask=await decodeMask(await f.context.artifact(r.maskArtifactId),{encoding:'luminance'}),alpha=await decodeMask(await f.context.artifact(r.alphaArtifactId),{encoding:'luminance'});
    expect(mask.data).toEqual(alpha.data);expect(mask.data[140*256+170]).toBe(255);expect(mask.data[120*256+90]).toBe(0);
    const overlay=await sharp(await f.context.artifact(r.overlayArtifactId)).ensureAlpha().raw().toBuffer();
    for(let i=0;i<mask.data.length;i++) expect(overlay[i*4]!==17).toBe(mask.data[i]>0);
  }finally{await f.cleanup();}
});
it.each(['network', 'partial'])('%s failure preserves previous mask and cannot advance Phase 5',async(failure)=>{
  const f=await contextFixture();try{
    const original=await saveTrio(f.context,f.master,f.torso,f.torso,'test/prior');
    f.context.job.phase=4;f.context.job.data.candidates=[{id:'target',label:'object',...original,target:semanticTarget('object','target')}];
    f.context.infer=async()=>{if(failure==='network')throw new ProviderError('PROVIDER_NETWORK','Network timeout');return [await encodeMask(f.torso)];};
    await semanticReview(f.context,f.master,{action:'guided-refine',expectedRevision:f.context.job.revision,objects:[{id:'target',points:[{x:170,y:140,label:1}],selected:true}]});
    expect(f.context.job.phase).toBe(4);expect(f.context.job.state).toBe('needs_review');expect(f.context.job.data.refined).toBeUndefined();
    expect((f.context.job.data.candidates as {maskArtifactId:string}[])[0].maskArtifactId).toBe(original.maskArtifactId);
  }finally{await f.cleanup();}
});
it('identical provider input reuses durable outputs across step keys, preserving scores and boxes',async()=>{
  const f=await contextFixture();try{
    const output=await encodeMask(f.full);const advance=vi.fn(async()=>({state:'completed',request:{providerRequestId:'known-id'},output:{images:[{url:'https://fal.media/output.png'}],scores:[0.9],boxes:[[0.5,0.5,0.4,0.7]]}}));
    const provider={advance,transport:{upload:vi.fn(async()=> 'https://fal.media/input.png'),download:vi.fn(async()=>output)}} as unknown as DurableFalClient;
    const context=new PipelineContext(f.context.job,f.repo,f.store,f.context.config,provider,'worker');
    const first=await context.infer('sam3',{image:f.master,prompt:'object',key:'first'});const second=await context.infer('sam3',{image:f.master,prompt:'object',key:'retry'});
    expect(advance).toHaveBeenCalledTimes(1);expect(second[0]).toEqual(first[0]);expect(second.scores).toEqual([0.9]);expect(second.boxes).toEqual([[0.5,0.5,0.4,0.7]]);
    expect(measureMask(f.full).area).toBeGreaterThan(measureMask(f.torso).area);
  }finally{await f.cleanup();}
});
it.each([['no hints',[]],['only a remove hint',[{x:20,y:20,label:0 as const}]]])('guided refine on an empty selection with %s asks for guidance and makes no provider call',async(_,points)=>{
  const f=await contextFixture();try{
    // Mirrors a Phase 4 rejection: the candidate carries an empty mask, so the client has no bbox to fall back on.
    const empty=await saveTrio(f.context,f.master,emptyMask(256,320),emptyMask(256,320),'test/empty');
    f.context.job.phase=4;f.context.job.data.candidates=[{id:'target',label:'Jhula',...empty,target:semanticTarget('Jhula','target'),qualityStatus:'needs-correction',qualityTier:'FAIL'}];
    const infer=vi.fn<Infer>(async()=>[await encodeMask(f.full)]);f.context.infer=infer;
    await semanticReview(f.context,f.master,{action:'guided-refine',expectedRevision:f.context.job.revision,objects:[{id:'target',candidateId:'target',label:'Jhula',selected:true,points}]});
    expect(infer).not.toHaveBeenCalled();
    expect(f.context.job.review).toMatchObject({code:'GUIDANCE_REQUIRED',gate:'semantic-mask-review'});expect(f.context.job.review?.actions).toContain('guided-refine');
    expect((f.context.job.data.candidates as {maskArtifactId:string}[])[0].maskArtifactId).toBe(empty.maskArtifactId);
  }finally{await f.cleanup();}
});
type Provisional={id:string;revisionId:string;maskArtifactId:string;provisional?:boolean;manualOwnership?:boolean;qualityTier:string;qualityStatus:string;qualityChecks:{code:string}[];rejectedCandidate?:{revisionId:string;maskArtifactId:string;rejectionReasons:string[];qualityChecks:unknown[];providerRequestIds:string[]}};
/** Replays the Jhula case: SAM returns a confident whole-object mask, but an automatic seed point falls outside it. */
async function provisionalDiscovery(f:Awaited<ReturnType<typeof contextFixture>>,mask:Parameters<typeof encodeMask>[0],providerScore:number,points=[{x:20,y:20,label:1 as const}]){
  f.context.job.data.proposalReviewApproved=true;
  f.context.job.data.proposalTargets=[{id:'jhula',label:'Jhula',proposalIds:[],approved:true,rejected:false,groupMode:'single',role:'object',points}];
  const infer=vi.fn<Infer>(async model=>{expect(model).toBe('sam3');return Object.assign([await encodeMask(mask)],{scores:[providerScore],requestId:'replayed-sam-request'});});f.context.infer=infer;
  expect(await semanticDiscovery(f.context,f.master,[])).toBe(true);
  return {infer,candidate:(f.context.job.data.candidates as Provisional[])[0]};
}
/** Submits a review through the repository and claims it like the worker does, so revision and gate checks are real. */
async function reviewAs(f:Awaited<ReturnType<typeof contextFixture>>,body:Omit<Parameters<typeof semanticReview>[2],'expectedRevision'>,infer:Infer){
  const current=f.repo.getJob(f.context.job.id)!;f.repo.reviewJob(current.id,'operator',{...body,expectedRevision:current.revision} as Parameters<typeof semanticReview>[2]);
  const job=f.repo.claimJob('worker')!;const context=new PipelineContext(job,f.repo,f.store,f.context.config,undefined,'worker');context.infer=infer;
  await semanticReview(context,f.master,job.data.reviewSubmission as Parameters<typeof semanticReview>[2]);
  return f.repo.getJob(job.id)!;
}
it('keeps a confident SAM mask that fails seed coverage as a provisional REVIEW candidate instead of an empty selection',async()=>{
  const f=await contextFixture();try{
    const {infer,candidate}=await provisionalDiscovery(f,f.full,0.98);
    expect(infer).toHaveBeenCalledTimes(1);
    const mask=await decodeMask(await f.context.artifact(candidate.maskArtifactId),{encoding:'luminance',binary:true});
    expect(mask.data).toEqual(f.full.data);
    expect(candidate.provisional).toBe(true);expect(candidate.qualityTier).toBe('REVIEW');expect(candidate.qualityStatus).toBe('needs-correction');
    expect(candidate.qualityChecks[0].code).toBe('PROVISIONAL_SELECTION');
    // Rejection reasons, the gate verdict, the original revision and the provider request are preserved.
    expect(candidate.rejectedCandidate).toMatchObject({revisionId:candidate.revisionId,maskArtifactId:candidate.maskArtifactId,providerRequestIds:['replayed-sam-request']});
    expect(candidate.rejectedCandidate!.rejectionReasons).toContain('POSITIVE_GUIDANCE_UNSATISFIED');expect(candidate.rejectedCandidate!.qualityChecks.length).toBeGreaterThan(0);
    expect(f.context.job.review?.gate).toBe('semantic-mask-review');expect(f.context.job.phase).toBe(4);expect(f.context.job.data.refined).toBeUndefined();
  }finally{await f.cleanup();}
});
it.each([['a low-confidence mask',()=>0.3,false],['a full-canvas mask',()=>0.99,true]])('does not keep %s as a provisional candidate',async(_,score,fullCanvas)=>{
  const f=await contextFixture();try{
    const {candidate}=await provisionalDiscovery(f,fullCanvas?rect(0,0,256,320):f.full,score());
    expect(candidate.provisional).toBeUndefined();expect(candidate.rejectedCandidate).toBeUndefined();expect(candidate.qualityTier).toBe('FAIL');
  }finally{await f.cleanup();}
});
it('blocks BiRefNet for a provisional candidate until the user keeps it as a new revision',async()=>{
  const f=await contextFixture();try{
    const {candidate}=await provisionalDiscovery(f,f.full,0.98);
    const infer=vi.fn<Infer>(async(model,request)=>{expect(model).toBe('birefnet');const t=request.transform!;return [await sharp({create:{width:t.modelWidth,height:t.modelHeight,channels:3,background:'#ffffff'}}).png().toBuffer()];});
    const object={id:'jhula',candidateId:'jhula',label:'Jhula',selected:true};
    // No silent approval: "Looks good" on the unconfirmed candidate neither calls BiRefNet nor changes the mask.
    let job=await reviewAs(f,{action:'accept-masks',objects:[{...object,strokes:[]}]},infer);
    expect(infer).not.toHaveBeenCalled();expect(job.review?.code).toBe('PROVISIONAL_SELECTION_UNCONFIRMED');expect(job.data.refined).toBeUndefined();
    let current=(job.data.candidates as Provisional[])[0];expect(current.provisional).toBe(true);expect(current.maskArtifactId).toBe(candidate.maskArtifactId);
    // Keeping it (a manual save without strokes) creates a new user-owned revision and keeps the rejected candidate's provenance.
    job=await reviewAs(f,{action:'manual-masks',objects:[{...object,strokes:[]}]},infer);
    expect(infer).not.toHaveBeenCalled();expect(job.review?.gate).toBe('semantic-mask-review');expect(job.data.refined).toBeUndefined();
    current=(job.data.candidates as Provisional[])[0];
    expect(current.provisional).toBeUndefined();expect(current.manualOwnership).toBe(true);expect(current.revisionId).not.toBe(candidate.revisionId);
    expect(current.qualityTier).not.toBe('PASS');expect(current.rejectedCandidate).toEqual(candidate.rejectedCandidate);
    // Only now does the explicit confirmation reach edge refinement: exactly one BiRefNet call.
    job=await reviewAs(f,{action:'accept-masks',objects:[{...object,strokes:[]}]},infer);
    expect(infer).toHaveBeenCalledTimes(1);expect(job.review?.gate).toBe('alpha-review');expect(job.data.refined).toHaveLength(1);
  }finally{await f.cleanup();}
});
it('a manual correction on a provisional candidate saves a new revision with the painted change',async()=>{
  const f=await contextFixture();try{
    const {candidate}=await provisionalDiscovery(f,f.full,0.98);const infer=vi.fn<Infer>();
    const job=await reviewAs(f,{action:'manual-masks',objects:[{id:'jhula',candidateId:'jhula',label:'Jhula',selected:true,strokes:[{mode:'subtract',radius:6,points:[{x:170,y:150}]}]}]},infer);
    expect(infer).not.toHaveBeenCalled();
    const current=(job.data.candidates as Provisional[])[0];expect(current.revisionId).not.toBe(candidate.revisionId);expect(current.provisional).toBeUndefined();
    const store=new PipelineContext(job,f.repo,f.store,f.context.config,undefined,'reader');
    expect((await decodeMask(await store.artifact(current.maskArtifactId),{encoding:'luminance',binary:true})).data[150*256+170]).toBe(0);
    expect((await decodeMask(await store.artifact(candidate.maskArtifactId),{encoding:'luminance',binary:true})).data[150*256+170]).toBe(255);
  }finally{await f.cleanup();}
});
it('refuses to confirm unsaved strokes: no BiRefNet call, mask unchanged, and only a saved revision that passes ownership checks proceeds',async()=>{
  const f=await contextFixture();try{
    // No seed point outside the mask: an ordinary accepted (non-provisional) candidate.
    const {candidate}=await provisionalDiscovery(f,f.full,0.98,[]);expect(candidate.provisional).toBeUndefined();expect(candidate.qualityTier).not.toBe('FAIL');
    const infer=vi.fn<Infer>(async(model,request)=>{expect(model).toBe('birefnet');const t=request.transform!;return [await sharp({create:{width:t.modelWidth,height:t.modelHeight,channels:3,background:'#ffffff'}}).png().toBuffer()];});
    const object={id:'jhula',candidateId:'jhula',label:'Jhula',selected:true};
    const strokes=[{mode:'subtract' as const,radius:6,points:[{x:170,y:150}]}];
    let job=await reviewAs(f,{action:'accept-masks',objects:[{...object,strokes}]},infer);
    expect(infer).not.toHaveBeenCalled();expect(job.review).toMatchObject({code:'UNSAVED_EDITS',gate:'semantic-mask-review'});expect(job.data.refined).toBeUndefined();
    expect((job.data.candidates as Provisional[])[0].revisionId).toBe(candidate.revisionId);
    // Saving the same strokes creates a revision; a passing revision can then be confirmed.
    job=await reviewAs(f,{action:'manual-masks',objects:[{...object,strokes}]},infer);
    const saved=(job.data.candidates as Provisional[])[0];expect(saved.revisionId).not.toBe(candidate.revisionId);expect(saved.qualityTier).not.toBe('FAIL');expect(infer).not.toHaveBeenCalled();
    job=await reviewAs(f,{action:'accept-masks',objects:[object]},infer);
    expect(infer).toHaveBeenCalledTimes(1);expect(job.review?.gate).toBe('alpha-review');
  }finally{await f.cleanup();}
});
it('a correction that fails ownership checks is not saved, does not relabel the saved selection, and never reaches BiRefNet',async()=>{
  const f=await contextFixture();try{
    const {candidate}=await provisionalDiscovery(f,f.full,0.98,[]);const infer=vi.fn<Infer>();
    const object={id:'jhula',candidateId:'jhula',label:'Jhula',selected:true};
    // Erasing the whole object would leave an empty mask: the gate refuses the save and keeps the previous revision.
    const job=await reviewAs(f,{action:'manual-masks',objects:[{...object,strokes:[{mode:'subtract',radius:256,points:[{x:128,y:160}]}]}]},infer);
    expect(infer).not.toHaveBeenCalled();expect(job.review?.code).toBe('TARGET_NOT_RECOVERED');expect(job.data.refined).toBeUndefined();
    const kept=(job.data.candidates as Provisional[])[0];
    expect(kept.revisionId).toBe(candidate.revisionId);expect(kept.maskArtifactId).toBe(candidate.maskArtifactId);
    expect(kept.qualityTier).toBe(candidate.qualityTier);expect(kept.qualityChecks).toEqual(candidate.qualityChecks);
  }finally{await f.cleanup();}
});
