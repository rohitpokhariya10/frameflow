import { catalogFont, fontWeightFor } from '@frameflow/shared';
export type FontState = 'idle' | 'loading' | 'ready' | 'failed';
export interface FontRequest { family:string; weight?:number; text?:string }
/** One bounded queue per application, cached by family/real weight. Searching never reaches this service. */
export function createFontLoader(fetchFace: (family:string, weight:number)=>Promise<void>, concurrency=3) {
  const jobs=new Map<string,Promise<boolean>>(), states=new Map<string,FontState>();
  const queue:(()=>void)[]=[]; let active=0;
  const keyOf=(family:string,weight=400)=>`${family}:${fontWeightFor(family,weight)}`;
  const pump=()=>{while(active<concurrency&&queue.length){active++;queue.shift()!();}};
  return {
    state:(family:string,weight=400):FontState=>states.get(keyOf(family,weight))??'idle',
    load(family:string,weight=400):Promise<boolean> {
      if(!catalogFont(family))return Promise.resolve(false);
      const actual=fontWeightFor(family,weight),key=keyOf(family,actual),pending=jobs.get(key);if(pending)return pending;
      states.set(key,'loading');
      const job=new Promise<boolean>(resolve=>{queue.push(()=>{void Promise.resolve().then(()=>fetchFace(family,actual)).then(()=>{states.set(key,'ready');resolve(true);},()=>{states.set(key,'failed');resolve(false);}).finally(()=>{active--;pump();});});});
      jobs.set(key,job);pump();return job;
    },
  };
}
export function googleFontStylesheet(family:string,weight:number):string {
  if(!catalogFont(family))throw new Error('This font is unavailable in the catalog.');
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g,'+')}:wght@${fontWeightFor(family,weight)}&display=swap`;
}
async function browserFace(family:string,weight:number) {
  // Existing bundled Inter/Lora keep their offline behavior and make no external requests.
  const bundled=family==='Inter'||family==='Lora';
  let link:HTMLLinkElement|undefined;
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>finish(new Error('Font loading timed out.')),8000);
    const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(link){link.onload=null;link.onerror=null;}if(error){link?.remove();reject(error);}else resolve();};
    const ready=()=>{void document.fonts.load(`${weight} 24px "${family}"`, 'Offer ₹ हिंदी').then(faces=>faces.length?finish():finish(new Error('Font unavailable.')),finish);};
    if(bundled){ready();return;}
    link=document.createElement('link');link.rel='stylesheet';link.href=googleFontStylesheet(family,weight);link.dataset.frameflowFont=family;
    link.onload=ready;link.onerror=()=>finish(new Error('Font could not load.'));document.head.append(link);
  });
}
export const fontLoader=createFontLoader(browserFace);
export async function loadRequiredFonts(requests:readonly FontRequest[]):Promise<boolean> {
  const needed=requests.filter(r=>r.family!=='Inter'&&r.family!=='Lora');
  if(requests.some(r=>/[\u0900-\u097f]/u.test(r.text??'')&&!catalogFont(r.family)?.devanagari))needed.push({family:'Noto Sans Devanagari',weight:400});
  return (await Promise.all(needed.map(r=>fontLoader.load(r.family,r.weight)))).every(Boolean);
}
