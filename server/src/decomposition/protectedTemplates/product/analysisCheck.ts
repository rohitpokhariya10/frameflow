/** Opt-in, single-request manual analysis check. Default is a network-free preparation. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { sceneModel } from '../../aiModels.js';
import { decodeRgba, sha256 } from '../pixels.js';
import { findSheetCreatives } from './sheet.js';
import { liveProductAnalyzer, productAnalysisRequest, PRODUCT_ANALYSIS_PRICE, PRODUCT_ANALYSIS_MAX_OUTPUT_TOKENS, PRODUCT_ANALYSIS_TIMEOUT_MS } from './analyzer.js';
const out=resolve('test-results/product-v3/live-analysis'), planFile=join(out,'plan.json');
mkdirSync(out,{recursive:true});
const source=readFileSync('Ganesh-Chaturthi.png'), crop=findSheetCreatives(await decodeRgba(source)).boxes[0];
if(!crop)throw new Error('No creative crop found; review the image manually.');
const image=await sharp(source).extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).png().toBuffer();
const size={width:crop.width,height:crop.height}, model=sceneModel(), request=productAnalysisRequest(image,'image/png',size,model), requestSha256=sha256(Buffer.from(JSON.stringify(request)));
const execute=process.argv.includes('--execute-approved');
if(!execute){
 if(existsSync(planFile)){ console.log(`Existing plan preserved: ${planFile}`);process.exit(0); }
 const inputAllowance=10000;
 const plan={status:'prepared-not-executed',createdAt:new Date().toISOString(),model,source:'Ganesh-Chaturthi.png',sourceSha256:sha256(source),crop,imageSha256:sha256(image),requestSha256,
   calls:1,endpoint:'POST /v1/responses',purpose:'Audit real model words, logos, Ganesha and each appliance against this actual crop',maxOutputTokens:PRODUCT_ANALYSIS_MAX_OUTPUT_TOKENS,maxRetries:0,timeoutMs:PRODUCT_ANALYSIS_TIMEOUT_MS,
   pricing:model===PRODUCT_ANALYSIS_PRICE.model?PRODUCT_ANALYSIS_PRICE:null,
   estimate:model===PRODUCT_ANALYSIS_PRICE.model?{inputTokenAllowance:inputAllowance,expectedUsd:[0.14,0.36],withFullOutputAndInputAllowanceUsd:(inputAllowance*4+PRODUCT_ANALYSIS_MAX_OUTPUT_TOKENS*20)/1e6,note:'Planning estimate, not a hard dollar cap; output cap includes reasoning. Actual input and usage may differ. Recheck rates and consent after 24 hours.'}:null,
   keyConfigured:!!process.env.OPENAI_API_KEY,accountModelAccess:'unverified',approvalRequired:true};
 writeFileSync(join(out,'input.png'),image,{flag:'wx'});
 writeFileSync(join(out,'request.json'),JSON.stringify({...request,input:{image:'input.png',...size,mime:'image/png',detail:'high'}},null,2),{flag:'wx'});
 writeFileSync(planFile,JSON.stringify(plan,null,2),{flag:'wx'});
 console.log(JSON.stringify(plan,null,2));
}else{
 const plan=JSON.parse(readFileSync(planFile,'utf8'));
 const consent=process.argv.find(a=>a.startsWith('--approval='))?.slice('--approval='.length);
 if(consent!==requestSha256||plan.requestSha256!==requestSha256||plan.model!==model)throw new Error('Explicit approval hash must match the prepared image, model and request. No request sent.');
 if(Date.now()-Date.parse(plan.createdAt)>86400000)throw new Error('Plan expired. Recheck pricing and prepare a new approval before any request.');
 if(!process.env.OPENAI_API_KEY)throw new Error('No API key configured. No request sent.');
 // An exclusive marker prevents re-execution even after timeout/crash (billing may have occurred).
 writeFileSync(join(out,'attempt.json'),JSON.stringify({at:new Date().toISOString(),requestSha256,approved:true}),{flag:'wx'});
 const save=(f:string,v:object)=>writeFileSync(join(out,f),JSON.stringify(v,null,2),{flag:'wx'});
 try{
  const scene=await liveProductAnalyzer({model}).analyze(image,'image/png',save);
  save('validated-scene.json',scene);save('result.json',{status:'received-needs-human-audit',fixture:false,model,requestSha256});
 }catch(error){save('result.json',{status:'failed-no-retry',error:(error as Error).message,requestSha256});throw error;}
}
