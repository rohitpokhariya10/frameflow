/**
 * Create Your Offer Creative: the simple Reuse Template flow for anyone (steps 2–4 of Create Offer Creative; the
 * template was chosen before).
 *
 *   Upload products   one or many photos at once (drag and drop or the button); all of the template's own products are
 *                     left out of the new creative (the template is never changed); include, rename, replace, remove,
 *                     make one the main product
 *   Generate          one cost dialog when AI arranging costs money (or arranged automatically, free); each progress
 *                     line is a real request
 *   Review and save   the poster large (full screen, compared with the template); Save Creative first; Customize
 *                     Manually (the detailed studio, same draft), Regenerate Layout; then Edit Individual Elements
 *                     (Decompose & Edit) for editing every element in the editor
 *
 * Every change is saved in the draft as it is made: a reload continues where the person left off.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, Columns2, ImagePlus, LayoutGrid, Maximize2, Pencil, RefreshCw, Save, Sparkles, Star, Trash2, UploadCloud, X } from 'lucide-react';
import { REUSE_ASPECT_RATIOS, type ReuseAspectRatio, type ReuseDraft } from '@frameflow/shared';
import { productApi, productFileUrl, type ProductView, type ReuseDraftChange, type ReuseStudioView } from './api';
import { CreativeSteps } from './TemplateGallery';
import { EditYourCreative } from './MakeEditable';

const KIND_CHOICES = ['washing machine', 'refrigerator', 'television', 'dishwasher', 'microwave oven', 'air conditioner', 'coffee machine', 'cooker', 'air fryer', 'water purifier', 'mixer grinder', 'speaker', 'smart speaker', 'soundbar', 'phone', 'computer', 'tablet', 'headphones', 'kettle', 'vacuum cleaner', 'fan'];
const FRIENDLY: Record<string, string> = {
  SOURCE_NOT_READY: 'This template needs a quick background repair before its products can be replaced.',
  UNSUPPORTED_IMAGE: 'We couldn’t read this image. Please use a PNG, JPG or WebP photo.',
  INVALID_UPLOAD: 'We couldn’t read this image. Please use a PNG, JPG or WebP photo.',
  UPLOAD_TOO_LARGE: 'This image is too large. Please use a photo under 25 MB.',
  NOT_READY: 'We couldn’t place one of your products cleanly. Try another photo, or adjust it with Customize Manually.',
  NOT_CONFIGURED: 'AI arranging isn’t available right now, so your products were arranged automatically.',
  APPROVAL_REQUIRED: 'Please approve the AI cost first, or choose Arrange Automatically (Free).',
  PLACEMENT_PLAN_INVALID: 'We couldn’t find a suitable arrangement. Try generating another layout.',
  STALE_REVISION: 'Your creative was changed in another tab. We loaded the latest version.',
  TOO_MANY: 'That’s the most products one creative can hold.',
  NOT_FOUND: 'We couldn’t find that item any more. Please reload the page.',
  BUSY: 'FrameFlow is still working on your creative. Please wait a moment and try again.',
  HTTP_ERROR: 'We couldn’t reach FrameFlow. Check your connection and try again.',
};
const friendly = (e: unknown) => ({ message: FRIENDLY[(e as { code?: string })?.code ?? ''] ?? 'Something went wrong. Please try again.', detail: e instanceof Error ? e.message : String(e) });
type Pending = { key: string; name: string; url: string; file: File; error?: string };
type Step = 'upload' | 'generating' | 'result';

export function SimpleReuse({ templateId, onBack, onEdit, onAllDrafts, onOpenRunInEditor, onOpenTemplate }: {
  templateId: string; onBack: () => void; onEdit: (draftId: string) => void; onAllDrafts: () => void;
  onOpenRunInEditor: (runId: string) => Promise<void>; onOpenTemplate: (id: string) => void;
}) {
  const [template, setTemplate] = useState<ProductView>(), [view, setView] = useState<ReuseStudioView>(), [draft, setDraft] = useState<ReuseDraft>();
  const [pending, setPending] = useState<Pending[]>([]), [step, setStep] = useState<Step>('upload'), [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ stages: string[]; at: number }>({ stages: [], at: 0 });
  const [error, setError] = useState<{ message: string; detail?: string }>(), [note, setNote] = useState(''), [askAi, setAskAi] = useState<'generate' | 'regenerate'>(), [regenMenu, setRegenMenu] = useState(false);
  const [ratio, setRatio] = useState<ReuseAspectRatio>('original'), [moreSizes, setMoreSizes] = useState(false), [dragOver, setDragOver] = useState(false);
  const [full, setFull] = useState(false), [compare, setCompare] = useState(false), [removing, setRemoving] = useState<string>();
  const draftRef = useRef<ReuseDraft | undefined>(undefined), input = useRef<HTMLInputElement>(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  // Escape closes the cost dialog, the full-screen preview and the layout menu.
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; setAskAi(undefined); setFull(false); setRegenMenu(false); };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  const load = useCallback(async (did: string) => {
    const v = await productApi.reuseDraft(templateId, did);
    setView(v); setDraft(v.draft); draftRef.current = v.draft;
    const first = v.draft.ratios[0]; setRatio(first);
    // A creative made before (even if changed since, e.g. in Customize Manually) opens on its review; else the uploads.
    setStep(v.draft.outputs[first] ? 'result' : 'upload');
    return v;
  }, [templateId]);
  // Continue the latest simple draft (a reload loses nothing), or wait for the first upload to start one.
  useEffect(() => {
    void productApi.get(templateId).then(setTemplate).catch(() => undefined);
    void productApi.reuseDrafts(templateId).then(r => { const d = r.drafts.find(x => x.simple); return d ? load(d.id) : undefined; }).catch(e => setError(friendly(e)));
  }, [templateId, load]);
  /** The draft, made on first use (its template products left out). */
  const ensure = async () => {
    if (draftRef.current) return draftRef.current;
    const d = await productApi.createReuseDraft(templateId, { simple: true, name: `${template?.template.name ?? 'Creative'} · new products` });
    const v = await load(d.id); return v.draft;
  };
  /** A change saved to the draft (shown at once). */
  const change = async (patch: Omit<ReuseDraftChange, 'expectedRevision'>, optimistic?: (d: ReuseDraft) => ReuseDraft) => {
    const d = draftRef.current; if (!d) return;
    if (optimistic) setDraft(optimistic(d));
    setSaving(true); setError(undefined);
    try { const next = await productApi.updateReuseDraft(templateId, d.id, { ...patch, expectedRevision: d.revision }); setDraft(next); draftRef.current = next; return next; }
    catch (e) { setError(friendly(e)); await load(d.id).catch(() => undefined); return undefined; }
    finally { setSaving(false); }
  };
  const addFiles = async (files: File[]) => {
    const images = files.filter(f => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name));
    if (!images.length) { setError({ message: 'Please choose product photos (PNG, JPG or WebP).' }); return; }
    const items = images.map(file => ({ key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`, name: file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' '), url: URL.createObjectURL(file), file }));
    setPending(p => [...p, ...items]); setError(undefined); setStep('upload');
    for (const item of items) {
      try {
        const d = await ensure();
        setSaving(true);
        const r = await productApi.reuseUpload(templateId, d.id, item.file, { kind: 'product', label: item.name, expectedRevision: (draftRef.current ?? d).revision }, item.file.name);
        setDraft(r.draft); draftRef.current = r.draft;
        setPending(p => p.filter(x => x.key !== item.key)); URL.revokeObjectURL(item.url);
      } catch (e) { setPending(p => p.map(x => (x.key === item.key ? { ...x, error: friendly(e).message } : x))); }
      finally { setSaving(false); }
    }
  };
  /** Another photo for one product (its name, main-product choice and place in the list are kept). */
  const replace = async (id: string, file?: File) => {
    const d = draftRef.current, item = d?.items.find(i => i.id === id); if (!d || !item || !file) return;
    setSaving(true); setError(undefined);
    try { const r = await productApi.reuseUpload(templateId, d.id, file, { kind: 'product', target: id, label: item.label, expectedRevision: d.revision }, file.name); setDraft(r.draft); draftRef.current = r.draft; }
    catch (e) { setError(friendly(e)); }
    finally { setSaving(false); }
  };
  const products = (draft?.items ?? []).filter(i => i.kind === 'product' && !i.objectId && !i.removed).sort((a, b) => a.order - b.order);
  const chosen = products.filter(i => i.included), hero = draft?.placement.hero ?? null;
  const output = draft?.outputs[ratio], fresh = !!output && output.draftRevision === draft?.revision;
  const plan = draft?.ai.plans[ratio], aiUsed = output?.placement === 'ai' && !!plan && !plan.notes.some(n => n.startsWith('Some AI positions'));
  const ai = view?.placement, aiCost = ai && !ai.offline ? Math.round((draft?.ratios.length ?? 1) * ai.costUsd * 100) / 100 : 0;
  const blocked = (view?.sourceIssues.length ?? 0) > 0;
  /** Generate: each progress line is shown while its real request runs. */
  const run = async (useAi: boolean, nextVariant?: number) => {
    const d = draftRef.current; if (!d) return;
    const stages = useAi ? ['Preparing your products', 'Planning the best arrangement', 'Creating your offer creative'] : ['Preparing your products', 'Arranging and creating your offer creative'];
    setAskAi(undefined); setRegenMenu(false); setError(undefined); setNote(''); setStep('generating'); setProgress({ stages, at: 0 });
    try {
      let current = await change({ placement: { mode: 'geometry', ...(nextVariant !== undefined ? { variant: nextVariant } : {}) } });
      if (!current) throw new Error('Could not prepare the draft.');
      setProgress({ stages, at: 1 });
      if (useAi) {
        try { current = await productApi.reusePlaceWithAi(templateId, current.id, { approveUsd: aiCost }); setDraft(current); draftRef.current = current; }
        catch (e) { setNote(`${friendly(e).message === FRIENDLY.NOT_CONFIGURED ? FRIENDLY.NOT_CONFIGURED : 'AI couldn’t arrange your products this time, so they were arranged automatically.'}`); }
        if (current.ai.failures.length && current.placement.mode !== 'ai') setNote('AI couldn’t arrange your products this time, so they were arranged automatically. Nothing was retried or charged again.');
        setProgress({ stages, at: 2 });
      }
      const done = await productApi.reuseGenerate(templateId, current.id);
      setDraft(done); draftRef.current = done; setRatio(r => (done.ratios.includes(r) ? r : done.ratios[0]));
      setProgress({ stages, at: stages.length }); setStep('result');
    } catch (e) { setError(friendly(e)); setStep('upload'); }
  };
  // Products that fit in the template's own product places stand in them (its own format): no arrangement to plan, so
  // no AI request.
  const anchored = chosen.length > 0 && chosen.length <= (ai?.slots ?? 0) && !!draft?.ratios.every(r => r === 'original');
  const generate = () => { if (anchored) void run(false); else if (ai?.ai && aiCost > 0) setAskAi('generate'); else void run(!!ai?.ai); };
  /** The preview drawn again with every change kept (free: nothing is re-arranged, no AI request). */
  const refresh = async () => {
    const d = draftRef.current; if (!d) return;
    const stages = ['Updating your offer creative'];
    setError(undefined); setStep('generating'); setProgress({ stages, at: 0 });
    try { const done = await productApi.reuseGenerate(templateId, d.id); setDraft(done); draftRef.current = done; setProgress({ stages, at: 1 }); setStep('result'); }
    catch (e) { setError(friendly(e)); setStep('result'); }
  };
  const save = async () => {
    const d = draftRef.current; if (!d) return;
    setSaving(true); setError(undefined);
    try { const next = await productApi.reuseSave(templateId, d.id); setDraft(next); draftRef.current = next; return next; }
    catch (e) { setError(friendly(e)); return undefined; }
    finally { setSaving(false); }
  };
  const saved = !!output?.creativeId && output.savedDraftRevision === draft?.revision;
  const masterPreview = template ? productFileUrl(templateId, template.template.source.inputFile) : undefined;
  const formats = view?.formats ?? [];
  const failed = output?.checks.status === 'failed', notes = output?.checks.issues ?? [], aiSkipped = output?.placement === 'ai' && !aiUsed;
  const startOver = () => { setDraft(undefined); draftRef.current = undefined; setView(undefined); setStep('upload'); setNote(''); setPending([]); };
  const cost = `$${aiCost.toFixed(2)}`;

  return <div className="sr-page">
    <div className="sr-top"><button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />All templates</button>
      <span className="sr-saved" role="status">{saving ? 'Saving…' : draft ? <><Check size={13} aria-hidden="true" />All changes saved</> : ''}</span></div>
    <header className="sr-head"><h2>Create Your Offer Creative</h2>{step === 'upload' && <p>Upload your product photos. AI will arrange them beautifully in your selected template.</p>}</header>
    <CreativeSteps current={step === 'upload' ? 1 : step === 'generating' ? 2 : 3} />
    {blocked && <div className="sr-error" role="alert"><p>This template needs a quick background repair before its products can be replaced.</p><p className="sr-error-sub">Ask your template owner to open it under Offer Templates → Edit master and fix it.</p></div>}
    {error && <div className="sr-error" role="alert"><p>{error.message}</p>{error.detail && error.detail !== error.message && <details><summary>Technical details</summary><p className="ot-small">{error.detail}</p></details>}</div>}
    {note && <p className="sr-note" role="status"><Check size={14} aria-hidden="true" />{note}</p>}

    {step === 'upload' && <div className="sr-layout">
      <section className="sr-main" aria-label="Upload products">
        <div className={`sr-drop${dragOver ? ' is-over' : ''}${products.length || pending.length ? ' is-compact' : ''}`} onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); void addFiles([...e.dataTransfer.files]); }}>
          <span className="sr-drop-icon" aria-hidden="true"><UploadCloud size={26} /></span>
          <div className="sr-drop-text"><strong>Drag your product photos here</strong><span>PNG with a transparent background works best. JPG and WebP work too — add as many as you like.</span></div>
          <button type="button" className="ws-btn ws-btn-primary ws-btn-large" onClick={() => input.current?.click()} disabled={blocked}><ImagePlus size={17} aria-hidden="true" />Upload Products</button>
          <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/webp" aria-label="Upload product photos" hidden onChange={e => { void addFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
        </div>
        {(products.length > 0 || pending.length > 0) && <>
          <div className="sr-row"><h3>Your products <span className="sr-count">{chosen.length} of {products.length} selected</span></h3></div>
          <ul className="sr-products" aria-label="Your products">
            {products.map(p => { const unknown = !!view && !view.knownCategories.includes(p.category);
              return <li key={p.id} className={`sr-product${p.included ? '' : ' is-off'}${hero === p.id ? ' is-hero' : ''}`} aria-label={`Product ${p.label}`}>
                <div className="sr-product-img">
                  <img src={productFileUrl(templateId, p.asset.file)} alt={p.label} />
                  {hero === p.id && <span className="sr-badge"><Star size={12} aria-hidden="true" />Main product</span>}
                  <label className="sr-include"><input type="checkbox" checked={p.included} aria-label={`Use ${p.label}`} onChange={e => void change({ items: [{ id: p.id, included: e.target.checked }] }, d => ({ ...d, items: d.items.map(i => (i.id === p.id ? { ...i, included: e.target.checked } : i)) }))} />{p.included ? 'Included' : 'Not included'}</label>
                </div>
                <input className="sr-name" value={p.label} maxLength={60} aria-label="Product name" onChange={e => setDraft(d => (d ? { ...d, items: d.items.map(i => (i.id === p.id ? { ...i, label: e.target.value } : i)) } : d))} onBlur={e => void change({ items: [{ id: p.id, label: e.target.value }] })} />
                {unknown && <select className="sr-kind" aria-label={`What is ${p.label}?`} value="" onChange={e => void change({ items: [{ id: p.id, category: e.target.value }] })}><option value="">What is it? (helps sizing)</option>{KIND_CHOICES.map(k => <option key={k} value={k}>{k}</option>)}</select>}
                <button type="button" className={`ws-btn sr-star${hero === p.id ? ' is-on' : ''}`} aria-pressed={hero === p.id} onClick={() => void change({ placement: { hero: hero === p.id ? null : p.id } }, d => ({ ...d, placement: { ...d.placement, hero: hero === p.id ? null : p.id } }))}><Star size={14} aria-hidden="true" />{hero === p.id ? 'Main product' : 'Make main product'}</button>
                <div className="sr-product-actions">
                  <label className="ws-btn ws-btn-quiet sr-replace"><RefreshCw size={14} aria-hidden="true" />Replace<input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`Replace ${p.label}`} onChange={e => { void replace(p.id, e.target.files?.[0]); e.target.value = ''; }} /></label>
                  <button type="button" className="ws-btn ws-btn-quiet sr-remove" aria-label={`Remove ${p.label}`} onClick={() => setRemoving(p.id)}><Trash2 size={14} aria-hidden="true" />Remove</button>
                </div>
                {removing === p.id && <div className="sr-confirm-remove" role="group" aria-label={`Remove ${p.label}?`}><span>Remove this product?</span>
                  <button type="button" className="ws-btn sr-danger" onClick={() => { setRemoving(undefined); void change({ items: [{ id: p.id, removed: true }] }, d => ({ ...d, items: d.items.map(i => (i.id === p.id ? { ...i, removed: true, included: false } : i)) })); }}>Remove</button>
                  <button type="button" className="ws-btn ws-btn-quiet" autoFocus onClick={() => setRemoving(undefined)}>Keep</button></div>}
              </li>; })}
            {pending.map(p => <li key={p.key} className={`sr-product ${p.error ? 'is-error' : 'is-uploading'}`} aria-label={`Uploading ${p.name}`}><div className="sr-product-img"><img src={p.url} alt={p.name} /></div><span className="sr-name">{p.name}</span>
              {p.error ? <><p className="sr-err">{p.error}</p><div className="sr-product-actions"><button type="button" className="ws-btn ws-btn-quiet" onClick={() => { setPending(x => x.filter(y => y.key !== p.key)); void addFiles([p.file]); }}>Try again</button><button type="button" className="ws-icon-button" aria-label={`Remove ${p.name}`} onClick={() => setPending(x => x.filter(y => y.key !== p.key))}><X size={15} /></button></div></>
                : <p className="sr-uploading" role="status"><span className="sr-dot-spin" aria-hidden="true" />Uploading…</p>}</li>)}
            <li className="sr-add-tile"><button type="button" onClick={() => input.current?.click()} disabled={blocked}><ImagePlus size={20} aria-hidden="true" />Add more photos</button></li>
          </ul>
          <p className="sr-hint">{hero ? 'Your main product stands in the middle; the others are grouped around it.' : 'AI picks the main product — or choose one with Make main product.'} The template’s own products are left out; Ganesh Ji, the festive design, text and logos stay as they are.</p>
        </>}
      </section>
      <aside className="sr-aside" aria-label="Your template">
        {masterPreview && <figure className="sr-template"><img src={masterPreview} alt={`Template ${template?.template.name ?? ''}`} /><figcaption><span>Your template</span><strong>{template?.template.name}</strong></figcaption></figure>}
        <p className="sr-aside-links"><button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={onBack}>Choose another template</button><br /><button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={onAllDrafts}>All creatives from this template</button></p>
        {draft && <div className="sr-size"><span>Size</span><strong>{formats.filter(f => draft.ratios.includes(f.ratio)).map(f => f.label).join(', ') || 'Original size'}</strong>
          <button type="button" className="ws-btn ws-btn-quiet" aria-expanded={moreSizes} onClick={() => setMoreSizes(v => !v)}>{moreSizes ? 'Done' : 'More sizes'}<ChevronDown size={14} aria-hidden="true" /></button></div>}
        {moreSizes && <div className="sr-formats" role="group" aria-label="Sizes">{formats.map(f => { const on = !!draft?.ratios.includes(f.ratio);
          return <button key={f.ratio} type="button" className={`sr-format${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => { const next = REUSE_ASPECT_RATIOS.filter(r => (r === f.ratio ? !on : draft?.ratios.includes(r))); if (next.length) void change({ ratios: next }, d => ({ ...d, ratios: next })); }}>
            <span className="sr-shape" style={{ aspectRatio: `${f.canvas.width} / ${f.canvas.height}` }} aria-hidden="true" />{f.label}</button>; })}</div>}
      </aside>
      {(products.length > 0 || pending.length > 0) && <div className="sr-cta-bar">
        <p><strong>{chosen.length} product{chosen.length === 1 ? '' : 's'}</strong> ready to arrange{pending.some(p => !p.error) ? ' · finishing uploads…' : ''}</p>
        <div className="sr-cta-actions">{fresh && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setStep('result')}>See your creative</button>}
          <button type="button" className="ws-btn ws-btn-primary ws-btn-large sr-generate" disabled={!chosen.length || pending.some(p => !p.error) || blocked} onClick={generate}><Sparkles size={17} aria-hidden="true" />Generate Creative</button></div>
      </div>}
    </div>}

    {step === 'generating' && <section className="sr-working" aria-label="Generating" aria-busy="true">
      <span className="sr-spinner" aria-hidden="true" />
      <h3>Creating your offer creative</h3>
      <ol className="sr-progress">{progress.stages.map((s, i) => <li key={s} className={i < progress.at ? 'is-done' : i === progress.at ? 'is-current' : ''} aria-current={i === progress.at ? 'step' : undefined}>
        <span aria-hidden="true">{i < progress.at ? <Check size={13} /> : i === progress.at ? <span className="sr-dot-spin" /> : null}</span>{s}{i === progress.at ? '…' : ''}</li>)}</ol>
      <p className="sr-status" role="status">{progress.stages[progress.at] ? `${progress.stages[progress.at]}…` : 'Your creative is ready!'}</p>
      <p className="sr-hint">Your photos and choices are saved. You can keep this page open.</p>
    </section>}

    {step === 'result' && draft && <section className="sr-result" aria-label="Your creative">
      <div className="sr-stage">
        <div className="sr-stage-bar">
          {output && <span className={`sr-chip${aiUsed ? ' is-ai' : ''}`}>{aiUsed ? <><Sparkles size={13} aria-hidden="true" />Products arranged by AI</> : 'Products arranged automatically'}</span>}
          {draft.ratios.length > 1 && <div className="sr-tabs" role="tablist" aria-label="Sizes">{draft.ratios.map(r => <button key={r} type="button" role="tab" aria-selected={ratio === r} onClick={() => setRatio(r)}>{formats.find(f => f.ratio === r)?.label ?? r}</button>)}</div>}
          <span className="sr-spacer" />
          {masterPreview && output && <button type="button" className="ws-btn ws-btn-quiet" aria-pressed={compare} onClick={() => setCompare(v => !v)}><Columns2 size={15} aria-hidden="true" />{compare ? 'Hide template' : 'Compare with template'}</button>}
          {output && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setFull(true)}><Maximize2 size={15} aria-hidden="true" />Full screen</button>}
        </div>
        {output && !fresh && <div className="sr-banner" role="status"><p>You changed your creative since this preview was made.</p><button type="button" className="ws-btn ws-btn-primary" onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />Update preview</button></div>}
        {output ? <div className={`sr-posters${compare ? ' is-compare' : ''}`}>
          {compare && masterPreview && <figure className="sr-poster"><img src={masterPreview} alt="The original template" /><figcaption>Original template</figcaption></figure>}
          <figure className="sr-poster"><img src={productFileUrl(templateId, output.preview)} alt="Your finished creative" />{compare && <figcaption>Your creative</figcaption>}</figure>
        </div> : <p className="sr-hint">Generate this size to see it.</p>}
      </div>
      <aside className="sr-panel">
        <h3>{failed ? 'Almost there' : 'Your creative is ready!'}</h3>
        <p className="sr-panel-lead">{failed ? FRIENDLY.NOT_READY : saved ? 'It’s saved to your creatives — you can use it as it is.' : 'Take a look. Save it when you’re happy, or adjust it first.'}</p>
        <button type="button" className={`ws-btn ws-btn-large sr-save${saved ? ' is-saved' : ' ws-btn-primary'}`} disabled={saving || saved || !fresh || failed} onClick={() => void save()}>{saved ? <><Check size={17} aria-hidden="true" />Saved</> : <><Save size={17} aria-hidden="true" />{saving ? 'Saving…' : 'Save Creative'}</>}</button>
        {!saved && !failed && <p className="sr-hint sr-center">After saving, you can turn it into editable layers.</p>}
        <p className="sr-group-label">Quick changes</p>
        <div className="sr-two">
          <button type="button" className="ws-btn" onClick={() => onEdit(draft.id)}><Pencil size={15} aria-hidden="true" />Customize Manually</button>
          <div className="sr-regen"><button type="button" className="ws-btn" aria-expanded={regenMenu} aria-haspopup="menu" disabled={anchored} title={anchored ? 'Your products stand in the template’s own product places, so there is no other layout to try.' : undefined} onClick={() => setRegenMenu(v => !v)}><RefreshCw size={15} aria-hidden="true" />Regenerate Layout</button>
            {regenMenu && <div className="sr-menu" role="menu"><button type="button" role="menuitem" onClick={() => void run(false, (draft.placement.variant ?? 0) + 1)}><LayoutGrid size={15} aria-hidden="true" /><span><strong>Try another layout</strong><small>Free · arranged automatically</small></span></button>
              {ai?.ai && <button type="button" role="menuitem" onClick={() => (aiCost > 0 ? setAskAi('regenerate') : void run(true))}><Sparkles size={15} aria-hidden="true" /><span><strong>Ask AI for a new arrangement</strong><small>{aiCost > 0 ? `About ${cost} · you’ll confirm first` : 'Free'}</small></span></button>}</div>}</div>
        </div>
        {saved && output && fresh && <EditYourCreative templateId={templateId} draftId={draft.id} ratio={ratio} output={output} onOpenRunInEditor={onOpenRunInEditor} onOpenTemplate={onOpenTemplate} />}
        {(notes.length > 0 || aiSkipped) && <details className="sr-more"><summary>Notes on this creative ({notes.length + (aiSkipped ? 1 : 0)})</summary><ul>
          {aiSkipped && <li>AI’s suggested layout didn’t pass our quality checks, so FrameFlow arranged your products itself. You weren’t charged again.</li>}
          {notes.map((i, k) => <li key={k} className={i.blocking ? 'is-blocking' : ''}>{i.message}</li>)}</ul></details>}
        <p className="sr-links"><button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={() => setStep('upload')}>Change products</button> · <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={onAllDrafts}>All creatives from this template</button> · <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={startOver}>Start over</button></p>
      </aside>
    </section>}

    {askAi && <div className="sr-modal-backdrop" onClick={() => setAskAi(undefined)}>
      <div className="sr-modal" role="dialog" aria-modal="true" aria-labelledby="sr-cost-title" onClick={e => e.stopPropagation()}>
        <span className="sr-modal-icon" aria-hidden="true"><Sparkles size={22} /></span>
        <h3 id="sr-cost-title">{askAi === 'generate' ? 'Arrange Products with AI' : 'Ask AI for a New Arrangement'}</h3>
        <p>AI will analyze your products and create a professional layout{askAi === 'regenerate' ? ' — a new one, with your photos reused' : ''}.</p>
        <dl className="sr-cost">
          <div><dt>Estimated cost</dt><dd><strong>{cost}</strong></dd></div>
          <div><dt>What runs</dt><dd>{draft && draft.ratios.length > 1 ? `${draft.ratios.length} new paid OpenAI requests (one per size)` : 'One new paid OpenAI request'}</dd></div>
          <div><dt>You get</dt><dd>Your products arranged on the template, ready to review. Nothing is saved until you click Save.</dd></div>
        </dl>
        <div className="sr-modal-actions">
          <button type="button" className="ws-btn ws-btn-primary ws-btn-large" autoFocus onClick={() => void run(true)}><Sparkles size={16} aria-hidden="true" />{askAi === 'generate' ? 'Approve & Generate' : 'Approve & Regenerate'}</button>
          {askAi === 'generate' && <button type="button" className="ws-btn ws-btn-large" onClick={() => void run(false)}>Arrange Automatically (Free)</button>}
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setAskAi(undefined)}>Cancel</button>
        </div>
      </div>
    </div>}

    {full && output && <div className="sr-lightbox" role="dialog" aria-modal="true" aria-label="Full-screen preview" onClick={() => setFull(false)}>
      <button type="button" className="sr-lightbox-close" aria-label="Close full-screen preview" autoFocus onClick={() => setFull(false)}><X size={20} /></button>
      <img src={productFileUrl(templateId, output.preview)} alt="Your finished creative, full screen" onClick={e => e.stopPropagation()} />
    </div>}
  </div>;
}
