import { combineReducers, configureStore, type UnknownAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { createDocument, generatedDesignApplied } from './editorSlice';
import { uiSlice } from './uiSlice';
import { historyReducer, initialHistory, undo, redo } from './history';
import { saveSlice } from './saveSlice';
import { aiSlice } from './aiSlice';

const combined = combineReducers({ editor: historyReducer, ui: uiSlice.reducer, save: saveSlice.reducer, ai: aiSlice.reducer });
function reducer(state: ReturnType<typeof combined> | undefined, action: UnknownAction) {
  if (state && generatedDesignApplied.match(action) && action.payload.preview.sourceVersion !== state.editor.version) return state;
  const next = combined(state, action);
  if ((undo.match(action) || redo.match(action)) && next.ui.selectedElementId) {
    const variant = next.editor.document.variants.find((item) => item.id === next.ui.activeVariantId) ?? next.editor.document.variants[0];
    if (!variant.elements.some((item) => item.id === next.ui.selectedElementId)) {
      return { ...next, ui: { ...next.ui, selectedElementId: null } };
    }
  }
  return next;
}

export const createEditorStore = (document = createDocument(crypto.randomUUID(), new Date().toISOString())) => configureStore({
  reducer,
  preloadedState: { editor: initialHistory(document), ui: { ...uiSlice.getInitialState(), activeVariantId: document.variants[0].id }, save: saveSlice.getInitialState(), ai: aiSlice.getInitialState() },
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
