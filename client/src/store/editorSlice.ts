import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createTextElement, estimateTextWidth, LAYER_LIMITS, TEXT_LIMITS, validTextChanges, validateCanvasSize, type CanvasSize, type DesignLayer, type DesignVariant, type ProjectDocument, type ShapeLayerElement, type TextElement, type TextKind, type TextChanges } from '@frameflow/shared';
import type { DesignPreview } from './aiSlice';
import { isDesignLayer, isProjectDocument, isTextElement } from '../lib/persistence/schema';
import { followLayerOrder, placeAbove, placeAtBottom, placeOnTop } from './stacking';

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

/** How wide a text is drawn (its own style; an estimate the editor and the export share). */
const drawnWidth = (e: TextElement) => estimateTextWidth(e.text, { fontFamily: e.fontFamily, fontSize: e.fontSize, fontWeight: e.fontWeight, fontStyle: e.fontStyle ?? 'normal', letterSpacing: e.letterSpacing });
type LineWord = { el: TextElement; x: number; y: number; width: number };
/**
 * Drawn widths of edited words before and after the change, measured in the browser as the canvas draws them (the
 * estimate above is only within about ±15%: at a headline's size enough to run a longer word into the next one). Words
 * not in it are estimated, the same before and after.
 */
export type MeasuredWords = Record<string, { before: number; after: number }>;
/** The words given, by line, in reading order, with where they are and how wide they are drawn now. */
function lineSnapshot(words: TextElement[], measured?: MeasuredWords): LineWord[][] {
  const lines = new Map<string, LineWord[]>();
  for (const el of words) { const w = el.protectedSlot?.word; if (!w) continue; const k = `${w.groupId}:${w.lineId}`; let l = lines.get(k); if (!l) lines.set(k, l = []); l.push({ el, x: el.x, y: el.y, width: measured?.[el.id]?.before ?? drawnWidth(el) }); }
  return [...lines.values()].map((l) => l.sort((a, b) => a.el.protectedSlot!.word!.order - b.el.protectedSlot!.word!.order));
}
/**
 * Each line's words placed again after their texts or styles changed: the first stays; each next one keeps the gap it had
 * after the one before it (along the line's direction), so a word that grew never runs into the next ("EDITEDwelcome")
 * and one that shrank leaves no hole.
 */
/** Whether a change can change how wide a word is drawn. */
const changesWidth = (c: TextChanges) => typeof c.text === 'string' || c.fontSize !== undefined || c.fontFamily !== undefined || c.fontWeight !== undefined || c.fontStyle !== undefined || c.letterSpacing !== undefined;
function reflowLines(lines: LineWord[][], measured?: MeasuredWords) {
  for (const line of lines) for (let k = 1; k < line.length; k++) {
    const prev = line[k - 1], cur = line[k], a = ((prev.el.rotation ?? 0) * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
    // The gap it had: its old position past the previous word's old end, measured along the line.
    const gap = (cur.x - prev.x) * cos + (cur.y - prev.y) * sin - prev.width, along = (measured?.[prev.el.id]?.after ?? drawnWidth(prev.el)) + gap;
    const across = -(cur.x - prev.x) * sin + (cur.y - prev.y) * cos;
    cur.el.x = prev.el.x + along * cos - across * sin; cur.el.y = prev.el.y + along * sin + across * cos;
  }
}

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
      placeOnTop(variant, variant.elements.at(-1));
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    textUpdated(state, action: PayloadAction<TextTarget & { changes: TextChanges; measured?: MeasuredWords }>) {
      const { variantId, id, changes, timestamp, measured } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const element = variant?.elements.find((item) => item.id === id);
      if (!variant || !element || !validTextChanges(changes)) return;
      if (Object.entries(changes).every(([key, value]) => element[key as keyof TextChanges] === value)) return;
      // A word of a product template's line: the words after it keep their spacing to it (lineSnapshot / reflowLines).
      const word = variant.productTemplate && element.protectedSlot?.word ? element.protectedSlot.word : undefined;
      const lines = word ? lineSnapshot(variant.elements.filter(isTextElement).filter((e) => e.protectedSlot?.word?.groupId === word.groupId && e.protectedSlot.word.lineId === word.lineId), measured) : undefined;
      Object.assign(element, changes);
      if (word && typeof changes.text === 'string') {
        element.width = Math.min(TEXT_LIMITS.maxWidth, Math.max(element.width, (measured?.[element.id]?.after ?? drawnWidth(element)) + element.fontSize * 0.6));
      }
      if (lines && changesWidth(changes)) reflowLines(lines, measured);
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
      const { protectedSlot: _slot, locked: _locked, ...free } = source; void _slot; void _locked;
      variant.elements.push({ ...free, id: newId, x, y });
      placeAbove(variant, variant.elements.at(-1), source.zIndex);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /**
     * Phrase tools: one change for every word of a protected template's phrase (protectedSlot.word.groupId). Only style and
     * lock change here; each word keeps its own text and place.
     */
    textGroupUpdated(state, action: PayloadAction<{ variantId: string; groupId: string; changes: TextChanges; timestamp: string; measured?: MeasuredWords }>) {
      const { variantId, groupId, changes, timestamp, measured } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const words = variant?.elements.filter((item) => item.protectedSlot?.word?.groupId === groupId) ?? [];
      if (!variant || !words.length || 'text' in changes || !validTextChanges(changes)) return;
      // (A phrase in another font or size: its lines keep their spacing, as for one word.)
      const lines = variant.productTemplate && changesWidth(changes) ? lineSnapshot(words.filter(isTextElement), measured) : undefined;
      let changed = false;
      for (const element of words) if (Object.entries(changes).some(([key, value]) => element[key as keyof TextChanges] !== value)) { Object.assign(element, changes); changed = true; }
      if (!changed) return;
      if (lines) reflowLines(lines, measured);
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /** Moves every unlocked word of a phrase by the same offset. */
    textGroupMoved(state, action: PayloadAction<{ variantId: string; groupId: string; dx: number; dy: number; timestamp: string }>) {
      const { variantId, groupId, dx, dy, timestamp } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const words = variant?.elements.filter((item) => item.protectedSlot?.word?.groupId === groupId && !item.locked) ?? [];
      if (!variant || !words.length || !finitePosition({ x: dx, y: dy }) || (dx === 0 && dy === 0)) return;
      for (const element of words) { element.x += dx; element.y += dy; }
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
    /**
     * A phrase typed again: its words in reading order take the new words one by one. Words no longer needed are removed;
     * extra words follow the last one on its line, in its style (an estimate of its width places them; adjust as needed).
     */
    textPhraseEdited(state, action: PayloadAction<{ variantId: string; groupId: string; text: string; newIds: { element: string; word: string }[]; timestamp: string; measured?: MeasuredWords }>) {
      const { variantId, groupId, text, newIds, timestamp, measured } = action.payload;
      const variant = state.document.variants.find((item) => item.id === variantId);
      const words = (variant?.elements.filter((item) => item.protectedSlot?.word?.groupId === groupId) ?? []).sort((a, b) => a.protectedSlot!.word!.order - b.protectedSlot!.word!.order);
      const tokens = text.split(/\s+/).filter(Boolean);
      if (!variant || !words.length || !tokens.length || tokens.some((t) => t.length > 80)) return;
      const extra = tokens.length - words.length;
      if (extra > newIds.length || variant.elements.length + Math.max(0, extra) > TEXT_LIMITS.maxElements) return;
      if (tokens.length === words.length && tokens.every((t, i) => words[i].text === t)) return;
      const lines = lineSnapshot(words, measured);
      tokens.slice(0, words.length).forEach((t, i) => { words[i].text = t; });
      // (Retyped words keep their lines' spacing: a longer one moves the rest of its line, never runs into it.)
      reflowLines(lines.map((l) => l.filter((e) => !words.slice(tokens.length).includes(e.el))), measured);
      const removed = new Set(words.slice(tokens.length).map((w) => w.id));
      if (removed.size) variant.elements = variant.elements.filter((item) => !removed.has(item.id));
      let last = words[Math.min(tokens.length, words.length) - 1];
      for (const [k, t] of tokens.slice(words.length).entries()) {
        const gap = last.fontSize * 0.28, width = estimateTextWidth(last.text, { fontFamily: last.fontFamily, fontSize: last.fontSize, fontWeight: last.fontWeight, fontStyle: last.fontStyle ?? 'normal', letterSpacing: last.letterSpacing });
        const word = { ...last.protectedSlot!.word!, id: newIds[k].word, order: last.protectedSlot!.word!.order + 1 };
        const next: TextElement = { ...last, id: newIds[k].element, text: t, x: last.x + width + gap, name: `Word · ${t}`.slice(0, 200), protectedSlot: { ...last.protectedSlot!, word } };
        variant.elements.push(next);
        placeAbove(variant, variant.elements.at(-1), last.zIndex);
        last = next;
      }
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
      // A copy is a free layer of its own: it is not the protected slot its source fills.
      const { protectedSlot: _slot, ...free } = source; void _slot;
      const copy = { ...free, id: newId, name: `${source.name} copy`.slice(0, 200), x: source.x + 24, y: source.y + 24, locked: false };
      if (!isDesignLayer(copy)) return;
      variant.layers.splice(index + 1, 0, copy);
      placeAbove(variant, variant.layers[index + 1], source.zIndex);
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
      followLayerOrder(variant);
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
      // A copy, so the place it is given in the order is written to the document, not to the dispatched action. A protected
      // slot's text raster becomes the slot's editable text: the slot (and its lock) moves with it.
      const placed = { ...element, ...(layer.protectedSlot ? { protectedSlot: { ...layer.protectedSlot, representation: 'native-text' as const }, locked: layer.locked } : {}) };
      variant.elements.push(placed);
      placeAbove(variant, placed, layer.zIndex);
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
      const placed = { ...layer };
      variant.layers = position === 'bottom' ? [placed, ...layers] : [...layers, placed];
      if (position === 'bottom') placeAtBottom(variant, placed); else placeOnTop(variant, placed);
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
      // A protected slot keeps its place and box; it now holds a picture someone chose, not the template's original.
      const next = { ...rest, assetId, ...(current.protectedSlot ? { protectedSlot: { ...current.protectedSlot, representation: 'source-asset' as const }, name: current.name.replace(/ \((original file|original pixels)\)$/, ' (replaced)') } : {}) };
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
    /** A creative's version was saved to its creative (masterTemplates/): the creative revision it now matches. */
    creativeSynced(state, action: PayloadAction<{ variantId: string; syncedRevision: number; masterRevision?: number }>) {
      const variant = state.document.variants.find((item) => item.id === action.payload.variantId);
      if (!variant?.creative || !Number.isSafeInteger(action.payload.syncedRevision)) return;
      variant.creative = { ...variant.creative, syncedRevision: action.payload.syncedRevision, ...(action.payload.masterRevision ? { masterRevision: action.payload.masterRevision } : {}) };
    },
    canvasResized(state, action: PayloadAction<{ variantId: string; size: CanvasSize; timestamp: string }>) {
      const { variantId, size, timestamp } = action.payload;
      if (!validateCanvasSize(size.width, size.height).valid) return;
      const variant = state.document.variants.find((item) => item.id === variantId);
      if (!variant || (variant.canvas.width === size.width && variant.canvas.height === size.height)) return;
      if (variant.creative?.product) {
        // Fit the entire composition uniformly and centre it. Non-square sizes add margins; raw crops never stretch.
        const factor = Math.min(size.width / variant.canvas.width, size.height / variant.canvas.height,
          TEXT_LIMITS.maxFontSize / Math.max(1, ...variant.elements.map(e => e.fontSize)));
        const dx = (size.width - variant.canvas.width * factor) / 2, dy = (size.height - variant.canvas.height * factor) / 2;
        for (const el of variant.elements) {
          el.x = el.x * factor + dx; el.y = el.y * factor + dy;
          el.width = Math.max(TEXT_LIMITS.minWidth, Math.min(TEXT_LIMITS.maxWidth, el.width * factor));
          el.fontSize *= factor; el.letterSpacing *= factor;
          if (el.height !== undefined) el.height = Math.max(1, el.height * factor);
        }
        for (const layer of variant.layers ?? []) {
          layer.x = layer.x * factor + dx; layer.y = layer.y * factor + dy;
          layer.width = Math.max(1, layer.width * factor); layer.height = Math.max(1, layer.height * factor);
          if (layer.radius !== undefined) layer.radius *= factor;
          if (layer.type === 'shape' && layer.stroke) layer.stroke.width *= factor;
        }
      }
      Object.assign(variant.canvas, { width: size.width, height: size.height });
      // A resized design is no longer its source's shape: it exports at its own canvas size.
      delete variant.sourceSize;
      if (variant.creative?.product) variant.creative.size = { width: Math.round(size.width / variant.creative.scale), height: Math.round(size.height / variant.creative.scale) };
      variant.revision += 1;
      state.document.updatedAt = timestamp;
    },
  },
});
export const { creativeSynced, layerUpdated, layerDeleted, layerDuplicated, layerReordered, layerAdded, layerImageReplaced, canvasBackgroundChanged, decomposedDesignImported, layerConvertedToText, documentRenamed, canvasResized, textAdded, textUpdated, textMoved, textWidthResized, textDuplicated, textDeleted, textGroupUpdated, textGroupMoved, textPhraseEdited, textAutoLayoutApplied, generatedDesignApplied, adaptedDesignApplied } = editorSlice.actions;
