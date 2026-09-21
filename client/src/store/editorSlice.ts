import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createTextElement, TEXT_LIMITS, validTextChanges, validateCanvasSize, type CanvasSize, type ProjectDocument, type TextKind, type TextChanges } from '@frameflow/shared';
import type { DesignPreview } from './aiSlice';
import { isProjectDocument } from '../lib/persistence/schema';

interface TextTarget { variantId: string; id: string; timestamp: string; editSession?: string }
const finitePosition = (position: { x: number; y: number }) => Number.isFinite(position.x) && Number.isFinite(position.y);

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
    generatedDesignApplied(state, action: PayloadAction<{ preview: DesignPreview; timestamp: string }>) {
      const { preview, timestamp } = action.payload;
      if (state.document.id !== preview.sourceProjectId) return;
      const index = state.document.variants.findIndex((variant) => variant.id === preview.variant.id);
      if (index < 0) return;
      const document = { ...state.document, originalPrompt: preview.originalPrompt, styleBrief: preview.styleBrief,
        updatedAt: timestamp, variants: state.document.variants.map((variant, i) => i === index ? { ...preview.variant, revision: variant.revision + 1 } : variant) };
      if (isProjectDocument(document)) state.document = document;
    },
    textAutoLayoutApplied(state, action: PayloadAction<TextTarget & { expectedRevision: number; layout: { x: number; y: number; width: number; fontSize: number } }>) {
      const { variantId, id, expectedRevision, layout, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const element = variant?.elements.find((item) => item.id === id);
      if (!variant || !element || variant.revision !== expectedRevision || !finitePosition(layout)
        || !Number.isFinite(layout.width) || layout.width < TEXT_LIMITS.minWidth || layout.width > TEXT_LIMITS.maxWidth
        || !Number.isFinite(layout.fontSize) || layout.fontSize < TEXT_LIMITS.minFontSize || layout.fontSize > element.fontSize) return;
      const { x, y, width, fontSize } = layout;
      if (element.x === x && element.y === y && element.width === width && element.fontSize === fontSize) return;
      Object.assign(element, { x, y, width, fontSize });
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textAdded(state, action: PayloadAction<TextTarget & { kind: TextKind }>) {
      const { variantId, id, kind, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || variant.elements.length >= TEXT_LIMITS.maxElements || variant.elements.some((item) => item.id === id)) return;
      variant.elements.push(createTextElement(kind, variant.canvas, id, variant.elements.length));
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textUpdated(state, action: PayloadAction<TextTarget & { changes: TextChanges }>) {
      const { variantId, id, changes, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const element = variant?.elements.find((item) => item.id === id);
      if (!variant || !element || !validTextChanges(changes)) return;
      if (Object.entries(changes).every(([key, value]) => element[key as keyof TextChanges] === value)) return;
      Object.assign(element, changes);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textMoved(state, action: PayloadAction<TextTarget & { x: number; y: number }>) {
      const { variantId, id, x, y, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const element = variant?.elements.find((item) => item.id === id);
      if (!variant || !element || !finitePosition({ x, y }) || (element.x === x && element.y === y)) return;
      Object.assign(element, { x, y });
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textWidthResized(state, action: PayloadAction<TextTarget & { x: number; y: number; width: number }>) {
      const { variantId, id, x, y, width, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const element = variant?.elements.find((item) => item.id === id);
      if (!variant || !element || !finitePosition({ x, y }) || !Number.isFinite(width) || width < TEXT_LIMITS.minWidth || width > TEXT_LIMITS.maxWidth) return;
      if (element.x === x && element.y === y && element.width === width) return;
      Object.assign(element, { x, y, width });
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textDuplicated(state, action: PayloadAction<TextTarget & { newId: string; x: number; y: number }>) {
      const { variantId, id, newId, x, y, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const source = variant?.elements.find((item) => item.id === id);
      if (!variant || !source || !finitePosition({ x, y }) || variant.elements.length >= TEXT_LIMITS.maxElements || variant.elements.some((item) => item.id === newId)) return;
      variant.elements.push({ ...source, id: newId, x, y });
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textDeleted(state, action: PayloadAction<TextTarget>) {
      const { variantId, id, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || !variant.elements.some((item) => item.id === id)) return;
      variant.elements = variant.elements.filter((item) => item.id !== id);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    canvasResized(state, action: PayloadAction<{ variantId: string; size: CanvasSize; timestamp: string }>) {
      const { variantId, size, timestamp } = action.payload;
      if (!validateCanvasSize(size.width, size.height).valid) return;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || (variant.canvas.width === size.width && variant.canvas.height === size.height)) return;
      Object.assign(variant.canvas, { width: size.width, height: size.height });
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
  },
});
export const { canvasResized, textAdded, textUpdated, textMoved, textWidthResized, textDuplicated, textDeleted, textAutoLayoutApplied, generatedDesignApplied } = editorSlice.actions;
