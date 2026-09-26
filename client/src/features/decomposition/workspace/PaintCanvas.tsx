import { useRef, useState } from 'react';
import { Brush, Eraser, Crosshair, Undo2, Trash2, Square } from 'lucide-react';
import type { DecompositionBox, DecompositionPoint, DecompositionStroke } from '@frameflow/shared';
import { artifactUrl } from '../api';
import { nativePointer } from '../geometry';

export type PaintEdits = { points?: DecompositionPoint[]; strokes?: DecompositionStroke[]; box?: DecompositionBox };
type Tool = 'add' | 'remove' | 'include' | 'exclude' | 'box';
const TOOL_HELP: Record<Tool, string> = {
  add: 'Paint over parts that should be included.',
  remove: 'Paint over areas that should not be included.',
  include: 'Click a spot that belongs to the object.',
  exclude: 'Click a spot that does not belong to the object.',
  box: 'Drag a box around the whole object.',
};

/**
 * Brush-first correction canvas in source pixels. "Add area" / "Remove area" paint strokes; optional precise tools
 * (click hints and a box) sit behind "More tools". Overlay: a tinted selection, or a cut-out preview.
 */
export function PaintCanvas({ sourceId, width, height, maskId, overlay = 'tint', edits, onChange, disabled = false, label }: {
  sourceId: string; width: number; height: number; maskId?: string; overlay?: 'tint' | 'cutout' | 'none';
  edits: PaintEdits; onChange: (edits: PaintEdits) => void; disabled?: boolean; label: string;
}) {
  const [tool, setTool] = useState<Tool>('add');
  const [radius, setRadius] = useState(() => Math.max(4, Math.round(Math.max(width, height) * 0.012)));
  const [showSelection, setShowSelection] = useState(true);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [pending, setPending] = useState<{ x: number; y: number }[]>([]);
  const stroke = useRef<{ x: number; y: number }[] | null>(null);
  const strokes = edits.strokes ?? [], points = edits.points ?? [];
  const undo = () => {
    // Undo the most recent correction of any kind (strokes and hints are recorded in order of their arrays' tails).
    if (strokes.length) onChange({ ...edits, strokes: strokes.slice(0, -1) });
    else if (points.length) onChange({ ...edits, points: points.slice(0, -1) });
    else if (edits.box) onChange({ ...edits, box: undefined });
  };
  const dirty = strokes.length + points.length + (edits.box ? 1 : 0);
  const draw = (s: DecompositionStroke, key: string) => <g key={key} opacity={0.55}>
    <polyline points={s.points.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={s.mode === 'add' ? '#18c37e' : '#f0445a'} strokeWidth={s.radius * 2} strokeLinecap="round" strokeLinejoin="round" />
    {s.points.length === 1 && <circle cx={s.points[0].x} cy={s.points[0].y} r={s.radius} fill={s.mode === 'add' ? '#18c37e' : '#f0445a'} />}</g>;
  const toolButton = (value: Tool, text: string, icon: React.ReactNode) =>
    <button type="button" className={`ws-tool ${tool === value ? 'is-active' : ''}`} aria-pressed={tool === value} title={TOOL_HELP[value]} disabled={disabled} onClick={() => setTool(value)}>{icon}<span>{text}</span></button>;
  return <div className="paint">
    <div className="paint-toolbar" role="toolbar" aria-label="Selection tools">
      {toolButton('add', 'Add area', <Brush size={15} />)}
      {toolButton('remove', 'Remove area', <Eraser size={15} />)}
      <label className="paint-size">Brush<input type="range" aria-label="Brush size" min={2} max={Math.max(40, Math.round(Math.max(width, height) * 0.06))} value={radius} disabled={disabled} onChange={e => setRadius(Number(e.target.value))} /></label>
      <span className="paint-spacer" />
      <button type="button" className="ws-icon-button" aria-label="Undo last correction" title="Undo last correction" disabled={disabled || !dirty} onClick={undo}><Undo2 size={15} /></button>
      <button type="button" className="ws-icon-button" aria-label="Clear corrections" title="Clear corrections" disabled={disabled || !dirty} onClick={() => onChange({ points: [], strokes: [], box: undefined })}><Trash2 size={15} /></button>
      <label className="paint-toggle"><input type="checkbox" checked={showSelection} onChange={e => setShowSelection(e.target.checked)} /> Show selection</label>
      <button type="button" className="ws-link" aria-expanded={more} onClick={() => { setMore(!more); if (more && ['include', 'exclude', 'box'].includes(tool)) setTool('add'); }}>{more ? 'Fewer tools' : 'More tools'}</button>
    </div>
    {more && <div className="paint-toolbar paint-toolbar-secondary" role="toolbar" aria-label="Precise tools">
      {toolButton('include', 'Include spot', <Crosshair size={15} />)}
      {toolButton('exclude', 'Exclude spot', <Crosshair size={15} />)}
      {toolButton('box', 'Object box', <Square size={15} />)}
    </div>}
    <p className="paint-help" aria-live="polite">{TOOL_HELP[tool]}</p>
    <div className="paint-stage" aria-label={label} role="application" style={{ aspectRatio: `${width} / ${height}`, width: `min(100%, calc((100vh - var(--ws-chrome, 330px)) * ${width / height}))`, cursor: disabled ? 'not-allowed' : 'none' }}
      onPointerDown={e => {
        if (disabled) return;
        const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height); if (!point) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        if (tool === 'include' || tool === 'exclude') { onChange({ ...edits, points: [...points, { ...point, label: tool === 'include' ? 1 as const : 0 as const }].slice(-64) }); return; }
        stroke.current = [point]; setPending([point]);
      }}
      onPointerMove={e => {
        const point = nativePointer(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height);
        setCursor(point);
        if (!stroke.current || disabled || !point || stroke.current.length >= 1000) return;
        stroke.current.push(point); setPending([...stroke.current]);
      }}
      onPointerLeave={() => setCursor(null)}
      onPointerUp={() => {
        if (!stroke.current) return;
        if (tool === 'box') { const a = stroke.current[0], b = stroke.current.at(-1)!; onChange({ ...edits, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(1, Math.abs(a.x - b.x)), height: Math.max(1, Math.abs(a.y - b.y)) } }); }
        else onChange({ ...edits, strokes: [...strokes, { mode: tool === 'remove' ? 'subtract' as const : 'add' as const, radius, points: stroke.current }].slice(-100) });
        stroke.current = null; setPending([]);
      }}
      onPointerCancel={() => { stroke.current = null; setPending([]); }}>
      {overlay === 'cutout' && maskId && showSelection
        ? <img className="paint-cutout" draggable={false} src={artifactUrl(sourceId)} alt="" style={{ maskImage: `url("${artifactUrl(maskId)}")`, WebkitMaskImage: `url("${artifactUrl(maskId)}")` }} />
        : <img draggable={false} src={artifactUrl(sourceId)} alt="" />}
      {overlay === 'tint' && maskId && showSelection && <div className="paint-overlay" role="img" aria-label="Current selection" style={{ maskImage: `url("${artifactUrl(maskId)}")`, WebkitMaskImage: `url("${artifactUrl(maskId)}")` }} />}
      <svg viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        {strokes.map((s, i) => draw(s, String(i)))}
        {pending.length > 0 && tool !== 'box' && draw({ mode: tool === 'remove' ? 'subtract' : 'add', radius, points: pending }, 'pending')}
        {points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={Math.max(width / 120, 4)} fill={p.label ? '#18c37e' : '#f0445a'} stroke="#fff" strokeWidth={Math.max(width / 600, 1.5)} />)}
        {edits.box && <rect x={edits.box.x} y={edits.box.y} width={edits.box.width} height={edits.box.height} fill="none" stroke="#18c37e" strokeWidth={Math.max(2, width / 400)} strokeDasharray={`${width / 80} ${width / 120}`} />}
        {pending.length > 1 && tool === 'box' && <rect x={Math.min(pending[0].x, pending.at(-1)!.x)} y={Math.min(pending[0].y, pending.at(-1)!.y)} width={Math.abs(pending[0].x - pending.at(-1)!.x)} height={Math.abs(pending[0].y - pending.at(-1)!.y)} fill="none" stroke="#18c37e" strokeWidth={Math.max(2, width / 400)} />}
        {cursor && !disabled && (tool === 'add' || tool === 'remove') && <circle className="paint-cursor" cx={cursor.x} cy={cursor.y} r={radius} fill="none" stroke={tool === 'add' ? '#18c37e' : '#f0445a'} strokeWidth={Math.max(1.5, width / 700)} />}
        {cursor && !disabled && !(tool === 'add' || tool === 'remove') && <circle cx={cursor.x} cy={cursor.y} r={Math.max(width / 200, 3)} fill="#fff" stroke="#1f2925" strokeWidth={Math.max(1, width / 900)} />}
      </svg>
    </div>
  </div>;
}

/** Brush strokes as hints for an AI refinement request: add → include points, remove → exclude points. */
export function strokeHints(edits: PaintEdits): DecompositionPoint[] {
  const hints: DecompositionPoint[] = [...(edits.points ?? [])];
  for (const stroke of edits.strokes ?? []) {
    const step = Math.max(1, Math.floor(stroke.points.length / 4));
    for (let i = 0; i < stroke.points.length; i += step) hints.push({ x: Math.floor(stroke.points[i].x), y: Math.floor(stroke.points[i].y), label: stroke.mode === 'add' ? 1 : 0 });
  }
  return hints.slice(-64);
}
