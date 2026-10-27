/**
 * Reuse Template studio: a saved Product with Text template reused with the person's own product set (select, deselect,
 * add, replace, remove, restore, reorder), copy, logos and output formats. Products are arranged on the template's stage
 * (the template's own places, fixed rules on this computer, or an approved AI placement), each format is recomposed
 * without stretching, every element stays its own layer, and the results are saved as creatives that open in the editor
 * or go on to the separately approved AI decomposition. Separate from Generate AI Variations.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Eye, EyeOff, ImagePlus, Layers3, Plus, RotateCcw, Save, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { OFFER_FONT_FAMILIES, offerWeights, PRODUCT_CHECK_KIND, REUSE_ASPECT_RATIOS, type ProductSnapshot, type ReuseAspectRatio, type ReuseDraft, type ReuseItem, type ReuseTextEdit } from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { CreativeCanvas, type Selected } from '../masterTemplates/CreativeCanvas';
import { loadCreativeFonts } from '../masterTemplates/creativeText';
import { productApi, productFileUrl, type ReuseDraftChange, type ReuseDraftSummary, type ReusePreview, type ReuseStudioView } from './api';
import { asInstance, asSnapshot } from './ProductTemplatePage';
import { SimpleReuse } from './SimpleReuse';

const CATEGORIES = ['refrigerator', 'washing machine', 'dishwasher', 'air conditioner', 'television', 'microwave oven', 'water purifier', 'soundbar', 'speaker', 'subwoofer', 'phone', 'computer', 'mixer grinder', 'air fryer', 'induction cooktop'];
const PLACEMENT_LABEL = { original: 'the template’s own places', geometry: 'arranged on this computer (free, fixed rules)', ai: 'placed by the approved AI plan' } as const;

/**
 * Reuse Template: the simple flow first (Upload Products → Generate My Creative → Review and save); Edit Creative opens
 * the detailed studio on the same draft; every draft of the template is one click away.
 */
export function ReuseStudio({ templateId, onBack, onOpenRunInEditor, onOpenTemplate }: { templateId: string; onBack: () => void; onOpenRunInEditor: (runId: string) => Promise<void>; onOpenTemplate: (id: string) => void }) {
  const [mode, setMode] = useState<{ kind: 'simple' } | { kind: 'drafts' } | { kind: 'editor'; draftId: string; from: 'simple' | 'drafts' }>({ kind: 'simple' });
  if (mode.kind === 'simple') return <SimpleReuse templateId={templateId} onBack={onBack} onEdit={did => setMode({ kind: 'editor', draftId: did, from: 'simple' })} onAllDrafts={() => setMode({ kind: 'drafts' })} onOpenRunInEditor={onOpenRunInEditor} onOpenTemplate={onOpenTemplate} />;
  if (mode.kind === 'editor') return <ReuseEditor key={mode.draftId} templateId={templateId} draftId={mode.draftId} backLabel={mode.from === 'simple' ? 'Back to my creative' : 'Reuse drafts'} simple={mode.from === 'simple'} onClose={() => setMode(mode.from === 'simple' ? { kind: 'simple' } : { kind: 'drafts' })} onOpenRunInEditor={onOpenRunInEditor} onOpenTemplate={onOpenTemplate} />;
  return <ReuseDrafts templateId={templateId} onBack={() => setMode({ kind: 'simple' })} onOpen={did => setMode({ kind: 'editor', draftId: did, from: 'drafts' })} />;
}

/** Every reuse draft of a template, and a new detailed one. */
function ReuseDrafts({ templateId, onBack, onOpen }: { templateId: string; onBack: () => void; onOpen: (draftId: string) => void }) {
  const [drafts, setDrafts] = useState<ReuseDraftSummary[]>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => productApi.reuseDrafts(templateId).then(r => setDrafts(r.drafts)).catch((e: Error) => setError(e.message)), [templateId]);
  useEffect(() => { void load(); }, [load]);
  const start = async () => { setBusy(true); setError(''); try { const d = await productApi.createReuseDraft(templateId); onOpen(d.id); } catch (e) { setError(e instanceof Error ? e.message : 'Could not start.'); } finally { setBusy(false); } };
  return <div className="ot-page rts-page">
    <div className="ot-head"><div><button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />Create a New Creative</button>
      <p className="ot-kicker">Reuse Template</p><h2>Reuse this template</h2>
      <p>Choose which products appear, use your own product pictures, change the headline and offer, and make the creative in other sizes. The saved template is never changed.</p></div>
      <button type="button" className="ws-btn" disabled={busy} onClick={() => void start()}><Plus size={15} aria-hidden="true" />{busy ? 'Starting…' : 'Start a detailed reuse'}</button></div>
    {error && <Alert>{error}</Alert>}
    {!drafts ? <p className="ot-muted" role="status">Loading…</p> : !drafts.length ? <p className="ot-muted">No reuse drafts yet. Start one: it begins with every product of the template selected.</p>
      : <section aria-label="Reuse drafts"><h3>Your reuse drafts</h3><div className="ot-grid">{drafts.map(d => <article key={d.id} className="ot-card" aria-label={`Reuse draft ${d.name}`}>
        {d.preview ? <img src={productFileUrl(templateId, d.preview)} alt="" /> : <div className="rts-noimg">Not generated yet</div>}
        <div className="ot-card-body"><h3>{d.name}</h3><p className="ot-small ot-muted">{d.products} product{d.products === 1 ? '' : 's'} · {d.ratios.join(', ')} · {d.saved} saved · version {d.revision}</p>
          <button type="button" className="ws-btn ws-btn-primary" onClick={() => onOpen(d.id)}>Continue editing</button></div></article>)}</div></section>}
  </div>;
}

/** `simple`: opened as Customize Manually from Create Your Offer Creative — the poster, products, text and logos first; formats and placement modes under Advanced; saving and editing elements happen back in the simple flow. */
function ReuseEditor({ templateId, draftId, backLabel, onClose, onOpenRunInEditor, onOpenTemplate, simple = false }: { templateId: string; draftId: string; backLabel: string; onClose: () => void; onOpenRunInEditor: (runId: string) => Promise<void>; onOpenTemplate: (id: string) => void; simple?: boolean }) {
  const [view, setView] = useState<ReuseStudioView>(), [snapshot, setSnapshot] = useState<ProductSnapshot>(), [preview, setPreview] = useState<ReusePreview>();
  const [ratio, setRatio] = useState<ReuseAspectRatio>('original'), [busy, setBusy] = useState(''), [error, setError] = useState(''), [note, setNote] = useState('');
  const [selected, setSelected] = useState<Selected>(null), [emptyStage, setEmptyStage] = useState(false), [fontsRevision, setFontsRevision] = useState(0);
  const [aiConfirm, setAiConfirm] = useState(false), [copy, setCopy] = useState<Record<string, string>>({}), [addName, setAddName] = useState(''), [addCategory, setAddCategory] = useState('');
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(520);
  const draft = view?.draft;
  const refresh = useCallback(async (r: ReuseAspectRatio) => {
    const p = await productApi.reusePreview(templateId, draftId, r);
    await loadCreativeFonts(asInstance(p.creative)).catch(() => undefined);
    setPreview(p); setFontsRevision(n => n + 1);
  }, [templateId, draftId]);
  useEffect(() => { void productApi.reuseDraft(templateId, draftId).then(async v => {
    setView(v); setSnapshot(await productApi.snapshot(templateId, v.draft.templateRevision));
    const first = v.draft.ratios[0]; setRatio(first); await refresh(first);
  }).catch((e: Error) => setError(e.message)); }, [templateId, draftId, refresh]);
  const canvas = preview?.creative.canvas;
  useEffect(() => { const el = box.current; if (!el || !canvas) return; const aspect = canvas.width / canvas.height;
    const ro = new ResizeObserver(() => setWidth(Math.max(220, Math.min(760, el.clientWidth - 16, (window.innerHeight - 220) * aspect)))); ro.observe(el); return () => ro.disconnect(); }, [canvas]);
  const act = async (key: string, work: () => Promise<void>) => { setBusy(key); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(''); } };
  const apply = (d: ReuseDraft, r = ratio) => { setView(v => (v ? { ...v, draft: d } : v)); return refresh(d.ratios.includes(r) ? r : d.ratios[0]); };
  const change = (input: Omit<ReuseDraftChange, 'expectedRevision'>, key = 'change') => act(key, async () => {
    if (!draft) return;
    try { const d = await productApi.updateReuseDraft(templateId, draftId, { ...input, expectedRevision: draft.revision }); if (input.ratios && !input.ratios.includes(ratio)) setRatio(input.ratios[0]); await apply(d, input.ratios && !input.ratios.includes(ratio) ? input.ratios[0] : ratio); }
    // A refused change (another tab, a stale version): the saved draft again, so nothing shown is unsaved.
    catch (e) { const v = await productApi.reuseDraft(templateId, draftId).catch(() => undefined); if (v) setView(v); throw e; }
  });
  const send = (file: File | undefined, fields: { kind: 'product' | 'character' | 'logo'; target?: string; label?: string; category?: string }, key: string) => {
    if (!file || !draft) return;
    void act(key, async () => { const r = await productApi.reuseUpload(templateId, draftId, file, { ...fields, expectedRevision: draft.revision }, file.name); setNote(r.note ?? 'Picture added.'); await apply(r.draft); });
  };
  const products = useMemo(() => (draft?.items ?? []).filter(i => i.kind === 'product').sort((a, b) => a.order - b.order), [draft]);
  const characters = (draft?.items ?? []).filter(i => i.kind === 'character');
  if (!view || !draft || !snapshot) return <div className="ot-page">{error ? <Alert>{error}</Alert> : <p className="ot-muted" role="status">Loading the reuse studio…</p>}</div>;
  const active = products.filter(i => !i.removed), removed = products.filter(i => i.removed), included = active.filter(i => i.included);
  // Customize Manually lists the person's products (and any template product they brought back); the rest fold away.
  const shown = simple ? active.filter(i => !i.objectId || i.included) : active, folded = simple ? active.filter(i => i.objectId && !i.included) : [];
  const added = included.some(i => !i.objectId);
  const fix = draft.overrides[ratio] ?? {};
  const move = (s: NonNullable<Selected>, dx: number, dy: number) => {
    if (!preview) return;
    if (s.kind === 'object') { const o = preview.creative.objects.find(x => x.id === s.id); if (!o || o.kind === 'decoration') return; void change({ overrides: { [ratio]: { [`o:${o.id}`]: { x: Math.round(o.box.x + dx), y: Math.round(o.box.y + dy), width: Math.round(o.box.width), height: Math.round(o.box.height) } } } }, 'move'); }
    else if (s.kind === 'text') { const g = preview.creative.texts.find(t => t.id === s.id)?.groupId; if (g) void change({ overrides: { [ratio]: { [`g:${g}`]: { dx: (fix[`g:${g}`]?.dx ?? 0) + dx, dy: (fix[`g:${g}`]?.dy ?? 0) + dy } } } }, 'move'); }
    else if (s.kind === 'image') void change({ overrides: { [ratio]: { [`i:${s.id}`]: { dx: (fix[`i:${s.id}`]?.dx ?? 0) + dx, dy: (fix[`i:${s.id}`]?.dy ?? 0) + dy } } } }, 'move');
  };
  const resize = (k: number) => {
    const o = selected?.kind === 'object' ? preview?.creative.objects.find(x => x.id === selected.id) : undefined;
    if (!o || o.kind === 'decoration') return;
    const w = o.box.width * k, h = o.box.height * k;
    void change({ overrides: { [ratio]: { [`o:${o.id}`]: { x: Math.round(o.box.x + o.box.width / 2 - w / 2), y: Math.round(o.box.y + o.box.height - h), width: Math.round(w), height: Math.round(h) } } } }, 'move');
  };
  /** A change shown at once (the control answers the click), then saved; the preview follows. */
  const now = (patch: (d: ReuseDraft) => ReuseDraft) => setView(v => (v ? { ...v, draft: patch(v.draft) } : v));
  // Shown at once (the list answers the click), then saved; the preview follows.
  /** Corner handles: the object's new box in this format (its proportions kept). */
  const resizeTo = (s: NonNullable<Selected>, b: { x: number; y: number; width: number; height: number }) => { if (s.kind !== 'object') return; const o = preview?.creative.objects.find(x => x.id === s.id); if (!o || o.kind === 'decoration') return; void change({ overrides: { [ratio]: { [`o:${o.id}`]: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } } } }, 'move'); };
  const items = (list: { id: string; included?: boolean; hidden?: boolean; removed?: boolean; order?: number; restore?: boolean }[]) => {
    setView(v => (v ? { ...v, draft: { ...v.draft, items: v.draft.items.map(i => { const p = list.find(x => x.id === i.id); if (!p) return i; const { restore: _r, ...rest } = p; void _r; const n = { ...i, ...rest }; return n.removed ? { ...n, included: false } : n; }) } } : v));
    return change({ items: list });
  };
  const reorder = (i: ReuseItem, by: number) => { const order = active.map(x => x.id), k = order.indexOf(i.id), j = k + by; if (j < 0 || j >= order.length) return; [order[k], order[j]] = [order[j], order[k]]; void items(order.map((id, n) => ({ id, order: n + 1 }))); };
  const textEdit = (gid: string, patch: ReuseTextEdit) => { now(x => ({ ...x, texts: { ...x.texts, [gid]: { ...x.texts[gid], ...patch } } })); return change({ texts: { [gid]: { ...draft.texts[gid], ...patch } } }); };
  const objects = (preview?.creative.objects ?? []).filter(o => !o.hidden && !(emptyStage && (o.kind === 'product' || o.label.startsWith('Shadow')))).map(o => ({ id: o.id, url: productFileUrl(templateId, o.asset.file), box: o.box, z: o.z, label: o.label, opacity: o.opacity, locked: o.kind === 'decoration' }));
  const ratios = draft.ratios, aiCost = view.placement.offline ? 0 : Math.round(ratios.length * view.placement.costUsd * 100) / 100;
  const generated = ratios.filter(r => draft.outputs[r]?.draftRevision === draft.revision);
  const canSave = generated.length === ratios.length && ratios.every(r => draft.outputs[r]?.checks.status !== 'failed');
  const thumb = (i: ReuseItem) => productFileUrl(templateId, i.asset.file);
  const selectedObject = selected?.kind === 'object' ? preview?.creative.objects.find(o => o.id === selected.id) : undefined;
  return <div className="ot-page rts-page">
    {simple ? <div className="ot-head rts-simple-head"><div><button type="button" className="ws-btn ws-btn-quiet" onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />{backLabel}</button>
      <h2>Customize Manually</h2><p>Click a product on the poster to select it, then drag it to move or pull a corner to resize. Edit the text and logos on the right. Changes are saved as you go.</p></div>
      <div className="rts-simple-actions"><span className="ot-muted ot-small" role="status">{busy ? 'Saving…' : 'All changes saved'}</span><button type="button" className="ws-btn ws-btn-primary ws-btn-large" onClick={onClose}>Done — show my creative</button></div></div>
      : <div className="ot-head"><div><button type="button" className="ws-btn ws-btn-quiet" onClick={onClose}><ArrowLeft size={14} aria-hidden="true" />{backLabel}</button>
      <p className="ot-kicker">Reuse Template · from version {draft.templateRevision} of the template (never changed)</p>
      <label className="ot-field rts-name"><span className="ot-sr">Draft name</span><input aria-label="Draft name" value={draft.name} maxLength={120} onChange={e => setView({ ...view, draft: { ...draft, name: e.target.value } })} onBlur={e => void change({ name: e.target.value })} /></label></div>
      <p className="ot-muted ot-small">Draft version {draft.revision}{busy ? ' · saving…' : ' · saved'}</p></div>}
    {error && <Alert>{error}</Alert>}
    {view.sourceIssues.length > 0 && <Alert>This template version needs repair before it can be reused: {view.sourceIssues.join(' ')}</Alert>}
    {note && <p className="prt-note" role="status">{note}</p>}
    <div className="rts-layout">
      <aside className="prt-pane rts-products" aria-label="Products">
        <div className="rts-head"><h3>{simple ? 'Your products' : 'Products'}</h3><span className="ot-small ot-muted">{included.length} of {shown.length} selected</span></div>
        <div className="ot-row"><button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void items(active.map(i => ({ id: i.id, included: true })))}>Select all</button>
          <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void items(active.map(i => ({ id: i.id, included: false })))}>Deselect all</button>
          <label className="ot-check"><input type="checkbox" checked={emptyStage} onChange={e => setEmptyStage(e.target.checked)} /> Show the empty stage</label></div>
        <ul className="rts-list" aria-label="Product list">{shown.map((i, n) => <li key={i.id} className={`${i.included ? '' : 'is-off'}${selected?.id === i.id ? ' is-selected' : ''}`} aria-label={`Product ${i.label}`}>
          <input type="checkbox" checked={i.included} aria-label={`Include ${i.label}`} disabled={!!busy} onChange={e => void items([{ id: i.id, included: e.target.checked }])} />
          <img src={thumb(i)} alt="" />
          <span className="rts-item-name"><strong>{i.label}</strong><span className="ot-small ot-muted">{i.category}{i.asset.kind === 'upload' ? ' · your picture' : !i.objectId ? '' : ' · template'}{!i.objectId ? ' · added' : ''}</span></span>
          <span className="rts-item-actions">
            <button type="button" className="ws-icon-button" aria-label={i.hidden ? `Show ${i.label}` : `Hide ${i.label}`} disabled={!!busy} onClick={() => void items([{ id: i.id, hidden: !i.hidden }])}>{i.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <button type="button" className="ws-icon-button" aria-label={`Move ${i.label} up`} disabled={!!busy || n === 0} onClick={() => reorder(i, -1)}><ArrowUp size={14} /></button>
            <button type="button" className="ws-icon-button" aria-label={`Move ${i.label} down`} disabled={!!busy || n === shown.length - 1} onClick={() => reorder(i, 1)}><ArrowDown size={14} /></button>
            <label className="ws-icon-button prt-file" aria-label={`Replace ${i.label}`} title="Replace with your picture"><ImagePlus size={14} /><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${i.label} with a picture`} onChange={e => send(e.target.files?.[0], { kind: 'product', target: i.id, label: i.label, category: i.category }, `replace-${i.id}`)} /></label>
            {i.objectId && i.asset.kind === 'upload' && <button type="button" className="ws-icon-button" aria-label={`Restore the original ${i.original?.label ?? i.label}`} title="Restore the template’s picture" disabled={!!busy} onClick={() => void items([{ id: i.id, restore: true }])}><RotateCcw size={14} /></button>}
            <button type="button" className="ws-icon-button" aria-label={`Remove ${i.label}`} title="Remove from this draft" disabled={!!busy} onClick={() => void items([{ id: i.id, removed: true }])}><Trash2 size={14} /></button>
            <button type="button" className="ws-btn ws-btn-quiet prt-inline" disabled={!i.included} onClick={() => setSelected({ kind: 'object', id: i.id })}>Edit placement</button>
          </span></li>)}</ul>
        {folded.length > 0 && <details className="rts-advanced"><summary>The template’s own products ({folded.length})</summary><ul className="rts-list">{folded.map(i => <li key={i.id} className="is-off">
          <input type="checkbox" checked={false} aria-label={`Include ${i.label}`} disabled={!!busy} onChange={() => void items([{ id: i.id, included: true }])} /><img src={thumb(i)} alt="" /><span className="rts-item-name"><strong>{i.label}</strong><span className="ot-small ot-muted">left out of your creative</span></span></li>)}</ul></details>}
        <div className="rts-add" aria-label="Add a product"><h4><Plus size={14} aria-hidden="true" />Add Product</h4>
          <label className="ot-field"><span>Name</span><input value={addName} maxLength={60} placeholder="e.g. Dishwasher" onChange={e => setAddName(e.target.value)} aria-label="New product name" /></label>
          <label className="ot-field"><span>Kind of product</span><select value={addCategory} aria-label="New product kind" onChange={e => setAddCategory(e.target.value)}><option value="">From its name</option>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="ws-btn ws-btn-primary prt-file"><ImagePlus size={14} aria-hidden="true" />{busy === 'add' ? 'Adding…' : '+ Add Product'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Add a product picture" onChange={e => { const f = e.target.files?.[0]; send(f, { kind: 'product', label: addName.trim() || undefined, category: addCategory || undefined }, 'add'); setAddName(''); setAddCategory(''); }} /></label>
          <p className="ot-muted ot-small">A PNG with transparency gives the cleanest cut-out; a plain backdrop is removed on this computer. Your product’s pixels are never redrawn.</p></div>
        {removed.length > 0 && <section aria-label="Removed products"><h4>Removed from this draft</h4><ul className="rts-list">{removed.map(i => <li key={i.id} className="is-off"><img src={thumb(i)} alt="" /><span className="rts-item-name">{i.label}</span>
          <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void items([{ id: i.id, removed: false, included: true }])}><RotateCcw size={14} aria-hidden="true" />Restore</button></li>)}</ul></section>}
        {characters.length > 0 && <section aria-label="Characters"><h4>Characters</h4><ul className="rts-list">{characters.map(i => <li key={i.id} className={i.included ? '' : 'is-off'}>
          <input type="checkbox" checked={i.included && !i.removed} aria-label={`Include ${i.label}`} onChange={e => void items([{ id: i.id, included: e.target.checked, removed: false }])} /><img src={thumb(i)} alt="" /><span className="rts-item-name"><strong>{i.label}</strong><span className="ot-small ot-muted">{i.asset.kind === 'upload' ? 'your picture' : 'the template’s own picture, kept exactly'}</span></span>
          <span className="rts-item-actions"><label className="ws-icon-button prt-file" aria-label={`Replace ${i.label}`}><ImagePlus size={14} /><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${i.label} with a picture`} onChange={e => send(e.target.files?.[0], { kind: 'character', target: i.id }, `replace-${i.id}`)} /></label>
            {i.asset.kind === 'upload' && <button type="button" className="ws-icon-button" aria-label={`Restore the original ${i.label}`} onClick={() => void items([{ id: i.id, restore: true }])}><RotateCcw size={14} /></button>}</span></li>)}</ul></section>}
      </aside>
      <section className="prt-pane rts-stage" ref={box} aria-label="Creative preview">
        <div className="prt-seg rts-tabs" role="tablist" aria-label="Formats">{ratios.map(r => { const f = view.formats.find(x => x.ratio === r)!; return <button key={r} type="button" role="tab" aria-selected={ratio === r} onClick={() => { setRatio(r); setSelected(null); void refresh(r); }}>{f.label}<span className="ot-small"> {f.canvas.width}×{f.canvas.height}</span></button>; })}</div>
        {preview && preview.ratio === ratio ? <>
          <CreativeCanvas snapshot={asSnapshot(snapshot, preview.creative)} creative={asInstance(preview.creative)} fontsRevision={fontsRevision} width={width} selected={selected} onSelect={setSelected} onMove={move} onResize={resizeTo} objects={objects} absoluteZOrder={preview.creative.absoluteZOrder} backgroundZ={preview.creative.backgroundSource?.z} canvasFill={preview.creative.canvasFill} />
          <p className="ot-muted ot-small">Products: {PLACEMENT_LABEL[preview.mode]}. Drag anything to correct it in this format{Object.keys(fix).length ? ` (${Object.keys(fix).length} correction${Object.keys(fix).length === 1 ? '' : 's'})` : ''}.{preview.frame.note ? ` ${preview.frame.note}` : ''}</p>
          {selectedObject && selectedObject.kind !== 'decoration' && <div className="ot-row" aria-label="Selected element"><strong className="ot-small">{selectedObject.label}</strong>
            <button type="button" className="ws-btn ws-btn-quiet" onClick={() => resize(0.9)}>Size −</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => resize(1.1)}>Size +</button>
            {fix[`o:${selectedObject.id}`] && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void change({ overrides: { [ratio]: { [`o:${selectedObject.id}`]: null } } })}>Reset</button>}
            <span className="ot-muted ot-small">Drag to move · corner handles resize</span></div>}
          {Object.keys(fix).length > 0 && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void change({ overrides: { [ratio]: null } })}><RotateCcw size={14} aria-hidden="true" />Reset this format’s corrections</button>}
          {(() => { const list = <ul className="prt-var-issues" aria-label="Checks of this format">{preview.checks.issues.map((i, k) => <li key={k} className={i.blocking ? 'is-blocking' : ''}><span className="ot-chip">{PRODUCT_CHECK_KIND[i.code] === 'automatic' ? 'Automatic' : PRODUCT_CHECK_KIND[i.code] === 'visual' ? 'Picture' : 'Your eyes'}</span> {i.message}</li>)}</ul>;
            return simple ? (preview.checks.issues.length > 0 && <details className="sr-more"><summary>Notes on this creative ({preview.checks.issues.length})</summary>{list}</details>) : list; })()}
        </> : <p className="ot-muted" role="status">Composing…</p>}
      </section>
      <aside className="prt-pane rts-side" aria-label="Formats, text and placement">
        {(() => { const advanced = <><section aria-label="Formats"><h3>Formats</h3>{view.formats.map(f => <label key={f.ratio} className="prt-option"><input type="checkbox" checked={ratios.includes(f.ratio)} disabled={!!busy} aria-label={`Format ${f.label}`}
          onChange={e => { const next = REUSE_ASPECT_RATIOS.filter(r => (r === f.ratio ? e.target.checked : ratios.includes(r))); if (!next.length) return; now(x => ({ ...x, ratios: next })); void change({ ratios: next }); }} /><span><strong>{f.label}</strong>{f.canvas.width} × {f.canvas.height} px{f.method === 'slice' ? ' · the artwork’s middle at its own size' : f.method === 'mirror-extend' ? ' · sides continued from its own artwork (check them)' : ''}</span></label>)}</section>
        <section aria-label="Product placement"><h3>Product placement</h3>
          {(['original', 'geometry', 'ai'] as const).map(m => <label key={m} className="prt-option"><input type="radio" name="placement" checked={draft.placement.mode === m} disabled={!!busy || (m === 'original' && added) || (m === 'ai' && !Object.keys(draft.ai.plans).length)} onChange={() => { now(x => ({ ...x, placement: { ...x.placement, mode: m } })); void change({ placement: { mode: m } }); }} />
            <span><strong>{m === 'original' ? 'Keep the template’s places' : m === 'geometry' ? 'Arrange on this computer' : 'AI Smart Placement'}</strong>{m === 'original' ? (added ? 'Not with an added product.' : 'Each product where it was (original size only).') : m === 'geometry' ? 'Free. Fixed rules: believable sizes, the tallest in the middle, rows in depth for many.' : Object.keys(draft.ai.plans).length ? `Plans for ${Object.keys(draft.ai.plans).join(', ')}.` : 'Run it below first.'}</span></label>)}
          {view.placement.ai ? (aiConfirm ? <div className="prt-confirm" role="group" aria-label="Confirm AI placement"><p>Send {ratios.length} request{ratios.length === 1 ? '' : 's'} (one per format) to <strong>{view.placement.model}</strong>{view.placement.offline ? ' (test planner: no network, free)' : `, about $${aiCost.toFixed(2)}`}? It sees the composition without products and proposes where they stand; every box is checked before it is used. Nothing is retried.</p>
            <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={!!busy} onClick={() => { setAiConfirm(false); void act('ai', async () => { await apply(await productApi.reusePlaceWithAi(templateId, draftId, { approveUsd: aiCost })); }); }}>{aiCost ? `Yes, spend $${aiCost.toFixed(2)}` : 'Yes, place with AI'}</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setAiConfirm(false)}>Cancel</button></div></div>
            : <button type="button" className="ws-btn" disabled={!!busy || view.sourceIssues.length > 0 || !included.length} onClick={() => setAiConfirm(true)}><Sparkles size={14} aria-hidden="true" />{busy === 'ai' ? 'Placing…' : 'Arrange with AI…'}</button>)
            : <p className="ot-muted ot-small">AI placement is not configured on this server; products are arranged on this computer (free).</p>}
          {draft.ai.requests > 0 && <p className="ot-muted ot-small">AI placement requests: {draft.ai.requests} (estimate ${draft.ai.costUsd.toFixed(2)}, not a billed amount).{draft.ai.failures.length ? ` Last failure: ${draft.ai.failures.at(-1)!.message}` : ''}</p>}
          {draft.placement.mode === 'original' && <label className="ot-check"><input type="checkbox" checked={draft.placement.keepStands} onChange={e => { const keepStands = e.target.checked; now(x => ({ ...x, placement: { ...x.placement, keepStands } })); void change({ placement: { keepStands } }); }} /> Keep the display stands (stand layers)</label>}
        </section></>;
          return simple ? <details className="rts-advanced"><summary>Advanced settings (sizes, arrangement)</summary>{advanced}</details> : advanced; })()}
        <section aria-label="Text"><h3>Text</h3>{view.texts.map(t => { const e = draft.texts[t.groupId] ?? {}, family = e.fontFamily ?? t.style?.fontFamily ?? OFFER_FONT_FAMILIES[0];
          return <div key={t.groupId} className="rts-text" aria-label={`Text ${t.label}`}><div className="ot-row"><strong className="ot-small">{t.category}</strong><label className="ot-check"><input type="checkbox" checked={!e.hidden} aria-label={`Show ${t.label}`} onChange={ev => void textEdit(t.groupId, { hidden: !ev.target.checked })} /> Show</label></div>
            <textarea rows={2} maxLength={400} value={copy[t.groupId] ?? e.text ?? t.text} aria-label={`${t.category} text`} onChange={ev => setCopy(c => ({ ...c, [t.groupId]: ev.target.value }))} />
            {copy[t.groupId] !== undefined && copy[t.groupId] !== (e.text ?? t.text) && <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={() => { const text = copy[t.groupId]; setCopy(c => { const n = { ...c }; delete n[t.groupId]; return n; }); void textEdit(t.groupId, { text }); }}>Apply text</button>
              <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setCopy(c => { const n = { ...c }; delete n[t.groupId]; return n; })}>Cancel</button></div>}
            <div className="rts-text-style">
              <select aria-label={`Font of ${t.label}`} value={family} onChange={ev => void textEdit(t.groupId, { fontFamily: ev.target.value, fontWeight: offerWeights(ev.target.value).includes((e.fontWeight ?? t.style?.fontWeight ?? 400) as never) ? e.fontWeight ?? t.style?.fontWeight : offerWeights(ev.target.value)[0] })}>{OFFER_FONT_FAMILIES.map(f => <option key={f}>{f}</option>)}</select>
              <select aria-label={`Weight of ${t.label}`} value={e.fontWeight ?? t.style?.fontWeight ?? 400} onChange={ev => void textEdit(t.groupId, { fontFamily: family, fontWeight: Number(ev.target.value) })}>{offerWeights(family).map(w => <option key={w} value={w}>{w === 700 ? 'Bold' : w === 600 ? 'Semi-bold' : 'Regular'}</option>)}</select>
              <input type="color" aria-label={`Colour of ${t.label}`} value={e.color ?? t.style?.color ?? '#111111'} onChange={ev => void textEdit(t.groupId, { color: ev.target.value })} />
              <select aria-label={`Size of ${t.label}`} value={e.scale ?? 1} onChange={ev => void textEdit(t.groupId, { scale: Number(ev.target.value) })}>{[0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5].map(k => <option key={k} value={k}>{Math.round(k * 100)} %</option>)}</select>
              <select aria-label={`Alignment of ${t.label}`} value={e.align ?? ''} onChange={ev => void textEdit(t.groupId, { align: (ev.target.value || undefined) as ReuseTextEdit['align'] })}><option value="">As in the template</option><option value="left">Left</option><option value="center">Centre</option></select>
              {draft.texts[t.groupId] && <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={() => void change({ texts: { [t.groupId]: null } })}>Keep the template’s</button>}
            </div></div>; })}
          <p className="ot-muted ot-small">Only type offers, prices, cashback, EMI terms and dates you are allowed to use. FrameFlow never writes them for you.</p></section>
        <section aria-label="Logos"><h3>Logos</h3><ul className="rts-list">{view.logos.map(l => { const e = draft.logos[l.id] ?? {}; return <li key={l.id} className={e.hidden ? 'is-off' : ''}><img src={productFileUrl(templateId, e.asset?.file ?? l.file)} alt="" /><span className="rts-item-name">{l.label}</span>
          <span className="rts-item-actions"><button type="button" className="ws-icon-button" aria-label={e.hidden ? `Show ${l.label}` : `Hide ${l.label}`} onClick={() => { now(x => ({ ...x, logos: { ...x.logos, [l.id]: { ...x.logos[l.id], hidden: !e.hidden } } })); void change({ logos: { [l.id]: { hidden: !e.hidden } } }); }}>{e.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
            <label className="ws-icon-button prt-file" aria-label={`Replace ${l.label}`}><ImagePlus size={14} /><input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${l.label} with a picture`} onChange={ev => send(ev.target.files?.[0], { kind: 'logo', target: l.id }, `logo-${l.id}`)} /></label>
            {e.asset && <button type="button" className="ws-icon-button" aria-label={`Restore ${l.label}`} onClick={() => void change({ logos: { [l.id]: { restore: true } } })}><RotateCcw size={14} /></button>}</span></li>; })}</ul></section>
      </aside>
    </div>
    {!simple && <section className="ts-card rts-results" aria-label="Reused creatives"><div className="ts-card-body">
      <div className="ot-row"><h3>Complete creatives</h3>
        <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={!!busy || view.sourceIssues.length > 0} onClick={() => void act('generate', async () => { const d = await productApi.reuseGenerate(templateId, draftId); setView(v => (v ? { ...v, draft: d } : v)); })}><Wand2 size={15} aria-hidden="true" />{busy === 'generate' ? 'Generating…' : 'Generate Reused Creative'}</button>
        <button type="button" className="ws-btn" disabled={!!busy || !canSave} title={canSave ? 'Save every format as a creative of this template' : 'Generate every format first; formats with failed checks cannot be saved'} onClick={() => void act('save', async () => { const d = await productApi.reuseSave(templateId, draftId); setView(v => (v ? { ...v, draft: d } : v)); setNote('Saved. Each format is now a creative of this template.'); })}><Save size={15} aria-hidden="true" />{busy === 'save' ? 'Saving…' : 'Save reused creatives'}</button></div>
      <p className="ot-muted">Free, on this computer: the template’s background, character, decorations, logos and your products composed for each format; every word, logo and product stays its own layer.</p>
      <div className="ot-grid is-wide">{ratios.map(r => { const o = draft.outputs[r], f = view.formats.find(x => x.ratio === r)!, stale = o && o.draftRevision !== draft.revision;
        return <article key={r} className="ot-card" aria-label={`Creative ${f.label}`} data-status={o?.checks.status}>
          {o ? <img src={productFileUrl(templateId, o.preview)} alt={`${f.label} creative`} /> : <div className="rts-noimg">Not generated yet</div>}
          <div className="ot-card-body"><div className="ot-row"><h3>{f.label}</h3><span className="ot-small ot-muted">{f.canvas.width} × {f.canvas.height}</span>
            {o && <Badge tone={o.checks.status === 'ready' ? 'ok' : o.checks.status === 'failed' ? 'danger' : 'warn'}>{o.checks.status === 'ready' ? 'Checks passed' : o.checks.status === 'failed' ? 'Failed checks' : 'Needs a look'}</Badge>}
            {stale && <Badge tone="warn">Changed since generated</Badge>}{o?.creativeId && <Badge tone="ok">Saved{o.savedDraftRevision !== draft.revision ? ' (older version)' : ''}</Badge>}</div>
            {o && <ul className="prt-var-issues">{o.checks.issues.filter(i => i.blocking).concat(o.checks.issues.filter(i => !i.blocking)).slice(0, 3).map((i, k) => <li key={k} className={i.blocking ? 'is-blocking' : ''}>{i.message}</li>)}</ul>}
            {o?.creativeId && <div className="ot-row">
              <button type="button" className="ws-btn ws-btn-primary" disabled={!!busy} title="Review it, approve OpenAI + Seedream decomposition separately, then inspect and edit" onClick={() => void act(`dec-${r}`, async () => { const x = await productApi.reuseDecompose(templateId, draftId, r); onOpenTemplate(x.templateId); })}><Layers3 size={14} aria-hidden="true" />{busy === `dec-${r}` ? 'Opening…' : 'Decompose & Edit'}</button>
              <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void act(`open-${r}`, async () => { const x = await productApi.reuseOpen(templateId, draftId, r); await onOpenRunInEditor(x.runId); })}>Open in editor (its own layers, free)</button></div>}
          </div></article>; })}</div>
    </div></section>}
  </div>;
}
