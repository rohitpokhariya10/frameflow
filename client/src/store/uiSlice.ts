import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { VIEWPORT } from '../features/canvas/viewport';

export type LeftTab = 'design' | 'text' | 'ai';
interface UiState {
  activeLeftTab: LeftTab;
  zoom: number;
  selectedElementId: string | null;
  activeVariantId: string;
  fitRequest: number;
  selectionVersion: number;
  aiMode: 'generate' | 'adapt';
}
const initialState: UiState = {
  activeLeftTab: 'design', zoom: 1, selectedElementId: null, activeVariantId: 'original', fitRequest: 0, selectionVersion: 0, aiMode: 'generate',
};
export const uiSlice = createSlice({
  name: 'ui', initialState,
  reducers: {
    variantSelected(state, action: PayloadAction<string>) {
      if (state.activeVariantId === action.payload) return;
      state.activeVariantId = action.payload; state.selectedElementId = null; state.selectionVersion++; state.fitRequest++;
    },
    aiModeChanged(state, action: PayloadAction<'generate' | 'adapt'>) { state.aiMode = action.payload; },
    elementSelected(state, action: PayloadAction<string | null>) { state.selectedElementId = action.payload; },
    tabChanged(state, action: PayloadAction<LeftTab>) { state.activeLeftTab = action.payload; },
    zoomChanged(state, action: PayloadAction<number>) {
      if (Number.isFinite(action.payload)) state.zoom = Math.max(VIEWPORT.minZoom, Math.min(VIEWPORT.maxZoom, action.payload));
    },
    fitRequested(state) { state.fitRequest += 1; },
  },
});
export const { tabChanged, zoomChanged, fitRequested, elementSelected, variantSelected, aiModeChanged } = uiSlice.actions;
