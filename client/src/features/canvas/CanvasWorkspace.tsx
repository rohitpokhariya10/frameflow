import { useLayoutEffect, useRef, useState } from 'react';
import { Layer, Rect, Stage, Text } from 'react-konva/lib/ReactKonvaCore';
import 'konva/lib/shapes/Rect';
import { Image, Maximize, Minus, Plus, Sparkles, Type } from 'lucide-react';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { fitRequested, tabChanged, zoomChanged, variantSelected } from '../../store/uiSlice';
import { calculateFitZoom, VIEWPORT } from './viewport';
import { TextElementNode } from './TextElementNode';
import { focusCanvas, useTextActions } from '../text/useTextActions';
import { BackgroundArtwork } from './BackgroundArtwork';
import { textNodeStyle } from '../text/textGeometry';

import { VariantComparison } from '../variants/VariantComparison';

export function CanvasWorkspace() {
  const dispatch = useAppDispatch();
  const variants = useAppSelector((state) => state.editor.document.variants);
  const [compare, setCompare] = useState(false);
  const current = useAppSelector(selectActiveVariant);
  const preview = useAppSelector((state) => state.ui.activeLeftTab === 'ai' ? state.ai.preview : null);
  const relative = current.sourceVariantId ? variants.find((item) => item.id === current.sourceVariantId) : variants.find((item) => item.sourceVariantId === current.id);
  const pair = preview?.adaptation ? { source: preview.adaptation.source, target: preview.variant }
    : compare && !preview && relative ? current.sourceVariantId ? { source: relative, target: current } : { source: current, target: relative } : null;
  const comparing = Boolean(pair);
  const { canvas, name, elements, id, background } = preview?.variant ?? current;
  const [artworkError, setArtworkError] = useState('');
  const { zoom, fitRequest, selectedElementId } = useAppSelector((state) => state.ui);
  const actions = useTextActions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const displayWidth = canvas.width * zoom;
  const displayHeight = canvas.height * zoom;
  const showEmptyState = !background && !preview && elements.length === 0 && displayWidth >= 220 && displayHeight >= 230;

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const fit = () => dispatch(zoomChanged(calculateFitZoom(canvas, { width: viewport.clientWidth, height: viewport.clientHeight })));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [canvas, dispatch, fitRequest, comparing]);

  return (
    <main className="canvas-workspace" aria-label="Canvas workspace" id="canvas-interaction" tabIndex={0} data-selection-owner>
      <div className="workspace-heading"><span>{preview ? preview.adaptation ? 'Adapted preview' : 'Generated preview' : name}<span className="workspace-heading-separator">/</span><span className="muted">{preview ? 'Apply from the AI panel' : elements.length ? `${elements.length} text ${elements.length === 1 ? 'element' : 'elements'}` : background ? 'Artwork' : 'Blank canvas'}</span></span><span className="workspace-unit">{canvas.width} × {canvas.height} px</span></div>
      {variants.length > 1 && <div className="variant-switcher"><label>Version<select aria-label="Active version" value={current.id} onChange={(event) => { dispatch(variantSelected(event.target.value)); setCompare(false); }}>{variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.name} · {variant.canvas.width} × {variant.canvas.height}</option>)}</select></label>{relative && !preview && <button className="button" aria-pressed={compare} onClick={() => setCompare(!compare)}>{compare ? 'Back to editing' : 'Compare versions'}</button>}</div>}
      {background && artworkError && <div className="artwork-error" role="alert">{artworkError}</div>}
      {pair ? <VariantComparison source={pair.source} target={pair.target} /> : <div className="canvas-viewport" ref={viewportRef} data-testid="canvas-viewport" onMouseDown={(event) => { if (event.target === event.currentTarget) { actions.select(null); focusCanvas(); } }}>
        <div className="canvas-scroll-content" onMouseDown={(event) => { if (event.target === event.currentTarget) { actions.select(null); focusCanvas(); } }}>
          <div className="canvas-frame" data-testid="canvas-frame" data-logical-width={canvas.width} data-logical-height={canvas.height}
            style={{ width: displayWidth, height: displayHeight }}>
            <div role="img" aria-label={`${canvas.width} by ${canvas.height} pixel canvas, ${elements.length} text elements. Use the Text panel to select and edit.`}>
              <Stage width={displayWidth} height={displayHeight} scaleX={zoom} scaleY={zoom}
                onMouseDown={(event) => { if (event.target === event.target.getStage()) { actions.select(null); focusCanvas(); } }}
                onTouchStart={(event) => { if (event.target === event.target.getStage()) { actions.select(null); focusCanvas(); } }}>
                <Layer listening={false} clipWidth={canvas.width} clipHeight={canvas.height}><Rect width={canvas.width} height={canvas.height} fill={canvas.backgroundColor} />
                  {background && <BackgroundArtwork background={background} canvas={canvas} onError={setArtworkError} />}
                </Layer>
                <Layer>{elements.map((element) => preview
                  ? <Text key={element.id} name="preview-text" {...textNodeStyle(element)} x={element.x} y={element.y} listening={false} />
                  : <TextElementNode key={element.id} element={element} selected={selectedElementId === element.id} canvas={canvas} variantId={id} zoom={zoom} />)}</Layer>
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
                <button className="button empty-secondary" onClick={() => dispatch(tabChanged('ai'))}><Sparkles size={14} />Create with AI</button>
                <button className="example-button" disabled title="Editable example is coming in Milestone 7"><Image size={14} />Open wedding example</button>
                <span className="action-hint">Example coming in a later update</span>
              </div>
            </div>}
          </div>
        </div>
      </div>
      }
      <div className="workspace-footer"><span className="workspace-caption">ROOM TO CREATE</span>
        {!comparing && <div className="zoom-controls" aria-label="Canvas zoom">
          <button aria-label="Zoom out" disabled={zoom <= VIEWPORT.minZoom} onClick={() => dispatch(zoomChanged(zoom / VIEWPORT.zoomStep))}><Minus size={15} /></button>
          <output aria-label="Current zoom">{Math.round(zoom * 100)}%</output>
          <button aria-label="Zoom in" disabled={zoom >= VIEWPORT.maxZoom} onClick={() => dispatch(zoomChanged(zoom * VIEWPORT.zoomStep))}><Plus size={15} /></button>
          <span className="zoom-divider" /><button className="fit-button" onClick={() => dispatch(fitRequested())}><Maximize size={14} />Fit</button>
        </div>
        }
        <span className="workspace-footer-label">{comparing ? 'Source / Target' : `Version ${variants.findIndex((item) => item.id === current.id) + 1}`}</span>
      </div>
    </main>
  );
}
