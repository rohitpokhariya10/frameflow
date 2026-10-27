/**
 * The protected-region editor: the source creative with its protected regions on top, in an SVG whose viewBox is in
 * SOURCE PIXELS. Pointers are mapped through the SVG's own screen transform (getScreenCTM), so what is stored never
 * depends on zoom, CSS scaling, browser zoom or device-pixel ratio. Draw, select, move, resize (8 handles, also rotated),
 * rotate (Shift: 15° steps), delete, nudge with the arrow keys (Shift: 10 px), zoom about the pointer (Ctrl/⌘ + wheel or
 * the buttons), pan (wheel, the Pan tool or Space + drag), snap to the canvas, other regions and whole pixels.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Hand, Maximize, MousePointer2, Scan, SquareDashedMousePointer, ZoomIn, ZoomOut } from 'lucide-react';
import { PROTECTED_KIND_LABELS, type ProtectedKind, type SourceBox, type SourceSize } from '@frameflow/shared';
import type { ElementDraft } from './api';
import { drawnBox, fitView, handlePoint, HANDLES, nudge, panView, resizeBox, rotateTowards, roundBox, snapBox, sourcePerScreen, zoomView, type Handle, type Point, type View } from './regionGeometry';

type Mode = 'select' | 'draw' | 'pan';
type Drag = { kind: 'move'; id: string; start: SourceBox; from: Point } | { kind: 'resize'; id: string; handle: Handle; start: SourceBox } | { kind: 'rotate'; id: string; start: SourceBox }
  | { kind: 'draw'; from: Point } | { kind: 'pan'; from: { x: number; y: number }; view: View };
const CURSORS: Record<Handle, string> = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };

export function RegionEditor({ imageUrl, size, elements, selectedId, onSelect, onChange, onCreate, drawKind, onDrawKind, snap, onSnap, readOnly = false }: {
  imageUrl: string; size: SourceSize; elements: ElementDraft[]; selectedId: string | null; onSelect: (id: string | null) => void;
  onChange: (elements: ElementDraft[]) => void; onCreate: (box: SourceBox, kind: ProtectedKind) => void; drawKind: ProtectedKind; onDrawKind: (kind: ProtectedKind) => void;
  snap: boolean; onSnap: (snap: boolean) => void; readOnly?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null), drag = useRef<Drag | null>(null), space = useRef(false);
  const [mode, setMode] = useState<Mode>('select'), [view, setView] = useState<View>({ x: 0, y: 0, ...size }), [fit, setFit] = useState<View>({ x: 0, y: 0, ...size });
  const [live, setLive] = useState<ElementDraft[] | null>(null), [ghost, setGhost] = useState<SourceBox | null>(null), [screenWidth, setScreenWidth] = useState(800);
  const shown = live ?? elements, sps = sourcePerScreen(view, screenWidth);
  const refit = useCallback(() => {
    const el = svg.current; if (!el || !el.clientWidth || !el.clientHeight) return;
    const next = fitView(size, el.clientWidth / el.clientHeight);
    setScreenWidth(el.clientWidth); setFit(next); setView(next);
  }, [size]);
  useLayoutEffect(() => { refit(); }, [refit]);
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const observer = new ResizeObserver(() => setScreenWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  /** A screen point in source pixels, through the SVG's own transform. */
  const toSource = useCallback((clientX: number, clientY: number): Point => {
    const el = svg.current!, m = el.getScreenCTM(), p = el.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const q = m ? p.matrixTransform(m.inverse()) : p;
    return { x: q.x, y: q.y };
  }, []);
  // Wheel: Ctrl/⌘ zooms about the pointer, otherwise it pans. A native listener, so the page itself does not scroll or zoom.
  useEffect(() => {
    const el = svg.current; if (!el) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) { const at = toSource(event.clientX, event.clientY); setView(v => zoomView(v, Math.exp(-event.deltaY * 0.0015), at, fit)); }
      else setView(v => panView(v, -event.deltaX * sourcePerScreen(v, el.clientWidth), -event.deltaY * sourcePerScreen(v, el.clientWidth)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [toSource, fit]);
  const zoomBy = (factor: number) => setView(v => zoomView(v, factor, { x: v.x + v.width / 2, y: v.y + v.height / 2 }, fit));
  const actual = () => { const el = svg.current; if (!el) return; setView(v => { const width = el.clientWidth, height = el.clientHeight; return { x: v.x + v.width / 2 - width / 2, y: v.y + v.height / 2 - height / 2, width, height }; }); };
  const others = (id: string) => shown.filter(e => e.id !== id).map(e => e.box);
  const replace = (id: string, box: SourceBox) => shown.map(e => e.id === id ? { ...e, box } : e);

  const down = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button === 2) return;
    // Focus for the keyboard, without scrolling: a scroll here would move the canvas under the pointer mid-gesture.
    svg.current?.focus({ preventScroll: true });
    const target = event.target as Element, part = target.getAttribute('data-part'), id = target.closest('[data-element]')?.getAttribute('data-element') ?? null;
    const at = toSource(event.clientX, event.clientY);
    if (mode === 'pan' || space.current || event.button === 1) drag.current = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, view };
    else if (!readOnly && part?.startsWith('handle-') && selectedId) drag.current = { kind: 'resize', id: selectedId, handle: part.slice(7) as Handle, start: shown.find(e => e.id === selectedId)!.box };
    else if (!readOnly && part === 'rotate' && selectedId) drag.current = { kind: 'rotate', id: selectedId, start: shown.find(e => e.id === selectedId)!.box };
    else if (!readOnly && mode === 'draw') { drag.current = { kind: 'draw', from: at }; onSelect(null); }
    else if (id) { onSelect(id); if (!readOnly) drag.current = { kind: 'move', id, start: shown.find(e => e.id === id)!.box, from: at }; }
    else { onSelect(null); drag.current = { kind: 'pan', from: { x: event.clientX, y: event.clientY }, view }; }
    if (drag.current) (event.currentTarget as Element).setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current; if (!d) return;
    if (d.kind === 'pan') { const k = sourcePerScreen(d.view, svg.current?.clientWidth ?? screenWidth); setView(panView(d.view, (event.clientX - d.from.x) * k, (event.clientY - d.from.y) * k)); return; }
    const at = toSource(event.clientX, event.clientY);
    if (d.kind === 'draw') { setGhost(drawnBox(d.from, at)); return; }
    let box = d.kind === 'move' ? { ...d.start, x: d.start.x + at.x - d.from.x, y: d.start.y + at.y - d.from.y }
      : d.kind === 'resize' ? resizeBox(d.start, d.handle, at) : rotateTowards(d.start, at, event.shiftKey);
    if (snap && d.kind === 'move') box = snapBox(box, size, others(d.id), 6 * sps);
    else if (snap && d.kind === 'resize' && !box.rotation) box = roundBox(box);
    setLive(replace(d.id, box));
  };
  const up = () => {
    const d = drag.current; drag.current = null;
    if (d?.kind === 'draw' && ghost) { setGhost(null); if (ghost.width >= 4 && ghost.height >= 4) onCreate(snap ? roundBox(ghost) : ghost, drawKind); return; }
    setGhost(null);
    if (live) { onChange(live); setLive(null); }
  };
  const key = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === ' ') { space.current = event.type === 'keydown'; event.preventDefault(); return; }
    if (event.type !== 'keydown') return;
    const selected = shown.find(e => e.id === selectedId);
    if (event.key === 'Escape') { onSelect(null); return; }
    if (!selected || readOnly) return;
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); onChange(shown.filter(e => e.id !== selected.id)); onSelect(null); return; }
    const next = nudge(selected.box, event.key, event.shiftKey);
    if (next) { event.preventDefault(); onChange(replace(selected.id, next)); }
  };
  const handle = 9 * sps, stroke = 1.5 * sps;
  return <div className="pt-editor">
    <div className="pt-toolbar" role="toolbar" aria-label="Region tools">
      <div className="pt-tool-group" role="group" aria-label="Tool">
        <button type="button" aria-pressed={mode === 'select'} onClick={() => setMode('select')} title="Select and move (V)"><MousePointer2 size={15} aria-hidden="true" />Select</button>
        {!readOnly && <button type="button" aria-pressed={mode === 'draw'} onClick={() => setMode('draw')} title="Draw a protected region"><SquareDashedMousePointer size={15} aria-hidden="true" />Draw region</button>}
        <button type="button" aria-pressed={mode === 'pan'} onClick={() => setMode('pan')} title="Pan (or hold Space)"><Hand size={15} aria-hidden="true" />Pan</button>
      </div>
      {!readOnly && <label className="pt-inline">New region<select aria-label="Kind of new region" value={drawKind} onChange={e => onDrawKind(e.target.value as ProtectedKind)}>
        {(Object.keys(PROTECTED_KIND_LABELS) as ProtectedKind[]).map(k => <option key={k} value={k}>{PROTECTED_KIND_LABELS[k]}</option>)}</select></label>}
      <div className="pt-tool-group" role="group" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.4)}><ZoomOut size={15} aria-hidden="true" /></button>
        <span className="pt-zoom" aria-live="polite">{Math.round(100 * fit.width / view.width)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.4)}><ZoomIn size={15} aria-hidden="true" /></button>
        <button type="button" onClick={() => setView(fit)} title="Fit the whole creative"><Maximize size={15} aria-hidden="true" />Fit</button>
        <button type="button" onClick={actual} title="One source pixel per screen pixel"><Scan size={15} aria-hidden="true" />1:1</button>
      </div>
      <label className="pt-inline"><input type="checkbox" checked={snap} onChange={e => onSnap(e.target.checked)} /> Snap to edges and whole pixels</label>
    </div>
    <svg ref={svg} className={`pt-canvas pt-mode-${mode}`} viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} preserveAspectRatio="xMidYMid meet" tabIndex={0} role="application"
      aria-label={`Protected regions on the ${size.width}×${size.height} source creative`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key} onKeyUp={key}>
      <rect x={0} y={0} width={size.width} height={size.height} className="pt-canvas-bg" />
      <image href={imageUrl} x={0} y={0} width={size.width} height={size.height} preserveAspectRatio="none" style={{ imageRendering: fit.width / view.width > 2 ? 'pixelated' : 'auto' }} />
      {shown.map(e => {
        const b = e.box, cx = b.x + b.width / 2, cy = b.y + b.height / 2, selected = e.id === selectedId;
        return <g key={e.id} data-element={e.id} transform={b.rotation ? `rotate(${b.rotation} ${cx} ${cy})` : undefined} className={`pt-region pt-kind-${e.kind}${selected ? ' is-selected' : ''}${e.review.status === 'approved' ? ' is-reviewed' : ''}`}>
          <rect data-part="body" x={b.x} y={b.y} width={b.width} height={b.height} strokeWidth={stroke} />
          <text x={b.x} y={b.y - 4 * sps} fontSize={12 * sps} className="pt-region-label">{e.label}</text>
        </g>;
      })}
      {(() => {
        const e = shown.find(item => item.id === selectedId); if (!e || readOnly) return null;
        const top = handlePoint(e.box, 'n'), rot = handlePoint(e.box, 'rotate', 26 * sps);
        return <g className="pt-handles">
          <line x1={top.x} y1={top.y} x2={rot.x} y2={rot.y} strokeWidth={stroke} />
          <circle data-part="rotate" cx={rot.x} cy={rot.y} r={handle / 1.6} strokeWidth={stroke} style={{ cursor: 'grab' }}><title>Rotate (Shift: 15° steps)</title></circle>
          {HANDLES.map(h => { const p = handlePoint(e.box, h); return <rect key={h} data-part={`handle-${h}`} x={p.x - handle / 2} y={p.y - handle / 2} width={handle} height={handle} strokeWidth={stroke}
            transform={e.box.rotation ? `rotate(${e.box.rotation} ${p.x} ${p.y})` : undefined} style={{ cursor: CURSORS[h] }} />; })}
        </g>;
      })()}
      {ghost && <rect className="pt-ghost" x={ghost.x} y={ghost.y} width={ghost.width} height={ghost.height} strokeWidth={stroke} />}
    </svg>
    <p className="pt-help">Coordinates are source pixels of the {size.width}×{size.height} creative, whatever the zoom. Arrow keys move the selected region by 1 px (Shift: 10 px); Delete removes it.</p>
  </div>;
}
