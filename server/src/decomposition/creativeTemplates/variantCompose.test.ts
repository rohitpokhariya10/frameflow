import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { closestGenerationRatio, GENERATION_IMAGE_SIZES } from '@frameflow/shared';
import { band, composeVariant, generationInputs, ghostHole, refineEdges, maskBox, measurePreservation, resizeMask, sourceRaster, splitMaskByBoxes, type PixelBox, type Raster, type VariantSubject } from './variantCompose.js';
import { maskedEditTruth, mijiaReplay, sceneryAt, softEdges, syntheticCreative, writeVisual, type MaskedEditKind, type Shape } from './variantTestKit.js';

// Pixel tests of a creative variant's compositing, with image models that behave like a real masked edit (variantTestKit.ts),
// which also say exactly where they drew their own copy of the products (a ghost) and their own shadow.
// Each test measures one failure found by the 2026-10-09 audit or in Step 2's fixtures: masks read in the wrong layout,
// a preservation check that could never fail, one shadow and one layer for all products, a smooth fill ring on
// textured scenery, a drawn shadow on top of the model's own, and old background colour in soft product edges.

const union = (masks: Uint8Array[]) => { const out = new Uint8Array(masks[0].length); for (const m of masks) for (let i = 0; i < m.length; i++) out[i] = Math.max(out[i], m[i]); return out; };
const subjects = (masks: Uint8Array[], shadow = true): VariantSubject[] => masks.map((mask, k) => ({ id: `p${k + 1}`, label: `Product ${k + 1}`, mask, shadow }));
const rgbOf = async (png: Buffer) => (await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true })).data;
/** A map the model drew at its own size, as it lands on the source canvas (the region the source was placed in, resized). */
const onSource = async (map: Uint8Array, size: { width: number; height: number }, placement: PixelBox, source: { width: number; height: number }) => {
  const crop = new Uint8Array(placement.width * placement.height);
  for (let y = 0; y < placement.height; y++) for (let x = 0; x < placement.width; x++) crop[y * placement.width + x] = map[(placement.y + y) * size.width + placement.x + x] ? 255 : 0;
  return band(sharp(Buffer.from(crop), { raw: { width: placement.width, height: placement.height, channels: 1 } }).resize(source.width, source.height, { fit: 'fill', kernel: 'nearest' }));
};
/** The whole variant pipeline offline: inputs → a fake masked edit at the model's size → compose. */
async function variant(width: number, height: number, shapes: Shape[], kind: MaskedEditKind = 'obeys-mask', options: { masks?: (m: Uint8Array[]) => Uint8Array[]; png?: (creative: Awaited<ReturnType<typeof syntheticCreative>>) => Promise<Buffer>; shadow?: boolean; contactShadow?: boolean; refine?: boolean; drift?: { dx: number; dy: number; scale: number } } = {}) {
  const creative = await syntheticCreative(width, height, '#c000c0', shapes), raw = await sourceRaster(options.png ? await options.png(creative) : creative.png);
  const given = options.masks ? options.masks(creative.masks) : creative.masks, refined = options.refine ? refineEdges(raw, given) : undefined;
  const masks = refined?.masks ?? given, all = union(masks), source = refined?.reference ?? raw;
  const size = GENERATION_IMAGE_SIZES[closestGenerationRatio(width, height)], inputs = await generationInputs(source, all, size);
  const truth = await maskedEditTruth(kind, inputs.image, inputs.mask, size, { contactShadow: options.contactShadow, ...(options.drift ? { drift: options.drift } : {}) });
  const composed = await composeVariant(truth.png, inputs.placement, source, subjects(masks, options.shadow));
  const [composite, plate, scenery] = await Promise.all([rgbOf(composed.composite), rgbOf(composed.plate), rgbOf(composed.scenery)]);
  const ghost = await onSource(truth.ghost, size, inputs.placement, raw), shadow = await onSource(truth.shadow, size, inputs.placement, raw);
  return { creative, raw, source, masks, all, size, inputs, generated: truth.png, composed, composite, plate, scenery, ghost, shadow };
}
type Variant = Awaited<ReturnType<typeof variant>>;
const count = (n: number, test: (i: number) => boolean) => { let c = 0; for (let i = 0; i < n; i++) if (test(i)) c++; return c; };
/** Pixels of the model's own copy of the products that still show in the composite (outside the products, unchanged). */
const survivingGhost = (v: Variant) => count(v.all.length, i => v.ghost[i] > 0 && v.all[i] === 0 && [0, 1, 2].every(c => Math.abs(v.composite[i * 3 + c] - v.scenery[i * 3 + c]) <= 3));
/** Of the edit mask sent to the model: how much of the products it keeps, and how much of what it keeps is the products. */
async function editMaskFit(inputs: { mask: Buffer; placement: PixelBox }, all: Uint8Array, source: Raster, size: { width: number; height: number }) {
  const keep = await band(sharp(inputs.mask).ensureAlpha().extractChannel(3));
  const expected = await resizeMask(all, source, inputs.placement);
  let both = 0, kept = 0, wanted = 0;
  for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
    const inside = x >= inputs.placement.x && y >= inputs.placement.y && x < inputs.placement.x + inputs.placement.width && y < inputs.placement.y + inputs.placement.height;
    const k = keep[y * size.width + x] === 255, w = inside && expected[(y - inputs.placement.y) * inputs.placement.width + (x - inputs.placement.x)] >= 128;
    if (k) kept++; if (w) wanted++; if (k && w) both++;
  }
  return both / Math.max(1, kept + wanted - both);
}
const near = (rgb: Buffer, i: number, color: number[], tolerance: number) => Math.abs(rgb[i * 3] - color[0]) <= tolerance && Math.abs(rgb[i * 3 + 1] - color[1]) <= tolerance && Math.abs(rgb[i * 3 + 2] - color[2]) <= tolerance;
/**
 * Mean colour error, 4–25 px outside the products, between the result and the scenery the model actually painted there
 * (the fake model's scenery is known exactly; its own copy of the products and its shadow are left out). A smooth fill
 * ring scores high; scenery kept or continued with its texture scores low. Step 2's smooth 2.5% fill measured 32 (model
 * kept the products), 31 (small drift) and 37 (large drift) on these scenes.
 */
function ringError(v: Variant, width: number, height: number) {
  const box = maskBox(v.all, width, height).box!, p = v.inputs.placement; let sum = 0, k = 0;
  for (let y = Math.max(0, box.y - 25); y < Math.min(height, box.y + box.height + 25); y++) for (let x = Math.max(0, box.x - 25); x < Math.min(width, box.x + box.width + 25); x++) {
    const d = Math.max(box.x - x, x - (box.x + box.width - 1), box.y - y, y - (box.y + box.height - 1), 0), i = y * width + x;
    if (d < 4 || d > 25 || v.all[i] || v.ghost[i] || v.shadow[i]) continue;
    const t = sceneryAt(Math.round(p.x + (x + 0.5) * p.width / width - 0.5), Math.round(p.y + (y + 0.5) * p.height / height - 0.5)).map(c => Math.max(0, Math.min(255, Math.round(c))));
    sum += (Math.abs(v.composite[i * 3] - t[0]) + Math.abs(v.composite[i * 3 + 1] - t[1]) + Math.abs(v.composite[i * 3 + 2] - t[2])) / 3; k++;
  }
  return sum / Math.max(1, k);
}

describe('masks keep one value per pixel, whatever layout sharp hands back', () => {
  it('band() reads a single band after a resize and a blur (sharp 0.35 returns three channels for both)', async () => {
    const mask = new Uint8Array(300 * 200); for (let y = 50; y < 150; y++) for (let x = 100; x < 200; x++) mask[y * 300 + x] = 255;
    const raw = () => sharp(Buffer.from(mask), { raw: { width: 300, height: 200, channels: 1 } });
    const resized = await band(raw().resize(150, 100, { fit: 'fill' })), blurred = await band(raw().blur(0.6));
    expect([resized.length, blurred.length]).toEqual([150 * 100, 300 * 200]);
    expect(maskBox(resized, 150, 100).box).toEqual({ x: 50, y: 25, width: 50, height: 50 });
    expect(maskBox(blurred, 300, 200).box).toEqual({ x: 100, y: 50, width: 100, height: 100 });
  });
});

describe('the edit mask sent to the image model keeps exactly the products', () => {
  const cases: [string, Shape[]][] = [
    ['a product at the top', [{ kind: 'rect', box: { x: 300, y: 40, width: 200, height: 220 }, color: '#d0a040' }]],
    ['a product in the middle', [{ kind: 'rect', box: { x: 288, y: 200, width: 224, height: 520 }, color: '#d0a040' }]],
    ['a product at the bottom', [{ kind: 'rect', box: { x: 250, y: 700, width: 300, height: 280 }, color: '#d0a040' }]],
    ['a round product', [{ kind: 'ellipse', box: { x: 230, y: 60, width: 340, height: 340 }, color: '#f0c020' }]],
    ['two products apart', [{ kind: 'rect', box: { x: 80, y: 300, width: 200, height: 400 }, color: '#d03030' }, { kind: 'ellipse', box: { x: 520, y: 560, width: 200, height: 200 }, color: '#3030d0' }]],
  ];
  for (const [name, shapes] of cases) it(name, async () => {
    const creative = await syntheticCreative(800, 1000, '#c000c0', shapes), source = await sourceRaster(creative.png), all = union(creative.masks);
    const size = GENERATION_IMAGE_SIZES[closestGenerationRatio(800, 1000)], inputs = await generationInputs(source, all, size);
    expect(await editMaskFit(inputs, all, source, size)).toBeGreaterThanOrEqual(0.99);
  });
});

describe('compose: the products are the source\'s own pixels on a clean new plate', { timeout: 60_000 }, () => {
  const phone: Shape = { kind: 'rect', box: { x: 288, y: 200, width: 224, height: 520 }, color: '#c8a03c' };
  it('a model that keeps the products: exact products, its scenery untouched right up to them, and their area filled in the plate', async () => {
    const v = await variant(800, 1000, [phone]), n = 800 * 1000, src = v.source.rgb;
    expect(v.composed.preservation).toMatchObject({ ok: true, maxDifference: 0, outsideAlphaPixels: 0 });
    expect(v.composed.ghost).toMatchObject({ drift: { dx: 0, dy: 0, scale: 1 }, margin: 3 });
    expect(v.composed.ghost.keptError).toBeLessThanOrEqual(3);
    let differing = 0;
    for (let y = 200; y < 720; y++) for (let x = 288; x < 512; x++) { const i = y * 800 + x; if (!near(v.composite, i, [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]], 0)) differing++; }
    expect(differing).toBe(0);
    expect(count(n, i => v.all[i] === 0 && near(v.composite, i, [192, 0, 192], 12))).toBe(0);
    // The plate no longer holds the product: its area is continued scenery.
    expect(count(n, i => v.all[i] === 255 && near(v.plate, i, [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]], 0))).toBeLessThan(0.01 * 224 * 520);
    // No fill ring: right next to the product the result is the scenery the model painted (Step 2's 2.5% fill: 32).
    expect(ringError(v, 800, 1000)).toBeLessThan(6);
    await writeVisual('compose-keeps-products', [{ label: 'source', png: v.creative.png }, { label: 'edit mask sent (white = keep)', png: await sharp(v.inputs.mask).ensureAlpha().extractChannel(3).png().toBuffer() },
      { label: 'model output', png: v.generated }, { label: 'plate', png: v.composed.plate }, { label: 'composite', png: v.composed.composite }]);
  });

  it('a model that redraws the products shifted and enlarged: its copy is found and filled with textured scenery, not a smooth ring', async () => {
    const v = await variant(800, 1000, [phone], 'drifts');
    expect(count(v.ghost.length, i => v.ghost[i] > 0 && v.all[i] === 0)).toBeGreaterThan(1000);
    expect(survivingGhost(v)).toBe(0);
    // The re-rendering was measured, and a wider margin around the products removed it.
    expect(v.composed.ghost.margin).toBeGreaterThan(3);
    expect(v.composed.preservation.ok).toBe(true);
    // Where the copy was, the scenery is continued with its texture (Step 2's smooth fill: 31).
    expect(ringError(v, 800, 1000)).toBeLessThan(24);
    await writeVisual('compose-drifting-model', [{ label: 'model output (its own shifted copy)', png: v.generated }, { label: 'plate', png: v.composed.plate }, { label: 'composite', png: v.composed.composite }]);
  });

  it('a drift larger than any fixed margin: the copy is located from its outline (within 3 px) and removed; a margin alone would leave it', async () => {
    // The model moves its copy 40×20 px at its own size (about 26×13 px on this canvas): beyond the 1.5% margin of 15 px.
    const v = await variant(800, 1000, [phone], 'drifts', { drift: { dx: 40, dy: 20, scale: 1 } }), k = 800 / v.inputs.placement.width;
    expect(Math.abs(v.composed.ghost.drift.dx - 40 * k)).toBeLessThanOrEqual(3);
    expect(Math.abs(v.composed.ghost.drift.dy - 20 * k)).toBeLessThanOrEqual(3);
    expect(survivingGhost(v)).toBe(0);
    expect(ringError(v, 800, 1000)).toBeLessThan(20); // Step 2's smooth fill: 37
    // The negative control: the same scene with only the margin (no measured copy) leaves part of the copy showing.
    const margin = v.composed.ghost.margin, onlyMargin = new Uint8Array(v.all.length);
    for (let y = 0; y < 1000; y++) for (let x = 0; x < 800; x++) if (v.all[y * 800 + x] >= 128) for (let yy = Math.max(0, y - margin); yy <= Math.min(999, y + margin); yy += margin) for (let xx = Math.max(0, x - margin); xx <= Math.min(799, x + margin); xx += margin) onlyMargin[yy * 800 + xx] = 1;
    expect(count(v.all.length, i => v.ghost[i] > 0 && v.all[i] === 0 && !onlyMargin[i])).toBeGreaterThan(1000);
    await writeVisual('compose-large-drift', [{ label: 'model output (copy moved 26x13 px)', png: v.generated }, { label: 'composite', png: v.composed.composite }]);
  });

  it('measuring the copy is brightness-proof: the same drift, re-rendered darker or lighter, is found the same way', async () => {
    const creative = await syntheticCreative(800, 1000, '#c000c0', [phone]), source = await sourceRaster(creative.png), mask = creative.masks[0];
    // The model's output as it lands on the canvas: new scenery, and the product drawn 20 px right and 10 px down, 30 levels lighter.
    const scenery = Buffer.alloc(800 * 1000 * 3);
    for (let y = 0; y < 1000; y++) for (let x = 0; x < 800; x++) { const i = y * 800 + x, j = (y - 10) * 800 + (x - 20); scenery.set(j >= 0 && x >= 20 && mask[j] ? [0, 1, 2].map(c => Math.min(255, source.rgb[j * 3 + c] + 30)) : [60, 130, 150], i * 3); }
    const g = ghostHole(scenery, source, mask, 800, 1000);
    expect([g.drift.dx, g.drift.dy, g.drift.scale]).toEqual([20, 10, 1]);
    // And a model that kept the product where it is: no copy is measured, and the margin stays 3 px.
    const keptScenery = Buffer.from(scenery.map((_, k) => mask[Math.floor(k / 3)] ? source.rgb[k] : [60, 130, 150][k % 3]));
    const kept = ghostHole(keptScenery, source, mask, 800, 1000);
    expect(kept).toMatchObject({ drift: { dx: 0, dy: 0, scale: 1 }, margin: 3 });
    // The light blur that keeps resampling noise out mixes each product's outermost pixels with what lies beside them
    // (new scenery here, old background in the source), so a perfectly kept product measures just under 1, not 0.
    expect(kept.keptError).toBeLessThanOrEqual(1);
  });

  it('the model\'s own contact shadow is kept, and no drawn shadow is added on top of it', async () => {
    const v = await variant(800, 1000, [phone], 'obeys-mask', { contactShadow: true });
    const lum = (i: number) => 0.299 * v.composite[i * 3] + 0.587 * v.composite[i * 3 + 1] + 0.114 * v.composite[i * 3 + 2];
    let shade = 0, k = 0, below = 0, j = 0;
    for (let i = 0; i < v.shadow.length; i++) if (v.shadow[i] && !v.all[i]) { shade += lum(i); k++; const under = i + 30 * 800; if (under < v.shadow.length && !v.shadow[under]) { below += lum(under); j++; } }
    expect(k).toBeGreaterThan(500);
    // Where the model put its shadow, the result is still clearly darker than the same scenery just below it.
    expect((shade / k) / (below / j)).toBeLessThan(0.75);
    expect(v.composed.shadows).toEqual([]);
    // Without one, a soft drawn shadow is added under the product as its own layer.
    expect((await variant(800, 1000, [phone])).composed.shadows).toHaveLength(1);
  });

  it('a round product: nothing of its old background shows, and the check measures it', async () => {
    const v = await variant(800, 800, [{ kind: 'ellipse', box: { x: 230, y: 60, width: 340, height: 340 }, color: '#f0c020' }]), n = 800 * 800;
    expect(v.composed.preservation).toMatchObject({ ok: true, outsideAlphaPixels: 0, maxDifference: 0 });
    expect(count(n, i => v.all[i] === 0 && near(v.composite, i, [192, 0, 192], 40))).toBe(0);
    await writeVisual('compose-round-product', [{ label: 'source', png: v.creative.png }, { label: 'composite', png: v.composed.composite }]);
  });

  it('soft edges: no old background colour in them, a mask that spills onto old background stops at the product, and every opaque pixel stays the source\'s', async () => {
    const soft = (m: Uint8Array[]) => m.map(x => softEdges(x, 800, 1000, 6));
    // A real soft edge: each ramp pixel is the product's colour mixed with the magenta behind it, as a camera or anti-aliasing makes it.
    const mixed = async (creative: Awaited<ReturnType<typeof syntheticCreative>>) => {
      const ramp = soft(creative.masks)[0], rgb = Buffer.from(creative.rgb);
      for (let i = 0; i < ramp.length; i++) if (ramp[i] > 0 && ramp[i] < 255) { const a = ramp[i] / 255; rgb[i * 3] = Math.round(a * 0xc8 + (1 - a) * 192); rgb[i * 3 + 1] = Math.round(a * 0xa0); rgb[i * 3 + 2] = Math.round(a * 0x3c + (1 - a) * 192); }
      return sharp(rgb, { raw: { width: 800, height: 1000, channels: 3 } }).png().toBuffer();
    };
    // How much more magenta the edge carries than the ideal blend of the product and the new scenery would (ramp pixels only).
    let rampCache: Uint8Array | undefined;
    const ramp = (v: Variant) => (rampCache ??= soft([v.creative.masks[0]])[0]);
    const excess = (v: Variant, trueAlpha: (a: number) => number) => {
      const r = ramp(v), product = [0xc8, 0xa0, 0x3c];
      let sum = 0, k = 0;
      for (let i = 0; i < r.length; i++) {
        if (!(r[i] > 0 && r[i] < 255)) continue;
        const a = trueAlpha(r[i] / 255), ideal = product.map((p, c) => a * p + (1 - a) * v.scenery[i * 3 + c]);
        sum += ((v.composite[i * 3] + v.composite[i * 3 + 2]) / 2 - v.composite[i * 3 + 1]) - ((ideal[0] + ideal[2]) / 2 - ideal[1]); k++;
      }
      return sum / k;
    };
    for (const [name, png, trueAlpha] of [['an anti-aliased edge', mixed, (a: number) => a], ['a mask spilling onto the old background', undefined, () => 0]] as const) {
      const plain = await variant(800, 1000, [phone], 'obeys-mask', { masks: soft, ...(png ? { png } : {}) }), clean = await variant(800, 1000, [phone], 'obeys-mask', { masks: soft, refine: true, ...(png ? { png } : {}) });
      for (const v of [plain, clean]) expect(v.composed.preservation, name).toMatchObject({ ok: true, outsideAlphaPixels: 0 });
      expect(excess(plain, trueAlpha), name).toBeGreaterThan(10);
      expect(excess(clean, trueAlpha), name).toBeLessThan(excess(plain, trueAlpha) * 0.3);
      // Refining changes soft edge pixels only: every opaque product pixel is still the source's.
      expect(count(800 * 1000, i => clean.all[i] >= 250 && [0, 1, 2].some(c => clean.source.rgb[i * 3 + c] !== clean.raw.rgb[i * 3 + c])), name).toBe(0);
      await writeVisual(`compose-soft-edges-${png ? 'anti-aliased' : 'spilling-mask'}`, [{ label: `${name}: as cut`, png: plain.composed.composite }, { label: `${name}: refined`, png: clean.composed.composite }]);
    }
  }, 60_000);

  it('two products far apart: each its own layer and its own shadow, under itself', async () => {
    const v = await variant(1200, 900, [{ kind: 'rect', box: { x: 100, y: 200, width: 200, height: 400 }, color: '#d03030' }, { kind: 'rect', box: { x: 850, y: 450, width: 200, height: 250 }, color: '#3030d0' }]);
    expect(v.composed.subjects.map(l => l.placement)).toEqual([{ x: 100, y: 200, width: 200, height: 400 }, { x: 850, y: 450, width: 200, height: 250 }]);
    expect(v.composed.shadows).toHaveLength(2);
    const [left, right] = v.composed.shadows.map(s => s.placement);
    expect(left.x + left.width).toBeLessThan(400); expect(right.x).toBeGreaterThan(750);
    expect(left.y).toBeLessThan(600); expect(left.y + left.height).toBeGreaterThan(600);
    expect(right.y).toBeLessThan(700); expect(right.y + right.height).toBeGreaterThan(700);
    await writeVisual('compose-two-products', [{ label: 'source', png: v.creative.png }, { label: 'composite', png: v.composed.composite }]);
  });

  it('a product that does not stand on its own gets no shadow', async () => {
    const v = await variant(800, 800, [{ kind: 'rect', box: { x: 300, y: 300, width: 200, height: 200 }, color: '#d0a040' }], 'obeys-mask', { shadow: false });
    expect(v.composed.shadows).toEqual([]); expect(v.composed.shadow).toBeUndefined();
  });

  it('overlapping products: the one in front owns their shared pixels, and the layers still give the exact composite', async () => {
    const v = await variant(800, 800, [{ kind: 'rect', box: { x: 200, y: 200, width: 300, height: 300 }, color: '#d03030' }, { kind: 'rect', box: { x: 400, y: 400, width: 200, height: 200 }, color: '#3030d0' }],
      'obeys-mask', { masks: m => [m[0], new Uint8Array(m[1].map((x, i) => Math.max(x, m[0][i] && (i % 800) >= 400 && Math.floor(i / 800) >= 400 ? 255 : 0)))] });
    const [back, front] = await Promise.all(v.composed.subjects.map(l => sharp(l.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    const at = (layer: typeof back, placement: PixelBox, x: number, y: number) => layer.data[((y - placement.y) * layer.info.width + (x - placement.x)) * 4 + 3];
    expect(at(front, v.composed.subjects[1].placement, 450, 450)).toBe(255);
    expect(at(back, v.composed.subjects[0].placement, 450, 450)).toBe(0);
    expect(v.composed.preservation.ok).toBe(true);
  });

  it('a large source keeps every mask aligned and its copy removed (the plate is continued at a working size)', async () => {
    const v = await variant(2400, 3000, [{ kind: 'rect', box: { x: 900, y: 700, width: 600, height: 1400 }, color: '#c8a03c' }], 'drifts');
    expect(await editMaskFit(v.inputs, v.all, v.source, v.size)).toBeGreaterThanOrEqual(0.99);
    expect(v.composed.preservation).toMatchObject({ ok: true, maxDifference: 0, outsideAlphaPixels: 0 });
    expect(survivingGhost(v)).toBe(0);
  }, 90_000);
});

describe('the preservation check fails when the products did not survive', () => {
  it('a changed product pixel, a wrong edge blend and alpha outside the mask each fail it', async () => {
    const width = 40, height = 40, n = width * height, src = Buffer.alloc(n * 3, 100), under = Buffer.alloc(n * 3, 10), mask = new Uint8Array(n);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) mask[y * width + x] = 255;
    const source: Raster = { rgb: src, width, height };
    const exact = Buffer.from(under); for (let i = 0; i < n; i++) if (mask[i]) for (let c = 0; c < 3; c++) exact[i * 3 + c] = 100;
    expect(measurePreservation(exact, under, source, [mask], mask)).toMatchObject({ ok: true, checkedPixels: 400 });
    const changed = Buffer.from(exact); changed[(15 * width + 15) * 3] = 101;
    expect(measurePreservation(changed, under, source, [mask], mask)).toMatchObject({ ok: false, maxDifference: 1 });
    const soft = new Uint8Array(mask); soft[10 * width + 10] = 128;
    const blendedWrong = Buffer.from(exact); blendedWrong[(10 * width + 10) * 3] = 100;
    expect(measurePreservation(blendedWrong, under, source, [soft], mask).ok).toBe(false);
    const leaking = new Uint8Array(mask); leaking[0] = 40;
    expect(measurePreservation(exact, under, source, [leaking], mask)).toMatchObject({ ok: false, outsideAlphaPixels: 1 });
    // Two products' soft edges overlapping at one pixel (combined opacity rounds to 255) are judged as a blend, and an
    // opaque pixel of either product stays exact.
    const edgeA = new Uint8Array(n), edgeB = new Uint8Array(n); edgeA[5] = 245; edgeB[5] = 245;
    const blend = Buffer.from(under); for (let c = 0; c < 3; c++) blend[5 * 3 + c] = Math.round(100 * (1 - (10 / 255) ** 2) + 10 * (10 / 255) ** 2);
    const report = measurePreservation(blend, under, source, [edgeA, edgeB], Uint8Array.from(edgeA));
    expect(report).toMatchObject({ checkedPixels: 0, edgePixels: 1 });
    expect(report.edgeMaxError).toBeLessThanOrEqual(0.5); // the blend rounded to whole levels
  });
});

describe('one mask of several products split by their regions', () => {
  it('each pixel goes to its own product; a far, unchosen object goes to none', () => {
    const width = 100, height = 100, mask = new Uint8Array(width * height);
    const paint = (b: PixelBox) => { for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) mask[y * width + x] = 255; };
    paint({ x: 10, y: 10, width: 20, height: 30 }); paint({ x: 60, y: 50, width: 25, height: 25 }); paint({ x: 5, y: 80, width: 10, height: 10 });
    const [a, b] = splitMaskByBoxes(mask, width, height, [{ x: 10, y: 10, width: 20, height: 30 }, { x: 60, y: 50, width: 25, height: 25 }]);
    expect(maskBox(a, width, height).box).toEqual({ x: 10, y: 10, width: 20, height: 30 });
    expect(maskBox(b, width, height).box).toEqual({ x: 60, y: 50, width: 25, height: 25 });
  });
});

const replay = await mijiaReplay();
describe.skipIf(!replay)('a real creative (Mijia appliances, 2026-10-09): real analysis and real product cutouts, fake image model', () => {
  it('keeps all four products exact on new scenery, each its own layer, with no surviving copy of them', async () => {
    const r = replay!, raw = await sourceRaster(r.source), refined = refineEdges(raw, r.products.map(p => p.mask)), masks = refined.masks, all = union(masks), source = refined.reference;
    const size = GENERATION_IMAGE_SIZES[closestGenerationRatio(r.width, r.height)], inputs = await generationInputs(source, all, size);
    expect(await editMaskFit(inputs, all, source, size)).toBeGreaterThanOrEqual(0.99);
    const panels: { label: string; png: Buffer }[] = [{ label: 'reference', png: r.source }];
    for (const kind of ['obeys-mask', 'drifts'] as const) {
      const truth = await maskedEditTruth(kind, inputs.image, inputs.mask, size, { contactShadow: true });
      const composed = await composeVariant(truth.png, inputs.placement, source, r.products.map((p, k) => ({ id: p.id, label: p.label, mask: masks[k], shadow: true })));
      expect(composed.preservation).toMatchObject({ ok: true, maxDifference: 0, outsideAlphaPixels: 0 });
      expect(composed.subjects.map(s => s.id).sort()).toEqual(r.products.map(p => p.id).sort());
      const [composite, scenery] = await Promise.all([rgbOf(composed.composite), rgbOf(composed.scenery)]), ghost = await onSource(truth.ghost, size, inputs.placement, raw);
      expect(count(all.length, i => ghost[i] > 0 && all[i] === 0 && [0, 1, 2].every(c => Math.abs(composite[i * 3 + c] - scenery[i * 3 + c]) <= 3))).toBe(0);
      panels.push({ label: `${kind}: model output`, png: truth.png }, { label: `${kind}: composite`, png: composed.composite });
    }
    await writeVisual('replay-mijia', panels);
  }, 120_000);
});
