import { describe, expect, it, vi } from 'vitest';
import { TEXT_LIMITS, type CreativeShape, type CreativeText } from '@frameflow/shared';
import { isProjectDocument } from '../../lib/persistence/schema';
import { createEditorStore, selectActiveVariant } from '../../store';
import { canvasResized, layerImageReplaced, layerUpdated, textUpdated } from '../../store/editorSlice';
import { creativeRunDocument, creativeRunSource, isCreativeRun, type CreativeRun } from './creativeRun';

// No DOM here: text is measured with creativeText's own fallback (no canvas).
vi.stubGlobal('document', { createElement: () => ({ getContext: () => null }) });
const text = (id: string, value: string, x: number, baselineY: number, over: Partial<CreativeText> = {}): CreativeText => ({
  id, wordId: null, groupId: 'cg-0000000001', line: 0, order: 0, text: value, x, baselineY, rotation: 0,
  style: { fontFamily: 'Poppins', fontWeight: 700, fontStyle: 'normal', fontSize: 120, letterSpacing: 0, color: '#123456', opacity: 1 }, hidden: false, locked: false, z: 20, ...over,
});
const plate: CreativeShape = { id: 'cs-0000000001', plateId: null, groupId: 'cg-0000000001', box: { x: 100, y: 900, width: 600, height: 140, rotation: 0 }, fill: '#ffcc00', stroke: null, radius: 30, hidden: false, z: 10 };
const placement = (x: number, y: number, width: number, height: number, kind: 'full-canvas' | 'bbox-crop' = 'bbox-crop') => ({ kind, x, y, width, height });
function fixture(fontSize = 120): CreativeRun {
  const texts = [text('ct-0000000001', 'Easy', 120, 400, { style: { ...text('', '', 0, 0).style, fontSize } }), text('ct-0000000002', 'EMI', 120, 640), text('ct-0000000003', 'later', 120, 800, { hidden: true })];
  const files = ['layer-00-background.png', 'layer-01-shape.png', 'layer-02-logo.png', 'layer-03-text.png', 'layer-04-artwork.png', 'layer-05-artwork.png'];
  return {
    id: '2026-10-20T17-47-13-590Z-eb72d9', stage: 'done', createdAt: '2026-10-20T17:47:13.590Z', warnings: [], timings: {}, seedream: { endpoint: 'local' },
    original: { file: 'original.png', width: 1820, height: 2420 }, input: { file: 'input.png', width: 1820, height: 2420, orientationNormalized: false }, canvas: { width: 1820, height: 2420 },
    origin: { kind: 'master-creative', generationId: 'pt-d974dae2d503', variantId: 'cr-1dd7f87c41f5' }, editorLayerFiles: files,
    layers: [placement(0, 0, 1820, 2420, 'full-canvas'), placement(100, 900, 600, 140), placement(1300, 2100, 400, 160), placement(118, 280, 420, 400), placement(194, 246, 1494, 2051), placement(1406, 199, 391, 621)].map((p, i) => ({ index: i, file: files[i], zIndex: i, name: ['Background base', 'Shape · offer', 'HDFC Bank', 'Text · Easy EMI', 'Border', 'Artwork · top right'][i], pixelWidth: p.width, pixelHeight: p.height, opaquePercent: 50, placement: p })),
    creative: { masterId: 'pt-d974dae2d503', masterRevision: 1, creativeId: 'cr-1dd7f87c41f5', creativeRevision: 3, name: 'Tall Tropic', canvas: { width: 1820, height: 2420 }, texts, shapes: [plate], groups: [{ id: 'cg-0000000001', label: 'Easy EMI', category: 'headline', masterGroupId: null, align: 'left' }], aiGenerated: true,
      artwork: { method: 'local', objects: 2, behindPercent: 12, trustedPercent: 40, durationMs: 9000 },
      layers: [{ file: files[0], kind: 'background', elementIds: ['ci-0000000009'], hidden: false, z: -1 }, { file: files[4], kind: 'artwork', elementIds: ['ci-0000000009'], hidden: false, z: -1 },
        { file: files[5], kind: 'artwork', elementIds: ['ci-0000000009'], hidden: false, z: -1 }, { file: files[1], kind: 'shape', elementIds: [plate.id], hidden: false, z: 10 },
        { file: files[2], kind: 'image', elementIds: ['ci-0000000001'], hidden: false, z: 15 }, { file: files[3], kind: 'text', elementIds: ['ct-0000000001', 'ct-0000000002'], hidden: false, z: 20 }] },
  } as CreativeRun;
}
function deps(fail?: string) {
  const assets = new Map<string, Blob>(), fetched: string[] = []; let n = 0;
  return { assets, fetched, deps: { file: async (name: string) => { if (name === fail) throw new Error('Could not load a saved layer.'); fetched.push(name); return new Blob([name], { type: 'image/png' }); },
    assets: { putAsset: async (id: string, b: Blob) => { assets.set(id, b); }, deleteAsset: async (id: string) => { assets.delete(id); } }, newId: () => `id${n++}`, now: () => '2026-10-21T12:00:00.000Z' } };
}

describe('a creative sent to decomposition, in the editor', () => {
  it('opens its pictures as layers and its texts and plates as native text and shapes, at the creative’s own size and order', async () => {
    const run = fixture(), d = deps(), doc = await creativeRunDocument(run, d.deps), v = doc.variants[0];
    expect(isCreativeRun(run)).toBe(true);
    expect(isProjectDocument(JSON.parse(JSON.stringify(doc)))).toBe(true);
    // Its own size: the export is 1820 × 2420.
    expect(v.canvas).toMatchObject({ width: 1820, height: 2420 });
    // Only the pictures are fetched: the text layer's picture is never imported.
    expect(d.fetched).toEqual(['layer-00-background.png', 'layer-04-artwork.png', 'layer-05-artwork.png', 'layer-02-logo.png']);
    expect(d.assets.size).toBe(4);
    const [background, border, corner, logo, shape] = v.layers!;
    expect(background).toMatchObject({ type: 'image', name: 'Background base', x: 0, y: 0, width: 1820, height: 2420, locked: true, zIndex: -1000 });
    // The artwork's objects: free picture layers at their places, above the base and below every element of the creative.
    expect(border).toMatchObject({ type: 'image', name: 'Border', x: 194, y: 246, width: 1494, height: 2051, locked: false, zIndex: -999, role: 'generic-image' });
    expect(corner).toMatchObject({ type: 'image', name: 'Artwork · top right', x: 1406, y: 199, locked: false, zIndex: -998 });
    expect(logo).toMatchObject({ type: 'image', name: 'HDFC Bank', x: 1300, y: 2100, width: 400, height: 160, locked: false, zIndex: 15, fit: 'contain' });
    expect(shape).toMatchObject({ type: 'shape', x: 100, y: 900, width: 600, height: 140, fill: '#ffcc00', radius: 30, zIndex: 10 });
    expect(v.elements.map(e => [e.type, e.text, e.fill, e.zIndex, e.visible ?? true])).toEqual([['text', 'Easy', '#123456', 20, true], ['text', 'EMI', '#123456', 20, true], ['text', 'later', '#123456', 20, false]]);
    expect(v.elements.every(e => e.x === 120 && !e.protectedSlot)).toBe(true);
    // A design of its own: it names the run it came from and is linked to no creative (saving never writes to it).
    expect(v.importedFrom).toEqual(creativeRunSource(run));
    expect(v.importedFrom).toEqual({ templateId: 'pt-d974dae2d503', resultId: `run-${run.id}`, runId: run.id });
    expect(v.creative).toBeUndefined();
    expect(v.sourceSize).toBeUndefined();
  });
  it('is edited like any design: text, a moved logo and a replaced logo', async () => {
    const doc = await creativeRunDocument(fixture(), deps().deps), s = createEditorStore(doc), variantId = doc.variants[0].id, at = '2026-10-21T12:00:01.000Z';
    const logo = doc.variants[0].layers!.find(l => l.name === 'HDFC Bank')!, corner = doc.variants[0].layers!.find(l => l.name === 'Artwork · top right')!;
    s.dispatch(textUpdated({ variantId, id: doc.variants[0].elements[1].id, changes: { text: 'No-cost EMI' }, timestamp: at }));
    s.dispatch(layerUpdated({ variantId, id: logo.id, changes: { x: 1200 }, timestamp: at }));
    s.dispatch(layerImageReplaced({ variantId, id: logo.id, assetId: 'new-bank-logo', timestamp: at }));
    // An object of the artwork moves and hides like any picture.
    s.dispatch(layerUpdated({ variantId, id: corner.id, changes: { x: 1300, visible: false }, timestamp: at }));
    const v = selectActiveVariant(s.getState()), moved = v.layers!.find(l => l.id === logo.id)!;
    expect(v.elements[1].text).toBe('No-cost EMI');
    expect(moved).toMatchObject({ x: 1200, y: 2100, assetId: 'new-bank-logo' });
    expect(v.layers!.find(l => l.id === corner.id)).toMatchObject({ x: 1300, y: 199, visible: false });
  });
  it('scales the design down when a text is larger than the editor takes, and removes what it stored when a layer cannot be read', async () => {
    const big = await creativeRunDocument(fixture(1400), deps().deps), v = big.variants[0];
    expect(v.canvas.width).toBeLessThan(1820);
    expect(Math.max(...v.elements.map(e => e.fontSize))).toBeLessThanOrEqual(TEXT_LIMITS.maxFontSize);
    // The export still draws at the creative's own size.
    expect(v.sourceSize).toEqual({ width: 1820, height: 2420, scale: v.canvas.width / 1820 });
    expect(isProjectDocument(JSON.parse(JSON.stringify(big)))).toBe(true);
    const s = createEditorStore(big);
    s.dispatch(canvasResized({ variantId: v.id, size: { width: 1080, height: 1080 }, timestamp: '2026-10-21T12:00:03.000Z' }));
    expect(selectActiveVariant(s.getState()).sourceSize).toBeUndefined();
    const d = deps('layer-02-logo.png');
    await expect(creativeRunDocument(fixture(), d.deps)).rejects.toThrow('Could not load a saved layer.');
    expect(d.assets.size).toBe(0);
  });
});
