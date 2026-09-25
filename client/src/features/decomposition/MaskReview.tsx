import { useRef, useState } from 'react';
import type { DecompositionJobSummary, DecompositionPoint, DecompositionReview, DecompositionStroke } from '@frameflow/shared';
import { artifactUrl } from './api';
import { nativePointer } from './geometry';

export interface ReviewCandidate { id: string; label: string; maskArtifactId: string; selected?: boolean; warnings: string[] }
export function MaskReview({ job, candidates, sourceId, width, height, onSubmit, busy }: {
  job: DecompositionJobSummary; candidates: ReviewCandidate[]; sourceId: string; width: number; height: number;
  onSubmit: (review: DecompositionReview) => void; busy: boolean;
}) {
  const [active, setActive] = useState(candidates[0]?.id || '');
  const [objects, setObjects] = useState(() => candidates.map((c) => ({ id: c.id, candidateId: c.id, label: c.label, selected: c.selected ?? true, points: [] as DecompositionPoint[], strokes: [] as DecompositionStroke[], completeHidden: false })));
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
    <div className="decomp-row"><label>Object <select value={active} onChange={(e) => setActive(e.target.value)}>{candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
      {selected && <><label>Name <input maxLength={100} value={selected.label} onChange={(e) => update({ label: e.target.value })} /></label><label><input type="checkbox" checked={selected.selected} onChange={(e) => update({ selected: e.target.checked })} /> Include this object</label></>}
    </div>
    <div className="decomp-row"><label>Correction <select value={tool} onChange={(e) => setTool(e.target.value as typeof tool)}><option value="positive">Positive point</option><option value="negative">Negative point</option><option value="add">Add brush</option><option value="subtract">Subtract brush</option><option value="box">Bounding box</option></select></label>
      <label>Brush radius (source pixels) <input type="number" min={1} max={256} value={radius} onChange={(e) => setRadius(Math.max(1, Math.min(256, Number(e.target.value))))} /></label>
      <button onClick={() => update({ points: [], strokes: [] })}>Clear corrections</button>
    </div>
    <div className="decomp-review-image" style={{ aspectRatio: `${width}/${height}`, touchAction: 'none' }} onPointerDown={(e) => {
      const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height); if (!point || !selected) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (tool === 'positive' || tool === 'negative') { update({ points: [...selected.points, { ...point, label: tool === 'positive' ? 1 as const : 0 as const }].slice(-64) }); return; }
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
      } else if (tool === 'add' || tool === 'subtract') update({ strokes: [...selected.strokes, { mode: tool, radius, points: stroke.current }].slice(-100) });
      stroke.current = null;
    }}>
      <img draggable={false} src={artifactUrl(sourceId)} alt="Source image for mask correction" />
      {candidate && <img draggable={false} className="decomp-mask-overlay" src={artifactUrl(candidate.maskArtifactId)} alt="Selected mask overlay" />}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">{selected?.points.map((p, index) => <circle key={`p${index}`} cx={p.x} cy={p.y} r={Math.max(width / 100, 3)} fill={p.label ? '#19e993' : '#ff4160'} />)}{selected?.strokes.map((s, i) => <polyline key={`s${i}`} points={s.points.map((p) => `${p.x},${p.y}`).join(' ')} fill="none" stroke={s.mode === 'add' ? '#19e993' : '#ff4160'} strokeWidth={s.radius * 2} strokeLinecap="round" strokeLinejoin="round" opacity={0.6} />)}</svg>
    </div>
    {candidate?.warnings.map((warning, i) => <p key={i}>{warning}</p>)}
    <div className="decomp-row"><button disabled={busy || !objects.some((o) => o.selected)} onClick={() => send('accept-masks')}>Confirm visible masks</button><button disabled={busy || !selected?.points.length} onClick={() => send('guided-refine')}>Refine with guidance</button></div>
  </section>;
}
