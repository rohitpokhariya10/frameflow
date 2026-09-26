import { useEffect, useRef, useState } from 'react';
import { Layers, X, ArrowRight } from 'lucide-react';
import type { DecompositionCapabilities, DecompositionClientContext, DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { useAppDispatch, useAppSelector, selectActiveVariant } from '../../store';
import { decompositionActions, decompositionContextMatches } from '../../store/decompositionSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { decompositionApi as api, rememberJob, recoveredJob, artifactUrl } from './api';
import { sceneToVariant } from './importScene';
import { isDesignVariant } from '../../lib/persistence/schema';
import { decomposedDesignImported } from '../../store/editorSlice';
import { variantSelected } from '../../store/uiSlice';
import { flowStep, stepperIndex } from './flow';
import { DeveloperDetails, Stepper } from './workspace/parts';
import { ErrorStep, ProcessingStep, ReadyStep, UploadStep } from './workspace/Steps';
import { ReviewStep } from './workspace/ReviewStep';
import { EdgesStep, RefineStep } from './workspace/RefineStep';
import './decomposition.css';
import './workspace/workspace.css';

const TITLES: Record<string, string> = { upload: 'Image to layers', processing: 'Separating your design', review: 'Review detected layers', refine: 'Refine selection', edges: 'Check the edges', ready: 'Ready to edit', error: 'Image to layers' };

/**
 * Layer-separation workspace. This component owns pipeline/domain state (capabilities, jobs, polling, submissions);
 * the step components only present it. Embedded (AI panel) it renders a launcher; otherwise the full workspace.
 */
export function DecompositionPanel({ onClose, embedded = false }: { onClose?: () => void; embedded?: boolean }) {
  const [open, setOpen] = useState(!embedded);
  if (embedded && !open) return <div className="ws-launcher"><Layers size={22} /><h3>Turn any image into an editable design</h3><p>AI separates images, text, shapes and the background into layers you can edit.</p>
    <button className="ws-btn ws-btn-primary" onClick={() => setOpen(true)}>Open image to layers<ArrowRight size={14} /></button></div>;
  return <Workspace onClose={() => { if (embedded) setOpen(false); onClose?.(); }} />;
}

function Workspace({ onClose }: { onClose: () => void }) {
  const dispatch = useAppDispatch();
  const projectId = useAppSelector((s) => s.editor.document.id);
  const variant = useAppSelector(selectActiveVariant);
  const variantCount = useAppSelector((s) => s.editor.document.variants.length);
  const { context, job, error } = useAppSelector((s) => s.decomposition);
  const [capabilities, setCapabilities] = useState<DecompositionCapabilities | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [jobs, setJobs] = useState<DecompositionJobSummary[]>([]);
  const [artwork, setArtwork] = useState<{ id: string; url: string }>();
  const mounted = useRef(true);
  // Recovery runs per project: the saved document (and its id) may finish loading after the workspace opens.
  const recoveredFor = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef({ projectId, variant });
  useEffect(() => { current.current = { projectId, variant }; }, [projectId, variant]);
  useEffect(() => {
    mounted.current = true;
    void api.capabilities().then((value) => { if (mounted.current) setCapabilities(value); }).catch(() => { if (mounted.current) setMessage('The image layers service could not be reached. Check your connection and try again.'); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!capabilities?.authenticated) return;
    let active = true;
    void api.jobs().then((value) => { if (active) setJobs(value); }).catch(() => undefined);
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
  useEffect(() => {
    const assetId = variant.background?.assetId; if (!assetId) return;
    let url: string | undefined, active = true;
    void assets.getAsset(assetId).then(asset => { if (asset && active) { url = URL.createObjectURL(asset.blob); setArtwork({ id: assetId, url }); } }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [variant.background?.assetId]);
  const artworkUrl = artwork?.id === variant.background?.assetId ? artwork?.url : undefined;
  const step = flowStep(job);
  // Move focus to the step heading when the step changes, so keyboard and screen-reader users follow along.
  useEffect(() => { heading.current?.focus(); }, [step]);
  useEffect(() => { const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [onClose]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await work(); } catch (e) { if (mounted.current) setMessage(e instanceof Error ? e.message : 'That didn’t work. Please try again.'); }
    finally { if (mounted.current) setBusy(false); }
  };
  const newContext = (): DecompositionClientContext => { const v = current.current.variant; return { projectId, variantId: v.id, variantRevision: v.revision, sourceAssetId: v.background?.assetId, operationToken: crypto.randomUUID() }; };
  const attach = (value: DecompositionJobSummary) => { const captured = newContext(); dispatch(decompositionActions.attached(captured)); dispatch(decompositionActions.received({ token: captured.operationToken, job: value })); rememberJob(projectId, value.id); };
  const update = async (operation: () => Promise<DecompositionJobSummary>) => {
    const token = context?.operationToken; const value = await operation();
    if (token) dispatch(decompositionActions.received({ token, job: value }));
  };
  const start = (file: File | null, labels: string[]) => run(async () => {
    const captured = newContext();
    dispatch(decompositionActions.attached(captured));
    const blob = file || (variant.background && (await assets.getAsset(variant.background.assetId))?.blob);
    if (!blob) throw new Error('Choose an image first.');
    const source = await api.upload(blob);
    const value = await api.create(source.id, { maxObjects: capabilities?.limits.maxObjects ?? 6, targetLabels: labels, qualityProfile: 'refined', completeHiddenObjects: false, reconstructBackground: false, allowEraseFallback: false, maxCalls: 20 }, captured, captured.operationToken);
    rememberJob(projectId, value.id);
    const latest = current.current;
    if (decompositionContextMatches(captured, latest.projectId, latest.variant.id, latest.variant.revision, latest.variant.background?.assetId)) dispatch(decompositionActions.received({ token: captured.operationToken, job: value }));
  });
  useEffect(() => {
    if (!capabilities?.authenticated || recoveredFor.current === projectId || context) return;
    recoveredFor.current = projectId; const id = recoveredJob(projectId); if (!id) return;
    let active = true;
    void api.job(id).then(value => { if (!active) return; const captured = newContext(); dispatch(decompositionActions.attached(captured)); dispatch(decompositionActions.received({ token: captured.operationToken, job: value })); }).catch(() => undefined);
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capabilities, context, projectId, dispatch]);
  const review = async (body: DecompositionReview) => { if (!job) throw new Error('Reload and try again.'); await update(() => api.review(job.id, body)); };
  const openInEditor = () => job && run(async () => {
    const fetchArtifact = async (id: string) => { const response = await fetch(artifactUrl(id), { credentials: 'same-origin' }); if (!response.ok) throw new Error('Part of your design could not be downloaded. Try again.'); return response.blob(); };
    const next = await sceneToVariant(job, fetchArtifact, assets);
    if (!isDesignVariant(next) || variantCount >= 30) {
      await Promise.all([next.background?.assetId, ...(next.layers ?? []).map(l => l.type === 'image' ? l.assetId : undefined)].filter((id): id is string => !!id).map(id => assets.deleteAsset(id).catch(() => undefined)));
      throw new Error(variantCount >= 30 ? 'This design already has the maximum of 30 versions. Delete one and try again.' : 'This design could not be opened. Try again.');
    }
    dispatch(decomposedDesignImported({ variant: next, timestamp: new Date().toISOString() }));
    dispatch(variantSelected(next.id));
    onClose();
  });
  const startOver = () => dispatch(decompositionActions.detached());
  // A refused retry (limit or budget reached, possibly by another tab) refreshes the job so the screen shows the real state.
  const retry = () => job && run(async () => {
    try { await update(() => api.retry(job.id, job.revision)); }
    catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'RETRY_LIMIT' && code !== 'CALL_BUDGET' && code !== 'STALE_REVISION') throw e;
      await update(() => api.job(job.id));
    }
  });
  /** A fresh job from the same uploaded image and options. The old job and its assets are kept; cached discovery is reused. */
  const newAttempt = () => job && run(async () => {
    const captured = newContext();
    dispatch(decompositionActions.attached(captured));
    const value = await api.create(job.sourceId, job.options, captured, captured.operationToken);
    rememberJob(projectId, value.id);
    dispatch(decompositionActions.received({ token: captured.operationToken, job: value }));
  });
  return <div className="ws-backdrop"><div className="ws" role="dialog" aria-modal="true" aria-labelledby="ws-title">
    <header className="ws-header">
      <div className="ws-brand"><span className="ws-brand-mark"><Layers size={16} /></span><h2 id="ws-title" ref={heading} tabIndex={-1}>{TITLES[step]}</h2></div>
      <Stepper current={stepperIndex(job)} />
      <div className="ws-header-actions">{job && step !== 'processing' && <button className="ws-link" onClick={startOver}>New image</button>}<button className="ws-icon-button" aria-label="Close image to layers" onClick={onClose}><X size={18} /></button></div>
    </header>
    {(message || error) && <p className="ws-banner" role="alert">{message || 'We couldn’t refresh your design. It will retry automatically.'}</p>}
    <div className="ws-body">
      {!capabilities ? <div className="ws-center"><p className="ws-muted">Loading…</p></div>
        : step === 'upload' ? <UploadStep capabilities={capabilities} jobs={jobs} hasArtwork={Boolean(variant.background)} artworkUrl={artworkUrl} busy={busy} onStart={start}
            onOpenJob={j => run(async () => attach(await api.job(j.id)))} onDeleteJob={j => run(async () => { await api.remove(j.id); setJobs(await api.jobs()); if (job?.id === j.id) dispatch(decompositionActions.detached()); })}
            onLogin={password => run(async () => { await api.login(password); setCapabilities(await api.capabilities()); })} />
        : step === 'processing' ? <ProcessingStep job={job!} busy={busy} onCancel={() => run(() => update(() => api.cancel(job!.id)))} />
        : step === 'review' ? <ReviewStep key={`${job!.id}-${job!.revision}`} job={job!} onSubmit={review} busy={busy} />
        : step === 'refine' ? <RefineStep key={`${job!.id}-${job!.revision}`} job={job!} onSubmit={review} busy={busy} />
        : step === 'edges' ? <EdgesStep key={`${job!.id}-${job!.revision}`} job={job!} onSubmit={review} busy={busy} />
        : step === 'ready' ? <ReadyStep job={job!} busy={busy} onOpen={openInEditor} />
        : <ErrorStep job={job!} busy={busy} onRetry={retry} onNewAttempt={newAttempt} onStartOver={startOver} />}
    </div>
    {job && <DeveloperDetails job={job} />}
  </div></div>;
}
