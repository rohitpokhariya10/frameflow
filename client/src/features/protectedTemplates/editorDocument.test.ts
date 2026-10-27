import { describe, expect, it } from 'vitest';
import { boxCorners, type ProtectedElement, type ProtectedTemplateView } from '@frameflow/shared';
import { isProjectDocument } from '../../lib/persistence/schema';
import type { ExperimentRun } from '../decomposition/layerizeExperiment';
import { protectedTemplateDocument, textReplaceable } from './editorDocument';

const element = (id: string, over: Partial<ProtectedElement>): ProtectedElement => ({ id, kind: 'logo', label: id, box: { x: 0, y: 0, width: 10, height: 10, rotation: 0 }, normalized: { x: 0, y: 0, width: 0, height: 0 },
  zIndex: 0, representation: 'raster', mask: { mode: 'difference', threshold: 24 }, locked: true, replaceable: true, origin: 'admin', review: { status: 'approved' }, ...over });
const asset = (file: string, w: number, h: number) => ({ file, sha256: 'a'.repeat(64), mime: 'image/png', width: w, height: h, bytes: 10, hasAlpha: true });
function template(width = 1820, height = 2420): ProtectedTemplateView {
  const s = width / 1820;
  return { schemaVersion: 1, id: 'pt-0123456789ab', name: 'EMI poster', createdAt: '', updatedAt: '', revision: 9, coordinateSystem: 'source-pixels', elementsRevision: 4, layerInstructions: '', runs: [],
    source: { file: 'source.png', inputFile: 'source.png', sha256: '', mime: 'image/png', width, height, bytes: 1, orientationNormalized: false, origin: { kind: 'upload' } },
    elements: [
      element('pe-000000000a', { label: 'Bank A', box: { x: 100 * s, y: 80 * s, width: 400 * s, height: 160 * s, rotation: 0 }, zIndex: 0, representation: 'source-asset', sourceAsset: asset('asset-a.png', 200, 80) }),
      element('pe-000000000b', { label: 'Bank B', box: { x: 600 * s, y: 80 * s, width: 200 * s, height: 200 * s, rotation: 15 }, zIndex: 1, representation: 'raster',
        raster: { ...asset('raster-b.png', 0, 0), placement: { x: Math.floor(573 * s), y: Math.floor(53 * s), width: 254, height: 254 }, opaquePercent: 80, protectedPercent: 80, basisSha256: 'x', maskKey: 'k' } }),
      element('pe-000000000c', { kind: 'text', label: 'Headline', box: { x: 100 * s, y: 400 * s, width: 900 * s, height: 150 * s, rotation: 0 }, zIndex: 2, representation: 'native-text', locked: true,
        text: { value: 'Easy EMI', fontFamily: 'Pine Sans', fallbackFamily: 'Inter', fontSize: 120 * s, fontWeight: 700, lineHeight: 1.1, letterSpacing: 2, align: 'left', verticalAlign: 'top', color: '#ffffff' } }),
      element('pe-000000000d', { kind: 'legal', label: 'Fine print', box: { x: 80 * s, y: 2300 * s, width: 1600 * s, height: 60 * s, rotation: 0 }, zIndex: 3, representation: 'raster',
        raster: { ...asset('raster-d.png', 0, 0), placement: { x: Math.floor(80 * s), y: Math.floor(2300 * s), width: Math.ceil(1600 * s), height: Math.ceil(60 * s) }, opaquePercent: 20, protectedPercent: 22, basisSha256: 'x', maskKey: 'k' } }),
    ], status: 'approved', problems: [], stale: { base: false, approval: false } } as ProtectedTemplateView;
}
const run = (w: number, h: number): Pick<ExperimentRun, 'id' | 'canvas' | 'layers' | 'outputLayers' | 'editorLayerFiles'> => ({ id: '2026-10-19T10-00-00-000Z-abcdef', canvas: { width: w, height: h }, editorLayerFiles: ['layer-00.png', 'layer-01.png'],
  layers: [], outputLayers: [
    { index: 0, file: 'layer-00.png', zIndex: 0, name: 'Background', pixelWidth: w, pixelHeight: h, opaquePercent: 100, placement: { kind: 'base', x: 0, y: 0, width: w, height: h }, sources: [] },
    { index: 1, file: 'layer-01.png', zIndex: 1, name: 'Phone', pixelWidth: w / 2, pixelHeight: h / 2, opaquePercent: 60, placement: { kind: 'bbox-crop', x: w / 2, y: h / 4, width: w / 2, height: h / 2 }, sources: [] },
  ] as ExperimentRun['outputLayers'] });
function deps() {
  const assets = new Map<string, Blob>(), fetched: string[] = []; let n = 0;
  return { assets, fetched, deps: { runFile: async (f: string) => { fetched.push(`run:${f}`); return new Blob([f]); }, templateFile: async (f: string) => { fetched.push(`tpl:${f}`); return new Blob([f]); },
    assets: { putAsset: async (id: string, b: Blob) => { assets.set(id, b); }, deleteAsset: async (id: string) => { assets.delete(id); } }, newId: () => `id${n++}`, now: () => '2026-10-19T12:00:00.000Z' } };
}

describe('protected template → editor document', () => {
  it('stacks Seedream layers under every protected slot, at source coordinates, with slots, locks and an editable headline', async () => {
    const d = deps(), doc = await protectedTemplateDocument(template(), run(1820, 2420), d.deps, { importedFrom: true });
    expect(isProjectDocument(JSON.parse(JSON.stringify(doc)))).toBe(true);
    const v = doc.variants[0];
    expect(v.canvas).toMatchObject({ width: 1820, height: 2420 });
    expect(v.importedFrom).toEqual({ templateId: 'pt-0123456789ab', resultId: 'approved-r4', runId: '2026-10-19T10-00-00-000Z-abcdef' });
    // One order across layers and text: Seedream first, then the protected elements in their own order.
    const order = [...v.layers!.map(l => [l.zIndex, l.name]), ...v.elements.map(e => [e.zIndex, e.name])].sort((a, b) => Number(a[0]) - Number(b[0])).map(x => x[1]);
    expect(order).toEqual(['Seedream base (z0)', 'Phone (z1)', 'Protected logo · Bank A (original file)', 'Protected logo · Bank B (original pixels)', 'Protected text · Headline', 'Protected legal / fine print · Fine print (original pixels)']);
    const [, phone, bankA, bankB, fine] = v.layers!;
    expect(phone).toMatchObject({ x: 910, y: 605, width: 910, height: 1210, locked: false });
    expect(bankA).toMatchObject({ x: 100, y: 80, width: 400, height: 160, rotation: 0, fit: 'contain', role: 'logo', locked: true, protectedSlot: { templateId: 'pt-0123456789ab', elementId: 'pe-000000000a', kind: 'logo', representation: 'source-asset' } });
    expect(bankB).toMatchObject({ x: 573, y: 53, width: 254, height: 254, rotation: 0, protectedSlot: { representation: 'raster' } });
    expect(fine).toMatchObject({ x: 80, y: 2300, width: 1600, height: 60, role: 'generic-image' });
    const headline = v.elements[0];
    expect(headline).toMatchObject({ text: 'Easy EMI', x: 100, y: 400, width: 900, height: 150, fontFamily: 'Inter', fontSize: 120, letterSpacing: 2, fill: '#ffffff', locked: true, protectedSlot: { elementId: 'pe-000000000c', representation: 'native-text' } });
    // Protected content comes from the template's own files, never from Seedream's.
    expect(d.fetched).toEqual(['run:layer-00.png', 'run:layer-01.png', 'tpl:asset-a.png', 'tpl:raster-b.png', 'tpl:raster-d.png']);
  });

  it('keeps every slot in place at another export size and on a smaller Seedream canvas', async () => {
    // A 6000×4000 source opens scaled down to the editor's limits; Seedream answered at half the source size.
    const t = template(6000, 4000), d = deps();
    const doc = await protectedTemplateDocument(t, run(3000, 2000), d.deps);
    const v = doc.variants[0], s = v.canvas.width / 6000;
    expect(v.canvas.width).toBeLessThanOrEqual(4096); expect(Math.abs(v.canvas.height / 4000 - s)).toBeLessThan(1 / 4000);
    const phone = v.layers![1], bankA = v.layers![2];
    expect(phone.x / v.canvas.width).toBeCloseTo(0.5, 3); expect(phone.y / v.canvas.height).toBeCloseTo(0.25, 3);
    expect(bankA.x / v.canvas.width).toBeCloseTo(t.elements[0].box.x / 6000, 6);
    expect(bankA.width / v.canvas.width).toBeCloseTo(t.elements[0].box.width / 6000, 6);
  });

  it('places a rotated original file so its corners land on the source box\'s corners', async () => {
    const t = template(); t.elements[1] = { ...t.elements[1], representation: 'source-asset', sourceAsset: asset('asset-b.png', 100, 100) };
    const layer = (await protectedTemplateDocument(t, run(1820, 2420), deps().deps)).variants[0].layers![3];
    const corners = boxCorners(t.elements[1].box), a = 15 * Math.PI / 180;
    expect(layer.x).toBeCloseTo(corners[0][0], 6); expect(layer.y).toBeCloseTo(corners[0][1], 6); expect(layer.rotation).toBe(15);
    const far = [layer.x + layer.width * Math.cos(a) - layer.height * Math.sin(a), layer.y + layer.width * Math.sin(a) + layer.height * Math.cos(a)];
    expect(far[0]).toBeCloseTo(corners[2][0], 6); expect(far[1]).toBeCloseTo(corners[2][1], 6);
  });

  it('reuses the template with a new logo, new copy and a hidden slot, without touching the others', async () => {
    const t = template(), d = deps(), logo = new Blob(['new bank logo']);
    const doc = await protectedTemplateDocument(t, run(1820, 2420), d.deps, { name: 'Diwali EMI · ICICI', replacements: { 'pe-000000000a': { kind: 'image', blob: logo }, 'pe-000000000c': { kind: 'text', text: 'No-cost EMI' }, 'pe-000000000d': { kind: 'hide' } } });
    const v = doc.variants[0];
    expect(v.importedFrom).toBeUndefined();
    expect(v.layers![2]).toMatchObject({ name: 'Protected logo · Bank A (replaced)', x: 100, y: 80, width: 400, height: 160, fit: 'contain' });
    expect(d.assets.get(String(v.layers![2].type === 'image' && v.layers![2].assetId))).toBe(logo);
    expect(v.elements[0]).toMatchObject({ text: 'No-cost EMI', x: 100, y: 400 });
    expect(v.layers![4]).toMatchObject({ visible: false, protectedSlot: { elementId: 'pe-000000000d' } });
    expect(v.layers![3]).toMatchObject({ name: 'Protected logo · Bank B (original pixels)' });
    expect(textReplaceable(t.elements[3])).toBe(false);
    await expect(protectedTemplateDocument(t, run(1820, 2420), deps().deps, { replacements: { 'pe-000000000d': { kind: 'text', text: 'x' } } })).rejects.toThrow(/no recorded text style/);
  });

  it('refuses a Seedream canvas of another shape and removes everything it stored', async () => {
    const d = deps();
    await expect(protectedTemplateDocument(template(), run(1000, 1000), d.deps)).rejects.toThrow(/does not match the source/);
    const missing = template(); delete missing.elements[1].raster;
    await expect(protectedTemplateDocument(missing, run(1820, 2420), d.deps)).rejects.toThrow(/preserved pixels are missing/);
    expect(d.assets.size).toBe(0);
  });
});
