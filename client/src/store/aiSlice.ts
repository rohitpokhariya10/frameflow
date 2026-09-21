import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { DesignVariant, StyleBrief } from '@frameflow/shared';
export interface DesignPreview {
  variant: DesignVariant; originalPrompt: string; styleBrief: StyleBrief; unresolved: string[];
  sourceVersion: number; sourceProjectId: string;
}
interface AiState { status: 'idle' | 'generating' | 'ready' | 'error'; requestId: string | null; error: string; preview: DesignPreview | null }
const initialState: AiState = { status: 'idle', requestId: null, error: '', preview: null };
export const aiSlice = createSlice({ name: 'ai', initialState, reducers: {
  generationStarted(_state, action: PayloadAction<string>): AiState { return { status: 'generating', requestId: action.payload, error: '', preview: null }; },
  generationReady(state, action: PayloadAction<{ requestId: string; preview: DesignPreview }>) {
    if (state.requestId !== action.payload.requestId) return;
    state.status = 'ready'; state.preview = action.payload.preview;
  },
  generationFailed(state, action: PayloadAction<{ requestId: string; message: string }>) {
    if (state.requestId !== action.payload.requestId) return;
    state.status = 'error'; state.error = action.payload.message;
  },
  generationCleared: () => initialState,
} });
export const { generationStarted, generationReady, generationFailed, generationCleared } = aiSlice.actions;
