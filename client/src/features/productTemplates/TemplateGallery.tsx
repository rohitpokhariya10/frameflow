/**
 * Create Offer Creative, step 1: the saved templates as large cards, one action each (Use This Template). For anyone:
 * no versions, stages, layers or plans — only templates ready to use are shown. Templates made from a creative
 * (Decompose & Edit) follow the masters in their own row.
 */
import { useEffect, useState } from 'react';
import { ArrowRight, Check, LayoutTemplate } from 'lucide-react';
import { productApi, productFileUrl, type ProductListItem } from './api';

export const CREATIVE_STEPS = ['Choose Template', 'Upload Products', 'Generate', 'Review & Save'] as const;
/** Where the person is in the four steps of Create Offer Creative. */
export function CreativeSteps({ current }: { current: 0 | 1 | 2 | 3 }) {
  return <ol className="cg-steps" aria-label="Steps">{CREATIVE_STEPS.map((s, i) => <li key={s} className={i === current ? 'is-current' : i < current ? 'is-done' : ''} aria-current={i === current ? 'step' : undefined}>
    <span className="cg-step-dot">{i < current ? <Check size={12} aria-hidden="true" /> : i + 1}</span><span className="cg-step-label">{s}</span></li>)}</ol>;
}

/** A canvas size in words (Square, Portrait 4:5, Landscape 16:9 …). */
export function formatName(width: number, height: number) {
  const r = width / Math.max(1, height), known: [number, string][] = [[1, 'Square'], [4 / 5, 'Portrait 4:5'], [9 / 16, 'Story 9:16'], [16 / 9, 'Landscape 16:9'], [3 / 4, 'Portrait 3:4'], [4 / 3, 'Landscape 4:3']];
  const near = known.find(([k]) => Math.abs(r - k) / k < 0.03);
  return near ? near[1] : r > 1 ? 'Landscape' : 'Portrait';
}

export function TemplateGallery({ onUse }: { onUse: (id: string) => void }) {
  const [templates, setTemplates] = useState<ProductListItem[]>(), [error, setError] = useState('');
  useEffect(() => { void productApi.list().then(r => setTemplates(r.templates)).catch(() => setError('We couldn’t load your templates. Check your connection and try again.')); }, []);
  const ready = (templates ?? []).filter(t => t.revisions > 0);
  const fromCreative = (t: ProductListItem) => /^variation-/.test(t.source.origin?.kind === 'upload' ? t.source.origin.filename ?? '' : '');
  const masters = ready.filter(t => !fromCreative(t)), mine = ready.filter(fromCreative);
  const card = (t: ProductListItem) => <article key={t.id} className="cg-card" aria-label={`Template ${t.name}`}>
    <button type="button" className="cg-thumb" onClick={() => onUse(t.id)} aria-label={`Use ${t.name}`} tabIndex={-1}>
      <img src={productFileUrl(t.id, t.source.inputFile)} alt="" loading="lazy" style={{ aspectRatio: `${t.source.width} / ${t.source.height}` }} />
    </button>
    <div className="cg-card-body">
      <h3>{t.name}</h3>
      <p className="cg-meta">{formatName(t.source.width, t.source.height)} format · ready to use</p>
      <button type="button" className="ws-btn ws-btn-primary cg-use" onClick={() => onUse(t.id)}>Use This Template<ArrowRight size={15} aria-hidden="true" /></button>
    </div>
  </article>;
  return <div className="cg-page">
    <header className="cg-head"><h2>Choose a template</h2><p>Pick the design for your offer. You’ll add your own product photos next — the festive artwork, text and logos stay as they are.</p></header>
    <CreativeSteps current={0} />
    {error && <div className="sr-error" role="alert"><p>{error}</p></div>}
    {!templates && !error ? <div className="cg-grid" aria-busy="true" aria-label="Loading templates">{[0, 1, 2].map(i => <div key={i} className="cg-card cg-skeleton" aria-hidden="true"><div className="cg-thumb" /><div className="cg-card-body"><span /><span /></div></div>)}</div>
      : templates && !ready.length ? <section className="cg-empty"><LayoutTemplate size={30} aria-hidden="true" /><h3>No templates yet</h3><p>Ask your template owner to add one under Offer Templates. It will appear here, ready to use.</p></section>
      : <>
        <div className="cg-grid">{masters.map(card)}</div>
        {mine.length > 0 && <section className="cg-mine" aria-label="Templates made from your creatives"><h3>Made from your creatives</h3><div className="cg-grid is-compact">{mine.map(card)}</div></section>}
      </>}
  </div>;
}
