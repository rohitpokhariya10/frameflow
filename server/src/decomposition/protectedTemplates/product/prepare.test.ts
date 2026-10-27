import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { flattenRgb } from '../pixels.js';
import { assertOverlaysGone, OverlayGateError, overlayMask, prepareProduct, providerExclusionMask } from './prepare.js';
import { detectedPoster, fakeSegmenter, PRODUCT_OBJECTS, PRODUCT_TILES } from './productPoster.fixture.js';

type Box = { x: number; y: number; width: number; height: number };
const rgbOf = async (png: Buffer) => { const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { rgb: data, w: info.width }; };
/** Pixels in `box` within `tolerance` of a colour. */
const near = (img: { rgb: Uint8Array; w: number }, box: Box, colour: string, tolerance = 40) => {
  const c = [1, 3, 5].map(k => parseInt(colour.slice(k, k + 2), 16));
  let n = 0;
  for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { const i = (y * img.w + x) * 3; if (Math.abs(img.rgb[i] - c[0]) + Math.abs(img.rgb[i + 1] - c[1]) + Math.abs(img.rgb[i + 2] - c[2]) < tolerance) n++; }
  return n;
};
const HEADLINE = { x: 100, y: 190, width: 600, height: 170 }, LEGAL = { x: 60, y: 1144, width: 190, height: 52 };
/** Every overlay of the fixture is gone from a picture: headline, offer and T&C ink, the three bank cards. */
async function expectNoOverlays(png: Buffer) {
  const img = await rgbOf(png);
  expect(near(img, HEADLINE, '#03595a')).toBe(0);
  expect(near(img, LEGAL, '#03595a')).toBe(0);
  for (const t of PRODUCT_TILES) { expect(near(img, t, '#0f5132', 30)).toBe(0); for (const c of ['#c8102e', '#1d2a6b', '#0a8f3c', '#334155']) expect(near(img, t, c, 30)).toBe(0); }
}

describe('Product with Text templates: preparing', { timeout: 120_000 }, () => {
  it('removes every overlay, cuts out each object on its own and rebuilds what is behind them (locally, no provider)', async () => {
    const { source, analysis, objects } = await detectedPoster(), segmenter = fakeSegmenter();
    const r = await prepareProduct({ source, analysis, objects, segmenter, paidApproved: false, save: () => undefined });
    expect(segmenter.calls).toHaveLength(0);
    expect(r.separation).toEqual({ method: 'local', requests: 0, costUsd: 0 });
    // The clean picture: no text, no bank logo; the products and mascot remain.
    await expectNoOverlays(r.clean);
    const clean = await rgbOf(r.clean);
    expect(near(clean, PRODUCT_OBJECTS.tv, '#111111', 20)).toBeGreaterThan(1000);
    expect(near(clean, { x: 768, y: 52, width: 170, height: 64 }, '#0b3b3c', 30)).toBe(0);
    // One cut-out per object, each where the object is, the mascot and each product with its slot.
    expect(r.cutouts.map(c => objects.find(o => o.id === c.id)!.label).sort()).toEqual(['Mascot', 'Refrigerator', 'Television', 'Washing machine']);
    const cut = (label: string) => r.cutouts.find(c => objects.find(o => o.id === c.id)!.label === label)!;
    for (const [label, box] of [['Television', PRODUCT_OBJECTS.tv], ['Washing machine', PRODUCT_OBJECTS.washer], ['Refrigerator', PRODUCT_OBJECTS.fridge]] as const) {
      const p = cut(label).placement;
      expect(Math.abs(p.x - box.x), label).toBeLessThanOrEqual(3); expect(Math.abs(p.x + p.width - box.x - box.width), label).toBeLessThanOrEqual(3);
      expect(Math.abs(p.y - box.y), label).toBeLessThanOrEqual(3);
    }
    // Overlapping boxes are split by colour: the mascot and the television take none of the gold podium.
    const gold = async (label: string) => { const c = cut(label), { data, info } = await sharp(c.png).raw().toBuffer({ resolveWithObject: true }); let g = 0; for (let i = 0; i < info.width * info.height; i++) if (data[i * 4 + 3] > 128 && Math.abs(data[i * 4] - 0xc9) + Math.abs(data[i * 4 + 1] - 0x92) + Math.abs(data[i * 4 + 2] - 0x2e) < 40) g++; return g; };
    expect(await gold('Mascot')).toBeLessThan(40);
    expect(await gold('Television')).toBeLessThan(40);

    // Standing on the podium: each product's lowest pixel is its contact line.
    expect(Math.abs(cut('Refrigerator').contactY - (PRODUCT_OBJECTS.fridge.y + PRODUCT_OBJECTS.fridge.height - 1))).toBeLessThanOrEqual(2);
    // Hidden or moved, an object leaves no ghost: the base has none of its colours where it was.
    const base = await rgbOf(r.base);
    expect(near(base, PRODUCT_OBJECTS.tv, '#111111', 20)).toBe(0);
    expect(near(base, PRODUCT_OBJECTS.fridge, '#374151', 20)).toBe(0);
    expect(near(base, PRODUCT_OBJECTS.mascot, '#f97316', 30)).toBe(0);
    expect(near(base, { x: 190, y: 800, width: 660, height: 90 }, '#c9922e', 30)).toBeGreaterThan(20000);
    // The base continues the panel's lattice where the products were (not a smudge): its line colour is there.
    expect(near(base, PRODUCT_OBJECTS.tv, '#fdf6d2', 12)).toBeGreaterThan(400);
    await expectNoOverlays(r.base);
    // Recombined, the creative is the original; base and cut-outs are the clean picture.
    expect(r.quality.original.visiblePercent).toBeLessThan(8);
    expect(r.quality.clean.visiblePercent).toBeLessThan(0.5);
    expect(r.quality.issues.filter(i => i.blocking)).toEqual([]);
  });

  it('gives the approved cut-out service only isolated character/product bytes with zeroed overlay exclusions', async () => {
    const { source, analysis, objects } = await detectedPoster(), segmenter = fakeSegmenter();
    const r = await prepareProduct({ source, analysis, objects, segmenter, paidApproved: true, save: () => undefined });
    expect(segmenter.calls).toHaveLength(4);
    expect(r.separation).toMatchObject({ method: 'sam3', requests: 4, costUsd: 0.04 });
    expect(segmenter.calls.flatMap(c => c.targets.map(t => t.label)).sort()).toEqual(['Mascot', 'Refrigerator', 'Television', 'Washing machine']);
    const excluded = providerExclusionMask(source, analysis);
    for (const call of segmenter.calls) {
      expect(call.image.equals(r.clean)).toBe(false);
      const m = await sharp(call.image).metadata();
      expect(m.width).toBe(call.targets[0].box.width); expect(m.height).toBe(call.targets[0].box.height);
      expect(m.width).toBeLessThan(source.width);
      const object = objects.find(o => o.label === call.targets[0].label)!;
      const data = await sharp(call.image).ensureAlpha().raw().toBuffer();
      let visible = 0;
      for (let y=0;y<object.box.height;y++) for (let x=0;x<object.box.width;x++) {
        const i = (y+object.box.y)*source.width+x+object.box.x, j=(y*object.box.width+x)*4;
        if (excluded[i] || data[j+3] === 0) expect([...data.subarray(j,j+4)]).toEqual([0,0,0,0]);
        else { expect([...data.subarray(j,j+4)]).toEqual([...source.data.subarray(i*4,i*4+4)]); visible++; }
      }
      expect(visible).toBeGreaterThan(16);
    }
    expect(r.cutouts.every(c => c.method === 'sam3')).toBe(true);
    expect(r.quality.original.visiblePercent).toBeLessThan(8);
  });

  it('refuses a picture that still shows an overlay (the gate), so nothing could be sent', async () => {
    const { source, analysis } = await detectedPoster(), rgb = flattenRgb(source), { mask, areas } = overlayMask(source, analysis);
    expect(areas.length).toBeGreaterThanOrEqual(6);
    expect(() => assertOverlaysGone(rgb, rgb, mask, source.width, areas)).toThrow(OverlayGateError);
    // One area left in: refused, and named.
    const { source: s2, analysis: a2, objects } = await detectedPoster(), r = await prepareProduct({ source: s2, analysis: a2, objects, paidApproved: false, save: () => undefined });
    const clean = Uint8Array.from((await rgbOf(r.clean)).rgb), tile = PRODUCT_TILES[1];
    for (let y = tile.y; y < tile.y + tile.height; y++) for (let x = tile.x; x < tile.x + tile.width; x++) for (let c = 0; c < 3; c++) clean[(y * source.width + x) * 3 + c] = rgb[(y * source.width + x) * 3 + c];
    let error: unknown;
    try { assertOverlaysGone(rgb, clean, mask, source.width, areas); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(OverlayGateError);
    expect((error as OverlayGateError).areas).toHaveLength(1);
    const gated = (await rgbOf(r.clean)).rgb;
    expect(() => assertOverlaysGone(rgb, gated, mask, source.width, areas)).not.toThrow();
  });
});
