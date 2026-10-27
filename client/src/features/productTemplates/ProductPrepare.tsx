/**
 * Step 4, Inspect: the decomposed template next to the original, before it is saved as a master template.
 *
 *   Original | Reconstructed full creative | Background only (the estimated areas can be shown) | Individual layers |
 *   Hide / Move test (hide an object or drag it to see what is behind it; nothing is saved by trying) | Without text and logos
 *
 * Display stands (what products stand on) are layers of their own; one found wrongly is put back into the background with
 * one click (the template is prepared again). The checks are split into blocking problems (fix them in the review, change
 * what is decomposed, or explicitly save a draft with the warnings) and warnings, confirmed once by looking — not one
 * checkbox per item. Saving makes a new version; earlier versions stay.
 *
 * The cut-out service (SAM-3) is offered with its cost and only used after a second, explicit confirmation; it is given
 * individual masked character/product crops with text and logo pixels excluded. The AI decomposition (OpenAI planner →
 * Seedream Layerize) is shown with its instructions, and offered again the same way when this one was made locally.
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, ArrowLeft, Check, Eye, EyeOff, Info, Layers, RotateCcw, Save, Scissors, SlidersHorizontal } from 'lucide-react';
import type { PixelRect, ProductObject } from '@frameflow/shared';
import { Alert } from '../templateStudio/ui';
import { productApi, productFileUrl, type PrepareEstimate, type ProductView } from './api';

type Tab = 'original' | 'recombined' | 'base' | 'cutouts' | 'layers' | 'clean';
const TABS: [Tab, string][] = [['original', 'Original'], ['recombined', 'Reconstructed full creative'], ['base', 'Background only'], ['cutouts', 'Individual layers'], ['layers', 'Hide / Move test'], ['clean', 'Without text and logos']];
const pct = (v: number) => (v >= 99.95 ? '99.9' : v.toFixed(1));

export function ProductPrepare({ view, onChange, onError, onBackToReview, onChangeSelection, onOpenEditor }: { view: ProductView; onChange: (v: ProductView) => void; onError: (m: string) => void; onBackToReview: () => void; onChangeSelection?: () => void; onOpenEditor?: () => Promise<void> }) {
  const id = view.template.id, p = view.product.prepared!, W = view.template.source.width, H = view.template.source.height;
  const [tab, setTab] = useState<Tab>('layers'), [hidden, setHidden] = useState<Set<string>>(new Set()), [offsets, setOffsets] = useState<Record<string, { x: number; y: number }>>({});
  const [overlays, setOverlays] = useState(true), [looked, setLooked] = useState(false), [focus, setFocus] = useState<PixelRect>(), [busy, setBusy] = useState(false), [showEstimated, setShowEstimated] = useState(false);
  const [estimate, setEstimate] = useState<PrepareEstimate>(), [confirmPaid, setConfirmPaid] = useState(false), [confirmDraft, setConfirmDraft] = useState(false), [confirmAi, setConfirmAi] = useState(false);
  useEffect(() => { void productApi.estimate(id).then(setEstimate).catch(() => undefined); }, [id]);
  const stands = useMemo(() => p.stands ?? [], [p]);
  const objects = useMemo(() => [...stands, ...view.product.objects.filter(o => o.cutout)].sort((a, b) => a.z - b.z), [view, stands]);
  const [unstand, setUnstand] = useState<string>();
  const issues = p.quality.issues, blocking = issues.filter(i => i.blocking), warnings = issues.filter(i => !i.blocking);
  const stage = useRef<HTMLDivElement>(null), drag = useRef<{ id: string; x: number; y: number; ox: number; oy: number } | null>(null);
  const scale = () => (stage.current ? stage.current.clientWidth / W : 1);
  const down = (e: ReactPointerEvent, oid: string) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); const o = offsets[oid] ?? { x: 0, y: 0 }; drag.current = { id: oid, x: e.clientX, y: e.clientY, ox: o.x, oy: o.y }; };
  const move = (e: ReactPointerEvent) => { const d = drag.current; if (!d) return; const s = scale(); setOffsets(o => ({ ...o, [d.id]: { x: d.ox + (e.clientX - d.x) / s, y: d.oy + (e.clientY - d.y) / s } })); };
  const save = async (draft: boolean) => {
    setBusy(true); onError('');
    try {
      const approved = await productApi.approve(id, { expectedRevision: view.template.revision, acknowledge: issues.map(i => i.id), ...(draft ? { draft: true } : {}) });
      onChange(await productApi.publish(id, { expectedRevision: approved.template.revision }));
    } catch (e) { onError(e instanceof Error ? e.message : 'The template could not be saved.'); }
    finally { setBusy(false); setConfirmDraft(false); }
  };
  const preparePaid = async () => {
    setBusy(true); onError('');
    try { onChange((await productApi.prepare(id, { expectedRevision: view.template.revision, paid: true })).template); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not start.'); }
    finally { setBusy(false); setConfirmPaid(false); }
  };
  const prepareAi = async (approveUsd: number) => {
    setBusy(true); onError('');
    try { onChange((await productApi.prepare(id, { expectedRevision: view.template.revision, engine: 'ai', approveUsd })).template); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not start.'); }
    finally { setBusy(false); setConfirmAi(false); }
  };
  const prepareAgain = async () => {
    setBusy(true); onError('');
    try { onChange((await productApi.prepare(id, { expectedRevision: view.template.revision })).template); }
    catch (e) { onError(e instanceof Error ? e.message : 'Could not start.'); }
    finally { setBusy(false); }
  };
  // A stand found wrongly: kept in the background from now on (a "part of the background" box over it), prepared again.
  const keepInBackground = async (standId: string) => {
    const s = stands.find(x => x.id === standId); if (!s) return;
    setBusy(true); onError('');
    try {
      const own = view.product.objects.find(o => o.id === standId);
      const objectsOut = view.product.objects.map(o => ({ id: o.id, kind: o.kind, label: o.label, box: o.box, accepted: true, ...(o.hidden ? { hidden: true } : {}), ...(o.kind === 'podium' ? { layer: o.id === standId ? 'background' as const : o.layer ?? null } : {}) }));
      if (!own) objectsOut.push({ kind: 'podium', label: `${s.label} (background)`.slice(0, 80), box: { x: Math.max(0, s.box.x - 2), y: Math.max(0, s.box.y - 2), width: Math.min(W - Math.max(0, s.box.x - 2), s.box.width + 4), height: Math.min(H - Math.max(0, s.box.y - 2), s.box.height + 4) }, accepted: true, layer: 'background' } as typeof objectsOut[number]);
      const v = await productApi.review(id, { expectedRevision: view.template.revision, objects: objectsOut, texts: [], logos: [] });
      onChange((await productApi.prepare(id, { expectedRevision: v.template.revision })).template);
      setHidden(new Set()); setOffsets({});
    } catch (e) { onError(e instanceof Error ? e.message : 'The stand could not be put back.'); }
    finally { setBusy(false); setUnstand(undefined); }
  };
  const share = (v: number) => `${Math.round(v)}%`;
  const box = (b: PixelRect) => ({ left: `${(b.x / W) * 100}%`, top: `${(b.y / H) * 100}%`, width: `${(b.width / W) * 100}%`, height: `${(b.height / H) * 100}%` });
  const show = (area: PixelRect, oid?: string) => { setTab('layers'); setFocus(area); if (oid) setHidden(h => new Set([...h, oid])); };
  const figure = (caption: string, src: string, alt: string, extra?: string) => <figure className="ot-figure prt-figure"><figcaption className="ot-small">{caption}</figcaption>
    <div className="prt-figure-stage"><img src={productFileUrl(id, src)} alt={alt} />{extra && <img src={productFileUrl(id, extra)} alt="" aria-hidden="true" className="prt-figure-overlay" />}</div></figure>;
  const what = (o: ProductObject) => (o.kind === 'podium' ? 'Stand' : o.kind === 'character' ? 'Character' : o.kind === 'product' ? 'Product' : o.kind === 'decoration' ? 'Decoration' : 'Graphic');

  return <div className="prt-prepare">
    <section className="prt-pane prt-prepare-stage" aria-label="The decomposed template">
      <div className="prt-tabs" role="tablist" aria-label="View">
        {TABS.map(([t, label]) => <button key={t} type="button" role="tab" aria-selected={tab === t} className="prt-tab" onClick={() => setTab(t)}>{label}</button>)}
      </div>
      {tab === 'original' ? figure('Your original, as uploaded (never changed)', view.template.source.inputFile, 'The original creative')
        : tab === 'recombined' ? figure('Every layer put back together: the background, each cut-out, the text and the logos', p.previews.recombined, 'The template rebuilt from its layers')
        : tab === 'clean' ? figure('The picture with its text and logos taken out (they are editable layers; characters and products are isolated separately for any cut-out service)', p.clean.file, 'The creative without its text and logos')
        : tab === 'base' ? <>
          {figure(p.quality.reconstructedPercent ? `Behind the decomposed elements (${p.quality.reconstructedPercent}% of the canvas) the artwork was never visible: it was rebuilt — from the scene's own structure where it has one (its rays, mirror image, columns, stage rows, floor), else guessed from the artwork around. An estimate, never the original pixels. Look for object outlines or smears before moving or hiding objects.` : 'Transparent holes mark unavailable artwork (an older preparation: prepare again to rebuild them). Supply a clean background before moving or hiding objects.',
            p.base.file, 'The background behind every object', showEstimated ? p.previews.estimated : undefined)}
          {p.previews.estimated && <div className="ot-row prt-legend">
            <button type="button" className="ws-btn ws-btn-quiet" aria-pressed={showEstimated} onClick={() => setShowEstimated(v => !v)}>{showEstimated ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{showEstimated ? 'Hide estimated areas' : 'Show estimated areas'}</button>
            {showEstimated && <span className="ot-small ot-muted"><span className="prt-key is-structure" aria-hidden="true" /> continued from the scene's structure <span className="prt-key is-guess" aria-hidden="true" /> guessed from the artwork around</span>}
          </div>}
        </>
        : tab === 'cutouts' ? <section className="prt-cutouts" aria-label="Individual layers">
          {objects.map(o => { const c = o.cutout!; const stand = 'stand' in o ? (o as typeof stands[number]).stand : undefined;
            return <article key={o.id} className="prt-cutout" aria-label={`Layer ${o.label}`}>
              <div className="prt-cutout-img"><img src={productFileUrl(id, c.file)} alt={o.label} loading="lazy" /></div>
              <div className="prt-cutout-body"><strong>{o.label}</strong>
                <span className="prt-reason">{what(o)} · {c.placement.width} × {c.placement.height} px · {c.method === 'seedream' ? 'Seedream layer' : c.method === 'sam3' ? 'cut-out service' : c.method === 'upload' ? 'your picture' : c.method === 'layer' ? 'the variation’s own layer' : 'cut out on this computer'}{stand ? ` · ${Math.round(100 * stand.completedPixels / Math.max(1, stand.visiblePixels + stand.completedPixels))}% continued behind the products` : ''}</span>
                {c.note && <span className="prt-reason is-warn">{c.note}</span>}
                <button type="button" className="ws-btn ws-btn-quiet prt-inline" onClick={() => show(c.placement, o.id)}>Hide it in the Hide / Move test</button></div>
            </article>; })}
          <article className="prt-cutout" aria-label="Layer Background">
            <div className="prt-cutout-img"><img src={productFileUrl(id, p.base.file)} alt="The background" loading="lazy" /></div>
            <div className="prt-cutout-body"><strong>Background</strong><span className="prt-reason">Everything not decomposed, with what was behind the decomposed elements rebuilt.</span></div>
          </article>
          {p.previews.overlays && <article className="prt-cutout" aria-label="Layer Text and logos">
            <div className="prt-cutout-img"><img src={productFileUrl(id, p.previews.overlays)} alt="The text and logos" loading="lazy" /></div>
            <div className="prt-cutout-body"><strong>Text and logos</strong><span className="prt-reason">{view.counts.text} text blocks and {view.counts.logos} logos, each an editable layer (never part of the background).</span></div>
          </article>}
        </section>
        : <>
          <p className="ot-muted">Hide an object, or drag it, to see what is behind it. This is only a try-out; nothing is saved.</p>
          <div className="prt-layers" ref={stage} style={{ aspectRatio: `${W} / ${H}`, width: `min(100%, calc((100vh - 330px) * ${(W / H).toFixed(4)}))` }} onPointerMove={move} onPointerUp={() => { drag.current = null; }}>
            <img src={productFileUrl(id, p.base.file)} alt="" className="prt-layer-base" draggable={false} />
            {objects.filter(o => !hidden.has(o.id)).map(o => { const c = o.cutout!, off = offsets[o.id] ?? { x: 0, y: 0 };
              return <img key={o.id} src={productFileUrl(id, c.file)} alt={o.label} title={`${o.label}: drag to move`} draggable={false} className="prt-layer" onPointerDown={e => down(e, o.id)}
                style={{ ...box({ ...c.placement, x: c.placement.x + off.x, y: c.placement.y + off.y }) }} />; })}
            {overlays && p.previews.overlays && <img src={productFileUrl(id, p.previews.overlays)} alt="" aria-hidden="true" className="prt-layer-overlays" draggable={false} />}
            {focus && <span className="prt-focus" style={box(focus)} aria-hidden="true" />}
          </div>
          <div className="prt-layer-list">
            <button type="button" className="ws-btn ws-btn-quiet" aria-pressed={overlays} onClick={() => setOverlays(v => !v)}>{overlays ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}Text and logos</button>
            {objects.map(o => <button key={o.id} type="button" className="ws-btn ws-btn-quiet" aria-pressed={!hidden.has(o.id)} onClick={() => setHidden(h => { const n = new Set(h); if (n.has(o.id)) n.delete(o.id); else n.add(o.id); return n; })}>
              {hidden.has(o.id) ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}{o.label}</button>)}
            {(hidden.size > 0 || Object.keys(offsets).length > 0) && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => { setHidden(new Set()); setOffsets({}); }}><RotateCcw size={14} aria-hidden="true" />Put everything back</button>}
          </div>
          {stands.length > 0 && <section className="prt-stands" aria-label="Display stands">
            <h4><Layers size={14} aria-hidden="true" />Display stands ({stands.length})</h4>
            <p className="ot-muted">What the products stand on, as layers of their own (the big podium stays in the background). Where products hid a stand, it was continued: hide or drag the products to check it.</p>
            <ul className="prt-stand-list">{stands.map(s => <li key={s.id} onMouseEnter={() => setFocus(s.box)} onMouseLeave={() => setFocus(undefined)}>
              <span><strong>{s.label}</strong>{s.stand.uncertain && <span className="ot-chip is-warn">Mostly hidden: check it</span>}
                <span className="prt-reason">{Math.round(100 * s.stand.completedPixels / Math.max(1, s.stand.visiblePixels + s.stand.completedPixels))}% of it continued behind the products{s.origin === 'user' ? ' · marked by you' : ''}</span></span>
              {unstand === s.id ? <span className="prt-confirm-inline" role="group" aria-label={`Put ${s.label} back into the background`}>
                <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void keepInBackground(s.id)}>Yes, prepare again</button>
                <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setUnstand(undefined)}>Cancel</button></span>
                : <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => setUnstand(s.id)} title="Not a stand: keep it as part of the background">Keep in background</button>}
            </li>)}</ul>
            <p className="ot-muted">A stand that was not found? Go back to the review, draw a box around it and choose “Podium or stand”, “Its own layer”.</p>
          </section>}
        </>}
    </section>

    <aside className="prt-pane prt-inspector" aria-label="Checks">
      <section>
        <h3>How close is it?</h3>
        <ul className="prt-facts">
          <li><strong>{pct(100 - p.quality.original.visiblePercent)}%</strong> of the picture looks the same as your original when every layer is shown. (That alone says nothing about the background on its own: look at it.)</li>
          <li><strong>{objects.length}</strong> layers cut out ({p.separation.method === 'seedream' ? (p.separation.ai?.offline ? 'with the offline AI stand-in — no OpenAI, no Seedream' : `with AI: ${p.separation.ai?.planner} plan → Seedream Layerize, $${p.separation.costUsd.toFixed(2)}`) : p.separation.method === 'sam3' ? `with the cut-out service, ${p.separation.requests} request${p.separation.requests === 1 ? '' : 's'}, $${p.separation.costUsd.toFixed(2)}` : 'on this computer, free'}){stands.length ? `, ${stands.length} of them display stands` : ''}, plus the background, {view.counts.text} text blocks and {view.counts.logos} logos.</li>
          <li>{p.quality.reconstructedPercent ? <>Behind the decomposed elements, {p.quality.reconstructedPercent}% of the canvas was rebuilt (an estimate, never the original pixels): see it in Background only, “Show estimated areas”.</> : p.quality.unavailablePercent ? <>{p.quality.unavailablePercent}% of the canvas has unavailable background, shown as transparent holes. Clean source artwork is needed before objects can be moved or hidden reliably.</> : p.quality.rebuiltPercent >= 1 ? <>Behind the objects and the text, {share(p.quality.rebuiltPercent)} of the hidden area was continued from the template’s own pattern{p.quality.estimatedPercent > 0 ? `; about ${share(p.quality.estimatedPercent)} is an estimate` : ''}.</>
            : <>This background has no repeating pattern to continue, so what is behind the objects and the text is an estimate{p.quality.estimatedPercent > 0 ? ` (about ${share(p.quality.estimatedPercent)} of it)` : ''}.</>} It only shows if you move or hide something.</li>
        </ul>
      </section>
      {blocking.length > 0 && <section className="prt-blocking-list" aria-label="Problems to fix">
        <h3><AlertTriangle size={15} aria-hidden="true" />To fix before saving <span className="ot-chip is-danger">{blocking.length}</span></h3>
        <ul className="prt-checks">{blocking.map(i => <li key={i.id} onMouseEnter={() => setFocus(i.area)} onMouseLeave={() => setFocus(undefined)}>
          <span>{i.message}</span><button type="button" className="ws-btn ws-btn-quiet prt-show" onClick={() => show(i.area, i.elementId)}>Show</button></li>)}</ul>
        <div className="ot-row"><button type="button" className="ws-btn" onClick={onBackToReview}>Fix it in the review</button>
          {onChangeSelection && <button type="button" className="ws-btn" onClick={onChangeSelection}>Change what is decomposed</button>}
          <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void prepareAgain()}>Decompose again</button></div>
      </section>}
      <section>
        <h3>Warnings to look at <span className={`ot-chip${warnings.length ? ' is-warn' : ' is-ok'}`}>{warnings.length}</span></h3>
        {!warnings.length ? <p className="ot-muted"><Check size={14} aria-hidden="true" /> Nothing to look at.</p>
          : <ul className="prt-checks">{warnings.map(i => <li key={i.id} onMouseEnter={() => setFocus(i.area)} onMouseLeave={() => setFocus(undefined)}>
            <span>{i.message}</span><button type="button" className="ws-btn ws-btn-quiet prt-show" onClick={() => show(i.area, i.elementId)}>Show</button></li>)}</ul>}
      </section>
      {p.separation.ai && <section aria-label="AI decomposition">
        <h3><Info size={15} aria-hidden="true" />AI decomposition</h3>
        <p className="ot-muted ot-small">{p.separation.ai.matched.length} element{p.separation.ai.matched.length === 1 ? '' : 's'} from {p.separation.ai.offline ? 'the offline stand-in' : 'Seedream'}’s {p.separation.ai.layers} layers{p.separation.ai.unmatched.length ? `; ${p.separation.ai.unmatched.length} cut out on this computer (no layer returned)` : ''}. Sent: the picture without text and logos at {p.separation.ai.sentSize.width}×{p.separation.ai.sentSize.height}{p.separation.ai.requestId ? `, request ${p.separation.ai.requestId}` : ''}.</p>
        <details><summary>The planner’s instructions</summary><p className="ot-small">{p.separation.ai.prompt}</p>{p.separation.ai.warnings.length > 0 && <ul className="ot-small">{p.separation.ai.warnings.map((w, k) => <li key={k}>{w}</li>)}</ul>}</details>
      </section>}
      {estimate && p.separation.method !== 'seedream' && estimate.ai.configured && estimate.ai.elements > 0 && <section>
        <h3><Scissors size={15} aria-hidden="true" />Decompose with AI (optional)</h3>
        <p className="ot-muted">{estimate.ai.offline ? 'An offline stand-in for testing (no OpenAI, no Seedream).' : `The OpenAI planner and Seedream Layerize: ${estimate.ai.note}`}</p>
        {!confirmAi ? <button type="button" className="ws-btn" disabled={busy} onClick={() => (estimate.ai.offline ? void prepareAi(0) : setConfirmAi(true))}>Decompose again with AI…</button>
          : <div className="prt-confirm" role="group" aria-label="Confirm the AI cost"><p>Spend about <strong>${estimate.ai.expectedUsd.toFixed(2)}</strong> (at most ${estimate.ai.maxUsd.toFixed(2)})?</p>
            <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void prepareAi(estimate.ai.maxUsd)}>Yes, decompose with AI</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmAi(false)}>Cancel</button></div></div>}
      </section>}
      {estimate && <section>
        <h3><Scissors size={15} aria-hidden="true" />Sharper cut-outs (optional)</h3>
        {estimate.sam3.configured ? <>
          <p className="ot-muted">The cut-out service (SAM-3 on fal.ai) traces each object more exactly, which helps where objects overlap or touch a stand of their own colour. {estimate.sam3.requests} request{estimate.sam3.requests === 1 ? '' : 's'}, about <strong>${estimate.sam3.usd.toFixed(2)}</strong>. Only individual masked character/product crops are sent; text and logo pixels are excluded. It does not rebuild the background.</p>
          {!confirmPaid ? <button type="button" className="ws-btn" disabled={busy} onClick={() => setConfirmPaid(true)}>Prepare again with the cut-out service…</button>
            : <div className="prt-confirm" role="group" aria-label="Confirm the cost"><p>Spend about <strong>${estimate.sam3.usd.toFixed(2)}</strong> on {estimate.sam3.requests} cut-out request{estimate.sam3.requests === 1 ? '' : 's'}?</p>
              <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void preparePaid()}>Yes, spend ${estimate.sam3.usd.toFixed(2)}</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmPaid(false)}>Cancel</button></div></div>}
        </> : <p className="ot-muted"><Info size={14} aria-hidden="true" /> The cut-out service is not set up on this server; the cut-outs above were made on this computer.</p>}
      </section>}
      <section className="prt-cta">
        {onOpenEditor && <><button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy} onClick={() => { setBusy(true); void onOpenEditor().finally(() => setBusy(false)); }}>Open in Editor</button>
          <p className="ot-muted">Saves a recoverable editor draft with these checks. Quality warnings stay unresolved until you review and approve them.</p></>}
        <label className="ot-check"><input type="checkbox" checked={looked} onChange={e => setLooked(e.target.checked)} />
          <span>I have looked at the background and the layers{warnings.length ? ` (and the ${warnings.length} warning${warnings.length === 1 ? '' : 's'})` : ''}.</span></label>
        {blocking.length > 0 ? <>
          <Alert tone="warn">{blocking.length === 1 ? 'One problem' : `${blocking.length} problems`} keep{blocking.length === 1 ? 's' : ''} this from being saved as a master template.</Alert>
          {confirmDraft ? <div className="prt-confirm" role="group" aria-label="Confirm the draft"><p>Save it as a <strong>draft</strong>? The warnings are saved with it and shown wherever it is used; fix them later and save again for a clean version.</p>
            <div className="ot-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || !looked} onClick={() => void save(true)}><Save size={15} aria-hidden="true" />Yes, save as a draft</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmDraft(false)}>Cancel</button></div></div>
            : <button type="button" className="ws-btn" disabled={busy || !looked} onClick={() => setConfirmDraft(true)}>Save as a draft with these warnings…</button>}
        </> : <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || !looked} onClick={() => void save(false)}><Save size={15} aria-hidden="true" />{busy ? 'Saving…' : 'Save master template'}</button>}
        {onChangeSelection && blocking.length === 0 && <button type="button" className="ws-btn ws-btn-quiet" onClick={onChangeSelection}><SlidersHorizontal size={14} aria-hidden="true" />Change what is decomposed</button>}
        <button type="button" className="ws-btn ws-btn-quiet" onClick={onBackToReview}><ArrowLeft size={14} aria-hidden="true" />Back to the review</button>
      </section>
    </aside>
  </div>;
}
