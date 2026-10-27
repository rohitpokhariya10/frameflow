import { describe,it,expect,vi } from 'vitest';
import sharp from 'sharp';
import { liveProductAnalyzer, parseProductScene, PRODUCT_ANALYSIS_SCHEMA, PRODUCT_ANALYSIS_MAX_OUTPUT_TOKENS, PRODUCT_ANALYSIS_TIMEOUT_MS } from '../../server/src/decomposition/protectedTemplates/product/analyzer.js';
import { loadGaneshHandmade } from '../fixtures/privateHandmade.js';
// (The sample answer is the client's private hand-made manifest: these tests run only where it is present.)
const handmade = await loadGaneshHandmade();
const size={width:607,height:606},answer=(handmade ? handmade.ganeshWordManifest(size) : undefined)!;
const png=()=>sharp({create:{...size,channels:3,background:'#ffffff'}}).png().toBuffer();
function fake(result:unknown){const create=vi.fn().mockResolvedValue(result);return {create,analyzer:liveProductAnalyzer({model:'gpt-5.6-sol',client:{responses:{create}} as never})};}
const usage={input_tokens:4000,output_tokens:8000,input_tokens_details:{cached_tokens:1000}};
describe.skipIf(!handmade)('Product analysis live-request readiness (mock transport; no network)',()=>{
 it('sends one bounded strict-schema image request and records usage at current rates',async()=>{
  const {create,analyzer}=fake({status:'completed',output:[],output_text:JSON.stringify(answer),usage}),saved=new Map<string,object>();
  const scene=await analyzer.analyze(await png(),'image/png',(f,v)=>saved.set(f,v));
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0][0]).toMatchObject({model:'gpt-5.6-sol',store:false,max_output_tokens:PRODUCT_ANALYSIS_MAX_OUTPUT_TOKENS,reasoning:{effort:'medium'},text:{format:{strict:true,schema:PRODUCT_ANALYSIS_SCHEMA}}});
  // 300 s since 2026-10-22: the approved live call took 106 s, and a full-size upload timed out at the former 120 s.
  expect(PRODUCT_ANALYSIS_TIMEOUT_MS).toBe(300000);
  expect(create.mock.calls[0][1]).toEqual({maxRetries:0,timeout:PRODUCT_ANALYSIS_TIMEOUT_MS});
  expect(create.mock.calls[0][0].input[0].content.filter((c:{type:string})=>c.type==='input_image')).toHaveLength(1);
  expect(scene).toHaveProperty('analysisUsage.costUsd',0.1724);
  expect(saved.has('product.usage.json')).toBe(true);
 });
 it.each([
  [{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},usage},'INCOMPLETE'],
  [{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'no'}]}],usage},'REFUSAL'],
  [{status:'completed',output:[],output_text:'',usage},'EMPTY_RESPONSE'],
  [{status:'completed',output:[],output_text:'{bad',usage},'INVALID_RESPONSE'],
 ])('rejects incomplete/refused/empty/invalid responses without retry',async(response,code)=>{
  const {create,analyzer}=fake(response);await expect(analyzer.analyze(await png(),'image/png',()=>{})).rejects.toMatchObject({code,usage:{costUsd:0.1724}});expect(create).toHaveBeenCalledTimes(1);
 });
 it.each([[401,'AUTHORIZATION'],[429,'RATE_LIMIT'],[400,'REQUEST_REJECTED'],[500,'PROVIDER_ERROR']])('handles HTTP %s without retry or leaking provider text',async(status,code)=>{
  const {create,analyzer}=fake(null);create.mockRejectedValue({status,message:'sensitive-provider-text'});
  const error=await analyzer.analyze(await png(),'image/png',()=>{}).catch(e=>e);
  expect(error).toMatchObject({code});expect(error.message).toContain(`HTTP ${status}`);expect(error.message).not.toContain('sensitive-provider-text');expect(create).toHaveBeenCalledTimes(1);
 });
 it('requires complete per-block words, bounded roles and unique word IDs',()=>{
  const missing=structuredClone(answer);missing.words.shift();expect(()=>parseProductScene(missing,size)).toThrow('does not cover');
  const duplicate=structuredClone(answer);duplicate.words[1].id=duplicate.words[0].id;expect(()=>parseProductScene(duplicate,size)).toThrow('duplicate');
  const role=structuredClone(answer);role.words[0].role='unrecognized';expect(()=>parseProductScene(role,size)).toThrow('invalid');
 });
 it('requires every schema object property and prohibits extra properties recursively',()=>{
  const walk=(s:Record<string,unknown>)=>{if(s.type==='object'){expect(s.additionalProperties).toBe(false);expect(s.required).toEqual(Object.keys(s.properties as object));for(const v of Object.values(s.properties as object))walk(v as Record<string,unknown>);}if(s.items)walk(s.items as Record<string,unknown>);};walk(PRODUCT_ANALYSIS_SCHEMA);
 });
});
