import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { advertisedProducts, GENERATION_IMAGE_SIZES, VARIANT_RATIOS, type ConceptComposition } from '@frameflow/shared';
import { composeVariant, maskBox, refineEdges, sourceRaster, type PixelBox } from './variantCompose.js';
import { backgroundColour, canvasInputs, DEFAULT_COMPOSITION, groupBox, placeGroup, placeProducts, SAFE_MARGIN, touchedEdges } from './variantLayout.js';
import { maskedEditTruth, mijiaReplay, syntheticCreative, writeVisual } from './variantTestKit.js';

// Placing the product group on a variant's own canvas: never stretched, never enlarged, never cut off, kept together.
const compositions: ConceptComposition[] = [DEFAULT_COMPOSITION, { x: 0.3, y: 0.7, scale: 0.8, copySpace: 'right' }, { x: 0.7, y: 0.35, scale: 0.4, copySpace: 'top' }, { x: 0.5, y: 0.5, scale: 0.85, copySpace: 'bottom' }];
const groups: [string, PixelBox][] = [['a tall product', { x: 300, y: 100, width: 220, height: 700 }], ['a wide group', { x: 50, y: 300, width: 1100, height: 300 }], ['a small product', { x: 500, y: 500, width: 180, height: 160 }]];

describe('the product group on each ratio\'s canvas', () => {
  for (const ratio of VARIANT_RATIOS) for (const [name, group] of groups) it(`${ratio}: ${name} keeps its proportions, is never enlarged, stays in the safe area and out of the open space`, () => {
    const canvas = GENERATION_IMAGE_SIZES[ratio];
    for (const c of compositions) {
      const { scale, box } = placeGroup(group, canvas, c);
      expect(scale).toBeLessThanOrEqual(1);
      // One scale for both sides: no stretching.
      expect(Math.abs(box.width / group.width - box.height / group.height)).toBeLessThan(0.01);
      expect(box.x).toBeGreaterThanOrEqual(Math.round(canvas.width * SAFE_MARGIN)); expect(box.y).toBeGreaterThanOrEqual(Math.round(canvas.height * SAFE_MARGIN));
      expect(box.x + box.width).toBeLessThanOrEqual(canvas.width - Math.round(canvas.width * SAFE_MARGIN));
      expect(box.y + box.height).toBeLessThanOrEqual(canvas.height - Math.round(canvas.height * SAFE_MARGIN));
      if (c.copySpace === 'top') expect(box.y).toBeGreaterThanOrEqual(Math.round(canvas.height * 0.3));
      if (c.copySpace === 'right') expect(box.x + box.width).toBeLessThanOrEqual(Math.round(canvas.width * 0.7));
      if (c.copySpace === 'bottom') expect(box.y + box.height).toBeLessThanOrEqual(Math.round(canvas.height * 0.7));
    }
  });

  it('a group the source frame cuts off stays against the same canvas edge (a cut never floats mid-picture)', () => {
    const source = { width: 1000, height: 1000 }, cut = { x: 300, y: 400, width: 400, height: 600 };
    expect(touchedEdges(cut, source)).toEqual({ top: false, bottom: true, left: false, right: false });
    for (const ratio of VARIANT_RATIOS) { const canvas = GENERATION_IMAGE_SIZES[ratio], { box } = placeGroup(cut, canvas, DEFAULT_COMPOSITION, touchedEdges(cut, source)); expect(box.y + box.height).toBe(canvas.height); }
  });
});

describe('the products\' own pixels moved onto the canvas', () => {
  it('at full scale: an exact copy, nothing of the old background, and each product\'s mask moved with it', async () => {
    const creative = await syntheticCreative(1000, 1000, '#c000c0', [{ kind: 'rect', box: { x: 200, y: 300, width: 200, height: 400 }, color: '#d03030' }, { kind: 'ellipse', box: { x: 450, y: 500, width: 200, height: 200 }, color: '#3030d0' }]);
    const source = await sourceRaster(creative.png), group = groupBox(creative.masks, 1000, 1000), canvas = GENERATION_IMAGE_SIZES['1:1'];
    const placement = { scale: 1, box: { x: 300, y: 250, width: group.width, height: group.height } };
    const placed = await placeProducts(source, creative.masks, group, placement, canvas, [200, 200, 200]);
    let differing = 0, magenta = 0;
    for (let y = 0; y < group.height; y++) for (let x = 0; x < group.width; x++) {
      const s = (group.y + y) * 1000 + group.x + x, c = (placement.box.y + y) * canvas.width + placement.box.x + x;
      if (creative.masks.some(m => m[s] === 255) && [0, 1, 2].some(k => placed.reference.rgb[c * 3 + k] !== source.rgb[s * 3 + k])) differing++;
      if (Math.abs(placed.reference.rgb[c * 3] - 192) < 20 && placed.reference.rgb[c * 3 + 1] < 30) magenta++;
    }
    expect([differing, magenta]).toEqual([0, 0]);
    // The arrangement is kept: each product's box moved by exactly the same offset.
    const shift = { x: placement.box.x - group.x, y: placement.box.y - group.y };
    expect(maskBox(placed.masks[0], canvas.width, canvas.height).box).toEqual({ x: 200 + shift.x, y: 300 + shift.y, width: 200, height: 400 });
    expect(maskBox(placed.masks[1], canvas.width, canvas.height).box).toEqual({ x: 450 + shift.x, y: 500 + shift.y, width: 200, height: 200 });
  });

  it('scaled down: one uniform resample of the group, the products\' relative positions kept, and no old background in their edges', async () => {
    const creative = await syntheticCreative(1600, 1600, '#c000c0', [{ kind: 'rect', box: { x: 200, y: 300, width: 300, height: 900 }, color: '#d03030' }, { kind: 'rect', box: { x: 900, y: 700, width: 500, height: 500 }, color: '#3030d0' }]);
    const source = await sourceRaster(creative.png), group = groupBox(creative.masks, 1600, 1600), canvas = GENERATION_IMAGE_SIZES['4:5'];
    const placement = placeGroup(group, canvas, DEFAULT_COMPOSITION);
    expect(placement.scale).toBeLessThan(1);
    const placed = await placeProducts(source, creative.masks, group, placement, canvas, [200, 200, 200]);
    const [a, b] = placed.masks.map(m => maskBox(m, canvas.width, canvas.height).box!), k = placement.scale;
    expect(Math.abs((b.x - a.x) - (900 - 200) * k)).toBeLessThanOrEqual(2);
    expect(Math.abs((b.y - a.y) - (700 - 300) * k)).toBeLessThanOrEqual(2);
    let magenta = 0;
    for (let i = 0; i < placed.union.length; i++) if (placed.union[i] > 0 && Math.abs(placed.reference.rgb[i * 3] - 192) < 25 && placed.reference.rgb[i * 3 + 1] < 40 && Math.abs(placed.reference.rgb[i * 3 + 2] - 192) < 25) magenta++;
    expect(magenta).toBe(0);
  });
});

const replay = await mijiaReplay();
describe.skipIf(!replay)('the real Mijia creative (its real analysis and real product cutouts)', () => {
  it('chooses all four advertised products, the faucet included; never the plinths, the water, or the small container', () => {
    const chosen = advertisedProducts(replay!.scene);
    expect([...chosen.ids].sort()).toEqual(['countertop_appliance_1', 'countertop_appliance_2', 'faucet_1', 'freestanding_appliance_1']);
    expect(chosen.parts).toEqual({ control_panel_1: 'countertop_appliance_2' });
    expect(chosen.reasons.faucet_1).toBe('shown with Freestanding appliance');
  });

  it('places the four products on each ratio as one group, exact or resampled once, with no surviving copy and nothing outside the cutout', async () => {
    const r = replay!, source = await sourceRaster(r.source), refined = refineEdges(source, r.products.map(p => p.mask)), group = groupBox(refined.masks, r.width, r.height);
    const panels: { label: string; png: Buffer }[] = [{ label: 'reference', png: r.source }];
    for (const [ratio, composition] of [['1:1', { x: 0.42, y: 0.58, scale: 0.6, copySpace: 'right' }], ['4:5', { x: 0.5, y: 0.66, scale: 0.7, copySpace: 'top' }], ['16:9', { x: 0.62, y: 0.55, scale: 0.75, copySpace: 'left' }]] as const) {
      const canvas = GENERATION_IMAGE_SIZES[ratio], placement = placeGroup(group, canvas, composition, touchedEdges(group, { width: r.width, height: r.height }));
      const placed = await placeProducts(refined.reference, refined.masks, group, placement, canvas, backgroundColour(source, refined.union)), inputs = await canvasInputs(placed.reference, placed.union);
      const truth = await maskedEditTruth('drifts', inputs.image, inputs.mask, canvas, { contactShadow: true });
      const composed = await composeVariant(truth.png, inputs.placement, placed.reference, r.products.map((p, k) => ({ id: p.id, label: p.label, mask: placed.masks[k], shadow: true })));
      expect(composed.preservation, ratio).toMatchObject({ ok: true, maxDifference: 0, outsideAlphaPixels: 0 });
      expect(placement.scale, ratio).toBeLessThanOrEqual(1);
      const [composite, scenery] = await Promise.all([sharp(composed.composite).removeAlpha().raw().toBuffer(), sharp(composed.scenery).removeAlpha().raw().toBuffer()]);
      let ghost = 0; for (let i = 0; i < placed.union.length; i++) if (truth.ghost[i] && !placed.union[i] && [0, 1, 2].every(c => Math.abs(composite[i * 3 + c] - scenery[i * 3 + c]) <= 3)) ghost++;
      expect(ghost, ratio).toBe(0);
      panels.push({ label: `${ratio} (scale ${Math.round(placement.scale * 100)}%, open ${composition.copySpace})`, png: composed.composite });
    }
    await writeVisual('ratios-mijia', panels);
  }, 120_000);
});
