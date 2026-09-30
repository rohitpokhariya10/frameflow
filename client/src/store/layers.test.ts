import { describe, expect, it, vi } from 'vitest';
import type { DesignVariant, SceneGraph, TextElement } from '@frameflow/shared';
import { createEditorStore, selectActiveVariant } from './index';
import { canvasBackgroundChanged, decomposedDesignImported, layerAdded, layerConvertedToText, layerDeleted, layerDuplicated, layerImageReplaced, layerReordered, layerUpdated } from './editorSlice';
import { undo } from './history';
import { elementSelected, variantSelected } from './uiSlice';
import { isProjectDocument } from '../lib/persistence/schema';
import { backgroundLayer, sceneToVariant } from '../features/decomposition/importScene';

const t = '2026-09-26T12:00:00.000Z';
const decomposed = (): DesignVariant => ({
  id: 'decomposed-1', name: 'Decomposed design', revision: 0, canvas: { width: 1200, height: 1500, backgroundColor: '#FFFFFF' }, elements: [],
  background: { assetId: 'decomp-bg', fit: 'cover', focalPoint: { x: 0.5, y: 0.5 } },
  layers: [
    { id: 'layer-panel', type: 'shape', name: 'Orange panel', shapeType: 'rounded-rectangle', x: 118, y: 294, width: 667, height: 632, rotation: 0, opacity: 1, visible: true, locked: false, fill: '#ff6a00', gradient: { from: '#ff6a00', to: '#ffb060', angle: 45 }, radius: 60, source: { jobId: 'job', layerId: 'shape-t4', kind: 'shape' } },
    { id: 'layer-pro', type: 'image', name: 'PRO headline', x: 118, y: 54, width: 626, height: 215, rotation: 0, opacity: 1, visible: true, locked: false, assetId: 'decomp-pro', source: { jobId: 'job', layerId: 'text-t3', kind: 'text' }, textSuggestion: { text: 'PRO', confidence: 'low', fill: '#ff7a1a', fontSize: 172, fontWeight: 700 } },
    { id: 'layer-woman', type: 'image', name: 'woman_with_phone', x: 21, y: 151, width: 853, height: 775, rotation: 0, opacity: 1, visible: true, locked: false, assetId: 'decomp-woman', source: { jobId: 'job', layerId: 'image-g', kind: 'image' } },
  ],
});
function imported() {
  const store = createEditorStore();
  store.dispatch(decomposedDesignImported({ variant: decomposed(), timestamp: t }));
  store.dispatch(variantSelected('decomposed-1'));
  return store;
}

describe('editable layers from a decomposed design', () => {
  it('imports as a new valid version, leaving the original untouched', () => {
    const store = imported();
    const document = store.getState().editor.document;
    expect(document.variants.map(v => v.id)).toEqual(['original', 'decomposed-1']);
    expect(isProjectDocument(document)).toBe(true);
    expect(selectActiveVariant(store.getState()).layers?.map(l => l.name)).toEqual(['Orange panel', 'PRO headline', 'woman_with_phone']);
    // Invalid versions are ignored.
    store.dispatch(decomposedDesignImported({ variant: { ...decomposed(), id: 'bad', layers: [{ ...decomposed().layers![2], opacity: 7 }] }, timestamp: t }));
    expect(store.getState().editor.document.variants).toHaveLength(2);
  });

  it('moves, resizes, rotates, fades, hides and locks image layers; recolours and restyles shapes; each step can be undone', () => {
    const store = imported();
    const v = 'decomposed-1';
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-woman', changes: { x: 300, y: 200, width: 426.5, height: 387.5, rotation: -15, opacity: 0.5 }, timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers![2]).toMatchObject({ x: 300, y: 200, width: 426.5, height: 387.5, rotation: -15, opacity: 0.5 });
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-woman', changes: { visible: false, locked: true }, timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers![2]).toMatchObject({ visible: false, locked: true });
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-panel', changes: { fill: '#123456', radius: 12, stroke: { color: '#000000', width: 4 } }, timestamp: t }));
    const panel = selectActiveVariant(store.getState()).layers![0];
    expect(panel).toMatchObject({ fill: '#123456', radius: 12, stroke: { color: '#000000', width: 4 } });
    expect(panel.type === 'shape' && panel.gradient).toBeUndefined();
    // Invalid values and shape-only fields on images are rejected.
    const before = selectActiveVariant(store.getState());
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-woman', changes: { opacity: 2 }, timestamp: t }));
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-woman', changes: { width: -5 }, timestamp: t }));
    store.dispatch(layerUpdated({ variantId: v, id: 'layer-woman', changes: { fill: '#ffffff' }, timestamp: t }));
    expect(selectActiveVariant(store.getState())).toBe(before);
    store.dispatch(undo());
    expect(selectActiveVariant(store.getState()).layers![0]).toMatchObject({ fill: '#ff6a00', radius: 60 });
    expect(isProjectDocument(store.getState().editor.document)).toBe(true);
  });

  it('duplicates, reorders and deletes layers', () => {
    const store = imported();
    const v = 'decomposed-1';
    store.dispatch(layerDuplicated({ variantId: v, id: 'layer-woman', newId: 'layer-copy', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).toEqual(['layer-panel', 'layer-pro', 'layer-woman', 'layer-copy']);
    expect(selectActiveVariant(store.getState()).layers![3]).toMatchObject({ name: 'woman_with_phone copy', x: 45, y: 175, assetId: 'decomp-woman' });
    store.dispatch(layerReordered({ variantId: v, id: 'layer-copy', direction: 'backward', timestamp: t }));
    store.dispatch(layerReordered({ variantId: v, id: 'layer-panel', direction: 'forward', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).toEqual(['layer-pro', 'layer-panel', 'layer-copy', 'layer-woman']);
    store.dispatch(layerDeleted({ variantId: v, id: 'layer-copy', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).toEqual(['layer-pro', 'layer-panel', 'layer-woman']);
  });

  it('moves a dragged layer across the stack in one undo step, retaining the order of other layers', () => {
    const store = imported(), v = 'decomposed-1';
    const original = selectActiveVariant(store.getState());
    store.dispatch(layerReordered({ variantId: v, id: 'layer-panel', toIndex: 2, timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).toEqual(['layer-pro', 'layer-woman', 'layer-panel']);
    expect(selectActiveVariant(store.getState()).revision).toBe(original.revision + 1);
    store.dispatch(undo());
    expect(selectActiveVariant(store.getState())).toEqual(original);
    for (const toIndex of [-1, 3, 0.5, NaN, 0]) store.dispatch(layerReordered({ variantId: v, id: 'layer-panel', toIndex, timestamp: t }));
    expect(selectActiveVariant(store.getState())).toEqual(original);
  });

  it('edits valid gradients with undo, validates stops and angles, and can return to a solid fill', () => {
    const store = imported(), target = { variantId: 'decomposed-1', id: 'layer-panel', timestamp: t };
    const original = selectActiveVariant(store.getState()).layers![0];
    store.dispatch(elementSelected('layer-panel'));
    const gradient = { from: '#123456', to: '#abcdef', angle: -90 };
    store.dispatch(layerUpdated({ ...target, changes: { gradient } }));
    expect(selectActiveVariant(store.getState()).layers![0]).toMatchObject({ gradient });
    expect(isProjectDocument(store.getState().editor.document)).toBe(true);
    const updated = selectActiveVariant(store.getState());
    for (const invalid of [{ ...gradient, from: 'red' }, { ...gradient, angle: 361 }, { ...gradient, angle: NaN }]) {
      store.dispatch(layerUpdated({ ...target, changes: { gradient: invalid } }));
      expect(selectActiveVariant(store.getState())).toBe(updated);
    }
    store.dispatch(undo());
    expect(selectActiveVariant(store.getState()).layers![0]).toEqual(original);
    expect(store.getState().ui.selectedElementId).toBe('layer-panel');
    store.dispatch(layerUpdated({ ...target, changes: { fill: '#123456', gradient: null } }));
    expect(selectActiveVariant(store.getState()).layers![0]).toMatchObject({ fill: '#123456' });
    expect(selectActiveVariant(store.getState()).layers![0]).not.toHaveProperty('gradient');
  });

  it('converts a text raster into an editable text element in one undoable step, keeping the raster hidden', () => {
    const store = imported();
    const element: TextElement = { id: 'text-pro', type: 'text', role: 'custom', text: 'PRO', x: 118, y: 54, width: 626, fontFamily: 'Inter', fontSize: 172, fontWeight: 700, fill: '#ff7a1a', align: 'left', lineHeight: 1.2, letterSpacing: 0 };
    store.dispatch(layerConvertedToText({ variantId: 'decomposed-1', id: 'layer-pro', element, timestamp: t }));
    const variant = selectActiveVariant(store.getState());
    expect(variant.elements).toEqual([element]);
    expect(variant.layers![1]).toMatchObject({ id: 'layer-pro', visible: false });
    // Only text rasters convert.
    store.dispatch(layerConvertedToText({ variantId: 'decomposed-1', id: 'layer-woman', element: { ...element, id: 'text-2' }, timestamp: t }));
    expect(selectActiveVariant(store.getState()).elements).toHaveLength(1);
    store.dispatch(undo());
    expect(selectActiveVariant(store.getState()).elements).toEqual([]);
    expect(selectActiveVariant(store.getState()).layers![1].visible).toBe(true);
  });

  it('keeps older documents valid and rejects malformed layers', () => {
    const store = createEditorStore();
    const document = store.getState().editor.document;
    expect(isProjectDocument(document)).toBe(true);
    const withLayers = { ...document, variants: [decomposed()] };
    expect(isProjectDocument(withLayers)).toBe(true);
    expect(isProjectDocument({ ...document, variants: [{ ...decomposed(), layers: [{ ...decomposed().layers![0], shapeType: 'star' }] }] })).toBe(false);
    expect(isProjectDocument({ ...document, variants: [{ ...decomposed(), layers: [{ ...decomposed().layers![2], assetId: 'blob:http://x' }] }] })).toBe(false);
    expect(isProjectDocument({ ...document, variants: [{ ...decomposed(), layers: [decomposed().layers![2], decomposed().layers![2]] }] })).toBe(false);
  });
});

describe('scene graph import', () => {
  const graph: SceneGraph = { schemaVersion: 1, jobId: 'job', revision: 9, width: 1200, height: 1500, createdAt: t, warnings: [], sourceImage: { artifactId: 'src', originalSha256: 'a', workingMasterSha256: 'b' },
    layers: [
      { id: 'background', type: 'background', name: 'Background', bbox: { x: 0, y: 0, width: 1200, height: 1500 }, zIndex: 0, opacity: 1, rotation: 0, visible: true, locked: true, sourceRevision: 'b', imageArtifactId: 'src', reconstruction: 'original-source', metadata: {} },
      { id: 'shape-a', type: 'shape', name: 'Orange panel', bbox: { x: 118, y: 294, width: 667, height: 632 }, zIndex: 1, opacity: 1, rotation: 0, visible: true, locked: false, sourceRevision: 'r', shapeType: 'rounded-rectangle', fill: '#ff6a00', gradient: { from: '#ff6a00', to: '#ffb060', angle: 45 }, radius: 60, confidence: 0.9, fitIoU: 0.98, rasterArtifactId: 'panel-raster', metadata: {} },
      { id: 'shape-b', type: 'shape', name: 'Texture', bbox: { x: 10, y: 10, width: 50, height: 50 }, zIndex: 2, opacity: 1, rotation: 0, visible: true, locked: false, sourceRevision: 'r', shapeType: 'raster', confidence: 0.2, fitIoU: 0.5, rasterArtifactId: 'texture-raster', metadata: {} },
      { id: 'text-c', type: 'text', name: 'PRO headline', bbox: { x: 118, y: 54, width: 626, height: 215 }, zIndex: 3, opacity: 1, rotation: 0, visible: true, locked: false, sourceRevision: 'r', text: 'PRO', textConfidence: 'low', color: '#ff7a1a', fontSize: 172, fontWeight: 700, confidence: 0.3, rasterArtifactId: 'pro-raster', rasterFallback: true, metadata: {} },
      { id: 'image-d', type: 'image', name: 'woman holding phone', bbox: { x: 21, y: 151, width: 853, height: 775 }, zIndex: 4, opacity: 1, rotation: 0, visible: true, locked: false, sourceRevision: 'r', transparentRgbaArtifactId: 'woman-rgba', maskArtifactId: 'm', alphaArtifactId: 'a', sourcePixelRegion: { x: 21, y: 151, width: 853, height: 775 }, semanticTarget: { id: 'g', label: 'woman holding phone' }, provenance: { maskRevisionId: 'r', alphaRevisionId: 'r', ownership: 'source-semantic', rgb: 'original-source' }, metadata: {} },
    ] };

  it('maps background, vector shapes, raster fallbacks, text rasters with suggestions and image layers in order', async () => {
    let n = 0;
    const put = vi.fn(async () => undefined), del = vi.fn(async () => undefined);
    const fetched: string[] = [];
    const variant = await sceneToVariant({ id: 'job', sceneGraph: graph }, async id => { fetched.push(id); return new Blob([id]); }, { putAsset: put, deleteAsset: del }, () => `id${++n}`);
    expect(fetched).toEqual(['src', 'texture-raster', 'pro-raster', 'woman-rgba']);
    expect(variant.canvas).toMatchObject({ width: 1200, height: 1500 });
    expect(variant.background).toMatchObject({ fit: 'cover' });
    expect(variant.layers!.map(l => [l.name, l.type])).toEqual([['Orange panel', 'shape'], ['Texture', 'image'], ['PRO headline', 'image'], ['woman holding phone', 'image']]);
    expect(variant.layers![0]).toMatchObject({ shapeType: 'rounded-rectangle', gradient: { angle: 45 }, radius: 60, x: 118, y: 294, width: 667, height: 632 });
    expect(variant.layers![2]).toMatchObject({ textSuggestion: { text: 'PRO', confidence: 'low', fill: '#ff7a1a', fontSize: 172, fontWeight: 700 }, source: { kind: 'text' } });
    const store = createEditorStore();
    store.dispatch(decomposedDesignImported({ variant, timestamp: t }));
    expect(store.getState().editor.document.variants).toHaveLength(2);
    expect(del).not.toHaveBeenCalled();
  });

  it('blank canvas: only the separated layers, at their original positions and order, on a transparent canvas — never the original image', async () => {
    let n = 0;
    const fetched: string[] = [];
    const variant = await sceneToVariant({ id: 'job', sceneGraph: graph }, async id => { fetched.push(id); return new Blob([id]); }, { putAsset: vi.fn(async () => undefined), deleteAsset: vi.fn(async () => undefined) }, () => `id${++n}`, { mode: 'blank' });
    expect(fetched).not.toContain('src');
    expect(variant.background).toBeUndefined();
    expect(variant.canvas).toEqual({ width: 1200, height: 1500, backgroundColor: '#FFFFFF', transparent: true });
    expect(variant.decomposition).toEqual({ jobId: 'job', mode: 'blank' });
    expect(variant.layers!.map(l => [l.name, l.x, l.y, l.width, l.height])).toEqual(graph.layers.slice(1).map(l => [l.name, l.bbox.x, l.bbox.y, l.bbox.width, l.bbox.height]));
    expect(variant.layers!.every(l => !l.locked)).toBe(true);
    expect(isProjectDocument({ ...createEditorStore().getState().editor.document, variants: [variant] })).toBe(true);
  });

  it('blank canvas adds the AI-rebuilt background only when asked, as a locked bottom layer; the original mode keeps the original image', async () => {
    const withRebuilt: SceneGraph = { ...graph, layers: [{ ...graph.layers[0], reconstructionCandidateArtifactId: 'rebuilt' } as SceneGraph['layers'][number], ...graph.layers.slice(1)] };
    const fetch = (seen: string[]) => async (id: string) => { seen.push(id); return new Blob([id]); };
    const assets = { putAsset: vi.fn(async () => undefined), deleteAsset: vi.fn(async () => undefined) };
    const without: string[] = [];
    expect((await sceneToVariant({ id: 'job', sceneGraph: withRebuilt }, fetch(without), assets, undefined, { mode: 'blank', includeBackground: false })).layers).toHaveLength(4);
    expect(without).not.toContain('rebuilt');
    const seen: string[] = [];
    const blank = await sceneToVariant({ id: 'job', sceneGraph: withRebuilt }, fetch(seen), assets, undefined, { mode: 'blank', includeBackground: true });
    expect(seen).toContain('rebuilt'); expect(seen).not.toContain('src');
    expect(blank.layers![0]).toMatchObject({ name: 'Background', type: 'image', x: 0, y: 0, width: 1200, height: 1500, locked: true });
    expect(blank.background).toBeUndefined();
    const original = await sceneToVariant({ id: 'job', sceneGraph: withRebuilt }, async id => new Blob([id]), assets, undefined, { mode: 'original' });
    expect(original.background).toMatchObject({ fit: 'cover' });
    expect(original.canvas.transparent).toBeUndefined();
    expect(original.decomposition).toEqual({ jobId: 'job', mode: 'original' });
    expect(original.layers).toHaveLength(4);
  });

  it('removes already stored assets when a download fails, and refuses oversize canvases', async () => {
    const put = vi.fn(async () => undefined), del = vi.fn(async () => undefined);
    await expect(sceneToVariant({ id: 'job', sceneGraph: graph }, async id => { if (id === 'woman-rgba') throw new Error('offline'); return new Blob([id]); }, { putAsset: put, deleteAsset: del })).rejects.toThrow('offline');
    expect(del).toHaveBeenCalledTimes(put.mock.calls.length);
    await expect(sceneToVariant({ id: 'job', sceneGraph: { ...graph, width: 5000 } }, async () => new Blob(), { putAsset: put, deleteAsset: del })).rejects.toThrow(/larger than the editor canvas limit/);
  });
});

describe('adding layers and changing the background', () => {
  function blankEditor() {
    const store = createEditorStore();
    const { background: _original, ...rest } = decomposed(); void _original;
    const variant = { ...rest, canvas: { width: 1200, height: 1500, backgroundColor: '#FFFFFF', transparent: true }, decomposition: { jobId: 'job', mode: 'blank' as const } };
    store.dispatch(decomposedDesignImported({ variant, timestamp: t }));
    store.dispatch(variantSelected(variant.id));
    return store;
  }
  it('adds a detected layer on top or a background at the bottom, as one undoable step', () => {
    const store = blankEditor();
    const phone = { id: 'layer-phone', type: 'image' as const, name: 'Phone', assetId: 'decomp-phone', x: 420, y: 520, width: 360, height: 200, rotation: 0, opacity: 1, visible: true, locked: false, source: { jobId: 'job', layerId: 'detected-target-4', kind: 'image' as const } };
    store.dispatch(layerAdded({ variantId: 'decomposed-1', layer: phone, position: 'top', timestamp: t }));
    store.dispatch(layerAdded({ variantId: 'decomposed-1', layer: backgroundLayer('layer-bg', 'decomp-bg2', 1200, 1500), position: 'bottom', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).toEqual(['layer-bg', 'layer-panel', 'layer-pro', 'layer-woman', 'layer-phone']);
    // Duplicates and malformed layers are refused.
    store.dispatch(layerAdded({ variantId: 'decomposed-1', layer: phone, position: 'top', timestamp: t }));
    store.dispatch(layerAdded({ variantId: 'decomposed-1', layer: { ...phone, id: 'bad', assetId: 'blob:x' }, position: 'top', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers).toHaveLength(5);
    store.dispatch(undo());
    expect(selectActiveVariant(store.getState()).layers!.map(l => l.id)).not.toContain('layer-bg');
  });
  it('switches between transparent and a solid colour, keeping the colour', () => {
    const store = blankEditor();
    store.dispatch(canvasBackgroundChanged({ variantId: 'decomposed-1', transparent: false, color: '#123456', timestamp: t }));
    expect(selectActiveVariant(store.getState()).canvas).toEqual({ width: 1200, height: 1500, backgroundColor: '#123456' });
    store.dispatch(canvasBackgroundChanged({ variantId: 'decomposed-1', transparent: true, timestamp: t }));
    expect(selectActiveVariant(store.getState()).canvas).toEqual({ width: 1200, height: 1500, backgroundColor: '#123456', transparent: true });
    store.dispatch(canvasBackgroundChanged({ variantId: 'decomposed-1', transparent: false, color: 'red', timestamp: t }));
    expect(selectActiveVariant(store.getState()).canvas.transparent).toBe(true);
    expect(isProjectDocument(store.getState().editor.document)).toBe(true);
  });
  it('replaces an image layer\'s picture in place and drops a text suggestion that no longer applies', () => {
    const store = blankEditor();
    store.dispatch(layerImageReplaced({ variantId: 'decomposed-1', id: 'layer-pro', assetId: 'decomp-new', timestamp: t }));
    const layer = selectActiveVariant(store.getState()).layers!.find(l => l.id === 'layer-pro')!;
    expect(layer).toMatchObject({ assetId: 'decomp-new', x: 118, y: 54, width: 626, height: 215, name: 'PRO headline' });
    expect('textSuggestion' in layer).toBe(false);
    store.dispatch(layerImageReplaced({ variantId: 'decomposed-1', id: 'layer-panel', assetId: 'decomp-x', timestamp: t }));
    expect(selectActiveVariant(store.getState()).layers!.find(l => l.id === 'layer-panel')).not.toHaveProperty('assetId');
  });
});
