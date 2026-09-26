import { useEffect, useRef, useState } from 'react';
import type { DecompositionJobSummary, DecompositionReview } from '@frameflow/shared';
import { validDecompositionReview } from '@frameflow/shared';
import { artifactUrl } from './api';
import { nativePointer } from './geometry';

export type ReviewCandidate = NonNullable<DecompositionJobSummary['candidates']>[number];
export function MaskReview({ job, candidates, sourceId, width, height, onSubmit, busy }: {
  job: DecompositionJobSummary; candidates: ReviewCandidate[]; sourceId: string; width: number; height: number;
  onSubmit: (review: DecompositionReview) => void; busy: boolean;
}) {
  const [active, setActive] = useState(candidates[0]?.id || '');
  const draftKey = `frameflow:mask-review:${job.id}:${job.revision}`;
  const [objects, setObjects] = useState<NonNullable<DecompositionReview['objects']>>(() => {
    let saved = job.reviewSubmission;
    try {
      const draft: unknown = JSON.parse(sessionStorage.getItem(draftKey) || 'null');
      if (validDecompositionReview(draft, width, height) && draft.expectedRevision === job.revision) saved = draft;
    } catch { /* Browser storage is optional; server-accepted corrections still recover. */ }
    return candidates.map(c => ({ id: c.id, candidateId: c.id, label: c.label, selected: c.selected ?? true, points: [], strokes: [], completeHidden: false, ...saved?.objects?.find(object => object.id === c.id && (object.candidateId ?? object.id) === c.id) }));
  });
  useEffect(() => {
    try { sessionStorage.setItem(draftKey, JSON.stringify({ expectedRevision: job.revision, action: 'accept-masks', objects })); } catch { /* Keep editing in memory when storage is unavailable. */ }
  }, [draftKey, job.revision, objects]);
  const [tool, setTool] = useState<'positive' | 'negative' | 'add' | 'subtract' | 'box'>('positive');
  const [radius, setRadius] = useState(10);
  const stroke = useRef<{ x: number; y: number }[] | null>(null);
  const selected = objects.find((object) => object.id === active);
  const candidate = candidates.find((object) => object.id === active);
  const update = (change: Partial<(typeof objects)[number]>) => setObjects((all) => all.map((object) => object.id === active ? { ...object, ...change } : object));
  const send = (action: DecompositionReview['action']) => onSubmit({ expectedRevision: job.revision, action, objects });
  return <section aria-label="Mask review">
    <h3>Review masks</h3><p>{job.review?.message}</p>
    <p>Check each object, especially fingers and faces near a board. Paint only pixels visible in the source. Labels and points guide one further segmentation attempt.</p>
    <div className="decomp-row"><label>Object <select value={active} onChange={(e) => setActive(e.target.value)}>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label} — {c.id} ({((c.statistics?.areaFraction ?? 0) * 100).toFixed(1)}% of image)</option>)}</select></label>
      {selected && <><label>Name <input maxLength={100} value={selected.label} onChange={(e) => update({ label: e.target.value })} /></label><label><input type="checkbox" checked={selected.selected !== false} onChange={(e) => update({ selected: e.target.checked })} /> Include this object</label></>}
    </div>
    <div className="decomp-row"><label>Correction <select value={tool} onChange={(e) => setTool(e.target.value as typeof tool)}><option value="positive">Positive point</option><option value="negative">Negative point</option><option value="add">Add brush</option><option value="subtract">Subtract brush</option><option value="box">Bounding box</option></select></label>
      <label>Brush radius (source pixels) <input type="number" min={1} max={256} value={radius} onChange={(e) => setRadius(Math.max(1, Math.min(256, Number(e.target.value))))} /></label>
      <button onClick={() => update({ points: [], strokes: [], box: undefined })}>Clear corrections</button>
    </div>
    <div className="decomp-review-image" style={{ width: `min(100%, ${65 * width / height}vh)`, aspectRatio: `${width}/${height}`, touchAction: 'none' }} onPointerDown={(e) => {
      const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height); if (!point || !selected) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (tool === 'positive' || tool === 'negative') { update({ points: [...(selected.points ?? []), { ...point, label: tool === 'positive' ? 1 as const : 0 as const }].slice(-64) }); return; }
      stroke.current = [point];
    }} onPointerMove={(e) => {
      if (!stroke.current) return;
      const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height);
      if (point && stroke.current.length < 1000) stroke.current.push(point);
    }} onPointerUp={() => {
      if (!stroke.current || !selected) return;
      if (tool === 'box') {
        const first = stroke.current[0], last = stroke.current.at(-1)!;
        setObjects((all) => all.map((object) => object.id === active ? { ...object, box: { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: Math.max(1, Math.abs(last.x - first.x)), height: Math.max(1, Math.abs(last.y - first.y)) } } : object));
      } else if (tool === 'add' || tool === 'subtract') update({ strokes: [...(selected.strokes ?? []), { mode: tool, radius, points: stroke.current }].slice(-100) });
      stroke.current = null;
    }}>
      <img draggable={false} src={artifactUrl(sourceId)} alt="Source image for mask correction" />
      {candidate && <div className="decomp-mask-overlay" role="img" aria-label={`Selected ownership for ${candidate.id}`} style={{ maskImage: `url("${artifactUrl(candidate.maskArtifactId)}")` }} />}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">{selected?.points?.map((p, index) => <circle key={`p${index}`} cx={p.x} cy={p.y} r={Math.max(width / 100, 3)} fill={p.label ? '#19e993' : '#ff4160'} />)}{selected?.strokes?.map((s, i) => <polyline key={`s${i}`} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={s.mode === 'add' ? '#19e993' : '#ff4160'} strokeWidth={s.radius * 2} strokeLinecap="round" strokeLinejoin="round" opacity={0.6} />)}</svg>
    </div>
    {candidate && <><p><strong>{candidate.id}</strong> · {job.artifacts.find(a => a.artifactId === candidate.overlayArtifactId)?.relativePath || 'Saved candidate'}<br />Cyan is selected ownership; the remaining source is context only. Renaming does not expand a mask.</p><a href={artifactUrl(candidate.maskArtifactId)} target="_blank" rel="noreferrer">Inspect actual black/white mask</a></>}
    <p>Saved on this object: {selected?.points?.filter(p => p.label === 1).length ?? 0} positive / {selected?.points?.filter(p => p.label === 0).length ?? 0} negative points. {selected?.selected === false ? 'Excluded: these corrections will not be used. Include this object to refine it.' : 'Included in refinement.'}</p>
    {candidate?.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    <div className="decomp-row"><button disabled={busy || !objects.some((o) => o.selected)} onClick={() => send('accept-masks')}>Confirm visible masks</button><button disabled={busy || selected?.selected === false || !selected?.points?.length} onClick={() => send('guided-refine')}>Refine with guidance</button></div>
  </section>;
}
