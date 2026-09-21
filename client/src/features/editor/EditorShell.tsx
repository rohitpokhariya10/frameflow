import { Download, Frame, MousePointer2 } from 'lucide-react';
import { useAppSelector, selectActiveVariant, selectDocument, selectSelectedText } from '../../store';
import { DesignPanel } from './DesignPanel';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { TextInspector } from '../text/TextInspector';
import { useTextActions } from '../text/useTextActions';
import { selectionKey } from './selectionKeyboard';

export function EditorShell() {
  const document = useAppSelector(selectDocument);
  const { canvas } = useAppSelector(selectActiveVariant);
  const selected = useAppSelector(selectSelectedText);
  const actions = useTextActions();
  return (
    <div className="editor-shell" onKeyDown={(event) => {
      const command = selectionKey(event);
      if (!command || !selected) return;
      event.preventDefault();
      if (command === 'delete') actions.remove(selected.id);
      else actions.select(null);
    }}>
      <header className="topbar">
        <a className="brand" href="/" aria-label="FrameFlow editor">
          <span className="brand-mark"><Frame size={19} strokeWidth={1.7} /></span>
          <span>FrameFlow<span className="brand-dot">.</span></span>
        </a>
        <span className="topbar-divider" />
        <span className="project-name">{document.name}</span>
        <span className="topbar-dimensions" data-testid="canvas-dimensions">{canvas.width} × {canvas.height} <span>px</span></span>
        <div className="topbar-actions">
          <span className="save-status"><span />Not saved yet</span>
          <button className="button export-button" disabled title="PNG export is coming in Milestone 7" aria-label="Export — not yet available">
            <Download size={15} />Export
          </button>
        </div>
      </header>
      <div className="editor-body">
        <DesignPanel />
        <CanvasWorkspace />
        <aside className={`properties-panel ${selected ? 'has-selection' : ''}`} aria-label="Properties">
          {selected ? <TextInspector key={selected.id} element={selected} /> : <>
          <div className="panel-heading"><h2>Properties</h2><span className="subtle-label">No selection</span></div>
          <div className="properties-empty">
            <div className="selection-hint" aria-hidden="true"><span /><MousePointer2 size={22} strokeWidth={1.4} /></div>
            <h3>Select an element</h3>
            <p>Choose a text element on the canvas to edit typography, position and layout.</p>
          </div>
          <div className="panel-footnote"><span className="tiny-frame" aria-hidden="true" /><p>A little space.<br />A lot of possibility.</p></div>
          </>}
        </aside>
      </div>
      <div className="mobile-notice">A little more room to create.<span>Open FrameFlow on a desktop, or widen your window to edit.</span></div>
    </div>
  );
}
