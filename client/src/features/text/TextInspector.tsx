import { productWordModeChanged } from '../../store/uiSlice';
import { AlignCenter, AlignLeft, AlignRight, Copy, Italic, Lock, ShieldCheck, Trash2, Unlock, X } from 'lucide-react';
import { useState } from 'react';
import { catalogFont, OFFER_FONT_FAMILIES, offerHasItalic, offerWeights, PROTECTED_KIND_LABELS, TEXT_FONTS, TEXT_LIMITS, TEXT_STYLE_LIMITS, TEXT_WEIGHTS, type TextChanges, type TextElement } from '@frameflow/shared';
import { selectActiveVariant, useAppSelector, useAppDispatch } from '../../store';
import { endTextSession } from '../../store/history';
import { textGroupMoved, textGroupUpdated, textPhraseEdited } from '../../store/editorSlice';
import { NumberField } from '../../components/ui/NumberField';
import { FontPicker } from '../fonts/FontPicker';
import { focusCanvas, useTextActions } from './useTextActions';
import { AutoLayoutControl } from './AutoLayoutControl';
import { measuredWords } from './measuredWords';

const isText = (e: { type: string }): e is TextElement => e.type === 'text';

const hexId = (prefix: string) => `${prefix}-${Array.from(crypto.getRandomValues(new Uint8Array(5)), b => b.toString(16).padStart(2, '0')).join('')}`;
/**
 * A word of a protected template's phrase: change the whole phrase at once (style, lock, position, its words), or this word
 * alone with the controls below. Every change is one undo step.
 */
function PhraseTools({ element }: { element: TextElement }) {
  const dispatch = useAppDispatch(), variant = useAppSelector(selectActiveVariant), word = element.protectedSlot!.word!;
  const words = variant.elements.filter(e => e.protectedSlot?.word?.groupId === word.groupId).sort((a, b) => a.protectedSlot!.word!.order - b.protectedSlot!.word!.order);
  const phrase = words.map(w => w.text).join(' ');
  const [draft, setDraft] = useState<string | null>(null);
  const at = () => new Date().toISOString(), group = (changes: TextChanges) => {
    const measured = variant.productTemplate ? measuredWords(words.filter(isText).map(w => ({ element: w, changes }))) : undefined;
    dispatch(textGroupUpdated({ variantId: variant.id, groupId: word.groupId, changes, timestamp: at(), ...(measured ? { measured } : {}) }));
  };
  const move = (dx: number, dy: number) => dispatch(textGroupMoved({ variantId: variant.id, groupId: word.groupId, dx, dy, timestamp: at() }));
  const allLocked = words.every(w => w.locked), protectedWords = words.filter(w => w.protectedSlot?.word?.protected);
  return <section className="inspector-section phrase-tools" aria-label="Phrase">
    <div className="inspector-section-title"><h3>Phrase</h3><span>{words.length} word{words.length === 1 ? '' : 's'}</span></div>
    <label className="control-label" htmlFor="phrase-text">Edit the phrase</label>
    <textarea id="phrase-text" aria-label="Phrase text" rows={2} value={draft ?? phrase} maxLength={TEXT_LIMITS.maxCharacters} onChange={e => setDraft(e.target.value)} />
    {protectedWords.length > 0 && <p className="inspector-hint" data-testid="protected-words">Contains protected {[...new Set(protectedWords.map(w => w.protectedSlot!.word!.role ?? 'text'))].join(', ')} text ({protectedWords.map(w => `“${w.text}”`).join(', ')}). Changing it changes the offer: check it is still correct.</p>}
    <div className="phrase-actions">
      <button className="button" disabled={draft === null || !draft.trim() || draft.trim() === phrase} onClick={() => {
        const tokens = draft!.split(/\s+/).filter(Boolean), count = tokens.length;
        const measured = variant.productTemplate ? measuredWords(words.filter(isText).slice(0, count).map((w, i) => ({ element: w, changes: { text: tokens[i] } }))) : undefined;
        dispatch(textPhraseEdited({ variantId: variant.id, groupId: word.groupId, text: draft!, newIds: Array.from({ length: Math.max(0, count - words.length) }, () => ({ element: crypto.randomUUID(), word: hexId('pw') })), timestamp: at(), ...(measured ? { measured } : {}) }));
        setDraft(null);
      }}>Apply to phrase</button>
      <button className="button" aria-pressed={allLocked} onClick={() => group({ locked: !allLocked })}>{allLocked ? <Unlock size={13} /> : <Lock size={13} />}{allLocked ? 'Unlock phrase' : 'Lock phrase'}</button>
    </div>
    <div className="phrase-actions" role="group" aria-label="Move the phrase">
      {([['←', -8, 0, 'left'], ['→', 8, 0, 'right'], ['↑', 0, -8, 'up'], ['↓', 0, 8, 'down']] as const).map(([label, dx, dy, dir]) => <button key={dir} className="button" aria-label={`Move phrase ${dir}`} disabled={allLocked} onClick={() => move(dx, dy)}>{label}</button>)}
    </div>
    <div className="phrase-actions">
      <button className="button" title="Use this word's font, weight, colour and style for the whole phrase" onClick={() => group({ fontFamily: element.fontFamily, fontWeight: element.fontWeight, fill: element.fill, fontStyle: element.fontStyle ?? 'normal', opacity: element.opacity ?? 1 })}>Match phrase to this word</button>
    </div>
  </section>;
}

export function TextInspector({ element }: { element: TextElement }) {
  const actions = useTextActions();
  const wordMode = useAppSelector(s => s.ui.productWordMode);
  const dispatch = useAppDispatch();
  const variant = useAppSelector(selectActiveVariant), count = variant.elements.length;
  // A creative of a master template draws only offer fonts (real bundled files, the same in preview, editor and export),
  // in the weights each has files for; other designs keep the editor's fonts and the whole catalogue.
  const offer = !!variant.creative, families = offer ? OFFER_FONT_FAMILIES : TEXT_FONTS, weights = offer ? offerWeights(element.fontFamily) : TEXT_WEIGHTS;
  return <>
    <div className="panel-heading"><h2>Text properties</h2><button className="icon-button" aria-label="Deselect text" title="Deselect (Escape)" onClick={() => { actions.select(null); focusCanvas(); }}><X size={15} /></button></div>
    <div className="text-inspector">
      {/* Only a protected slot's text opens locked, so its lock lives here; every other text's controls are unchanged. */}
      {element.protectedSlot && <div className="inspector-hint protected-slot-note" data-testid="protected-slot"><ShieldCheck size={13} aria-hidden="true" /> Protected {PROTECTED_KIND_LABELS[element.protectedSlot.kind].toLowerCase()} slot from a protected template. Change the text here; the slot keeps its place. {element.locked ? 'Locked on the canvas: unlock it to move or resize it.' : ''}
        <button className="button protected-slot-lock" aria-pressed={!!element.locked} title={element.locked ? 'Unlock to move or resize on the canvas' : 'Lock its position and size on the canvas'} onClick={() => actions.update(element.id, { locked: !element.locked })}>{element.locked ? <Unlock size={13} /> : <Lock size={13} />}{element.locked ? 'Unlock' : 'Lock'}</button></div>}
      {variant.productTemplate && element.protectedSlot?.word && <button className="button" aria-pressed={wordMode} onClick={() => dispatch(productWordModeChanged(!wordMode))}>{wordMode ? 'Select headline group' : 'Edit words individually'}</button>}
      {element.protectedSlot?.word && <PhraseTools key={element.protectedSlot.word.groupId} element={element} />}
      <section className="inspector-section">
        <div className="inspector-section-title"><label htmlFor="text-content">Content</label><span>{element.role === 'custom' ? 'Text' : element.role}</span></div>
        <textarea id="text-content" aria-label="Text content" value={element.text} maxLength={TEXT_LIMITS.maxCharacters}
          spellCheck={false} placeholder="Write something…" onBlur={() => dispatch(endTextSession())} onChange={(event) => actions.update(element.id, { text: event.target.value })} />
        <div className="content-caption"><span>Line breaks stay exactly as typed.</span><span>{element.text.length}/{TEXT_LIMITS.maxCharacters}</span></div>
        {/* A text opened from a template keeps its fixed box and overflow rules; they shape how it is drawn, never what is stored. */}
        {element.height !== undefined && <p className="inspector-hint" data-testid="text-box-rules">Fixed text box{element.maxLines ? `, up to ${element.maxLines} ${element.maxLines === 1 ? 'line' : 'lines'}` : ''}. Text that does not fit is {element.overflow === 'shrink' && element.minFontSize !== undefined ? `drawn smaller, down to ${Math.round(element.minFontSize * 10) / 10} px, then ` : ''}ended with an ellipsis on the canvas. The text here is always kept whole.{element.rotation ? ` Rotated ${element.rotation}°.` : ''}</p>}
      </section>
      <section className="inspector-section">
        <h3>Typography</h3>
        <label className="control-label" htmlFor="font-family">Font family</label>
        <select id="font-family" value={element.fontFamily} onChange={(event) => {
          const fontFamily = event.target.value, available = offer ? offerWeights(fontFamily) : TEXT_WEIGHTS;
          const fontWeight = (available as readonly number[]).includes(element.fontWeight) ? element.fontWeight : available[available.length - 1] as TextElement['fontWeight'];
          actions.update(element.id, { fontFamily, fontWeight, ...(offer && element.fontStyle === 'italic' && !offerHasItalic(fontFamily) ? { fontStyle: 'normal' as const } : {}) });
        }}>
          {!families.some(font => font === element.fontFamily) && <option value={element.fontFamily}>{element.fontFamily}</option>}
          {families.map((font) => <option key={font} value={font}>{font}{offer ? '' : font === 'Lora' ? ' · Editorial serif' : ' · Sans serif'}</option>)}
        </select>
        {/* Every family of the licensed catalogue (open-licensed Google Fonts); only a chosen family downloads. Not for a
            creative of a master template, which keeps to its offer fonts. */}
        {offer ? <p className="inspector-hint">Offer fonts: bundled font files, drawn identically in the content preview, the editor and the export.</p>
          : <FontPicker value={element.fontFamily} onChange={(fontFamily) => actions.update(element.id, { fontFamily, ...(element.fontStyle === 'italic' && !catalogFont(fontFamily)?.italic ? { fontStyle: 'normal' as const } : {}) })} recommendationLabel="Editor fonts" recommended={TEXT_FONTS} heading={null} />}
        <div className="inspector-row typography-row">
          <NumberField label="Font size" value={element.fontSize} min={TEXT_LIMITS.minFontSize} max={TEXT_LIMITS.maxFontSize} onEndSession={() => dispatch(endTextSession())} onCommit={(fontSize, session) => actions.update(element.id, { fontSize }, session)} />
          <div><label className="control-label" htmlFor="font-weight">Weight</label><select id="font-weight" value={element.fontWeight} onChange={(event) => actions.update(element.id, { fontWeight: Number(event.target.value) as TextElement['fontWeight'] })}>
            {weights.map((weight) => <option key={weight} value={weight}>{weight === 400 ? 'Regular' : weight === 600 ? 'Semibold' : 'Bold'}</option>)}
          </select></div>
        </div>
        <div className="inspector-row typography-row">
          <div><span className="control-label" id="text-style-label">Style</span>
            <button className="button" aria-labelledby="text-style-label" aria-pressed={element.fontStyle === 'italic'} disabled={offer && element.fontStyle !== 'italic' && !offerHasItalic(element.fontFamily)} title={offer && !offerHasItalic(element.fontFamily) ? `${element.fontFamily} has no italic file` : catalogFont(element.fontFamily)?.italic ? 'Italic' : `${element.fontFamily} has no italic; the browser slants it`}
              onClick={() => actions.update(element.id, { fontStyle: element.fontStyle === 'italic' ? 'normal' : 'italic' })}><Italic size={14} />Italic</button></div>
          <NumberField label="Opacity (%)" value={Math.round((element.opacity ?? 1) * 100)} min={0} max={100} onEndSession={() => dispatch(endTextSession())} onCommit={(v, session) => actions.update(element.id, { opacity: Math.round(v) / 100 }, session)} />
        </div>
        <div className="inspector-row typography-row">
          <NumberField label="Letter spacing" value={element.letterSpacing} min={-TEXT_STYLE_LIMITS.maxLetterSpacing} max={TEXT_STYLE_LIMITS.maxLetterSpacing} onEndSession={() => dispatch(endTextSession())} onCommit={(letterSpacing, session) => actions.update(element.id, { letterSpacing }, session)} />
          <NumberField label="Line height" value={element.lineHeight} min={TEXT_STYLE_LIMITS.minLineHeight} max={TEXT_STYLE_LIMITS.maxLineHeight} onEndSession={() => dispatch(endTextSession())} onCommit={(lineHeight, session) => actions.update(element.id, { lineHeight }, session)} />
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
        <div className="inspector-section-title"><h3>Layout</h3><span>Canvas pixels</span></div>
        <div className="inspector-row geometry-row">
          <NumberField label="X" value={element.x} onEndSession={() => dispatch(endTextSession())} onCommit={(x, session) => actions.move(element, { x, y: element.y }, session)} />
          <NumberField label="Y" value={element.y} onEndSession={() => dispatch(endTextSession())} onCommit={(y, session) => actions.move(element, { x: element.x, y }, session)} />
          <NumberField label="Text box width" value={element.width} min={TEXT_LIMITS.minWidth} max={TEXT_LIMITS.maxWidth} onEndSession={() => dispatch(endTextSession())} onCommit={(width, session) => actions.resize(element, width, session)} />
          <NumberField label="Rotation (°)" value={element.rotation ?? 0} min={-360} max={360} onEndSession={() => dispatch(endTextSession())} onCommit={(rotation, session) => actions.update(element.id, { rotation }, session)} />
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
