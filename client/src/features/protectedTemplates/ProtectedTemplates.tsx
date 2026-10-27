/**
 * Protected templates: keep a creative's text, logos and legal copy out of AI decomposition. The administrator marks them,
 * prepares the artwork Seedream receives (without them), sends it to Seedream 5.0 Pro Layerize (the only model used, one
 * paid request, explicitly), reviews the reconstruction, approves the template, and opens or reuses it in the editor with
 * new logos and copy, without decomposing again. Runs, costs and diagnostics stay in Overview and Saved Runs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, FileImage, Layers3, LoaderCircle, Plus, RefreshCw, Save, ShieldCheck, Upload } from 'lucide-react';
import { elementsProblems, PROTECTED_BASE_METHODS, PROTECTED_KIND_LABELS, type ProtectedKind, type ProtectedTemplateView, type SourceBox } from '@frameflow/shared';
import { Alert, Badge, PageHeading, StepCard, fmtDate } from '../templateStudio/ui';
import { experimentApi, experimentFileUrl, type ExperimentRun } from '../decomposition/layerizeExperiment';
import { newElementId, newKey, protectedApi, protectedFileUrl, ProtectedApiError, STATUS_LABELS, type ElementDraft, type Preflight, type ProtectedListItem } from './api';
import { RegionEditor } from './RegionEditor';
import { defaultText, ElementPanel } from './ElementPanel';
import { textReplaceable, type SlotReplacement } from './editorDocument';
import { browserFetch, studioSceneUrl } from './fromStudioPoster';
import { WordsAndLogos } from './WordsAndLogos';
import { StyleVariations, type OpenVariation } from './StyleVariations';
import './protectedTemplates.css';

export type ProtectedRequest = { templateId: string; at: number };
export type OpenProtected = (template: ProtectedTemplateView, run: ExperimentRun, reuse?: { replacements: Record<string, SlotReplacement>; name: string }) => Promise<void>;
const tone = (status: ProtectedTemplateView['status']) => status === 'approved' ? 'ok' : status === 'failed' || status === 'interrupted' ? 'danger' : status === 'review' || status === 'decomposing' ? 'accent' : 'neutral';
const usd = (n: number) => `$${n.toFixed(2)}`, inr = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;

/** A request (a poster's or run's "Protect text and logos") opens that template; the panel remounts this per request. */
export function ProtectedTemplates({ runs, onOpenRun, onOpenEditor, onOpenVariation, request }: { runs: ExperimentRun[]; onOpenRun: (runId: string) => void; onOpenEditor: OpenProtected; onOpenVariation: OpenVariation; request?: ProtectedRequest }) {
  const [selected, setSelected] = useState<string | undefined>(request?.templateId);
  return selected ? <TemplateWorkflow key={selected} id={selected} onBack={() => setSelected(undefined)} onOpenRun={onOpenRun} onOpenEditor={onOpenEditor} onOpenVariation={onOpenVariation} />
    : <TemplateList runs={runs} onOpen={setSelected} />;
}

function TemplateList({ runs, onOpen }: { runs: ExperimentRun[]; onOpen: (id: string) => void }) {
  const [list, setList] = useState<ProtectedListItem[]>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File>(), [name, setName] = useState(''), [runId, setRunId] = useState('');
  useEffect(() => { let alive = true; void protectedApi.list().then(r => { if (alive) setList(r.templates); }).catch((e: Error) => { if (alive) setError(e.message); }); return () => { alive = false; }; }, []);
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } };
  const usable = runs.filter(r => r.original);
  return <div className="ts-page">
    <PageHeading kicker="PROTECTED TEMPLATES" title="Keep text and logos out of decomposition">Mark bank logos, offer text and fine print once. Only the remaining artwork is sent to Seedream 5.0 Pro Layerize; the protected content is restored from its own pixels or original files, and can be replaced later without decomposing again.</PageHeading>
    {error && <Alert>{error}</Alert>}
    <div className="ts-two">
      <StepCard title="New from a creative" hint="The finished creative, with its text and logos. Nothing is sent anywhere until you decompose.">
        <label className="ff-lab-upload"><strong>{file?.name ?? 'Choose the creative'}</strong><input type="file" accept="image/png,image/jpeg,image/webp" aria-label="Source creative" onChange={e => setFile(e.target.files?.[0])} /></label>
        <div className="ts-field"><label htmlFor="pt-new-name">Template name</label><input id="pt-new-name" value={name} maxLength={120} placeholder="Easy EMI · bank offers" onChange={e => setName(e.target.value)} /></div>
        <button type="button" className="ws-btn ws-btn-primary" disabled={!file || busy} onClick={() => file && void act(async () => onOpen((await protectedApi.create(file, name)).id))}><Plus size={15} aria-hidden="true" />Create protected template</button>
      </StepCard>
      <StepCard title="New from a saved run" hint="The exact image a decomposition run used, for example one Seedream refused.">
        <div className="ts-field"><label htmlFor="pt-run">Saved run</label><select id="pt-run" value={runId} onChange={e => setRunId(e.target.value)}><option value="">Choose a run…</option>
          {usable.map(r => <option key={r.id} value={r.id}>{new Date(r.createdAt).toLocaleString()} · {r.stage} · {r.original.width}×{r.original.height} · {r.id.slice(-6)}</option>)}</select></div>
        <button type="button" className="ws-btn" disabled={!runId || busy} onClick={() => void act(async () => onOpen((await protectedApi.fromRun(runId)).id))}><FileImage size={15} aria-hidden="true" />Use this run's image</button>
      </StepCard>
    </div>
    <section aria-label="Protected templates" className="pt-list">
      {!list ? <p className="ts-muted" role="status">Loading…</p> : !list.length ? <p className="ts-muted">No protected templates yet.</p>
        : list.map(t => <article key={t.id} className="pt-card" aria-label={`Protected template ${t.name}`}>
          <img src={protectedFileUrl(t.id, t.source.inputFile)} alt="" loading="lazy" />
          <div><h3>{t.name}</h3><p className="ts-muted">{t.elements} protected element{t.elements === 1 ? '' : 's'} · {t.source.width}×{t.source.height} · {fmtDate(t.updatedAt)}</p>
            <Badge tone={tone(t.status)}>{STATUS_LABELS[t.status]}</Badge></div>
          <button type="button" className="ws-btn" onClick={() => onOpen(t.id)}>Open</button>
        </article>)}
    </section>
  </div>;
}

function TemplateWorkflow({ id, onBack, onOpenRun, onOpenEditor, onOpenVariation }: { id: string; onBack: () => void; onOpenRun: (runId: string) => void; onOpenEditor: OpenProtected; onOpenVariation: OpenVariation }) {
  const [t, setT] = useState<ProtectedTemplateView>(), [drafts, setDrafts] = useState<ElementDraft[]>([]), [dirty, setDirty] = useState(false);
  const [selectedEl, setSelectedEl] = useState<string | null>(null), [drawKind, setDrawKind] = useState<ProtectedKind>('logo'), [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState<{ message: string; stale?: boolean; checks?: Preflight['checks'] }>(), [notice, setNotice] = useState('');
  const [preflight, setPreflight] = useState<Preflight>(), [confirming, setConfirming] = useState(false), [repeat, setRepeat] = useState(false), [instructions, setInstructions] = useState('');
  const [baseView, setBaseView] = useState<'source' | 'base' | 'fill'>('base'), [acknowledgeBase, setAcknowledgeBase] = useState(false), [ack, setAck] = useState<Record<string, boolean>>({});
  const [reviewView, setReviewView] = useState<'source' | 'seedream' | 'reconstruction'>('reconstruction');
  const key = useRef<string | undefined>(undefined);
  const apply = useCallback((next: ProtectedTemplateView, keepDrafts = false) => {
    setT(next); setInstructions(i => keepDrafts ? i : next.layerInstructions);
    if (!keepDrafts) { setDrafts(next.elements); setDirty(false); }
  }, []);
  const load = useCallback(async (keepDrafts = false) => apply(await protectedApi.get(id), keepDrafts), [apply, id]);
  useEffect(() => {
    let alive = true;
    void protectedApi.get(id).then(next => { if (alive) apply(next); }).catch((e: Error) => { if (alive) setError({ message: e.message }); });
    return () => { alive = false; };
  }, [apply, id]);
  const running = t?.status === 'decomposing' || !!t?.latestRun?.active;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void protectedApi.get(id).then(next => apply(next, true)).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [running, id, apply]);
  const ready = t?.status === 'ready' || t?.status === 'failed' || t?.status === 'review' || t?.status === 'approved' || t?.status === 'interrupted';
  // Checked again after every change, never while a run is in progress (each check re-reads and hashes the stored files).
  useEffect(() => { if (t && ready && !dirty && !running) void protectedApi.preflight(t.id).then(setPreflight).catch(() => undefined); }, [t, ready, dirty, running]);
  const act = async (work: () => Promise<void>, done?: string) => {
    setBusy(true); setError(undefined); setNotice('');
    try { await work(); if (done) setNotice(done); }
    catch (e) { setError({ message: e instanceof Error ? e.message : 'Request failed.', stale: e instanceof ProtectedApiError && e.code === 'STALE_REVISION', checks: e instanceof ProtectedApiError ? e.details.checks : undefined }); }
    finally { setBusy(false); }
  };
  const problems = useMemo(() => t ? elementsProblems(drafts.map(d => ({ ...d, normalized: d.normalized ?? { x: 0, y: 0, width: 0, height: 0 } })), t.source) : [], [drafts, t]);
  if (!t) return <div className="ts-page">{error ? <Alert>{error.message}</Alert> : <p className="ts-muted" role="status">Loading the protected template…</p>}</div>;

  const size = { width: t.source.width, height: t.source.height }, selected = drafts.find(d => d.id === selectedEl);
  const change = (next: ElementDraft[]) => {
    // A region that moved or changed shape needs reviewing again.
    setDrafts(next.map(n => { const before = drafts.find(d => d.id === n.id); return before && JSON.stringify(before.box) !== JSON.stringify(n.box) ? { ...n, review: { status: 'needs-review' } } : n; }));
    setDirty(true);
  };
  const create = (box: SourceBox, kind: ProtectedKind) => {
    const n = drafts.filter(d => d.kind === kind).length + 1, element: ElementDraft = { id: newElementId(), kind, label: `${PROTECTED_KIND_LABELS[kind]} ${n}`, box, zIndex: Math.max(-1, ...drafts.map(d => d.zIndex)) + 1,
      representation: 'raster', mask: { mode: 'difference', threshold: 24 }, locked: true, replaceable: true, origin: 'admin', review: { status: 'needs-review' }, ...(kind === 'text' || kind === 'legal' ? { text: defaultText(box) } : {}) };
    setDrafts([...drafts, element]); setSelectedEl(element.id); setDirty(true);
  };
  const save = () => act(async () => apply(await protectedApi.setElements(t, drafts)), 'Saved.');
  const errors = problems.filter(p => p.severity === 'error'), unreviewed = drafts.filter(d => d.review.status !== 'approved');
  const confirmed = !!t.regionsConfirmed && !problems.some(p => p.code === 'REGIONS_CHANGED') && !t.problems.some(p => p.code === 'REGIONS_CHANGED') && !dirty;
  const baseCurrent = !!t.base && !t.stale.base, baseApproved = baseCurrent && !!t.base?.approval;
  const run = t.latestRun, recon = t.reconstruction, origin = t.source.origin;
  const previousForBase = t.runs.filter(r => r.baseSha256 === t.base?.sha256).length;
  const openRun = async () => { if (!run) return; await onOpenEditor(t, await experimentApi.get(t.approval?.runId ?? run.runId)); };
  return <div className="ts-page pt-page">
    <div className="ts-detail-head">
      <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> Protected templates</button>
      <div className="ts-detail-title"><h2>{t.name} <Badge tone={tone(t.status)}>{STATUS_LABELS[t.status]}</Badge></h2>
        <p>Source {t.source.width}×{t.source.height}{t.source.orientationNormalized ? ' (EXIF orientation applied)' : ''} · revision {t.revision} · coordinates in source pixels</p></div>
    </div>
    <section className="pt-feature-entry" aria-label="Editable words and style variations">
      <div>
        <p className="ts-kicker">WORD-LEVEL EDITING + STYLE VARIATIONS</p>
        <h3>Edit each word. Replace each logo. Create another style.</h3>
        <p>Review the protected regions, detect individual words and logo slots, then create artwork with editable content on top. Seedream decomposition is optional for this workflow.</p>
      </div>
      <nav className="pt-feature-shortcuts" aria-label="Protected template workflow">
        <button type="button" className="ws-btn" onClick={() => document.getElementById('pt-step-regions')?.closest('section')?.scrollIntoView({ block: 'start' })}>
          <strong>1 · Review regions</strong><span>{confirmed ? 'Regions confirmed' : dirty ? 'Save your region changes first' : `${unreviewed.length} region(s) need review`}</span>
        </button>
        <button type="button" className="ws-btn" onClick={() => document.getElementById('pt-step-words')?.closest('section')?.scrollIntoView({ block: 'start' })}>
          <strong>2 · Words &amp; logos</strong><span>{t.textAnalysis ? `${t.textAnalysis.words.length} words · ${t.textAnalysis.logoSlots.length} logo slots` : confirmed ? 'Run local detection · free' : 'Confirm regions to enable detection'}</span>
        </button>
        <button type="button" className="ws-btn" onClick={() => document.getElementById('pt-step-variations')?.closest('section')?.scrollIntoView({ block: 'start' })}>
          <strong>3 · Style variations</strong><span>{!baseApproved ? 'Prepare and approve the clean base' : !t.textAnalysis ? 'Detect and review words first' : 'Choose styles, compare and open in editor'}</span>
        </button>
      </nav>
      {!confirmed && <p className="ts-hint">This template has not completed region review. The large headline box below is a region; individual words appear after local detection in Words &amp; logos.</p>}
    </section>
    {origin.kind === 'template-studio-poster' && origin.provenance === 'reference_reuse' && <Alert tone="warn"><strong>Reused reference, not a generated image.</strong> This poster is the template's original reference copied unchanged (Match Reference with nothing to change): no AI image was generated, and its bank logos and text are part of the pixels. Mark them here so they stay out of decomposition.</Alert>}
    {origin.kind === 'decomposition-run' && <p className="ts-muted">From saved run {origin.runId}: the exact image that run used.</p>}
    {error && <Alert>{error.message}{error.stale && <> <button type="button" className="ws-link" onClick={() => void load()}>Reload the template</button></>}
      {error.checks && <ul>{error.checks.filter(c => c.status === 'fail').map(c => <li key={c.id}>{c.label}: {c.detail}</li>)}</ul>}</Alert>}
    {notice && <Alert tone="ok">{notice}</Alert>}

    <StepCard step={1} id="pt-step-regions" title="Mark protected text and logos" hint="Draw a box over each bank logo, headline, offer and fine print. Draw a region or add one, then set exact pixels, how it is kept, and review it.">
      <div className="pt-annotate">
        <RegionEditor imageUrl={protectedFileUrl(t.id, t.source.inputFile)} size={size} elements={drafts} selectedId={selectedEl} onSelect={setSelectedEl} onChange={change} onCreate={create}
          drawKind={drawKind} onDrawKind={setDrawKind} snap={snap} onSnap={setSnap} readOnly={busy} />
        <aside className="pt-side">
          <div className="pt-side-head"><h4>Protected elements ({drafts.length})</h4>
            <button type="button" className="ws-btn" onClick={() => create({ x: Math.round(size.width * 0.35), y: Math.round(size.height * 0.45), width: Math.round(size.width * 0.3), height: Math.round(size.height * 0.08), rotation: 0 }, drawKind)}><Plus size={14} aria-hidden="true" />Add {PROTECTED_KIND_LABELS[drawKind].toLowerCase()}</button></div>
          <ul className="pt-elements" aria-label="Protected elements">{[...drafts].sort((a, b) => a.zIndex - b.zIndex).map(d => <li key={d.id}><button type="button" aria-pressed={d.id === selectedEl} onClick={() => setSelectedEl(d.id)}>
            <span className={`pt-dot pt-kind-${d.kind}`} aria-hidden="true" />{d.label}<small>{PROTECTED_KIND_LABELS[d.kind]} · {d.representation === 'native-text' ? 'editable text' : d.representation === 'source-asset' ? 'original file' : 'original pixels'}</small>
            {d.review.status === 'approved' ? <CheckCircle2 size={14} className="pt-ok" aria-label="Reviewed" /> : <span className="pt-todo">Review</span>}</button></li>)}</ul>
          {selected ? <ElementPanel key={selected.id} templateId={t.id} element={selected} size={size} onChange={next => { setDrafts(drafts.map(d => d.id === next.id ? next : d)); setDirty(true); }}
            onDelete={() => { setDrafts(drafts.filter(d => d.id !== selected.id)); setSelectedEl(null); setDirty(true); }} uploading={busy}
            onUpload={dirty ? undefined : file => void act(async () => apply(await protectedApi.attachAsset(t, selected.id, file)), 'Original file stored byte for byte.')} />
            : <p className="ts-hint">Select a region to set its details.{dirty ? '' : ' Save before uploading an original file.'}</p>}
        </aside>
      </div>
      {problems.length > 0 && <ul className="pt-problems" aria-label="Problems">{problems.map((p, i) => <li key={i} className={`is-${p.severity}`}>{p.message}</li>)}</ul>}
      <div className="ws-row">
        <button type="button" className="ws-btn" disabled={!dirty || busy} onClick={() => void save()}><Save size={15} aria-hidden="true" />Save changes</button>
        <button type="button" className="ws-btn ws-btn-primary" disabled={dirty || busy || !drafts.length || errors.length > 0 || unreviewed.length > 0 || confirmed}
          onClick={() => void act(async () => apply(await protectedApi.confirmRegions(t)), 'Protected regions confirmed.')}><ShieldCheck size={15} aria-hidden="true" />{confirmed ? 'Regions confirmed' : 'Confirm protected regions'}</button>
        {dirty && <span className="ts-hint">Unsaved changes.</span>}
        {!dirty && unreviewed.length > 0 && <span className="ts-hint">Review every element to confirm ({unreviewed.length} left).</span>}
      </div>
    </StepCard>

    <StepCard step={2} id="pt-step-base" title="Prepare the artwork Seedream receives" hint="The creative without its protected content. Clean artwork (before text and logos were added) is reliable; filling the regions from their surroundings is an estimate you must check.">
      {!confirmed ? <p className="ts-muted">Confirm the protected regions first.</p> : <>
        <div className="pt-methods">
          <label className="ws-btn"><Upload size={14} aria-hidden="true" />Upload clean artwork<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Clean artwork" disabled={busy}
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(async () => { apply(await protectedApi.uploadBase(t, f)); setBaseView('base'); setAcknowledgeBase(false); }, 'Clean artwork stored and checked.'); }} /></label>
          {origin.kind === 'template-studio-poster' && origin.provenance === 'ai_generated' && <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(async () => {
            apply(await protectedApi.uploadBase(t, await browserFetch.blob(studioSceneUrl(origin.posterId)), 'structured-scene')); setBaseView('base'); setAcknowledgeBase(false);
          }, 'Template Studio scene stored and checked.')}>Use the Template Studio scene (made without text or logos)</button>}
          <button type="button" className="ws-btn" disabled={busy} onClick={() => void act(async () => { apply(await protectedApi.localFill(t)); setBaseView('fill'); setAcknowledgeBase(false); }, 'Regions filled locally. Check the filled areas.')}>Fill the regions from their surroundings (local, no AI)</button>
        </div>
        {t.base && <>
          <p><strong>{PROTECTED_BASE_METHODS[t.base.method]}</strong> · {t.base.width}×{t.base.height} · <Badge tone={t.base.reliability === 'reliable' ? 'ok' : 'warn'}>{t.base.reliability === 'reliable' ? 'Checks passed' : 'Estimate: check it'}</Badge>
            {t.stale.base && <Badge tone="danger">Made for other regions</Badge>} {t.base.approval && !t.stale.base && <Badge tone="ok">Approved</Badge>}</p>
          <div className="ts-view-tabs" role="tablist" aria-label="Base view">
            {(['source', 'base', ...(t.base.fill ? ['fill'] : [])] as ('source' | 'base' | 'fill')[]).map(v => <button key={v} type="button" role="tab" aria-selected={baseView === v} className={baseView === v ? 'is-on' : undefined} onClick={() => setBaseView(v)}>{v === 'source' ? 'Source creative' : v === 'base' ? 'Sent to Seedream' : 'Filled areas'}</button>)}</div>
          <figure className="pt-figure" style={{ aspectRatio: `${t.source.width} / ${t.source.height}` }}><img src={protectedFileUrl(t.id, baseView === 'source' ? t.source.inputFile : baseView === 'fill' && t.base.fill ? t.base.fill.previewFile : t.base.file)} alt={baseView === 'base' ? 'The exact image proposed for Seedream' : baseView === 'fill' ? 'Filled areas: green continued from a plain or flat surrounding, amber estimated' : 'Source creative'} /></figure>
          <ul className="pt-checks" aria-label="Base checks">
            {t.base.checks.map(c => { const e = t.elements.find(x => x.id === c.elementId); return <li key={c.elementId} className={c.differsFromSource ? 'is-pass' : 'is-warn'}>{e?.label ?? c.elementId}: {c.differsFromSource ? 'removed from the base' : 'still looks like the source here: Seedream would decompose it too'} (mean difference {c.meanDiff})</li>; })}
            {t.base.method !== 'local-fill' && <li className={t.base.outsideMeanDiff <= 10 ? 'is-pass' : 'is-warn'}>Outside the protected regions the artwork {t.base.outsideMeanDiff <= 10 ? 'matches the source' : 'differs from the source'} (mean difference {t.base.outsideMeanDiff}).</li>}
            {t.base.fill?.regions.map((r, i) => <li key={i} className={r.trusted ? 'is-pass' : 'is-warn'}>{r.elementIds.map(e => t.elements.find(x => x.id === e)?.label ?? e).join(', ')}: {r.trusted ? 'continued' : 'estimated'} ({r.method.replace('-', ' ')}, {r.areaPercent}% of the image). {r.reason}</li>)}
          </ul>
          {!t.base.approval && !t.stale.base && <div className="ts-confirm">
            {t.base.reliability === 'uncertain' && <label className="ts-check"><input type="checkbox" checked={acknowledgeBase} onChange={e => setAcknowledgeBase(e.target.checked)} />
              <span>{t.base.method === 'local-fill' ? 'I looked at the filled areas. What lies under the protected content is an estimate, and I accept it for decomposition.' : 'I looked at the clean artwork and accept it despite the checks above.'}</span></label>}
            <button type="button" className="ws-btn ws-btn-primary" disabled={busy || (t.base.reliability === 'uncertain' && !acknowledgeBase)} onClick={() => void act(async () => apply(await protectedApi.approveBase(t, acknowledgeBase)), 'Base approved.')}>Approve this base</button>
          </div>}
        </>}
      </>}
    </StepCard>

    <StepCard step={3} id="pt-step-decompose" title="Decompose with Seedream 5.0 Pro Layerize" hint="One paid request with the prepared base only. No planner, image edit or other model; the provider's safety checker stays on. Never sent or repeated by itself.">
      {!baseApproved ? <p className="ts-muted">Approve the prepared base first.</p> : <>
        <div className="ts-field"><label htmlFor="pt-instructions">Layer instructions for Seedream (optional)</label>
          <textarea id="pt-instructions" rows={2} maxLength={2000} value={instructions} placeholder="Empty: Seedream decides the layers itself (automatic mode)." onChange={e => setInstructions(e.target.value)} />
          {instructions !== t.layerInstructions && <button type="button" className="ws-link" disabled={busy} onClick={() => void act(async () => apply(await protectedApi.rename(t, { layerInstructions: instructions }), true), 'Instructions saved.')}>Save instructions</button>}</div>
        {preflight && <ul className="pt-checks" aria-label="Checks before the paid request">{preflight.checks.map(c => <li key={c.id} className={`is-${c.status}`}><strong>{c.label}:</strong> {c.detail}</li>)}</ul>}
        {preflight?.estimate && <p className="ts-hint">Cost: up to {usd(preflight.estimate.maxUsd)} ({inr(preflight.estimate.maxInr)} at ₹{preflight.estimate.fx}/$). {preflight.estimate.note}</p>}
        {!confirming ? <button type="button" className="ws-btn ws-btn-primary" disabled={busy || running || !preflight?.ok || dirty || instructions !== t.layerInstructions}
          onClick={() => { key.current = newKey(); setRepeat(false); setConfirming(true); }}><Layers3 size={15} aria-hidden="true" />{previousForBase ? 'Decompose again…' : 'Decompose with Seedream…'}</button>
          : <div className="ts-confirm" role="group" aria-label="Confirm the paid request">
            <p><strong>Send the prepared base to {preflight?.estimate?.endpoint ?? 'Seedream'}?</strong> One paid request, up to {preflight?.estimate ? `${usd(preflight.estimate.maxUsd)} (${inr(preflight.estimate.maxInr)})` : 'its listed price'}. The protected text and logos are not in this image and are never sent. Seedream may refuse an image; nothing is retried automatically.</p>
            {previousForBase > 0 && <label className="ts-check"><input type="checkbox" checked={repeat} onChange={e => setRepeat(e.target.checked)} /><span>This base was sent {previousForBase} time{previousForBase === 1 ? '' : 's'} before. Send it again as a new paid request.</span></label>}
            <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy || (previousForBase > 0 && !repeat)} onClick={() => void act(async () => {
              const result = await protectedApi.decompose(t, key.current!, repeat); apply(result.template, true); setConfirming(false); key.current = undefined;
            }, 'Sent to Seedream.')}>Send to Seedream (paid)</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button></div>
          </div>}
        {run && <RunStatus template={t} onOpenRun={onOpenRun} onResume={() => void act(async () => { await protectedApi.resume(t.id, run.runId); await load(true); }, 'Resuming from the saved request (no new paid request).')} busy={busy} />}
      </>}
    </StepCard>

    <StepCard step={4} id="pt-step-review" title="Review the reconstruction" hint="Seedream's layers with the protected content restored on top, compared with the source pixel by pixel.">
      {!recon || !run?.usable ? <p className="ts-muted">{run?.stage === 'done' && !run.usable ? `The run has no usable layers: ${run.problems.join(' ')}` : 'Decompose the base first.'}</p> : <>
        <div className="ts-view-tabs" role="tablist" aria-label="Reconstruction view">
          {(['source', 'seedream', 'reconstruction'] as const).map(v => <button key={v} type="button" role="tab" aria-selected={reviewView === v} className={reviewView === v ? 'is-on' : undefined} onClick={() => setReviewView(v)}>{v === 'source' ? 'Source creative' : v === 'seedream' ? 'Seedream layers only' : 'Reconstruction'}</button>)}</div>
        <figure className="pt-figure" style={{ aspectRatio: `${t.source.width} / ${t.source.height}` }}><img src={reviewView === 'source' ? protectedFileUrl(t.id, t.source.inputFile) : reviewView === 'seedream' ? experimentFileUrl(run.runId, 'reconstructed.png') : protectedFileUrl(t.id, recon.file)} alt={`${reviewView} view`} /></figure>
        <table className="pt-metrics"><caption>Measured against the source (largest channel difference, 0–255; tolerance {recon.metrics.tolerance})</caption>
          <thead><tr><th>Area</th><th>Shown as</th><th>Exact where fully protected</th><th>Exact overall</th><th>Largest difference</th><th>Mean difference</th></tr></thead>
          <tbody>
            <tr><td>Whole image</td><td>—</td><td>—</td><td>{recon.metrics.overall.withinTolerancePercent}% within tolerance</td><td>—</td><td>{recon.metrics.overall.meanAbsDiff}</td></tr>
            <tr><td>Outside protected regions (Seedream)</td><td>Seedream layers</td><td>—</td><td>{recon.metrics.outsideProtected.withinTolerancePercent}% within tolerance</td><td>—</td><td>{recon.metrics.outsideProtected.meanAbsDiff}</td></tr>
            {recon.metrics.protected.map(p => <tr key={p.elementId}><td>{p.label}</td><td>{p.representation === 'raster' ? 'original pixels' : p.representation === 'source-asset' ? 'original file' : 'editable text (pixels shown here)'}</td>
              <td>{p.opaquePixels ? `${p.opaqueExactPercent}% of ${p.opaquePixels}` : '—'}</td><td>{p.exactPercent}%</td><td>{p.maxDiff}</td><td>{p.meanAbsDiff}</td></tr>)}
          </tbody></table>
        {recon.duplicates.some(d => d.suspected) && <Alert tone="warn">Possible duplicates: {recon.duplicates.filter(d => d.suspected).map(d => d.label).join(', ')}. Seedream's own layers look like the protected content where it was removed. Check the layers.</Alert>}
        {recon.blockers.length > 0 && <Alert>{recon.blockers.join(' ')}</Alert>}
        {recon.warnings.length > 0 && <ul className="pt-problems">{recon.warnings.map((w, i) => <li key={i} className="is-warning">{w}</li>)}</ul>}
        {t.status !== 'approved' && <div className="ts-confirm">
          {recon.warnings.length > 0 && <label className="ts-check"><input type="checkbox" checked={!!ack.warnings} onChange={e => setAck({ ...ack, warnings: e.target.checked })} /><span>I checked the notes above.</span></label>}
          {recon.duplicates.some(d => d.suspected) && <label className="ts-check"><input type="checkbox" checked={!!ack.duplicates} onChange={e => setAck({ ...ack, duplicates: e.target.checked })} /><span>I checked the layers for duplicated logos or text.</span></label>}
          <div className="ws-row">
            <button type="button" className="ws-btn ws-btn-primary" disabled={busy || recon.blockers.length > 0 || (recon.warnings.length > 0 && !ack.warnings) || (recon.duplicates.some(d => d.suspected) && !ack.duplicates)}
              onClick={() => void act(async () => apply(await protectedApi.approve(t, run.runId, Object.keys(ack).filter(k => ack[k]))), 'Template approved.')}><CheckCircle2 size={15} aria-hidden="true" />Approve template</button>
            <button type="button" className="ws-btn ws-btn-quiet" disabled={busy} onClick={() => void act(async () => { await protectedApi.reconstruct(t.id, run.runId); await load(true); }, 'Reconstructed again.')}><RefreshCw size={14} aria-hidden="true" />Reconstruct again</button>
          </div>
        </div>}
      </>}
    </StepCard>

    <StepCard step={5} id="pt-step-use" title="Use the template" hint="Opens Seedream's layers and the protected slots in the editor. A reuse replaces logos and copy in their saved slots, with no new decomposition and no AI call.">
      {t.status !== 'approved' ? <p className="ts-muted">Approve the template first.{t.stale.approval ? ' Its earlier approval no longer matches its elements or base.' : ''}</p> : <>
        <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(openRun)}><Layers3 size={15} aria-hidden="true" />Open in editor</button>
          <span className="ts-hint">Approved {fmtDate(t.approval!.at)} · run {t.approval!.runId.slice(-6)}</span></div>
        <ReuseForm template={t} busy={busy} onCreate={(replacements, name) => act(async () => onOpenEditor(t, await experimentApi.get(t.approval!.runId), { replacements, name }))} />
      </>}
    </StepCard>

    <StepCard step={6} id="pt-step-words" title="Words and logos" hint="Every word as its own editable text, every logo as its own replaceable slot. Read on this server by a local recognizer (no AI provider); you correct and approve each one.">
      <WordsAndLogos key={`${t.textAnalysis?.revision ?? 0}-${t.textAnalysis?.analyzedAt ?? ''}`} template={t} busy={busy} act={act} apply={next => apply(next, true)} confirmed={confirmed} />
    </StepCard>

    <StepCard step={7} id="pt-step-variations" title="Style variations" hint="New artwork in other styles from the approved text-free base, with the template's own words and logos placed on top by FrameFlow. AI artwork is paid and needs your confirmation; local restyles are free.">
      {!baseApproved ? <p className="ts-muted">Approve the prepared base first (step 2): it is the only picture the image model sees.</p>
        : !t.textAnalysis ? <p className="ts-muted">Find and review the words and logos first (step 6).</p>
        : <StyleVariations template={t} onOpen={onOpenVariation} />}
    </StepCard>
  </div>;
}

function RunStatus({ template: t, onOpenRun, onResume, busy }: { template: ProtectedTemplateView; onOpenRun: (id: string) => void; onResume: () => void; busy: boolean }) {
  const run = t.latestRun!, error = run.error, partner = run.rejection?.category === 'partner-content';
  const resumable = !!run.requestId && !run.active && (t.status === 'interrupted' || (run.stage === 'failed' && !!error && !['PROVIDER_DECOMPOSITION_REJECTED', 'PROVIDER_SAFETY_REJECTED'].includes(error.code) && ![400, 422].includes(error.provider?.status ?? 0)));
  return <div className="pt-run" aria-label="Latest decomposition" role="status">
    <p>{run.active && run.stage === 'uploaded' ? <><LoaderCircle size={15} className="ws-spin" aria-hidden="true" /> Waiting for another decomposition to finish; run {run.runId.slice(-6)} is sent next (once).</>
      : run.active ? <><LoaderCircle size={15} className="ws-spin" aria-hidden="true" /> Seedream is working on run {run.runId.slice(-6)} ({run.stage.replace('_', ' ')})…</> : <>Run {run.runId.slice(-6)}: <strong>{run.stage === 'done' ? `${run.editorLayers} layers returned` : run.stage}</strong></>}
      {run.requestId && <span className="ts-hint"> · fal request {run.requestId}</span>}{!run.current && <Badge tone="warn">made from an earlier base</Badge>}</p>
    {error && <Alert>{partner ? <><strong>Seedream's provider refused the prepared base</strong> (HTTP {error.provider?.status}, {run.rejection?.reason ?? 'content policy'}{run.rejection?.billableUnits === '0' ? ', billed 0 units' : ''}). The provider does not say what it flagged. The same image is not sent again: change the clean artwork or the protected regions first.</>
      : <>{error.code}: {error.message}</>}
      {error.provider && <ul>{error.provider.messages.map((m, i) => <li key={i}>{m.msg}{m.loc ? ` (${m.loc})` : ''}</li>)}</ul>}</Alert>}
    <div className="ws-row">
      <button type="button" className="ws-btn" onClick={() => onOpenRun(run.runId)}>View run, costs and diagnostics</button>
      {resumable && <button type="button" className="ws-btn" disabled={busy} onClick={onResume}>Resume saved request (no new paid request)</button>}
    </div>
  </div>;
}

/** A reuse: for each replaceable slot, keep it, give it a new picture or text, or hide it; then a new design. */
function ReuseForm({ template: t, busy, onCreate }: { template: ProtectedTemplateView; busy: boolean; onCreate: (replacements: Record<string, SlotReplacement>, name: string) => Promise<void> }) {
  const [choices, setChoices] = useState<Record<string, SlotReplacement>>({}), [name, setName] = useState(`${t.name} · reuse`);
  const slots = [...t.elements].filter(e => e.replaceable).sort((a, b) => a.zIndex - b.zIndex);
  const set = (id: string, value: SlotReplacement) => setChoices({ ...choices, [id]: value });
  return <section className="pt-reuse" aria-label="Reuse with new content">
    <h4>Reuse with new logos and copy</h4>
    {!slots.length ? <p className="ts-muted">No element is marked replaceable.</p> : <ul>{slots.map(e => {
      const c = choices[e.id] ?? { kind: 'keep' };
      return <li key={e.id}><div><strong>{e.label}</strong><small>{PROTECTED_KIND_LABELS[e.kind]}</small></div>
        <select aria-label={`What to do with ${e.label}`} value={c.kind} onChange={ev => set(e.id, ev.target.value === 'text' ? { kind: 'text', text: e.text?.value ?? '' } : ev.target.value === 'hide' ? { kind: 'hide' } : { kind: 'keep' })}>
          <option value="keep">Keep the original</option>{e.representation !== 'native-text' && <option value="image" disabled={c.kind !== 'image'}>{c.kind === 'image' ? 'New picture (chosen)' : 'New picture: choose a file'}</option>}
          {textReplaceable(e) && <option value="text">New text</option>}<option value="hide">Hide</option></select>
        {c.kind === 'text' && <textarea aria-label={`New text for ${e.label}`} rows={2} maxLength={5000} value={c.text} onChange={ev => set(e.id, { kind: 'text', text: ev.target.value })} />}
        {e.representation !== 'native-text' && <label className="ws-btn ws-btn-quiet"><Upload size={14} aria-hidden="true" />{c.kind === 'image' ? 'Picture chosen' : 'New picture…'}<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={`New picture for ${e.label}`}
          onChange={ev => { const f = ev.target.files?.[0]; ev.target.value = ''; if (f) set(e.id, { kind: 'image', blob: f }); }} /></label>}
      </li>;
    })}</ul>}
    <div className="ws-row"><div className="ts-field"><label htmlFor="pt-reuse-name">Design name</label><input id="pt-reuse-name" value={name} maxLength={120} onChange={e => setName(e.target.value)} /></div>
      <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !name.trim()} onClick={() => void onCreate(choices, name.trim())}>Create a new design</button></div>
    <p className="ts-hint">Seedream is not called again: the saved layers and slots are reused. A new picture is fitted inside its slot without distortion.</p>
  </section>;
}
