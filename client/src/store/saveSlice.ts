import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { SaveStatus } from '../lib/persistence/projectStorage';

export const saveSlice = createSlice({
  name: 'save', initialState: { status: 'saving' as SaveStatus, warning: '' },
  reducers: {
    saveStatusChanged(state, action: PayloadAction<SaveStatus>) { state.status = action.payload; },
    recoveryWarningChanged(state, action: PayloadAction<string>) { state.warning = action.payload; },
  },
});
export const { saveStatusChanged, recoveryWarningChanged } = saveSlice.actions;
