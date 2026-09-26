import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, Save, RotateCcw, ArrowLeft, Check } from 'lucide-react';
import type { DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { submitReviewOnce } from '../reviewSubmission';
import { reviewNotice, selectionStatus } from '../flow';
import { Thumb, Toast } from './parts';
import { PaintCanvas, strokeHints, type PaintEdits } from './PaintCanvas';
import { EDGE_DRAFTS, loadObjectDrafts, markDraftSubmitted, persistObjectDraft, sessionDraftStorage, type ObjectDraft } from './refineDrafts';
/** Saved strokes are already applied to the current selection; only unsent drafts may replay them. */
export function restoredSelections(job: DecompositionJobSummary, candidates: NonNullable<DecompositionJobSummary['candidates']>): Record<string, ObjectDraft> {
  return Object.fromEntries(candidates.map(candidate => {
    const saved = job.reviewSubmission?.objects?.find(object => object.id === candidate.id && (object.candidateId ?? object.id) === candidate.id);
    return [candidate.id, { selected: saved?.selected !== false, points: saved?.points ?? [], ...(saved?.box ? { box: saved.box } : {}), strokes: [] }];
  }));
}
/** Remembers which object was open, so a failed save or reload returns to it. */
function useActiveObject(storage: ReturnType<typeof sessionDraftStorage>, key: string, ids: string[], preferred: string) {
  const [activeId, setActiveId] = useState(() => {
    let remembered: string | null = null; try { remembered = storage?.getItem(key) ?? null; } catch { /* optional */ }
    return remembered && ids.includes(remembered) ? remembered : preferred;
  });
  useEffect(() => { try { storage?.setItem(key, activeId); } catch { /* optional */ } }, [storage, key, activeId]);
  return [activeId, setActiveId] as const;
}
const clearedNotice = (labels: string[], what = 'selection') => labels.length > 0 && <p className="ws-notice" role="status">{`Your unsaved edits on ${labels.map(l => `“${l}”`).join(', ')} were cleared because the ${what} changed. Paint them again if you still need them.`}</p>;
const pendingCount = (d?: PaintEdits) => (d?.strokes?.length ?? 0) + (d?.points?.length ?? 0) + (d?.box ? 1 : 0);

/** "Refine selection": brush corrections are saved without AI; AI refine uses them as hints; "Looks good" confirms. */
export function RefineStep({ job, onSubmit, busy }: { job: DecompositionJobSummary; onSubmit: (body: DecompositionReview) => Promise<void>; busy: boolean }) {
  const candidates = useMemo(() => (job.candidates ?? []).filter(c => c.source === 'sam3' || !c.source), [job.candidates]);
  // Drafts are kept per object and tied to that object's saved revision, so a failed save or an unrelated revision bump keeps them.
  const [storage] = useState(sessionDraftStorage);
  const [restored] = useState(() => loadObjectDrafts(storage, job, candidates, restoredSelections(job, candidates)));
  const [drafts, setDrafts] = useState<Record<string, ObjectDraft>>(restored.drafts);
  useEffect(() => { for (const c of candidates) if (drafts[c.id]) persistObjectDraft(storage, job, c, drafts[c.id]); }, [storage, job, candidates, drafts]);
  const [activeId, setActiveId] = useActiveObject(storage, `frameflow:refine-active:${job.id}`, candidates.map(c => c.id), candidates.find(c => c.qualityTier === 'FAIL')?.id ?? candidates[0]?.id ?? '');
  const [status, setStatus] = useState({ pending: false, error: '' }); const lock = useRef(false);
  const active = candidates.find(c => c.id === activeId);
  const draft = drafts[activeId] ?? { selected: true };
  const setDraft = (change: Partial<ObjectDraft>) => setDrafts(all => ({ ...all, [activeId]: { ...(all[activeId] ?? { selected: true }), ...change } }));
  const included = candidates.filter(c => drafts[c.id]?.selected !== false);
  // Painting never fixes a selection by itself: only a saved revision that passes the ownership checks unblocks it.
  const blocked = included.find(c => selectionStatus(c).tone === 'fix');
  const unsaved = included.find(c => drafts[c.id]?.strokes?.length);
  // AI's possible selection needs an explicit keep or save; painting alone is not a confirmation.
  const unconfirmed = included.find(c => c.provisional);
  const disabled = busy || status.pending;
  const notice = reviewNotice(job);
  const send = (body: Omit<DecompositionReview, 'expectedRevision'>) => void submitReviewOnce(lock, { expectedRevision: job.revision, ...body }, onSubmit, setStatus);
  // A draft sent for saving is cleared quietly once its object has a new revision; if the save fails it is restored.
  const sendDraft = (body: Omit<DecompositionReview, 'expectedRevision'>) => { if (active) markDraftSubmitted(storage, job, active); send(body); };
  const hints = strokeHints(draft), bbox = (active?.statistics as { bbox?: { x: number; y: number; width: number; height: number } | null } | undefined)?.bbox;
  // With nothing selected and no painted "add" area or box, AI would only have the label to go on.
  const needsHint = !bbox && !draft.box && !hints.some(h => h.label === 1);
  const aiRefine = () => {
    if (!active || needsHint) return;
    sendDraft({ action: 'guided-refine', objects: [{ id: active.id, candidateId: active.id, label: active.label, selected: true, points: hints, ...(draft.box ? { box: draft.box } : !hints.length && bbox ? { box: bbox } : {}) }] });
  };
  const saveManual = () => active && sendDraft({ action: 'manual-masks', objects: [{ id: active.id, candidateId: active.id, label: active.label, selected: true, strokes: draft.strokes ?? [] }] });
  // Keeping AI's possible selection saves it as your own revision through the same manual path; it still goes through ownership checks.
  const keepSelection = () => active && send({ action: 'manual-masks', objects: [{ id: active.id, candidateId: active.id, label: active.label, selected: true, strokes: [] }] });
  // Confirms saved revisions only; unsaved strokes stay in the draft and are never sent with a confirmation.
  const looksGood = () => !unsaved && send({ action: 'accept-masks', objects: candidates.map(c => ({ id: c.id, candidateId: c.id, label: c.label, selected: drafts[c.id]?.selected !== false })) });
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
        {clearedNotice(restored.invalidated)}
        <div className={`ws-status-card ws-status-${st.tone}`} aria-label="Selection status"><strong>{st.title}</strong>{st.details.length > 0 && <ul>{st.details.map(d => <li key={d}>{d}</li>)}</ul>}</div>
        <label className="ws-check"><input type="checkbox" checked={draft.selected !== false} disabled={disabled} onChange={e => setDraft({ selected: e.target.checked })} />Include in my design</label>
        <div className="ws-stack">
          <button className="ws-btn" disabled={disabled || draft.selected === false || needsHint} title="Let AI clean the selection boundary and recover missed details." onClick={aiRefine}><Sparkles size={14} />AI refine</button>
          <p className="ws-hint">{needsHint ? 'Paint over the object first so AI knows where to look — or paint the whole object and save it yourself.' : pendingCount(draft) ? 'AI will use your painted areas as hints.' : 'Tip: paint roughly over missing or extra parts first — AI uses them as hints.'}</p>
          <button className="ws-btn" disabled={disabled || !draft.strokes?.length || draft.selected === false} title="Apply your painted changes exactly, without AI." onClick={saveManual}><Save size={14} />Save my changes</button>
          {active.provisional && !draft.strokes?.length && <button className="ws-btn" disabled={disabled || draft.selected === false} title="Use AI's possible selection as it is, without changes." onClick={keepSelection}><Check size={14} />Keep this selection</button>}
        </div>
      </div>}
    </aside>
    <footer className="ws-footer">
      <span className="ws-footer-status" aria-live="polite">{status.error ? <span className="ws-error-text" role="alert">{status.error}</span> : !included.length ? 'Include at least one object.' : unsaved ? `Save your changes first — “${unsaved.label}” has unsaved edits.` : unconfirmed ? `Check “${unconfirmed.label}” first — keep AI’s selection or save your fixes.` : blocked ? `Fix “${blocked.label}” first — paint over it and save, or use AI refine.` : `${included.length} object${included.length === 1 ? '' : 's'} ready.`}</span>
      <button className="ws-btn ws-btn-primary" disabled={disabled || !included.length || !!unsaved || !!blocked || !!unconfirmed} onClick={looksGood}>{status.pending ? 'Working…' : 'Looks good'}</button>
    </footer>
  </div>;
}

/** "Check the edges": the cut-out on transparent/dark/light; paint to add or remove edge areas, then confirm. */
export function EdgesStep({ job, onSubmit, busy }: { job: DecompositionJobSummary; onSubmit: (body: DecompositionReview) => Promise<void>; busy: boolean }) {
  const refined = useMemo(() => job.refined ?? [], [job.refined]);
  // Edge drafts are kept per object and tied to that object's saved alpha revision, like selection drafts.
  const [storage] = useState(sessionDraftStorage);
  const [restored] = useState(() => loadObjectDrafts<PaintEdits>(storage, job, refined, {}, EDGE_DRAFTS));
  const [drafts, setDrafts] = useState<Record<string, PaintEdits>>(restored.drafts);
  useEffect(() => { for (const r of refined) if (drafts[r.id]) persistObjectDraft(storage, job, r, drafts[r.id], EDGE_DRAFTS); }, [storage, job, refined, drafts]);
  const [activeId, setActiveId] = useActiveObject(storage, `frameflow:edges-active:${job.id}`, refined.map(r => r.id), refined[0]?.id ?? '');
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
        {clearedNotice(restored.invalidated, 'cut-out')}
        <p className="ws-muted">Look closely at hair, fingers and thin details. Paint to add or remove edge areas.</p>
        <div className="ws-stack">
          <button className="ws-btn" disabled={disabled || !draft.strokes?.length} onClick={() => { markDraftSubmitted(storage, job, active, EDGE_DRAFTS); send({ action: 'manual-alpha', alphaValue: 255, objects: [{ id: active.id, selected: true, strokes: draft.strokes ?? [] }] }); }}><Save size={14} />Save my changes</button>
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
