import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { DecompositionClientContext, DecompositionJobSummary } from '@frameflow/shared';

interface DecompositionState {
  context: DecompositionClientContext | null;
  job: DecompositionJobSummary | null;
  error: string;
}
const initialState: DecompositionState = { context: null, job: null, error: '' };
export const decompositionSlice = createSlice({ name: 'decomposition', initialState, reducers: {
  attached(_state, action: PayloadAction<DecompositionClientContext>): DecompositionState {
    return { context: action.payload, job: null, error: '' };
  },
  received(state, action: PayloadAction<{ token: string; job: DecompositionJobSummary }>) {
    if (state.context?.operationToken !== action.payload.token) return;
    if (state.job?.id === action.payload.job.id && state.job.revision > action.payload.job.revision) return;
    state.job = action.payload.job; state.error = '';
  },
  failed(state, action: PayloadAction<{ token: string; message: string }>) {
    if (state.context?.operationToken === action.payload.token) state.error = action.payload.message;
  },
  detached: () => initialState,
} });
export const decompositionActions = decompositionSlice.actions;

export function decompositionContextMatches(context: DecompositionClientContext, projectId: string, variantId: string, revision: number, assetId?: string) {
  return context.projectId === projectId && context.variantId === variantId && context.variantRevision === revision && context.sourceAssetId === assetId;
}
