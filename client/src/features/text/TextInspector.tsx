import { AlignCenter, AlignLeft, AlignRight, Copy, Trash2, X } from 'lucide-react';
import { TEXT_FONTS, TEXT_LIMITS, TEXT_WEIGHTS, type TextElement } from '@frameflow/shared';
import { selectActiveVariant, useAppSelector } from '../../store';
import { NumberField } from '../../components/ui/NumberField';
import { focusCanvas, useTextActions } from './useTextActions';
import { AutoLayoutControl } from './AutoLayoutControl';

export function TextInspector({ element }: { element: TextElement }) {
  const actions = useTextActions();
  const count = useAppSelector(selectActiveVariant).elements.length;
  return <>
    <div className="panel-heading"><h2>Text properties</h2><button className="icon-button" aria-label="Deselect text" title="Deselect (Escape)" onClick={() => { actions.select(null); focusCanvas(); }}><X size={15} /></button></div>
    <div className="text-inspector">
      <section className="inspector-section">
        <div className="inspector-section-title"><label htmlFor="text-content">Content</label><span>{element.role === 'custom' ? 'Text' : element.role}</span></div>
        <textarea id="text-content" aria-label="Text content" value={element.text} maxLength={TEXT_LIMITS.maxCharacters}
          spellCheck={false} placeholder="Write something…" onChange={(event) => actions.update(element.id, { text: event.target.value })} />
        <div className="content-caption"><span>Line breaks stay exactly as typed.</span><span>{element.text.length}/{TEXT_LIMITS.maxCharacters}</span></div>
      </section>
      <section className="inspector-section">
        <h3>Typography</h3>
        <label className="control-label" htmlFor="font-family">Font family</label>
        <select id="font-family" value={element.fontFamily} onChange={(event) => actions.update(element.id, { fontFamily: event.target.value })}>
          {TEXT_FONTS.map((font) => <option key={font} value={font}>{font}{font === 'Lora' ? ' · Editorial serif' : ' · Sans serif'}</option>)}
        </select>
        <div className="inspector-row typography-row">
          <NumberField label="Font size" value={element.fontSize} min={TEXT_LIMITS.minFontSize} max={TEXT_LIMITS.maxFontSize} onCommit={(fontSize) => actions.update(element.id, { fontSize })} />
          <div><label className="control-label" htmlFor="font-weight">Weight</label><select id="font-weight" value={element.fontWeight} onChange={(event) => actions.update(element.id, { fontWeight: Number(event.target.value) as TextElement['fontWeight'] })}>
            {TEXT_WEIGHTS.map((weight) => <option key={weight} value={weight}>{weight === 400 ? 'Regular' : weight === 600 ? 'Semibold' : 'Bold'}</option>)}
          </select></div>
        </div>
        <div className="color-alignment-row">
          <div><label className="control-label" htmlFor="text-color">Color</label><div className="color-control"><input id="text-color" type="color" value={element.fill} onChange={(event) => actions.update(element.id, { fill: event.target.value })} /><span>{element.fill.toUpperCase()}</span></div></div>
          <div><span className="control-label" id="alignment-label">Alignment</span><div className="alignment-control" role="group" aria-labelledby="alignment-label">
            {([{ align: 'left', Icon: AlignLeft }, { align: 'center', Icon: AlignCenter }, { align: 'right', Icon: AlignRight }] as const).map(({ align, Icon }) =>
              <button key={align} aria-label={`Align ${align}`} title={`Align ${align}`} aria-pressed={element.align === align} onClick={() => actions.update(element.id, { align })}><Icon size={16} /></button>)}
          </div></div>
        </div>
      </section>
      <section className="inspector-section">
        <div className="inspector-section-title"><h3>Layout</h3><span>Logical pixels</span></div>
        <div className="inspector-row geometry-row">
          <NumberField label="X" value={element.x} onCommit={(x) => actions.move(element, { x, y: element.y })} />
          <NumberField label="Y" value={element.y} onCommit={(y) => actions.move(element, { x: element.x, y })} />
          <NumberField label="Text box width" value={element.width} min={TEXT_LIMITS.minWidth} max={TEXT_LIMITS.maxWidth} onCommit={(width) => actions.resize(element, width)} />
        </div>
        <AutoLayoutControl element={element} />
      </section>
    </div>
    <div className="inspector-actions">
      <button className="button" disabled={count >= TEXT_LIMITS.maxElements} title="Duplicate with a small offset" onClick={() => actions.duplicate(element)}><Copy size={14} />Duplicate</button>
      <button className="button delete-text" onClick={() => actions.remove(element.id)} title="Delete selected text"><Trash2 size={14} />Delete</button>
    </div>
  </>;
}
