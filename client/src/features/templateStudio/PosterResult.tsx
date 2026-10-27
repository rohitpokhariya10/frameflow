/**
 * The generated image: preview, comparison with the template reference, the review (what was checked and how it came
 * out), the recorded cost, approval, and the hand-off to FrameFlow's existing decomposition.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleDashed, Download, Layers3, RefreshCw, ScanSearch, ShieldCheck, ShieldPlus, XCircle } from 'lucide-react';
import { AI_PRICING, FIDELITY_MODES, type StudioJob, type StudioPoster, type StudioReviewCheck } from '@frameflow/shared';
import { newIdempotencyKey, studioApi } from './api';
import { RecordedCost } from './CostViews';
import { Alert, Badge, JobSteps, StepCard, fmtDate, useJob } from './ui';

const CHECK_ICON = { pass: CheckCircle2, warn: AlertTriangle, fail: XCircle, unchecked: CircleDashed } as const;
const CHECK_TEXT = { pass: 'Passed', warn: 'Check', fail: 'Problem', unchecked: 'Not checked' } as const;

export function reviewBadge(status: StudioPoster['reviewStatus']) {
  return status === 'ok' ? <Badge tone="ok">Review passed</Badge> : status === 'needs_review' ? <Badge tone="warn">Needs review</Badge> : <Badge>Not reviewed</Badge>;
}

export function ReviewChecklist({ checks }: { checks: StudioReviewCheck[] }) {
  return <ul className="ts-checks">{checks.map(c => {
    const Icon = CHECK_ICON[c.status];
    return <li key={c.id} className={`is-${c.status}`}><Icon size={18} aria-hidden="true" /><div><strong>{c.label}</strong><span className="ts-check-status">{CHECK_TEXT[c.status]}</span><p>{c.detail}</p></div></li>;
  })}</ul>;
}

type View = 'poster' | 'scene' | 'raw' | 'guide';

export function PosterResult({ posterId, onBack, backLabel = 'Back', onDecompose, onOpenRun, onStartedJob, onProtect, onMakeMaster }: {
  posterId: string; onBack?: () => void; backLabel?: string;
  /** Makes a protected template of this poster (its text and logos kept out of decomposition) and opens it. */
  onProtect?: (poster: StudioPoster) => Promise<void>;
  /** This poster's image as a Text & Graphics master (Offer Templates), without downloading and uploading it again. */
  onMakeMaster?: (poster: StudioPoster) => Promise<void>;
  /** Sends the poster's text-free scene to FrameFlow's decomposition (the panel owns that); resolves with the run id. */
  onDecompose: (poster: StudioPoster, recursive: boolean) => Promise<void>;
  onOpenRun: (runId: string) => void;
  onStartedJob: (jobId: string) => void;
}) {
  const [poster, setPoster] = useState<StudioPoster | null>(null), [error, setError] = useState('');
  const [view, setView] = useState<View>('poster'), [busy, setBusy] = useState(false);
  const [confirmDecompose, setConfirmDecompose] = useState(false), [recursive, setRecursive] = useState(true), [acknowledged, setAcknowledged] = useState(false);
  const [confirm, setConfirm] = useState<'regenerate' | 'review' | null>(null), [recheckJob, setRecheckJob] = useState<string>();
  const keys = useRef<Record<string, string>>({});
  const load = useCallback(async () => { setPoster((await studioApi.get<{ poster: StudioPoster }>(`/posters/${posterId}`)).poster); }, [posterId]);
  useEffect(() => {
    let alive = true;
    void studioApi.get<{ poster: StudioPoster }>(`/posters/${posterId}`).then(r => { if (alive) setPoster(r.poster); }).catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [posterId]);
  const { job: recheck } = useJob(recheckJob, () => void load());
  const act = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); } catch (e) { setError(e instanceof Error ? e.message : 'Request failed.'); } finally { setBusy(false); } };
  if (error && !poster) return <div className="ts-page"><Alert>{error}</Alert></div>;
  if (!poster) return <div className="ts-page"><p className="ts-muted" role="status">Loading the generated image…</p></div>;

  const mode = FIDELITY_MODES.find(m => m.id === poster.fidelityMode)!;
  const approved = Boolean(poster.approvedAt), flagged = poster.reviewStatus !== 'ok';
  const images: Record<View, string | null> = { poster: poster.urls.poster, scene: poster.urls.scene, raw: poster.urls.rawScene, guide: poster.urls.layoutGuide };
  const reuse = poster.provenance === 'reference_reuse';
  const labels: Record<View, string> = { poster: 'Poster', scene: reuse ? 'Reused reference (with its text and logos)' : 'Text-free scene', raw: "Model's own scene", guide: 'Layout guide' };
  const hard = poster.review?.hardFailures ?? [];
  const reviewCost = poster.cost.lines.filter(l => l.stage.startsWith('review')).at(-1);
  const once = (name: string) => (keys.current[name] ??= newIdempotencyKey());

  const nextStep = <>
        <StepCard title="Next: editable layers" hint={reuse ? 'This image is the original reference, copied unchanged: its bank logos and text are part of its pixels. Protect them to keep them out of decomposition.' : 'FrameFlow splits the text-free scene into layers, then restores your text and logo as editable elements in the editor.'}>
          {onProtect && <button type="button" className={`ws-btn${reuse ? ' ws-btn-primary' : ''} ts-wide`} disabled={busy} onClick={() => void act(() => onProtect(poster))}><ShieldPlus size={16} aria-hidden="true" /> Protect text &amp; logos, then decompose with Seedream only</button>}
          {onMakeMaster && <button type="button" className="ws-btn ts-wide" disabled={busy} onClick={() => void act(() => onMakeMaster(poster))}>Use as a Text &amp; Graphics template (scan its text and logos)</button>}
          {poster.decompositions.length > 0 && <ul className="ts-runs">{poster.decompositions.map(d => <li key={d.runId}><Layers3 size={15} aria-hidden="true" /><span>Decomposition {fmtDate(d.createdAt)}<small>{d.sentWidth}×{d.sentHeight} sent · run {d.runId.slice(-6)}</small></span><button type="button" className="ws-btn" onClick={() => onOpenRun(d.runId)}>View layers</button></li>)}</ul>}
          {!approved ? <>
            {flagged && <label className="ts-check"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} /> I have checked the flagged items and want to use this image.</label>}
            <button type="button" className="ws-btn ws-btn-primary ws-btn-large ts-wide" disabled={busy || (flagged && !acknowledged)} onClick={() => void act(async () => { setPoster((await studioApi.post<{ poster: StudioPoster }>(`/posters/${poster.id}/approve`, { approved: true })).poster); })}><ShieldCheck size={16} aria-hidden="true" /> Approve this image</button>
          </> : !confirmDecompose ? <button type="button" className="ws-btn ws-btn-primary ws-btn-large ts-wide" disabled={busy} onClick={() => setConfirmDecompose(true)}><Layers3 size={16} aria-hidden="true" /> {poster.decompositions.length ? 'Decompose again' : 'Decompose Image into Editable Layers'}</button>
            : <div className="ts-confirm" role="group" aria-label="Confirm decomposition">
              <p><strong>Start FrameFlow decomposition?</strong> {reuse ? <>No new image was generated for this poster: the template's <strong>original reference, copied unchanged</strong> ({poster.crop.width}×{poster.crop.height}), goes to FrameFlow's existing pipeline <strong>with its raster text and logos</strong>, which Seedream would decompose (or its provider may refuse) along with the rest. To keep them out, use Protect text &amp; logos instead.</> : <>The text-free scene ({poster.crop.width}×{poster.crop.height}) goes to FrameFlow's existing pipeline.</>} One OpenAI planner call and one Seedream layer request, plus cleanup passes only when needed. These are paid calls. Its exact cost is recorded in Overview; FrameFlow's planning target is ₹{AI_PRICING.targetInr.min}–{AI_PRICING.targetInr.max} per image ({AI_PRICING.version}), and cleanup can add more.</p>
              <label className="ts-check"><input type="checkbox" checked={recursive} onChange={e => setRecursive(e.target.checked)} /> Recursive cleanup (FrameFlow default)</label>
              <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(async () => { await onDecompose(poster, recursive); setConfirmDecompose(false); })}>{busy ? 'Starting…' : 'Start decomposition (paid)'}</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirmDecompose(false)}>Cancel</button></div>
            </div>}
          {approved && <button type="button" className="ws-link" onClick={() => void act(async () => { setPoster((await studioApi.post<{ poster: StudioPoster }>(`/posters/${poster.id}/approve`, { approved: false })).poster); })}>Withdraw approval</button>}
        </StepCard>
  </>;
  return <div className="ts-page ts-result">
    <div className="ts-detail-head">
      {onBack && <button type="button" className="ws-btn ws-btn-quiet" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> {backLabel}</button>}
      <div className="ts-detail-title">
        <h2>{poster.copy.headline ?? poster.template.name} {reviewBadge(poster.reviewStatus)} {approved && <Badge tone="ok">Approved</Badge>}</h2>
        <p>{poster.template.name}{poster.template.profileVersion ? ` (style v${poster.template.profileVersion})` : ''} · {mode.label} · {poster.format?.label} · {poster.quality} quality{poster.occasion ? ` · ${poster.occasion}` : ''} · {fmtDate(poster.createdAt)}</p>
      </div>
      <div className="ws-row"><a className="ws-btn" href={poster.urls.download.png}><Download size={15} aria-hidden="true" /> PNG</a><a className="ws-btn" href={poster.urls.download.jpeg}>JPEG</a></div>
    </div>
    {error && <Alert>{error}</Alert>}
    {poster.provenance === 'reference_reuse' && <Alert tone="info">Local reference reuse · no AI image generated. Original products, raster text and logos are retained. No generation charge.</Alert>}
    {hard.length > 0 && <Alert tone="warn"><strong>The review found problems to check before using this image:</strong><ul className="ts-problems">{hard.map((h, i) => <li key={i}>{h.description}</li>)}</ul>No new image was generated automatically; regenerating is your decision.</Alert>}

    <div className="ts-result-grid">
      <div className="ts-preview">
        <div className="ts-view-tabs" role="tablist" aria-label="Image to show">{(Object.keys(images) as View[]).filter(v => images[v]).map(v => <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'is-on' : undefined} onClick={() => setView(v)}>{labels[v]}</button>)}</div>
        <figure className="ts-preview-frame" style={{ aspectRatio: `${poster.canvas.width} / ${poster.canvas.height}` }}>
          <img src={images[view] ?? poster.urls.poster} alt={`${labels[view]} of the generated image`} />
        </figure>
        <p className="ts-footnote">{view === 'poster' ? `Rendered at ${poster.canvas.width}×${poster.canvas.height}: ${reuse ? 'the reused reference' : 'the generated scene'} plus exact text and logo layers.` : view === 'scene' && reuse ? `The original reference (${poster.crop.width}×${poster.crop.height}), copied unchanged, with its own text and logos: what a plain decomposition would send.` : view === 'scene' ? `The text-free scene (${poster.crop.width}×${poster.crop.height}) FrameFlow decomposes.${poster.exactProducts?.applied ? ' Products are your cutouts\' exact pixels.' : ''}` : view === 'raw' ? 'What the image model returned, before your exact product pixels replaced its products.' : 'The wordless wireframe sent to the image model first: product blocks, supports and empty text areas.'}</p>
      </div>
      <aside className="ts-result-side">
        {nextStep}
        <StepCard title="Reference vs result" hint={poster.fidelityMode === 'match' ? 'Match Reference: the new image should be the same design with new products.' : `${mode.label}: ${mode.summary}`}>
          <div className="ts-compare">
            <figure><img src={poster.template.references[0]?.thumb} alt="Template reference" /><figcaption>Template reference</figcaption></figure>
            <figure><img src={poster.urls.poster} alt="Generated result" /><figcaption>{poster.provenance === 'reference_reuse' ? 'Reused reference' : 'Generated'}</figcaption></figure>
          </div>
          {poster.review?.referenceMatch && <p className="ts-match-score"><ScanSearch size={15} aria-hidden="true" /> Reference match {poster.review.referenceMatch.score}/5</p>}
        </StepCard>
      </aside>
    </div>

    <div className="ts-two">
      <StepCard title="Review" hint={poster.review ? `AI review (heuristic aid, not a guarantee) · ${poster.review.model} · ${fmtDate(poster.review.createdAt)}` : poster.provenance === 'reference_reuse' ? 'Local asset reuse verified; no paid visual review.' : 'Not reviewed yet.'}>
        {poster.review?.summary && <p className="ts-summary">{poster.review.summary}</p>}
        {poster.review?.reviewError && <Alert tone="warn">The automatic review did not run: {poster.review.reviewError}</Alert>}
        <ReviewChecklist checks={poster.checks} />
        {poster.notes.length > 0 && <details className="ts-advanced"><summary>Automatic adjustments ({poster.notes.length})</summary><ul>{poster.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></details>}
      </StepCard>
      <StepCard title="Cost of this image" hint="Template analysis is counted on the template; decomposition on its run.">
        <RecordedCost cost={poster.cost} />
      </StepCard>
    </div>

    <StepCard title="Not right? Your decision, never automatic">
      {recheck && !recheck.terminal ? <JobSteps job={recheck} /> : <div className="ws-row">
        <button type="button" className="ws-btn" disabled={busy || poster.provenance === 'reference_reuse'} onClick={() => setConfirm(confirm === 'review' ? null : 'review')}><ScanSearch size={15} aria-hidden="true" /> Re-check (review only)</button>
        <button type="button" className="ws-btn" disabled={busy || poster.provenance === 'reference_reuse'} onClick={() => setConfirm(confirm === 'regenerate' ? null : 'regenerate')}><RefreshCw size={15} aria-hidden="true" /> Regenerate</button>
      </div>}
      {confirm === 'review' && <div className="ts-confirm"><p>Runs the AI review again on this same image (one text call{reviewCost?.estimated ? `, up to about ${reviewCost.estimated.inr}` : ''}). No new image.</p>
        <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(async () => { const r = await studioApi.post<{ jobId: string }>(`/posters/${poster.id}/review`, { idempotencyKey: once('review') }); delete keys.current.review; setRecheckJob(r.jobId); setConfirm(null); })}>Re-check (paid)</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
      {confirm === 'regenerate' && <div className="ts-confirm"><p>Generates a new image with the same template, products, text, format and mode ({mode.label}). This repeats the paid planning, image and review calls (about {poster.cost.total.inr} last time); cached product analyses are reused.</p>
        <div className="ws-row"><button type="button" className="ws-btn ws-btn-primary" disabled={busy} onClick={() => void act(async () => { const r = await studioApi.post<{ jobId: string }>(`/posters/${poster.id}/regenerate`, { idempotencyKey: once('regenerate') }); delete keys.current.regenerate; setConfirm(null); onStartedJob(r.jobId); })}>Regenerate (paid)</button><button type="button" className="ws-btn ws-btn-quiet" onClick={() => setConfirm(null)}>Cancel</button></div></div>}
    </StepCard>

    <details className="ts-advanced ts-card">
      <summary>How this image was made</summary>
      <div className="ts-made">
        {poster.plan && <><h4>Art direction: {poster.plan.concept?.title}</h4><p>{poster.plan.concept?.summary}</p><p className="ts-muted">{poster.plan.rationale}</p>
          {poster.plan.alternatives.length > 0 && <p className="ts-muted">Other concepts considered: {poster.plan.alternatives.map(a => a.title).join(', ')}.</p>}</>}
        {poster.generation && <><h4>Image request</h4><p>{poster.generation.model} · {poster.generation.quality} · {poster.generation.providerSize}{poster.generation.latencyMs ? ` · ${(poster.generation.latencyMs / 1000).toFixed(0)} s` : ''} · {poster.generation.promptVersion}</p>
          <p>Images sent, in order: {poster.generation.references.map(r => `${r.index}. ${r.role.replace('_', ' ')} (${r.label})`).join('; ')}.</p>
          <pre className="ts-prompt">{poster.generation.prompt}</pre></>}
        {poster.format && <p className="ts-muted">{poster.format.note}</p>}
      </div>
    </details>
  </div>;
}

/** A generation in progress: its steps, then the result. */
export function GenerationRun({ jobId, onDone, onCancelled }: { jobId: string; onDone: (posterId: string) => void; onCancelled?: () => void }) {
  const [refresh, setRefresh] = useState(0), [resumeError, setResumeError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const { job, error } = useJob(jobId, (j: StudioJob) => { const id = (j.result as { posterId?: string } | null)?.posterId; if (id) onDone(id); }, refresh);
  if (error) return <div className="ts-page"><Alert>{error}</Alert></div>;
  if (!job) return <div className="ts-page"><p className="ts-muted" role="status">Starting…</p></div>;
  return <div className="ts-page">
    <StepCard title={job.terminal ? (job.state === 'failed' ? 'Generation failed' : job.state === 'cancelled' ? 'Generation cancelled' : 'Generation finished') : 'Generating your image'} hint="Usually one to two minutes. You can leave this page; the result appears in Generation History.">
      <JobSteps job={job} />
      {job.error && <Alert>{job.error.message}{job.error.code === 'outcome_unknown' ? ' Nothing was repeated automatically.' : ''}</Alert>}
      {Boolean(job.cost.reserved?.microUsd) && <Alert tone="warn">{job.cost.reserved!.usd} remains reserved for calls with an unknown outcome; it may have been billed and has not been treated as free.</Alert>}
      {resumeError && <Alert>{resumeError}</Alert>}
      {job.error?.code === 'budget_exceeded' && <button className="ws-btn" disabled={cancelling} onClick={async () => { setCancelling(true); try { await studioApi.post(`/jobs/${job.id}/resume-budget`); setRefresh(r => r + 1); } catch (err) { setResumeError((err as Error).message); } finally { setCancelling(false); } }}>Resume remaining steps (paid; completed work is reused)</button>}
      {job.cost.calls > 0 && <p className="ts-muted">Recorded so far: {job.cost.total.inr} ({job.cost.calls} paid call{job.cost.calls === 1 ? '' : 's'}).</p>}
      {!job.terminal && <button type="button" className="ws-btn" disabled={cancelling || job.cancelRequested} onClick={async () => { setCancelling(true); try { await studioApi.post(`/jobs/${job.id}/cancel`); } finally { setCancelling(false); } }}>{job.cancelRequested ? 'Stopping after this step…' : 'Cancel'}</button>}
      {job.terminal && job.state !== 'complete' && job.state !== 'needs_review' && onCancelled && <button type="button" className="ws-btn" onClick={onCancelled}>Back to the form</button>}
    </StepCard>
  </div>;
}
