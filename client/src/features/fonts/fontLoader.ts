import { catalogFont, fontWeightFor, offerFace } from '@frameflow/shared';
/** Offer template fonts (shared offerFonts.ts): Template Studio's bundled files, served by the app itself, never a font service. */
const STUDIO_FONT_FILES=import.meta.glob('../../../../server/assets/template-studio/fonts/*/*.ttf',{query:'?url',import:'default',eager:true}) as Record<string,string>;
export const studioFontUrl=(file:string)=>STUDIO_FONT_FILES[`../../../../server/assets/template-studio/fonts/${file}`];
export type FontState = 'idle' | 'loading' | 'ready' | 'failed';
export interface FontRequest { family:string; weight?:number; text?:string; italic?:boolean }
/** One bounded queue per application, cached by family/real weight. Searching never reaches this service. */
export function createFontLoader(fetchFace: (family:string, weight:number, italic?:boolean)=>Promise<void>, concurrency=3) {
  const jobs=new Map<string,Promise<boolean>>(), states=new Map<string,FontState>();
  const queue:(()=>void)[]=[]; let active=0;
  // An italic face is its own download; a family without one is drawn upright-slanted by the browser, as before.
  const keyOf=(family:string,weight=400,italic=false)=>`${family}:${fontWeightFor(family,weight)}${italic&&catalogFont(family)?.italic?':italic':''}`;
  const pump=()=>{while(active<concurrency&&queue.length){active++;queue.shift()!();}};
  return {
    state:(family:string,weight=400,italic=false):FontState=>states.get(keyOf(family,weight,italic))??'idle',
    load(family:string,weight=400,italic=false):Promise<boolean> {
      if(!catalogFont(family))return Promise.resolve(false);
      const actual=fontWeightFor(family,weight),slanted=italic&&!!catalogFont(family)?.italic,key=keyOf(family,actual,slanted),pending=jobs.get(key);if(pending)return pending;
      states.set(key,'loading');
      const job=new Promise<boolean>(resolve=>{queue.push(()=>{void Promise.resolve().then(()=>slanted?fetchFace(family,actual,true):fetchFace(family,actual)).then(()=>{states.set(key,'ready');resolve(true);},()=>{states.set(key,'failed');resolve(false);}).finally(()=>{active--;pump();});});});
      jobs.set(key,job);pump();return job;
    },
  };
}
export function googleFontStylesheet(family:string,weight:number,italic=false):string {
  if(!catalogFont(family))throw new Error('This font is unavailable in the catalog.');
  const name=encodeURIComponent(family).replace(/%20/g,'+'),w=fontWeightFor(family,weight),axes=italic&&catalogFont(family)?.italic?`ital,wght@1,${w}`:`wght@${w}`;
  return `https://fonts.googleapis.com/css2?family=${name}:${axes}&display=swap`;
}
async function browserFace(family:string,weight:number,italic=false) {
  // An offer font's own file (the same one the server measured it with) is loaded from the app; nothing external.
  const local=offerFace(family,weight,italic?'italic':'normal'),url=local?.root==='studio'?studioFontUrl(local.file):undefined;
  if(url&&local&&(local.style==='italic')===italic){
    const face=new FontFace(family,`url(${url})`,{weight:String(weight),style:italic?'italic':'normal'});
    document.fonts.add(await face.load());
    if(!(await document.fonts.load(`${italic?'italic ':''}${weight} 24px "${family}"`,'Offer')).length)throw new Error('Font unavailable.');
    return;
  }
  // Existing bundled Inter/Lora keep their offline behavior and make no external requests.
  const bundled=family==='Inter'||family==='Lora';
  let link:HTMLLinkElement|undefined;
  await new Promise<void>((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>finish(new Error('Font loading timed out.')),8000);
    const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);if(link){link.onload=null;link.onerror=null;}if(error){link?.remove();reject(error);}else resolve();};
    const ready=()=>{void document.fonts.load(`${italic?'italic ':''}${weight} 24px "${family}"`, 'Offer ₹ हिंदी').then(faces=>faces.length?finish():finish(new Error('Font unavailable.')),finish);};
    if(bundled){ready();return;}
    link=document.createElement('link');link.rel='stylesheet';link.href=googleFontStylesheet(family,weight,italic);link.dataset.frameflowFont=family;
    link.onload=ready;link.onerror=()=>finish(new Error('Font could not load.'));document.head.append(link);
  });
}
export const fontLoader=createFontLoader(browserFace);
export async function loadRequiredFonts(requests:readonly FontRequest[]):Promise<boolean> {
  // Inter and Lora are bundled (their italics load on first use, so those are asked for like any other face).
  const needed=requests.filter(r=>!((r.family==='Inter'||r.family==='Lora')&&!r.italic));
  if(requests.some(r=>/[\u0900-\u097f]/u.test(r.text??'')&&!catalogFont(r.family)?.devanagari))needed.push({family:'Noto Sans Devanagari',weight:400});
  return (await Promise.all(needed.map(r=>fontLoader.load(r.family,r.weight,r.italic)))).every(Boolean);
}
