import { describe, expect, it, vi } from 'vitest';
import type { DesignVariant, SceneGraph, TextElement } from '@frameflow/shared';
import { createEditorStore, selectActiveVariant } from './index';
import { decomposedDesignImported, layerConvertedToText, layerDeleted, layerDuplicated, layerReordered, layerUpdated } from './editorSlice';
import { undo } from './history';
import { variantSelected } from './uiSlice';
import { isProjectDocument } from '../lib/persistence/schema';
import { sceneToVariant } from '../features/decomposition/importScene';

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

  it('removes already stored assets when a download fails, and refuses oversize canvases', async () => {
    const put = vi.fn(async () => undefined), del = vi.fn(async () => undefined);
    await expect(sceneToVariant({ id: 'job', sceneGraph: graph }, async id => { if (id === 'woman-rgba') throw new Error('offline'); return new Blob([id]); }, { putAsset: put, deleteAsset: del })).rejects.toThrow('offline');
    expect(del).toHaveBeenCalledTimes(put.mock.calls.length);
    await expect(sceneToVariant({ id: 'job', sceneGraph: { ...graph, width: 5000 } }, async () => new Blob(), { putAsset: put, deleteAsset: del })).rejects.toThrow(/larger than the editor canvas limit/);
  });
});
