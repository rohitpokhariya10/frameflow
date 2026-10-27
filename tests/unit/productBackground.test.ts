/**
 * What is rebuilt behind the objects of a Product with Text template (backgroundGuide.ts), on drawn pictures whose truth
 * is known: a symmetric layout's hole takes its mirror image (never a one-off decoration's), an asymmetric one is left to
 * the patches; the floor continues under a stand; a wall the administrator draws over a TV stays in the background while
 * the TV, its sound bar and its speakers stay one layer.
 */
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import type { ProductObject } from '@frameflow/shared';
import { decodeRgba } from '../../server/src/decomposition/protectedTemplates/pixels.js';
import { guidedFill } from '../../server/src/decomposition/protectedTemplates/product/backgroundGuide.js';
import { prepareProduct } from '../../server/src/decomposition/protectedTemplates/product/prepare.js';

type Box = { x: number; y: number; width: number; height: number };
const raw = async (svg: string) => { const { data, info } = await sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer({ resolveWithObject: true }); return { rgb: new Uint8Array(data), w: info.width, h: info.height }; };
const holeOf = (w: number, h: number, b: Box) => { const m = new Uint8Array(w * h); for (let y = b.y; y < b.y + b.height; y++) for (let x = b.x; x < b.x + b.width; x++) m[y * w + x] = 1; return m; };
const meanError = (a: Uint8Array, b: Uint8Array, w: number, box: Box) => { let s = 0, n = 0; for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { const i = (y * w + x) * 3; s += Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2])); n++; } return s / n; };

// A festive layout, mirror-symmetric about x = 200: frame columns, a lotus band, a temple-like block each side.
const SYMMETRIC = (badge: boolean) => `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e7f5c4"/>
  <rect x="40" y="0" width="10" height="300" fill="#f97316"/><rect x="350" y="0" width="10" height="300" fill="#f97316"/>
  <rect x="0" y="200" width="400" height="30" fill="#84cc16"/><rect x="0" y="230" width="400" height="8" fill="#7c3aed"/>
  <rect x="0" y="60" width="36" height="140" fill="#fde68a"/><rect x="364" y="60" width="36" height="140" fill="#fde68a"/>
  <rect x="8" y="120" width="8" height="80" fill="#334155"/><rect x="384" y="120" width="8" height="80" fill="#334155"/>
  ${badge ? '<rect x="300" y="40" width="40" height="60" fill="#0ea5e9"/>' : ''}</svg>`;

describe('the background behind objects, rebuilt from the creative itself', { timeout: 120_000 }, () => {
  it('a symmetric layout: the hole takes its mirror image; a one-off decoration is never copied', async () => {
    const truth = await raw(SYMMETRIC(false)), { w, h } = truth, hole = holeOf(w, h, { x: 20, y: 40, width: 60, height: 200 });
    const g = guidedFill(truth.rgb, w, h, hole, {});
    expect(g.axis?.x2).toBe(399);
    expect(g.mirror).toBeGreaterThan(60 * 200 * 0.8);
    expect(meanError(g.rgb, truth.rgb, w, { x: 20, y: 40, width: 60, height: 200 })).toBeLessThan(3);
    // A badge on the right (a decoration of its own): its mirror place stays to the patches, never a second badge.
    const withBadge = await raw(SYMMETRIC(true)), g2 = guidedFill(withBadge.rgb, w, h, hole, { oneOff: [{ x: 300, y: 40, width: 40, height: 60 }] });
    let blue = 0; for (let y = 40; y < 100; y++) for (let x = 60; x < 100; x++) { const i = (y * w + x) * 3; if (g2.rgb[i + 2] > 200 && g2.rgb[i] < 60) blue++; }
    expect(blue).toBe(0);
  });

  it('an asymmetric layout is not mirrored', async () => {
    const img = await raw(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#ffffff"/>
      <rect x="0" y="0" width="150" height="300" fill="#1d4ed8"/><rect x="150" y="0" width="250" height="120" fill="#f59e0b"/><circle cx="300" cy="220" r="60" fill="#16a34a"/></svg>`);
    const g = guidedFill(img.rgb, img.w, img.h, holeOf(img.w, img.h, { x: 30, y: 100, width: 60, height: 100 }), {});
    expect(g.mirror).toBe(0);
  });

  it('the floor continues under a stand, up to a little behind where stands stand', async () => {
    const img = await raw(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#dff7c0"/>
      <rect x="0" y="200" width="400" height="40" fill="#f3e2c4"/><rect x="0" y="240" width="400" height="60" fill="#b45309"/></svg>`), { w, h } = img;
    const floor = new Uint8Array(w * h); for (let y = 200; y < 240; y++) for (let x = 0; x < w; x++) floor[y * w + x] = 1;
    // A stand once stood here (rows 185–235): the hole reaches below the floor's top.
    const hole = holeOf(w, h, { x: 150, y: 185, width: 80, height: 50 }); for (let i = 0; i < w * h; i++) if (hole[i]) floor[i] = 0;
    const g = guidedFill(img.rgb, w, h, hole, { floor, floorTop: 195 });
    expect(g.floor).toBeGreaterThan(80 * 38);
    expect(meanError(g.rgb, img.rgb, w, { x: 150, y: 200, width: 80, height: 35 })).toBeLessThan(3);
    // Above the floor's reach it is not floor (the wall's: mirrored here, else for the patches).
    for (let x = 150; x < 230; x++) { const i = (188 * w + x) * 3; expect(Math.max(Math.abs(g.rgb[i] - 0xf3), Math.abs(g.rgb[i + 1] - 0xe2), Math.abs(g.rgb[i + 2] - 0xc4))).toBeGreaterThan(15); }
  });

  it('a wall drawn over a TV stays in the background; the screen, sound bar and speakers stay with the TV', async () => {
    const W = 600, H = 400, tv: Box = { x: 200, y: 80, width: 200, height: 220 };
    const png = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="#e7f5c4"/>
      <rect x="0" y="300" width="${W}" height="100" fill="#c9922e"/>
      <rect x="200" y="80" width="200" height="220" fill="#f4f4f4"/>
      <rect x="215" y="92" width="170" height="100" fill="#111827"/><rect x="225" y="100" width="150" height="84" fill="#7c3aed"/>
      <rect x="235" y="210" width="130" height="10" rx="4" fill="#1f2937"/>
      <rect x="230" y="245" width="26" height="50" fill="#111111"/><rect x="345" y="255" width="22" height="40" fill="#111111"/></svg>`)).png().toBuffer();
    const source = await decodeRgba(png);
    const object = (id: string, kind: ProductObject['kind'], box: Box, z: number, extra: Partial<ProductObject> = {}): ProductObject =>
      ({ id, kind, label: id, box, confidence: 0.9, z, covers: [], origin: 'ai', review: { status: 'accepted', by: 'user' }, ...extra });
    const prepare = (objects: ProductObject[]) => prepareProduct({ source, analysis: undefined, objects, paidApproved: false, save: () => undefined });
    const tvObject = object('po-tv000000000', 'product', tv, 10);
    const opaque = async (png: Buffer, at: Box, box: Box) => { const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true }); let n = 0;
      for (let y = box.y; y < box.y + box.height; y++) for (let x = box.x; x < box.x + box.width; x++) { const lx = x - at.x, ly = y - at.y; if (lx >= 0 && ly >= 0 && lx < info.width && ly < info.height && data[(ly * info.width + lx) * 4 + 3] > 0) n++; } return n; };
    const wallBelow: Box = { x: 260, y: 225, width: 80, height: 15 }; // white wall between the sound bar and the speakers
    const before = (await prepare([tvObject])).cutouts[0];
    expect(await opaque(before.png, before.placement, wallBelow)).toBeGreaterThan(80 * 15 * 0.9);
    const after = await prepare([tvObject, object('po-wall0000000', 'frame', tv, 11, { origin: 'user', label: 'Wall' })]);
    const c = after.cutouts.find(x => x.id === tvObject.id)!;
    expect(await opaque(c.png, c.placement, wallBelow)).toBeLessThan(80 * 15 * 0.1);
    expect(await opaque(c.png, c.placement, { x: 225, y: 100, width: 150, height: 84 })).toBeGreaterThan(150 * 84 * 0.95); // the screen
    expect(await opaque(c.png, c.placement, { x: 235, y: 210, width: 130, height: 10 })).toBeGreaterThan(130 * 10 * 0.8); // the sound bar
    expect(await opaque(c.png, c.placement, { x: 230, y: 245, width: 26, height: 50 })).toBeGreaterThan(26 * 50 * 0.8); // a speaker
    expect(await opaque(c.png, c.placement, { x: 345, y: 255, width: 22, height: 40 })).toBeGreaterThan(22 * 40 * 0.8); // the other
    // The wall is in the background, as it was.
    const base = await sharp(after.base).removeAlpha().raw().toBuffer();
    let white = 0; for (let y = wallBelow.y; y < wallBelow.y + wallBelow.height; y++) for (let x = wallBelow.x; x < wallBelow.x + wallBelow.width; x++) { const i = (y * W + x) * 3; if (base[i] > 230 && base[i + 1] > 230 && base[i + 2] > 230) white++; }
    expect(white).toBeGreaterThan(80 * 15 * 0.9);
  });
});
