import { useEffect, useMemo, useRef, useState } from 'react';
import { UploadCloud, ImagePlus, Loader2, Check, Circle, Layers, Type, Square, Image as ImageIcon, Mountain, AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import type { DecompositionCapabilities, DecompositionJobSummary } from '@frameflow/shared';
import { artifactUrl } from '../api';
import { friendlyError, processingMessage, processingStages, readySummary } from '../flow';

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Friendly client-side checks mirroring the server limits; the server still validates everything. */
export async function validateImage(file: Blob, limits: DecompositionCapabilities['limits']): Promise<string | undefined> {
  if (!ACCEPTED.includes(file.type)) return 'Please choose a PNG, JPEG or WebP image.';
  if (file.size > limits.uploadBytes) return `This image is larger than ${mb(limits.uploadBytes)}. Try a smaller file.`;
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap; bitmap.close();
    if (Math.min(width, height) < limits.minSide) return `This image is too small. Use one at least ${limits.minSide} pixels on each side.`;
    if (Math.max(width, height) > limits.maxSide || width * height > limits.maxPixels) return `This image is too large. Use one up to ${limits.maxSide} pixels on its longest side.`;
  } catch { return 'This file could not be opened as an image.'; }
  return undefined;
}

const JOB_STATUS: Record<string, string> = { needs_review: 'Waiting for your review', running: 'Processing', queued: 'Processing', cancel_requested: 'Stopping', completed: 'Ready', partial: 'Ready', failed: 'Needs attention', cancelled: 'Stopped' };

export function UploadStep({ capabilities, jobs, hasArtwork, artworkUrl, busy, onStart, onOpenJob, onDeleteJob, onLogin }: {
  capabilities: DecompositionCapabilities; jobs: DecompositionJobSummary[]; hasArtwork: boolean; artworkUrl?: string; busy: boolean;
  onStart: (file: File | null, labels: string[]) => void; onOpenJob: (job: DecompositionJobSummary) => void; onDeleteJob: (job: DecompositionJobSummary) => void; onLogin: (password: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [useArtwork, setUseArtwork] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [labels, setLabels] = useState('');
  const [password, setPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const choose = async (candidate: File | null | undefined) => {
    if (!candidate) return;
    setError('');
    const problem = await validateImage(candidate, capabilities.limits);
    if (problem) { setError(problem); return; }
    setUseArtwork(false); setFile(candidate);
  };
  const fileUrl = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => { if (fileUrl) URL.revokeObjectURL(fileUrl); }, [fileUrl]);
  const preview = fileUrl ?? (useArtwork ? artworkUrl : undefined);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => { const item = [...(event.clipboardData?.files ?? [])].find(f => f.type.startsWith('image/')); if (item) { event.preventDefault(); void choose(item); } };
    window.addEventListener('paste', paste); return () => window.removeEventListener('paste', paste);
  });
  if (!capabilities.enabled || !capabilities.configured) return <div className="ws-center"><div className="ws-empty"><Layers size={28} /><h2>Image layers aren’t available yet</h2><p>This workspace needs its AI service set up. Your designs and editing are not affected.</p></div></div>;
  if (!capabilities.authenticated) return <div className="ws-center"><form className="ws-card ws-signin" onSubmit={e => { e.preventDefault(); onLogin(password); setPassword(''); }}>
    <h2>Sign in to use image layers</h2><label className="ws-field">Password<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
    <button className="ws-btn ws-btn-primary" disabled={busy || !password}>Sign in</button></form></div>;
  const ready = Boolean(file || useArtwork);
  const unfinished = jobs.find(j => ['needs_review', 'running', 'queued'].includes(j.state));
  return <div className="ws-upload">
    {unfinished && <section className="ws-resume" aria-label="Continue where you left off">
      {unfinished.sourcePreviewArtifactId ? <img src={artifactUrl(unfinished.sourcePreviewArtifactId)} alt="" /> : null}
      <span className="ws-recent-text"><strong>Continue where you left off</strong><span>{JOB_STATUS[unfinished.state]} · {new Date(unfinished.updatedAt).toLocaleString()}</span></span>
      <button className="ws-btn ws-btn-primary" onClick={() => onOpenJob(unfinished)}>Continue</button>
    </section>}
    <div className="ws-upload-hero">
      <h2>Turn any image into an editable design</h2>
      <p>Upload a poster, social graphic or product creative. AI will separate images, text, shapes and the background into editable layers.</p>
      <div className={`ws-dropzone ${dragging ? 'is-dragging' : ''} ${ready ? 'has-file' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
        onDrop={e => { e.preventDefault(); setDragging(false); void choose(e.dataTransfer.files?.[0]); }}>
        {ready && preview ? <><img src={preview} alt="Selected image" className="ws-dropzone-preview" /><div className="ws-dropzone-file"><strong>{file?.name ?? 'Current design artwork'}</strong><button className="ws-link" onClick={() => { setFile(null); setUseArtwork(false); }}>Choose a different image</button></div></>
          : <><UploadCloud size={34} strokeWidth={1.5} /><p className="ws-dropzone-title">Drop an image here, paste it, or</p>
            <button className="ws-btn ws-btn-primary" onClick={() => input.current?.click()}><ImagePlus size={15} />Choose image</button>
            <p className="ws-hint">PNG, JPEG or WebP · up to {mb(capabilities.limits.uploadBytes)} · {capabilities.limits.minSide}–{capabilities.limits.maxSide} px</p></>}
        <input ref={input} type="file" accept={ACCEPTED.join(',')} hidden aria-label="Choose image" onChange={e => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
      </div>
      {error && <p className="ws-error-text" role="alert">{error}</p>}
      {!ready && hasArtwork && <button className="ws-link" onClick={() => { setFile(null); setUseArtwork(true); }}>Use this design’s artwork instead</button>}
      <details className="ws-options"><summary>Tell AI what to look for (optional)</summary><label className="ws-field">Things to separate, separated by commas<input placeholder="e.g. woman, phone, logo" value={labels} maxLength={600} onChange={e => setLabels(e.target.value)} /></label></details>
      <button className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || !ready} onClick={() => onStart(file, labels.split(',').map(s => s.trim()).filter(Boolean))}>{busy ? <><Loader2 size={16} className="ws-spin" />Uploading…</> : 'Separate layers'}</button>
    </div>
    {jobs.length > 0 && <section className="ws-recent" aria-label="Recent designs"><h3>Recent designs</h3><ul>{jobs.slice(0, 8).map(job => <li key={job.id}>
      {job.sourcePreviewArtifactId ? <img src={artifactUrl(job.sourcePreviewArtifactId)} alt="" loading="lazy" /> : <span className="ws-thumb ws-thumb-empty" />}
      <span className="ws-recent-text"><strong>{JOB_STATUS[job.state] ?? job.state}</strong><span>{new Date(job.createdAt).toLocaleString()}</span></span>
      <button className="ws-btn" onClick={() => onOpenJob(job)}>{job.state === 'completed' ? 'Open' : 'Continue'}</button>
      {confirmDelete === job.id ? <button className="ws-btn ws-btn-danger" onClick={() => { setConfirmDelete(null); onDeleteJob(job); }}>Confirm delete</button>
        : <button className="ws-icon-button" aria-label="Delete this design" title="Delete" onClick={() => setConfirmDelete(job.id)}><Trash2 size={15} /></button>}
    </li>)}</ul></section>}
  </div>;
}

export function ProcessingStep({ job, onCancel, busy }: { job: DecompositionJobSummary; onCancel: () => void; busy: boolean }) {
  const stages = processingStages(job);
  return <div className="ws-processing">
    {job.sourcePreviewArtifactId && <div className="ws-processing-preview"><img src={artifactUrl(job.sourcePreviewArtifactId)} alt="Your design" /><div className="ws-scan" aria-hidden="true" /></div>}
    <div className="ws-card ws-progress-card" role="status" aria-live="polite">
      <h2>Preparing your design…</h2>
      <p className="ws-muted">{processingMessage(job)}</p>
      <ol className="ws-stages">{stages.map(s => <li key={s.label} className={`is-${s.state}`}>{s.state === 'done' ? <Check size={15} strokeWidth={3} /> : s.state === 'active' ? <Loader2 size={15} className="ws-spin" /> : <Circle size={15} />}<span>{s.label}</span></li>)}</ol>
      <p className="ws-hint">This usually takes a minute or two. You can close this window — we’ll keep working and you can continue from Recent designs.</p>
      <button className="ws-btn ws-btn-quiet" disabled={busy || job.state === 'cancel_requested'} onClick={onCancel}>Stop</button>
    </div>
  </div>;
}

export function ReadyStep({ job, busy, onOpen }: { job: DecompositionJobSummary; busy: boolean; onOpen: () => void }) {
  const [reviewing, setReviewing] = useState(false);
  const s = readySummary(job.sceneGraph);
  const layers = job.sceneGraph?.layers ?? [];
  const icon = (type: string) => type === 'text' ? <Type size={14} /> : type === 'shape' ? <Square size={14} /> : type === 'background' ? <Mountain size={14} /> : <ImageIcon size={14} />;
  const artifact = (l: (typeof layers)[number]) => l.type === 'image' ? l.transparentRgbaArtifactId : l.type === 'background' ? l.imageArtifactId : l.rasterArtifactId;
  return <div className="ws-ready">
    <div className="ws-ready-preview">{job.sourcePreviewArtifactId && <img src={artifactUrl(job.sourcePreviewArtifactId)} alt="Your design" />}</div>
    <div className="ws-card ws-ready-card">
      <span className="ws-ready-badge"><Check size={16} strokeWidth={3} /></span>
      <h2>Your editable design is ready</h2>
      <ul className="ws-ready-stats">
        <li><strong>{s.editable}</strong>editable layer{s.editable === 1 ? '' : 's'}</li>
        <li><strong>{s.text}</strong>text</li><li><strong>{s.shapes}</strong>shape{s.shapes === 1 ? '' : 's'}</li><li><strong>{s.images}</strong>image{s.images === 1 ? '' : 's'}</li>
        {s.background && <li><strong><Check size={14} strokeWidth={3} /></strong>background</li>}
      </ul>
      {s.text > 0 && <p className="ws-hint">Text keeps its original look. Select a text layer in the editor and choose “Make text editable” to change the words.</p>}
      <div className="ws-row"><button className="ws-btn ws-btn-primary ws-btn-large" disabled={busy || !job.sceneGraph} onClick={onOpen}>{busy ? <><Loader2 size={16} className="ws-spin" />Opening…</> : 'Open in editor'}</button>
        <button className="ws-btn" aria-expanded={reviewing} onClick={() => setReviewing(!reviewing)}>Review layers</button></div>
      {reviewing && <ul className="ws-ready-layers" aria-label="Layers in your design">{[...layers].reverse().map(l => <li key={l.id}>{artifact(l) ? <img src={artifactUrl(artifact(l)!)} alt="" loading="lazy" /> : null}<span>{l.name}</span><span className="ws-muted">{icon(l.type)}{l.type === 'shape' && l.shapeType === 'raster' ? 'image' : l.type}</span></li>)}</ul>}
    </div>
  </div>;
}

export function ErrorStep({ job, busy, onRetry, onNewAttempt, onStartOver }: { job: DecompositionJobSummary; busy: boolean; onRetry: () => void; onNewAttempt: () => void; onStartOver: () => void }) {
  const e = friendlyError(job);
  return <div className="ws-center"><div className="ws-card ws-error-card" role="alert">
    <AlertTriangle size={26} /><h2>{e.title}</h2><p>{e.message}</p>
    <div className="ws-row">
      {e.canRetry && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={onRetry}><RefreshCw size={14} />Try again</button>}
      {!e.canRetry && job.state !== 'cancelled' && <button className="ws-btn ws-btn-primary" disabled={busy} onClick={onNewAttempt}><RefreshCw size={14} />Start a new attempt</button>}
      <button className="ws-btn" disabled={busy} onClick={onStartOver}>Use a different image</button>
    </div>
    {e.exhausted && <p className="ws-hint">Your previous attempt stays in Recent designs.</p>}
  </div></div>;
}
