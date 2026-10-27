import type { Router, ErrorRequestHandler } from 'express';
import { z } from 'zod';
import type { StudioStore } from '../store.js';
import type { ServerEnv } from '../config.js';
import type { ProtectedStore } from '../../decomposition/protectedTemplates/store.js';
import type { WordRecognizer } from '../../textRecognition/recognizer.js';
import { prepareMasterAi, enqueueMasterAi, masterBatch, MASTER_AI_KIND, type MasterAiJobInput } from './service.js';

export function registerMasterCreativeRoutes(router:Router,ctx:{db:StudioStore;env:ServerEnv;store:ProtectedStore;configured:boolean;offline:boolean;wake:()=>void;
  /** Reads the original poster for the template check (local; the same reading as Scan Again). */
  recognizer:()=>WordRecognizer}) {
  const {db,env,store}=ctx,base='/master-creatives/:masterId',provider=ctx.offline?'offline-mock' as const:'openai' as const;
  router.get(base,(req,res,next)=>{try{
    const masterId=String(req.params.masterId);store.require(masterId);
    res.setHeader('Cache-Control','no-store');
    res.json({batches:db.jobs.filter(j=>j.kind===MASTER_AI_KIND&&(j.inputSnapshot as MasterAiJobInput).masterId===masterId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>masterBatch(db,env,store,j))});
  }catch(e){next(e);}});
  router.post(`${base}/estimate`,async(req,res,next)=>{try{
    res.json((await prepareMasterAi(store,env,String(req.params.masterId),req.body,ctx.configured,ctx.recognizer(),provider)).estimate);
  }catch(e){next(e);}});
  router.post(base,async(req,res,next)=>{try{
    const auth=z.object({idempotencyKey:z.string().min(8).max(100).regex(/^[a-zA-Z0-9-]+$/),confirmCost:z.literal(true),approvedMaxUsd:z.number().finite().nonnegative(),masterRevision:z.number().int().positive(),acknowledgeMissingText:z.boolean().optional()}).parse(req.body);
    if(!ctx.configured) return void res.status(503).json({error:{code:'not_configured',message:'Configure the AI provider before generating.'}});
    const prepared=await prepareMasterAi(store,env,String(req.params.masterId),req.body,ctx.configured,ctx.recognizer(),provider);
    if(auth.masterRevision!==prepared.estimate.masterRevision) return void res.status(409).json({error:{code:'stale_master',message:'The master changed. Review the estimate again.'}});
    if(auth.approvedMaxUsd+1e-9<prepared.estimate.maxUsd) return void res.status(409).json({error:{code:'cost_changed',message:'The estimate changed. Review the cost again.'}});
    // Text the template lacks would be missing from every design: generating anyway is the user's explicit choice.
    if(prepared.estimate.readiness.missingText.length&&auth.acknowledgeMissingText!==true) return void res.status(409).json({error:{code:'missing_text',message:'Your template is missing some text from the original poster. Fix the template first, or choose to generate anyway.'}});
    const job=enqueueMasterAi(db,env,store,prepared.input,auth.idempotencyKey);ctx.wake();
    res.status(202).json(masterBatch(db,env,store,job));
  }catch(e){next(e);}});
  router.use('/master-creatives', ((error, _req, res, _next) => {
    void _next;
    const message=error instanceof z.ZodError ? error.issues.map(i=>i.message).join(' ') : error instanceof Error ? error.message : 'Could not process this generation request.';
    res.status(error instanceof z.ZodError ? 400 : 422).json({error:{code:'master_creative_request',message}});
  }) as ErrorRequestHandler);
}
