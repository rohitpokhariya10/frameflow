import { useEffect, useState } from 'react';
import { loadRequiredFonts, type FontRequest } from './fontLoader';
/** Late font responses only trigger remeasurement; they never mutate chosen fonts, content or geometry. */
export function useFonts(requests:readonly FontRequest[]) {
  const signature=JSON.stringify(requests.map(r=>[r.family,r.weight??400,/[\u0900-\u097f]/u.test(r.text??'')]));
  const [ready,setReady]=useState({signature:'',revision:0,failed:false});
  useEffect(()=>{
    let cancelled=false;
    const values=JSON.parse(signature) as [string,number,boolean][];
    void loadRequiredFonts(values.map(([family,weight,hindi])=>({family,weight,text:hindi?'हिंदी':''}))).then(ok=>{
      if(!cancelled)setReady(previous=>({signature,revision:previous.revision+1,failed:!ok}));
    });
    return()=>{cancelled=true;};
  },[signature]);
  return {revision:ready.revision,failed:ready.signature===signature&&ready.failed,loading:ready.signature!==signature};
}
