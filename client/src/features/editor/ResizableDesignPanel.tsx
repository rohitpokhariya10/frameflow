import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { DesignPanel } from './DesignPanel';
import './resizablePanel.css';

const STORAGE_KEY = 'frameflow:left-panel-width';
const MIN_WIDTH = 224;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 248;
const clamp = (width: number, max = MAX_WIDTH) => Math.max(MIN_WIDTH, Math.min(max, Math.round(width)));

function readWidth() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    const width = stored === null ? DEFAULT_WIDTH : Number(stored);
    return Number.isFinite(width) && stored !== '' ? clamp(width) : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

/** A local UI preference; resizing never changes the design or its undo history. */
export function ResizableDesignPanel({ onNewDesign }: { onNewDesign: () => void }) {
  const [preferred, setPreferred] = useState(readWidth);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; width: number; before: number; current: number } | null>(null);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const rightWidth = viewport <= 1050 ? 0 : viewport <= 1180 ? 232 : 280;
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, viewport - rightWidth - 360));
  const width = clamp(preferred, max);
  function save(value: number) {
    setPreferred(value);
    try { localStorage.setItem(STORAGE_KEY, String(value)); } catch { /* The current session can still resize. */ }
  }
  function cancel() {
    if (drag.current) setPreferred(drag.current.before);
    drag.current = null;
    setResizing(false);
  }
  return <div className={`resizable-design-panel${resizing ? ' left-panel-resizing' : ''}`} style={{ '--left-panel-width': `${width}px` } as CSSProperties}>
    <DesignPanel onNewDesign={onNewDesign} />
    <div className="left-panel-resizer" role="separator" aria-label="Resize design tools" aria-orientation="vertical"
      aria-controls="design-tools" aria-valuemin={MIN_WIDTH} aria-valuemax={max} aria-valuenow={width}
      aria-valuetext={`${width} pixels`} tabIndex={0} title="Drag to resize. Arrow keys adjust width; Home and End set the limits."
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, x: event.clientX, width, before: preferred, current: width };
        setResizing(true);
      }}
      onPointerMove={event => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        const next = clamp(drag.current.width + event.clientX - drag.current.x, max);
        drag.current.current = next;
        setPreferred(next);
      }}
      onPointerUp={event => {
        if (!drag.current || event.pointerId !== drag.current.pointerId) return;
        save(drag.current.current);
        drag.current = null;
        setResizing(false);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={cancel} onLostPointerCapture={cancel}
      onDoubleClick={() => save(DEFAULT_WIDTH)}
      onKeyDown={event => {
        if (event.key === 'Escape' && drag.current) { event.preventDefault(); cancel(); return; }
        const step = event.shiftKey ? 50 : 10;
        const next = event.key === 'ArrowLeft' ? width - step : event.key === 'ArrowRight' ? width + step
          : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? max : undefined;
        if (next === undefined || drag.current) return;
        event.preventDefault();
        save(clamp(next, max));
      }} />
  </div>;
}
