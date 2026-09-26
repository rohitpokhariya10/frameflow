import { useEffect, useRef, useState } from 'react';
import type { DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { validDecompositionReview } from '@frameflow/shared';
import { artifactUrl } from './api';
import { submitReviewOnce } from './reviewSubmission';
import { MaskCanvas } from './MaskCanvas';

export type ReviewCandidate = NonNullable<DecompositionJobSummary['candidates']>[number];
export function MaskReview({ job, candidates, sourceId, width, height, onSubmit, busy }: {
  job: DecompositionJobSummary; candidates: ReviewCandidate[]; sourceId: string; width: number; height: number;
  onSubmit: (review: DecompositionReview) => void | Promise<void>; busy: boolean;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [groupLabel, setGroupLabel] = useState('');
  const semanticCandidates = candidates.filter(c => c.source !== 'sam2' && c.source !== undefined);
  const visibleCandidates = advanced || !semanticCandidates.length ? candidates : semanticCandidates;
  const [active, setActive] = useState(visibleCandidates[0]?.id || '');
  const draftKey = `frameflow:mask-review:${job.id}:${job.revision}`;
  const [objects, setObjects] = useState<NonNullable<DecompositionReview['objects']>>(() => {
    let saved = job.reviewSubmission;
    try {
      const draft: unknown = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (validDecompositionReview(draft, width, height) && draft.expectedRevision === job.revision) saved = draft;
    } catch { /* Browser storage is optional; server-accepted corrections still recover. */ }
    return candidates.map(c => ({ id: c.id, candidateId: c.id, label: c.label, selected: false, points: [], strokes: [], completeHidden: false, ...saved?.objects?.find(object => object.id === c.id && (object.candidateId ?? object.id) === c.id) }));
  });
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ expectedRevision: job.revision, action: 'accept-masks', objects })); } catch { /* Keep editing in memory when storage is unavailable. */ }
  }, [draftKey, job.revision, objects]);
  const selected = objects.find((object) => object.id === active);
  const candidate = candidates.find((object) => object.id === active);
  const update = (change: Partial<(typeof objects)[number]>) => setObjects((all) => all.map((object) => object.id === active ? { ...object, ...change } : object));
  const submissionLock = useRef(false);
  const [submission, setSubmission] = useState({ pending: false, error: '' });
  const send = (action: DecompositionReview['action']) => {
    if (busy) return;
    void submitReviewOnce(submissionLock, { expectedRevision: job.revision, action, objects, ...(['merge-targets','split-target'].includes(action) ? { group: { label: groupLabel || selected?.label || 'Target group', memberIds: action === 'split-target' ? [active] : objects.filter(o => o.selected).map(o => o.id) } } : {}) }, onSubmit, setSubmission);
  };
  const submitting = busy || submission.pending;
  return <section aria-label="Mask review">
    <h3>Review masks</h3><p>{job.review?.message}</p>
    <p>Paint visible source pixels. Positive points can include missing regions. AI correction returns here for inspection; confirming ownership starts edge refinement.</p>
    <p><strong>Included ({objects.filter(o => o.selected).length}):</strong> {objects.filter(o => o.selected).map(o => advanced ? `${o.label} (${o.candidateId})` : o.label).join(', ') || 'None — choose the intended object below.'}</p>
    <p>Choose the target and include it. Exclude targets you do not want to extract.</p>
    <button disabled={submitting || !active} onClick={() => setObjects(all => all.map(object => ({ ...object, selected: object.id === active })))}>Use only this candidate</button>
    <label><input type="checkbox" checked={advanced} onChange={e => { setAdvanced(e.target.checked); if (!e.target.checked && semanticCandidates.length && !semanticCandidates.some(c => c.id === active)) setActive(semanticCandidates[0].id); }} /> Advanced / raw proposals</label>
    <div className="decomp-row"><label>Object <select value={active} onChange={(e) => setActive(e.target.value)}>{visibleCandidates.map((c) => <option key={c.id} value={c.id}>{c.label} — {c.qualityStatus === 'needs-correction' ? 'Needs correction' : 'Inspect target'}{advanced ? ` · ${c.id} (${((c.statistics?.areaFraction ?? 0) * 100).toFixed(1)}%)` : ''}</option>)}</select></label>
      {selected && <><label>Name (user target) <input aria-label="Name" list={`targets-${job.id}`} maxLength={100} value={selected.label} onChange={(e) => update({ label: e.target.value })} /></label><label><input type="checkbox" checked={selected.selected !== false} onChange={(e) => update({ selected: e.target.checked })} /> Include this object</label></>}
    </div>
    <datalist id={`targets-${job.id}`}>{job.options?.targetLabels?.map(label => <option key={label} value={label} />)}</datalist>
    {candidate && selected && <div aria-label={`Selected ownership for ${candidate.id}`}><MaskCanvas key={candidate.id} sourceId={sourceId} maskId={candidate.maskArtifactId} width={width} height={height} edits={selected} onChange={update} disabled={submitting} /></div>}
    {candidate?.target && <p>Target: {selected?.label} · Provider: SAM 3.1 · {candidate.qualityStatus === 'needs-correction' ? 'Needs correction' : 'Needs visual confirmation'} · Revision {candidate.revisionId || job.revision}</p>}
    {advanced && candidate && <><p><strong>{candidate.id}</strong> · {job.artifacts.find(a => a.artifactId === candidate.overlayArtifactId)?.relativePath || 'Saved candidate'}<br />{candidate.source === 'sam3' ? 'Source-image semantic ownership; generated RGB is not used.' : candidate.source === 'synthesized' ? `Synthesized from ${candidate.sourceCandidateIds?.join(', ')}; Qwen ${candidate.proposalId}. Grouping requires review.` : `Raw source support. Qwen matches: ${candidate.proposalMatches?.map(match => match.proposalId).join(', ') || 'none reliable'}.`}<br />Cyan is selected ownership; the remaining source is context only. Renaming does not expand a mask.</p><a href={artifactUrl(candidate.maskArtifactId)} target="_blank" rel="noreferrer">Inspect actual black/white mask</a></>}
    <div className="decomp-row"><label>Group name <input value={groupLabel} maxLength={100} onChange={e => setGroupLabel(e.target.value)} /></label><button disabled={submitting || objects.filter(o => o.selected).length < 2} onClick={() => send('merge-targets')}>Merge included targets</button><button disabled={submitting || !active} onClick={() => send('split-target')}>Split target</button></div>
    <p>Positive = should belong, including missing regions. Negative = should not belong. Refine with AI runs one targeted attempt and returns a mask for inspection.</p>
    <p>Saved on this object: {selected?.points?.filter(p => p.label === 1).length ?? 0} positive / {selected?.points?.filter(p => p.label === 0).length ?? 0} negative points. {selected?.selected === false ? 'Excluded: these corrections will not be used. Include this object to refine it.' : 'Included in refinement.'}</p>
    {candidate?.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    {submission.error && <p role="alert">{submission.error}</p>}
    <div className="decomp-row"><button disabled={submitting || !objects.some((o) => o.selected)} onClick={() => send('accept-masks')}>{submission.pending ? 'Submitting review…' : 'Confirm ownership and refine edges'}</button><button disabled={submitting || selected?.selected === false || (!selected?.points?.length && !selected?.box)} onClick={() => send('guided-refine')}>Refine with AI</button><button disabled={submitting || !objects.some(o => o.selected)} onClick={() => send('manual-masks')}>Save manual mask (no AI)</button></div>
  </section>;
}
