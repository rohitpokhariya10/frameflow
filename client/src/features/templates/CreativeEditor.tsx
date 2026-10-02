import { useMemo, useState } from 'react';
import {
  offerTemplateTheme, offerTheme, themeFonts, themeColors, applyCreative, designCanvasSize, editablePropertiesOf, findElement, pixelChangeToNormalized, resolveElements, roundNormalized, setCreativeAspectRatio, setCreativeOverride, textFitWarning, toPixels,
  type OfferTheme, type Creative, type DesignTemplate, type DesignVariant, type ElementOverride, type NormalizedLayout, type PixelBox, type ResolvedElement, type ResolvedText, type TemplateElement,
} from '@frameflow/shared';
import { FontPicker } from '../fonts/FontPicker';
import { useFonts } from '../fonts/useFonts';
import { ThemePalette } from './templateUi';
import { assets } from '../../lib/assets/runtimeAssets';
import { LOCKED_POINTER, TemplateCanvas } from './TemplateCanvas';
import { copyAsset } from './slotImage';
import { fitTemplateTexts } from './templateText';
import { ColorInput, Field, ImagePicker, NumberInput, Section } from './templateUi';
import { creativeToVariant } from './toDesignVariant';
import { TemplateHistoryButtons, type TemplateHistoryControls } from './useTemplateHistory';

interface Props {
  /** The template version this creative is pinned to. */
  template: DesignTemplate; creative: Creative;
  history: TemplateHistoryControls;
  onRatioChange: (creative: Creative) => void;
  /** The newest version of the template, when that is a later one than the creative uses. */
  newerVersion?: number;
  saved: boolean; dirty: boolean;
  onChange: (creative: Creative) => void; onSave: () => void; onUpgrade: () => void;
  /** Adds the rendered creative to the existing editor as a new version; returns why not, if it could not. */
  onOpenInEditor: (variant: DesignVariant) => string | undefined;
}
const GEOMETRY = ['position', 'size', 'rotation'] as const;
const GEOMETRY_FIELDS: Record<typeof GEOMETRY[number], (keyof NormalizedLayout)[]> = { position: ['x', 'y'], size: ['width', 'height'], rotation: ['rotation'] };

/**
 * Use Template: fill a template with content. Only what the template author marked editable can be changed; the
 * geometry comes from the template and is locked here unless the author opened it for an element.
 */
export function CreativeEditor({ template, creative, history, onRatioChange, newerVersion, saved, dirty, onChange, onSave, onUpgrade, onOpenInEditor }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const canvas = useMemo(() => designCanvasSize(creative.aspectRatio), [creative.aspectRatio]);
  const applied = useMemo(() => applyCreative(template, creative), [template, creative]);
  if (selectedId && !applied.elements.some(element => element.id === selectedId)) setSelectedId(null);
  const resolved = useMemo(() => resolveElements(applied.elements, canvas), [applied, canvas]);
  const fonts = useFonts(resolved.flatMap(e => e.type === 'text' ? [{family:e.fontFamily,weight:e.fontWeight,text:e.text}] : []));
  const fits = useMemo(() => { void fonts.revision; return fitTemplateTexts(resolved); }, [resolved, fonts.revision]);
  const criticalOverflow = resolved.some(e => ["headline", "offer-value", "cta", "offer-prefix", "offer-suffix", "date", "location", "second-offer-value", "second-offer-label", "time", "dress-code"].includes(e.themeRole ?? "") && fits.get(e.id)?.truncated);
  const warnings = [...applied.ignored.map(issue => issue.message), ...resolved.filter((element): element is ResolvedText => element.type === 'text').flatMap(element => textFitWarning(element, fits.get(element.id)!) ?? [])];

  const change = (edit: () => Creative) => {
    try { onChange(edit()); setError(''); return true; }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'That change could not be made.'); return false; }
  };
  const override = (id: string, values: ElementOverride) => change(() => setCreativeOverride(creative, template, id, values, new Date().toISOString()));
  const allows = (element: ResolvedElement) => {
    const source = findElement(template, element.id);
    if (!source || source.type === 'background') return LOCKED_POINTER;
    return { move: source.editableProperties.position, resize: source.editableProperties.size, rotate: source.editableProperties.rotation };
  };
  /** A drag or resize, possible only where the template opened that geometry: stored as a normalized override. */
  const commit = (id: string, pixels: Partial<PixelBox>): PixelBox | undefined => {
    const source = findElement(template, id), shown = applied.elements.find(element => element.id === id);
    if (!source || !shown) return undefined;
    const next = pixelChangeToNormalized(shown.layout, pixels, canvas);
    const allowed = GEOMETRY.filter(property => source.editableProperties[property]).flatMap(property => GEOMETRY_FIELDS[property]);
    const layout = Object.fromEntries(allowed.filter(field => next[field] !== shown.layout[field]).map(field => [field, next[field]])) as Partial<NormalizedLayout>;
    if (!Object.keys(layout).length || !override(id, { layout })) return toPixels(shown.layout, canvas);
    return toPixels({ ...shown.layout, ...layout }, canvas);
  };
  const openInEditor = async () => {
    setOpening(true); setError('');
    const newId = () => crypto.randomUUID();
    try {
      // The complete elements (template structure + this creative's content), still normalized, go to the editor through the shared adapter.
      const variant = await creativeToVariant(applied.elements, canvas, { name: creative.name, templateId: template.id, templateVersion: template.version, creativeId: creative.id, themeId: template.themeId },
        { newId, copyAsset: id => copyAsset(id, newId), deleteAsset: id => assets.deleteAsset(id) });
      const refused = onOpenInEditor(variant);
      if (refused) {
        await Promise.all([variant.background?.assetId, ...(variant.layers ?? []).map(layer => layer.type === 'image' ? layer.assetId : undefined)].map(id => id ? assets.deleteAsset(id).catch(() => undefined) : undefined));
        setError(refused);
      }
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'The creative could not be opened in the editor.'); }
    finally { setOpening(false); }
  };
  // Fields in reading order: top to bottom, then left to right; the background last.
  const ordered = [...template.elements].sort((a, b) => Number(a.type === 'background') - Number(b.type === 'background') || a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const editable = ordered.filter(element => editablePropertiesOf(element).length), locked = ordered.filter(element => !editablePropertiesOf(element).length);

  return <ThemePalette.Provider value={themeColors((offerTemplateTheme(template) ?? offerTheme(template.themeId)))}><div className="tpl-main" data-fonts-state={fonts.loading ? "loading" : fonts.failed ? "failed" : "ready"}>
    <div className="tpl-toolbar">
      <TemplateHistoryButtons history={history} />
      <span><strong>Template:</strong> {template.name} <span className="ws-muted">(version {template.version})</span></span>
      <label className="tpl-row"><strong>Creative name</strong>
        <input type="text" aria-label="Creative name" value={creative.name} maxLength={200} onChange={event => onChange({ ...creative, name: event.target.value })} style={{ width: 220 }} /></label>
      <div className="tpl-row" role="group" aria-label="Aspect ratio"><strong>Ratio</strong>
        {template.supportedAspectRatios.map(item => <button key={item} type="button" className={`ws-btn ${item === creative.aspectRatio ? 'ws-btn-primary' : ''}`} aria-pressed={item === creative.aspectRatio}
          onClick={() => onRatioChange(setCreativeAspectRatio(creative, template, item, new Date().toISOString()))}>{item}</button>)}
        <span className="ws-muted">{canvas.width} × {canvas.height} px</span>
      </div>
      <span className="tpl-row" style={{ marginLeft: 'auto' }}>
        <button type="button" className="ws-btn ws-btn-primary" disabled={!dirty && saved} onClick={onSave}>{saved && !dirty ? 'Saved' : 'Save Creative'}</button>
        <button type="button" className="ws-btn" disabled={opening || criticalOverflow || fonts.loading} onClick={() => void openInEditor()}>{opening ? 'Opening…' : 'Open in editor'}</button>
      </span>
      {newerVersion !== undefined && <div className="ws-notice" style={{ flexBasis: '100%' }}>This creative uses version {template.version} of the template and stays on it. Version {newerVersion} exists.{' '}
        <button type="button" className="ws-btn" onClick={onUpgrade}>Update this creative to version {newerVersion}</button></div>}
      {error && <div role="alert" className="ws-error-text" style={{ flexBasis: '100%' }}>{error}</div>}
    </div>
    <div className="tpl-work is-creative">
      <aside className="tpl-panel" aria-label="Editable content">
        {fonts.loading && <p role="status" className="ws-muted">Loading selected fonts…</p>}
        {fonts.failed && <p role="status" className="ws-warn">Some fonts could not load. Your selections are kept; readable fallbacks are shown.</p>}
        <Section title="Editable content" note="(set by the template)">
          {!editable.length && <p className="ws-muted">This template locks everything; there is nothing to change.</p>}
          {editable.map(element => <CreativeFields key={element.id} theme={offerTemplateTheme(template) ?? offerTheme(template.themeId)} element={element} shown={applied.elements.find(item => item.id === element.id) ?? element} override={creative.contentOverrides[element.id]}
            selected={element.id === selectedId} onSelect={() => setSelectedId(element.id)} change={values => override(element.id, values)} />)}
        </Section>
        {locked.length > 0 && <Section title="Locked by the template"><p className="ws-muted">{locked.map(element => element.name || element.role).join(', ')}</p></Section>}
        {warnings.length > 0 && <Section title="Warnings">{warnings.map(warning => <p key={warning} className="ws-warn">{warning}</p>)}</Section>}
      </aside>
      <div className="tpl-stage">
        <TemplateCanvas fontRevision={fonts.revision} elements={resolved} fits={fits} canvas={canvas} selectedId={selectedId} onSelect={setSelectedId} allows={allows} onCommit={commit} />
      </div>
    </div>
  </div></ThemePalette.Provider>;
}

/** The fields of one element: one control per property the template lets a creative change. */
function CreativeFields({ theme, element, shown, override, selected, onSelect, change }: {
  theme?: OfferTheme; element: TemplateElement; shown: TemplateElement; override?: ElementOverride; selected: boolean; onSelect: () => void; change: (values: ElementOverride) => void;
}) {
  const can = element.editableProperties;
  const geometry = GEOMETRY.filter(property => can[property]);
  const changed = !!override && Object.keys(override).length > 0;
  return <fieldset className={`tpl-fields ${selected ? 'is-on' : ''}`} onFocus={onSelect} onClick={onSelect}>
    <legend>{element.name || element.role} <span className="ws-muted">{element.role}</span></legend>
    {shown.type === 'text' && can.content && <Field label="Text"><textarea rows={2} value={shown.defaultContent.text} maxLength={5000} onChange={event => change({ text: event.target.value })} /></Field>}
    {shown.type === 'text' && can.color && <ColorInput label="Text colour" value={shown.style.color} onChange={color => change({ color })} />}
    {shown.type === 'text' && can.backgroundColor && shown.style.backgroundColor !== null && <ColorInput label="Box colour" value={shown.style.backgroundColor} onChange={backgroundColor => change({ backgroundColor })} />}
    {shown.type === 'text' && can.fontFamily && <FontPicker value={shown.style.fontFamily} recommended={theme ? themeFonts(theme, element.themeRole ?? element.role) : []} recommendationLabel={`Recommended for ${theme?.name ?? "text"}`} onChange={fontFamily => change({ fontFamily })} />}
    {shown.type === 'shape' && can.color && <ColorInput label="Colour" value={shown.style.fill} onChange={color => change({ color })} />}
    {shown.type === 'background' && can.color && <ColorInput label="Colour" value={shown.defaultContent.color} onChange={color => change({ color })} />}
    {(shown.type === 'image' || shown.type === 'background') && can.image && <>
      <ImagePicker label="Image" assetId={shown.defaultContent.assetId} onChange={assetId => change({ assetId })} />
      {shown.defaultContent.assetId && <>
        <NumberInput label="Focal X" suffix="%" min={0} max={100} step={5} digits={1} value={shown.behavior.focalX * 100} onChange={value => change({ focalX: roundNormalized(value / 100) })} />
        <NumberInput label="Focal Y" suffix="%" min={0} max={100} step={5} digits={1} value={shown.behavior.focalY * 100} onChange={value => change({ focalY: roundNormalized(value / 100) })} />
      </>}
    </>}
    {geometry.length > 0 && <p className="ws-hint">The template lets this element's {geometry.join(', ')} change: use the handles on the canvas.</p>}
    {changed && <button type="button" className="ws-btn ws-btn-quiet" onClick={() => change({ text: undefined, color: undefined, backgroundColor: undefined, assetId: undefined, focalX: undefined, focalY: undefined, fontFamily: undefined,
      layout: { x: undefined, y: undefined, width: undefined, height: undefined, rotation: undefined } })}>Reset to the template</button>}
  </fieldset>;
}
