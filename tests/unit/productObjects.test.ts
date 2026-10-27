/**
 * Object masks on drawn scenes whose truth is known (segment.ts, prepare.ts), for the classes of failure found on the
 * real creatives (Ganesh sheet creatives 2–4, the LG upload): a phone in front of a laptop merged into it, an object's
 * hidden part shown as a hole of background when what stands in front of it is moved, products stacked in the wrong order
 * (these fail without the fixes), and a white appliance body on a white page (a guard only).
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { orderProductObjects, type ProductObject } from '@frameflow/shared';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { prepareProduct } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';

type Box = { x: number; y: number; width: number; height: number };
const object = (id: string, kind: ProductObject['kind'], box: Box, z: number, label = id): ProductObject =>
  ({ id, kind, label, box, confidence: 0.9, z, covers: [], origin: 'ai', review: { status: 'accepted', by: 'user' } });
const png = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();
/** Opaque pixels of a cut-out inside a box (canvas pixels), and how many of the box's pixels it covers. */
async function covered(cut: { png: Buffer; placement: Box }, b: Box) {
  const { data, info } = await sharp(cut.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); let k = 0;
  for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) {
    const X = x - cut.placement.x, Y = y - cut.placement.y; if (X < 0 || Y < 0 || X >= info.width || Y >= info.height) continue;
    if (data[(Y * info.width + X) * 4 + 3] >= 128) k++;
  }
  return k / (b.width * b.height);
}

describe('object masks: completeness, ownership, order', { timeout: 120_000 }, () => {
  it('a white appliance body on a white page is the appliance’s, not the background’s', async () => {
    // A water purifier: a black top and a white body, on a beige stand, in front of a pink block, on a white page.
    const body = { x: 230, y: 170, width: 100, height: 90 }, top = { x: 230, y: 110, width: 100, height: 60 };
    // (White all around it too — the page to its right, a white appliance to its left. A guard of the behaviour only: this
    // drawn scene does not reproduce the loss seen on the real 4096 px upload, which is checked on that upload's evidence
    // run, test-results/product-v14/.)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="560" height="400"><rect width="560" height="400" fill="#fbfbfb"/>
      <rect x="60" y="60" width="300" height="260" fill="#f1d3cd"/><rect x="200" y="260" width="160" height="60" fill="#ead6c0"/>
      <rect x="120" y="150" width="104" height="110" fill="#f9f9f9"/><rect x="120" y="150" width="104" height="18" fill="#ddd"/>
      <rect x="${top.x}" y="${top.y}" width="${top.width}" height="${top.height}" rx="6" fill="#111"/><rect x="${body.x}" y="${body.y}" width="${body.width}" height="${body.height}" fill="#f7f7f7"/>
      <rect x="265" y="195" width="30" height="30" fill="#9aa"/><rect x="0" y="330" width="560" height="70" fill="#fbfbfb"/></svg>`;
    const source = await decodeRgba(await png(svg));
    const r = await prepareProduct({ source, analysis: undefined, objects: [object('po-podium0000', 'podium', { x: 60, y: 60, width: 300, height: 260 }, 0, 'Block'), object('po-dish000000', 'product', { x: 116, y: 146, width: 112, height: 118 }, 1, 'Dishwasher'), object('po-purifier00', 'product', { x: 222, y: 104, width: 116, height: 162 }, 2, 'Water purifier')], paidApproved: false, save: () => undefined });
    const cut = r.cutouts.find(c => c.id === 'po-purifier00')!;
    // The white body as well as the black top (the local colour estimate had left most of the body out).
    expect(await covered(cut, top)).toBeGreaterThan(0.95);
    expect(await covered(cut, body)).toBeGreaterThan(0.9);
    // And not the white page beside it.
    expect(await covered(cut, { x: 340, y: 120, width: 20, height: 120 })).toBeLessThan(0.1);
  });

  it('a phone in front of a laptop is its own layer, and the laptop shows behind it (an estimate, said so) when it is moved', async () => {
    const laptop = { x: 120, y: 120, width: 260, height: 170 }, phone = { x: 90, y: 180, width: 70, height: 130 };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="380"><rect width="480" height="380" fill="#e2f3b0"/>
      <rect x="${laptop.x}" y="${laptop.y}" width="${laptop.width}" height="${laptop.height}" rx="8" fill="#1d1d1f"/><rect x="${laptop.x + 10}" y="${laptop.y + 10}" width="${laptop.width - 20}" height="${laptop.height - 30}" fill="#7cc4e8"/>
      <rect x="${phone.x}" y="${phone.y}" width="${phone.width}" height="${phone.height}" rx="10" fill="#8f6ad8"/><rect x="${phone.x + 6}" y="${phone.y + 6}" width="${phone.width - 12}" height="${phone.height - 12}" rx="6" fill="#b79cf0"/></svg>`;
    const source = await decodeRgba(await png(svg));
    // Detected back to front by where they stand (the phone's foot is lower), and ordered so: the phone in front.
    const ordered = orderProductObjects([object('po-laptop0000', 'product', { x: 116, y: 116, width: 268, height: 178 }, 0, 'Laptop'), object('po-phone00000', 'product', { x: 86, y: 176, width: 78, height: 138 }, 1, 'Smartphone')]);
    ordered.forEach((o, i) => { o.z = i; });
    expect(ordered.map(o => o.label)).toEqual(['Laptop', 'Smartphone']);
    const r = await prepareProduct({ source, analysis: undefined, objects: ordered, paidApproved: false, save: () => undefined });
    const lap = r.cutouts.find(c => c.id === 'po-laptop0000')!, ph = r.cutouts.find(c => c.id === 'po-phone00000')!;
    expect(await covered(ph, phone)).toBeGreaterThan(0.9);
    // The laptop's layer holds none of the phone: where they overlap it is the laptop's completed part (laptop colours).
    const overlap = { x: laptop.x + 4, y: phone.y + 4, width: phone.x + phone.width - laptop.x - 8, height: laptop.y + laptop.height - phone.y - 8 };
    const { data, info } = await sharp(lap.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let purple = 0, opaque = 0;
    for (let y = overlap.y; y < overlap.y + overlap.height; y++) for (let x = overlap.x; x < overlap.x + overlap.width; x++) {
      const o = ((y - lap.placement.y) * info.width + x - lap.placement.x) * 4; if (data[o + 3] < 128) continue; opaque++;
      if (data[o] > 120 && data[o + 2] > 180 && data[o + 1] < 170) purple++;
    }
    expect(opaque / (overlap.width * overlap.height)).toBeGreaterThan(0.9);
    expect(purple).toBe(0);
    expect(r.quality.issues.some(i => i.id === 'completed-po-laptop0000' && /estimate/.test(i.message))).toBe(true);
  });

  it('orders products: one lying mostly over another is in front; supports stay behind what stands on them', () => {
    const tv = object('tv', 'product', { x: 100, y: 50, width: 300, height: 260 }, 0, 'TV'), bar = object('bar', 'product', { x: 150, y: 250, width: 200, height: 20 }, 0, 'Soundbar');
    const stand = object('stand', 'podium', { x: 80, y: 300, width: 340, height: 60 }, 0, 'Stand'), mascot = object('m', 'character', { x: 20, y: 80, width: 120, height: 280 }, 0, 'Mascot');
    // The soundbar's foot is higher than the TV's, yet it lies on the TV: in front.
    expect(orderProductObjects([bar, mascot, tv, stand]).map(o => o.label)).toEqual(['Stand', 'TV', 'Soundbar', 'Mascot']);
  });
});
