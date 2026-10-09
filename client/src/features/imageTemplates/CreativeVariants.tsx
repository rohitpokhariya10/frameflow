import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ImagePlus, LoaderCircle, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { advertisedProducts, closestGenerationRatio, directionProblems, protectedGroup, scenePromptProblems, VARIANT_COUNTS, VARIANT_LIMITS, VARIANT_RATIOS, type CreativeVariant, type SceneDescription, type SceneDraft, type TemplateVersion, type VariantRatio } from '@frameflow/shared';
import { protectableObjects, semanticLabel, SET_STATUS, VARIANT_STATUS, type SceneAnalysis, type ShownVariantSet, type SmartFeatures } from './smartEdit';
import type { ShownExecution } from './templateWizard';

const BASE = '/api/layerize-experiment';
const fileUrl = (setId: string, file: string) => `${BASE}/creative-variant-sets/${setId}/files/${file}`;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const RATIO_NAMES: Record<VariantRatio, string> = { '1:1': 'Square 1:1', '4:5': 'Portrait 4:5', '16:9': 'Landscape 16:9' };

/**
 * "Generate creative template": new premium scenes around the reference's own products, in one click. The reference
 * image is the one on screen; the advertised product or product group is found automatically (and shown); the user
 * picks how many creatives and the aspect ratio. What to keep, a direction and the AI check are optional, under
 * Advanced. The products are the reference's own pixels in every result; only the scene around them is new. Each
 * creative is its own paid request: one may fail while the others are kept, and nothing is resent automatically.
 */
export function CreativeVariants({ analysis, scene, draft, version, features, request, setId, onSetId, onChosen, onBack }: {
  analysis: SceneAnalysis; scene: SceneDescription; draft: SceneDraft; version: TemplateVersion; features: SmartFeatures; request: Request;
  setId?: string; onSetId: (id: string | undefined) => void; onChosen: (execution: ShownExecution) => void; onBack: () => void;
}) {
  const objects = protectableObjects(scene), auto = advertisedProducts(scene);
  // Manual choice is optional: until the user changes it under Advanced, the automatic one is used (and sent as such).
  const [manual, setManual] = useState<string[] | undefined>(undefined), chosen = manual ?? auto.ids;
  const reference = analysis.upload, defaultRatio = reference ? closestGenerationRatio(reference.width, reference.height) as VariantRatio : '1:1';
  const [count, setCount] = useState<number>(3), [ratio, setRatio] = useState<VariantRatio>((VARIANT_RATIOS as readonly string[]).includes(defaultRatio) ? defaultRatio : '1:1');
  const [direction, setDirection] = useState(''), [verify, setVerify] = useState(features.verification.available);
  const [loaded, setSet] = useState<ShownVariantSet>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [edits, setEdits] = useState<Record<string, string>>({});
  const pending = useRef(false), key = useRef<string | undefined>(undefined);
  const group = protectedGroup(scene, chosen), label = (id: string) => scene.objects.find(o => o.id === id)?.label ?? id;
  // An attached part travels inside its product's cutout: one mask request per product.
  const parts = new Set(scene.relations.filter(r => (r.relation === 'part_of' || r.relation === 'attached_to') && group.ids.includes(r.target)).map(r => r.source));
  const products = group.ids.filter(id => !parts.has(id)), directionIssue = directionProblems(direction)[0];
  // The set on screen is the one asked for; it is polled only while something in it is still running.
  const set = loaded && loaded.id === setId ? loaded : undefined;
  const running = !!set && (['cutout', 'concepts', 'generating'].includes(set.state) || set.variants.some(v => v.status === 'generating'));
  const waiting = !!setId && (!set || running);
  useEffect(() => {
    if (!setId || !waiting) return;
    let live = true;
    const load = () => void request<ShownVariantSet>(`/creative-variant-sets/${setId}`).then(s => { if (live) setSet(s); }).catch((e: Error) => { if (live) setError(e.message); });
    load();
    const timer = window.setInterval(load, 900);
    return () => { live = false; clearInterval(timer); };
  }, [setId, waiting, request]);
  const act = async (work: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { pending.current = false; setBusy(false); }
  };
  const start = () => void act(async () => {
    key.current ??= crypto.randomUUID();
    const s = await request<ShownVariantSet>('/creative-variant-sets', json({ analysisId: analysis.id, templateId: version.templateId, templateVersion: version.version, count, aspectRatio: ratio,
      ...(manual ? { protectedIds: manual } : {}), ...(Object.keys(draft.corrections).length ? { corrections: draft.corrections } : {}), ...(direction.trim() ? { direction: direction.trim() } : { surprise: true }), verify, idempotencyKey: key.current }));
    key.current = undefined; setSet(s); onSetId(s.id);
  });
  const regenerate = (v: CreativeVariant) => void act(async () => { setSet(await request<ShownVariantSet>(`/creative-variant-sets/${set!.id}/variants/${v.id}/regenerate`, json({ scene: edits[v.id] ?? v.scene, idempotencyKey: crypto.randomUUID() }))); });
  const choose = (v: CreativeVariant) => void act(async () => { onChosen(await request<ShownExecution>(`/creative-variant-sets/${set!.id}/variants/${v.id}/select`, json({ idempotencyKey: crypto.randomUUID() }))); });
  const rewriteConcepts = () => void act(async () => { setSet(await request<ShownVariantSet>(`/creative-variant-sets/${set!.id}/concepts`, json({ idempotencyKey: crypto.randomUUID() }))); });
  // Variants still without a usable scene idea (the concept call failed, answered short, or asked for text).
  const sceneless = set ? set.variants.filter(v => v.status === 'failed' && ['CONCEPT_REJECTED', 'CONCEPT_MISSING', 'CONCEPTS_FAILED'].includes(v.error?.code ?? '')).length : 0;
  const uploadCutout = (file?: File) => { if (!file) return; void act(async () => { const body = new FormData(); body.append('cutout', file); setSet(await request<ShownVariantSet>(`/creative-variant-sets/${set!.id}/cutout`, { method: 'POST', body })); }); };
  const masks = features.variants.cutout === 'none' ? 'you upload a cutout' : features.variants.cutout === 'birefnet' ? '1 mask request' : `${products.length} mask request${products.length === 1 ? '' : 's'}`;
  const ideas = count === 1 && direction.trim() ? 0 : 1;
  return <section className="cv-studio" aria-label="Generate creative template">
    <header className="cv-head"><div><p className="ff-lab-kicker">GENERATE CREATIVE TEMPLATE</p><h3>New premium scenes around your exact {products.length === 1 ? 'product' : 'products'}</h3>
      <p className="tw-muted">Your products are cut out of this image and kept as its own pixels: same shape, colours, logos and details. The AI designs a different scene around them for each creative. No text, prices or offers are added.</p></div>
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} /> Back to editing</button></header>
    {error && <p role="alert" className="tw-alert">{error}</p>}
    {!set ? <div className="cv-form">
      <p className="cv-keeps" role="status"><ShieldCheck size={15} aria-hidden="true" /> Keeps exactly: <b>{products.map(label).join(', ') || 'nothing yet'}</b>
        <small className="tw-muted"> · {manual ? 'your choice' : auto.fallback ? 'the most prominent product (nothing was named as main)' : 'chosen automatically'}</small></p>
      <div className="cv-row">
        <fieldset className="tw-modes cv-choice" aria-label="Number of creatives"><legend>Creatives</legend>{VARIANT_COUNTS.map(n => <label key={n} className={count === n ? 'is-on' : ''}><input type="radio" name="cv-count" value={n} checked={count === n} disabled={busy} onChange={() => setCount(n)} />{n}</label>)}</fieldset>
        <fieldset className="tw-modes cv-choice" aria-label="Aspect ratio"><legend>Aspect ratio</legend>{VARIANT_RATIOS.map(r => <label key={r} className={ratio === r ? 'is-on' : ''} title={RATIO_NAMES[r]}><input type="radio" name="cv-ratio" value={r} checked={ratio === r} disabled={busy} onChange={() => setRatio(r)} />{r}</label>)}</fieldset>
      </div>
      <div className="tw-actions"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || !products.length || !!directionIssue} onClick={start}>{busy ? <LoaderCircle size={16} className="ws-spin" aria-hidden="true" /> : <Sparkles size={16} />} Generate {count} creative{count === 1 ? '' : 's'}</button></div>
      <p className="tw-muted cv-cost">Paid requests: {masks} · scene ideas {ideas} call · {count} image call{count === 1 ? '' : 's'}{verify ? ` · ${count} AI check${count === 1 ? '' : 's'}` : ''}. Nothing is retried automatically.</p>
      <details className="cv-advanced"><summary><SlidersHorizontal size={14} aria-hidden="true" /> Advanced (optional)</summary>
        <fieldset className="sm-group"><legend>Keep exactly as it is</legend>
          <div className="cv-protect">{objects.map(o => <label key={o.id} className={`tw-check${chosen.includes(o.id) ? ' is-on' : ''}`}><input type="checkbox" checked={chosen.includes(o.id)} disabled={busy}
            onChange={e => setManual(e.target.checked ? [...chosen, o.id] : chosen.filter(id => id !== o.id))} />{o.label}<small>{!manual && auto.reasons[o.id] ? `chosen: ${auto.reasons[o.id]}` : o.description}</small></label>)}</div>
          {group.added.length > 0 && <p className="tw-muted">Kept with them so hands, grips and parts stay intact: {group.added.map(a => `${label(a.id)} (${a.because})`).join('; ')}.</p>}
          {manual && <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => setManual(undefined)}>Use the automatic choice</button>}
        </fieldset>
        <label className="tw-field"><span>Direction <small>optional: the AI chooses the concepts without one</small></span><textarea aria-label="Creative direction" maxLength={VARIANT_LIMITS.direction} rows={2} value={direction} disabled={busy}
          placeholder="e.g. a calm festive table with diyas and marigolds, warm evening light" onChange={e => setDirection(e.target.value)} /></label>
        {directionIssue && <p className="tw-alert" role="alert">{directionIssue}</p>}
        {features.verification.available && <label className="tw-check"><input type="checkbox" checked={verify} disabled={busy} onChange={e => setVerify(e.target.checked)} />Check each result with AI</label>}
      </details>
    </div> : <div className="cv-set">
      <p className="cv-status" role="status">{running && <LoaderCircle size={15} className="ws-spin" aria-hidden="true" />} {SET_STATUS[set.state]} · keeps: {set.protectedLabels.join(', ')}{set.aspectRatio ? ` · ${set.aspectRatio}` : ''}{set.direction ? ` · direction: ${set.direction}` : ' · concepts chosen by the AI'}</p>
      {set.error && <p className="tw-alert" role="alert">{set.error.message}</p>}
      {set.cutout.status === 'needs-cutout' && <div className="tw-alert" role="alert"><p><strong>The subject could not be cut out reliably.</strong> {set.cutout.error?.message}</p>
        <label className="ws-btn tw-upload"><ImagePlus size={15} /> Upload cutout PNG<input className="tw-file" aria-label="Subject cutout" type="file" accept="image/png" disabled={busy} onChange={e => uploadCutout(e.target.files?.[0])} /></label>
        <p className="tw-muted">Export it from this same image (same size, transparent background). Its pixels are checked against your image; a retouched or regenerated cutout is refused.</p></div>}
      {set.cutout.limitations.map(l => <p key={l} className="tw-note-warn" role="note">{l}</p>)}
      <div className="cv-grid">{set.variants.map(v => <article key={v.id} className={`cv-card is-${v.status}`} aria-label={`Variant ${v.id.slice(1)}: ${v.title}`}>
        <div className="cv-image">{v.image ? <img src={fileUrl(set.id, v.image.file)} alt={`Variant ${v.id.slice(1)}: ${v.title}`} /> : <div className="tw-empty">{v.status === 'generating' ? <LoaderCircle size={24} className="ws-spin" aria-hidden="true" /> : <Sparkles size={24} aria-hidden="true" />}<p>{VARIANT_STATUS[v.status]}</p></div>}</div>
        <div className="cv-body"><h4>{v.title} <small className={`cv-badge is-${v.status}`}>{VARIANT_STATUS[v.status]}</small></h4>
          {v.error && <p className="tw-alert" role="alert">{v.error.message}</p>}
          {v.concept && <p className="cv-concept tw-muted">{v.concept.family} · {v.concept.mood || v.concept.lighting}{v.concept.composition.copySpace !== 'none' ? ` · open space ${v.concept.composition.copySpace}` : ''}</p>}
          {v.preservation && <p className="tw-muted">{set.protectedLabels.length > 1 ? 'Products' : 'Product'}: your image's own pixels{v.preservation.scale !== undefined && v.preservation.scale < 1 ? `, scaled to ${Math.round(v.preservation.scale * 100)}%` : ''} ({v.preservation.checkedPixels.toLocaleString()} identical{v.preservation.edgePixels !== undefined ? `, ${v.preservation.edgePixels.toLocaleString()} soft edge pixels blended` : ''}).</p>}
          {v.verification && <p className={`cv-check is-${v.verification.status}`}>{semanticLabel(v.verification)}{v.verification.reason ? `: ${v.verification.reason}` : ''}</p>}
          {v.verification?.checks.filter(c => c.status !== 'pass').map(c => <p key={c.id} className="tw-muted">{c.id}: {c.message}</p>)}
          <label className="tw-field"><span>Scene</span><textarea aria-label={`Variant ${v.id.slice(1)} scene`} rows={3} maxLength={VARIANT_LIMITS.scene} value={edits[v.id] ?? v.scene} disabled={busy || running} onChange={e => setEdits(x => ({ ...x, [v.id]: e.target.value }))} /></label>
          {scenePromptProblems(edits[v.id] ?? v.scene).length > 0 && (edits[v.id] ?? v.scene) !== '' && <p className="tw-alert" role="alert">{scenePromptProblems(edits[v.id] ?? v.scene)[0]}</p>}
          {v.prompt && <details><summary>Exact prompt sent</summary><p className="tw-muted cv-prompt">{v.prompt}</p></details>}
          {v.history.length > 0 && <details><summary>Earlier results ({v.history.length})</summary><div className="cv-history">{v.history.map(h => h.image ? <img key={h.at} src={fileUrl(set.id, h.image.file)} alt={`Earlier result: ${h.scene}`} /> : <p key={h.at} className="tw-muted">{h.error?.message}</p>)}</div></details>}
          <div className="tw-actions">
            {v.status === 'done' && <button type="button" className="ws-btn ws-btn-primary" disabled={busy || running} onClick={() => choose(v)}>Use this creative</button>}
            {(v.status === 'done' || v.status === 'failed') && set.cutout.status === 'ready' && <button type="button" className="ws-btn" disabled={busy || running || scenePromptProblems(edits[v.id] ?? v.scene).length > 0} onClick={() => regenerate(v)}>Regenerate · 1 paid call</button>}
          </div></div>
      </article>)}</div>
      {!running && sceneless > 0 && set.cutout.status === 'ready' && <div className="tw-actions"><button type="button" className="ws-btn" disabled={busy} onClick={rewriteConcepts}><Sparkles size={15} /> Write scene ideas again · 1 call</button>
        <small className="tw-muted">For the {sceneless === 1 ? 'variant' : `${sceneless} variants`} without a scene. The cutout is kept: no new mask request.</small></div>}
      <p className="tw-muted">Requests so far: {set.usage.segmentationCalls} mask · {set.usage.conceptCalls} scene ideas · {set.usage.imageGenerationCalls} image · {set.usage.verificationCalls} AI check.</p>
      {!running && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => { onSetId(undefined); setEdits({}); }}>Start a new set</button>}
    </div>}
  </section>;
}
