import { configureStore } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';
import { createDocument, editorSlice } from './editorSlice';
import { uiSlice } from './uiSlice';

export const createEditorStore = () => configureStore({
  reducer: { editor: editorSlice.reducer, ui: uiSlice.reducer },
  preloadedState: { editor: { document: createDocument(crypto.randomUUID(), new Date().toISOString()) } },
});
export const store = createEditorStore();
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
export const useAppDispatch = useDispatch.withTypes<AppDispatch>();
export const useAppSelector = useSelector.withTypes<RootState>();
export const selectDocument = (state: RootState) => state.editor.document;
export const selectActiveVariant = (state: RootState) =>
  state.editor.document.variants.find((variant) => variant.id === state.ui.activeVariantId) ?? state.editor.document.variants[0];
export const selectSelectedText = (state: RootState) =>
  selectActiveVariant(state).elements.find((element) => element.id === state.ui.selectedElementId) ?? null;
