import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { DIWALI_TEMPLATES } from '@frameflow/shared';
import { createApp } from '../app.js';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());})));vi.unstubAllEnvs();});
async function start(planner=vi.fn().mockResolvedValue(DIWALI_TEMPLATES[0].spec)){
  vi.stubEnv('OPENAI_API_KEY','');
  const server=createServer(createApp({provider:'gemini',model:'fake',timeoutMs:1000,trustProxyHops:0},undefined,()=>{},undefined,undefined,undefined,planner));
  servers.push(server);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/themes/plan`;
  const request=(body:unknown,origin?:string)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  return {request,planner};
}
it('one valid HTTP Generate request calls the planner once',async()=>{const {request,planner}=await start();const response=await request({prompt:'sale'});expect(response.status).toBe(200);expect(await response.json()).toEqual({spec:DIWALI_TEMPLATES[0].spec});expect(planner).toHaveBeenCalledTimes(1);});
it('rejects invalid requests and hostile origins before the provider',async()=>{const {request,planner}=await start();expect((await request({prompt:''})).status).toBe(400);expect((await request({prompt:'x'.repeat(2001)})).status).toBe(400);expect((await request({prompt:'sale'},'https://untrusted.invalid')).status).toBe(403);expect(planner).not.toHaveBeenCalled();});
it('normalizes provider errors without leaking secrets or retrying',async()=>{const {request,planner}=await start(vi.fn().mockRejectedValue(new Error('SECRET upstream response')));const response=await request({prompt:'sale'});expect(response.status).toBe(502);expect(JSON.stringify(await response.json())).not.toContain('SECRET');expect(planner).toHaveBeenCalledTimes(1);});
it('validates fake provider results at the HTTP boundary',async()=>{const {request,planner}=await start(vi.fn().mockResolvedValue({invalid:true}));expect((await request({prompt:'sale'})).status).toBe(502);expect(planner).toHaveBeenCalledTimes(1);});
