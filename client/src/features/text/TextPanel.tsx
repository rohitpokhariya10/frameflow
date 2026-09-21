import { Heading1, Heading2, Pilcrow, Type } from 'lucide-react';
import { TEXT_LIMITS } from '@frameflow/shared';
import { selectActiveVariant, useAppSelector } from '../../store';
import { useTextActions } from './useTextActions';

export function TextPanel() {
  const { elements } = useAppSelector(selectActiveVariant);
  const selectedId = useAppSelector((state) => state.ui.selectedElementId);
  const actions = useTextActions();
  const atLimit = elements.length >= TEXT_LIMITS.maxElements;
  return <div className="text-tools-panel">
    <div className="section-intro"><span className="eyebrow">GIVE YOUR IDEA A VOICE</span><h2>Words with presence.</h2><p>A headline. A detail. Your story.</p></div>
    <div className="section-label"><h3>Add text</h3></div>
    <div className="text-insert-actions">
      <button disabled={atLimit} onClick={() => actions.add('heading')}><Heading1 size={19} /><span className="heading-preview">Add heading</span></button>
      <button disabled={atLimit} onClick={() => actions.add('subheading')}><Heading2 size={18} /><span className="subheading-preview">Add subheading</span></button>
      <button disabled={atLimit} onClick={() => actions.add('body')}><Pilcrow size={17} /><span>Add body text</span></button>
    </div>
    {atLimit && <p className="field-error" role="status">This frame has reached its {TEXT_LIMITS.maxElements}-element limit.</p>}
    <div className="section-label elements-heading"><h3>Elements</h3><span>{elements.length}</span></div>
    {elements.length === 0 ? <p className="elements-empty">Your text will appear here.<br />Select any element to make it yours.</p> :
      <ul className="text-elements" aria-label="Text elements" data-selection-owner>
        {elements.map((element) => <li key={element.id}>
          <button aria-pressed={element.id === selectedId} onClick={() => actions.select(element.id)} title={element.text || 'Empty text'}>
            <Type size={15} /><span><strong>{element.text.trim() || 'Empty text'}</strong><small>{element.role === 'custom' ? 'Text' : element.role}</small></span>
          </button>
        </li>)}
      </ul>}
    <p className="text-panel-hint">Select on the canvas or in this list.<br />Drag to move. Side handles reflow text.</p>
  </div>;
}
