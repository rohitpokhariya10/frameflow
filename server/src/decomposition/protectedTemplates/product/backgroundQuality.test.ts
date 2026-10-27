import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ProductObject } from '@frameflow/shared';
import { decodeRgba, sha256 } from '../pixels.js';
import { prepareProduct } from './prepare.js';
import { standInProductLayerizer } from './aiDecompose.js';

// A provider can return plausible object masks while leaving the same products in its background.
// Test that failure independently of the real LG files; these fixtures never write to a saved template.
describe('replacement background quality and provenance', () => {
  it('blocks residue for every selected product and retains the actual provider background for diagnosis', async () => {
    const png = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="#e9e5dd"/><rect x="100" y="160" width="100" height="160" fill="#122438"/><rect x="350" y="160" width="130" height="160" fill="#652717"/></svg>')).png().toBuffer();
    const source = await decodeRgba(png), objects: ProductObject[] = [
      { id: 'po-purifier', label: 'Water purifier', box: { x: 90, y: 150, width: 120, height: 180 } },
      { id: 'po-fridge', label: 'Refrigerator', box: { x: 340, y: 150, width: 150, height: 180 } },
    ].map((o, z) => ({ ...o, kind: 'product', confidence: 1, z, covers: [], origin: 'local', review: { status: 'accepted', by: 'user' } }));
    const layerizer = standInProductLayerizer(), records = new Map<string, object>(), images = new Map<string, Buffer>();
    const r = await prepareProduct({ source, analysis: undefined, objects, layerizer, paidApproved: true,
      save: (f, v) => records.set(f, v), saveImage: (f, b) => images.set(f, b) });
    expect(layerizer.calls).toHaveLength(1);
    expect(r.quality.issues.filter(i => i.blocking && i.id.startsWith('duplicate-')).map(i => i.elementId).sort()).toEqual(objects.map(o => o.id).sort());
    expect(records.get('ai-mapping.json')).toMatchObject({ background: { source: 'seedream-layer', sha256: sha256(images.get('ai-background.png')!) } });
    expect(records.get('background-provenance.json')).toMatchObject({ baseSha256: sha256(r.base), cleanSha256: sha256(r.clean), sources: { seedreamBackground: true, verifiedComposition: false }, residualChecks: objects.map(o => ({ id: o.id, label: o.label })) });

    // An approved native composition has a separate clean background. Keep that exact reference under the
    // selected products even if the mocked AI background is defective. The AI decomposition still runs; each product
    // then keeps its complete layer from the composition (the uploaded picture, whole when moved) instead of a cut-out.
    const background = await decodeRgba(await sharp({ create: { width: 600, height: 600, channels: 4, background: '#e9e5dd' } }).png().toBuffer());
    const layers = await Promise.all(objects.map(async o => ({ label: o.label, kind: o.kind, box: o.box,
      png: await sharp(png).extract({ left: o.box.x, top: o.box.y, width: o.box.width, height: o.box.height }).png().toBuffer() })));
    const clean = await prepareProduct({ source, analysis: undefined, objects, layerizer, paidApproved: true, requireAiMatches: true,
      known: { verifiedComposition: true, background, clean: source, layers }, save: (f, v) => records.set(f, v) });
    expect(clean.quality.issues.filter(i => i.blocking)).toEqual([]);
    expect(clean.cutouts.every(c => c.method === (objects.find(o => o.id === c.id)?.kind === 'product' ? 'layer' : 'seedream'))).toBe(true);
    const base = await decodeRgba(clean.base);
    for (const o of objects) for (let y = o.box.y; y < o.box.y + o.box.height; y++) for (let x = o.box.x; x < o.box.x + o.box.width; x++) {
      const p = (y * 600 + x) * 4;
      expect(base.data.subarray(p, p + 4)).toEqual(background.data.subarray(p, p + 4));
    }
    expect(records.get('background-provenance.json')).toMatchObject({ baseSha256: sha256(clean.base), sources: { verifiedComposition: true }, blockingIssues: [] });
    expect(clean.quality.issues.some(i => i.id === 'native-background-reference')).toBe(true);
  });
});
