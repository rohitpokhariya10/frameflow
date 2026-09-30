import { Frame, MousePointer2, Undo2, Redo2, X } from 'lucide-react';
import { useAppSelector, useAppDispatch, selectActiveVariant, selectSelectedText } from '../../store';
import { DesignName } from './DesignName';
import { ResizableDesignPanel } from './ResizableDesignPanel';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { TextInspector } from '../text/TextInspector';
import { useTextActions } from '../text/useTextActions';
import { historyKey, selectionKey } from './selectionKeyboard';
import { undo, redo } from '../../store/history';
import { recoveryWarningChanged } from '../../store/saveSlice';
import { ExportButton } from '../export/ExportButton';
import { LayerInspector, LayersList } from '../layers/LayerInspector';
import { DetectedLayersTray } from '../decomposition/DetectedLayersTray';

export function EditorShell({ onNewDesign }: { onNewDesign: () => void }) {
  const variant = useAppSelector(selectActiveVariant);
  const { canvas, id: variantId } = variant;
  const selectedId = useAppSelector((state) => state.ui.selectedElementId);
  const adapting = useAppSelector((state) => Boolean(state.ai.preview?.adaptation));
  const preview = useAppSelector((state) => state.ui.activeLeftTab === 'ai' && Boolean(state.ai.preview));
  const selected = useAppSelector((state) => preview ? undefined : selectSelectedText(state));
  const selectedLayer = preview ? undefined : variant.layers?.find((layer) => layer.id === selectedId);
  const actions = useTextActions();
  const dispatch = useAppDispatch();
  const canUndo = useAppSelector((state) => state.editor.past.length > 0);
  const canRedo = useAppSelector((state) => state.editor.future.length > 0);
  const save = useAppSelector((state) => state.save);
  return (
    <div className="editor-shell" onKeyDown={(event) => {
      const history = historyKey(event);
      if (history) { event.preventDefault(); dispatch(history === 'undo' ? undo() : redo()); return; }
      const command = selectionKey(event);
      if (command === 'deselect' && selectedLayer) { event.preventDefault(); actions.select(null); return; }
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
        <DesignName />
        <span className="topbar-dimensions" data-testid="canvas-dimensions">{canvas.width} × {canvas.height} <span>px</span></span>
        <div className="topbar-actions">
          <div className="history-controls" role="group" aria-label="Document history">
            <button className="icon-button" aria-label="Undo" title="Undo (⌘/Ctrl Z)" disabled={!canUndo} onClick={() => dispatch(undo())}><Undo2 size={16} /></button>
            <button className="icon-button" aria-label="Redo" title="Redo (⌘/Ctrl Shift Z)" disabled={!canRedo} onClick={() => dispatch(redo())}><Redo2 size={16} /></button>
          </div>
          <span className={`save-status save-${save.status}`} role="status" aria-live="polite" title={save.status === 'error' ? 'Keep this tab open. Check browser storage, then edit to retry saving.' : 'Saved only in this browser. Export a PNG to keep a copy.'}><span />{{ saving: 'Saving…', saved: 'Saved on this device', error: 'Could not save' }[save.status]}</span>
          <ExportButton />
        </div>
      </header>
      {save.warning && <div className="recovery-warning" role="alert"><span>{save.warning} New edits will replace the saved design.</span><button className="icon-button" aria-label="Dismiss recovery warning" onClick={() => dispatch(recoveryWarningChanged(''))}><X size={14} /></button></div>}
      <div className="editor-body">
        <ResizableDesignPanel onNewDesign={onNewDesign} />
        <CanvasWorkspace />
        <aside className={`properties-panel ${selected || selectedLayer ? 'has-selection' : ''}`} aria-label="Properties">
          {selectedLayer ? <><LayerInspector key={`${variantId}-${selectedLayer.id}`} variant={variant} layer={selectedLayer} /><LayersList variant={variant} selectedId={selectedId} /><DetectedLayersTray variant={variant} /></> : selected ? <><TextInspector key={`${variantId}-${selected.id}`} element={selected} /><LayersList variant={variant} selectedId={selectedId} /><DetectedLayersTray variant={variant} /></> : <>
          <div className="panel-heading"><h2>Properties</h2><span className="subtle-label">No selection</span></div>
          <div className="properties-empty">
            <div className="selection-hint" aria-hidden="true"><span /><MousePointer2 size={22} strokeWidth={1.4} /></div>
            <h3>{preview ? 'Review your design' : 'Select an element'}</h3>
            <p>{preview ? `Use this ${adapting ? 'version' : 'design'} from the AI panel, then select any text to edit its wording and layout.` : 'Select text on the canvas or in the Text tab to edit its content, typography and layout.'}</p>
          </div>
          {!preview && <><LayersList variant={variant} selectedId={selectedId} /><DetectedLayersTray variant={variant} /></>}
          <div className="panel-footnote"><span className="tiny-frame" aria-hidden="true" /><p>A little space.<br />A lot of possibility.</p></div>
          </>}
        </aside>
      </div>
      <div className="mobile-notice">A little more room to create.<span>Open FrameFlow on a desktop, or widen your window to edit.</span></div>
    </div>
  );
}
