import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { VIEWPORT } from '../features/canvas/viewport';

export type LeftTab = 'design' | 'text' | 'ai';
interface UiState {
  activeLeftTab: LeftTab;
  zoom: number;
  selectedElementId: string | null;
  activeVariantId: string;
  fitRequest: number;
}
const initialState: UiState = {
  activeLeftTab: 'design', zoom: 1, selectedElementId: null, activeVariantId: 'original', fitRequest: 0,
};
export const uiSlice = createSlice({
  name: 'ui', initialState,
  reducers: {
    elementSelected(state, action: PayloadAction<string | null>) { state.selectedElementId = action.payload; },
    tabChanged(state, action: PayloadAction<LeftTab>) { state.activeLeftTab = action.payload; },
    zoomChanged(state, action: PayloadAction<number>) {
      if (Number.isFinite(action.payload)) state.zoom = Math.max(VIEWPORT.minZoom, Math.min(VIEWPORT.maxZoom, action.payload));
    },
    fitRequested(state) { state.fitRequest += 1; },
  },
});
export const { tabChanged, zoomChanged, fitRequested, elementSelected } = uiSlice.actions;
