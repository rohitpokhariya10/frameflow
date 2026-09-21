import { useLayoutEffect, useRef } from 'react';
import { Layer, Rect, Stage } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Rect';
import { Image, Maximize, Minus, Plus, Sparkles, Type } from 'lucide-react';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { fitRequested, tabChanged, zoomChanged } from '../../store/uiSlice';
import { calculateFitZoom, VIEWPORT } from './viewport';
import { TextElementNode } from './TextElementNode';
import { focusCanvas, useTextActions } from '../text/useTextActions';

export function CanvasWorkspace() {
  const dispatch = useAppDispatch();
  const { canvas, name, elements, id } = useAppSelector(selectActiveVariant);
  const { zoom, fitRequest, selectedElementId } = useAppSelector((state) => state.ui);
  const actions = useTextActions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const displayWidth = canvas.width * zoom;
  const displayHeight = canvas.height * zoom;
  const showEmptyState = elements.length === 0 && displayWidth >= 220 && displayHeight >= 230;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fit = () => dispatch(zoomChanged(calculateFitZoom(canvas, { width: viewport.clientWidth, height: viewport.clientHeight })));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [canvas, dispatch, fitRequest]);

  return (
    <main className="canvas-workspace" aria-label="Canvas workspace" id="canvas-interaction" tabIndex={0} data-selection-owner>
      <div className="workspace-heading"><span>{name}<span className="workspace-heading-separator">/</span><span className="muted">{elements.length ? `${elements.length} text ${elements.length === 1 ? 'element' : 'elements'}` : 'Blank canvas'}</span></span><span className="workspace-unit">{canvas.width} × {canvas.height} px</span></div>
      <div className="canvas-viewport" ref={viewportRef} data-testid="canvas-viewport" onMouseDown={(event) => { if (event.target === event.currentTarget) { actions.select(null); focusCanvas(); } }}>
        <div className="canvas-scroll-content" onMouseDown={(event) => { if (event.target === event.currentTarget) { actions.select(null); focusCanvas(); } }}>
          <div className="canvas-frame" data-testid="canvas-frame" data-logical-width={canvas.width} data-logical-height={canvas.height}
            style={{ width: displayWidth, height: displayHeight }}>
            <div role="img" aria-label={`${canvas.width} by ${canvas.height} pixel canvas, ${elements.length} text elements. Use the Text panel to select and edit.`}>
              <Stage width={displayWidth} height={displayHeight} scaleX={zoom} scaleY={zoom}
                onMouseDown={(event) => { if (event.target === event.target.getStage()) { actions.select(null); focusCanvas(); } }}
                onTouchStart={(event) => { if (event.target === event.target.getStage()) { actions.select(null); focusCanvas(); } }}>
                <Layer listening={false}><Rect width={canvas.width} height={canvas.height} fill={canvas.backgroundColor} /></Layer>
                <Layer>{elements.map((element) => <TextElementNode key={element.id} element={element} selected={selectedElementId === element.id} canvas={canvas} variantId={id} zoom={zoom} />)}</Layer>
              </Stage>
            </div>
            {showEmptyState && <div className={`canvas-empty ${displayWidth < 310 || displayHeight < 350 ? 'canvas-empty-compact' : ''}`}>
              <span className="empty-art" aria-hidden="true"><span /><span /><Plus size={18} strokeWidth={1} /></span>
              <span className="eyebrow">A FRESH START</span>
              <h1>Something good<br />starts here.</h1>
              <p>A blank canvas for your next idea.</p>
              <div className="empty-actions">
                <button className="button empty-primary" onClick={() => actions.add('heading')}><Type size={15} />Add heading</button>
                <span className="action-hint">Make your first words count</span>
                <button className="button empty-secondary" onClick={() => dispatch(tabChanged('ai'))}><Sparkles size={14} />Create with AI<span className="soon-tag">Soon</span></button>
                <button className="example-button" disabled title="Editable example is coming in Milestone 7"><Image size={14} />Open wedding example</button>
                <span className="action-hint">Example coming in a later update</span>
              </div>
            </div>}
          </div>
        </div>
      </div>
      <div className="workspace-footer"><span className="workspace-caption">ROOM TO CREATE</span>
        <div className="zoom-controls" aria-label="Canvas zoom">
          <button aria-label="Zoom out" disabled={zoom <= VIEWPORT.minZoom} onClick={() => dispatch(zoomChanged(zoom / VIEWPORT.zoomStep))}><Minus size={15} /></button>
          <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
          <button aria-label="Zoom in" disabled={zoom >= VIEWPORT.maxZoom} onClick={() => dispatch(zoomChanged(zoom * VIEWPORT.zoomStep))}><Plus size={15} /></button>
          <span className="zoom-divider" /><button className="fit-button" onClick={() => dispatch(fitRequested())}><Maximize size={14} />Fit</button>
        </div>
        <span className="workspace-footer-label">Frame 01</span>
      </div>
    </main>
  );
}
