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
import { semanticDiscovery, semanticReview, saveTrio, deterministicProposalSeed } from './semanticPipeline.js';
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
    const records=f.context.job.data.refined as {maskRevisionId:string;alphaRevisionId:string;overlayRevisionId:string;maskArtifactId:string;alphaArtifactId:string;overlayArtifactId:string}[];
    const r=records[0];expect(r.maskRevisionId).toBe(r.alphaRevisionId);expect(r.maskRevisionId).toBe(r.overlayRevisionId);
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
    expect(deterministicProposalSeed('hash',{target:'object'})).toBe(deterministicProposalSeed('hash',{target:'object'}));
    expect(measureMask(f.full).area).toBeGreaterThan(measureMask(f.torso).area);
  }finally{await f.cleanup();}
});
