/**
 * Offer Templates: Text & Graphics master templates and the creatives made from them.
 *
 *   Template creation   choose the type → Upload → Scan & Review → Prepare & Save (MasterSetup)
 *   Template reuse      choose a template → edit content (CreativeStudio) → Open in Editor → save the creative
 *
 * Product + Text templates (products, characters, text and logos as layers) have their own flow (productTemplates/);
 * Template Studio's generated posters stay on its own tab.
 */
import { useCallback, useEffect, useState } from 'react';
import { FileImage, LayoutTemplate, Package, Plus, Sparkles, Type, Upload } from 'lucide-react';
import { MASTER_STAGE_LABELS, TEMPLATE_TYPE_LABELS, type ProtectedSourceOrigin, type TemplateType } from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { masterApi, masterFileUrl, type CreativeSummary, type MasterListItem } from './api';
import { MasterSetup } from './MasterSetup';
import { CreativeStudio } from './CreativeStudio';
import { AiCreatives } from './AiCreatives';
import { ProductLibrary, ProductTemplates, type ProductRequest } from '../productTemplates/ProductTemplates';
import { TemplateGallery } from '../productTemplates/TemplateGallery';
import './offerTemplates.css';

export type OfferRequest = { view: 'new' } | { view: 'setup'; id: string } | { view: 'reuse'; id: string; creativeId?: string };
type View = { kind: 'library' } | { kind: 'new' } | { kind: 'setup'; id: string } | { kind: 'ai'; id: string } | { kind: 'reuse'; id: string; creativeId?: string; at: number } | { kind: 'product'; request: ProductRequest; at: number };

/** The two kinds of template, as two simple cards (also shown at the start of Template Studio's Create Template). */
export function TemplateTypeChoice({ value, onChoose }: { value?: TemplateType; onChoose: (type: TemplateType) => void }) {
  return <div className="ot-types" role="group" aria-label="Template type">
    <button type="button" className="ot-type" aria-pressed={value === 'text-graphics'} onClick={() => onChoose('text-graphics')}>
      <h3><Type size={18} aria-hidden="true" />{TEMPLATE_TYPE_LABELS['text-graphics'].title}</h3>
      <p>{TEMPLATE_TYPE_LABELS['text-graphics'].summary}</p>
      <ul><li>Upload an existing offer poster</li><li>Every word and logo becomes editable</li><li>Reuse it for new offers without a new scan</li></ul>
    </button>
    <button type="button" className="ot-type" aria-pressed={value === 'product-text'} onClick={() => onChoose('product-text')}>
      <h3><Package size={18} aria-hidden="true" />{TEMPLATE_TYPE_LABELS['product-text'].title}</h3>
      <p>{TEMPLATE_TYPE_LABELS['product-text'].summary}</p>
      <ul><li>Reference posters with products</li><li>Product replacement and generation</li><li>Decomposition and supporting text</li></ul>
    </button>
  </div>;
}

export function OfferTemplates({ request, onProductTemplate, onOpenCreative, onOpenRun, onOpenRunInEditor, client = false }: {
  request?: OfferRequest & { at: number };
  /** Create Offer Creative: the template gallery (Use This Template → the simple flow) instead of the template library. */
  client?: boolean;
  /** Template Studio's own Create Template (generated posters), offered beside Product with Text templates. */
  onProductTemplate: () => void;
  onOpenCreative: (masterId: string, creativeId: string) => Promise<void>;
  /** A creative's decomposition run, shown in the decomposition workspace. */
  onOpenRun?: (runId: string) => Promise<void>;
  /** A Product with Text creative's run, opened straight in the editor. */
  onOpenRunInEditor?: (runId: string) => Promise<void>;
}) {
  const [view, setView] = useState<View>(() => !request ? { kind: 'library' } : request.view === 'new' ? { kind: 'new' } : request.view === 'setup' ? { kind: 'setup', id: request.id } : { kind: 'reuse', id: request.id, creativeId: request.creativeId, at: request.at });
  const library = () => setView({ kind: 'library' });
  /** Open in Editor straight from a saved master: a new creative, opened in the editor. */
  const editorFromMaster = useCallback(async (id: string) => { const c = await masterApi.createCreative(id); await onOpenCreative(id, c.id); }, [onOpenCreative]);
  const product = (r: ProductRequest) => setView({ kind: 'product', request: r, at: Date.now() });
  if (view.kind === 'product') return <ProductTemplates onOpenRun={onOpenRun} key={view.at} request={view.request} onBack={library} onOpenRunInEditor={onOpenRunInEditor ?? (async () => { throw new Error('The editor is unavailable.'); })} />;
  if (view.kind === 'setup') return <MasterSetup key={view.id} id={view.id} onBack={library} onReuse={id => setView({ kind: 'reuse', id, at: Date.now() })} onOpenEditor={editorFromMaster} />;
  if (view.kind === 'ai') return <AiCreatives masterId={view.id} onBack={library} onSetup={() => setView({ kind: 'setup', id: view.id })} onManual={() => setView({ kind: 'reuse', id: view.id, at: Date.now() })} onEdit={creativeId => setView({ kind: 'reuse', id: view.id, creativeId, at: Date.now() })} onOpenRun={onOpenRun} />;
  if (view.kind === 'reuse') return <CreativeStudio key={`${view.id}-${view.creativeId ?? view.at}`} masterId={view.id} creativeId={view.creativeId} onBack={library} onOpenEditor={onOpenCreative} onAi={() => setView({ kind: 'ai', id: view.id })} onOpenRun={onOpenRun} />;
  if (view.kind === 'new') return <NewTemplate onCancel={library} onProduct={() => product({ view: 'new' })} onCreated={id => setView({ kind: 'setup', id })} />;
  if (client) return <TemplateGallery onUse={id => product({ view: 'reuse', id })} />;
  return <>
    <Library onNew={() => setView({ kind: 'new' })} onSetup={id => setView({ kind: 'setup', id })} onAi={id => setView({ kind: 'ai', id })} onReuse={(id, creativeId) => setView({ kind: 'reuse', id, creativeId, at: Date.now() })} />
    <div className="ot-page prt-library-page"><ProductLibrary onNew={() => product({ view: 'new' })} onSetup={id => product({ view: 'setup', id })} onUse={id => product({ view: 'template', id })} onGenerate={id => product({ view: 'template', id, tab: 'variations' })} onReuse={id => product({ view: 'reuse', id })} />
      <p className="ot-muted">Want brand-new posters drawn by AI instead? Use <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={onProductTemplate}>Template Studio</button>.</p></div>
  </>;
}

function NewTemplate({ onCancel, onProduct, onCreated, origin }: { onCancel: () => void; onProduct: () => void; onCreated: (id: string) => void; origin?: { file: Blob; name: string; origin: ProtectedSourceOrigin } }) {
  const [type, setType] = useState<TemplateType>('text-graphics'), [file, setFile] = useState<File>(), [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const preview = file ? URL.createObjectURL(file) : undefined;
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const create = async () => {
    setBusy(true); setError('');
    try { const v = await masterApi.create(origin?.file ?? file!, name || origin?.name || '', origin?.origin); onCreated(v.template.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create the template.'); }
    finally { setBusy(false); }
  };
  return <div className="ot-page">
    <div className="ot-head"><div><p className="ot-kicker">Create template</p><h2>What kind of template is it?</h2><p>Choose the type first. Easy EMI and other offer posters with replaceable text, logos, badges and QR codes are Text &amp; Graphics.</p></div>
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onCancel}>Cancel</button></div>
    <TemplateTypeChoice value={type} onChoose={t => (t === 'product-text' ? onProduct() : setType(t))} />
    <section className="ts-card"><div className="ts-card-body">
      <h3 style={{ fontSize: 15 }}>1 · Upload the offer creative</h3>
      <p className="ot-muted">The finished poster, with its text and logos. It is kept unchanged as the template’s original; nothing is sent to an AI service.</p>
      {error && <Alert>{error}</Alert>}
      <div className="ot-row" style={{ alignItems: 'flex-start' }}>
        <div style={{ display: 'grid', gap: 10, minWidth: 280, flex: 1 }}>
          <label className="ff-lab-upload"><strong>{file?.name ?? 'Choose the poster (PNG, JPEG or WebP)'}</strong><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Offer creative" onChange={e => { const f = e.target.files?.[0]; setFile(f); if (f && !name) setName(f.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 80)); }} /></label>
          <label className="ot-field"><span>Template name</span><input value={name} maxLength={120} placeholder="Easy EMI · bank offers" aria-label="Template name" onChange={e => setName(e.target.value)} /></label>
          <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || (!file && !origin)} onClick={() => void create()}><Upload size={15} aria-hidden="true" />{busy ? 'Uploading…' : 'Upload and scan'}</button></div>
          <p className="ot-muted">Next: the scan finds every word, logo and offer element (on this computer, free), you review them, then FrameFlow prepares a clean background and saves the master.</p>
        </div>
        {preview && <img src={preview} alt="Poster preview" style={{ maxWidth: 300, maxHeight: 380, borderRadius: 8, border: '1px solid var(--color-line)' }} />}
      </div>
    </div></section>
  </div>;
}

function Library({ onNew, onSetup, onReuse, onAi }: { onNew: () => void; onSetup: (id: string) => void; onReuse: (id: string, creativeId?: string) => void; onAi: (id: string) => void }) {
  const [masters, setMasters] = useState<MasterListItem[]>(), [error, setError] = useState(''), [open, setOpen] = useState<string>(), [creatives, setCreatives] = useState<Record<string, CreativeSummary[]>>({});
  useEffect(() => { void masterApi.list().then(r => setMasters(r.masters)).catch((e: Error) => setError(e.message)); }, []);
  const showCreatives = (id: string) => { setOpen(open === id ? undefined : id); if (!creatives[id]) void masterApi.creatives(id).then(r => setCreatives(c => ({ ...c, [id]: r.creatives }))).catch(() => undefined); };
  return <div className="ot-page">
    <div className="ot-head">
      <div><p className="ot-kicker">Offer templates · Text &amp; Graphics</p><h2>Saved templates</h2><p>Create a master once from an offer poster, then make as many creatives from it as you need: new copy, logos, fonts and colours on the saved artwork, with no new scan or decomposition.</p></div>
      <button type="button" className="ws-btn ws-btn-primary" onClick={onNew}><Plus size={15} aria-hidden="true" />New template</button>
    </div>
    {error && <Alert>{error}</Alert>}
    {!masters ? <p className="ot-muted" role="status">Loading…</p> : !masters.length ? <section className="ts-card"><div className="ts-card-body" style={{ justifyItems: 'start' }}>
      <LayoutTemplate size={26} aria-hidden="true" /><h3>No templates yet</h3><p className="ot-muted">Upload an offer creative to make your first master template.</p>
      <button type="button" className="ws-btn ws-btn-primary" onClick={onNew}><Plus size={15} aria-hidden="true" />New template</button></div></section>
      : <div className="ot-grid">{masters.map(m => <article key={m.id} className="ot-card" aria-label={`Template ${m.name}`}>
        <img src={masterFileUrl(m.id, m.source.inputFile)} alt="" loading="lazy" />
        <div className="ot-card-body">
          <h3>{m.name}</h3>
          <div className="ot-row"><Badge tone={m.stage === 'ready' ? 'ok' : m.stage === 'scan-failed' ? 'danger' : 'neutral'}>{MASTER_STAGE_LABELS[m.stage]}</Badge><span className="ot-small ot-muted">{m.words} words · {m.logos} logos · {m.creatives} creative{m.creatives === 1 ? '' : 's'}</span></div>
          <div className="ot-row">
            {m.latestRevision ? <button type="button" className="ws-btn ws-btn-primary" onClick={() => onReuse(m.id)}><Sparkles size={14} aria-hidden="true" />Reuse Template</button> : null}
            {m.latestRevision ? <button type="button" className="ws-btn" onClick={() => onAi(m.id)}>Generate AI Variations</button> : null}
            <button type="button" className="ws-btn" onClick={() => onSetup(m.id)}>{m.latestRevision ? 'Edit master' : 'Continue setup'}</button>
            {m.creatives > 0 && <button type="button" className="ws-btn ws-btn-quiet" aria-expanded={open === m.id} onClick={() => showCreatives(m.id)}><FileImage size={14} aria-hidden="true" />Creatives</button>}
          </div>
          {m.latestRevision ? <p className="ot-small">Reuse keeps your layout for manual edits. AI Variations restyles it: new fonts, colours and a background tint on the same layout; each stays editable.</p> : null}
          {open === m.id && <ul className="ot-list" aria-label={`Creatives of ${m.name}`}>{(creatives[m.id] ?? []).map(c => <li key={c.id}><button type="button" className="ot-item" onClick={() => onReuse(m.id, c.id)}>
            <span className="ot-dot is-approved" aria-hidden="true" /><span>{c.name}</span><span className="ot-chip">{new Date(c.updatedAt).toLocaleDateString()}</span></button></li>)}</ul>}
        </div>
      </article>)}</div>}
  </div>;
}
