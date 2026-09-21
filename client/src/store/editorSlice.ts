import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { validateCanvasSize, type CanvasSize, type ProjectDocument } from '@frameflow/shared';

export function createDocument(id: string, timestamp: string): ProjectDocument {
  return {
    schemaVersion: 1, id, name: 'Untitled design', createdAt: timestamp, updatedAt: timestamp,
    variants: [{
      id: 'original', name: 'Original', revision: 0,
      canvas: { width: 1080, height: 1350, backgroundColor: '#FFFEFA' }, elements: [],
    }],
  };
}

const initialState: { document: ProjectDocument } = { document: createDocument('initial', '1970-01-01T00:00:00.000Z') };

export const editorSlice = createSlice({
  name: 'editor', initialState,
  reducers: {
    canvasResized(state, action: PayloadAction<{ variantId: string; size: CanvasSize; timestamp: string }>) {
      const { variantId, size, timestamp } = action.payload;
      if (!validateCanvasSize(size.width, size.height).valid) return;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || (variant.canvas.width === size.width && variant.canvas.height === size.height)) return;
      Object.assign(variant.canvas, size);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
  },
});
export const { canvasResized } = editorSlice.actions;
