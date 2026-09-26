import { useRef } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, Lock, Trash2, Type, Unlock } from 'lucide-react';
import { clamp, TEXT_LIMITS, type DesignLayer, type DesignVariant, type TextElement } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { layerConvertedToText, layerDeleted, layerDuplicated, layerReordered, layerUpdated, type LayerChanges } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import './layers.css';

const now = () => new Date().toISOString();
const kindLabel = (layer: DesignLayer) => layer.type === 'shape' ? layer.shapeType.replace('-', ' ') : layer.source?.kind === 'text' ? 'text image' : 'image';

/** Back-to-front document order, listed front-first like design tools. */
export function LayersList({ variant, selectedId }: { variant: DesignVariant; selectedId: string | null }) {
  const dispatch = useAppDispatch();
  const layers = [...(variant.layers ?? [])].reverse();
  if (!layers.length) return null;
  return <section className="layers-list" aria-label="Layers">
    <div className="section-label"><h3>Layers</h3><span>{layers.length}</span></div>
    <ul>{layers.map(layer => <li key={layer.id} className={layer.id === selectedId ? 'selected' : ''}>
      <button className="layer-select" aria-pressed={layer.id === selectedId} onClick={() => dispatch(elementSelected(layer.id))}>
        <span className="layer-name">{layer.name}</span><span className="layer-kind">{kindLabel(layer)}{layer.visible ? '' : ' · hidden'}</span>
      </button>
      <button className="icon-button" aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`} title={layer.visible ? 'Hide' : 'Show'}
        onClick={() => dispatch(layerUpdated({ variantId: variant.id, id: layer.id, changes: { visible: !layer.visible }, timestamp: now() }))}>{layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
    </li>)}</ul>
  </section>;
}

export function LayerInspector({ variant, layer }: { variant: DesignVariant; layer: DesignLayer }) {
  const dispatch = useAppDispatch();
  // One undo step per focused field, like text controls.
  const session = useRef<string>('');
  const change = (changes: LayerChanges, editSession?: string) => dispatch(layerUpdated({ variantId: variant.id, id: layer.id, changes, timestamp: now(), editSession }));
  const number = (label: string, key: 'x' | 'y' | 'width' | 'height' | 'rotation', min = -100_000, max = 100_000) =>
    <label className="layer-field">{label}<input type="number" aria-label={label} value={Math.round(layer[key] * 10) / 10} min={min} max={max}
      onFocus={() => { session.current = crypto.randomUUID(); }}
      onChange={e => { const value = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(value)) change({ [key]: clamp(value, min, max) }, session.current || undefined); }} /></label>;
  const index = variant.layers?.findIndex(item => item.id === layer.id) ?? -1;
  const convert = () => {
    if (layer.type !== 'image' || !layer.textSuggestion) return;
    const s = layer.textSuggestion;
    const element: TextElement = {
      id: `text-${crypto.randomUUID()}`, type: 'text', role: 'custom', text: s.text || 'Edit this text',
      x: layer.x, y: layer.y, width: clamp(Math.round(layer.width), TEXT_LIMITS.minWidth, TEXT_LIMITS.maxWidth),
      fontFamily: 'Inter', fontSize: clamp(s.fontSize ?? Math.round(layer.height * 0.8), TEXT_LIMITS.minFontSize, TEXT_LIMITS.maxFontSize),
      fontWeight: s.fontWeight ?? 600, fill: s.fill ?? '#111111', align: 'left', lineHeight: 1.2, letterSpacing: 0,
    };
    dispatch(layerConvertedToText({ variantId: variant.id, id: layer.id, element, timestamp: now() }));
    dispatch(elementSelected(element.id));
  };
  return <div className="layer-inspector">
    <div className="panel-heading"><h2>Layer</h2><span className="subtle-label">{kindLabel(layer)}</span></div>
    <label className="layer-field layer-name-field">Name<input aria-label="Layer name" maxLength={200} value={layer.name} onFocus={() => { session.current = crypto.randomUUID(); }} onChange={e => change({ name: e.target.value }, session.current)} /></label>
    <div className="layer-grid">{number('X', 'x')}{number('Y', 'y')}{number('Width', 'width', 1, 16384)}{number('Height', 'height', 1, 16384)}{number('Rotation', 'rotation', -180, 180)}</div>
    <label className="layer-field">Opacity {Math.round(layer.opacity * 100)}%<input type="range" aria-label="Opacity" min={0} max={100} value={Math.round(layer.opacity * 100)}
      onPointerDown={() => { session.current = crypto.randomUUID(); }} onChange={e => change({ opacity: Number(e.target.value) / 100 }, session.current || undefined)} /></label>
    {layer.type === 'shape' && <>
      <label className="layer-field">Fill<input type="color" aria-label="Fill" value={layer.gradient?.from ?? layer.fill} onChange={e => change({ fill: e.target.value })} /></label>
      {layer.gradient && <p className="inspector-hint">Gradient {layer.gradient.from} → {layer.gradient.to}. Choosing a fill replaces it with a solid colour.</p>}
      {layer.shapeType === 'rounded-rectangle' && <label className="layer-field">Corner radius<input type="number" aria-label="Corner radius" min={0} value={Math.round(layer.radius)} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) change({ radius: v }); }} /></label>}
      <label className="layer-field">Stroke<input type="color" aria-label="Stroke colour" value={layer.stroke?.color ?? '#000000'} onChange={e => change({ stroke: { color: e.target.value, width: layer.stroke?.width || 2 } })} /></label>
      <label className="layer-field">Stroke width<input type="number" aria-label="Stroke width" min={0} max={200} value={layer.stroke?.width ?? 0} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) change({ stroke: v ? { color: layer.stroke?.color ?? '#000000', width: v } : null }); }} /></label>
    </>}
    {layer.type === 'image' && layer.textSuggestion && <div className="layer-text-suggestion">
      <p><strong>Text image.</strong> {layer.textSuggestion.text ? <>Suggested text (unverified): “{layer.textSuggestion.text}”.</> : 'No reliable text suggestion; you can type it after converting.'}</p>
      <button className="button" onClick={convert}><Type size={14} />Make text editable</button>
    </div>}
    <div className="layer-actions">
      <button className="button" aria-pressed={!layer.visible} onClick={() => change({ visible: !layer.visible })}>{layer.visible ? <EyeOff size={14} /> : <Eye size={14} />}{layer.visible ? 'Hide' : 'Show'}</button>
      <button className="button" onClick={() => change({ locked: !layer.locked })}>{layer.locked ? <Unlock size={14} /> : <Lock size={14} />}{layer.locked ? 'Unlock' : 'Lock'}</button>
      <button className="button" disabled={index >= (variant.layers?.length ?? 0) - 1} onClick={() => dispatch(layerReordered({ variantId: variant.id, id: layer.id, direction: 'forward', timestamp: now() }))}><ArrowUp size={14} />Bring forward</button>
      <button className="button" disabled={index <= 0} onClick={() => dispatch(layerReordered({ variantId: variant.id, id: layer.id, direction: 'backward', timestamp: now() }))}><ArrowDown size={14} />Send backward</button>
      <button className="button" onClick={() => { const newId = `layer-${crypto.randomUUID()}`; dispatch(layerDuplicated({ variantId: variant.id, id: layer.id, newId, timestamp: now() })); dispatch(elementSelected(newId)); }}><Copy size={14} />Duplicate</button>
      <button className="button delete-text" onClick={() => { dispatch(layerDeleted({ variantId: variant.id, id: layer.id, timestamp: now() })); dispatch(elementSelected(null)); }}><Trash2 size={14} />Delete</button>
    </div>
    <p className="inspector-hint">Drag on the canvas to move; use the handles to resize and rotate. Text elements always stay above layers.</p>
  </div>;
}
