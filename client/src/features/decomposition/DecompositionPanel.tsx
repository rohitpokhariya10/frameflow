import { useEffect, useRef, useState } from 'react';
import type { DecompositionCapabilities, DecompositionClientContext, DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { useAppDispatch, useAppSelector, selectActiveVariant } from '../../store';
import { decompositionActions, decompositionContextMatches } from '../../store/decompositionSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { decompositionApi as api, rememberJob, recoveredJob, artifactUrl } from './api';
import { sceneToVariant } from './importScene';
import { isDesignVariant } from '../../lib/persistence/schema';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { ProposalReview } from './ProposalReview';
import { AlphaReview } from './AlphaReview';
import { MaskReview } from './MaskReview';
import { InspectionViewer } from './InspectionViewer';
import './decomposition.css';

export function DecompositionPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((s) => s.editor.document.id);
  const variant = useAppSelector(selectActiveVariant);
  const variantCount = useAppSelector((s) => s.editor.document.variants.length);
  const { context, job, error } = useAppSelector((s) => s.decomposition);
  const [capabilities, setCapabilities] = useState<DecompositionCapabilities | null>(null);
  const [message, setMessage] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [labels, setLabels] = useState('');
  const [jobs, setJobs] = useState<DecompositionJobSummary[]>([]);
  const mounted = useRef(true);
  const recovered = useRef(false);
  const current = useRef({ projectId, variant });
  useEffect(() => { current.current = { projectId, variant }; }, [projectId, variant]);
  useEffect(() => {
    mounted.current = true;
    void api.capabilities().then((value) => { if (mounted.current) setCapabilities(value); }).catch((e: Error) => { if (mounted.current) setMessage(e.message); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!capabilities?.authenticated) return;
    let active = true;
    void api.jobs().then((value) => { if (active) setJobs(value); }).catch((e: Error) => { if (active) setMessage(e.message); });
    return () => { active = false; };
  }, [capabilities, job?.state]);
  useEffect(() => {
    if (context && !decompositionContextMatches(context, projectId, variant.id, variant.revision, variant.background?.assetId)) dispatch(decompositionActions.detached());
  }, [context, dispatch, projectId, variant.id, variant.revision, variant.background?.assetId]);
  useEffect(() => {
    if (!job || !context || !['queued', 'running', 'cancel_requested'].includes(job.state)) return;
    let active = true;
    const timer = window.setInterval(() => { void api.job(job.id).then((value) => {
      if (active) dispatch(decompositionActions.received({ token: context.operationToken, job: value }));
    }).catch((e: Error) => { if (active) dispatch(decompositionActions.failed({ token: context.operationToken, message: e.message })); }); }, 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [job, context, dispatch]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await work(); } catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : 'The request could not finish. Try again.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const attach = (value: DecompositionJobSummary) => {
    const captured: DecompositionClientContext = { projectId, variantId: variant.id, variantRevision: variant.revision, sourceAssetId: variant.background?.assetId, operationToken: crypto.randomUUID() };
    dispatch(decompositionActions.attached(captured)); dispatch(decompositionActions.received({ token: captured.operationToken, job: value }));
  };
  const update = async (operation: () => Promise<DecompositionJobSummary>) => {
    const token = context?.operationToken; const value = await operation();
    if (token) dispatch(decompositionActions.received({ token, job: value }));
  };
  const start = () => run(async () => {
    const captured: DecompositionClientContext = { projectId, variantId: variant.id, variantRevision: variant.revision, sourceAssetId: variant.background?.assetId, operationToken: crypto.randomUUID() };
    dispatch(decompositionActions.attached(captured));
    const blob = file || (variant.background && (await assets.getAsset(variant.background.assetId))?.blob);
    if (!blob) throw new Error('Choose an image or use artwork stored in this design.');
    const source = await api.upload(blob);
    const value = await api.create(source.id, { maxObjects: capabilities?.limits.maxObjects ?? 6, targetLabels: labels.split(',').map((s) => s.trim()).filter(Boolean), qualityProfile: 'refined', completeHiddenObjects: false, reconstructBackground: false, allowEraseFallback: false, maxCalls: 20 }, captured, captured.operationToken);
    if (!rememberJob(projectId, value.id)) setMessage('Browser recovery storage is unavailable. Your server job remains available in the job list.');
    const latest = current.current;
    if (decompositionContextMatches(captured, latest.projectId, latest.variant.id, latest.variant.revision, latest.variant.background?.assetId)) dispatch(decompositionActions.received({ token: captured.operationToken, job: value }));
  });
  useEffect(() => {
    if (!capabilities?.authenticated || recovered.current || context) return;
    recovered.current = true; const id = recoveredJob(projectId); if (!id) return;
    let active = true;
    void api.job(id).then(value => { if (!active) return; const v=current.current.variant;const captured={projectId,variantId:v.id,variantRevision:v.revision,sourceAssetId:v.background?.assetId,operationToken:crypto.randomUUID()};dispatch(decompositionActions.attached(captured));dispatch(decompositionActions.received({token:captured.operationToken,job:value})); }).catch(()=>undefined);
    return () => {active=false;};
  },[capabilities,context,projectId,dispatch]);
  const review = async (body: DecompositionReview) => {
    if (!job) throw new Error('Reload the job before submitting review.');
    await update(() => api.review(job.id, body));
  };
  return <div className={embedded ? "decomp-inline" : "decomp-backdrop"}><div className="decomp-panel" role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-label="Image decomposition">
    <div className="decomp-row"><h2>Image decomposition</h2>{onClose && <button onClick={onClose} aria-label="Close image decomposition">Close</button>}</div>
    <p>Review discovered layers, confirm their source masks, then inspect alpha before extracting original pixels. Each review can be saved and resumed. Stops at phase 6.</p>
    {(message || error) && <p role="alert">{message || error}</p>}
    {!capabilities ? <p>Checking decomposition service…</p> : !capabilities.enabled ? <p>{capabilities.message}</p> : <>
      {!capabilities.authenticated ? <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await api.login(password); setPassword(''); setCapabilities(await api.capabilities()); }); }}>
        <label>Operator password <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label><button disabled={busy || !password}>Sign in</button>
      </form> : <>
        <p role="status">{capabilities.providerMode === 'mock' ? 'Mock inference — local demo only. Use the owned fixture; other artwork requires Live Fal.' : 'Live Fal — paid inference; no mock fallback.'}</p>
        {capabilities.providerMode === 'mock' && <button disabled={busy} onClick={() => void run(async () => {const response=await fetch('/api/decomposition/fixture');if(!response.ok)throw new Error('Demo fixture unavailable');setFile(new File([await response.blob()], 'person-board-fixture.png', {type:'image/png'}));})}>Use demo fixture</button>}
        {!capabilities.configured && <p role="status">{capabilities.message}</p>}
        <div className="decomp-row"><label>Source image <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} /></label><button onClick={() => setFile(null)} disabled={!variant.background}>Use current artwork</button></div>
        <p>{file ? file.name : variant.background ? 'Current artwork: original stored image bytes' : 'Choose a PNG, JPEG or WebP.'} · Retained {capabilities.limits.retentionDays} days</p>
        <label>Optional target names, separated by commas <input placeholder="person, board" value={labels} onChange={(e) => setLabels(e.target.value)} maxLength={600} /></label>
        
        <button className="decomp-primary" disabled={busy || !capabilities.configured || (!file && !variant.background)} onClick={() => void start()}>Start decomposition</button>
        <p>{capabilities.providerMode === 'mock' ? 'Deterministic fixture responses; no paid calls.' : 'At most 20 model submissions. A call limit is not a dollar estimate.'}</p>
        {job && <section aria-label="Decomposition job"><div className="decomp-row"><h3>{job.progress?.startsWith('Phase ') ? job.progress : `Phase ${job.phase} of 6 — ${job.progress || 'Waiting'}`}</h3><span>{job.state.replaceAll('_', ' ')} · {job.callsUsed} calls</span></div>
          {job.error && <p role="alert">{job.error.message}</p>}{job.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
          {['queued', 'running', 'needs_review', 'cancel_requested'].includes(job.state) && <button disabled={busy || job.state === 'cancel_requested'} onClick={() => void run(() => update(() => api.cancel(job.id)))}>Cancel job</button>}
          {job.state === 'failed' && <button disabled={busy} onClick={() => void run(() => update(() => api.retry(job.id, job.revision)))}>Retry failed step</button>}
          {job.state === 'needs_review' && job.review?.gate === 'qwen-proposal-review' && <ProposalReview key={`${job.id}-${job.revision}`} job={job} onSubmit={review} busy={busy} />}
          {job.state === 'needs_review' && job.review?.gate === 'alpha-review' && <AlphaReview key={`${job.id}-${job.revision}`} job={job} onSubmit={review} busy={busy} />}
          {job.state === 'needs_review' && job.review?.gate !== 'alpha-review' && job.candidates?.length && job.sourcePreviewArtifactId && job.review?.actions.some(action => ['accept-masks', 'guided-refine', 'manual-masks'].includes(action)) ? <MaskReview key={`${job.id}-${job.revision}`} job={job} candidates={job.candidates} sourceId={job.sourcePreviewArtifactId} width={job.sourceWidth!} height={job.sourceHeight!} onSubmit={review} busy={busy} /> : null}
          {job.state === 'needs_review' && !job.review?.gate && (job.review?.code === 'REFINEMENT_VISUAL_REVIEW' || !job.candidates?.length) && <div><p>{job.review?.message}</p><div className="decomp-row">{job.review?.actions.filter((action) => action === 'approve-result').map((action) => <button key={action} disabled={busy} onClick={() => void run(() => review({ expectedRevision: job.revision, action: action as DecompositionReview['action'] }))}>{action.replaceAll('-', ' ')}</button>)}</div></div>}
          {job.state === 'completed' && job.sceneGraph && <section aria-label="Editable design"><h4>Editable design</h4>
            <p>{job.sceneGraph.layers.length} layers at {job.sceneGraph.width} × {job.sceneGraph.height} px: {job.sceneGraph.layers.map(l => `${l.name} (${l.type === 'shape' && l.shapeType === 'raster' ? 'image' : l.type})`).join(', ')}.</p>
            <p>Text arrives as source-pixel images with an unverified suggestion; convert each to editable text in the layer panel. Moving an object reveals the original pixels behind it.</p>
            <button className="decomp-primary" disabled={busy} onClick={() => void run(async () => {
              const fetchArtifact = async (id: string) => { const response = await fetch(artifactUrl(id), { credentials: 'same-origin' }); if (!response.ok) throw new Error('A layer image could not be downloaded. Try again.'); return response.blob(); };
              const variant = await sceneToVariant(job, fetchArtifact, assets);
              if (!isDesignVariant(variant) || variantCount >= 30) {
                await Promise.all([variant.background?.assetId, ...(variant.layers ?? []).map(l => l.type === 'image' ? l.assetId : undefined)].filter((id): id is string => !!id).map(id => assets.deleteAsset(id).catch(() => undefined)));
                throw new Error(variantCount >= 30 ? 'This design already has the maximum of 30 versions.' : 'The scene could not be converted into a valid design.');
              }
              dispatch(decomposedDesignImported({ variant, timestamp: new Date().toISOString() }));
              dispatch(variantSelected(variant.id));
              setMessage('Opened as a new version. Select layers on the canvas or in the Layers list.');
              onClose?.();
            })}>Open as editable design</button></section>}
          <InspectionViewer job={job} />
        </section>}
        <details><summary>Recover jobs ({jobs.length})</summary><p>Opening a job only attaches its viewer. Closing this panel or changing designs does not cancel server work.</p>{jobs.map((saved) => <div className="decomp-row" key={saved.id}><button onClick={() => void run(async () => attach(await api.job(saved.id)))}>{saved.id.slice(0, 8)} · {saved.state} · phase {saved.phase}</button><button onClick={() => void run(async () => { await api.remove(saved.id); setJobs(await api.jobs()); if (job?.id === saved.id) dispatch(decompositionActions.detached()); })}>Delete job and artifacts</button></div>)}</details>
        <button onClick={() => void run(async () => { await api.logout(); dispatch(decompositionActions.detached()); setCapabilities(await api.capabilities()); })}>Sign out</button>
      </>}
    </>}
  </div></div>;
}
