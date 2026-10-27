/**
 * A saved Product with Text template, reused. Creatives: swap a product or character into its slot (its background is
 * removed on this computer when it is a plain colour), edit the text and logos, move things, save (each save a new
 * revision of the creative) and open it in the editor with every element its own layer. Variations: 3–5 creatives made
 * from the template's structure in one go, kept only when saved.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Eye, EyeOff, FileText, ImagePlus, Layers3, Plus, RefreshCw, RotateCcw, Save, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { ProductDetails } from './ProductDetails';
import {
  MASTER_CATEGORY_LABELS, PRODUCT_ASPECT_LABELS, PRODUCT_CHECK_KIND, PRODUCT_KIND_LABELS, PRODUCT_VARIATION_LABELS, rewriteGroup, type CreativeInstance, type MasterSnapshot, type ProductAspectRatio, type ProductCreative, type ProductSnapshot, type ProductVariationKind,
} from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { CreativeCanvas, type Selected } from '../masterTemplates/CreativeCanvas';
import { loadCreativeFonts, measureAdvance } from '../masterTemplates/creativeText';
import { productApi, productFileUrl, type CreativeListItem, type GenerationState, type ProductView, type TemplateBrief, type VariationJob, type VariationOptions, type VariationResult } from './api';

const hex10 = () => Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('');
/** The creative as the Text & Graphics canvas and text tools read one (its objects are drawn separately). */
export const asInstance = (c: ProductCreative) => ({ ...c, schemaVersion: 1, masterId: c.templateId, masterRevision: c.templateRevision, origin: { kind: 'master' }, editor: null, exports: [], history: [] }) as unknown as CreativeInstance;
/** The snapshot as the canvas reads one; a creative with a background of its own (another aspect ratio or style) draws that. */
export const asSnapshot = (s: ProductSnapshot, c?: ProductCreative) => ({ schemaVersion: 1, masterId: s.templateId, revision: s.revision, publishedAt: s.publishedAt, name: s.name, canvas: c?.canvas ?? s.canvas, source: s.source,
  background: { file: c?.background?.file ?? s.base.file, sha256: c?.background?.sha256 ?? s.base.sha256, width: (c?.canvas ?? s.canvas).width, height: (c?.canvas ?? s.canvas).height, method: 'local-fill', reliability: 'uncertain', acknowledgedEstimate: true }, layers: [], decomposition: null,
  words: s.words, groups: s.groups, logoSlots: s.logoSlots, plates: s.plates, analysisRevision: 0 }) as unknown as MasterSnapshot;

export function ProductTemplatePage({ id, initialTab, onBack, onEditTemplate, onOpenRunInEditor, onOpenRun, onOpenTemplate, onChangeSelection }: { onOpenRun?: (runId: string) => Promise<void>; id: string; initialTab?: 'creatives' | 'variations' | 'details'; onBack: () => void; onEditTemplate: () => void; onOpenRunInEditor: (runId: string) => Promise<void>;
  /** A variation's own template ("Decompose & Edit"), opened at its steps; the choice of what is decomposed. */ onOpenTemplate?: (id: string) => void; onChangeSelection?: () => void }) {
  const [view, setView] = useState<ProductView>(), [tab, setTab] = useState<'creatives' | 'variations' | 'details'>(initialTab ?? 'creatives'), [error, setError] = useState('');
  const [list, setList] = useState<CreativeListItem[]>([]), [current, setCurrent] = useState<string>();
  const [selectedRevision, setSelectedRevision] = useState<number>();
  const refresh = useCallback(async () => { const r = await productApi.creatives(id); setList(r.creatives); return r.creatives; }, [id]);
  useEffect(() => { void Promise.all([productApi.get(id).then(setView), productApi.creatives(id).then(r => { setList(r.creatives); setCurrent(cur => cur ?? r.creatives[0]?.id); })]).catch((e: Error) => setError(e.message)); }, [id, refresh]);
  const latest = view?.product.revisions.at(-1);
  const revision = selectedRevision ?? latest?.revision;
  const create = async () => { setError(''); try { const c = await productApi.createCreative(id, { revision }); await refresh(); setCurrent(c.id); setTab('creatives'); } catch (e) { setError(e instanceof Error ? e.message : 'Could not make a creative.'); } };
  const open = async (cid: string) => { const r = await productApi.openCreative(id, cid); await onOpenRunInEditor(r.runId); };
  if (!view) return <div className="ot-page">{error ? <Alert>{error}</Alert> : <p className="ot-muted" role="status">Loading…</p>}</div>;
  return <div className="ot-page prt-page-wide">
    <div className="ot-head"><div><p className="ot-kicker">Product template · version {latest?.revision ?? '–'}</p><h2>{view.template.name}</h2>
      <p>Swap products and characters, change the offer, and make variations. Your template and its saved versions are never changed.</p></div>
      <div className="ot-row"><button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={14} aria-hidden="true" />Templates</button><button type="button" className="ws-btn" onClick={onEditTemplate}>Edit template</button></div></div>
    {error && <Alert>{error}</Alert>}
    {!latest ? <Alert tone="warn">This template is not saved yet. Finish its setup first.</Alert> : <>
      <label className="ot-field"><span>Master revision for new creatives and variations</span><select value={revision} onChange={e => setSelectedRevision(Number(e.target.value))}>
        {[...view.product.revisions].reverse().map(r => <option key={r.revision} value={r.revision}>Revision {r.revision}{r.draft ? ' · draft, quality review retained' : ' · approved'}</option>)}
      </select></label>
      <div className="prt-tabs" role="tablist" aria-label="Use the template">
        <button type="button" role="tab" aria-selected={tab === 'creatives'} className="prt-tab" onClick={() => setTab('creatives')}><Layers3 size={14} aria-hidden="true" />Creatives</button>
        <button type="button" role="tab" aria-selected={tab === 'variations'} className="prt-tab" onClick={() => setTab('variations')}><Sparkles size={14} aria-hidden="true" />Generate with AI</button>
        <button type="button" role="tab" aria-selected={tab === 'details'} className="prt-tab" onClick={() => setTab('details')}><FileText size={14} aria-hidden="true" />Template details</button>
      </div>
      {tab === 'creatives' ? (!list.length ? <section className="ts-card"><div className="ts-card-body" style={{ justifyItems: 'start' }}><h3>Make your first creative</h3>
        <p className="ot-muted">A creative starts as an exact copy of the template, with every product, character, text and logo ready to change.</p>
        <button type="button" className="ws-btn ws-btn-primary ws-btn-large" onClick={() => void create()}><Plus size={15} aria-hidden="true" />New creative</button></div></section>
        : <div className="prt-reuse">
          <aside className="prt-pane prt-list" aria-label="Creatives"><section><h3>Creatives<span className="ot-chip">{list.length}</span></h3>
            <ul className="ot-list">{list.map(c => <li key={c.id}><button type="button" className="ot-item" aria-pressed={c.id === current} onClick={() => setCurrent(c.id)}>
              <span className="ot-dot is-approved" aria-hidden="true" /><span>{c.name}<span className="prt-reason">{c.variation ? `Variation · ${c.variation.title}` : c.replaced ? `${c.replaced} replaced` : 'As the template'} · version {c.revision}</span></span><span /></button></li>)}</ul>
            <button type="button" className="ws-btn" onClick={() => void create()}><Plus size={14} aria-hidden="true" />New creative</button></section></aside>
          {current && <CreativeEditor key={current} templateId={id} creativeId={current} onChanged={() => void refresh()} onDecompose={onOpenRun ? async cid => { const r = await productApi.openCreative(id, cid); await onOpenRun(r.runId); } : undefined} onOpen={open} onError={setError} onCopied={async c => { await refresh(); setCurrent(c); }} />}
        </div>)
        : tab === 'details' ? <ProductDetails view={view} onChanged={setView} onChangeSelection={onChangeSelection ?? onEditTemplate} />
        : <Variations key={`${id}-${revision}`} templateId={id} revision={revision!} onRepairSource={onEditTemplate} onOpen={async cid => { await refresh(); await open(cid); }} onSaved={async cid => { await refresh(); setCurrent(cid); }} onDecompose={onOpenRun} onDecomposeTemplate={onOpenTemplate} onError={setError} />}
    </>}
  </div>;
}

/** One creative: its preview (drag to move), its slots, text and logos; Save makes a new revision. */
function CreativeEditor({ templateId, creativeId, onChanged, onOpen, onError, onCopied, onDecompose }: { onDecompose?: (cid: string) => Promise<void>; templateId: string; creativeId: string; onChanged: () => void; onOpen: (cid: string) => Promise<void>; onError: (m: string) => void; onCopied: (cid: string) => Promise<void> }) {
  const [creative, setCreative] = useState<ProductCreative>(), [snapshot, setSnapshot] = useState<ProductSnapshot>(), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(''), [note, setNote] = useState('');
  const [selected, setSelected] = useState<Selected>(null), [fontsRevision, setFontsRevision] = useState(0), [copy, setCopy] = useState<Record<string, string>>({});
  const box = useRef<HTMLDivElement>(null), [width, setWidth] = useState(560);
  useEffect(() => { void productApi.getCreative(templateId, creativeId).then(async c => { setCreative(c); setSnapshot(await productApi.snapshot(templateId, c.templateRevision)); }).catch((e: Error) => onError(e.message)); }, [templateId, creativeId, onError]);
  // As wide as the pane, and short enough to see whole.
  const canvasWidth = (creative?.canvas ?? snapshot?.canvas)?.width, canvasHeight = (creative?.canvas ?? snapshot?.canvas)?.height;
  useEffect(() => { const el = box.current; if (!el || !canvasWidth || !canvasHeight) return; const aspect = canvasWidth / canvasHeight;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, Math.min(720, el.clientWidth - 24, (window.innerHeight - 260) * aspect)))); ro.observe(el); return () => ro.disconnect(); }, [canvasWidth, canvasHeight]);
  const fontKey = creative ? JSON.stringify([...new Set(creative.texts.map(t => `${t.style.fontFamily}:${t.style.fontWeight}:${t.style.fontStyle}`))]) : '';
  useEffect(() => { if (!creative) return; let live = true; void loadCreativeFonts(creative).then(() => { if (live) setFontsRevision(r => r + 1); }); return () => { live = false; }; // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontKey]);
  const groups = useMemo(() => creative ? creative.groups.map(g => ({ g, text: [...new Set(creative.texts.filter(t => t.groupId === g.id).map(t => t.line))].sort((a, b) => a - b).map(l => creative.texts.filter(t => t.groupId === g.id && t.line === l).sort((a, b) => a.order - b.order).map(t => t.text).join(' ')).join('\n') })).filter(x => x.text) : [], [creative]);
  if (!creative || !snapshot) return <p className="ot-muted" role="status">Loading the creative…</p>;
  const update = (c: ProductCreative) => { setCreative(c); setDirty(true); };
  const save = async (): Promise<ProductCreative | undefined> => {
    setBusy('saving'); onError('');
    try { const saved = await productApi.saveCreative(templateId, creativeId, { expectedRevision: creative.revision, creative }); setCreative(saved); setDirty(false); onChanged(); return saved; }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not save.'); return undefined; }
    finally { setBusy(''); }
  };
  const replace = async (objectId: string, file?: File) => {
    if (!file) return;
    if (dirty && !(await save())) return;
    setBusy(objectId); setNote(''); onError('');
    try {
      const latest = dirty ? await productApi.getCreative(templateId, creativeId) : creative;
      const r = await productApi.replace(templateId, creativeId, objectId, file, latest.revision);
      setCreative(r.creative); setDirty(false); onChanged();
      setNote(r.cutout.background === 'removed' ? 'Its plain background was removed, and it was fitted to the slot.' : r.cutout.background === 'transparent' ? 'Placed in the slot (its own transparency kept).' : r.cutout.note ?? 'Placed in the slot.');
    } catch (e) { onError(e instanceof Error ? e.message : 'Could not replace it.'); }
    finally { setBusy(''); }
  };
  const restore = async (objectId: string) => {
    if (dirty && !(await save())) return;
    setBusy(objectId);
    try { const latest = await productApi.getCreative(templateId, creativeId); setCreative(await productApi.restore(templateId, creativeId, objectId, latest.revision)); setDirty(false); onChanged(); setNote('The template’s own picture is back.'); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not restore it.'); }
    finally { setBusy(''); }
  };
  const replaceLogo = async (imageId: string, file?: File) => {
    if (!file) return;
    try { const { asset } = await productApi.uploadAsset(templateId, creativeId, file); update({ ...creative, images: creative.images.map(i => (i.id === imageId ? { ...i, asset } : i)) }); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not use that picture.'); }
  };
  const move = (s: NonNullable<Selected>, dx: number, dy: number) => {
    if (s.kind === 'object') update({ ...creative, objects: creative.objects.map(o => (o.id === s.id ? { ...o, box: { ...o.box, x: Math.round(o.box.x + dx), y: Math.round(o.box.y + dy) } } : o)) });
    else if (s.kind === 'text') { const g = creative.texts.find(t => t.id === s.id)?.groupId; update({ ...creative, texts: creative.texts.map(t => (t.groupId === g ? { ...t, x: t.x + dx, baselineY: t.baselineY + dy } : t)) }); }
    else if (s.kind === 'image') update({ ...creative, images: creative.images.map(i => (i.id === s.id ? { ...i, box: { ...i.box, x: i.box.x + dx, y: i.box.y + dy } } : i)) });
  };
  const applyCopy = (groupId: string) => { const text = copy[groupId]; if (text === undefined) return; const r = rewriteGroup(asInstance(creative), groupId, text, measureAdvance, { newId: () => `ct-${hex10()}` }); update({ ...creative, texts: r.texts, shapes: r.shapes }); setCopy(c => { const n = { ...c }; delete n[groupId]; return n; }); if (r.warnings.length) setNote(r.warnings.join(' ')); };
  const objects = creative.objects.filter(o => !o.hidden).map(o => ({ id: o.id, url: productFileUrl(templateId, o.asset.file), box: o.box, z: o.z, label: o.label, opacity: o.opacity, locked: o.locked }));
  const slots = creative.objects.filter(o => o.kind === 'product' || o.kind === 'character' || o.kind === 'brand-logo');
  // Display stands (what the products stand on): layers of their own, shown, hidden or dragged like the rest.
  const stands = creative.objects.filter(o => o.kind === 'podium');
  return <div className="prt-reuse-main">
    <section className="prt-pane prt-stage" ref={box} aria-label="Creative preview">
      <CreativeCanvas snapshot={asSnapshot(snapshot, creative)} creative={asInstance(creative)} fontsRevision={fontsRevision} width={width} selected={selected} onSelect={setSelected} onMove={move} objects={objects} absoluteZOrder={creative.absoluteZOrder} backgroundZ={creative.backgroundSource?.z} canvasFill={creative.canvasFill} />
      <p className="ot-muted">Drag anything to move it. Products and characters stay in their slots when replaced.</p>
    </section>
    <aside className="prt-pane prt-inspector" aria-label="Change the creative">
      <section>
        <label className="ot-field"><span>Creative name</span><input value={creative.name} maxLength={120} onChange={e => update({ ...creative, name: e.target.value })} /></label>
        {note && <p className="prt-note" role="status">{note}</p>}
      </section>
      <section aria-label="Products and characters"><h3>Products and characters</h3>
        <ul className="prt-slots">{slots.map(o => <li key={o.id} className={selected?.kind === 'object' && selected.id === o.id ? 'is-selected' : ''}>
          <img src={productFileUrl(templateId, o.asset.file)} alt="" />
          <span className="prt-slot-name">{o.label}<span className="prt-reason">{PRODUCT_KIND_LABELS[o.kind].one}{o.asset.kind === 'upload' ? ' · replaced' : ''}</span></span>
          <span className="ot-row prt-slot-actions">
            <label className="ws-btn ws-btn-quiet prt-file"><ImagePlus size={14} aria-hidden="true" />{busy === o.id ? 'Placing…' : 'Replace'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${o.label}`} disabled={!!busy} onChange={e => void replace(o.id, e.target.files?.[0])} /></label>
            {o.asset.kind === 'upload' && <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy} onClick={() => void restore(o.id)}><RotateCcw size={14} aria-hidden="true" />Original</button>}
            <button type="button" className="ws-icon-button" aria-label={o.hidden ? `Show ${o.label}` : `Hide ${o.label}`} onClick={() => update({ ...creative, objects: creative.objects.map(x => (x.id === o.id ? { ...x, hidden: !x.hidden } : x)) })}>{o.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </span></li>)}</ul>
        <p className="ot-muted">For the cleanest result use a PNG with a transparent background, or a product photo on a plain white or single-colour background.</p>
      </section>
      {stands.length > 0 && <section aria-label="Display stands"><h3>Display stands</h3>
        <ul className="prt-slots">{stands.map(o => <li key={o.id} className={selected?.kind === 'object' && selected.id === o.id ? 'is-selected' : ''}>
          <img src={productFileUrl(templateId, o.asset.file)} alt="" />
          <span className="prt-slot-name">{o.label}<span className="prt-reason">Stand · its own layer: drag it on the canvas to move it</span></span>
          <span className="ot-row prt-slot-actions">
            <button type="button" className="ws-icon-button" aria-label={o.hidden ? `Show ${o.label}` : `Hide ${o.label}`} onClick={() => update({ ...creative, objects: creative.objects.map(x => (x.id === o.id ? { ...x, hidden: !x.hidden } : x)) })}>{o.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button>
          </span></li>)}</ul>
      </section>}
      <section aria-label="Text"><h3>Text</h3>
        {groups.map(({ g, text }) => <div key={g.id} className="ot-field prt-copy"><span>{MASTER_CATEGORY_LABELS[g.category]}</span>
          <textarea rows={Math.min(4, text.split('\n').length + (copy[g.id] !== undefined ? 1 : 0))} value={copy[g.id] ?? text} maxLength={400} onChange={e => setCopy(c => ({ ...c, [g.id]: e.target.value }))} aria-label={`${MASTER_CATEGORY_LABELS[g.category]} text`} />
          {copy[g.id] !== undefined && copy[g.id] !== text && <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={() => applyCopy(g.id)}>Apply</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setCopy(c => { const n = { ...c }; delete n[g.id]; return n; })}>Cancel</button></div>}
        </div>)}
        <p className="ot-muted">New lines start a new line; long text is set smaller to fit its place.</p>
      </section>
      {creative.images.length > 0 && <section aria-label="Logos"><h3>Logos</h3>
        <ul className="prt-slots">{creative.images.map(i => <li key={i.id}><img src={productFileUrl(templateId, i.asset.file)} alt="" /><span className="prt-slot-name">{i.label}<span className="prt-reason">{MASTER_CATEGORY_LABELS[i.category]}</span></span>
          <span className="ot-row prt-slot-actions"><label className="ws-btn ws-btn-quiet prt-file"><ImagePlus size={14} aria-hidden="true" />Replace<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${i.label}`} onChange={e => void replaceLogo(i.id, e.target.files?.[0])} /></label>
            <button type="button" className="ws-icon-button" aria-label={i.hidden ? `Show ${i.label}` : `Hide ${i.label}`} onClick={() => update({ ...creative, images: creative.images.map(x => (x.id === i.id ? { ...x, hidden: !x.hidden } : x)) })}>{i.hidden ? <EyeOff size={15} /> : <Eye size={15} />}</button></span></li>)}</ul></section>}
      <section className="prt-cta">
        {dirty ? <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={!!busy} onClick={() => void save()}><Save size={15} aria-hidden="true" />{busy === 'saving' ? 'Saving…' : 'Save changes'}</button>
          : <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={!!busy} onClick={() => { setBusy('opening'); void onOpen(creativeId).catch((e: Error) => onError(e.message)).finally(() => setBusy('')); }}><Wand2 size={15} aria-hidden="true" />{busy === 'opening' ? 'Opening…' : 'Open in editor'}</button>}
        {!dirty && onDecompose && <button type="button" className="ws-btn" disabled={!!busy} onClick={() => { setBusy('opening'); void onDecompose(creativeId).catch((e: Error) => onError(e.message)).finally(() => setBusy('')); }}>Send to Decomposition</button>}
        {dirty && <button type="button" className="ws-btn" disabled={!!busy} onClick={() => { void save().then(saved => { if (saved) { setBusy('opening'); return onOpen(creativeId).finally(() => setBusy('')); } }).catch((e: Error) => onError(e.message)); }}>Save and open in editor</button>}
        <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy || dirty} onClick={() => void productApi.duplicate(templateId, creativeId).then(c => onCopied(c.id)).catch((e: Error) => onError(e.message))}><Copy size={14} aria-hidden="true" />Duplicate</button>
        <p className="ot-muted">Version {creative.revision}{dirty ? ' · unsaved changes' : ''}. Each save keeps the earlier versions.</p>
      </section>
    </aside>
  </div>;
}

/**
 * Generate with AI: 3–5 variations at once from the template's structure, in the chosen styles and aspect ratios, with the
 * person's own headline and offer text and their choice of products and characters. Each card shows exactly what was
 * made and its checks; the chosen one goes through review and explicit AI decomposition approval before the editor.
 */
function Variations({ templateId, revision, onOpen, onSaved, onDecomposeTemplate, onRepairSource, onError }: { templateId: string; revision: number; onRepairSource?: () => void; onOpen: (cid: string) => Promise<void>; onSaved: (cid: string) => Promise<void>; onDecompose?: (runId: string) => Promise<void>; onDecomposeTemplate?: (templateId: string) => void; onError: (m: string) => void }) {
  const [options, setOptions] = useState<VariationOptions>(), [count, setCount] = useState(3), [kinds, setKinds] = useState<ProductVariationKind[]>(['premium', 'minimal', 'festive']);
  const [mode, setMode] = useState<'reuse' | 'typography' | 'redesign'>('reuse');
  // Every design in every chosen size, or one size each; the saved generation instructions (editable for this run only).
  const [eachSize, setEachSize] = useState(false), [brief, setBrief] = useState<TemplateBrief>(), [briefText, setBriefText] = useState('');
  useEffect(() => { void productApi.brief(templateId).then(b => { setBrief(b); setBriefText(b.generation.prompt); }).catch(() => undefined); }, [templateId]);
  const [ratios, setRatios] = useState<ProductAspectRatio[]>(['original']), [headline, setHeadline] = useState(''), [offer, setOffer] = useState(''), [aiCopy, setAiCopy] = useState(false);
  const generateProducts = mode === 'reuse';
  const [probeImage, setProbeImage] = useState(false);
  const [picked, setPicked] = useState<Record<string, string[]>>({}), [useAi, setUseAi] = useState(false), [confirm, setConfirm] = useState(false);
  // The background: the template's artwork (its layout), a simple backdrop (free, laid out again), or new AI artwork (paid).
  const [artwork, setArtwork] = useState<'template' | 'local' | 'ai'>('template'), [direction, setDirection] = useState(''), [confirmRegen, setConfirmRegen] = useState<number>();
  const [job, setJob] = useState<VariationJob>(), [busy, setBusy] = useState(''), [note, setNote] = useState(''), [inspect, setInspect] = useState<number>();
  const load = useCallback(() => productApi.variationOptions(templateId, revision).then(setOptions), [templateId, revision]);
  useEffect(() => { void load().catch((e: Error) => onError(e.message)); void productApi.variations(templateId).then(r => { const last = r.jobs.find(j => j.revision === revision); if (last) void productApi.variation(templateId, last.id).then(setJob); }).catch(() => undefined); }, [templateId, revision, load, onError]);
  useEffect(() => {
    // Poll only while the server says this job is generating: a paused or failed job shows no activity.
    if (!job || !(job.running || job.status === 'running')) return;
    const t = setInterval(() => { void productApi.variation(templateId, job.id).then(setJob).catch(() => undefined); }, 1000);
    return () => clearInterval(t);
  }, [job, templateId]);
  if (!options) return <p className="ot-muted" role="status">Loading…</p>;
  const addPicture = async (kind: 'product' | 'character', file?: File) => {
    if (!file) return;
    setBusy(kind); setNote('');
    try { const r = await productApi.addVariationProduct(templateId, file, kind); await load(); setNote(r.background === 'kept' ? r.note ?? 'Added (its background was kept).' : `${r.choice.label} added. Choose it for a slot below.`); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not add the picture.'); }
    finally { setBusy(''); }
  };
  // How many creatives: one per design (each in the next size), or every design in every size.
  const outputs = mode === 'redesign' && eachSize ? count * ratios.length : count, tooMany = outputs > 20;
  // Offline artwork is either the test model or real artwork recorded earlier and replayed: named as what it is.
  const replayed = !!options?.artwork?.model.includes('(recorded artwork'), offlineArtwork = replayed ? `${options!.artwork!.model.replace(' (recorded artwork, replayed)', '')} artwork recorded earlier, replayed, free` : 'test image model, free';
  const paidArtwork = mode === 'redesign' && artwork === 'ai' && !!options?.artwork && !options.artwork.offline, artworkTotal = options?.artwork ? Math.round(outputs * options.artwork.costUsd * 100) / 100 : 0;
  const productRequests = mode === 'reuse' && generateProducts && options.artwork?.ai ? probeImage ? 1 : outputs * options.slots.filter(s => s.kind === 'product').length : 0;
  const productTotal = options.artwork && !options.artwork.offline ? Math.round(productRequests * options.artwork.costUsd * 100) / 100 : 0;
  const total = productTotal + (useAi ? options?.planner.costUsd ?? 0 : 0) + (paidArtwork ? artworkTotal : 0);
  // An unfinished job of this revision with saved images: continuing it reuses them, a new batch makes them all again.
  const unfinished = job?.request.generateProducts && !job.running && job.continuation?.available && (job.progress?.ready ?? 0) > 0 ? job : undefined;
  const fullBatch = mode === 'reuse' && options.artwork?.ai ? outputs * options.slots.filter(s => s.kind === 'product').length : 0;
  const generate = async () => {
    if ((useAi || paidArtwork || productTotal > 0) && !confirm) { setConfirm(true); return; }
    setBusy('generate'); setConfirm(false); onError(''); setInspect(undefined);
    try { setJob(await productApi.startVariations(templateId, { revision: options.revision, mode, count, kinds, copy: useAi && aiCopy ? 'suggest' : 'none', ai: useAi, aspectRatios: mode !== 'redesign' ? ['original'] : ratios, ...(headline.trim() ? { headline: headline.trim() } : {}), ...(offer.trim() ? { offer: offer.trim() } : {}), ...(Object.values(picked).some(v => v.length) ? { products: picked } : {}),
      ...(mode === 'reuse' && probeImage ? { maxNewImages: 1 } : {}), generateProducts: mode === 'reuse' && generateProducts && !!options.artwork?.ai, approveProductsUsd: productTotal, ...(productRequests ? { approveImages: productRequests } : {}), ...(unfinished ? { startNew: true } : {}), artwork: mode !== 'redesign' ? 'template' : artwork, ...(direction.trim() ? { direction: direction.trim() } : {}), ...(paidArtwork ? { approveArtworkUsd: artworkTotal } : {}), ...(mode === 'redesign' && eachSize ? { sizes: 'each' as const } : {}),
      ...(brief && briefText.trim() && briefText.trim() !== brief.generation.prompt ? { brief: briefText.trim() } : {}) })); }
    catch (e) {
      onError(e instanceof Error ? e.message : 'Could not start.');
      // An older unfinished job of this revision: show it, so its saved images can be continued (or a new batch confirmed).
      const jobId = (e as { code?: string; details?: { jobId?: string } }).code === 'UNFINISHED_JOB' ? (e as { details?: { jobId?: string } }).details?.jobId : undefined;
      if (jobId) void productApi.variation(templateId, jobId).then(setJob).catch(() => undefined);
    }
    finally { setBusy(''); }
  };
  const act = async (key: string, work: () => Promise<void>) => { setBusy(key); onError(''); try { await work(); } catch (e) { onError(e instanceof Error ? e.message : 'That did not work.'); } finally { setBusy(''); } };
  /** Review the selected variation, then explicitly approve its OpenAI + Seedream preparation. */
  const decompose = (r: VariationResult) => act(`decompose-${r.index}`, async () => {
    if (!job || !onDecomposeTemplate) return;
    const sent = await productApi.decomposeVariation(templateId, job.id, r.index);
    setJob(await productApi.variation(templateId, job.id));
    onDecomposeTemplate(sent.templateId);
  });
  const regenProducts = job?.request.generateProducts && options.artwork && !options.artwork.offline ? options.slots.filter(s => s.kind === 'product').length * options.artwork.costUsd : 0;
  const regenTotal = regenProducts + (job?.artwork?.mode === 'ai' && !job.artwork.offline ? options.artwork?.costUsd ?? 0 : 0);
  const results = job?.results.filter(r => !r.removed) ?? [];
  const currentHeadline = options.texts.find(t => t.role === 'headline')?.text, currentOffer = options.texts.find(t => t.role === 'offer')?.text;
  const slotsOf = (kind: 'product' | 'character') => options.slots.filter(s => s.kind === kind);
  const choicesOf = (kind: 'product' | 'character') => options.choices.filter(c => c.kind === kind);
  return <div className="prt-variations">
    <section className="ts-card"><div className="ts-card-body prt-var-form">
      <h3>What should the variations look like?</h3>
      <label className="ot-field"><span>Generation mode</span><select aria-label="Generation mode" value={mode} onChange={e => { setMode(e.target.value as typeof mode); setConfirm(false); setKinds(['premium', 'minimal', 'festive']); }}><option value="reuse">Preserve structure · new AI products</option><option value="typography">Typography only · keep existing products</option><option value="redesign">Redesign artwork or layout</option></select></label>
      <p className="ot-muted">{mode === 'typography' ? 'Keep all existing images and refresh editable typography. No new product imagery is generated.' : mode === 'reuse' ? 'Keep the background, fixed characters, logos, canvas and layout anchors. Generate different product mixes within their original families, refresh typography and edit copy without flattening words into the artwork.' : 'Choose new artwork, sizes, products or copy. New AI artwork needs explicit cost approval and must pass text-exclusion checks.'}</p>
      <div className="ot-field"><span>How many</span><div className="prt-seg" role="radiogroup" aria-label="How many variations">{[1, 3, 4, 5, 10].map(n => <button key={n} type="button" role="radio" aria-checked={count === n} onClick={() => { setCount(n); setConfirm(false); }}>{n}</button>)}</div></div>
      <div className="ot-field"><span>Styles</span><div className="prt-kinds">{options.kinds.filter(k => mode === 'redesign' || ['premium', 'minimal', 'festive'].includes(k.kind)).map(k => <label key={k.kind} className="prt-kind"><input type="checkbox" checked={kinds.includes(k.kind)} onChange={e => setKinds(v => (e.target.checked ? [...v, k.kind] : v.filter(x => x !== k.kind)))} /><span><strong>{mode !== 'redesign' ? ({ premium: 'Premium typography', minimal: 'Modern typography', festive: 'Festive typography' } as Record<string, string>)[k.kind] : k.title}</strong>{mode === 'reuse' ? 'Original composition; editable copy and category-matched products.' : k.hint}</span></label>)}</div></div>
      {mode === 'redesign' && <><div className="ot-field"><span>Sizes <span className="ot-muted">(choose one or more)</span></span>
        <div className="prt-seg" role="group" aria-label="Aspect ratios">{options.aspectRatios.map(a => { const size = canvasFor(options.canvas, a); return <button key={a} type="button" role="checkbox" aria-checked={ratios.includes(a)} title={`${size.width} × ${size.height} px`}
          onClick={() => setRatios(v => (v.includes(a) ? (v.length > 1 ? v.filter(x => x !== a) : v) : [...v, a]))}>{PRODUCT_ASPECT_LABELS[a]}</button>; })}</div>
        <label className="prt-option"><input type="checkbox" checked={eachSize} onChange={e => { setEachSize(e.target.checked); setConfirm(false); }} /><span><strong>Make every variation in every size</strong>Otherwise each variation takes the next size in turn. Nothing is stretched.</span></label>
        <p className="ot-muted" data-testid="variation-outputs">{tooMany ? `That makes ${outputs} creatives; at most 20 at once.` : `Makes ${outputs} creative${outputs === 1 ? '' : 's'}: ${eachSize ? `${count} designs × ${ratios.length} size${ratios.length === 1 ? '' : 's'}` : `${count} designs, ${ratios.length === 1 ? `all ${PRODUCT_ASPECT_LABELS[ratios[0]]}` : 'one size each, in turn'}`}${artwork === 'ai' && options.artwork ? `, ${outputs} artwork image${outputs === 1 ? '' : 's'} (${options.artwork.offline ? offlineArtwork : `about $${artworkTotal.toFixed(2)}`})` : ''}.`}</p></div>
      <div className="ot-field"><span>Background</span><div className="prt-kinds" role="radiogroup" aria-label="Background">
        {([['template', 'The template’s artwork', 'Same design and layout; plain margins are lengthened for other sizes. Free.'],
          ['local', 'A simple backdrop', 'A soft backdrop in the template’s colours, every element laid out again for each size. Free, no AI.'],
          ...(options.artwork?.ai ? [['ai', 'New AI artwork', `${options.artwork.offline ? (replayed ? `Real ${options.artwork.model.replace(' (recorded artwork, replayed)', '')} artwork recorded earlier, replayed (free, nothing is sent).` : 'Test image model (offline, free).') : `One image per variation from ${options.artwork.model}, about $${options.artwork.costUsd.toFixed(2)} each.`} Every element laid out again; the artwork never contains text.`]] : [])] as [typeof artwork, string, string][]).map(([v, t, h]) =>
          <label key={v} className="prt-kind"><input type="radio" name="artwork" checked={artwork === v} onChange={() => { setArtwork(v); setConfirm(false); }} /><span><strong>{t}</strong>{h}</span></label>)}</div>
        <label className="ot-field"><span>Custom instructions (optional)</span><textarea rows={2} maxLength={300} value={direction} aria-label="Creative direction" placeholder="Leave empty, or e.g. Diwali lights over a marble terrace, warm and premium" onChange={e => setDirection(e.target.value)} /></label>
        {brief && <details className="ot-more prt-advanced"><summary>Advanced: generation instructions</summary>
          <p className="ot-muted ot-small">{brief.generation.source === 'derived' ? 'Written by FrameFlow from this template’s AI detection (not the prompt the creative was originally made with).' : 'The prompt the creative was originally made with.'}{brief.generation.edited ? ' Edited by you.' : ''} A change here is used for this generation only; to keep it, edit it in Template details.</p>
          <textarea rows={5} maxLength={2000} value={briefText} aria-label="Generation instructions for this run" onChange={e => setBriefText(e.target.value)} /></details>}</div>
      </>}
      {mode !== 'typography' && <><label className="ot-field"><span>Headline</span><input value={headline} maxLength={300} placeholder={currentHeadline ? `Keep “${currentHeadline.slice(0, 60)}”` : 'Keep the template’s headline'} aria-label="Headline for the variations" onChange={e => setHeadline(e.target.value)} />
        <span className="ot-muted ot-small">Leave empty to keep the template’s headline. What you type is exactly what every variation shows.</span></label>
      <label className="ot-field"><span>Offer text</span><input value={offer} maxLength={300} placeholder={currentOffer ? `Keep “${currentOffer.slice(0, 60)}”` : 'Keep the template’s offer'} aria-label="Offer text for the variations" onChange={e => setOffer(e.target.value)} />
        <span className="ot-muted ot-small">Only type a real, approved offer. FrameFlow never writes prices, cashback, EMI or dates itself.</span></label></>}
      {(['product', 'character'] as const).filter(() => mode === 'redesign').map(kind => slotsOf(kind).length > 0 && <div key={kind} className="ot-field"><span>{kind === 'product' ? 'Products' : 'Characters'}</span>
        <p className="ot-muted">{kind === 'product' ? 'Only category-compatible products are offered in preserve mode. Unknown uploads must have a descriptive category in their filename. AI product generation, when selected, replaces these choices.' : 'Characters stay as they are unless you choose another picture.'}</p>
        {slotsOf(kind).map(s => <label key={s.slotId} className="prt-slot-pick"><span>{s.label}</span><select aria-label={`${kind === 'product' ? 'Product' : 'Character'} for ${s.label}`} value={picked[s.slotId]?.[0] ?? ''} onChange={e => setPicked(p => ({ ...p, [s.slotId]: e.target.value ? [e.target.value] : [] }))}>
          <option value="">{kind === 'product' ? 'Any' : 'Keep it'}</option>{choicesOf(kind).filter(c => mode !== 'reuse' || options.compatibleProducts?.[s.slotId]?.includes(c.ref)).map(c => <option key={c.ref} value={c.ref}>{c.label}</option>)}</select></label>)}
        <label className="ws-btn ws-btn-quiet prt-file"><ImagePlus size={14} aria-hidden="true" />{busy === kind ? 'Adding…' : kind === 'product' ? 'Add a product picture' : 'Add a character picture'}<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={kind === 'product' ? 'Add a product picture' : 'Add a character picture'} onChange={e => void addPicture(kind, e.target.files?.[0])} /></label>
      </div>)}
      {note && <p className="prt-note" role="status">{note}</p>}
      {mode === 'reuse' && !!options.sourceIssues?.length && <Alert>Repair this master revision before generating paid images: {options.sourceIssues.join(' ')}</Alert>}
      {mode === 'reuse' && <p className="ot-muted">Product families: {options.productFamilies?.join(', ') || 'source product categories'}. Fixed characters keep their exact saved images.</p>}
      {mode === 'reuse' && <p className="prt-note" role="status" data-testid="generation-plan">{options.artwork?.ai ? <>New product images from <strong>{options.artwork.model}</strong>: {probeImage ? <>smoke test, 1 image, about ${productTotal.toFixed(2)} (the full batch is {fullBatch} images)</> : <>{productRequests} images for {count} variations, about ${productTotal.toFixed(2)}, approved once for the whole batch</>}. Products change within their source families and fit the original slots. Generated concepts need review and are not verified catalogue photos.</> : 'AI product generation is unavailable: configure the image provider and text checker on the server. Choose Typography only to keep existing product images.'}</p>}
      {mode === 'reuse' && <label className="prt-option"><input type="checkbox" checked={probeImage} onChange={e => { setProbeImage(e.target.checked); setConfirm(false); }} /><span><strong>Smoke test: make one product image first (optional)</strong>Generates a single image and pauses, so you can check it. You then approve the remaining images once, as one batch; the test image is reused. Leave this off to make all {count} variations in one go.</span></label>}
      {options.planner.ai && <label className="prt-option"><input type="checkbox" checked={useAi} onChange={e => { setUseAi(e.target.checked); setConfirm(false); }} /><span><strong>Plan with AI</strong>One request to OpenAI ({options.planner.model}), about ${options.planner.costUsd.toFixed(2)}. Without it, the styles above are applied by fixed rules, free.</span></label>}
      {useAi && mode !== 'typography' && <label className="prt-option"><input type="checkbox" checked={aiCopy} onChange={e => setAiCopy(e.target.checked)} /><span><strong>Let the AI write headlines</strong>Used only where you typed none, and marked on the card for you to check. Offers, prices and legal text are never rewritten.</span></label>}
      {confirm && <div className="prt-confirm" role="group" aria-label="Confirm the cost"><p>Spend about <strong>${total.toFixed(2)}</strong>{useAi ? ' on one planning request' : ''}{useAi && paidArtwork ? ' and' : ''}{paidArtwork ? ` on ${outputs} artwork image${outputs === 1 ? '' : 's'} (${options.artwork!.model})` : ''}{productRequests ? `${useAi || paidArtwork ? ' plus' : ' on'} ${productRequests} category-matched product image${productRequests === 1 ? '' : 's'}` : ''}? Nothing is retried automatically.</p>
        {productRequests > 0 && <p>{probeImage ? 'One approval for one image: generation then pauses with the image shown, and you decide whether to continue.' : `One approval for the whole batch: all ${productRequests} images are generated automatically (at most ${productRequests} requests, about $${productTotal.toFixed(2)} estimated), each saved as soon as it arrives, and each variation shown as soon as its images are ready. A provider or connection failure stops further requests.`}</p>}
        {unfinished && <p><strong>The unfinished generation below already has {unfinished.progress!.ready} saved product images.</strong> A new batch does not reuse them. To reuse them, cancel this and use “Continue” below instead.</p>}</div>}
      <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={!!busy || !kinds.length || tooMany || job?.status === 'running' || (mode === 'reuse' && (!!options.sourceIssues?.length || !options.artwork?.ai || !options.slots.some(s => s.kind === 'product')))} onClick={() => void generate()}><Sparkles size={15} aria-hidden="true" />
        {job?.running || job?.status === 'running' ? 'Generating…' : confirm ? `Yes, spend $${total.toFixed(2)} and generate` : probeImage && mode === 'reuse' ? 'Run the smoke test (1 image)' : `Generate ${count} variations`}</button>
        {confirm && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirm(false)}>Cancel</button>}</div>
    </div></section>
    {job?.request.generateProducts && job.state ? <GenerationStatus job={job} templateId={templateId} busy={!!busy} onRepairSource={onRepairSource}
      onStop={() => void act('stop', async () => setJob(await productApi.cancelVariations(templateId, job.id)))}
      onContinue={(approveImages, approveProductsUsd, retry) => void act('continue', async () => setJob(await productApi.resumeVariations(templateId, job.id, { approveImages, approveProductsUsd, retry, approveLegacyRecovery: !!job.continuation?.legacy })))} />
      : <>{job?.status === 'running' && <p className="prt-waiting" role="status">Making {job.request.count} variations…</p>}
        {job?.status === 'failed' && <Alert>{job.error ?? 'Generating did not finish.'}</Alert>}</>}
    {job && results.length > 0 && <section aria-label="Variations">
      <p className="ot-muted">{job.planner.offline ? 'Planned with fixed style rules, on this computer (free).' : `Planned by ${job.planner.model} (${job.planner.requests} request${job.planner.requests === 1 ? '' : 's'}, $${job.planner.costUsd.toFixed(2)}).`}
        {job.artwork?.mode === 'ai' ? ` Artwork: ${job.artwork.model.includes('(recorded artwork') ? `${job.artwork.model.replace(' (recorded artwork, replayed)', '')} artwork recorded earlier, replayed (free)` : job.artwork.offline ? 'test image model (offline)' : `${job.artwork.model}, ${job.artwork.requests} image${job.artwork.requests === 1 ? '' : 's'}, $${job.artwork.costUsd.toFixed(2)}`}.` : job.artwork?.mode === 'local' ? ' Backdrops: drawn on this computer (no AI).' : ''} {job.productGeneration && !job.accounting ? ` Product image attempts: ${job.productGeneration.requests}; mixed estimate $${job.productGeneration.costUsd.toFixed(2)} (billing unconfirmed).` : ''} Every word, logo, product and character stays its own layer. Choose one and send it to Decomposition Layers to open it in the editor.</p>
      <div className="ot-grid is-wide prt-var-grid">{results.map(r => { const v = r.creative?.variation, checks = v?.checks, failed = checks?.status === 'failed';
        return <article key={`${r.index}-${r.round ?? 0}`} className={`ot-card${inspect === r.index ? ' is-inspected' : ''}`} aria-label={`Variation ${r.plan?.title ?? r.index + 1}`} data-status={checks?.status ?? r.status}>
        {r.preview ? <button type="button" className="prt-var-preview" aria-label={`Inspect ${r.plan?.title ?? 'the variation'}`} onClick={() => setInspect(i => (i === r.index ? undefined : r.index))}><img src={productFileUrl(templateId, r.preview)} alt={`Preview of ${r.plan?.title ?? 'the variation'}`} /></button>
          : <div className={r.status === 'pending' ? 'prt-var-pending' : 'prt-var-failed'}>{(() => { const saved = job.progress?.variations[r.index]?.slots.filter(x => x.asset) ?? [];
            return saved.length > 0 && <div className="prt-var-thumbs" aria-label={`Saved product images for ${r.plan?.title ?? 'this variation'}`}>{saved.map(x => <img key={x.slotId} src={productFileUrl(templateId, x.asset!)} alt={x.label} title={`${x.label} (in the ${x.slot} slot)`} />)}</div>; })()}
            <p>{r.note ?? r.error}</p></div>}
        <div className="ot-card-body">
          <div className="ot-row"><h3>{r.plan?.title}</h3>{r.savedCreativeId && <Badge tone="ok">Saved</Badge>}{r.status === 'pending' && <Badge tone="warn">Not finished</Badge>}{r.status === 'failed' && !checks && <Badge tone="danger">{job.request.generateProducts && r.preview === undefined ? 'An image needs a decision' : 'Failed'}</Badge>}
            {checks && <Badge tone={checks.status === 'ready' ? 'ok' : checks.status === 'failed' ? 'danger' : 'warn'}>{checks.status === 'ready' ? 'Automatic checks passed' : checks.status === 'failed' ? 'Failed checks' : 'Needs a look'}</Badge>}
            {r.creative?.background?.method === 'ai-artwork' ? <Badge tone="accent">{r.creative.background.artwork?.model.includes('(recorded artwork') ? 'Recorded AI artwork (replayed)' : r.creative.background.artwork?.offline ? 'Test artwork (offline)' : 'AI artwork'}</Badge> : r.creative?.background?.method === 'local-backdrop' ? <Badge>Simple backdrop · no AI</Badge> : null}</div>
          {r.creative && <p className="ot-small ot-muted">{PRODUCT_ASPECT_LABELS[v?.aspectRatio ?? 'original']} · {r.creative.canvas.width} × {r.creative.canvas.height} px{v?.mode === 'reuse' ? ' · Editable typography; original composition preserved' : r.plan ? ` · ${PRODUCT_VARIATION_LABELS[r.plan.kind].hint}` : ''}</p>}
          {v?.copy.map(d => <p key={d.groupId} className="prt-draft"><span className="ot-chip">{d.source === 'ai' ? 'AI-written: check it' : MASTER_CATEGORY_LABELS[d.role as keyof typeof MASTER_CATEGORY_LABELS] ?? 'Text'}</span> “{d.text}”</p>)}
          {checks && checks.issues.length > 0 && <ul className="prt-var-issues">{checks.issues.slice(0, inspect === r.index ? 40 : 3).map((i, k) => <li key={k} className={i.blocking ? 'is-blocking' : ''}><span className="ot-chip">{PRODUCT_CHECK_KIND[i.code] === 'automatic' ? 'Automatic' : PRODUCT_CHECK_KIND[i.code] === 'visual' ? 'Picture' : 'Your eyes'}</span> {i.message}</li>)}
            {inspect !== r.index && checks.issues.length > 3 && <li><button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={() => setInspect(r.index)}>{checks.issues.length - 3} more…</button></li>}</ul>}
          {inspect === r.index && r.plan?.notes.map((n, i) => <p key={i} className="ot-muted ot-small">{n}</p>)}
          <div className="ot-row">
            <button type="button" className="ws-btn ws-btn-primary" disabled={!!busy || job.status === 'running' || r.status !== 'ready' || failed || !onDecomposeTemplate} title="Review this variation, approve OpenAI + Seedream decomposition, then inspect and edit" onClick={() => void decompose(r)}><Wand2 size={14} aria-hidden="true" />{busy === `decompose-${r.index}` ? 'Opening…' : r.templateId ? 'Continue Decompose & Edit' : 'Decompose & Edit'}</button>
            <button type="button" className="ws-btn" disabled={!!busy || job.status === 'running' || r.status !== 'ready' || failed || !onDecomposeTemplate} onClick={() => void decompose(r)}><Layers3 size={14} aria-hidden="true" />Send to Decomposition</button>
            <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy || job.status === 'running' || r.status !== 'ready' || failed} onClick={() => void act(`open-${r.index}`, async () => { const c = await productApi.saveVariation(templateId, job.id, r.index); await onOpen(c.id); })}>Open existing layers (free)</button>
            {!r.savedCreativeId && <button type="button" className="ws-btn" disabled={!!busy || job.status === 'running' || r.status !== 'ready' || failed} onClick={() => void act(`save-${r.index}`, async () => { const c = await productApi.saveVariation(templateId, job.id, r.index); setJob(await productApi.variation(templateId, job.id)); await onSaved(c.id); })}><Save size={14} aria-hidden="true" />Save</button>}
            {!(job.request.generateProducts && r.status !== 'ready') && (confirmRegen === r.index ? <><button type="button" className="ws-btn" disabled={!!busy} onClick={() => { setConfirmRegen(undefined); void act(`regen-${r.index}`, async () => setJob(await productApi.regenerate(templateId, job.id, r.index, false, options.artwork?.costUsd, regenProducts))); }}>Yes, spend ${regenTotal.toFixed(2)}</button>
              <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmRegen(undefined)}>Cancel</button></>
              : <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy || job.status === 'running'} onClick={() => (regenTotal > 0 ? setConfirmRegen(r.index) : void act(`regen-${r.index}`, async () => setJob(await productApi.regenerate(templateId, job.id, r.index))))}><RefreshCw size={14} aria-hidden="true" />{busy === `regen-${r.index}` ? 'Making…' : 'Regenerate'}</button>)}
            {!r.savedCreativeId && <button type="button" className="ws-btn ws-btn-quiet" disabled={!!busy || job.status === 'running'} onClick={() => void act(`rm-${r.index}`, async () => setJob(await productApi.removeVariation(templateId, job.id, r.index)))}><Trash2 size={14} aria-hidden="true" />Remove</button>}
          </div>
        </div>
      </article>; })}</div>
    </section>}
  </div>;
}
const STATE_TITLE: Record<GenerationState, string> = {
  generating: 'Generating product images', 'paused-smoke-test': 'Smoke test finished', 'paused-approval': 'Paused for your approval', cancelled: 'Stopped by you', completed: 'All variations are ready',
  'insufficient-credits': 'OpenAI API credits exhausted', 'provider-failure': 'The image provider refused or failed a request', 'connection-interrupted': 'Connection to the image provider interrupted',
  'images-rejected': 'Generated images failed the checks', interrupted: 'Interrupted: the server stopped', 'source-blocked': 'The master template needs repair', failed: 'Generation failed',
};
const STATE_TONE: Record<GenerationState, 'ok' | 'warn' | 'danger' | 'accent'> = {
  generating: 'accent', 'paused-smoke-test': 'warn', 'paused-approval': 'warn', cancelled: 'warn', completed: 'ok', 'insufficient-credits': 'danger', 'provider-failure': 'danger',
  'connection-interrupted': 'danger', 'images-rejected': 'danger', interrupted: 'danger', 'source-blocked': 'danger', failed: 'danger',
};
/**
 * A product-image job as the server reports it: its state (a pause is never shown as a failure), images saved of the
 * total, Stop while it runs, and one approval to continue everything it still needs; earlier failed or uncertain
 * images only when the person ticks them. Costs are estimates, never presented as billed charges.
 */
function GenerationStatus({ job, templateId, busy, onStop, onContinue, onRepairSource }: { job: VariationJob; templateId: string; busy: boolean; onStop: () => void; onContinue: (images: number, usd: number, retry: boolean) => void; onRepairSource?: () => void }) {
  const [confirm, setConfirm] = useState(false), [retry, setRetry] = useState(false);
  const state = job.state ?? 'failed', p = job.progress, c = job.continuation;
  const images = (c?.images ?? 0) + (retry ? c?.retryImages ?? 0 : 0), usd = Math.round(((c?.estimateUsd ?? 0) + (retry ? c?.retryEstimateUsd ?? 0 : 0)) * 100) / 100;
  const nothingToSend = images === 0 && !!c?.retryImages && !retry;
  return <section className="ts-card prt-gen-status" aria-label="Generation status" data-state={state}><div className="ts-card-body">
    <div className="ot-row"><h3>{STATE_TITLE[state]}</h3><Badge tone={STATE_TONE[state]}>{job.running ? 'Running' : job.status === 'paused' ? 'Paused' : job.status === 'done' ? 'Done' : 'Stopped'}</Badge></div>
    {p && p.total > 0 && <><div className="prt-progress" role="progressbar" aria-label="Product images saved" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.ready}><span style={{ width: `${(100 * p.ready) / p.total}%` }} /></div>
      <p className="prt-waiting" data-testid="generation-progress">{p.ready} of {p.total} images completed{p.inFlight ? ` · ${p.inFlight} in progress` : ''}{p.retry ? ` · ${p.retry} need${p.retry === 1 ? 's' : ''} a decision` : ''}</p></>}
    <p className="prt-gen-message" role="status" data-testid="generation-message">{job.message}</p>
    {job.running && <div className="ot-row"><button type="button" className="ws-btn" disabled={busy || job.cancelRequested} onClick={onStop}>{job.cancelRequested ? 'Stopping after the images in progress…' : 'Stop after the images in progress'}</button>
      <span className="ot-muted ot-small">Completed images are kept. Nothing is retried automatically.</span></div>}
    {!job.running && !!job.sourceIssues?.length && <Alert>This master revision cannot be used for paid images: {job.sourceIssues.join(' ')} Prepare a repaired revision first; nothing will be sent for this job until then.
      {onRepairSource && <> <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={onRepairSource}>Open the master template to repair it</button></>}</Alert>}
    {!job.running && c?.available && <div className="prt-confirm" role="group" aria-label="Continue generation">
      <p><strong>Continue this generation.</strong> {c.reused} saved product image{c.reused === 1 ? ' is' : 's are'} reused and not requested again. {c.images ? `${c.images} image${c.images === 1 ? ' has' : 's have'} not been attempted yet (about $${c.estimateUsd.toFixed(2)}).` : 'No image is left that was never attempted.'}</p>
      {c.retryImages > 0 && <label className="prt-option"><input type="checkbox" checked={retry} onChange={e => { setRetry(e.target.checked); setConfirm(false); }} /><span><strong>Also try again the {c.retryImages} image{c.retryImages === 1 ? '' : 's'} whose earlier attempt failed or has an unknown outcome</strong>About ${c.retryEstimateUsd.toFixed(2)} more. An unknown outcome may already have been billed by the provider. Left unticked, they are not sent.</span></label>}
      {c.legacy && <p>Some saved images were matched to their slots from older records (by timing and file hashes). Check them in the records below before continuing.</p>}
      {confirm ? <><p>Approve up to <strong>${usd.toFixed(2)}</strong> for <strong>{images}</strong> new product image request{images === 1 ? '' : 's'}, as one batch? They run automatically; each image is saved as it arrives; a provider or connection failure stops further requests; nothing is retried automatically.</p>
        <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => { setConfirm(false); onContinue(images, usd, retry); }}>Yes, approve ${usd.toFixed(2)} and continue</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirm(false)}>Cancel</button></div></>
        : <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || nothingToSend} onClick={() => (usd > 0 ? setConfirm(true) : onContinue(images, 0, retry))}>{nothingToSend ? 'Tick the images above to try them again' : images ? `Continue: ${images} image${images === 1 ? '' : 's'}, about $${usd.toFixed(2)}` : 'Finish the variations (free)'}</button></div>}
    </div>}
    {!job.running && c && !c.available && state !== 'completed' && !job.sourceIssues?.length && c.reason && <p className="ot-muted">{c.reason}</p>}
    {job.accounting && <p className="ot-muted ot-small" data-testid="product-generation-cost">Image attempts: {job.productGeneration?.requests ?? 0}. Usage-derived estimate: ${job.accounting.usageCostUsd.toFixed(4)}; other estimates: ${job.accounting.estimatedCostUsd.toFixed(4)}; uncertain/in-flight attempts: ${job.accounting.uncertainCostUsd.toFixed(4)}. These are not confirmed billed charges.</p>}
    {!!job.authorizations?.length && <p className="ot-muted ot-small">Approvals: {job.authorizations.map(a => `${a.kind === 'smoke-test' ? 'smoke test' : a.kind} ${a.images} image${a.images === 1 ? '' : 's'} (up to $${a.maxUsd.toFixed(2)})${a.retry ? ', retries allowed' : ''}`).join('; ')}.</p>}
    {!!job.operations?.length && <details><summary>Product image records</summary><ul>{job.operations.map(o => <li key={o.id}>Variation {o.index + 1} · {o.label}: {o.status}{o.requestId ? ` · ${o.requestId}` : ''}{o.asset && <> · <a href={productFileUrl(templateId, o.asset.file)} target="_blank" rel="noreferrer">View saved product</a></>}{o.failure && <> · {o.failure.code}: {o.failure.message}</>}</li>)}</ul></details>}
  </div></section>;
}
/** A template's canvas in an aspect ratio (as the server makes it: one side kept, the other lengthened). */
function canvasFor(canvas: { width: number; height: number }, ratio: ProductAspectRatio) {
  if (ratio === 'original') return canvas;
  const [w, h] = ratio.split(':').map(Number), want = w / h, have = canvas.width / canvas.height;
  if (Math.abs(want - have) < 0.005) return canvas;
  return want < have ? { width: canvas.width, height: Math.round(canvas.width / want) } : { width: Math.round(canvas.height * want), height: canvas.height };
}
