import { describe, expect, it, vi } from 'vitest';
import { createFontLoader, googleFontStylesheet } from './fontLoader';
describe('bounded on-demand font loader',()=>{
  it('deduplicates concurrent requests and caches successful loads by actual weight',async()=>{
    const fetch=vi.fn(async()=>{}),loader=createFontLoader(fetch);
    await Promise.all([loader.load('Poppins',400),loader.load('Poppins',400),loader.load('Poppins',700),loader.load('Yatra One',700),loader.load('Yatra One',400)]);
    expect(fetch.mock.calls).toHaveLength(3);
    await loader.load('Poppins');expect(fetch.mock.calls).toHaveLength(3);expect(loader.state('Poppins')).toBe('ready');
  });
  it('bounds concurrency, continues after a failure and returns fallbacks instead of throwing',async()=>{
    let active=0,peak=0;
    const loader=createFontLoader(async family=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;if(family==='Hind')throw Error('offline');},2);
    expect(await Promise.all(['Poppins','Hind','Cinzel','Baloo 2','Mukta'].map(f=>loader.load(f)))).toEqual([true,false,true,true,true]);
    expect(peak).toBe(2);expect(loader.state('Hind')).toBe('failed');
    expect(await loader.load('Hind')).toBe(false);expect(await loader.load('Missing font')).toBe(false);
  });
  it('handles synchronous provider errors without poisoning the queue',async()=>{
    const loader=createFontLoader(()=>{throw Error('blocked');});
    expect(await loader.load('Poppins')).toBe(false);
  });
  it('encodes names with spaces, limits weights and requests swap',()=>{
    expect(googleFontStylesheet('Baloo 2',700)).toContain('family=Baloo+2:wght@700&display=swap');
    expect(()=>googleFontStylesheet('unknown',400)).toThrow();
  });
});
