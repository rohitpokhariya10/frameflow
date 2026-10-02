/** Session-only history of canonical documents. Images remain asset IDs, never binary copies. */
export const TEMPLATE_HISTORY_LIMIT = 50;
export interface TemplateHistory<T> {
  past: T[]; present: T; future: T[]; group: string | null; session: number;
}
export type HistoryAction<T> =
  | { type: 'edit'; value: T; group?: string; session: number }
  | { type: 'reset'; value: T }
  | { type: 'replace'; value: T }
  | { type: 'end-group' }
  | { type: 'undo' | 'redo'; restore?: (next: T, current: T) => T };
export const initialTemplateHistory = <T>(value: T): TemplateHistory<T> => ({ past: [], present: structuredClone(value), future: [], group: null, session: 0 });

export function templateHistoryReducer<T>(state: TemplateHistory<T>, action: HistoryAction<T>): TemplateHistory<T> {
  if (action.type === 'reset') return { ...initialTemplateHistory(action.value), session: state.session + 1 };
  if (action.type === 'replace') return { ...state, present: structuredClone(action.value), group: null };
  if (action.type === 'end-group') return state.group ? { ...state, group: null } : state;
  if (action.type === 'edit') {
    // An upload or other async callback from a closed editing session cannot restore that session.
    if (action.session !== state.session || JSON.stringify(action.value) === JSON.stringify(state.present)) return state;
    const grouped = action.group !== undefined && action.group === state.group && !state.future.length;
    return { ...state, past: grouped ? state.past : [...state.past, state.present].slice(-TEMPLATE_HISTORY_LIMIT),
      present: structuredClone(action.value), future: [], group: action.group ?? null };
  }
  const next = action.type === 'undo' ? state.past.at(-1) : state.future[0];
  if (!next) return state;
  const present = action.restore ? action.restore(next, state.present) : next;
  return action.type === 'undo'
    ? { ...state, present, past: state.past.slice(0, -1), future: [state.present, ...state.future].slice(0, TEMPLATE_HISTORY_LIMIT), group: null }
    : { ...state, present, past: [...state.past, state.present].slice(-TEMPLATE_HISTORY_LIMIT), future: state.future.slice(1), group: null };
}
