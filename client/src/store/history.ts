import { createAction, type UnknownAction } from '@reduxjs/toolkit';
import type { ProjectDocument } from '@frameflow/shared';
import { editorSlice, textUpdated } from './editorSlice';

export const HISTORY_LIMIT = 30;
export const undo = createAction('history/undo');
export const redo = createAction('history/redo');
export const endTextSession = createAction('history/endTextSession');
export interface HistoryState {
  document: ProjectDocument;
  past: ProjectDocument[];
  future: ProjectDocument[];
  group: { key: string; time: number } | null;
  version: number;
}
export const initialHistory = (document: ProjectDocument): HistoryState => ({ document, past: [], future: [], group: null, version: 0 });

/** Existing document actions remain the only mutation path. Snapshots share unchanged objects. */
export function historyReducer(state: HistoryState = initialHistory(editorSlice.getInitialState().document), action: UnknownAction): HistoryState {
  if (endTextSession.match(action)) return state.group ? { ...state, group: null } : state;
  if (undo.match(action)) {
    const document = state.past.at(-1);
    return document ? { document, past: state.past.slice(0, -1), future: [state.document, ...state.future].slice(0, HISTORY_LIMIT), group: null, version: state.version + 1 } : state;
  }
  if (redo.match(action)) {
    const document = state.future[0];
    return document ? { document, past: [...state.past, state.document].slice(-HISTORY_LIMIT), future: state.future.slice(1), group: null, version: state.version + 1 } : state;
  }
  const { document } = editorSlice.reducer({ document: state.document }, action);
  if (document === state.document) return state;
  // Coalesce only content updates, with a pause boundary and an explicit blur boundary.
  const payload = textUpdated.match(action) ? action.payload : null;
  const group = payload && Object.keys(payload.changes).length === 1 && 'text' in payload.changes
    ? { key: JSON.stringify([payload.variantId, payload.id]), time: Date.parse(payload.timestamp) } : null;
  const coalesce = group && state.group && group.key === state.group.key
    && group.time >= state.group.time && group.time - state.group.time <= 1000 && state.future.length === 0;
  return { document, past: coalesce ? state.past : [...state.past, state.document].slice(-HISTORY_LIMIT), future: [], group, version: state.version + 1 };
}
