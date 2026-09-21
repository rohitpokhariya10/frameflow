import { useRef, useState, type KeyboardEvent } from 'react';
import { Check, LayoutTemplate, SlidersHorizontal, Sparkles, Type, ArrowUpRight } from 'lucide-react';
import { CANVAS_PRESETS, validateCanvasSize, type CanvasSize } from '@frameflow/shared';
import { selectActiveVariant, useAppDispatch, useAppSelector } from '../../store';
import { canvasResized } from '../../store/editorSlice';
import { fitRequested, tabChanged, type LeftTab } from '../../store/uiSlice';

const TABS = [
  { id: 'design', label: 'Design', icon: LayoutTemplate },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'ai', label: 'AI', icon: Sparkles },
] as const;

export function DesignPanel() {
  const dispatch = useAppDispatch();
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
    <aside className="design-panel" aria-label="Design tools">
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
        {activeTab === 'design' ? <CanvasSettings /> : <UpcomingPanel tab={activeTab} />}
      </div>
      <div className="design-panel-footer"><span className="status-dot" />Your next idea starts here.</div>
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
      <div className="section-intro"><span className="eyebrow">THE STARTING POINT</span><h2>Make room for your idea.</h2><p>Choose a format. Make it yours.</p></div>
      <div className="section-label"><h3>Canvas size</h3><span>Pixels</span></div>
      <div className="preset-list" aria-label="Canvas size presets">
        {CANVAS_PRESETS.map((preset) => {
          const selected = !customOpen && matchingPreset?.id === preset.id;
          return (
            <button key={preset.id} className={`preset-button ${selected ? 'is-selected' : ''}`} aria-pressed={selected}
              onClick={() => { applySize(preset); setCustomOpen(false); setErrors({}); setDraft({ width: String(preset.width), height: String(preset.height) }); }}>
              <span className="preset-preview" aria-hidden="true"><span style={{ aspectRatio: `${preset.width} / ${preset.height}` }} /></span>
              <span className="preset-copy"><strong>{preset.name}</strong><span>{preset.width} × {preset.height}</span></span>
              {selected ? <Check size={15} className="preset-check" /> : <span className="preset-ratio">{preset.ratio}</span>}
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
      <div className="design-note"><span className="eyebrow">A FRAME, NOT A LIMIT</span><p>You can change your canvas size at any time.</p></div>
    </div>
  );
}

function UpcomingPanel({ tab }: { tab: 'text' | 'ai' }) {
  const Icon = tab === 'text' ? Type : Sparkles;
  return <div className="upcoming-panel"><Icon size={24} strokeWidth={1.4} /><span className="eyebrow">COMING NEXT</span>
    <h2>{tab === 'text' ? 'Words with presence.' : 'An idea into artwork.'}</h2>
    <p>{tab === 'text' ? 'Add headings, shape your typography, and give every word its place.' : 'Create original artwork from a prompt, with your words kept editable.'}</p>
    <span className="upcoming-badge">{tab === 'text' ? 'Text editing · Milestone 2' : 'AI generation · Milestone 5'}</span>
  </div>;
}
