import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, LayoutTemplate, SlidersHorizontal, Sparkles, Type, ArrowUpRight, Grid2x2, PaintBucket, Blend, ImagePlus } from 'lucide-react';
import { CANVAS_PRESETS, LAYER_LIMITS, validateCanvasSize, type CanvasSize, type DesignLayer } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { canvasBackgroundChanged, canvasResized, layerAdded } from '../../store/editorSlice';
import { elementSelected } from '../../store/uiSlice';
import { assets } from '../../lib/assets/runtimeAssets';
import { backgroundLayer } from '../decomposition/importScene';
import { fitRequested, tabChanged, type LeftTab } from '../../store/uiSlice';
import { AIPanel } from '../ai/AIPanel';
import { TextPanel } from '../text/TextPanel';

const TABS = [
  { id: 'design', label: 'Design', icon: LayoutTemplate },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'ai', label: 'AI', icon: Sparkles },
] as const;

export function DesignPanel({ onNewDesign }: { onNewDesign: () => void }) {
  const dispatch = useAppDispatch();
  const variantId = useAppSelector(selectActiveVariant).id;
  const activeTab = useAppSelector((state) => state.ui.activeLeftTab);
  const tabRefs = useRef<Partial<Record<LeftTab, HTMLButtonElement | null>>>({});
  function moveTab(event: KeyboardEvent, index: number) {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    dispatch(tabChanged(TABS[next].id));
    tabRefs.current[TABS[next].id]?.focus();
  }
  return (
    <aside className="design-panel" id="design-tools" aria-label="Design tools">
      <div className="panel-tabs" role="tablist" aria-label="Editor tools">
        {TABS.map(({ id, label, icon: Icon }, index) => (
          <button key={id} ref={(node) => { tabRefs.current[id] = node; }} role="tab" id={`tab-${id}`}
            aria-selected={activeTab === id} aria-controls={`panel-${id}`} tabIndex={activeTab === id ? 0 : -1}
            onKeyDown={(event) => moveTab(event, index)} onClick={() => dispatch(tabChanged(id))}>
            <Icon size={17} strokeWidth={1.6} /><span>{label}</span>
          </button>
        ))}
      </div>
      <div className="tab-content" role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`}>
        {activeTab === 'design' ? <CanvasSettings key={variantId} /> : activeTab === 'text' ? <TextPanel /> : <AIPanel />}
      </div>
      <div className="design-panel-footer"><button id="new-design-action" className="button new-design-action" onClick={onNewDesign}>New design</button><span>Start fresh</span></div>
    </aside>
  );
}
function CanvasSettings() {
  const dispatch = useAppDispatch();
  const variant = useAppSelector(selectActiveVariant);
  const { width, height } = variant.canvas;
  const matchingPreset = CANVAS_PRESETS.find((preset) => preset.width === width && preset.height === height);
  const [customOpen, setCustomOpen] = useState(!matchingPreset);
  const [draft, setDraft] = useState({ width: String(width), height: String(height) });
  const [errors, setErrors] = useState<Partial<Record<'width' | 'height' | 'area', string>>>({});
  const [message, setMessage] = useState('');

  function applySize(size: CanvasSize) {
    dispatch(canvasResized({ variantId: variant.id, size, timestamp: new Date().toISOString() }));
    dispatch(fitRequested());
    setMessage(`Canvas set to ${size.width} × ${size.height} pixels.`);
  }
  return (
    <div className="canvas-settings">
      <div className="section-intro"><span className="eyebrow">THE STARTING POINT</span><h2>Choose your canvas size.</h2><p>Start with a preset or set your own dimensions.</p></div>
      <div className="section-label"><h3>Canvas size</h3><span>Pixels</span></div>
      <div className="preset-list" aria-label="Canvas size presets">
        {CANVAS_PRESETS.map((preset) => {
          const selected = !customOpen && matchingPreset?.id === preset.id;
          return (
            <button key={preset.id} className={`preset-button ${selected ? 'is-selected' : ''}`} aria-pressed={selected}
              onClick={() => { applySize(preset); setCustomOpen(false); setErrors({}); setDraft({ width: String(preset.width), height: String(preset.height) }); }}>
              <span className="preset-preview" aria-hidden="true"><span style={{ aspectRatio: `${preset.width} / ${preset.height}` }} /></span>
              <span className="preset-copy"><strong>{preset.name}</strong><span>{preset.width} × {preset.height}</span></span>
              <span className="preset-meta"><span className="preset-ratio">{preset.ratio}</span>{selected && <Check size={15} className="preset-check" aria-hidden="true" />}</span>
            </button>
          );
        })}
        <button className={`preset-button custom-preset ${customOpen ? 'is-selected' : ''}`} aria-expanded={customOpen} aria-controls="custom-size-form"
          onClick={() => { setCustomOpen(!customOpen); setDraft({ width: String(width), height: String(height) }); setErrors({}); }}>
          <SlidersHorizontal size={18} strokeWidth={1.5} /><strong>Custom size</strong><span className="custom-indicator">{customOpen ? '−' : '+'}</span>
        </button>
      </div>
      {customOpen && <form id="custom-size-form" className="custom-size-form" noValidate onSubmit={(event) => {
        event.preventDefault();
        const result = validateCanvasSize(draft.width, draft.height);
        if (!result.valid) { setErrors(result.errors); setMessage(''); return; }
        setErrors({}); applySize(result.size);
      }}>
        <div className="dimension-fields">
          {(['width', 'height'] as const).map((field) => <label key={field} htmlFor={`canvas-${field}`}>
            <span>{field === 'width' ? 'Width' : 'Height'}</span>
            <span className="input-wrap"><input id={`canvas-${field}`} inputMode="numeric" type="text" value={draft[field]}
              aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `${field}-error` : 'size-help'}
              onChange={(event) => { setDraft({ ...draft, [field]: event.target.value }); setErrors({}); setMessage(''); }} /><span aria-hidden="true">px</span></span>
          </label>)}
        </div>
        {Object.entries(errors).map(([field, error]) => <p key={field} id={`${field}-error`} className="field-error" role="alert">{error}</p>)}
        <p className="size-help" id="size-help">256–4096 px per side. Up to 12 million pixels.</p>
        <button className="button primary-button apply-button" type="submit">Apply size<ArrowUpRight size={15} /></button>
      </form>}
      <p role="status" className="sr-only">{message}</p>
      <BackgroundSettings />
      <div className="design-note"><span className="eyebrow">A FRAME, NOT A LIMIT</span><p>You can change your canvas size at any time.</p></div>
    </div>
  );
}

const BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
/** Transparent or a solid colour on the canvas itself; a gradient or an uploaded picture as a locked bottom layer. */
function BackgroundSettings() {
  const dispatch = useAppDispatch();
  const variant = useAppSelector(selectActiveVariant);
  const [error, setError] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const { width, height, backgroundColor, transparent } = variant.canvas;
  const full = (variant.layers?.length ?? 0) >= LAYER_LIMITS.maxLayers;
  const timestamp = () => new Date().toISOString();
  const addBottom = (layer: DesignLayer) => { dispatch(layerAdded({ variantId: variant.id, layer, position: 'bottom', timestamp: timestamp() })); dispatch(elementSelected(layer.id)); };
  const gradient = () => addBottom({ id: `layer-${crypto.randomUUID()}`, type: 'shape', name: 'Background gradient', shapeType: 'rectangle', x: 0, y: 0, width, height, rotation: 0, opacity: 1, visible: true, locked: true,
    fill: backgroundColor, gradient: { from: backgroundColor, to: '#d9e6df', angle: 90 }, radius: 0 });
  const image = async (file?: File) => {
    setError('');
    if (!file) return;
    if (!BACKGROUND_TYPES.includes(file.type) || file.size > 25 * 1024 * 1024) { setError('Choose a PNG, JPEG or WebP image up to 25 MB.'); return; }
    const id = `background-${crypto.randomUUID()}`;
    try { await assets.putAsset(id, file); } catch { setError('This image could not be saved in your browser. Try a smaller one.'); return; }
    addBottom(backgroundLayer(`layer-${crypto.randomUUID()}`, id, width, height, 'Background image'));
  };
  return <section className="background-settings" aria-label="Background">
    <div className="section-label"><h3>Background</h3><span>{transparent ? 'Transparent' : backgroundColor.toUpperCase()}</span></div>
    <div className="background-options">
      <button className={`button ${transparent ? 'is-selected' : ''}`} aria-pressed={Boolean(transparent)} onClick={() => dispatch(canvasBackgroundChanged({ variantId: variant.id, transparent: true, timestamp: timestamp() }))}><Grid2x2 size={14} />Transparent</button>
      <label className={`button background-colour ${transparent ? '' : 'is-selected'}`}><PaintBucket size={14} />Solid colour
        <input type="color" aria-label="Background colour" value={backgroundColor.toLowerCase()} onChange={e => dispatch(canvasBackgroundChanged({ variantId: variant.id, transparent: false, color: e.target.value, timestamp: timestamp() }))}
          onClick={() => { if (transparent) dispatch(canvasBackgroundChanged({ variantId: variant.id, transparent: false, timestamp: timestamp() })); }} /></label>
      <button className="button" disabled={full} onClick={gradient}><Blend size={14} />Add gradient</button>
      <button className="button" disabled={full} onClick={() => upload.current?.click()}><ImagePlus size={14} />Add image</button>
      <input ref={upload} type="file" accept={BACKGROUND_TYPES.join(',')} hidden aria-label="Background image" onChange={e => { void image(e.target.files?.[0]); e.target.value = ''; }} />
    </div>
    <p className="size-help">{transparent ? 'Exports as a PNG with a transparent background.' : 'A gradient or image goes behind all your layers; select it to change it.'}</p>
    {error && <p className="field-error" role="alert">{error}</p>}
  </section>;
}
