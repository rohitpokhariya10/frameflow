import { describe, expect, it, vi } from 'vitest';
import { DIWALI_TEMPLATES } from '@frameflow/shared';
import { createThemePlanner } from './planner.js';
const spec=DIWALI_TEMPLATES[0].spec;
const fixture=(response:unknown)=>{const create=vi.fn().mockResolvedValue(response);return {create,planner:createThemePlanner({client:{responses:{create}} as never})};};
describe('theme planner, fake Responses client only',()=>{
  it.each(['sale','premium','product','Hindi','x'])('one %s request produces structured data and never image generation',async prompt=>{
    const {create,planner}=fixture({status:'completed',output:[],output_text:JSON.stringify(spec)});
    expect(await planner(prompt,new AbortController().signal)).toEqual(spec);expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toMatchObject({model:'gpt-5-mini',store:false,input:prompt,text:{format:{type:'json_schema',strict:true}}});expect(create.mock.calls[0][1].maxRetries).toBe(0);
  });
  it.each([{status:'incomplete',output_text:'{}'},{status:'completed',output_text:'broken'},{status:'completed',output_text:'{}'},{status:'completed',output:[{type:'message',content:[{type:'refusal'}]}],output_text:JSON.stringify(spec)}])('refuses invalid responses without retries',async response=>{
    const {create,planner}=fixture(response);await expect(planner('test',new AbortController().signal)).rejects.toThrow();expect(create).toHaveBeenCalledTimes(1);
  });
  it('does not retry or expose provider errors',async()=>{
    const create=vi.fn().mockRejectedValue(new Error('fake failure'));
    const planner=createThemePlanner({client:{responses:{create}} as never});await expect(planner('test',new AbortController().signal)).rejects.toThrow();expect(create).toHaveBeenCalledTimes(1);
  });
  it('missing key makes zero requests',async()=>{await expect(createThemePlanner({apiKey:''})('test',new AbortController().signal)).rejects.toThrow('not configured');});
});
