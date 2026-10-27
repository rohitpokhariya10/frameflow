/**
 * Template details: what a saved template knows, apart in two parts.
 *
 *   How new creatives should look   the generation instructions (product/brief.ts): the subject, products and characters,
 *                                   style, palette, background, layout, typography, the approved copy (never rewritten),
 *                                   what an artwork never contains, and the artwork prompt made from them — written by
 *                                   FrameFlow from the AI detection (said so) or edited here; Generate with AI uses them
 *   How it is decomposed            the decomposition plan: what was cut out, what stays in the background, the overlays
 */
import { useEffect, useState } from 'react';
import { RotateCcw, Save, SlidersHorizontal } from 'lucide-react';
import type { ProductGenerationBrief } from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { productApi, type ProductView, type TemplateBrief } from './api';

type Field = 'subject' | 'style' | 'background' | 'layout' | 'typography' | 'negative' | 'prompt';
const FIELDS: [Field, string, number][] = [['subject', 'What it is', 2], ['style', 'Style', 2], ['background', 'Background and decoration', 3], ['layout', 'Layout to keep', 2], ['typography', 'Typography', 2], ['negative', 'Never in the artwork', 3], ['prompt', 'Artwork prompt (made from the above)', 5]];

export function ProductDetails({ view, onChanged, onChangeSelection }: { view: ProductView; onChanged: (v: ProductView) => void; onChangeSelection: () => void }) {
  const id = view.template.id;
  const [brief, setBrief] = useState<TemplateBrief>(), [draft, setDraft] = useState<Partial<ProductGenerationBrief>>({}), [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState('');
  useEffect(() => { void productApi.brief(id).then(setBrief).catch((e: Error) => setError(e.message)); }, [id]);
  if (!brief) return error ? <Alert>{error}</Alert> : <p className="ot-muted" role="status">Loading…</p>;
  const g = brief.generation, changed = Object.keys(draft).length > 0;
  const save = async (derive: boolean) => {
    setBusy(true); setError(''); setNote('');
    try { const r = await productApi.editBrief(id, { expectedRevision: view.template.revision, ...(derive ? { derive: true } : { brief: draft }) }); setBrief(r); setDraft({}); onChanged(r.template); setNote(derive ? 'Written again from the template.' : 'Saved: Generate with AI uses these instructions from now on.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save.'); }
    finally { setBusy(false); }
  };
  const d = brief.decomposition;
  return <div className="prt-details">
    <section className="ts-card" aria-label="How new creatives should look"><div className="ts-card-body">
      <div className="ot-row"><h3>How new creatives should look</h3>
        <Badge tone={g.edited ? 'accent' : 'neutral'}>{g.source === 'original' ? 'Original prompt' : g.edited ? 'Edited by you' : 'Written by FrameFlow from the AI detection'}</Badge></div>
      <p className="ot-muted">Generate with AI plans every variation from these, so nobody has to write a prompt. {g.source === 'derived' ? 'They were written from this template’s detection, not from the prompt the creative was originally made with.' : ''} Products, characters, text and logos are always the template’s own layers, placed over new artwork.</p>
      {error && <Alert>{error}</Alert>}{note && <p className="prt-note" role="status">{note}</p>}
      <div className="prt-details-grid">
        <div className="ot-field"><span>Products</span><p className="ot-small">{g.products.map(p => p.label).join(', ') || '—'}</p></div>
        <div className="ot-field"><span>Characters</span><p className="ot-small">{g.characters.map(p => p.label).join(', ') || '—'}</p></div>
        <div className="ot-field"><span>Logos (kept as they are)</span><p className="ot-small">{g.brand.logos.join(', ') || '—'}</p></div>
        <div className="ot-field"><span>Palette</span><p className="prt-palette">{g.palette.map(c => <span key={c} className="prt-swatch-lg" style={{ background: c }} title={c} />)}</p></div>
      </div>
      {FIELDS.map(([k, label, rows]) => <label key={k} className="ot-field"><span>{label}</span>
        <textarea rows={rows} maxLength={k === 'prompt' ? 2000 : 800} value={(draft[k] as string | undefined) ?? g[k]} aria-label={label} onChange={e => setDraft(x => ({ ...x, [k]: e.target.value }))} /></label>)}
      <div className="ot-field"><span>Approved copy (used as it is; offers, prices, dates and legal text are never rewritten)</span>
        <ul className="prt-copy">{g.copy.map((c, k) => <li key={k}><span className="ot-chip">{c.role}</span> {c.text}</li>)}</ul></div>
      <div className="ot-row">
        <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !changed} onClick={() => void save(false)}><Save size={14} aria-hidden="true" />Save instructions</button>
        <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void save(true)}><RotateCcw size={14} aria-hidden="true" />Write them again from the template</button>
      </div>
    </div></section>
    <section className="ts-card" aria-label="How it is decomposed"><div className="ts-card-body">
      <h3>How it is decomposed</h3>
      <p>{d.instructions}</p>
      <ul className="prt-plan">{d.elements.map(e => <li key={e.id}><span className={`ot-dot${e.decompose ? ' is-approved' : ''}`} aria-hidden="true" />{e.label}<span className="prt-reason">{e.decompose ? 'its own layer' : 'in the background'}</span></li>)}</ul>
      <button type="button" className="ws-btn" onClick={onChangeSelection}><SlidersHorizontal size={14} aria-hidden="true" />Change what is decomposed</button>
    </div></section>
  </div>;
}
