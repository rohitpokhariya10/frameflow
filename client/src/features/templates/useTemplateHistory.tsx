import { useRef, useState, type ChangeEvent, type FocusEvent } from 'react';
import { initialTemplateHistory, templateHistoryReducer, type HistoryAction } from './templateHistory';

/** A focused field is a transaction; unrelated buttons, pointer commits and async uploads are atomic edits. */
export function useTemplateHistory<T>(initial: () => T) {
  const [state, setState] = useState(() => initialTemplateHistory(initial()));
  const focused = useRef<{ target: EventTarget; key: string } | null>(null);
  const changeGroup = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const send = (action: HistoryAction<T>) => setState(current => templateHistoryReducer(current, action));
  const endGroup = () => { changeGroup.current = undefined; send({ type: 'end-group' }); };
  return {
    present: state.present, session: state.session, canUndo: !!state.past.length, canRedo: !!state.future.length,
    edit: (value: T) => send({ type: 'edit', value, session: state.session, group: changeGroup.current }),
    replace: (value: T) => { endGroup(); send({ type: 'replace', value }); },
    reset: (value: T) => { focused.current = null; endGroup(); send({ type: 'reset', value }); },
    undo: (restore?: (next: T, current: T) => T) => { endGroup(); send({ type: 'undo', restore }); },
    redo: (restore?: (next: T, current: T) => T) => { endGroup(); send({ type: 'redo', restore }); },
    fieldEvents: {
      onFocusCapture: (event: FocusEvent) => { focused.current = { target: event.target, key: String(++sequence.current) }; },
      onBlurCapture: () => { focused.current = null; endGroup(); },
      onChangeCapture: (event: ChangeEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement && !['checkbox', 'radio', 'file'].includes(target.type))) return;
        if (focused.current?.target !== target) focused.current = { target, key: String(++sequence.current) };
        changeGroup.current = focused.current.key;
        queueMicrotask(() => { changeGroup.current = undefined; });
      },
    },
  };
}

export interface TemplateHistoryControls { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void }
export function TemplateHistoryButtons({ history }: { history: TemplateHistoryControls }) {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return <span className="tpl-row tpl-history" role="group" aria-label="Template history">
    <button type="button" className="ws-btn" disabled={!history.canUndo} title={mac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)'} onClick={history.undo}>↶ Undo</button>
    <button type="button" className="ws-btn" disabled={!history.canRedo} title={mac ? 'Redo (⌘⇧Z)' : 'Redo (Ctrl+Shift+Z / Ctrl+Y)'} onClick={history.redo}>↷ Redo</button>
  </span>;
}
