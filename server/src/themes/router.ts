import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { parseThemePrompt, parseThemeSpec, ThemeSpecError } from '@frameflow/shared';
import { createThemePlanner, type ThemePlanner } from './planner.js';
export function createThemeRouter(options: { planner?: ThemePlanner; apiKey?: string; model?: string } = {}) {
  const router=Router();let active=0;
  const planner=options.planner??createThemePlanner(options);
  router.post('/plan',rateLimit({windowMs:60_000,limit:3,standardHeaders:'draft-8',legacyHeaders:false,message:{error:{message:'Please wait a minute before planning another theme.'}}}),async(req,res)=>{
    let prompt:string;
    try {prompt=parseThemePrompt(req.body);}catch(error){res.status(400).json({error:{message:error instanceof Error?error.message:'Invalid prompt.'}});return;}
    if(!options.planner&&!options.apiKey?.trim()){res.status(503).json({error:{message:'AI theme planning is not configured. Curated templates are available.'}});return;}
    if(active>=2){res.status(429).json({error:{message:'Theme planner is busy. Please try again shortly.'}});return;}
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),65_000);
    const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);active++;
    try {const spec=parseThemeSpec(await planner(prompt,controller.signal));if(!res.destroyed)res.json({spec});}
    catch(error){if(!res.destroyed)res.status(502).json({error:{message:error instanceof ThemeSpecError?'The planner returned an invalid design. Your canvas is unchanged. Try adjusting your prompt.':'Theme planning failed. Your prompt and canvas are unchanged. Retry when ready.'}});}
    finally{active--;clearTimeout(timer);res.off('close',disconnect);}
  });return router;
}
