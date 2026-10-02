import { memo, useMemo } from 'react';
import { applyCuratedOffer, builtinDiwaliAsset, PREMIUM_DIWALI_TEMPLATES, createTemplateDraft, type TemplateElement } from '@frameflow/shared';
/** Premium thumbnails are actual canvas renders; existing curated previews keep their original renderer. */
export const OfferPreview = memo(function OfferPreview({id}:{id:string}) {
  const premium=PREMIUM_DIWALI_TEMPLATES.some(d=>d.id===id);
  const elements=useMemo(()=>premium?[]:applyCuratedOffer(createTemplateDraft('preview','2026-10-01T00:00:00Z'),id).elements,[id,premium]);
  if(premium)return <img src={`/assets/diwali-premium/previews/${id}.webp`} loading="lazy" decoding="async" width="420" height="420" alt=""/>;
  const draw=(e:TemplateElement)=>{
    const {x,y,width:w,height:h}=e.layout,box={x:x*400,y:y*400,width:w*400,height:h*400};
    if(e.type==='background')return <rect {...box} fill={e.defaultContent.color}/>;
    if(e.type==='shape')return <g>{e.style.gradient&&<defs><linearGradient id={`${id}-${e.id}`} gradientTransform={`rotate(${e.style.gradient.angle} .5 .5)`}><stop stopColor={e.style.gradient.from}/><stop offset="1" stopColor={e.style.gradient.to}/></linearGradient></defs>}<rect {...box} rx={e.style.cornerRadius*Math.min(w,h)*200} fill={e.style.gradient?`url(#${id}-${e.id})`:e.style.fill} opacity={e.style.opacity} stroke={e.style.stroke??undefined} strokeWidth={e.style.strokeWidth*400}/></g>;
    if(e.type==='image'){
      const svg=e.defaultContent.assetId&&builtinDiwaliAsset(e.defaultContent.assetId);
      return svg?<image {...box} href={`data:image/svg+xml,${encodeURIComponent(svg)}`} opacity={e.style.opacity}/>:<g><rect {...box} rx="3" fill="#C3AE8222" stroke="#BDAA7A" strokeWidth=".5"/><text x={(x+w/2)*400} y={(y+h/2)*400} fill="#BDAA7A" fontSize="5" textAnchor="middle">{e.role==='logo'?'LOGO':'PRODUCT'}</text></g>;
    }
    const size=Math.min(e.style.fontSize*400,h*400/2.4),chars=Math.max(5,Math.floor(w*400/(size*.55)));
    const lines:string[]=[];
    for(const para of e.defaultContent.text.split('\n')){let line='';for(const word of para.split(' ')){if((line+' '+word).trim().length>chars&&line){lines.push(line);line=word;}else line=(line+' '+word).trim();}lines.push(line);}
    const centered=e.style.align==='center';
    return <g>{e.style.backgroundColor&&<rect {...box} rx="3" fill={e.style.backgroundColor}/>}<text x={(centered?x+w/2:x)*400} y={y*400+size} fill={e.style.color} fontSize={size} fontWeight={e.style.fontWeight} textAnchor={centered?'middle':'start'}>{lines.slice(0,3).map((line,i)=><tspan key={i} x={(centered?x+w/2:x)*400} dy={i?size*1.15:0}>{line}</tspan>)}</text></g>;
  };
  return <svg viewBox="0 0 400 400" aria-hidden="true">{elements.map(e=><g key={e.id}>{draw(e)}</g>)}</svg>;
});
