import { useRef, useState } from 'react';
import type { DecompositionBox, DecompositionPoint, DecompositionStroke } from '@frameflow/shared';
import { artifactUrl } from './api';
import { nativePointer } from './geometry';
export type MaskEdits = { points?: DecompositionPoint[]; strokes?: DecompositionStroke[]; box?: DecompositionBox };
/** All draft geometry is canonical source pixels; no images or canvas objects enter Redux. */
export function MaskCanvas({ sourceId, maskId, width, height, edits, onChange, disabled = false }: {
  sourceId: string; maskId?: string; width: number; height: number; edits: MaskEdits; onChange: (edits: MaskEdits) => void; disabled?: boolean;
}) {
  const [tool, setTool] = useState<'positive' | 'negative' | 'add' | 'subtract' | 'box'>('positive');
  const [radius, setRadius] = useState(10);
  const [pending, setPending] = useState<{ x: number; y: number }[]>([]);
  const stroke = useRef<{ x: number; y: number }[] | null>(null);
  const drawStroke = (s: DecompositionStroke, key: string) => <g key={key} opacity={0.6}><polyline points={s.points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={s.mode === 'add' ? '#19e993' : '#ff4160'} strokeWidth={s.radius * 2} strokeLinecap="round" strokeLinejoin="round" />{s.points.length === 1 && <circle cx={s.points[0].x} cy={s.points[0].y} r={s.radius} fill={s.mode === 'add' ? '#19e993' : '#ff4160'} />}</g>;
  return <>
    <div className="decomp-row"><label>Correction <select disabled={disabled} value={tool} onChange={e => setTool(e.target.value as typeof tool)}><option value="positive">Positive point</option><option value="negative">Negative point</option><option value="add">Add brush</option><option value="subtract">Subtract brush</option><option value="box">Bounding box</option></select></label><label>Brush radius (source pixels) <input disabled={disabled} type="number" min={1} max={256} value={radius} onChange={e => setRadius(Math.max(1, Math.min(256, Number(e.target.value))))} /></label><button disabled={disabled} onClick={() => onChange({ points: [], strokes: [], box: undefined })}>Clear corrections</button></div>
    <div className="decomp-review-image" style={{ width: `min(100%, ${65 * width / height}vh)`, aspectRatio: `${width}/${height}`, touchAction: 'none' }} onPointerDown={e => {
      if (disabled) return;
      const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height); if (!point) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      if (tool === 'positive' || tool === 'negative') { onChange({ ...edits, points: [...(edits.points ?? []), { ...point, label: tool === 'positive' ? 1 as const : 0 as const }].slice(-64) }); return; }
      stroke.current = [point]; setPending([point]);
    }} onPointerMove={e => {
      if (!stroke.current || disabled) return;
      const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height);
      if (point && stroke.current.length < 1000) { stroke.current.push(point); setPending([...stroke.current]); }
    }} onPointerUp={() => {
      if (!stroke.current) return;
      if (tool === 'box') { const first = stroke.current[0], last = stroke.current.at(-1)!; onChange({ ...edits, box: { x: Math.min(first.x, last.x), y: Math.min(first.y, last.y), width: Math.max(1, Math.abs(first.x - last.x)), height: Math.max(1, Math.abs(first.y - last.y)) } }); }
      else if (tool === 'add' || tool === 'subtract') onChange({ ...edits, strokes: [...(edits.strokes ?? []), { mode: tool, radius, points: stroke.current }].slice(-100) });
      stroke.current = null; setPending([]);
    }} onPointerCancel={() => { stroke.current = null; setPending([]); }}>
      <img draggable={false} src={artifactUrl(sourceId)} alt="Original image for source pixel correction" />
      {maskId && <div className="decomp-mask-overlay" role="img" aria-label="Selected ownership mask" style={{ maskImage: `url("${artifactUrl(maskId)}")` }} />}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">{edits.points?.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(width / 100, 3)} fill={p.label ? '#19e993' : '#ff4160'} />)}{edits.strokes?.map((s, i) => drawStroke(s, String(i)))}{pending.length > 0 && tool !== 'box' && drawStroke({ mode: tool === 'subtract' ? 'subtract' : 'add', radius, points: pending }, 'pending')}{edits.box && <rect {...{ x: edits.box.x, y: edits.box.y, width: edits.box.width, height: edits.box.height }} fill="none" stroke="#19e993" strokeWidth={Math.max(2, width / 400)} />}</svg>
    </div>
    <p>Saved on this target: {edits.points?.filter(p => p.label === 1).length ?? 0} positive / {edits.points?.filter(p => p.label === 0).length ?? 0} negative points. Green adds; red removes. Save to inspect the resulting mask.</p>
  </>;
}
