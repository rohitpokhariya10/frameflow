import { useMemo, useState } from 'react';
import {
  DESIGN_ASPECT_RATIOS, TEMPLATE_IMAGE_ROLES, TEMPLATE_SHAPE_ROLES, TEMPLATE_TEXT_ROLES, TEXT_FONTS, TEXT_WEIGHTS, addElement, commitPixelBox, createTemplateElement, designCanvasSize, findElement,
  removeElement, reorderElement, resolveElements, roundNormalized, setElementLayout, templateIssues, textFitWarning, toPixels, updateElement,
  type DesignAspectRatio, type DesignTemplate, type EditableProperty, type NormalizedLayout, type PixelBox, type ResolvedText, type TemplateElement, type TemplateElementRole,
} from '@frameflow/shared';
import { TemplateCanvas } from './TemplateCanvas';
import { fitTemplateTexts } from './templateText';
import { ColorInput, Field, ImagePicker, NumberInput, Section, Select, percent } from './templateUi';

const ADDABLE: { group: string; roles: [TemplateElementRole, string][] }[] = [
  { group: 'Text', roles: [['heading', 'Heading'], ['subheading', 'Subheading'], ['paragraph', 'Paragraph'], ['offer', 'Offer'], ['cta', 'CTA'], ['generic-text', 'Text']] },
  { group: 'Image', roles: [['hero', 'Hero'], ['logo', 'Logo'], ['product', 'Product'], ['generic-image', 'Image']] },
  { group: 'Shape', roles: [['rectangle', 'Rectangle'], ['rounded-rectangle', 'Rounded'], ['circle', 'Circle'], ['ellipse', 'Ellipse'], ['decorative', 'Decoration']] },
];
/** The editable properties that mean something for each element type, with the wording shown to the author. */
const EDITABLE_CHOICES: Record<TemplateElement['type'], [EditableProperty, string][]> = {
  text: [['content', 'Text'], ['color', 'Text colour'], ['backgroundColor', 'Box colour'], ['fontFamily', 'Font'], ['position', 'Position'], ['size', 'Size'], ['rotation', 'Rotation']],
  image: [['image', 'Image'], ['position', 'Position'], ['size', 'Size'], ['rotation', 'Rotation']],
  shape: [['color', 'Colour'], ['position', 'Position'], ['size', 'Size'], ['rotation', 'Rotation']],
  background: [['color', 'Colour'], ['image', 'Image']],
};
const ROLES: Record<TemplateElement['type'], readonly string[]> = { text: TEMPLATE_TEXT_ROLES, image: TEMPLATE_IMAGE_ROLES, shape: TEMPLATE_SHAPE_ROLES, background: ['background'] };
const AUTHOR = () => ({ move: true, resize: true, rotate: true });
/** A percentage typed by the author as the stored fraction: 6 decimals, like every stored normalized value. */
const fraction = (percentage: number) => roundNormalized(percentage / 100);
const FIXED = () => ({ move: false, resize: false, rotate: false });

interface Props {
  template: DesignTemplate;
  /** Already in the library (an edit) or not yet saved (a new template). */
  saved: boolean; dirty: boolean;
  onChange: (template: DesignTemplate) => void; onSave: () => void;
}

/**
 * Template authoring: where a template's geometry is created. The canvas shows the one normalized layout in whichever
 * aspect ratio is being previewed; switching the ratio only changes the canvas it is resolved against.
 */
export function TemplateAuthor({ template, saved, dirty, onChange, onSave }: Props) {
  // The previewed ratio is view state: it is not part of the template and changing it writes nothing.
  const [ratio, setRatio] = useState<DesignAspectRatio>(template.canvas.masterAspectRatio);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const canvas = useMemo(() => designCanvasSize(ratio), [ratio]);
  const resolved = useMemo(() => resolveElements(template.elements, canvas), [template.elements, canvas]);
  const fits = useMemo(() => fitTemplateTexts(resolved), [resolved]);
  const selected = selectedId ? findElement(template, selectedId) : undefined;
  const warnings = [
    ...templateIssues(template).map(issue => issue.message),
    ...resolved.filter((element): element is ResolvedText => element.type === 'text').flatMap(element => textFitWarning(element, fits.get(element.id)!) ?? []),
  ];

  /** Every change goes through the shared, pure editing functions; one that is refused is shown, and nothing changes. */
  const change = (edit: (current: DesignTemplate) => DesignTemplate) => {
    try { onChange(edit(template)); setError(''); return true; }
    catch (problem) { setError(problem instanceof Error ? problem.message : 'That change could not be made.'); return false; }
  };
  const add = (role: TemplateElementRole) => {
    const id = `el-${crypto.randomUUID()}`;
    if (change(current => addElement(current, createTemplateElement(role, id, 0, current.elements.length)))) setSelectedId(id);
  };
  const edit = (id: string, patch: (element: TemplateElement) => TemplateElement) => change(current => updateElement(current, id, patch));
  const layout = (id: string, values: Partial<NormalizedLayout>) => change(current => setElementLayout(current, id, values));
  const remove = (id: string) => { if (change(current => removeElement(current, id))) setSelectedId(null); };
  /** A drag or resize on the canvas: pixels of the previewed canvas in, normalized layout stored, the stored box back. */
  const commit = (id: string, pixels: Partial<PixelBox>): PixelBox | undefined => {
    try {
      const next = commitPixelBox(template, id, pixels, canvas);
      if (next !== template) onChange(next);
      setError('');
      return toPixels(findElement(next, id)!.layout, canvas);
    } catch (problem) { setError(problem instanceof Error ? problem.message : 'That change could not be made.'); return undefined; }
  };
  const hasBackground = template.elements.some(element => element.type === 'background');

  return <div className="tpl-main">
    <div className="tpl-toolbar">
      <label className="tpl-row"><strong>Template name</strong>
        <input type="text" aria-label="Template name" value={template.name} maxLength={200} onChange={event => onChange({ ...template, name: event.target.value })} style={{ width: 220 }} /></label>
      <div className="tpl-row" role="group" aria-label="Aspect preview"><strong>Aspect preview</strong>
        {DESIGN_ASPECT_RATIOS.map(item => <button key={item} type="button" className={`ws-btn ${item === ratio ? 'ws-btn-primary' : ''}`} aria-pressed={item === ratio} onClick={() => setRatio(item)}>{item}</button>)}
        <span className="ws-muted">{canvas.width} × {canvas.height} px</span>
      </div>
      <button type="button" className="ws-btn ws-btn-primary" disabled={!dirty && saved} onClick={onSave} style={{ marginLeft: 'auto' }}>{saved ? dirty ? 'Save Template (new version if the structure changed)' : 'Saved' : 'Save Template'}</button>
      <div className="tpl-row" style={{ flexBasis: '100%' }}>
        {ADDABLE.map(({ group, roles }) => <span key={group} className="tpl-row"><strong>{group}</strong>
          {roles.map(([role, label]) => <button key={role} type="button" className="ws-btn" onClick={() => add(role)}>+ {label}</button>)}</span>)}
        <button type="button" className="ws-btn" disabled={hasBackground} title={hasBackground ? 'This template has a background; select it to change it.' : undefined} onClick={() => add('background')}>+ Background</button>
      </div>
      {error && <div role="alert" className="ws-error-text" style={{ flexBasis: '100%' }}>{error}</div>}
    </div>
    <div className="tpl-work">
      <div className="tpl-stage" tabIndex={0} aria-label="Template canvas" onKeyDown={(event) => {
        if (event.target !== event.currentTarget || !selected) return;
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(selected.id); }
        if (event.key === 'Escape') setSelectedId(null);
      }}>
        <TemplateCanvas elements={resolved} fits={fits} canvas={canvas} selectedId={selectedId} onSelect={setSelectedId} onCommit={commit}
          allows={element => element.type === 'background' ? FIXED() : AUTHOR()} />
        {!template.elements.length && <p className="tpl-empty">Add a background, text, images and shapes with the buttons above, then drag and resize them here.</p>}
      </div>
      <aside className="tpl-panel" aria-label="Element properties">
        <Section title="Supported in creatives" note="(the same layout in each)">
          <div className="tpl-row">{DESIGN_ASPECT_RATIOS.map(item => <label key={item} className="tpl-check"><input type="checkbox" checked={template.supportedAspectRatios.includes(item)}
            // The master ratio, the one the template was designed in, is always supported.
            disabled={item === template.canvas.masterAspectRatio}
            onChange={event => onChange({ ...template, supportedAspectRatios: DESIGN_ASPECT_RATIOS.filter(other => other === item ? event.target.checked : template.supportedAspectRatios.includes(other)) })} /> {item}</label>)}</div>
        </Section>
        <Section title="Layers" note="(front first)">
          {template.elements.length ? <ul className="tpl-layers">{[...template.elements].reverse().map(element => <li key={element.id}>
            <button type="button" className={element.id === selectedId ? 'is-on' : ''} onClick={() => setSelectedId(element.id)}><span>{element.name || element.role}</span><span className="ws-muted">{element.role} · z{element.zIndex}{element.visible === false ? ' · hidden' : ''}</span></button></li>)}</ul>
            : <p className="ws-muted">No elements yet.</p>}
        </Section>
        {warnings.length > 0 && <Section title="Warnings">{warnings.map(warning => <p key={warning} className="ws-warn">{warning}</p>)}</Section>}
        {selected ? <ElementProperties key={selected.id} element={selected} template={template} ratio={ratio} edit={patch => edit(selected.id, patch)} layout={values => layout(selected.id, values)}
          reorder={move => change(current => reorderElement(current, selected.id, move))} remove={() => remove(selected.id)} />
          : <p className="ws-muted">Select an element on the canvas or in the layer list to edit its content, style, editable properties and layout.</p>}
      </aside>
    </div>
  </div>;
}

/** Writes part of an element's style, behaviour, content or editable properties, leaving the rest as it is. */
const patchOf = (part: 'style' | 'behavior' | 'defaultContent' | 'editableProperties', values: Record<string, unknown>) =>
  (element: TemplateElement) => ({ ...element, [part]: { ...element[part], ...values } }) as TemplateElement;

function ElementProperties({ element, template, ratio, edit, layout, reorder, remove }: {
  element: TemplateElement; template: DesignTemplate; ratio: DesignAspectRatio; edit: (patch: (element: TemplateElement) => TemplateElement) => void;
  layout: (values: Partial<NormalizedLayout>) => void; reorder: (move: 'forward' | 'backward' | 'front' | 'back') => void; remove: () => void;
}) {
  const style = (values: Record<string, unknown>) => edit(patchOf('style', values));
  const behavior = (values: Record<string, unknown>) => edit(patchOf('behavior', values));
  const content = (values: Record<string, unknown>) => edit(patchOf('defaultContent', values));
  const isBackground = element.type === 'background', l = element.layout;
  const px = toPixels(l, designCanvasSize(ratio));
  const fitControls = (element.type === 'image' || element.type === 'background') && <>
    <Select label="Fit" value={element.behavior.fit} options={['cover', 'contain'] as const} onChange={fit => behavior({ fit })} />
    <NumberInput label="Focal X" suffix="%" min={0} max={100} step={5} digits={1} value={element.behavior.focalX * 100} onChange={value => behavior({ focalX: fraction(value) })} />
    <NumberInput label="Focal Y" suffix="%" min={0} max={100} step={5} digits={1} value={element.behavior.focalY * 100} onChange={value => behavior({ focalY: fraction(value) })} />
  </>;
  return <>
    <Section title={`${element.type[0].toUpperCase()}${element.type.slice(1)} element`}>
      <Field label="Name"><input type="text" value={element.name} maxLength={200} onChange={event => edit(current => ({ ...current, name: event.target.value }))} /></Field>
      {!isBackground && <Select label="Role" value={element.role} options={ROLES[element.type]} onChange={role => edit(current => ({ ...current, role }) as TemplateElement)} />}
      {/* Hidden elements keep their place in the template and are not drawn; visible ones carry no flag. */}
      {!isBackground && <Field label="Visible"><input type="checkbox" checked={element.visible !== false} onChange={event => edit((current) => {
        const { visible: _visible, ...rest } = current; void _visible;
        return (event.target.checked ? rest : { ...rest, visible: false }) as TemplateElement;
      })} /></Field>}
    </Section>

    <Section title="Content" note="(the default; a creative may replace it where allowed)">
      {element.type === 'text' && <Field label="Text"><textarea rows={3} value={element.defaultContent.text} maxLength={5000} onChange={event => content({ text: event.target.value })} /></Field>}
      {element.type === 'image' && <ImagePicker label="Image" assetId={element.defaultContent.assetId} onChange={assetId => content({ assetId })} />}
      {element.type === 'shape' && <p className="ws-muted">A shape has no content.</p>}
      {element.type === 'background' && <>
        <ColorInput label="Colour" value={element.defaultContent.color} onChange={color => content({ color })} />
        <ImagePicker label="Image" assetId={element.defaultContent.assetId} onChange={assetId => content({ assetId })} />
      </>}
    </Section>

    <Section title="Style">
      {element.type === 'text' && <>
        <Select label="Font" value={element.style.fontFamily} options={TEXT_FONTS.includes(element.style.fontFamily as typeof TEXT_FONTS[number]) ? TEXT_FONTS : [...TEXT_FONTS, element.style.fontFamily]} onChange={fontFamily => style({ fontFamily })} />
        {/* Font sizes are fractions of the canvas short edge, shown as a percentage of it. */}
        <NumberInput label="Font size" suffix="% of short edge" min={0.75} max={45} step={0.25} value={element.style.fontSize * 100}
          onChange={value => edit(current => current.type === 'text' ? { ...current, style: { ...current.style, fontSize: fraction(value) }, behavior: { ...current.behavior, minFontSize: Math.min(current.behavior.minFontSize, fraction(value)) } } : current)} />
        <Select label="Weight" value={element.style.fontWeight} options={TEXT_WEIGHTS} onChange={fontWeight => style({ fontWeight })} />
        <ColorInput label="Colour" value={element.style.color} onChange={color => style({ color })} />
        <Select label="Align" value={element.style.align} options={['left', 'center', 'right'] as const} onChange={align => style({ align })} />
        <Select label="Vertical" value={element.style.verticalAlign} options={['top', 'middle', 'bottom'] as const} onChange={verticalAlign => style({ verticalAlign })} />
        <NumberInput label="Line height" min={0.5} max={4} step={0.05} value={element.style.lineHeight} onChange={lineHeight => style({ lineHeight: roundNormalized(lineHeight) })} />
        <NumberInput label="Letter spacing" suffix="em" min={-0.5} max={2} step={0.01} value={element.style.letterSpacing} onChange={letterSpacing => style({ letterSpacing: roundNormalized(letterSpacing) })} />
        <Field label="Box behind text"><input type="checkbox" checked={element.style.backgroundColor !== null} onChange={event => style({ backgroundColor: event.target.checked ? '#285443' : null })} /></Field>
        {element.style.backgroundColor !== null && <>
          <ColorInput label="Box colour" value={element.style.backgroundColor} onChange={backgroundColor => style({ backgroundColor })} />
          <NumberInput label="Box corners" suffix="%" min={0} max={100} step={5} digits={0} value={element.style.cornerRadius * 100} onChange={value => style({ cornerRadius: fraction(value) })} />
        </>}
      </>}
      {element.type === 'image' && <>
        {fitControls}
        <NumberInput label="Corners" suffix="%" min={0} max={100} step={5} digits={0} value={element.style.cornerRadius * 100} onChange={value => style({ cornerRadius: fraction(value) })} />
        <NumberInput label="Opacity" suffix="%" min={0} max={100} step={5} digits={0} value={element.style.opacity * 100} onChange={value => style({ opacity: fraction(value) })} />
      </>}
      {element.type === 'shape' && <>
        <ColorInput label="Fill" value={element.style.fill} onChange={fill => style({ fill })} />
        <NumberInput label="Opacity" suffix="%" min={0} max={100} step={5} digits={0} value={element.style.opacity * 100} onChange={value => style({ opacity: fraction(value) })} />
        {(element.role === 'rounded-rectangle' || element.role === 'decorative') && <NumberInput label="Corners" suffix="%" min={0} max={100} step={5} digits={0} value={element.style.cornerRadius * 100} onChange={value => style({ cornerRadius: fraction(value) })} />}
        <Field label="Outline"><input type="checkbox" checked={element.style.stroke !== null} onChange={event => style(event.target.checked ? { stroke: '#1F2925', strokeWidth: 0.004 } : { stroke: null, strokeWidth: 0 })} /></Field>
        {element.style.stroke !== null && <>
          <ColorInput label="Outline colour" value={element.style.stroke} onChange={stroke => style({ stroke })} />
          <NumberInput label="Outline width" suffix="% of short edge" min={0} max={20} step={0.1} value={element.style.strokeWidth * 100} onChange={value => style({ strokeWidth: fraction(value) })} />
        </>}
      </>}
      {element.type === 'background' && fitControls}
    </Section>

    {element.type === 'text' && <Section title="Overflow" note="(longer text never moves or resizes the box)">
      <NumberInput label="Max lines" min={1} max={50} step={1} digits={0} value={element.behavior.maxLines} onChange={value => behavior({ maxLines: Math.round(value) })} />
      <Select label="When too long" value={element.behavior.overflow} options={[{ value: 'shrink', label: 'Shrink, then ellipsis' }, { value: 'ellipsis', label: 'Ellipsis' }] as const} onChange={overflow => behavior({ overflow })} />
      {element.behavior.overflow === 'shrink' && <NumberInput label="Smallest size" suffix="% of short edge" min={0.25} max={element.style.fontSize * 100} step={0.25} value={element.behavior.minFontSize * 100} onChange={value => behavior({ minFontSize: fraction(value) })} />}
    </Section>}

    <Section title="Editable in creatives" note="(everything unticked is locked)">
      <div className="tpl-row">{EDITABLE_CHOICES[element.type].map(([property, label]) => <label key={property} className="tpl-check">
        <input type="checkbox" checked={element.editableProperties[property]} onChange={event => edit(patchOf('editableProperties', { [property]: event.target.checked }))} /> {label}</label>)}</div>
    </Section>

    <Section title="Layer order">
      <div className="tpl-row"><span>z-index <strong>{element.zIndex}</strong> of {template.elements.length - 1}</span>
        {isBackground ? <span className="ws-muted">The background is always at the bottom.</span>
          : (['back', 'backward', 'forward', 'front'] as const).map(move => <button key={move} type="button" className="ws-btn" onClick={() => reorder(move)}>{{ back: 'To back', backward: 'Backward', forward: 'Forward', front: 'To front' }[move]}</button>)}</div>
    </Section>

    <Section title="Layout" note="(normalized: % of the canvas)">
      {isBackground ? <p className="ws-muted">The background always covers the whole canvas.</p> : <>
        <NumberInput label="X" suffix="% of width" min={0} max={100} step={0.5} value={l.x * 100} onChange={value => layout({ x: value / 100 })} />
        <NumberInput label="Y" suffix="% of height" min={0} max={100} step={0.5} value={l.y * 100} onChange={value => layout({ y: value / 100 })} />
        <NumberInput label="Width" suffix="% of width" min={0.5} max={100} step={0.5} value={l.width * 100} onChange={value => layout({ width: value / 100 })} />
        <NumberInput label="Height" suffix="% of height" min={0.5} max={100} step={0.5} value={l.height * 100} onChange={value => layout({ height: value / 100 })} />
        <NumberInput label="Rotation" suffix="°" min={-180} max={180} step={1} value={l.rotation} onChange={rotation => layout({ rotation })} />
      </>}
      <pre className="tpl-debug" data-testid="layout-debug">{`x: ${percent(l.x)}\ny: ${percent(l.y)}\nw: ${percent(l.width)}\nh: ${percent(l.height)}\nrotation: ${l.rotation}°\nzIndex: ${element.zIndex}`}</pre>
      <details><summary>The same layout in every ratio ({ratio}: {px.x.toFixed(1)}, {px.y.toFixed(1)} · {px.width.toFixed(1)} × {px.height.toFixed(1)} px)</summary>
        <table className="tpl-ratios"><thead><tr><th>Ratio</th><th>Canvas</th><th>x</th><th>y</th><th>w</th><th>h</th></tr></thead><tbody>
          {DESIGN_ASPECT_RATIOS.map((item) => {
            const size = designCanvasSize(item), box = toPixels(l, size);
            return <tr key={item}><td>{item}</td><td>{size.width}×{size.height}</td><td>{box.x.toFixed(1)}</td><td>{box.y.toFixed(1)}</td><td>{box.width.toFixed(1)}</td><td>{box.height.toFixed(1)}</td></tr>;
          })}
          <tr><td colSpan={2}>% of canvas</td><td>{percent(l.x)}</td><td>{percent(l.y)}</td><td>{percent(l.width)}</td><td>{percent(l.height)}</td></tr>
        </tbody></table>
      </details>
    </Section>

    <button type="button" className="ws-btn ws-btn-danger" onClick={remove}>Remove element</button>
  </>;
}
