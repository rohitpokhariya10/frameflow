/**
 * Phase 1 for one master: Upload (done) → Scan & Review → Prepare & Save. The scan and the clean background run on this
 * server (no AI provider, no cost). Splitting the background into layers with Seedream is optional, priced and confirmed;
 * the protected template's own request sends only the clean background (never the text or logos).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, CheckCircle2, ImageUp, Layers3, LoaderCircle, RefreshCw, Sparkles, Upload, Wand2 } from 'lucide-react';
import { MASTER_STAGE_LABELS } from '@frameflow/shared';
import { Alert, Badge } from '../templateStudio/ui';
import { protectedApi, type Preflight } from '../protectedTemplates/api';
import { masterApi, masterFileUrl, MasterApiError, removalPreviewUrl, type MasterView, type ReviewDraft } from './api';
import { ReviewWorkspace } from './ReviewWorkspace';
import { RescanPanel } from './RescanPanel';

const STEPS = ['Upload', 'Scan & Review', 'Prepare & Save'] as const;
const stepOf = (v: MasterView) => v.stage === 'scanning' || v.stage === 'scan-failed' || v.stage === 'review' ? 1 : 2;
const newKey = () => `master-${crypto.randomUUID().replace(/-/g, '')}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

export function MasterSetup({ id, onBack, onReuse, onOpenEditor }: { id: string; onBack: () => void; onReuse: (id: string) => void; onOpenEditor: (id: string) => Promise<void> }) {
  const [view, setView] = useState<MasterView>(), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(), [rescanOpen, setRescanOpen] = useState(false);
  // The step follows the master when it is opened (and once its scan is done); after that only the user moves on, so
  // approving the last element never jumps away from the review.
  const show = useCallback((v: MasterView) => { setView(v); if (v.stage !== 'scanning' && v.stage !== 'scan-failed') setStep(s => s ?? stepOf(v)); }, []);
  const load = useCallback(async () => { const v = await masterApi.get(id); show(v); return v; }, [id, show]);
  useEffect(() => {
    let alive = true;
    void masterApi.get(id).then(v => { if (alive) show(v); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [id, show]);
  const running = view?.stage === 'scanning' || !!view?.template.latestRun?.active || view?.master.rescan?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void load().catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [running, load]);
  const act = async (work: () => Promise<unknown>, done?: string) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); if (done) setNotice(done); }
    catch (e) { setError(e instanceof MasterApiError && e.code === 'STALE_REVISION' ? `${e.message}` : e instanceof Error ? e.message : 'Request failed.'); await load().catch(() => undefined); }
    finally { setBusy(false); }
  };
  if (!view) return <div className="ot-page">{error ? <Alert>{error}</Alert> : <p className="ot-muted" role="status">Loading…</p>}</div>;
  const current = view.stage === 'scanning' || view.stage === 'scan-failed' ? 1 : step ?? stepOf(view);
  // Scan Again: offered once the first scan is done; its panel stays while it runs or has results to look at.
  const canRescan = !!view.template.textAnalysis && view.stage !== 'scanning' && view.stage !== 'scan-failed', rescanShown = canRescan && (rescanOpen || !!view.master.rescan);
  return <div className="ot-page">
    <div className="ot-head">
      <div className="ot-row">
        <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />Templates</button>
        <div><p className="ot-kicker">Text &amp; Graphics template</p><h2>{view.template.name} <Badge tone={view.stage === 'ready' ? 'ok' : view.stage === 'scan-failed' ? 'danger' : 'neutral'}>{MASTER_STAGE_LABELS[view.stage]}</Badge></h2></div>
        {canRescan && !rescanShown && <button type="button" className="ws-btn" onClick={() => { setNotice(''); setRescanOpen(true); }} title="Check your original design again to find text and improve font matching. Your saved creatives won't change."><RefreshCw size={15} aria-hidden="true" />Scan Again</button>}
      </div>
      <ol className="ot-steps" aria-label="Template creation steps">
        {STEPS.map((label, i) => <li key={label} className={i === current ? 'is-current' : i < current ? 'is-done' : undefined} aria-current={i === current ? 'step' : undefined}><span>{i < current ? '✓' : i + 1}</span>{label}</li>)}
      </ol>
    </div>
    {error && <Alert>{error}</Alert>}
    {notice && <Alert tone="ok">{notice}</Alert>}
    {rescanShown && <RescanPanel view={view} onView={setView} onClose={() => setRescanOpen(false)}
      onApplied={(v, message) => { setView(v); setRescanOpen(false); setNotice(message); setStep(stepOf(v)); }} />}
    {current === 1 ? <ScanStep view={view} busy={busy} act={act} setView={setView} onContinue={() => setStep(2)} />
      : <PrepareStep view={view} busy={busy} act={act} setView={setView} load={load} onBackToReview={() => setStep(1)} onReuse={() => onReuse(id)} onOpenEditor={() => act(() => onOpenEditor(id))} onDone={onBack} />}
  </div>;
}

type Act = (work: () => Promise<unknown>, done?: string) => Promise<void>;
function ScanStep({ view, busy, act, setView, onContinue }: { view: MasterView; busy: boolean; act: Act; setView: (v: MasterView) => void; onContinue: () => void }) {
  if (view.stage === 'scanning' || !view.template.textAnalysis) {
    const failed = view.stage === 'scan-failed' || view.master.scan?.status === 'failed';
    return <section className="ts-card"><div className="ts-card-body">
      {failed ? <Alert>The scan stopped: {view.master.scan?.error ?? 'unknown error'}. <button type="button" className="ws-link" disabled={busy} onClick={() => void act(async () => setView((await masterApi.scan(view, true)).master))}>Scan again</button></Alert>
        : <p className="ot-row" role="status"><LoaderCircle size={18} className="ws-spin" aria-hidden="true" /><strong>Scanning the poster for text, logos and offer elements…</strong></p>}
      <p className="ot-muted">Read on this computer (local OCR and image analysis): nothing is sent anywhere and it costs nothing. It takes a few seconds, and runs once for this poster.</p>
      <img src={masterFileUrl(view.template.id, view.template.source.inputFile)} alt="The uploaded poster" style={{ maxWidth: 360, borderRadius: 8, border: '1px solid var(--color-line)' }} />
    </div></section>;
  }
  const scan = view.master.scan;
  return <>
    {scan?.found && <p className="ot-muted" role="status">Found {scan.found.words} words in {scan.found.groups} groups, {scan.found.logos} logos and graphics{scan.found.plates ? `, ${scan.found.plates} text plate${scan.found.plates === 1 ? '' : 's'}` : ''} in {Math.round((scan.durationMs ?? 0) / 100) / 10} s ({scan.recognizerCalls} local OCR reads; {scan.found.ignored} decorative readings left out).</p>}
    <ReviewWorkspace key={`${view.template.textAnalysis.revision}-${view.template.revision}`} view={view} busy={busy}
      onSave={(draft: ReviewDraft) => act(async () => setView(await masterApi.saveReview(view, draft)), 'Changes saved.')}
      onApproveAll={includeUncertain => act(async () => setView(await masterApi.approveAll(view, includeUncertain)))}
      onContinue={onContinue} />
  </>;
}

function PrepareStep({ view, busy, act, setView, load, onBackToReview, onReuse, onOpenEditor, onDone }: {
  view: MasterView; busy: boolean; act: Act; setView: (v: MasterView) => void; load: () => Promise<MasterView>;
  onBackToReview: () => void; onReuse: () => void; onOpenEditor: () => void; onDone: () => void;
}) {
  const t = view.template, base = t.base && !view.background.stale ? t.base : undefined, cleanup = view.master.cleanup && base && view.master.cleanup.baseSha256 === base.sha256 ? view.master.cleanup : undefined;
  const [show, setShow] = useState<'clean' | 'areas' | 'source' | 'saved'>('clean'), [acknowledged, setAcknowledged] = useState(false), [preparing, setPreparing] = useState(false);
  // A background made again after publishing: the saved one (the published revision's) beside it, to compare before approving.
  const saved = view.latestRevision, compare = saved && base && base.sha256 !== saved.baseSha256 ? saved.revision : undefined, [savedBackground, setSavedBackground] = useState<{ revision: number; file: string }>();
  useEffect(() => {
    if (compare === undefined) return;
    let live = true;
    void masterApi.snapshot(t.id, compare).then(s => { if (live) setSavedBackground({ revision: compare, file: s.background.file }); }).catch(() => undefined);
    return () => { live = false; };
  }, [t.id, compare]);
  const savedFile = compare !== undefined && savedBackground?.revision === compare ? savedBackground.file : undefined;
  // Before cleaning: what will be removed (tinted), or the poster as it is.
  const [before, setBefore] = useState<'removal' | 'source'>('removal'), [shown, setShown] = useState<{ url: string; ok: boolean }>();
  const beforeUrl = before === 'removal' ? removalPreviewUrl(view) : masterFileUrl(t.id, t.source.inputFile), beforeState = shown?.url === beforeUrl ? (shown.ok ? 'ready' : 'failed') : 'loading';
  const estimates = cleanup?.areas.filter(a => !a.trusted) ?? [];
  const published = view.stage === 'ready';
  const prepare = () => act(async () => { setPreparing(true); try { setView(await masterApi.prepare(view)); setShow('clean'); setAcknowledged(false); } finally { setPreparing(false); } }, 'Clean background ready. Check it, then approve it.');
  return <div className="ot-work">
    <div className="ot-stage">
      {base ? <>
        <div className="ot-stage-toolbar" role="tablist" aria-label="Background view">
          {(['clean', 'areas', 'saved', 'source'] as const).filter(v => (v !== 'areas' || base.fill) && (v !== 'saved' || savedFile)).map(v => <button key={v} type="button" role="tab" aria-selected={show === v} className={`ws-btn${show === v ? ' ws-btn-primary' : ''}`} onClick={() => setShow(v)}>
            {v === 'clean' ? (savedFile ? 'New clean background' : 'Clean background') : v === 'areas' ? 'Changed areas' : v === 'saved' ? `Saved background (version ${saved?.revision})` : 'Original poster'}</button>)}
        </div>
        <figure className="ot-figure" style={{ maxWidth: 820 }}><img src={masterFileUrl(t.id, show === 'source' ? t.source.inputFile : show === 'areas' && base.fill ? base.fill.previewFile : show === 'saved' && savedFile ? savedFile : base.file)}
          alt={show === 'clean' ? 'Clean background without the replaceable text and logos' : show === 'areas' ? 'Changed areas: green matched nearby colours or patterns, amber needs closer review' : show === 'saved' ? 'The saved clean background of the published template' : 'Original poster'} data-testid="background-preview" /></figure>
      </> : <>
        <div className="ot-stage-toolbar" role="tablist" aria-label="Before cleaning">
          {(['removal', 'source'] as const).map(v => <button key={v} type="button" role="tab" aria-selected={before === v} className={`ws-btn${before === v ? ' ws-btn-primary' : ''}`} onClick={() => setBefore(v)}>{v === 'removal' ? 'What will be cleaned' : 'Original poster'}</button>)}
        </div>
        <figure className="ot-figure" style={{ maxWidth: 820 }}>
          {beforeState === 'loading' && <p className="ot-muted" role="status"><LoaderCircle size={14} className="ws-spin" aria-hidden="true" /> {before === 'removal' ? 'Preparing the preview… (a few seconds)' : 'Loading…'}</p>}
          {beforeState === 'failed' && <Alert tone="warn">The preview could not be shown. You can still make the clean background and check it there.</Alert>}
          <img src={beforeUrl} data-testid="removal-preview" data-state={beforeState} hidden={beforeState !== 'ready'} onLoad={() => setShown({ url: beforeUrl, ok: true })} onError={() => setShown({ url: beforeUrl, ok: false })}
            alt={before === 'removal' ? 'The poster with what will be cleaned shown in pink' : 'Original poster'} />
          {before === 'removal' && beforeState === 'ready' && <figcaption className="ot-small">Pink: removed from the background (text, logos, shapes behind text). Anything else stays.</figcaption>}
        </figure>
      </>}
    </div>
    <div className="ot-panel" aria-label="Prepare and save">
      <section>
        <h3>1 · Clean background</h3>
        <p className="ot-muted">The approved text, logos and plates are removed and the artwork behind them is continued, on this computer (free). Decorative artwork stays.</p>
        {base && view.background.olderCleanup && <Alert tone="warn"><span data-testid="older-cleanup">This clean background was made with an older version of FrameFlow’s clean-up and may keep small leftovers: marks of removed text, white patches or smudges. <strong>Make it again</strong> with the current clean-up (free, on this computer), compare it with the saved one, then approve it and save the master. Saving publishes a new version; existing creatives keep their background until you update them.</span></Alert>}
        {!base && <p className="ot-small ot-check-first" data-testid="clean-check-hint"><strong>Check first:</strong> everything in pink will be removed. Text that is <em>not</em> pink would stay in the background and show behind your new text: <button type="button" className="ws-link" onClick={onBackToReview}>go back to Scan &amp; Review</button> and add it (or use Scan Again at the top).</p>}
        {!base ? <div className="ot-row">
          <button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void prepare()}>{preparing ? <><LoaderCircle size={14} className="ws-spin" aria-hidden="true" />Preparing… (up to a minute)</> : <><Wand2 size={14} aria-hidden="true" />Make the clean background</>}</button>
          <UploadBackground view={view} busy={busy} act={act} setView={setView} />
        </div> : <>
          {cleanup && <><p className="ot-small">{cleanup.trustedPercent}% of the removed area was filled using matching nearby colours or patterns{estimates.length ? `; ${estimates.length} area(s) need closer review, shown in amber.` : '.'}</p>
            <p className="ot-small" data-testid="cleanup-review-hint">This is a local repair, not the original hidden artwork. Zoom in to check for leftover text, seams or smudges, including in green areas. If the result is not clean enough, go back to correct the detected elements or use your own clean background.</p></>}
          {!cleanup && base.method === 'clean-upload' && <p className="ot-small">Your own clean background ({base.reliability === 'reliable' ? 'its checks passed' : 'some checks did not pass: look at it'}).</p>}
          {estimates.length > 0 && <ul className="ot-issues">{estimates.slice(0, 6).map((a, i) => <li key={i} className="is-warning">{a.detail}</li>)}</ul>}
          {!view.background.approved ? <>
            {base.reliability === 'uncertain' && <label className="ts-check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /><span>I checked the clean background{estimates.length ? ' and the amber areas' : ''}; it may be used for this template.</span></label>}
            <div className="ot-row">
              <button type="button" className="ws-btn ws-btn-primary" disabled={busy || (base.reliability === 'uncertain' && !acknowledged)} onClick={() => void act(async () => setView(await masterApi.approveBackground(view, acknowledged)), 'Background approved.')}><CheckCircle2 size={14} aria-hidden="true" />Approve background</button>
              <button type="button" className="ws-btn" disabled={busy} onClick={() => void prepare()}><RefreshCw size={14} aria-hidden="true" />Make it again</button>
              <UploadBackground view={view} busy={busy} act={act} setView={setView} />
            </div>
          </> : <p className="ot-row"><Badge tone="ok">Approved</Badge><button type="button" className="ws-link" disabled={busy} onClick={() => void prepare()}>Make it again</button></p>}
        </>}
        <button type="button" className="ws-btn ws-btn-quiet" onClick={onBackToReview}>← Back to Scan &amp; Review</button>
      </section>
      {view.background.approved && <ArtworkChoice view={view} busy={busy} act={act} setView={setView} load={load} />}
      {view.background.approved && <section>
        <h3>3 · Save the master</h3>
        {published ? <>
          <Alert tone="ok"><strong>Master saved</strong> · revision {view.latestRevision?.revision}. Reuse it to make creatives: no new scan or decomposition is needed.</Alert>
          <div className="ot-row">
            <button type="button" className="ws-btn ws-btn-primary" onClick={onReuse}><Sparkles size={14} aria-hidden="true" />Reuse Template</button>
            <button type="button" className="ws-btn" disabled={busy} onClick={onOpenEditor}><Layers3 size={14} aria-hidden="true" />Open in Editor</button>
            <button type="button" className="ws-btn ws-btn-quiet" onClick={onDone}>Back to Templates</button>
          </div>
        </> : <>
          <p className="ot-muted">{view.changedSincePublish ? 'You changed the template since its last save: saving makes a new revision (creatives made earlier keep theirs).' : 'Saves the background, artwork, every word and logo with its coordinates and style as the reusable master.'}</p>
          <button type="button" className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || (view.master.artwork.mode === 'seedream' && !view.master.artwork.runId)} onClick={() => void act(async () => setView(await masterApi.publish(view)), 'Master saved.')}><CheckCircle2 size={15} aria-hidden="true" />Save master</button>
        </>}
      </section>}
    </div>
  </div>;
}

function UploadBackground({ view, busy, act, setView }: { view: MasterView; busy: boolean; act: Act; setView: (v: MasterView) => void }) {
  return <label className="ws-btn"><Upload size={14} aria-hidden="true" />Use my own clean background<input type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label="Clean background file" disabled={busy}
    onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void act(async () => setView(await masterApi.uploadBackground(view, f)), 'Your clean background is stored and checked against the poster.'); }} /></label>;
}

/** The artwork creatives use: the clean background as one picture (free), or Seedream's layers of it (optional, paid, confirmed). */
function ArtworkChoice({ view, busy, act, setView, load }: { view: MasterView; busy: boolean; act: Act; setView: (v: MasterView) => void; load: () => Promise<MasterView> }) {
  const t = view.template, run = t.latestRun, [preflight, setPreflight] = useState<Preflight>(), [confirming, setConfirming] = useState(false), key = useRef<string | undefined>(undefined);
  const usable = run && run.current && run.usable;
  return <section>
    <h3>2 · Artwork layers <span className="ot-chip">optional</span></h3>
    <label className="ts-check"><input type="radio" name="artwork" checked={view.master.artwork.mode === 'background'} disabled={busy} onChange={() => void act(async () => setView(await masterApi.chooseArtwork(view, 'background')))} />
      <span><strong>Use the clean background as one picture</strong> (recommended, free).</span></label>
    <label className="ts-check"><input type="radio" name="artwork" checked={view.master.artwork.mode === 'seedream'} disabled={busy || !usable} onChange={() => usable && void act(async () => setView(await masterApi.chooseArtwork(view, 'seedream', run.runId)))} />
      <span><strong>Split it into layers with Seedream</strong> (paid: one request with the clean background only).{!usable && ' Decompose first.'}</span></label>
    {run && <p className="ot-small" role="status">{run.active ? <><LoaderCircle size={13} className="ws-spin" aria-hidden="true" /> Seedream is working on it ({run.stage.replace('_', ' ')})…</> : run.stage === 'done' ? `Seedream returned ${run.editorLayers} layers${run.current ? '' : ' (of an earlier background)'}.` : `Last decomposition: ${run.stage}${run.error ? ` — ${run.error.message}` : ''}.`}</p>}
    {!confirming ? <button type="button" className="ws-btn" disabled={busy || !!run?.active} onClick={() => void act(async () => { setPreflight(await protectedApi.preflight(t.id)); key.current = newKey(); setConfirming(true); })}>
      <ImageUp size={14} aria-hidden="true" />{run ? 'Decompose again…' : 'Decompose with Seedream…'}</button>
      : <div className="ts-confirm" role="group" aria-label="Confirm the paid request">
        {preflight?.estimate && <p><strong>One paid request to {preflight.estimate.endpoint}</strong>: up to {usd(preflight.estimate.maxUsd)} (₹{preflight.estimate.maxInr.toFixed(0)}). Only the clean background is sent; the text and logos stay here.</p>}
        {preflight && !preflight.ok && <ul className="ot-issues">{preflight.checks.filter(c => c.status === 'fail').map(c => <li key={c.id} className="is-error">{c.label}: {c.detail}</li>)}</ul>}
        <div className="ot-row">
          <button type="button" className="ws-btn ws-btn-primary" disabled={busy || !preflight?.ok} onClick={() => void act(async () => {
            const repeat = t.runs.some(r => r.baseSha256 === t.base?.sha256);
            await protectedApi.decompose(t, key.current!, repeat); setConfirming(false); key.current = undefined; await load();
          }, 'Sent to Seedream.')}>Send to Seedream (paid)</button>
          <button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      </div>}
  </section>;
}
