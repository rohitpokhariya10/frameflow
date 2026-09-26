import { useEffect, useRef, useState } from 'react';
import { Sparkles, Save, RotateCcw, ArrowLeft } from 'lucide-react';
import type { DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { submitReviewOnce } from '../reviewSubmission';
import { reviewNotice, selectionStatus } from '../flow';
import { Thumb, Toast } from './parts';
import { PaintCanvas, strokeHints, type PaintEdits } from './PaintCanvas';

type ObjectDraft = PaintEdits & { selected: boolean };
function useDraft<T>(key: string, initial: () => T) {
  const [value, setValue] = useState<T>(() => { try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null') as T | null; if (saved) return saved; } catch { /* optional */ } return initial(); });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* optional */ } }, [key, value]);
  return [value, setValue] as const;
}
const pendingCount = (d?: PaintEdits) => (d?.strokes?.length ?? 0) + (d?.points?.length ?? 0) + (d?.box ? 1 : 0);

/** "Refine selection": brush corrections are saved without AI; AI refine uses them as hints; "Looks good" confirms. */
export function RefineStep({ job, onSubmit, busy }: { job: DecompositionJobSummary; onSubmit: (body: DecompositionReview) => Promise<void>; busy: boolean }) {
  const candidates = (job.candidates ?? []).filter(c => c.source === 'sam3' || !c.source);
  const [drafts, setDrafts] = useDraft<Record<string, ObjectDraft>>(`frameflow:refine:${job.id}:${job.revision}`, () => Object.fromEntries(candidates.map(c => [c.id, { selected: true }])));
  const [activeId, setActiveId] = useState(candidates.find(c => c.qualityTier === 'FAIL')?.id ?? candidates[0]?.id ?? '');
  const [status, setStatus] = useState({ pending: false, error: '' }); const lock = useRef(false);
  const active = candidates.find(c => c.id === activeId);
  const draft = drafts[activeId] ?? { selected: true };
  const setDraft = (change: Partial<ObjectDraft>) => setDrafts(all => ({ ...all, [activeId]: { ...(all[activeId] ?? { selected: true }), ...change } }));
  const included = candidates.filter(c => drafts[c.id]?.selected !== false);
  const blocked = included.find(c => selectionStatus(c).tone === 'fix' && !drafts[c.id]?.strokes?.length);
  const disabled = busy || status.pending;
  const notice = reviewNotice(job);
  const send = (body: Omit<DecompositionReview, 'expectedRevision'>) => void submitReviewOnce(lock, { expectedRevision: job.revision, ...body }, onSubmit, setStatus);
  const aiRefine = () => {
    if (!active) return;
    const hints = strokeHints(draft), bbox = (active.statistics as { bbox?: { x: number; y: number; width: number; height: number } | null } | undefined)?.bbox;
    send({ action: 'guided-refine', objects: [{ id: active.id, candidateId: active.id, label: active.label, selected: true, points: hints, ...(draft.box ? { box: draft.box } : !hints.length && bbox ? { box: bbox } : {}) }] });
  };
  const saveManual = () => active && send({ action: 'manual-masks', objects: [{ id: active.id, candidateId: active.id, label: active.label, selected: true, strokes: draft.strokes ?? [] }] });
  const looksGood = () => send({ action: 'accept-masks', objects: candidates.map(c => ({ id: c.id, candidateId: c.id, label: c.label, selected: drafts[c.id]?.selected !== false, strokes: drafts[c.id]?.strokes ?? [] })) });
  const st = selectionStatus(active);
  return <div className="ws-grid">
    <aside className="ws-pane ws-list-pane" aria-label="Objects to refine">
      <div className="ws-pane-head"><h3>Objects <span className="ws-count">{candidates.length}</span></h3><p>Check each object is fully selected.</p></div>
      <ul className="ws-layer-list">{candidates.map(c => { const s = selectionStatus(c), off = drafts[c.id]?.selected === false; return <li key={c.id} className={`ws-layer ${c.id === activeId ? 'is-active' : ''} ${off ? 'is-removed' : ''}`}>
        <button className="ws-layer-main" aria-current={c.id === activeId} onClick={() => setActiveId(c.id)}>
          <Thumb artifactId={c.overlayArtifactId ?? c.maskArtifactId} />
          <span className="ws-layer-text"><span className="ws-layer-name">{c.label}</span><span className="ws-layer-meta"><span className={`ws-status ws-status-${s.tone}`}>{off ? 'Not included' : s.title}</span>{pendingCount(drafts[c.id]) > 0 && <span className="ws-muted">Unsaved edits</span>}</span></span>
        </button></li>; })}</ul>
    </aside>
    <section className="ws-pane ws-preview-pane" aria-label="Selection">
      {active ? <PaintCanvas label={`Selection for ${active.label}`} sourceId={job.sourcePreviewArtifactId!} width={job.sourceWidth!} height={job.sourceHeight!} maskId={active.maskArtifactId}
        edits={draft} onChange={edits => setDraft(edits)} disabled={disabled || draft.selected === false} /> : <p className="ws-muted">Nothing to refine.</p>}
    </section>
    <aside className="ws-pane ws-inspector-pane" aria-label="Selection status">
      {active && <div className="ws-inspector">
        <h3 className="ws-inspector-title">{active.label}</h3>
        {notice && <p className="ws-notice" role="status">{notice}</p>}
        <div className={`ws-status-card ws-status-${st.tone}`} aria-label="Selection status"><strong>{st.title}</strong>{st.details.length > 0 && <ul>{st.details.map(d => <li key={d}>{d}</li>)}</ul>}</div>
        <label className="ws-check"><input type="checkbox" checked={draft.selected !== false} disabled={disabled} onChange={e => setDraft({ selected: e.target.checked })} />Include in my design</label>
        <div className="ws-stack">
          <button className="ws-btn" disabled={disabled || draft.selected === false} title="Let AI clean the selection boundary and recover missed details." onClick={aiRefine}><Sparkles size={14} />AI refine</button>
          <p className="ws-hint">{pendingCount(draft) ? 'AI will use your painted areas as hints.' : 'Tip: paint roughly over missing or extra parts first — AI uses them as hints.'}</p>
          <button className="ws-btn" disabled={disabled || !draft.strokes?.length || draft.selected === false} title="Apply your painted changes exactly, without AI." onClick={saveManual}><Save size={14} />Save my changes</button>
        </div>
      </div>}
    </aside>
    <footer className="ws-footer">
      <span className="ws-footer-status" aria-live="polite">{status.error ? <span className="ws-error-text" role="alert">{status.error}</span> : !included.length ? 'Include at least one object.' : blocked ? `Fix “${blocked.label}” first — paint over it, or use AI refine.` : `${included.length} object${included.length === 1 ? '' : 's'} ready. Painted changes are applied when you continue.`}</span>
      <button className="ws-btn ws-btn-primary" disabled={disabled || !included.length || !!blocked} onClick={looksGood}>{status.pending ? 'Working…' : 'Looks good'}</button>
    </footer>
  </div>;
}

/** "Check the edges": the cut-out on transparent/dark/light; paint to add or remove edge areas, then confirm. */
export function EdgesStep({ job, onSubmit, busy }: { job: DecompositionJobSummary; onSubmit: (body: DecompositionReview) => Promise<void>; busy: boolean }) {
  const refined = job.refined ?? [];
  const [drafts, setDrafts] = useDraft<Record<string, PaintEdits>>(`frameflow:edges:${job.id}:${job.revision}`, () => ({}));
  const [activeId, setActiveId] = useState(refined[0]?.id ?? '');
  const [surface, setSurface] = useState<'checker' | 'dark' | 'light'>('checker');
  const [toast, setToast] = useState('');
  const [status, setStatus] = useState({ pending: false, error: '' }); const lock = useRef(false);
  const active = refined.find(r => r.id === activeId);
  const draft = drafts[activeId] ?? {};
  const dirty = Object.values(drafts).some(d => d.strokes?.length);
  const disabled = busy || status.pending;
  const notice = reviewNotice(job);
  const send = (body: Omit<DecompositionReview, 'expectedRevision'>) => void submitReviewOnce(lock, { expectedRevision: job.revision, ...body }, onSubmit, setStatus);
  return <div className="ws-grid">
    <aside className="ws-pane ws-list-pane" aria-label="Objects">
      <div className="ws-pane-head"><h3>Objects <span className="ws-count">{refined.length}</span></h3><p>Check the edges of each cut-out.</p></div>
      <ul className="ws-layer-list">{refined.map(r => <li key={r.id} className={`ws-layer ${r.id === activeId ? 'is-active' : ''}`}>
        <button className="ws-layer-main" aria-current={r.id === activeId} onClick={() => setActiveId(r.id)}><Thumb artifactId={r.overlayArtifactId} /><span className="ws-layer-text"><span className="ws-layer-name">{r.label}</span><span className="ws-layer-meta">{drafts[r.id]?.strokes?.length ? <span className="ws-muted">Unsaved edits</span> : <span className="ws-status ws-status-check">Ready to check</span>}</span></span></button>
      </li>)}</ul>
    </aside>
    <section className={`ws-pane ws-preview-pane ws-surface-${surface}`} aria-label="Cut-out preview">
      <div className="ws-surface-toggle" role="radiogroup" aria-label="Preview background">{(['checker', 'dark', 'light'] as const).map(s => <button key={s} role="radio" aria-checked={surface === s} className={surface === s ? 'is-on' : ''} onClick={() => setSurface(s)}>{s === 'checker' ? 'Transparent' : s === 'dark' ? 'Dark' : 'Light'}</button>)}</div>
      {active && <PaintCanvas label={`Edges of ${active.label}`} sourceId={job.sourcePreviewArtifactId!} width={job.sourceWidth!} height={job.sourceHeight!} maskId={active.alphaArtifactId} overlay="cutout"
        edits={draft} onChange={edits => setDrafts(all => ({ ...all, [activeId]: { strokes: edits.strokes } }))} disabled={disabled} />}
    </section>
    <aside className="ws-pane ws-inspector-pane" aria-label="Edge settings">
      {active && <div className="ws-inspector">
        <h3 className="ws-inspector-title">{active.label}</h3>
        {notice && <p className="ws-notice" role="status">{notice}</p>}
        <p className="ws-muted">Look closely at hair, fingers and thin details. Paint to add or remove edge areas.</p>
        <div className="ws-stack">
          <button className="ws-btn" disabled={disabled || !draft.strokes?.length} onClick={() => send({ action: 'manual-alpha', alphaValue: 255, objects: [{ id: active.id, selected: true, strokes: draft.strokes ?? [] }] })}><Save size={14} />Save my changes</button>
          <button className="ws-btn" disabled={disabled} title="Bring back any part inside the object that was trimmed too much." onClick={() => { send({ action: 'restore-interior', objects: [{ id: active.id, selected: true }] }); setToast('Restoring the full object…'); }}><RotateCcw size={14} />Restore trimmed areas</button>
          <button className="ws-btn ws-btn-quiet" disabled={disabled} title="Go back and change which pixels belong to the object." onClick={() => send({ action: 'back-to-semantic' })}><ArrowLeft size={14} />Back to selection</button>
        </div>
      </div>}
    </aside>
    <footer className="ws-footer">
      <span className="ws-footer-status" aria-live="polite">{status.error ? <span className="ws-error-text" role="alert">{status.error}</span> : dirty ? 'Save your edge changes before continuing.' : 'When the edges look right, build your editable design.'}</span>
      <button className="ws-btn ws-btn-primary" disabled={disabled || dirty} onClick={() => send({ action: 'approve-result' })}>{status.pending ? 'Working…' : 'Looks good'}</button>
    </footer>
    <Toast message={toast} />
  </div>;
}
