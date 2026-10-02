import { useMemo, useState } from 'react';
import { catalogFont, searchFonts } from '@frameflow/shared';
import { fontLoader } from './fontLoader';
export function FontPicker({value,onChange,recommended=[],recommendationLabel='Recommended fonts'}:{value:string;onChange:(font:string)=>void;recommended?:readonly string[];recommendationLabel?:string}) {
  const [query,setQuery]=useState(''),[open,setOpen]=useState(false);
  const results=useMemo(()=>searchFonts(query),[query]);
  const select=(font:string)=>{onChange(font);setOpen(false);};
  return <div className="theme-font-picker">
    <strong>Font Family</strong>
    <button type="button" className="ws-btn" aria-label="Choose font" aria-expanded={open} onClick={()=>setOpen(!open)}>{value} · Search fonts… ▾</button>
    {fontLoader.state(value)==='failed'&&<small role="status">Font unavailable. A readable fallback is shown; your selection is kept.</small>}
    {open&&<div className="theme-font-menu">
      <label>Search fonts<input type="search" aria-label="Search fonts" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search all Google Fonts…" /></label>
      {!query.trim()&&recommended.length>0&&<><strong>{recommendationLabel}</strong><div className="theme-font-results">{recommended.map(family=><button key={family} type="button" onClick={()=>select(family)}>{family}{catalogFont(family)?.devanagari&&<small>Devanagari</small>}</button>)}</div></>}
      <strong>All fonts · {results.length}</strong>
      <div className="theme-font-results" role="list" aria-label="Font search results">{results.slice(0,40).map(font=><button type="button" role="listitem" key={font.family} aria-label={`Use font ${font.family}`} onClick={()=>select(font.family)}>{font.family}{font.devanagari&&<small>Devanagari</small>}</button>)}</div>
      {!results.length&&<p>No fonts found. Try a different name.</p>}{results.length>40&&<small>Showing the first 40. Refine your search to find any family.</small>}
      <small>Names use the interface font. Only selected fonts download.</small>
    </div>}
  </div>;
}
