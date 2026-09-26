import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Eye, EyeOff, GripVertical, ImageUp, Lock, Trash2, Type, Unlock } from 'lucide-react';
import { clamp, TEXT_LIMITS, type DesignLayer, type DesignVariant, type TextElement } from '@frameflow/shared';
import { useAppDispatch } from '../../store';
import { layerConvertedToText, layerDeleted, layerDuplicated, layerImageReplaced, layerReordered, layerUpdated, type LayerChanges } from '../../store/editorSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { elementSelected } from '../../store/uiSlice';
import { LayerThumbnail } from './LayerThumbnail';
import './layers.css';

const now = () => new Date().toISOString();
const kindLabel = (layer: DesignLayer) => layer.type === 'shape' ? layer.shapeType.replace('-', ' ') : layer.source?.kind === 'text' ? 'text image' : 'image';

/** Back-to-front document order, listed front-first like design tools. */
export function LayersList({ variant, selectedId }: { variant: DesignVariant; selectedId: string | null }) {
  const dispatch = useAppDispatch();
  const layers = [...(variant.layers ?? [])].reverse();
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const reorder = (layer: DesignLayer, toIndex: number) => {
    dispatch(layerReordered({ variantId: variant.id, id: layer.id, toIndex, timestamp: now() }));
    setAnnouncement(`${layer.name} moved to position ${layers.length - toIndex} of ${layers.length}.`);
  };
  if (!layers.length) return null;
  return <section className="layers-list" aria-label="Layers">
    <div className="section-label"><h3>Layers</h3><span>{layers.length}</span></div>
    <p className="layer-list-hint">Front to back · Drag to reorder</p>
    <span className="layer-announcement" role="status" aria-live="polite">{announcement}</span>
    <ul aria-label="Design layers">{layers.map((layer, index) => <li key={layer.id} data-layer-id={layer.id}
      className={[layer.id === selectedId ? 'selected' : '', draggedId === layer.id ? 'is-dragging' : '', drop?.id === layer.id ? (drop.after ? 'drop-after' : 'drop-before') : ''].join(' ')}
      onDragOver={event => {
        if (!draggedId || draggedId === layer.id) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        const bounds = event.currentTarget.getBoundingClientRect();
        setDrop({ id: layer.id, after: event.clientY > bounds.y + bounds.height / 2 });
      }} onDrop={event => {
        event.preventDefault();
        const source = layers.find(item => item.id === draggedId);
        if (source && drop?.id === layer.id && source.id !== layer.id) {
          const ids = layers.filter(item => item.id !== source.id).map(item => item.id);
          const at = ids.indexOf(layer.id) + (drop.after ? 1 : 0);
          reorder(source, layers.length - 1 - at);
        }
        setDraggedId(null); setDrop(null);
      }}>
      <button className="layer-drag icon-button" draggable aria-label={`Reorder ${layer.name}`} title="Drag to reorder, or use the Up and Down arrow keys"
        onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', layer.id); setDraggedId(layer.id); }}
        onDragEnd={() => { setDraggedId(null); setDrop(null); }}
        onKeyDown={event => {
          const next = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : event.key === 'Home' ? 0 : event.key === 'End' ? layers.length - 1 : null;
          if (next === null) return;
          event.preventDefault();
          if (next >= 0 && next < layers.length && next !== index) reorder(layer, layers.length - 1 - next);
        }}><GripVertical size={14} /></button>
      <button className="layer-select" aria-pressed={layer.id === selectedId} onClick={() => dispatch(elementSelected(layer.id))}>
        <LayerThumbnail layer={layer} /><span className="layer-label"><span className="layer-name">{layer.name}</span><span className="layer-kind">{kindLabel(layer)}{layer.visible ? '' : ' · hidden'}{layer.locked ? ' · locked' : ''}</span></span>
      </button>
      <button className="icon-button" aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`} aria-pressed={layer.locked} title={layer.locked ? 'Unlock' : 'Lock'}
        onClick={() => dispatch(layerUpdated({ variantId: variant.id, id: layer.id, changes: { locked: !layer.locked }, timestamp: now() }))}>{layer.locked ? <Lock size={14} /> : <Unlock size={14} />}</button>
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
  const replaceInput = useRef<HTMLInputElement>(null);
  const [replaceError, setReplaceError] = useState('');
  /** A new picture in the same place and size; the old one stays stored so Undo can bring it back. */
  const replaceImage = async (file?: File) => {
    setReplaceError('');
    if (!file || layer.type !== 'image') return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 25 * 1024 * 1024) { setReplaceError('Choose a PNG, JPEG or WebP image up to 25 MB.'); return; }
    const assetId = `replace-${crypto.randomUUID()}`;
    try { await assets.putAsset(assetId, file); } catch { setReplaceError('This image could not be saved in your browser. Try a smaller one.'); return; }
    dispatch(layerImageReplaced({ variantId: variant.id, id: layer.id, assetId, timestamp: now() }));
  };
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
      <label className="layer-field">Fill style<select aria-label="Fill style" value={layer.gradient ? 'gradient' : 'solid'}
        onChange={e => change(e.target.value === 'gradient' ? { gradient: { from: layer.fill, to: '#ffffff', angle: 0 } } : { fill: layer.gradient?.from ?? layer.fill, gradient: null })}>
        <option value="solid">Solid colour</option><option value="gradient">Linear gradient</option>
      </select></label>
      {layer.gradient ? <div className="layer-gradient-controls">
        <div className="layer-grid">{(['from', 'to'] as const).map((key, i) => <label key={key} className="layer-field">{i === 0 ? 'Start colour' : 'End colour'}<input type="color" aria-label={i === 0 ? 'Gradient start colour' : 'Gradient end colour'} value={layer.gradient![key]}
          onFocus={() => { session.current = crypto.randomUUID(); }} onChange={e => change({ gradient: { ...layer.gradient!, [key]: e.target.value } }, session.current || undefined)} /></label>)}</div>
        <label className="layer-field">Angle<input type="number" aria-label="Gradient angle" value={layer.gradient.angle} min={-360} max={360}
          onFocus={() => { session.current = crypto.randomUUID(); }} onChange={e => { const angle = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(angle)) change({ gradient: { ...layer.gradient!, angle: clamp(angle, -360, 360) } }, session.current || undefined); }} /></label>
      </div> : <label className="layer-field">Fill<input type="color" aria-label="Fill" value={layer.fill} onFocus={() => { session.current = crypto.randomUUID(); }} onChange={e => change({ fill: e.target.value }, session.current || undefined)} /></label>}
      {layer.shapeType === 'rounded-rectangle' && <label className="layer-field">Corner radius<input type="number" aria-label="Corner radius" min={0} value={Math.round(layer.radius)} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) change({ radius: v }); }} /></label>}
      <label className="layer-field">Stroke<input type="color" aria-label="Stroke colour" value={layer.stroke?.color ?? '#000000'} onChange={e => change({ stroke: { color: e.target.value, width: layer.stroke?.width || 2 } })} /></label>
      <label className="layer-field">Stroke width<input type="number" aria-label="Stroke width" min={0} max={200} value={layer.stroke?.width ?? 0} onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) change({ stroke: v ? { color: layer.stroke?.color ?? '#000000', width: v } : null }); }} /></label>
    </>}
    {layer.type === 'image' && layer.textSuggestion && <div className="layer-text-suggestion">
      <p><strong>Text image.</strong> {layer.textSuggestion.text ? <>Suggested text (unverified): “{layer.textSuggestion.text}”.</> : 'No reliable text suggestion; you can type it after converting.'}</p>
      <button className="button" onClick={convert}><Type size={14} />Make text editable</button>
    </div>}
    {layer.type === 'image' && <div className="layer-replace">
      <button className="button" onClick={() => replaceInput.current?.click()}><ImageUp size={14} />Replace image</button>
      <input ref={replaceInput} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Replacement image" onChange={e => { void replaceImage(e.target.files?.[0]); e.target.value = ''; }} />
      {replaceError && <p className="field-error" role="alert">{replaceError}</p>}
    </div>}
    <div className="layer-actions">
      <button className="button" aria-pressed={!layer.visible} onClick={() => change({ visible: !layer.visible })}>{layer.visible ? <EyeOff size={14} /> : <Eye size={14} />}{layer.visible ? 'Hide' : 'Show'}</button>
      <button className="button" aria-pressed={layer.locked} onClick={() => change({ locked: !layer.locked })}>{layer.locked ? <Unlock size={14} /> : <Lock size={14} />}{layer.locked ? 'Unlock' : 'Lock'}</button>
      <button className="button" disabled={index >= (variant.layers?.length ?? 0) - 1} onClick={() => dispatch(layerReordered({ variantId: variant.id, id: layer.id, direction: 'forward', timestamp: now() }))}><ArrowUp size={14} />Bring forward</button>
      <button className="button" disabled={index <= 0} onClick={() => dispatch(layerReordered({ variantId: variant.id, id: layer.id, direction: 'backward', timestamp: now() }))}><ArrowDown size={14} />Send backward</button>
      <button className="button" onClick={() => { const newId = `layer-${crypto.randomUUID()}`; dispatch(layerDuplicated({ variantId: variant.id, id: layer.id, newId, timestamp: now() })); dispatch(elementSelected(newId)); }}><Copy size={14} />Duplicate</button>
      <button className="button delete-text" onClick={() => { dispatch(layerDeleted({ variantId: variant.id, id: layer.id, timestamp: now() })); dispatch(elementSelected(null)); }}><Trash2 size={14} />Delete</button>
    </div>
    <p className="inspector-hint">{layer.locked ? 'Locked on the canvas. Unlock to move, resize or rotate with the handles.' : 'Drag on the canvas to move; use the handles to resize and rotate.'} Text elements always stay above layers.</p>
  </div>;
}
