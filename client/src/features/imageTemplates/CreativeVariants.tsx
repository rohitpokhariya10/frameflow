import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ImagePlus, LoaderCircle, ShieldCheck, Sparkles, Wand2 } from 'lucide-react';
import { directionProblems, protectedGroup, scenePromptProblems, VARIANT_LIMITS, type CreativeVariant, type SceneDescription, type SceneDraft, type TemplateVersion } from '@frameflow/shared';
import { defaultProtected, protectableObjects, semanticLabel, SET_STATUS, VARIANT_STATUS, type SceneAnalysis, type ShownVariantSet, type SmartFeatures } from './smartEdit';
import type { ShownExecution } from './templateWizard';

const BASE = '/api/layerize-experiment';
const fileUrl = (setId: string, file: string) => `${BASE}/creative-variant-sets/${setId}/files/${file}`;
type Request = <T>(path: string, init?: RequestInit) => Promise<T>;
const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/**
 * "Generate creative template": new scenes around the image's own products or subjects. The user confirms what is
 * protected (nothing is preselected when the main subject is ambiguous), gives a direction or asks for a surprise, and
 * gets 1–4 different scenes. The subjects are the reference's own pixels in every result; only the scenery is new.
 * Each variant is its own paid request: one may fail while the others are kept, and nothing is resent automatically.
 */
export function CreativeVariants({ analysis, scene, draft, version, features, request, setId, onSetId, onChosen, onBack }: {
  analysis: SceneAnalysis; scene: SceneDescription; draft: SceneDraft; version: TemplateVersion; features: SmartFeatures; request: Request;
  setId?: string; onSetId: (id: string | undefined) => void; onChosen: (execution: ShownExecution) => void; onBack: () => void;
}) {
  const objects = protectableObjects(scene), [chosen, setChosen] = useState<string[]>(() => defaultProtected(scene));
  const [direction, setDirection] = useState(''), [surprise, setSurprise] = useState(true), [count, setCount] = useState(3), [verify, setVerify] = useState(features.verification.available);
  const [loaded, setSet] = useState<ShownVariantSet>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [edits, setEdits] = useState<Record<string, string>>({});
  const pending = useRef(false), key = useRef<string | undefined>(undefined);
  const group = protectedGroup(scene, chosen), ambiguous = defaultProtected(scene).length === 0;
  const directionIssue = directionProblems(direction)[0];
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
    const s = await request<ShownVariantSet>('/creative-variant-sets', json({ analysisId: analysis.id, templateId: version.templateId, templateVersion: version.version, protectedIds: chosen,
      ...(Object.keys(draft.corrections).length ? { corrections: draft.corrections } : {}), ...(direction.trim() ? { direction: direction.trim() } : {}), surprise: surprise || !direction.trim(), count, verify, idempotencyKey: key.current }));
    key.current = undefined; setSet(s); onSetId(s.id);
  });
  const regenerate = (v: CreativeVariant) => void act(async () => { setSet(await request<ShownVariantSet>(`/creative-variant-sets/${set!.id}/variants/${v.id}/regenerate`, json({ scene: edits[v.id] ?? v.scene, idempotencyKey: crypto.randomUUID() }))); });
  const choose = (v: CreativeVariant) => void act(async () => { onChosen(await request<ShownExecution>(`/creative-variant-sets/${set!.id}/variants/${v.id}/select`, json({ idempotencyKey: crypto.randomUUID() }))); });
  const uploadCutout = (file?: File) => { if (!file) return; void act(async () => { const body = new FormData(); body.append('cutout', file); setSet(await request<ShownVariantSet>(`/creative-variant-sets/${set!.id}/cutout`, { method: 'POST', body })); }); };
  const calls = surprise || !direction.trim() || count > 1 ? 1 : 0;
  return <section className="cv-studio" aria-label="Generate creative template">
    <header className="cv-head"><div><p className="ff-lab-kicker">GENERATE CREATIVE TEMPLATE</p><h3>New scenes around your exact {group.ids.length === 1 ? 'subject' : 'subjects'}</h3>
      <p className="tw-muted">The protected items are cut out of your image and kept as its own pixels: same angle, markings and identity. Only the scenery around them is generated. No text, prices or logos are added.</p></div>
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} /> Back to editing</button></header>
    {error && <p role="alert" className="tw-alert">{error}</p>}
    {!set ? <div className="cv-form">
      <fieldset className="sm-group"><legend><ShieldCheck size={15} aria-hidden="true" /> Keep exactly as it is</legend>
        {ambiguous && <p className="tw-note-warn" role="note">Several items could be the main subject. Choose what must stay exactly as it is.</p>}
        <div className="cv-protect">{objects.map(o => <label key={o.id} className={`tw-check${chosen.includes(o.id) ? ' is-on' : ''}`}><input type="checkbox" checked={chosen.includes(o.id)} disabled={busy}
          onChange={e => setChosen(c => e.target.checked ? [...c, o.id] : c.filter(id => id !== o.id))} />{o.label}<small>{o.description}</small></label>)}</div>
        {group.added.length > 0 && <p className="tw-muted">Kept with them so hands, grips and parts stay intact: {group.added.map(a => `${scene.objects.find(o => o.id === a.id)?.label} (${a.because})`).join('; ')}.</p>}
      </fieldset>
      <fieldset className="sm-group"><legend><Wand2 size={15} aria-hidden="true" /> Direction</legend>
        <label className="tw-field"><span>Describe the setting <small>optional</small></span><textarea aria-label="Creative direction" maxLength={VARIANT_LIMITS.direction} rows={3} value={direction} disabled={busy}
          placeholder="e.g. a calm festive table with diyas and marigolds, warm evening light" onChange={e => { setDirection(e.target.value); if (e.target.value.trim()) setSurprise(false); }} /></label>
        {directionIssue && <p className="tw-alert" role="alert">{directionIssue}</p>}
        <label className="tw-check"><input type="checkbox" checked={surprise || !direction.trim()} disabled={busy || !direction.trim()} onChange={e => setSurprise(e.target.checked)} />Surprise me {direction.trim() ? 'with variations on it' : '(no direction given)'}</label>
        <div className="cv-row"><label className="tw-field"><span>Variants</span><select aria-label="Number of variants" value={count} disabled={busy} onChange={e => setCount(Number(e.target.value))}>{Array.from({ length: VARIANT_LIMITS.max }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
          {features.verification.available && <label className="tw-check"><input type="checkbox" checked={verify} disabled={busy} onChange={e => setVerify(e.target.checked)} />Check each result with AI</label>}</div>
      </fieldset>
      <p className="tw-muted cv-cost">Paid requests: subject mask ({features.variants.cutout === 'none' ? 'you upload a cutout' : `${group.ids.length} mask request${group.ids.length === 1 ? '' : 's'}`}) · scene ideas {calls} call · {count} image call{count === 1 ? '' : 's'}{verify ? ` · ${count} AI check${count === 1 ? '' : 's'}` : ''}. Nothing is retried automatically.</p>
      <div className="tw-actions"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || !chosen.length || !!directionIssue} onClick={start}>{busy ? <LoaderCircle size={16} className="ws-spin" aria-hidden="true" /> : <Sparkles size={16} />} Generate {count} creative{count === 1 ? '' : 's'}</button></div>
    </div> : <div className="cv-set">
      <p className="cv-status" role="status">{running && <LoaderCircle size={15} className="ws-spin" aria-hidden="true" />} {SET_STATUS[set.state]} · protected: {set.protectedLabels.join(', ')}{set.direction ? ` · direction: ${set.direction}` : ' · surprise me'}</p>
      {set.error && <p className="tw-alert" role="alert">{set.error.message}</p>}
      {set.cutout.status === 'needs-cutout' && <div className="tw-alert" role="alert"><p><strong>The subject could not be cut out reliably.</strong> {set.cutout.error?.message}</p>
        <label className="ws-btn tw-upload"><ImagePlus size={15} /> Upload cutout PNG<input className="tw-file" aria-label="Subject cutout" type="file" accept="image/png" disabled={busy} onChange={e => uploadCutout(e.target.files?.[0])} /></label>
        <p className="tw-muted">Export it from this same image (same size, transparent background). Its pixels are checked against your image; a retouched or regenerated cutout is refused.</p></div>}
      {set.cutout.limitations.map(l => <p key={l} className="tw-note-warn" role="note">{l}</p>)}
      <div className="cv-grid">{set.variants.map(v => <article key={v.id} className={`cv-card is-${v.status}`} aria-label={`Variant ${v.id.slice(1)}: ${v.title}`}>
        <div className="cv-image">{v.image ? <img src={fileUrl(set.id, v.image.file)} alt={`Variant ${v.id.slice(1)}: ${v.title}`} /> : <div className="tw-empty">{v.status === 'generating' ? <LoaderCircle size={24} className="ws-spin" aria-hidden="true" /> : <Sparkles size={24} aria-hidden="true" />}<p>{VARIANT_STATUS[v.status]}</p></div>}</div>
        <div className="cv-body"><h4>{v.title} <small className={`cv-badge is-${v.status}`}>{VARIANT_STATUS[v.status]}</small></h4>
          {v.error && <p className="tw-alert" role="alert">{v.error.message}</p>}
          {v.preservation && <p className="tw-muted">Subject: your image's own pixels ({v.preservation.checkedPixels.toLocaleString()} checked, unchanged).</p>}
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
      <p className="tw-muted">Requests so far: {set.usage.segmentationCalls} mask · {set.usage.conceptCalls} scene ideas · {set.usage.imageGenerationCalls} image · {set.usage.verificationCalls} AI check.</p>
      {!running && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => { onSetId(undefined); setEdits({}); }}>Start a new set</button>}
    </div>}
  </section>;
}
