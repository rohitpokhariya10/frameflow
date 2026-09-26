import { useEffect, useRef, useState } from 'react';
import type { DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { validDecompositionReview } from '@frameflow/shared';
import { MaskCanvas, type MaskEdits } from './MaskCanvas';
import { artifactUrl } from './api';
import { submitReviewOnce } from './reviewSubmission';
export function AlphaReview({ job, busy, onSubmit }: { job: DecompositionJobSummary; busy: boolean; onSubmit: (body: DecompositionReview) => Promise<void> }) {
  const [active, setActive] = useState(job.refined?.[0]?.id ?? '');
  const key = `frameflow:alpha-review:${job.id}:${job.revision}`;
  const [drafts, setDrafts] = useState<Record<string, MaskEdits>>(() => { try { const d = JSON.parse(sessionStorage.getItem(key) || 'null') as unknown; if (validDecompositionReview(d, job.sourceWidth!, job.sourceHeight!)) return Object.fromEntries((d.objects ?? []).map(o => [o.id, o])); } catch { /* optional storage */ } return {}; });
  const [alphaValue, setAlphaValue] = useState(255);
  const [status, setStatus] = useState({ pending: false, error: '' }); const lock = useRef(false);
  const selected = job.refined?.find(o => o.id === active);
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify({ expectedRevision: job.revision, action: 'manual-alpha', objects: Object.entries(drafts).map(([id, edits]) => ({ id, ...edits })) })); } catch { /* optional storage */ } }, [key, job.revision, drafts]);
  const send = (action: DecompositionReview['action']) => void submitReviewOnce(lock, { expectedRevision: job.revision, action, alphaValue, objects: [{ id: active, selected: true, ...drafts[active] }] }, onSubmit, setStatus);
  const disabled = busy || status.pending;
  const dirty = Object.values(drafts).some(d => d.strokes?.length);
  return <section aria-label="Final alpha review"><h3>Final mask and alpha review</h3><p>Inspect every layer on light and dark surfaces. Save edge changes before approving source-pixel extraction.</p><label>Target <select value={active} onChange={e => setActive(e.target.value)}>{job.refined?.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</select></label>
    {selected && <><div className="decomp-layer-grid">{[['Mask', selected.maskArtifactId], ['Alpha', selected.alphaArtifactId], ['Overlay', selected.overlayArtifactId]].map(([label, id]) => <article key={label}><strong>{label}</strong><a href={artifactUrl(id)} target="_blank" rel="noreferrer"><img src={artifactUrl(id)} alt={`${selected.label} ${label}`} className="decomp-checker" /></a></article>)}</div><p>Revision {selected.revisionId} · Visual approval required</p><label>Add alpha strength <input type="range" min={1} max={255} value={alphaValue} onChange={e => setAlphaValue(Number(e.target.value))} /> {Math.round(alphaValue / 255 * 100)}%</label><MaskCanvas key={selected.id} sourceId={job.sourcePreviewArtifactId!} maskId={selected.alphaArtifactId} width={job.sourceWidth!} height={job.sourceHeight!} edits={drafts[active] ?? {}} onChange={edits => setDrafts(all => ({ ...all, [active]: edits }))} disabled={disabled} /></>}
    {status.error && <p role="alert">{status.error}</p>}<div className="decomp-row"><button disabled={disabled} onClick={() => send('manual-alpha')}>Save alpha edits (no AI)</button><button disabled={disabled} onClick={() => send('restore-interior')}>Restore semantic interior</button><button disabled={disabled} onClick={() => send('back-to-semantic')}>Back to semantic correction</button><button disabled={disabled || dirty} onClick={() => send('approve-result')}>Approve alpha and extract</button></div>{dirty && <p>Save your pending edge edits before approval.</p>}
  </section>;
}
