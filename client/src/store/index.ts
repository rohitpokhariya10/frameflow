import { combineReducers, configureStore, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { createDocument, generatedDesignApplied, adaptedDesignApplied } from './editorSlice';
import { uiSlice, variantSelected } from './uiSlice';
import { historyReducer, initialHistory, undo, redo } from './history';
import { saveSlice } from './saveSlice';
import { aiSlice, adaptationIsCurrent } from './aiSlice';
import { projectReset } from './projectReset';
import { decompositionSlice } from './decompositionSlice';

const combined = combineReducers({ editor: historyReducer, ui: uiSlice.reducer, save: saveSlice.reducer, ai: aiSlice.reducer, decomposition: decompositionSlice.reducer });
function reducer(state: ReturnType<typeof combined> | undefined, action: UnknownAction) {
  if (projectReset.match(action)) return { ...freshState(action.payload), save: { ...saveSlice.getInitialState(), status: 'saved' as const } };
  if (state && generatedDesignApplied.match(action) && action.payload.preview.sourceVersion !== state.editor.version) return state;
  if (state && variantSelected.match(action) && !state.editor.document.variants.some((item) => item.id === action.payload)) return state;
  if (state && adaptedDesignApplied.match(action) && !adaptationIsCurrent(action.payload.preview, state.editor.document, state.editor.version, state.ui.activeVariantId, state.ui.selectionVersion)) return state;
  let next = combined(state, action);
  if (state && next.editor.document !== state.editor.document) {
    const restored = next.editor.document.variants.find((item) => !state.editor.document.variants.some((old) => old.id === item.id));
    const previous = state.editor.document.variants.find((item) => item.id === state.ui.activeVariantId);
    const activeVariantId = restored?.id ?? (next.editor.document.variants.some((item) => item.id === state.ui.activeVariantId) ? state.ui.activeVariantId
      : next.editor.document.variants.find((item) => item.id === previous?.sourceVariantId)?.id ?? next.editor.document.variants[0].id);
    if (activeVariantId !== next.ui.activeVariantId) next = { ...next, ui: { ...next.ui, activeVariantId, selectedElementId: null, fitRequest: next.ui.fitRequest + 1, selectionVersion: next.ui.selectionVersion + 1 } };
  }
  if ((undo.match(action) || redo.match(action)) && next.ui.selectedElementId) {
    const variant = next.editor.document.variants.find((item) => item.id === next.ui.activeVariantId) ?? next.editor.document.variants[0];
    if (!variant.elements.some((item) => item.id === next.ui.selectedElementId)) {
      return { ...next, ui: { ...next.ui, selectedElementId: null } };
    }
  }
  return next;
}

const freshState = (document: ReturnType<typeof createDocument>) => ({ editor: initialHistory(document), ui: { ...uiSlice.getInitialState(), activeVariantId: document.variants[0].id }, save: saveSlice.getInitialState(), ai: aiSlice.getInitialState(), decomposition: decompositionSlice.getInitialState() });
export const createEditorStore = (document = createDocument(crypto.randomUUID(), new Date().toISOString())) => configureStore({
  reducer,
  preloadedState: freshState(document),
});
export type EditorStore = ReturnType<typeof createEditorStore>;
export type RootState = ReturnType<EditorStore['getState']>;
export type AppDispatch = EditorStore['dispatch'];
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const selectDocument = (state: RootState) => state.editor.document;
export const selectActiveVariant = (state: RootState) =>
  state.editor.document.variants.find((variant) => variant.id === state.ui.activeVariantId) ?? state.editor.document.variants[0];
export const selectSelectedText = (state: RootState) =>
  selectActiveVariant(state).elements.find((element) => element.id === state.ui.selectedElementId) ?? null;
