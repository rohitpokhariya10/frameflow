import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { GenerationConfig } from '../generationGroups.js';
import { editTemplateImage } from './imageEdit.js';
import { regionAlpha, smartEditImage } from './smartEditImage.js';
import { imagesClient, syntheticCreative, writeVisual, type MaskedEditKind } from './variantTestKit.js';

// A smart edit's image, made by its strategy, against fake image models that obey the mask or repaint beyond it. The
// claims checked: the source's own size and aspect come back, and outside a local edit's regions (or on a restyle's kept
// products) every pixel is the source's own, whatever the model did there.
const model = (kind: MaskedEditKind) => { const fake = imagesClient(kind); return { fake, config: { model: 'gpt-image-2', client: () => fake.client as never } as GenerationConfig }; };
const saved = () => { const files = new Map<string, unknown>(); return { files, save: (file: string, value: Buffer | object) => { files.set(file, value); } }; };
const raw = async (png: Buffer) => sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
/** A tall creative (720×1280, 9:16: no canvas of that ratio) with a product on a soft scene. */
const tall = () => syntheticCreative(720, 1280, '#d8e4ee', [{ kind: 'rect', box: { x: 210, y: 420, width: 280, height: 460 }, color: '#d03030' }, { kind: 'ellipse', box: { x: 80, y: 1040, width: 160, height: 160 }, color: '#2050c0' }]);
const REGION = { x: 0.25, y: 0.3, w: 0.45, h: 0.42 }; // around the red product only

describe('a smart edit made locally: only its regions are painted', { timeout: 60_000 }, () => {
  it('keeps the source\'s size and aspect, and every pixel outside the regions exactly, although the model repainted them', async () => {
    const creative = await tall(), { fake, config } = model('drifts'), { files, save } = saved();
    const result = await smartEditImage(config, { bytes: creative.png, file: 'upload.png' }, 'Replace the red box with a green bottle.', { kind: 'local', regions: [{ targetId: 'box_1', label: 'Box', box: REGION }] }, save);
    expect(result.image).toMatchObject({ width: 720, height: 1280 });
    expect(fake.requests).toEqual([{ prompt: 'Replace the red box with a green bottle.', size: '1216x1520', hasMask: true }]);
    const out = await raw(result.bytes), alpha = regionAlpha([REGION], 720, 1280, Math.round(0.015 * 720));
    let outside = 0, differing = 0, inside = 0, changedInside = 0;
    for (let i = 0; i < 720 * 1280; i++) {
      const d = Math.max(...[0, 1, 2].map(c => Math.abs(out.data[i * 3 + c] - creative.rgb[i * 3 + c])));
      if (alpha[i] === 0) { outside++; if (d) differing++; } else if (alpha[i] === 1) { inside++; if (d > 20) changedInside++; }
    }
    expect(differing).toBe(0);
    expect(outside / (720 * 1280)).toBeGreaterThan(0.78);
    expect(changedInside / inside).toBeGreaterThan(0.9);
    expect(result.preservation).toMatchObject({ method: 'outside-regions', unchangedPixels: outside, maxDifferenceOutside: 0 });
    // The mask let the model paint only the region (mapped into its canvas), nothing else.
    const mask = await sharp(files.get('edit-mask.png') as Buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), { width: mw, height: mh } = mask.info;
    let x0 = mw, y0 = mh, x1 = 0, y1 = 0;
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) if (mask.data[(y * mw + x) * 4 + 3] === 0) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const scale = 1520 / 1280, left = Math.floor((1216 - Math.round(720 * scale)) / 2);
    expect(Math.abs(x0 - (left + REGION.x * 720 * scale))).toBeLessThanOrEqual(3);
    expect(Math.abs(y1 - (REGION.y + REGION.h) * 1280 * scale)).toBeLessThanOrEqual(3);
    expect(result.generated).toMatchObject({ file: 'edit-generated.png', width: 1216, height: 1520 });
    // Before: the same model through the whole-image edit returns another size, and repaints what nobody asked to change.
    const before = await editTemplateImage(config, { bytes: creative.png, file: 'upload.png', width: 720, height: 1280 }, 'Replace the red box with a green bottle.', () => undefined);
    expect(before.image).toMatchObject({ width: 1216, height: 1520 });
    const back = await sharp(before.bytes).resize(720, 1280, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    let changedBefore = 0;
    for (let i = 0; i < 720 * 1280; i++) if (alpha[i] === 0 && Math.max(...[0, 1, 2].map(c => Math.abs(back[i * 3 + c] - creative.rgb[i * 3 + c]))) > 20) changedBefore++;
    expect(changedBefore / outside).toBeGreaterThan(0.5);
    await writeVisual('smart-edit-local', [{ label: 'source (720×1280)', png: creative.png }, { label: 'before: whole-image edit (1216×1520)', png: before.bytes }, { label: 'model output (repainted beyond its mask)', png: files.get('edit-generated.png') as Buffer }, { label: 'after: local edit (720×1280)', png: result.bytes }]);
  });

  it('eases each region in from its edge, never at the image border, and paints nothing outside it', () => {
    const a = regionAlpha([{ x: 0, y: 0.5, w: 0.5, h: 0.5 }], 100, 100, 5);
    expect(a[99 * 100 + 0]).toBe(1); // corner on the image border: no easing there
    expect(a[75 * 100 + 25]).toBe(1);
    expect(a[50 * 100 + 25]).toBeLessThan(0.2); // its top edge eases in
    expect(a[75 * 100 + 49]).toBeLessThan(0.2);
    expect(a[25 * 100 + 25]).toBe(0);
    expect(a[75 * 100 + 60]).toBe(0);
  });

  it('nothing to change: refused before any request', async () => {
    const creative = await tall(), { fake, config } = model('obeys-mask');
    await expect(smartEditImage(config, { bytes: creative.png, file: 'upload.png' }, 'x', { kind: 'none', regions: [] }, () => undefined)).rejects.toMatchObject({ code: 'NO_CHANGES' });
    expect(fake.requests).toEqual([]);
  });
});

describe('a smart edit made whole, or around kept products', { timeout: 60_000 }, () => {
  it('a whole-image edit still comes back at the source\'s own size and aspect', async () => {
    const creative = await tall(), { config } = model('obeys-mask');
    const result = await smartEditImage(config, { bytes: creative.png, file: 'upload.png' }, 'Restyle everything.', { kind: 'global', regions: [] }, () => undefined);
    expect(result.image).toMatchObject({ width: 720, height: 1280 });
    expect(result.preservation.method).toBe('none');
  });

  it('a restyled background keeps the products as their own pixels, although the model redrew them shifted', async () => {
    const creative = await tall(), { config } = model('drifts');
    const subjects = creative.masks.map((mask, k) => ({ id: `p${k}`, label: `Product ${k + 1}`, mask, shadow: true }));
    const result = await smartEditImage(config, { bytes: creative.png, file: 'upload.png' }, 'Restyle the background: a warm sunset.', { kind: 'background', regions: [] }, () => undefined, { subjects });
    expect(result.image).toMatchObject({ width: 720, height: 1280 });
    expect(result.preservation).toMatchObject({ method: 'protected-products', maxDifferenceOutside: 0, products: { ok: true, maxDifference: 0, outsideAlphaPixels: 0 } });
    const out = await raw(result.bytes);
    let differing = 0;
    for (let i = 0; i < 720 * 1280; i++) if (creative.masks.some(m => m[i] === 255) && [0, 1, 2].some(c => out.data[i * 3 + c] !== creative.rgb[i * 3 + c])) differing++;
    expect(differing).toBe(0);
  });
});
