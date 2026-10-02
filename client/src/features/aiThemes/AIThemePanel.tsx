import { useEffect, useRef, useState } from 'react';
import { compileOfferTemplate, parseThemeSpec, type DesignTemplate, type ThemeSpec } from '@frameflow/shared';
/** One explicit request per click; generated data stays a draft until the designer applies it. */
export function AIThemePanel({template,onChange}:{template:DesignTemplate;onChange:(next:DesignTemplate)=>void}) {
  const [expanded,setExpanded]=useState(false);
  const [prompt,setPrompt]=useState(''),[pending,setPending]=useState<ThemeSpec>(),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const controller=useRef<AbortController|null>(null);
  useEffect(()=>()=>controller.current?.abort(),[]);
  const generate=async()=>{
    if(controller.current||!prompt.trim())return;
    const request=new AbortController();controller.current=request;setBusy(true);setError('');setPending(undefined);
    const timer=setTimeout(()=>request.abort(),70_000);
    try {
      const response=await fetch('/api/themes/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt}),signal:request.signal});
      const result=await response.json();if(!response.ok)throw new Error(result.error?.message??'Theme planning failed.');
      const spec=parseThemeSpec(result.spec);
      // Compile before offering Apply; malformed designs never replace the current canvas.
      compileOfferTemplate(template,spec,'ai','diwali-ai');setPending(spec);
    }catch(problem){if(controller.current===request)setError(request.signal.aborted?'Theme planning timed out. Your canvas is unchanged. Retry when ready.':problem instanceof Error?problem.message:'Theme planning failed.');}
    finally{clearTimeout(timer);if(controller.current===request){controller.current=null;setBusy(false);}}
  };
  return <details className="ai-theme-panel" onToggle={event=>setExpanded(event.currentTarget.open)}><summary>✨ Generate Diwali Theme with AI</summary>
    {expanded&&<><p>Describe a new design. One AI planning request; the result is an editable template.</p>
    <label>Describe your creative<textarea aria-label="Describe your Diwali creative" rows={4} maxLength={2000} value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Premium maroon and gold, product on right, 40% off and a shop-now CTA…"/></label>
    <small>{prompt.length}/2,000</small>
    <button type="button" className="ws-btn ws-btn-primary" disabled={busy||!prompt.trim()} onClick={()=>void generate()}>{busy?'Planning your theme…':'Generate Editable Theme'}</button>
    {error&&<p role="alert" className="ws-warn">{error}</p>}
    {pending&&<div className="theme-confirm" role="group" aria-label="AI theme draft"><strong>{pending.templateName}</strong><p>{pending.content.headline} · {pending.content.offerValue}</p><p>{template.elements.length?'Applying replaces the current canvas. Your saved templates remain unchanged.':'Ready to load as editable layers.'}</p>
      <button type="button" className="ws-btn ws-btn-primary" onClick={()=>{onChange(compileOfferTemplate(template,pending,'ai','diwali-ai'));setPending(undefined);}}>Apply generated theme</button>
      <button type="button" className="ws-btn" onClick={()=>setPending(undefined)}>Discard generated draft</button>
    </div>}
  </>} </details>;
}
