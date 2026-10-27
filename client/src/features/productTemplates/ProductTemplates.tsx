/**
 * Product with Text templates: an offer creative with products, characters, text and logos, made into a reusable layered
 * template once, then reused.
 *
 *   Create   Upload (choose one creative of a sheet) → Review (what was found) → Prepare (text and logos out, each object
 *            cut out, the background rebuilt, checked) → Save (a new version of the template)
 *   Reuse    ProductTemplatePage: new creatives, products and characters replaced in their slots, text and logos edited,
 *            variations; each opens in the editor with every element its own layer
 *
 * The original upload is kept unchanged. Nothing is sent to a paid service unless the person turns it on after seeing its cost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crop, Image as ImageIcon, Package, Plus, Recycle, Sparkles, Upload } from 'lucide-react';
import type { PixelRect, ProductDetection, ProductStage } from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { productApi, productFileUrl, type ProductListItem, type ProductView, type SheetAnswer } from './api';
import { ProductReview } from './ProductReview';
import { ProductPrepare } from './ProductPrepare';
import { ProductSelect } from './ProductSelect';
import { ProductTemplatePage } from './ProductTemplatePage';
import { ReuseStudio } from './ReuseStudio';
import './productTemplates.css';

/** One AI detection request, as its confirmation states it (the answer is capped at 16,000 output tokens: at most about $0.35). */
const AI_REQUEST_COST = 'Estimated cost: up to about $0.35 (the answer is capped at 16,000 output tokens; one 607 × 606 creative cost $0.22).';
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
/**
 * Why the AI detection did not complete, in its own words, with what was sent and how long it waited: never a local
 * reading presented as a finished detection.
 */
function AiDetectionFailed({ detection, onUseSaved }: { detection?: ProductDetection; onUseSaved?: () => void }) {
  const ai = detection?.ai, answered = !!ai && (ai.costUsd ?? 0) > 0;
  return <Alert>
    <strong>AI detection did not complete{ai?.code ? ` (${ai.code})` : ''}.</strong>{' '}
    {answered ? <>OpenAI did answer (this request was billed, about ${(ai.costUsd ?? 0).toFixed(2)}), but FrameFlow could not use the answer: {ai.error ?? 'it did not pass the checks.'} </> : ai?.error ?? detection?.error ?? 'No answer was received.'}
    {ai && (ai.sent || ai.elapsedMs !== undefined || ai.httpStatus) && <span className="prt-ai-facts">
      {ai.model && <>Model {ai.model}. </>}
      {ai.sent && <>Sent: a {ai.sent.width} × {ai.sent.height} {ai.sent.mime === 'image/jpeg' ? 'JPEG' : 'PNG'} ({mb(ai.sent.bytes)}){ai.sent.width !== ai.sent.source.width || ai.sent.height !== ai.sent.source.height ? `, from your ${ai.sent.source.width} × ${ai.sent.source.height} creative` : ''}. </>}
      {ai.elapsedMs !== undefined && <>Waited {Math.round(ai.elapsedMs / 1000)} s. </>}
      {ai.httpStatus ? <>HTTP {ai.httpStatus}.</> : null}
    </span>}
    <span className="prt-ai-facts">This attempt did not complete detection. The source image and any previous detections and corrections are retained.</span>
    {onUseSaved && <span className="prt-ai-facts"><button type="button" className="ws-btn ws-btn-primary" onClick={onUseSaved}>Recover saved analysis for this image (free)</button> Only a completed answer with verified image identity is accepted.</span>}
  </Alert>;
}

export const PRODUCT_STAGE_LABELS: Record<ProductStage, string> = {
  detecting: 'Finding elements', 'detect-failed': 'Needs another try', review: 'Ready to review', preparing: 'Preparing', prepared: 'Ready to approve', ready: 'Saved', changed: 'Changed since saved',
};
export type ProductRequest = { view: 'new' } | { view: 'setup'; id: string; choose?: boolean } | { view: 'template'; id: string; tab?: 'creatives' | 'variations' | 'details' } | { view: 'reuse'; id: string };
type Props = {
  onOpenRun?: (runId: string) => Promise<void>;
  request: ProductRequest; onBack: () => void;
  /** A creative's run opened in the editor (each element its own layer). */
  onOpenRunInEditor: (runId: string) => Promise<void>;
};

export function ProductTemplates({ request, onBack, onOpenRunInEditor, onOpenRun }: Props) {
  const [view, setView] = useState<ProductRequest>(request);
  if (view.view === 'new') return <ProductUpload onCancel={onBack} onCreated={id => setView({ view: 'setup', id })} />;
  if (view.view === 'reuse') return <ReuseStudio key={view.id} templateId={view.id} onBack={onBack} onOpenRunInEditor={onOpenRunInEditor} onOpenTemplate={id => setView({ view: 'setup', id })} />;
  if (view.view === 'setup') return <ProductSetup key={`${view.id}-${view.choose ? 'choose' : ''}`} id={view.id} initialChoosing={view.choose} onBack={onBack} onUse={id => setView({ view: 'template', id })} onOpenRunInEditor={onOpenRunInEditor} />;
  return <ProductTemplatePage onOpenRun={onOpenRun} key={view.id} id={view.id} initialTab={view.tab} onOpenTemplate={id => setView({ view: 'setup', id })} onChangeSelection={() => setView({ view: 'setup', id: view.id, choose: true })} onBack={onBack} onEditTemplate={() => setView({ view: 'setup', id: view.id })} onOpenRunInEditor={onOpenRunInEditor} />;
}

/** The saved Product with Text templates, for the Offer Templates library. */
export function ProductLibrary({ onNew, onSetup, onUse, onGenerate, onReuse }: { onNew: () => void; onSetup: (id: string) => void; onUse: (id: string) => void; onGenerate: (id: string) => void; onReuse?: (id: string) => void }) {
  const [templates, setTemplates] = useState<ProductListItem[]>(), [error, setError] = useState('');
  useEffect(() => { void productApi.list().then(r => setTemplates(r.templates)).catch((e: Error) => setError(e.message)); }, []);
  return <section className="prt-library" aria-labelledby="prt-library-title">
    <div className="ot-head"><div><p className="ot-kicker">Offer templates · Product with Text</p><h2 id="prt-library-title">Product templates</h2>
      <p>Upload a creative with products once. FrameFlow separates its products, characters, text and logos into layers, so you can swap products and edit the offer again and again.</p></div>
      <button type="button" className="ws-btn" onClick={onNew}><Plus size={15} aria-hidden="true" />New product template</button></div>
    {error && <Alert>{error}</Alert>}
    {!templates ? <p className="ot-muted" role="status">Loading…</p> : !templates.length ? <p className="ot-muted">No product templates yet.</p>
      : <div className="ot-grid">{templates.map(t => <article key={t.id} className="ot-card" aria-label={`Product template ${t.name}`}>
        <img src={productFileUrl(t.id, t.source.inputFile)} alt="" loading="lazy" />
        <div className="ot-card-body">
          <h3>{t.name}</h3>
          <div className="ot-row"><Badge tone={t.stage === 'ready' ? 'ok' : t.stage === 'detect-failed' ? 'danger' : 'neutral'}>{PRODUCT_STAGE_LABELS[t.stage]}</Badge>{t.draft && <Badge tone="warn">Draft · quality warnings</Badge>}
            <span className="ot-small ot-muted">{t.counts.products} product{t.counts.products === 1 ? '' : 's'} · {t.counts.characters} character{t.counts.characters === 1 ? '' : 's'} · {t.counts.text} text</span></div>
          <div className="ot-row">
            {t.revisions > 0 && <button type="button" className="ws-btn ws-btn-primary" onClick={() => onUse(t.id)}>Use template</button>}
            {/* The saved template's Generate with AI: 3–5 variations, their sizes and artwork; paid only after its cost is confirmed. */}
            {t.revisions > 0 && <button type="button" className="ws-btn" onClick={() => onGenerate(t.id)}><Sparkles size={14} aria-hidden="true" />Generate AI Variations</button>}
            {/* Reuse Template: the person's own product set, copy and formats (separate from variations). */}
            {t.revisions > 0 && onReuse && <button type="button" className="ws-btn" onClick={() => onReuse(t.id)}><Recycle size={14} aria-hidden="true" />Reuse Template</button>}
            <button type="button" className="ws-btn" onClick={() => onSetup(t.id)}>{t.revisions > 0 ? 'Edit master' : 'Continue setup'}</button>
          </div>
        </div>
      </article>)}</div>}
  </section>;
}

export function Steps({ current }: { current: 1 | 2 | 3 | 4 | 5 }) {
  const steps = ['Upload', 'Review', 'Choose', 'Decompose', 'Save'];
  return <ol className="ot-steps" aria-label="Steps">{steps.map((s, i) => <li key={s} className={i + 1 === current ? 'is-current' : i + 1 < current ? 'is-done' : ''} aria-current={i + 1 === current ? 'step' : undefined}>
    <span>{i + 1 < current ? <Check size={12} aria-hidden="true" /> : i + 1}</span>{s}</li>)}</ol>;
}

/** Step 1: the creative, its name, one creative of a sheet, and whether the AI finds characters and products. */
function ProductUpload({ onCancel, onCreated }: { onCancel: () => void; onCreated: (id: string) => void }) {
  const [file, setFile] = useState<File>(), [name, setName] = useState(''), [sheet, setSheet] = useState<SheetAnswer>(), [crop, setCrop] = useState<PixelRect | null>(null);
  const [useAi, setUseAi] = useState(false), [busy, setBusy] = useState<'' | 'reading' | 'uploading'>(''), [error, setError] = useState('');
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const choose = async (f?: File) => {
    setFile(f); setSheet(undefined); setCrop(null); setError('');
    if (!f) return;
    if (!name) setName(f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ').slice(0, 80));
    setBusy('reading');
    try { const s = await productApi.sheet(f); setSheet(s); setCrop(s.sheet ? s.boxes[0] : null); }
    catch (e) { setError(e instanceof Error ? e.message : 'The picture could not be read.'); }
    finally { setBusy(''); }
  };
  const create = async () => {
    if (!file) return;
    setBusy('uploading'); setError('');
    try { const v = await productApi.create(file, { name: name.trim() || 'Product template', crop: crop ?? undefined, useAi }); onCreated(v.template.id); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not create the template.'); setBusy(''); }
  };
  return <div className="ot-page">
    <div className="ot-head"><div><p className="ot-kicker">New product template</p><h2>Upload your creative</h2>
      <p>Use a finished offer creative with its products, characters, text and logos. It is kept exactly as uploaded; FrameFlow works on a copy.</p></div>
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onCancel}>Cancel</button></div>
    <Steps current={1} />
    {error && <Alert>{error}</Alert>}
    <section className="ts-card"><div className="ts-card-body prt-upload">
      <div className="prt-upload-form">
        <label className="ff-lab-upload"><strong>{file?.name ?? 'Choose the creative (PNG, JPEG or WebP)'}</strong><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Creative to upload" onChange={e => void choose(e.target.files?.[0])} /></label>
        <label className="ot-field"><span>Template name</span><input value={name} maxLength={120} placeholder="Festive appliance offer" aria-label="Template name" onChange={e => setName(e.target.value)} /></label>
        <label className="prt-option"><input type="checkbox" checked={useAi} onChange={e => setUseAi(e.target.checked)} />
          <span><strong>Find characters and products with AI</strong>Reuse a verified saved analysis first, free. If none exists, this authorizes one OpenAI request (estimated up to about $0.35). OpenAI stores the response for recovery. Without approval, only saved analysis or local text candidates are used.</span></label>
        <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={!file || !!busy} onClick={() => void create()}>
          <Upload size={15} aria-hidden="true" />{busy === 'uploading' ? 'Uploading…' : busy === 'reading' ? 'Reading the picture…' : 'Upload and find elements'}</button></div>
        <p className="ot-muted">Next you check what was found, then FrameFlow prepares the layers and you save the template.</p>
      </div>
      {preview && <div className="prt-upload-preview">
        {sheet?.sheet ? <>
          <p className="prt-sheet-note"><Crop size={15} aria-hidden="true" />This picture has {sheet.boxes.length} creatives. Choose the one to make a template of.</p>
          <div className="prt-sheet" role="radiogroup" aria-label="Creatives on the sheet">
            {sheet.boxes.map((b, i) => <button key={i} type="button" role="radio" aria-checked={crop === b} className="prt-sheet-item" onClick={() => setCrop(b)} aria-label={`Creative ${i + 1}, ${b.width} by ${b.height} pixels`}>
              <SheetCrop url={preview} sheet={sheet} box={b} /><span>Creative {i + 1}</span></button>)}
            <button type="button" role="radio" aria-checked={crop === null} className="prt-sheet-item is-whole" onClick={() => setCrop(null)}><ImageIcon size={22} aria-hidden="true" /><span>The whole picture</span></button>
          </div>
        </> : <img src={preview} alt="Creative preview" className="prt-upload-image" />}
      </div>}
    </div></section>
  </div>;
}
function SheetCrop({ url, sheet, box }: { url: string; sheet: SheetAnswer; box: PixelRect }) {
  const size = 132, s = size / Math.max(box.width, box.height);
  return <span className="prt-crop" style={{ width: box.width * s, height: box.height * s, backgroundImage: `url(${url})`, backgroundSize: `${sheet.width * s}px ${sheet.height * s}px`, backgroundPosition: `${-box.x * s}px ${-box.y * s}px` }} aria-hidden="true" />;
}

/** Steps 2–4 of one template, by its stage (detecting and preparing are waited for). */
function ProductSetup({ id, onBack, onUse, initialChoosing, onOpenRunInEditor }: { id: string; onBack: () => void; onUse: (id: string) => void; initialChoosing?: boolean; onOpenRunInEditor?: (runId: string) => Promise<void> }) {
  const [view, setView] = useState<ProductView>(), [error, setError] = useState(''), [reviewing, setReviewing] = useState(false), [choosing, setChoosing] = useState(!!initialChoosing), [retryAi, setRetryAi] = useState(false);
  const [inspecting, setInspecting] = useState(false), [opening, setOpening] = useState(false), [fitted, setFitted] = useState(0);
  const live = useRef(true);
  const load = useCallback(async () => { const v = await productApi.get(id); if (live.current) setView(v); return v; }, [id]);
  useEffect(() => { live.current = true; void load().catch((e: Error) => setError(e.message)); return () => { live.current = false; }; }, [load]);
  const waiting = view?.stage === 'detecting' || view?.stage === 'preparing';
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 1200);
    return () => clearInterval(timer);
  }, [waiting, load]);
  if (error && !view) return <div className="ot-page"><Alert>{error}</Alert><button type="button" className="ws-btn" onClick={onBack}>Back</button></div>;
  if (!view) return <div className="ot-page"><p className="ot-muted" role="status">Loading…</p></div>;
  const useSaved = () => void productApi.detect(id, { force: true, useAi: false, savedAnswer: true }).then(r => { setError(''); setView(r.template); }).catch((e: Error) => setError(e.message));
  const retrieve = () => void productApi.detect(id, { force: true, useAi: false, recover: true }).then(r => { setError(''); setView(r.template); }).catch((e: Error) => setError(e.message));
  const recovery = view.recovery?.retrievable && <p><button type="button" className="ws-btn ws-btn-primary" onClick={retrieve}>Retrieve existing request (no new detection charge)</button> The saved response ID is reused; no new analysis is submitted.</p>;
  const from = view.product.variation;
  const head = (step: 1 | 2 | 3 | 4 | 5, title: string, text: string) => <><div className="ot-head"><div><p className="ot-kicker">{view.template.name}</p><h2>{title}</h2><p>{text}</p></div>
    <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}>Back to templates</button></div><Steps current={step} />{error && <Alert>{error}</Alert>}{view.product.detection?.lastFailure && <Alert>{view.product.detection.lastFailure.message} Your previous successful analysis is still available.</Alert>}
    {from && <div className="prt-note prt-journey" role="status" data-testid="from-variation"><strong>Edit Individual Elements</strong>
      <ol><li>Check what we found in your creative <span>(free)</span></li><li>Separate it into layers with AI <span>(you’ll approve the cost first)</span></li><li>Open it in the editor to move, resize and edit</li></ol>
      <details><summary>Details</summary>Made from the generated variation “{from.title}”. Its elements and editable words come from its saved composition (no new detection charge). Review the selection, approve OpenAI + Seedream decomposition, then inspect the returned layers.</details></div>}</>;
  const openInEditor = async () => { if (opening) return; setOpening(true); setError(''); try { const r = await productApi.openEditor(id); setView(r.template); await onOpenRunInEditor?.(r.runId); } catch (e) { setError(e instanceof Error ? e.message : 'Could not open it in the editor.'); } finally { setOpening(false); } };
  if (view.stage === 'detecting') return <div className="ot-page">{head(2, 'Finding what is in your creative', 'Reading the text and logos on this computer' + (view.product.detection?.ai?.status === 'skipped' ? '.' : ', and asking the AI for the characters and products.'))}
    <Waiting label="Finding text, logos, products and characters…" /><p>You can return from the template library after refreshing. The saved request can be retrieved without submitting detection again.</p></div>;
  if (view.stage === 'detect-failed') return <div className="ot-page">{head(2, 'Finding the elements did not finish', 'Nothing was lost: your creative is stored unchanged.')}
    <AiDetectionFailed detection={view.product.detection} onUseSaved={useSaved} />{recovery}
    {/* Characters and products need the AI analysis: a free retry reads the text only and cannot complete detection. */}
    {retryAi ? <section className="ts-card"><div className="ts-card-body"><p>Authorize one new OpenAI vision analysis request if no matching saved answer exists. {AI_REQUEST_COST} An earlier timed-out request may still finish and be billed; try recovery first. Nothing is retried automatically.</p>
      <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={() => void productApi.detect(id, { force: true, useAi: true, newRequest: true }).then(r => { setRetryAi(false); setView(r.template); }).catch((e: Error) => setError(e.message))}>Approve one AI detection request</button>
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setRetryAi(false)}>Cancel</button></div></div></section>
      : <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={() => setRetryAi(true)}>Try again with AI…</button>
        <button type="button" className="ws-btn ws-btn-quiet" onClick={() => void productApi.detect(id, { force: true, useAi: false }).then(r => setView(r.template)).catch((e: Error) => setError(e.message))}>Read the text only (free)</button></div>}
    <p className="ot-muted">Reading the text only is free, but characters and products can only be found by the AI analysis, so the template cannot be prepared without it.</p></div>;
  if (view.stage === 'preparing') return <div className="ot-page">{head(4, 'Decomposing your creative', 'Taking out the text and logos, cutting out each chosen element, and rebuilding the background behind them.')}
    <Waiting label={view.product.preparing?.engine === 'ai' ? 'Decomposing with AI (OpenAI planner, then Seedream Layerize)… this can take a minute or two.' : view.product.preparing?.paid ? 'Preparing with the cut-out service…' : 'Preparing on this computer…'} /></div>;
  // Review: found elements to check (also when asked to change them, or when the saved template changed and is not prepared).
  const aiDone = view.product.detection?.ai?.status === 'done', added = view.counts.characters + view.counts.products;
  // Choose what to decompose (after the review is saved).
  if (choosing && (view.stage === 'review' || view.stage === 'changed' || view.stage === 'prepared' || view.stage === 'ready')) return <div className="ot-page prt-page-wide">{head(3, 'Choose what to decompose', 'Tick each element that should become an image layer of its own. Unticked ones stay part of the background picture.')}
    <ProductSelect view={view} onBack={() => { setChoosing(false); setReviewing(true); }} onStarted={v => { setChoosing(false); setReviewing(false); setView(v); }} onError={setError} /></div>;
  if (reviewing || view.stage === 'review' || view.stage === 'changed') return <div className="ot-page prt-page-wide">{aiDone ? head(2, "Here’s what we found", 'Each box is one element. Fix anything that looks wrong, then prepare the template. Items that need a look are listed first.')
      : head(2, 'AI detection did not complete', 'Local candidates are retained. Recover a saved response or approve a new AI analysis before preparation.')}
    {view.product.preparing?.status === 'failed' && <Alert>{view.product.preparing.error}</Alert>}
    {aiDone && view.counts.words > 0 && <FitText view={view} onDone={v => { setView(v); setFitted(n => n + 1); }} onError={setError} />}
    {aiDone ? <p>{view.counts.characters} Characters · {view.counts.products} Products · {view.counts.words} Text words · {view.counts.text} Text groups · {view.counts.logos} Logos
      {(view.product.detection?.ai?.costUsd ?? 0) > 0 && <> <button type="button" className="ws-btn ws-btn-quiet" onClick={useSaved}>Find the elements again from the saved AI answer (free; your corrections are kept)</button></>}</p>
      : <p data-testid="local-only-counts">Read on this computer, without AI: {view.counts.words} Text words · {view.counts.text} Text groups · {view.counts.logos} Logos. Characters and products: {added ? `${added} added by you` : 'not detected'}.</p>}
    {!aiDone && <><AiDetectionFailed detection={view.product.detection} onUseSaved={useSaved} />{recovery}
      <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" onClick={() => setRetryAi(true)}>Retry AI analysis…</button></div></>}
    {aiDone && added === 0 && <Alert>Object detection needs attention: no characters or products were found. Retry analysis or correct the result.
      <button type="button" className="ws-btn" onClick={() => setRetryAi(true)}>Retry AI analysis</button></Alert>}
    {retryAi && <section className="ts-card"><p>Authorize one new OpenAI vision analysis request if no matching saved answer exists. {AI_REQUEST_COST} An earlier timed-out request may still finish and be billed; try recovery first. Nothing is retried automatically.</p>
      <button type="button" className="ws-btn" onClick={() => void productApi.detect(id, { force: true, useAi: true, newRequest: true }).then(r => { setRetryAi(false); setView(r.template); }).catch((e: Error) => setError(e.message))}>Approve one AI detection request</button>
      <button type="button" className="ws-btn" onClick={() => setRetryAi(false)}>Cancel</button></section>}
    {view.product.detection?.ai?.offline && <p role="status">Offline fixture detections — not verified AI provider results.</p>}
    {view.product.detection?.ai?.model?.includes('(recorded answer') && <p role="status">A recorded AI answer for this exact image, replayed: no new AI request was made.</p>}
    <ProductReview key={`${view.product.objectsRevision}:${fitted}`} view={view} onSaved={async (v, next) => { setView(v); if (next) { setReviewing(false); setChoosing(true); } }} onError={setError} /></div>;
  if (view.stage === 'prepared' || inspecting) return <div className="ot-page prt-page-wide">{head(4, 'Inspect the layers and the background', 'Compare it with your original, look at each layer and at the background on its own, then save it as your master template.')}
    {view.product.editorDraft && <p className="ot-muted">These checks describe the original separation. Open in Editor to inspect and continue your saved editing draft. Opening it does not approve quality.</p>}
    {view.product.revisions.length > 0 && <button type="button" className="ws-btn" onClick={() => onUse(id)}>Use a saved revision</button>}
    <ProductPrepare view={view} onChange={setView} onError={setError} onBackToReview={() => setReviewing(true)} onChangeSelection={() => setChoosing(true)} onOpenEditor={onOpenRunInEditor ? openInEditor : undefined} /></div>;
  // Saved.
  const latest = view.product.revisions.at(-1);
  return <div className="ot-page">{head(5, 'Your template is saved', `Version ${latest?.revision ?? 1} is ready to use. Earlier versions stay as they were.`)}
    <section className="ts-card"><div className="ts-card-body prt-done">
      <img src={productFileUrl(id, view.product.prepared?.previews.recombined ?? view.template.source.inputFile)} alt="The saved template, its layers over each other" />
      <div className="prt-done-text"><h3><Check size={18} aria-hidden="true" /> {view.counts.products} products, {view.counts.characters} character{view.counts.characters === 1 ? '' : 's'}, {view.counts.text} text blocks and {view.counts.logos} logos, each its own layer</h3>
        <p className="ot-muted">Use the template to swap products, change the offer and make variations. Each creative opens in the editor with every element editable.</p>
        <div className="ot-row">{onOpenRunInEditor && <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={opening} onClick={() => void openInEditor()}>{opening ? 'Opening…' : 'Open in Editor'}</button>}
          <button type="button" className={`ws-btn ${from ? '' : 'ws-btn-primary '}ws-btn-large`} onClick={() => onUse(id)}><Package size={15} aria-hidden="true" />Use this template</button>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setReviewing(true)}>Change what was found</button>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setInspecting(true)}>Inspect layers</button>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setChoosing(true)}>Change what is decomposed</button></div></div>
    </div></section></div>;
}
/** The AI-read text boxes moved onto their letters (free, read on this computer), when asked; a person's corrections stay. */
function FitText({ view, onDone, onError }: { view: ProductView; onDone: (v: ProductView) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false), [note, setNote] = useState('');
  const run = () => {
    setBusy(true); setNote('');
    void productApi.fitText(view.template.id, view.template.revision).then(r => {
      onDone(r);
      setNote(r.fit.moved ? `${r.fit.moved} line${r.fit.moved === 1 ? '' : 's'} moved onto ${r.fit.moved === 1 ? 'its' : 'their'} letters. Check the boxes, then prepare again.` : 'Every line already sits on its letters, or could not be read clearly enough to move: nothing was changed.');
    }).catch((e: Error) => onError(e.message)).finally(() => setBusy(false));
  };
  return <div className="ot-row" data-testid="fit-text"><button type="button" className="ws-btn" disabled={busy} onClick={run}>{busy ? 'Fitting the text to its letters…' : 'Fit text to the letters (free)'}</button>
    <span className="ot-muted" role="status">{note || 'Moves text boxes that sit off their letters onto them, read on this computer. Your own corrections are kept.'}</span></div>;
}

export function Waiting({ label }: { label: string }) {
  return <section className="ts-card"><div className="ts-card-body"><p role="status" className="prt-waiting">{label}</p><div className="ot-rescan-progress" aria-hidden="true"><span /></div></div></section>;
}
