import { useState } from 'react';
import { DIWALI_TEMPLATES, PREMIUM_DIWALI_TEMPLATES, applyCuratedOffer, OFFER_THEMES, applyOfferTheme, applyThemePairing, clearOfferTheme, offerTheme, type OfferTheme, type DesignTemplate, type DesignAspectRatio } from '@frameflow/shared';
import { OfferPreview } from './OfferPreview';
import { AIThemePanel } from '../aiThemes/AIThemePanel';
import { Section } from './templateUi';

/** Small local previews use native vector marks and UI type; browsing themes never downloads fonts. */
function ThemePreview({ theme }: { theme: OfferTheme }) {
  const p = theme.palette;
  return <svg viewBox="0 0 220 132" aria-hidden="true">
    <rect width="220" height="132" fill={p.background} rx="8" />
    <path d="M8 8H212M8 124H212" stroke={p.gold} opacity=".7" />
    <rect x="147" y="32" width="58" height="75" rx="29" fill={p.surface} stroke={p.gold} strokeWidth=".6" />
    <text x="16" y="25" fill={p.muted} fontSize="7">YOUR LOGO</text>
    <text x="16" y="46" fill={theme.light ? p.accent : p.gold} fontSize="6" letterSpacing="1">{theme.content.eyebrow}</text>
    <text x="16" y="65" fill={p.ink} fontSize="13" fontWeight="700">{theme.content.headline.split('\n')[0]}</text>
    <text x="16" y="80" fill={p.ink} fontSize="13" fontWeight="700">{theme.content.headline.split('\n')[1]}</text>
    <rect x="16" y="89" width="104" height="19" rx="4" fill={p.gold} />
    <text x="23" y="102" fill={theme.light ? p.ink : p.background} fontSize="10" fontWeight="700">{theme.content['offer-value']}</text>
    {[0,1,2].map(i => <circle key={i} cx={163+i*16} cy={18+i%2*4} r={theme.motif==='coins'?5:3} fill={theme.motif==='color'?['#D72679','#25B8CA','#FCC949'][i]:p.gold} />)}
    <text x="158" y="73" fill={p.muted} fontSize="6">PRODUCT</text>
  </svg>;
}
export function ThemePanel({ template, ratio, onChange }: { template: DesignTemplate; ratio: DesignAspectRatio; onChange: (next: DesignTemplate) => void }) {
  const [curated,setCurated] = useState<string>();
  const [pending,setPending] = useState<OfferTheme>();
  const [error,setError] = useState('');
  const active=offerTheme(template.themeId);
  const apply=(theme:OfferTheme, mode:'style'|'replace')=>{
    try {onChange(applyOfferTheme(template,theme.id,mode));setPending(undefined);setError('');}
    catch(problem){setError(problem instanceof Error ? problem.message : 'The theme could not be applied.');}
  };
  return <Section title="Themes" note="(editable offer creatives)">
    <button type="button" className={`ws-btn ${!template.themeId?'ws-btn-primary':''}`} aria-pressed={!template.themeId} onClick={()=>{onChange(clearOfferTheme(template,ratio));setPending(undefined);setCurated(undefined);}}>Custom / No Theme</button>
    <details className="diwali-gallery" open={!template.elements.length || undefined}><summary>Curated Diwali Templates · 5 designs</summary>
      <p className="ws-hint">Ready-made, editable campaigns. Instant loading, no AI.</p>
      <div className="diwali-cards">{DIWALI_TEMPLATES.map(item=><button type="button" key={item.id} className={`theme-card ${template.themeId===item.id?'is-active':''}`} aria-label={`Use ${item.name} template`} onClick={()=>{setPending(undefined);if(template.elements.length)setCurated(item.id);else onChange(applyCuratedOffer(template,item.id));}}>
        <OfferPreview id={item.id}/><strong>{item.name}</strong><small>{item.category}</small><small>{item.description}</small><span className="theme-swatches">{Object.values(item.spec.palette).map(color=><i key={color} style={{background:color}}/>)}</span>
      </button>)}</div>
    </details>
    <details className="premium-gallery" open={!template.elements.length || undefined}><summary>Premium Reference-Inspired Diwali Templates · 6 designs</summary>
      <p className="ws-hint">Photographic scenes with editable copy, logo and hero images.</p>
      <div className="diwali-cards">{PREMIUM_DIWALI_TEMPLATES.map(item=><button type="button" key={item.id} className={`theme-card ${template.themeId===item.id?'is-active':''}`} aria-label={`Use ${item.name} template`} onClick={()=>{setPending(undefined);if(template.elements.length)setCurated(item.id);else onChange(applyCuratedOffer(template,item.id));}}>
        <OfferPreview id={item.id}/><strong>{item.name}</strong><small>{item.category}</small><small>{item.description}</small>
      </button>)}</div>
    </details>
    {curated&&<div className="theme-confirm" role="group" aria-label="Replace with curated template"><strong>Replace current canvas with {[...DIWALI_TEMPLATES,...PREMIUM_DIWALI_TEMPLATES].find(d=>d.id===curated)?.name}?</strong><p>Your saved templates stay unchanged.</p><button type="button" className="ws-btn ws-btn-primary" onClick={()=>{onChange(applyCuratedOffer(template,curated));setCurated(undefined);}}>Replace canvas</button><button type="button" className="ws-btn" onClick={()=>setCurated(undefined)}>Cancel replacement</button></div>}
    <AIThemePanel key={template.id} template={template} onChange={next=>{setPending(undefined);setCurated(undefined);onChange(next);}}/>
    <details className="legacy-themes" open><summary>More festival starters</summary>
    <div className="theme-cards">{OFFER_THEMES.map(theme=><button key={theme.id} type="button" className={`theme-card ${active?.id===theme.id?'is-active':''}`} aria-label={`Apply ${theme.name} theme`} aria-pressed={active?.id===theme.id}
      onClick={()=>{setCurated(undefined);setError('');if(active?.id===theme.id)return;if(template.elements.length)setPending(theme);else apply(theme,'replace');}}>
      <ThemePreview theme={theme}/><strong>{theme.name}{active?.id===theme.id?' ✓':''}</strong><small>{theme.description}</small>
      <span className="theme-swatches">{Object.values(theme.palette).slice(0,5).map(color=><i key={color} style={{background:color}}/>)}</span>
    </button>)}</div></details>
    {pending&&<div className="theme-confirm" role="group" aria-label={`Apply ${pending.name} theme options`}>
      <strong>Apply {pending.name}</strong><p>Styling keeps your text, images and custom layers. Replacing removes the current canvas and starts again.</p>
      <button type="button" className="ws-btn ws-btn-primary" onClick={()=>apply(pending,'style')}>Apply styling only</button>
      <button type="button" className="ws-btn ws-btn-danger" onClick={()=>apply(pending,'replace')}>Replace with {pending.name} starter</button>
      <button type="button" className="ws-btn" onClick={()=>setPending(undefined)}>Cancel theme change</button>
    </div>}
    {active&&<><p className="ws-hint">{active.typography.heading} + {active.typography.body} · layouts adapt to each ratio.</p><button type="button" className="ws-btn" onClick={()=>onChange(applyThemePairing(template))}>Apply theme font pairing</button></>}
    {error&&<p role="alert" className="ws-error-text">{error}</p>}
  </Section>;
}
