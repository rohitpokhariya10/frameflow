import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createTextElement, LAYER_LIMITS, TEXT_LIMITS, validTextChanges, validateCanvasSize, type CanvasSize, type DesignLayer, type DesignVariant, type ProjectDocument, type ShapeLayerElement, type TextElement, type TextKind, type TextChanges } from '@frameflow/shared';
import type { DesignPreview } from './aiSlice';
import { isDesignLayer, isProjectDocument, isTextElement } from '../lib/persistence/schema';

interface TextTarget { variantId: string; id: string; timestamp: string; editSession?: string }
interface LayerTarget { variantId: string; id: string; timestamp: string; editSession?: string }
/** Fields a user may change on a layer; type, asset and provenance are immutable. */
export type LayerChanges = Partial<Pick<DesignLayer, 'name' | 'x' | 'y' | 'width' | 'height' | 'rotation' | 'opacity' | 'visible' | 'locked'>> & { fill?: string; radius?: number; stroke?: { color: string; width: number } | null; gradient?: ShapeLayerElement['gradient'] | null };
const finitePosition = (position: { x: number; y: number }) => Number.isFinite(position.x) && Number.isFinite(position.y);
export const DEFAULT_DESIGN_NAME = 'New design';

export function createDocument(id: string, timestamp: string): ProjectDocument {
  return {
    schemaVersion: 1, id, name: DEFAULT_DESIGN_NAME, createdAt: timestamp, updatedAt: timestamp,
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
    documentRenamed(state, action: PayloadAction<{ name: string; timestamp: string }>) {
      const name = action.payload.name.trim() || DEFAULT_DESIGN_NAME;
      if (name.length > 10_000 || name === state.document.name) return;
      state.document.name = name;
      state.document.updatedAt = action.payload.timestamp;
    },
    generatedDesignApplied(state, action: PayloadAction<{ preview: DesignPreview; timestamp: string }>) {
      const { preview, timestamp } = action.payload;
      if (state.document.id !== preview.sourceProjectId) return;
      const index = state.document.variants.findIndex((variant) => variant.id === preview.variant.id);
      if (index < 0) return;
      const document = { ...state.document, originalPrompt: preview.originalPrompt, styleBrief: preview.styleBrief,
        updatedAt: timestamp, variants: state.document.variants.map((variant, i) => i === index ? { ...preview.variant, revision: variant.revision + 1 } : variant) };
      if (isProjectDocument(document)) state.document = document;
    },
    adaptedDesignApplied(state, action: PayloadAction<{ preview: DesignPreview; timestamp: string }>) {
      const { preview, timestamp } = action.payload, source = preview.adaptation?.source;
      const current = state.document.variants.find((item) => item.id === source?.id);
      if (!source || !current || state.document.id !== preview.sourceProjectId || current.revision !== source.revision
        || current.background?.assetId !== source.background?.assetId || preview.variant.sourceVariantId !== current.id
        || state.document.variants.some((item) => item.id === preview.variant.id) || state.document.variants.length >= 30
        || preview.variant.elements.length !== current.elements.length
        || !current.elements.every((element) => preview.variant.elements.some((item) => item.id === element.id && item.text === element.text))) return;
      const document = { ...state.document, updatedAt: timestamp, variants: [...state.document.variants, preview.variant] };
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
    layerUpdated(state, action: PayloadAction<LayerTarget & { changes: LayerChanges }>) {
      const { variantId, id, changes, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const index = variant?.layers?.findIndex((item) => item.id === id) ?? -1;
      if (!variant?.layers || index < 0) return;
      const current = variant.layers[index];
      const { stroke, gradient, fill, radius, ...common } = changes;
      if (current.type === 'image' && (stroke !== undefined || gradient !== undefined || fill !== undefined || radius !== undefined)) return;
      const next = { ...current, ...common, ...(fill !== undefined ? { fill, gradient: undefined } : {}), ...(radius !== undefined ? { radius } : {}) } as DesignLayer & { stroke?: unknown; gradient?: unknown };
      if (stroke === null) delete next.stroke; else if (stroke) next.stroke = stroke;
      if (gradient) next.gradient = gradient;
      if (gradient === null || next.gradient === undefined) delete next.gradient;
      if (!isDesignLayer(next) || JSON.stringify(next) === JSON.stringify(current)) return;
      variant.layers[index] = next;
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    layerDeleted(state, action: PayloadAction<LayerTarget>) {
      const { variantId, id, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant?.layers?.some((item) => item.id === id)) return;
      variant.layers = variant.layers.filter((item) => item.id !== id);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    layerDuplicated(state, action: PayloadAction<LayerTarget & { newId: string }>) {
      const { variantId, id, newId, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const index = variant?.layers?.findIndex((item) => item.id === id) ?? -1;
      if (!variant?.layers || index < 0 || variant.layers.length >= LAYER_LIMITS.maxLayers || variant.layers.some((item) => item.id === newId)) return;
      const source = variant.layers[index];
      const copy = { ...source, id: newId, name: `${source.name} copy`.slice(0, 200), x: source.x + 24, y: source.y + 24, locked: false };
      if (!isDesignLayer(copy)) return;
      variant.layers.splice(index + 1, 0, copy);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    layerReordered(state, action: PayloadAction<LayerTarget & ({ direction: 'forward' | 'backward' } | { toIndex: number })>) {
      const { variantId, id, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const index = variant?.layers?.findIndex((item) => item.id === id) ?? -1;
      const target = 'toIndex' in action.payload ? action.payload.toIndex : action.payload.direction === 'forward' ? index + 1 : index - 1;
      if (!variant?.layers || index < 0 || !Number.isInteger(target) || target < 0 || target >= variant.layers.length || target === index) return;
      const [layer] = variant.layers.splice(index, 1);
      variant.layers.splice(target, 0, layer);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /** A decomposed image becomes a new version: background source, image/shape layers and any text elements. */
    decomposedDesignImported(state, action: PayloadAction<{ variant: DesignVariant; timestamp: string }>) {
      const { variant, timestamp } = action.payload;
      if (state.document.variants.length >= 30 || state.document.variants.some((item) => item.id === variant.id)) return;
      const document = { ...state.document, updatedAt: timestamp, variants: [...state.document.variants, variant] };
      if (isProjectDocument(document)) state.document = document;
    },
    /** Replace a text raster with an editable text element (one undo step); the raster is kept hidden. */
    layerConvertedToText(state, action: PayloadAction<LayerTarget & { element: TextElement }>) {
      const { variantId, id, element, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const layer = variant?.layers?.find((item) => item.id === id);
      if (!variant || !layer || layer.type !== 'image' || !layer.textSuggestion || variant.elements.length >= TEXT_LIMITS.maxElements
        || variant.elements.some((item) => item.id === element.id) || !isTextElement(element)) return;
      variant.elements.push(element);
      layer.visible = false;
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /** Adds a new layer (e.g. a detected layer or a background) at the top, or at the bottom for backgrounds. */
    layerAdded(state, action: PayloadAction<{ variantId: string; layer: DesignLayer; position: 'top' | 'bottom'; timestamp: string }>) {
      const { variantId, layer, position, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const layers = variant?.layers ?? [];
      if (!variant || layers.length >= LAYER_LIMITS.maxLayers || layers.some((item) => item.id === layer.id) || !isDesignLayer(layer)) return;
      variant.layers = position === 'bottom' ? [layer, ...layers] : [...layers, layer];
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /** Swaps an image layer's picture, keeping its position, size, name and provenance. */
    layerImageReplaced(state, action: PayloadAction<LayerTarget & { assetId: string }>) {
      const { variantId, id, assetId, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const index = variant?.layers?.findIndex((item) => item.id === id) ?? -1;
      const current = index >= 0 ? variant!.layers![index] : undefined;
      if (!variant?.layers || current?.type !== 'image' || current.assetId === assetId) return;
      // A replaced picture is no longer the text raster it may have been, so its text suggestion no longer applies.
      const { textSuggestion: _suggestion, ...rest } = current; void _suggestion;
      const next = { ...rest, assetId };
      if (!isDesignLayer(next)) return;
      variant.layers[index] = next;
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /** Transparent (no fill) or a solid colour; the colour is kept while transparent so switching back restores it. */
    canvasBackgroundChanged(state, action: PayloadAction<{ variantId: string; transparent: boolean; color?: string; timestamp: string }>) {
      const { variantId, transparent, color, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || (color !== undefined && !/^#[\da-f]{6}$/i.test(color))) return;
      const { transparent: _was, ...rest } = variant.canvas; void _was;
      const next = { ...rest, backgroundColor: color ?? variant.canvas.backgroundColor, ...(transparent ? { transparent: true } : {}) };
      if (JSON.stringify(next) === JSON.stringify(variant.canvas)) return;
      variant.canvas = next;
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
export const { layerUpdated, layerDeleted, layerDuplicated, layerReordered, layerAdded, layerImageReplaced, canvasBackgroundChanged, decomposedDesignImported, layerConvertedToText, documentRenamed, canvasResized, textAdded, textUpdated, textMoved, textWidthResized, textDuplicated, textDeleted, textAutoLayoutApplied, generatedDesignApplied, adaptedDesignApplied } = editorSlice.actions;
